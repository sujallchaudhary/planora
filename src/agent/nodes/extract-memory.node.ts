import type { AgentState } from '../state.js';
import { MemoryType } from '../../config/defaults.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { preferenceRepo } from '../../memory/mongo/repositories/preference.repo.js';
import { Habit } from '../../memory/mongo/models/habit.model.js';
import { Constraint } from '../../memory/mongo/models/constraint.model.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { SemanticMemory } from '../../memory/qdrant/semantic-memory.js';
import { getLLMProvider } from '../../llm/openai-compatible.provider.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('node:extract-memory');

export async function extractMemoryNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.intent || state.intent.memorySignals.length === 0) {
    return {};
  }

  const user = await userRepo.findByTelegramId(state.telegramId);
  if (!user) return {};

  const config = resolveUserConfig(user.settings);

  // Prepare semantic memory for vector storage
  const llm = getLLMProvider();
  const semanticMemory = new SemanticMemory((t: string) => llm.getEmbedding(t));

  for (const signal of state.intent.memorySignals) {
    if (signal.confidence < config.memoryConfidenceThreshold) {
      log.debug({ key: signal.key, confidence: signal.confidence }, 'Skipping low-confidence memory signal');
      continue;
    }

    try {
      switch (signal.type) {
        case MemoryType.PREFERENCE:
          await preferenceRepo.upsert(state.telegramId, user._id, {
            key: signal.key,
            value: signal.value,
            confidence: signal.confidence,
            source: 'explicit',
          });
          log.info({ key: signal.key, value: signal.value }, 'Stored preference');
          break;

        case MemoryType.HABIT:
          await Habit.findOneAndUpdate(
            { telegramId: state.telegramId, key: signal.key },
            {
              $set: {
                userId: user._id,
                description: signal.value,
                timeRange: {
                  start: signal.timeRange?.start ?? '00:00',
                  end: signal.timeRange?.end ?? '23:59',
                },
                days: signal.timeRange?.days ?? ['daily'],
                frequency: 'daily',
                confidence: signal.confidence,
                isActive: true,
              },
              $inc: { dataPoints: 1 },
            },
            { upsert: true, new: true }
          );
          log.info({ key: signal.key }, 'Stored habit');
          break;

        case MemoryType.CONSTRAINT:
          await Constraint.findOneAndUpdate(
            { telegramId: state.telegramId, key: signal.key },
            {
              $set: {
                userId: user._id,
                description: signal.value,
                timeRange: {
                  start: signal.timeRange?.start ?? '00:00',
                  end: signal.timeRange?.end ?? '23:59',
                },
                days: signal.timeRange?.days ?? ['daily'],
                isRecurring: true,
                isActive: true,
              },
            },
            { upsert: true, new: true }
          );
          log.info({ key: signal.key }, 'Stored constraint');
          break;
      }

      // Also store in Qdrant vector store for semantic retrieval
      await semanticMemory.store({
        userId: user._id.toString(),
        telegramId: state.telegramId,
        type: signal.type,
        content: `${signal.key}: ${signal.value}`,
        metadata: {
          key: signal.key,
          timeRange: signal.timeRange ?? null,
          source: 'user_message',
        },
        timestamp: new Date().toISOString(),
        confidence: signal.confidence,
      }).catch(err => {
        log.warn({ err: err?.message, key: signal.key }, 'Failed to store in vector DB — MongoDB entry is still saved');
      });

    } catch (error) {
      log.error({ error, signal }, 'Failed to store memory signal');
    }
  }

  return {};
}
