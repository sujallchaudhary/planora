import Anthropic from '@anthropic-ai/sdk';
import type { ChatBackend, ChatRequest, ChatTurn } from '../types.js';
import { withRetry } from '../types.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('llm:anthropic');

type Effort = 'low' | 'medium' | 'high';
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
/** beta and non-beta responses carry the same fields we read (content, stop_reason, usage, model). */
type AnyMessage = Anthropic.Beta.Messages.BetaMessage | Anthropic.Messages.Message;

export interface AnthropicChatOptions {
  apiKey?: string;
  chatModel: string;
  reasoningModel: string;
  visionModel: string;
  /** Server-side refusal fallbacks (beta). */
  fallbacks: boolean;
  effortChat: Effort;
  effortPlanning: Effort;
}

/**
 * Claude backend.
 * - The stable part of every system prompt carries a cache breakpoint, so the ~3k-token
 *   instruction block is read from cache on every request after the first.
 * - Thinking is left at the model default (adaptive on Opus 5); depth is steered with
 *   output_config.effort per call type instead of sampling params.
 * - Refusals are surfaced as errors (never silently treated as chat).
 */
export class AnthropicChatBackend implements ChatBackend {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(private opts: AnthropicChatOptions) {
    // apiKey undefined → SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile.
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  private effortFor(req: ChatRequest): Effort {
    return req.label === 'blueprint' ? this.opts.effortPlanning : this.opts.effortChat;
  }

  /** Only Opus 5 / Fable / Mythos accept the `fallbacks` parameter — Sonnet and Haiku reject it with a 400. */
  private supportsFallbacks(model: string): boolean {
    return /^claude-(opus-5|opus-4-8|fable-5(-1)?|mythos-5(-1)?)$/.test(model);
  }

  private toMessages(turns: ChatTurn[]): Anthropic.MessageParam[] {
    // The first message must be from the user; drop any leading assistant turns from history.
    const start = turns.findIndex(t => t.role === 'user');
    const usable = start >= 0 ? turns.slice(start) : [];
    return usable.map(t => ({ role: t.role, content: t.content }));
  }

  async complete(req: ChatRequest): Promise<string> {
    const model = req.tier === 'reasoning' ? this.opts.reasoningModel : this.opts.chatModel;
    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: req.json ? `${req.system.stable}\n\nRespond with a single JSON object and nothing else.` : req.system.stable, cache_control: { type: 'ephemeral' } },
    ];
    if (req.system.dynamic) system.push({ type: 'text', text: req.system.dynamic });

    const messages = this.toMessages(req.messages);
    if (messages.length === 0) throw new Error('No user message to send');

    const base = {
      model,
      max_tokens: req.maxTokens,
      system,
      messages,
      output_config: { effort: this.effortFor(req) },
    };

    const useFallbacks = this.opts.fallbacks && this.supportsFallbacks(model);
    const response = await withRetry<AnyMessage>(req.label, async () => {
      if (useFallbacks) {
        return this.client.beta.messages.create({
          ...base,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
      }
      return this.client.messages.create(base);
    }, 2, (status, attempt) => log.warn({ label: req.label, status, attempt }, 'Retryable error'));

    if (response.stop_reason === 'refusal') {
      const details = ('stop_details' in response ? response.stop_details : undefined) as { explanation?: string } | undefined;
      throw new Error(`Claude declined the request${details?.explanation ? `: ${details.explanation}` : ''}`);
    }
    if (response.stop_reason === 'max_tokens') {
      log.warn({ label: req.label, model }, 'Response hit max_tokens — output may be truncated');
    }

    const usage: any = response.usage;
    log.debug({
      label: req.label,
      model: response.model,
      input: usage?.input_tokens,
      cacheRead: usage?.cache_read_input_tokens,
      cacheWrite: usage?.cache_creation_input_tokens,
      output: usage?.output_tokens,
    }, 'Claude usage');

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
    if (!text) throw new Error(`Empty response from ${model}`);
    return text;
  }

  async describeImage(prompt: string, imageBase64: string, mimeType: string, maxTokens: number): Promise<string> {
    const media = (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType) ? mimeType : 'image/jpeg') as ImageMediaType;
    const model = this.opts.visionModel;
    const visionBase = {
      model,
      max_tokens: maxTokens,
      output_config: { effort: this.opts.effortChat },
      messages: [{
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: media, data: imageBase64 } },
          { type: 'text' as const, text: prompt },
        ],
      }],
    };
    const response = await withRetry<AnyMessage>('vision', () => {
      if (this.opts.fallbacks && this.supportsFallbacks(model)) {
        return this.client.beta.messages.create({ ...visionBase, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
      }
      return this.client.messages.create(visionBase);
    });

    if (response.stop_reason === 'refusal') throw new Error('Claude declined to read the image');
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) throw new Error('Empty vision response');
    return text;
  }
}
