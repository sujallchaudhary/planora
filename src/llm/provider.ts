import type { ClassificationResult, ImageExtractionResult } from '../utils/zod-schemas.js';

export interface UserContext {
  telegramId: number;
  firstName: string;
  timezone: string;
  currentTime: string;
  currentDate: string;
  /** The date the user considers 'today' — shifted back if before lateNightThresholdHour */
  planningDate?: string;
  /** The date the user considers 'tomorrow' — shifted accordingly */
  tomorrowDate?: string;
  /** True if current time is before the late-night threshold */
  isLateNight?: boolean;
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

import { ChatOpenAI } from '@langchain/openai';

export interface LLMProvider {
  /**
   * Get the LangChain model for the ReAct agent.
   */
  getLangChainModel(): ChatOpenAI;

  /**
   * Extract content from an image (base64 encoded).
   */
  extractImageContent(imageBase64: string, mimeType: string): Promise<ImageExtractionResult>;

  /**
   * Generate an embedding vector for text.
   */
  getEmbedding(text: string): Promise<number[]>;
}
