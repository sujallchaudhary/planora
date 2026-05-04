import type { ClassificationResult, ImageExtractionResult, ScheduleBlueprint } from '../utils/zod-schemas.js';
import type { ITask } from '../memory/mongo/models/task.model.js';
import type { RetrievedMemory } from '../memory/hybrid-retriever.js';
import type { UserConfig } from '../config/config-resolver.js';

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
  pendingTasksList?: string;
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

  generateScheduleBlueprint(
    tasks: ITask[],
    memory: RetrievedMemory,
    config: UserConfig,
    targetDate: string
  ): Promise<ScheduleBlueprint | null>;
}
