import { env } from '../config/env.js';
import { LLMService } from './llm-service.js';
import type { ChatBackend, EmbeddingBackend } from './types.js';
import { OpenAIChatBackend } from './backends/openai-chat.backend.js';
import { AnthropicChatBackend } from './backends/anthropic-chat.backend.js';
import { OpenAIEmbeddingBackend } from './backends/openai-embeddings.backend.js';
import { LocalEmbeddingBackend } from './backends/local-embeddings.backend.js';

let service: LLMService | null = null;

function openAIChat(): ChatBackend {
  return new OpenAIChatBackend({
    baseURL: env.LLM_BASE_URL!,
    apiKey: env.LLM_API_KEY!,
    chatModel: env.LLM_CHAT_MODEL,
    reasoningModel: env.LLM_REASONING_MODEL,
    visionModel: env.LLM_VISION_MODEL,
    temperature: env.LLM_TEMPERATURE,
    jsonMode: env.LLM_JSON_MODE,
  });
}

function anthropicChat(): ChatBackend {
  return new AnthropicChatBackend({
    apiKey: env.ANTHROPIC_API_KEY,
    chatModel: env.ANTHROPIC_CHAT_MODEL,
    reasoningModel: env.ANTHROPIC_REASONING_MODEL,
    visionModel: env.ANTHROPIC_VISION_MODEL,
    fallbacks: env.ANTHROPIC_FALLBACKS,
    effortChat: env.ANTHROPIC_EFFORT_CHAT,
    effortPlanning: env.ANTHROPIC_EFFORT_PLANNING,
  });
}

function buildVision(chat: ChatBackend): ChatBackend {
  const provider = env.VISION_PROVIDER ?? env.LLM_PROVIDER;
  if (provider === 'anthropic') return env.LLM_PROVIDER === 'anthropic' ? chat : anthropicChat();
  if (env.LLM_PROVIDER === 'openai' && !env.VISION_BASE_URL) return chat;
  return new OpenAIChatBackend({
    baseURL: env.VISION_BASE_URL || env.LLM_BASE_URL!,
    apiKey: env.VISION_API_KEY || env.LLM_API_KEY!,
    chatModel: env.LLM_VISION_MODEL,
    reasoningModel: env.LLM_VISION_MODEL,
    visionModel: env.LLM_VISION_MODEL,
    temperature: env.LLM_TEMPERATURE,
    jsonMode: false,
  });
}

function buildEmbeddings(): EmbeddingBackend {
  if (env.EMBEDDING_PROVIDER === 'local') {
    return new LocalEmbeddingBackend(env.LOCAL_EMBEDDING_MODEL, env.LOCAL_EMBEDDING_DIMENSIONS, env.TRANSFORMERS_CACHE_DIR);
  }
  return new OpenAIEmbeddingBackend({
    baseURL: env.EMBEDDING_BASE_URL || env.LLM_BASE_URL!,
    apiKey: env.EMBEDDING_API_KEY || env.LLM_API_KEY!,
    model: env.LLM_EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
  });
}

export function getLLMProvider(): LLMService {
  if (!service) {
    const chat = env.LLM_PROVIDER === 'anthropic' ? anthropicChat() : openAIChat();
    service = new LLMService(chat, buildVision(chat), buildEmbeddings(), {
      maxTokens: env.LLM_MAX_TOKENS,
      temperature: env.LLM_TEMPERATURE,
    });
  }
  return service;
}

/** Vector size the Qdrant collection must have for the active embedding backend. */
export function getEmbeddingDimensions(): number {
  return env.EMBEDDING_PROVIDER === 'local' ? env.LOCAL_EMBEDDING_DIMENSIONS : env.EMBEDDING_DIMENSIONS;
}
