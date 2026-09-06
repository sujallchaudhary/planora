import OpenAI from 'openai';
import type { ChatBackend, ChatRequest } from '../types.js';
import { joinSystemPrompt, withRetry } from '../types.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('llm:openai');

export interface OpenAIChatOptions {
  baseURL: string;
  apiKey: string;
  chatModel: string;
  reasoningModel: string;
  visionModel: string;
  temperature: number;
  jsonMode: boolean;
}

/** Any OpenAI-compatible endpoint: OpenAI, SambaNova, Groq, Together, Ollama, vLLM, LiteLLM... */
export class OpenAIChatBackend implements ChatBackend {
  readonly name = 'openai-compatible';
  private client: OpenAI;

  constructor(private opts: OpenAIChatOptions) {
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
  }

  async complete(req: ChatRequest): Promise<string> {
    const model = req.tier === 'reasoning' ? this.opts.reasoningModel : this.opts.chatModel;
    const response = await withRetry(req.label, () => this.client.chat.completions.create({
      model,
      temperature: req.temperature ?? this.opts.temperature,
      max_tokens: req.maxTokens,
      ...(req.json && this.opts.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      messages: [
        { role: 'system', content: joinSystemPrompt(req.system) },
        ...req.messages,
      ],
    }), 2, (status, attempt) => log.warn({ label: req.label, status, attempt }, 'Retryable error'));

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error(`Empty response from ${model}`);
    return content;
  }

  async describeImage(prompt: string, imageBase64: string, mimeType: string, maxTokens: number): Promise<string> {
    const response = await withRetry('vision', () => this.client.chat.completions.create({
      model: this.opts.visionModel,
      temperature: this.opts.temperature,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      }],
    }));
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty vision response');
    return content;
  }
}
