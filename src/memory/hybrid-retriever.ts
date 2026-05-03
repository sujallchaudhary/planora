import { preferenceRepo } from './mongo/repositories/preference.repo.js';
import { taskHistoryRepo } from './mongo/repositories/task-history.repo.js';
import { SemanticMemory, type SemanticMatch } from './qdrant/semantic-memory.js';
import { Habit } from './mongo/models/habit.model.js';
import { Constraint } from './mongo/models/constraint.model.js';
import type { IPreference } from './mongo/models/preference.model.js';
import type { IHabit } from './mongo/models/habit.model.js';
import type { IConstraint } from './mongo/models/constraint.model.js';
import type { ITaskHistory } from './mongo/models/task-history.model.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('hybrid-retriever');

export interface RetrievedMemory {
  preferences: IPreference[];
  habits: IHabit[];
  constraints: IConstraint[];
  semanticContext: SemanticMatch[];
  recentHistory: ITaskHistory[];
}

export class HybridRetriever {
  constructor(private semanticMemory: SemanticMemory) {}

  async retrieve(telegramId: number, context: string, confidenceThreshold: number): Promise<RetrievedMemory> {
    log.debug({ telegramId }, 'Retrieving hybrid memory');

    // Run all retrieval in parallel for speed
    const [preferences, habits, constraints, semanticContext, recentHistory] = await Promise.all([
      preferenceRepo.findHighConfidence(telegramId, confidenceThreshold),
      Habit.find({ telegramId, isActive: true, confidence: { $gte: confidenceThreshold } }),
      Constraint.find({ telegramId, isActive: true }),
      this.semanticMemory.search(telegramId, context, 5).catch((err) => {
        log.warn({ err }, 'Semantic search failed, continuing without it');
        return [] as SemanticMatch[];
      }),
      taskHistoryRepo.findRecentHistory(telegramId, 7),
    ]);

    log.debug({
      preferences: preferences.length,
      habits: habits.length,
      constraints: constraints.length,
      semantic: semanticContext.length,
      history: recentHistory.length,
    }, 'Retrieved hybrid memory');

    return { preferences, habits, constraints, semanticContext, recentHistory };
  }
}
