import OpenAI from 'openai';
import { ChatOpenAI } from '@langchain/openai';
import { env } from '../config/env.js';
import type { LLMProvider } from './provider.js';
import {
  ImageExtractionResultSchema,
  type ImageExtractionResult,
} from '../utils/zod-schemas.js';
import { IMAGE_EXTRACTION_PROMPT } from '../agent/prompts/image-extraction.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('llm-openai');

export class OpenAICompatibleProvider implements LLMProvider {
  private chatClient: OpenAI;
  private visionClient: OpenAI;
  private embeddingClient: OpenAI;
  private chatModel: string;
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
    this.visionModel = env.LLM_VISION_MODEL;
    this.embeddingModel = env.LLM_EMBEDDING_MODEL;
    this.temperature = env.LLM_TEMPERATURE;
    this.maxTokens = env.LLM_MAX_TOKENS;

    log.info({
      chatBaseURL: env.LLM_BASE_URL,
      visionBaseURL: env.VISION_BASE_URL || env.LLM_BASE_URL,
      embeddingBaseURL: env.EMBEDDING_BASE_URL || env.LLM_BASE_URL,
      chatModel: this.chatModel,
      visionModel: this.visionModel,
      embeddingModel: this.embeddingModel,
    }, 'Initialized OpenAI-compatible LLM provider (multi-endpoint)');
  }

  getLangChainModel() {
    return new ChatOpenAI({
      modelName: this.chatModel,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      configuration: {
        baseURL: env.LLM_BASE_URL,
        apiKey: env.LLM_API_KEY,
      },
    });
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
}

// Singleton instance
let provider: OpenAICompatibleProvider | null = null;

export function getLLMProvider(): OpenAICompatibleProvider {
  if (!provider) {
    provider = new OpenAICompatibleProvider();
  }
  return provider;
}
