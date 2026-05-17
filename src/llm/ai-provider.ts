import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { env } from '../config/env.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('ai-provider');

// ─── Chat / Reasoning provider ─────────────────────────────────────────────────
const chatProvider = createOpenAI({
  ...(env.LLM_BASE_URL ? { baseURL: env.LLM_BASE_URL } : {}),
  apiKey: env.LLM_API_KEY,
  compatibility: 'compatible',
});

// ─── Vision provider (falls back to chat if not configured) ─────────────────────
const visionProvider = createOpenAI({
  ...(env.VISION_BASE_URL || env.LLM_BASE_URL ? { baseURL: env.VISION_BASE_URL || env.LLM_BASE_URL } : {}),
  apiKey: env.VISION_API_KEY || env.LLM_API_KEY,
  compatibility: 'compatible',
});

// ─── Model references ───────────────────────────────────────────────────────────
// structuredOutputs: false on chatModel because our tool schemas use optional fields,
// and OpenAI strict mode requires ALL properties in 'required'.
export const chatModel = chatProvider(env.LLM_CHAT_MODEL, {
  structuredOutputs: false,
});

export const reasoningModel = chatProvider(env.LLM_REASONING_MODEL, {
  structuredOutputs: true,
});

export const visionModel = visionProvider(env.LLM_VISION_MODEL);

log.info({
  chatBaseURL: env.LLM_BASE_URL,
  visionBaseURL: env.VISION_BASE_URL || env.LLM_BASE_URL,
  chatModel: env.LLM_CHAT_MODEL,
  reasoningModel: env.LLM_REASONING_MODEL,
  visionModel: env.LLM_VISION_MODEL,
}, 'Initialized AI SDK providers');

// ─── Image content extraction (using vision model) ─────────────────────────────
export async function extractImageContent(
  imageBase64: string,
  mimeType: string,
): Promise<{ content: string; tasks: string[]; context?: string }> {
  try {
    const result = await generateText({
      model: visionModel,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyze this image and extract all relevant content. Identify any tasks, dates, schedules, or important information. Provide a clear text summary that can be used for task planning.`,
          },
          {
            type: 'image',
            image: imageBase64,
            mimeType: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          },
        ],
      }],
    });

    return {
      content: result.text,
      tasks: [],
      context: result.text,
    };
  } catch (error) {
    log.error({ error }, 'Failed to extract image content');
    return {
      content: 'Failed to extract content from the image.',
      tasks: [],
    };
  }
}
