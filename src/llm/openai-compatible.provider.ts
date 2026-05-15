import OpenAI from 'openai';
import { env } from '../config/env.js';
import type { LLMProvider, UserContext, ActionResult } from './provider.js';
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
import { INTENT_CLASSIFICATION_PROMPT } from '../agent/prompts/intent-classification.js';
import { RESPONSE_GENERATION_PROMPT } from '../agent/prompts/response-generation.js';
import { IMAGE_EXTRACTION_PROMPT } from '../agent/prompts/image-extraction.js';
import { SCHEDULE_BLUEPRINT_PROMPT } from '../agent/prompts/schedule-blueprint.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('llm-openai');

export class OpenAICompatibleProvider implements LLMProvider {
  private chatClient: OpenAI;
  private visionClient: OpenAI;
  private embeddingClient: OpenAI;
  private chatModel: string;
  private reasoningModel: string;
  private visionModel: string;
  private embeddingModel: string;
  private temperature: number;
  private maxTokens: number;

  constructor() {
    // Chat/Text client
    this.chatClient = new OpenAI({
      baseURL: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
    });

    // Vision client — falls back to chat client config if not set or empty
    this.visionClient = new OpenAI({
      baseURL: env.VISION_BASE_URL || env.LLM_BASE_URL,
      apiKey: env.VISION_API_KEY || env.LLM_API_KEY,
    });

    // Embedding client — falls back to chat client config if not set or empty
    this.embeddingClient = new OpenAI({
      baseURL: env.EMBEDDING_BASE_URL || env.LLM_BASE_URL,
      apiKey: env.EMBEDDING_API_KEY || env.LLM_API_KEY,
    });

    this.chatModel = env.LLM_CHAT_MODEL;
    this.reasoningModel = env.LLM_REASONING_MODEL;
    this.visionModel = env.LLM_VISION_MODEL;
    this.embeddingModel = env.LLM_EMBEDDING_MODEL;
    this.temperature = env.LLM_TEMPERATURE;
    this.maxTokens = env.LLM_MAX_TOKENS;

    log.info({
      chatBaseURL: env.LLM_BASE_URL,
      visionBaseURL: env.VISION_BASE_URL || env.LLM_BASE_URL,
      embeddingBaseURL: env.EMBEDDING_BASE_URL || env.LLM_BASE_URL,
      chatModel: this.chatModel,
      reasoningModel: this.reasoningModel,
      visionModel: this.visionModel,
      embeddingModel: this.embeddingModel,
    }, 'Initialized OpenAI-compatible LLM provider (multi-endpoint)');
  }

  async classifyAndExtract(input: string, context: UserContext): Promise<ClassificationResult> {
    const systemPrompt = INTENT_CLASSIFICATION_PROMPT(context);

    try {
      const response = await this.chatClient.chat.completions.create({
        model: this.reasoningModel,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          // Inject last few turns so model has follow-up context
          ...(context.conversationHistory ?? []),
          { role: 'user', content: input },
        ],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty LLM response');
      }

      // Robust JSON extraction — handles markdown-wrapped responses
      const parsed = this.extractJSON(content);
      log.info({ rawContent: content.substring(0, 500), parsedKeys: parsed ? Object.keys(parsed) : null }, 'LLM raw classification response');

      if (!parsed) {
        throw new Error(`Failed to parse JSON from LLM response: ${content.substring(0, 200)}`);
      }

      // Use safeParse for lenient validation
      const result = ClassificationResultSchema.safeParse(parsed);
      if (result.success) {
        log.info({ intent: result.data.intent, confidence: result.data.confidence }, 'Classified intent');
        return result.data;
      }

      // If validation fails, try to salvage what we can
      log.warn({ errors: result.error.issues, parsedKeys: Object.keys(parsed) }, 'Zod validation failed, attempting salvage');

      // Handle memorySignals being strings instead of objects
      let memorySignals = parsed.memorySignals ?? parsed.memory_signals ?? [];
      if (Array.isArray(memorySignals)) {
        memorySignals = memorySignals.filter((s: unknown) => typeof s === 'object' && s !== null);
      }

      // Handle replanContext being an object instead of string
      let replanContext = parsed.replanContext ?? parsed.replan_context;
      if (typeof replanContext === 'object' && replanContext !== null) {
        replanContext = JSON.stringify(replanContext);
      }

      return {
        intent: parsed.intent ?? IntentType.GENERAL_CHAT,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((t: any) => ({
          ...t,
          estimatedMinutes: typeof t.estimatedMinutes === 'number' ? Math.max(5, t.estimatedMinutes) : 30
        })) : [],
        memorySignals,
        taskReference: typeof parsed.taskReference === 'string' ? parsed.taskReference : undefined,
        replanContext: typeof replanContext === 'string' ? replanContext : undefined,
        secondaryIntents: Array.isArray(parsed.secondaryIntents) ? parsed.secondaryIntents : [],
        reasoning: parsed.reasoning,
      };
    } catch (error) {
      log.error({ error, input: input.substring(0, 100) }, 'Failed to classify intent');
      // Fallback to general chat on error
      return {
        intent: IntentType.GENERAL_CHAT,
        confidence: 0.5,
        tasks: [],
        memorySignals: [],
        secondaryIntents: [],
        reasoning: 'Failed to classify — falling back to general chat',
      };
    }
  }

  /**
   * Extract JSON from LLM response, handling:
   * - Markdown code fences
   * - Duplicate keys (model looping on "reasoning")
   * - Truncated JSON (max_tokens cut-off)
   */
  private extractJSON(text: string): Record<string, any> | null {
    // Step 1: Remove duplicate keys (keep first occurrence)
    // The LLM sometimes loops: "reasoning":"x","reasoning":"x","reasoning":"x"...
    let cleaned = text.replace(
      /,\s*"reasoning"\s*:\s*"[^"]*"(?=\s*,\s*"reasoning")/g,
      ''
    );

    // Step 2: Try direct parse
    try {
      return JSON.parse(cleaned);
    } catch { /* continue */ }

    // Step 3: Try extracting from markdown code fence
    const jsonMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonMatch?.[1]) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch { /* continue */ }
    }

    // Step 4: Try finding first { ... } block
    const braceMatch = cleaned.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch { /* continue */ }
    }

    // Step 5: Handle truncated JSON — find the opening { and try to close it
    const openBrace = cleaned.indexOf('{');
    if (openBrace >= 0) {
      let truncated = cleaned.substring(openBrace);
      // Remove trailing incomplete string/value (after last complete key-value)
      truncated = truncated.replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/, '');
      // Close any unclosed structures
      const openBraces = (truncated.match(/\{/g) || []).length;
      const closeBraces = (truncated.match(/\}/g) || []).length;
      truncated += '}'.repeat(Math.max(0, openBraces - closeBraces));
      try {
        return JSON.parse(truncated);
      } catch { /* continue */ }
    }

    return null;
  }

  async generateResponse(
    input: string,
    classification: ClassificationResult,
    result: ActionResult,
    context: UserContext,
  ): Promise<string> {
    const systemPrompt = RESPONSE_GENERATION_PROMPT(context);
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.chatClient.chat.completions.create({
          model: this.chatModel,
          temperature: this.temperature + 0.2,
          max_tokens: this.maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            // Inject last few turns for conversational context
            ...(context.conversationHistory ?? []),
            {
              role: 'user',
              content: JSON.stringify({
                userInput: input,
                intent: classification.intent,
                actionResult: result,
                extractedTasks: classification.tasks,
              }),
            },
          ],
        });

        const content = response.choices[0]?.message?.content;
        return content ?? 'I processed your request, but I couldn\'t formulate a response. Please try again.';
      } catch (error: any) {
        const status = error?.status ?? error?.response?.status;
        const isRetryable = status === 503 || status === 429 || status === 502;

        if (isRetryable && attempt < maxRetries) {
          const delay = 1000 * (attempt + 1);
          log.warn({ status, attempt: attempt + 1, maxRetries, delayMs: delay }, 'Retryable error in generateResponse, retrying...');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        log.error({ error, attempt }, 'Failed to generate response');
        return result.success
          ? `✅ Done! ${result.message}`
          : `❌ Something went wrong: ${result.message}`;
      }
    }

    // Should never reach here, but TypeScript safety
    return result.success
      ? `✅ Done! ${result.message}`
      : `❌ Something went wrong: ${result.message}`;
  }

  async extractImageContent(imageBase64: string, mimeType: string): Promise<ImageExtractionResult> {
    const systemPrompt = IMAGE_EXTRACTION_PROMPT;

    try {
      const response = await this.visionClient.chat.completions.create({
        model: this.visionModel,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${systemPrompt}\n\nExtract all relevant content from this image. Identify any tasks, dates, schedules, or important information. Respond with a JSON object only.`,
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${imageBase64}`,
                },
              },
            ],
          },
        ],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty vision response');
      }

      const parsed = this.extractJSON(content);
      if (!parsed) {
        throw new Error(`Could not parse JSON from vision response: ${content.substring(0, 200)}`);
      }
      return ImageExtractionResultSchema.parse(parsed);
    } catch (error: any) {
      const errBody = error?.error ?? error?.response?.data ?? error?.message ?? error;
      log.error({ error: errBody, status: error?.status, model: this.visionModel }, 'Failed to extract image content');
      return {
        content: 'Failed to extract content from the image.',
        tasks: [],
        dates: [],
        context: undefined,
      };
    }
  }

  async getEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.embeddingClient.embeddings.create({
        model: this.embeddingModel,
        input: text,
      });
      return response.data[0]!.embedding;
    } catch (error) {
      log.error({ error }, 'Failed to generate embedding');
      throw error;
    }
  }

  async generateScheduleBlueprint(
    tasks: ITask[],
    memory: RetrievedMemory,
    config: UserConfig,
    targetDate: string
  ): Promise<ScheduleBlueprint | null> {
    const systemPrompt = SCHEDULE_BLUEPRINT_PROMPT(tasks, memory, config, targetDate);

    try {
      const response = await this.chatClient.chat.completions.create({
        model: this.reasoningModel,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        messages: [{ role: 'system', content: systemPrompt }],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return null;

      const parsed = this.extractJSON(content);
      if (!parsed) return null;

      const result = ScheduleBlueprintSchema.safeParse(parsed);
      if (result.success) {
        log.info({ tasksCount: result.data.tasks.length }, 'Generated schedule blueprint');
        return result.data;
      }
      log.warn({ errors: result.error.issues }, 'Zod validation failed for blueprint');
      return null;
    } catch (error) {
      log.error({ error }, 'Failed to generate schedule blueprint');
      return null;
    }
  }
}

// Singleton instance
let provider: OpenAICompatibleProvider | null = null;

export function getLLMProvider(): OpenAICompatibleProvider {
  if (!provider) {
    provider = new OpenAICompatibleProvider();
  }
  return provider;
}
