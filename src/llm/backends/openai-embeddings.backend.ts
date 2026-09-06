import OpenAI from 'openai';
import type { EmbeddingBackend } from '../types.js';
import { withRetry } from '../types.js';

export class OpenAIEmbeddingBackend implements EmbeddingBackend {
  readonly name = 'openai-compatible';
  private client: OpenAI;

  constructor(opts: { baseURL: string; apiKey: string; model: string; dimensions: number }, private model = opts.model, readonly dimensions = opts.dimensions) {
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const response = await withRetry('embed', () => this.client.embeddings.create({ model: this.model, input: text }));
    return response.data[0]!.embedding;
  }
}
