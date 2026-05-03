import type { ClassificationResult, ImageExtractionResult } from '../utils/zod-schemas.js';

export interface UserContext {
  telegramId: number;
  firstName: string;
  timezone: string;
  currentTime: string;
  currentDate: string;
  pendingTaskCount: number;
  hasScheduleToday: boolean;
  recentMemorySummary?: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ActionResult {
  success: boolean;
  action: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LLMProvider {
  /**
   * Single LLM call: classify intent + extract tasks + extract memory signals.
   */
  classifyAndExtract(input: string, context: UserContext): Promise<ClassificationResult>;

  /**
   * Generate a natural language response based on the action result and context.
   */
  generateResponse(
    input: string,
    classification: ClassificationResult,
    result: ActionResult,
    context: UserContext,
  ): Promise<string>;

  /**
   * Extract content from an image (base64 encoded).
   */
  extractImageContent(imageBase64: string, mimeType: string): Promise<ImageExtractionResult>;

  /**
   * Generate an embedding vector for text.
   */
  getEmbedding(text: string): Promise<number[]>;
}
