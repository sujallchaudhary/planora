import { preferenceRepo } from './mongo/repositories/preference.repo.js';
import { taskHistoryRepo } from './mongo/repositories/task-history.repo.js';
import { Habit } from './mongo/models/habit.model.js';
import { Constraint } from './mongo/models/constraint.model.js';
import type { IPreference } from './mongo/models/preference.model.js';
import type { IHabit } from './mongo/models/habit.model.js';
import type { IConstraint } from './mongo/models/constraint.model.js';
import type { ITaskHistory } from './mongo/models/task-history.model.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('hybrid-retriever');

export interface SemanticMatch {
  content: string;
  score: number;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface RetrievedMemory {
  preferences: IPreference[];
  habits: IHabit[];
  constraints: IConstraint[];
  semanticContext: SemanticMatch[];
  recentHistory: ITaskHistory[];
}

/**
 * Retrieve structured memory from MongoDB.
 * Semantic/behavioral memory is now handled by Mem0.
 */
export async function getStructuredMemory(telegramId: number, confidenceThreshold: number): Promise<RetrievedMemory> {
  log.debug({ telegramId }, 'Retrieving structured memory');

  const [preferences, habits, constraints, recentHistory] = await Promise.all([
    preferenceRepo.findHighConfidence(telegramId, confidenceThreshold),
    Habit.find({ telegramId, isActive: true, confidence: { $gte: confidenceThreshold } }),
    Constraint.find({ telegramId, isActive: true }),
    taskHistoryRepo.findRecentHistory(telegramId, 7),
  ]);

  log.debug({
    preferences: preferences.length,
    habits: habits.length,
    constraints: constraints.length,
    history: recentHistory.length,
  }, 'Retrieved structured memory');

  return { preferences, habits, constraints, semanticContext: [], recentHistory };
}
