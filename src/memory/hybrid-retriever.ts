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

export const EMPTY_MEMORY: RetrievedMemory = {
  preferences: [],
  habits: [],
  constraints: [],
  semanticContext: [],
  recentHistory: [],
};

export interface RetrieveOptions {
  /** yyyy-MM-dd used to drop expired constraints. */
  asOfDate?: string;
  /** Skip the vector search (planning paths don't need chat context). */
  skipSemantic?: boolean;
}

export class HybridRetriever {
  constructor(private semanticMemory: SemanticMemory) {}

  async retrieve(telegramId: number, context: string, confidenceThreshold: number, options: RetrieveOptions = {}): Promise<RetrievedMemory> {
    log.debug({ telegramId }, 'Retrieving hybrid memory');

    const semanticPromise = options.skipSemantic
      ? Promise.resolve([] as SemanticMatch[])
      : this.semanticMemory.embed(context)
          // One embedding, two filtered searches: real memory first, then a little chat context
          .then(vector => Promise.all([
            this.semanticMemory.searchByVector(telegramId, vector, 5, { excludeTypes: ['conversation'] }),
            this.semanticMemory.searchByVector(telegramId, vector, 2, { types: ['conversation'] }),
          ]))
          .then(([memory, conversation]) => [...memory, ...conversation])
          .catch((err) => {
            log.warn({ err: err?.message ?? err }, 'Semantic search failed, continuing without it');
            return [] as SemanticMatch[];
          });

    const [preferences, habits, rawConstraints, semanticContext, recentHistory] = await Promise.all([
      preferenceRepo.findHighConfidence(telegramId, confidenceThreshold),
      Habit.find({ telegramId, isActive: true, confidence: { $gte: Math.min(confidenceThreshold, 0.6) } }),
      Constraint.find({ telegramId, isActive: true }),
      semanticPromise,
      taskHistoryRepo.findRecentHistory(telegramId, 7),
    ]);

    // Expire temporary constraints ("exams until the 20th") lazily.
    const constraints: IConstraint[] = [];
    for (const c of rawConstraints) {
      if (options.asOfDate && c.expiresOn && c.expiresOn < options.asOfDate) {
        await Constraint.updateOne({ _id: c._id }, { $set: { isActive: false } }).catch(() => undefined);
        log.info({ telegramId, key: c.key }, 'Constraint expired');
        continue;
      }
      constraints.push(c);
    }

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
