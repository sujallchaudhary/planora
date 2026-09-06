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
  /** The date the user considers 'today' */
  planningDate?: string;
  /** The date the user considers 'tomorrow' — shifted in late-night mode */
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
  classifyAndExtract(input: string, context: UserContext): Promise<ClassificationResult>;
  generateResponse(input: string, classification: ClassificationResult, result: ActionResult, context: UserContext): Promise<string>;
  extractImageContent(imageBase64: string, mimeType: string): Promise<ImageExtractionResult>;
  getEmbedding(text: string): Promise<number[]>;
  generateScheduleBlueprint(tasks: ITask[], memory: RetrievedMemory, config: UserConfig, targetDate: string): Promise<ScheduleBlueprint | null>;
}
