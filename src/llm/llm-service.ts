import type { LLMProvider, UserContext, ActionResult } from './provider.js';
import type { ChatBackend, EmbeddingBackend } from './types.js';
import {
  ClassificationResultSchema,
  ImageExtractionResultSchema,
  ScheduleBlueprintSchema,
  type ClassificationResult,
  type ImageExtractionResult,
  type ScheduleBlueprint,
} from '../utils/zod-schemas.js';
import type { ITask } from '../memory/mongo/models/task.model.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';
import type { UserConfig } from '../config/config-resolver.js';
import { IntentType } from '../config/defaults.js';
import { buildIntentPrompt } from '../agent/prompts/intent-classification.js';
import { buildResponsePrompt } from '../agent/prompts/response-generation.js';
import { IMAGE_EXTRACTION_PROMPT } from '../agent/prompts/image-extraction.js';
import { buildBlueprintPrompt } from '../agent/prompts/schedule-blueprint.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('llm-service');

const EMBED_CACHE_MAX = 300;

export interface LLMServiceOptions {
  maxTokens: number;
  temperature: number;
}

/** Provider-agnostic orchestration: prompts, JSON extraction, salvage, embedding cache, call accounting. */
export class LLMService implements LLMProvider {
  private embedCache = new Map<string, number[]>();
  /** Per-process counters — surfaced in logs so you can see what a message costs. */
  readonly calls = { classify: 0, respond: 0, blueprint: 0, vision: 0, embed: 0, embedCacheHits: 0 };

  constructor(
    private chat: ChatBackend,
    private vision: ChatBackend,
    private embeddings: EmbeddingBackend,
    private opts: LLMServiceOptions,
  ) {
    log.info({ chat: chat.name, vision: vision.name, embeddings: embeddings.name, dims: embeddings.dimensions }, 'LLM service ready');
  }

  get embeddingDimensions(): number {
    return this.embeddings.dimensions;
  }

  async warmup(): Promise<void> {
    await this.embeddings.warmup?.();
  }

  // ─── Classification ─────────────────────────────────────────────────────────

  async classifyAndExtract(input: string, context: UserContext): Promise<ClassificationResult> {
    this.calls.classify++;
    try {
      const content = await this.chat.complete({
        label: 'classify',
        tier: 'reasoning',
        system: buildIntentPrompt(context),
        messages: [...(context.conversationHistory ?? []), { role: 'user', content: input }],
        maxTokens: this.opts.maxTokens,
        temperature: Math.min(this.opts.temperature, 0.2),
        json: true,
      });

      const parsed = extractJSON(content);
      log.info({ rawContent: content.substring(0, 400) }, 'LLM raw classification response');
      if (!parsed) throw new Error(`Failed to parse JSON from LLM response: ${content.substring(0, 200)}`);

      const result = ClassificationResultSchema.safeParse(parsed);
      if (result.success) {
        log.info({ intent: result.data.intent, confidence: result.data.confidence }, 'Classified intent');
        return result.data;
      }
      log.warn({ errors: result.error.issues.slice(0, 5), parsedKeys: Object.keys(parsed) }, 'Zod validation failed, salvaging');
      return salvageClassification(parsed);
    } catch (error: any) {
      log.error({ err: error?.message ?? error, input: input.substring(0, 100) }, 'Failed to classify intent');
      return {
        intent: IntentType.GENERAL_CHAT,
        confidence: 0,
        tasks: [],
        memorySignals: [],
        userState: null,
        secondaryIntents: [],
        reasoning: 'classification failed',
        classificationError: error?.message ?? 'LLM unavailable',
      };
    }
  }

  // ─── Response ───────────────────────────────────────────────────────────────

  async generateResponse(input: string, classification: ClassificationResult, result: ActionResult, context: UserContext): Promise<string> {
    this.calls.respond++;
    try {
      const content = await this.chat.complete({
        label: 'respond',
        tier: 'chat',
        system: buildResponsePrompt(context),
        messages: [
          ...(context.conversationHistory ?? []),
          {
            role: 'user',
            content: JSON.stringify({
              userInput: input,
              intent: classification.intent,
              actionResult: result,
              extractedTasks: classification.tasks.map(t => ({ title: t.title, dueDate: t.dueDate, estimatedMinutes: t.estimatedMinutes })),
            }),
          },
        ],
        maxTokens: Math.min(this.opts.maxTokens, 600),
        temperature: Math.min(1, this.opts.temperature + 0.2),
      });
      if (content.trim()) return content.trim();
    } catch (error: any) {
      log.error({ err: error?.message ?? error }, 'Failed to generate response');
    }
    return result.success ? `✅ ${result.message}` : `⚠️ ${result.message}`;
  }

  // ─── Vision ─────────────────────────────────────────────────────────────────

  async extractImageContent(imageBase64: string, mimeType: string): Promise<ImageExtractionResult> {
    this.calls.vision++;
    try {
      const content = await this.vision.describeImage(
        `${IMAGE_EXTRACTION_PROMPT}\n\nExtract all relevant content from this image. Identify any tasks, dates, schedules, or important information. Respond with a JSON object only.`,
        imageBase64,
        mimeType,
        this.opts.maxTokens,
      );
      const parsed = extractJSON(content);
      if (!parsed) throw new Error(`Could not parse JSON from vision response: ${content.substring(0, 200)}`);
      return ImageExtractionResultSchema.parse(parsed);
    } catch (error: any) {
      log.error({ err: error?.message ?? error }, 'Failed to extract image content');
      return { content: 'Failed to extract content from the image.', tasks: [], dates: [], context: undefined };
    }
  }

  // ─── Embeddings (with an LRU so the same text is never embedded twice per process) ─

  async getEmbedding(text: string): Promise<number[]> {
    const key = text.trim().toLowerCase();
    const cached = this.embedCache.get(key);
    if (cached) {
      this.calls.embedCacheHits++;
      this.embedCache.delete(key);
      this.embedCache.set(key, cached); // refresh LRU position
      return cached;
    }
    this.calls.embed++;
    const vector = await this.embeddings.embed(text);
    this.embedCache.set(key, vector);
    if (this.embedCache.size > EMBED_CACHE_MAX) {
      const oldest = this.embedCache.keys().next().value;
      if (oldest !== undefined) this.embedCache.delete(oldest);
    }
    return vector;
  }

  // ─── Planning blueprint ─────────────────────────────────────────────────────

  async generateScheduleBlueprint(tasks: ITask[], memory: RetrievedMemory, config: UserConfig, targetDate: string): Promise<ScheduleBlueprint | null> {
    this.calls.blueprint++;
    try {
      const prompt = buildBlueprintPrompt(tasks, memory, config, targetDate);
      const content = await this.chat.complete({
        label: 'blueprint',
        tier: 'reasoning',
        system: { stable: prompt.stable },
        messages: [{ role: 'user', content: prompt.dynamic ?? 'Produce the blueprint.' }],
        maxTokens: this.opts.maxTokens,
        temperature: Math.min(this.opts.temperature, 0.2),
        json: true,
      });
      const parsed = extractJSON(content);
      if (!parsed) return null;
      const result = ScheduleBlueprintSchema.safeParse(parsed);
      if (result.success) {
        log.info({ tasksCount: result.data.tasks.length }, 'Generated schedule blueprint');
        return result.data;
      }
      log.warn({ errors: result.error.issues.slice(0, 3) }, 'Zod validation failed for blueprint');
      return null;
    } catch (error: any) {
      log.error({ err: error?.message ?? error }, 'Failed to generate schedule blueprint');
      return null;
    }
  }
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

/** Extract JSON from an LLM response: fences, duplicate keys, truncation. */
export function extractJSON(text: string): Record<string, any> | null {
  const cleaned = text.replace(/,\s*"reasoning"\s*:\s*"[^"]*"(?=\s*,\s*"reasoning")/g, '');

  try { return JSON.parse(cleaned); } catch { /* continue */ }

  const jsonMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonMatch?.[1]) {
    try { return JSON.parse(jsonMatch[1].trim()); } catch { /* continue */ }
  }

  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch { /* continue */ }
  }

  const openBrace = cleaned.indexOf('{');
  if (openBrace >= 0) {
    const repaired = closeTruncatedJSON(cleaned.substring(openBrace));
    for (const candidate of repaired) {
      try { return JSON.parse(candidate); } catch { /* continue */ }
    }
  }

  return null;
}

/**
 * Close a JSON document cut off by max_tokens: finish an open string, drop a dangling
 * key or trailing comma, then close brackets in the reverse order they were opened.
 */
function closeTruncatedJSON(src: string): string[] {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of src) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  let body = inString ? `${src}"` : src;
  const variants: string[] = [];
  const closers = [...stack].reverse().join('');

  const tidy = (s: string) => s.replace(/,?\s*"[^"]*"\s*:\s*$/, '').replace(/,\s*$/, '');
  variants.push(tidy(body) + closers);
  // Also try dropping a half-written last value ("key": 12 / "key": "abc")
  variants.push(tidy(body.replace(/,?\s*"[^"]*"\s*:\s*[^,\]}]*$/, '')) + closers);
  return variants;
}

function cleanTasks(list: unknown) {
  return Array.isArray(list)
    ? list.filter((t: any) => t && typeof t === 'object').map((t: any) => ({
      title: typeof t.title === 'string' && t.title.trim() ? String(t.title).trim() : null,
      description: typeof t.description === 'string' ? t.description : '',
      priority: [1, 2, 3, 4, 5].includes(t.priority) ? t.priority : 2,
      cognitiveLoad: [1, 2, 3].includes(t.cognitiveLoad) ? t.cognitiveLoad : 2,
      estimatedMinutes: typeof t.estimatedMinutes === 'number' ? Math.max(5, t.estimatedMinutes) : 30,
      dueDate: typeof t.dueDate === 'string' ? t.dueDate : null,
      preferredTime: typeof t.preferredTime === 'string' ? t.preferredTime : null,
      tags: Array.isArray(t.tags) ? t.tags.filter((x: unknown) => typeof x === 'string') : [],
      isFixed: t.isFixed === true,
      fixedStartTime: typeof t.fixedStartTime === 'string' ? t.fixedStartTime : null,
      fixedEndTime: typeof t.fixedEndTime === 'string' ? t.fixedEndTime : null,
      recurrence: t.recurrence && typeof t.recurrence === 'object' && ['daily', 'weekdays', 'weekly'].includes(t.recurrence.pattern)
        ? { pattern: t.recurrence.pattern, days: Array.isArray(t.recurrence.days) ? t.recurrence.days : null }
        : null,
    }))
    : [];
}

export function salvageClassification(parsed: Record<string, any>): ClassificationResult {
  const intentRaw = String(parsed.intent ?? '').toUpperCase();
  const intent = (Object.values(IntentType) as string[]).includes(intentRaw) ? (intentRaw as IntentType) : IntentType.GENERAL_CHAT;

  let memorySignals = parsed.memorySignals ?? parsed.memory_signals ?? [];
  memorySignals = Array.isArray(memorySignals)
    ? memorySignals.filter((s: any) => s && typeof s === 'object' && typeof s.key === 'string' && ['preference', 'habit', 'constraint'].includes(s.type)).map((s: any) => ({
      type: s.type,
      key: s.key,
      value: typeof s.value === 'string' ? s.value : String(s.value ?? ''),
      timeRange: s.timeRange && typeof s.timeRange === 'object' ? s.timeRange : null,
      until: typeof s.until === 'string' ? s.until : null,
      confidence: typeof s.confidence === 'number' ? s.confidence : 0.75,
    }))
    : [];

  let replanContext = parsed.replanContext ?? parsed.replan_context;
  if (typeof replanContext === 'object' && replanContext !== null) replanContext = JSON.stringify(replanContext);

  const us = parsed.userState;
  const userState = us && typeof us === 'object'
    ? {
      energy: ['depleted', 'low', 'normal', 'high'].includes(us.energy) ? us.energy : null,
      mood: typeof us.mood === 'string' ? us.mood : null,
      availability: typeof us.availability === 'string' ? us.availability : null,
      unavailableUntil: typeof us.unavailableUntil === 'string' ? us.unavailableUntil : null,
      note: typeof us.note === 'string' ? us.note : null,
    }
    : null;

  const secondary = Array.isArray(parsed.secondaryIntents)
    ? parsed.secondaryIntents.filter((s: any) => s && typeof s === 'object' && (Object.values(IntentType) as string[]).includes(String(s.intent).toUpperCase())).map((s: any) => ({
      intent: String(s.intent).toUpperCase() as IntentType,
      tasks: cleanTasks(s.tasks),
      taskReference: typeof s.taskReference === 'string' ? s.taskReference : null,
      memoryReference: typeof s.memoryReference === 'string' ? s.memoryReference : null,
      replanContext: typeof s.replanContext === 'string' ? s.replanContext : null,
      targetDate: typeof s.targetDate === 'string' ? s.targetDate : null,
    }))
    : [];

  return {
    intent,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    tasks: cleanTasks(parsed.tasks),
    memorySignals,
    userState,
    taskReference: typeof parsed.taskReference === 'string' ? parsed.taskReference : null,
    memoryReference: typeof parsed.memoryReference === 'string' ? parsed.memoryReference : null,
    replanContext: typeof replanContext === 'string' ? replanContext : null,
    targetDate: typeof parsed.targetDate === 'string' ? parsed.targetDate : null,
    secondaryIntents: secondary,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : null,
  };
}
