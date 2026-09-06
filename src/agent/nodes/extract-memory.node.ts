import type { AgentState } from '../state.js';
import { MemoryType } from '../../config/defaults.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { preferenceRepo } from '../../memory/mongo/repositories/preference.repo.js';
import { Habit } from '../../memory/mongo/models/habit.model.js';
import { Constraint } from '../../memory/mongo/models/constraint.model.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { SemanticMemory } from '../../memory/qdrant/semantic-memory.js';
import { getLLMProvider } from '../../llm/index.js';
import { normalizeDays, canonicalizePreference, isAllDayRange } from '../../memory/memory-utils.js';
import { normalizeTimeString, isValidDateString } from '../../utils/date.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('node:extract-memory');

function slug(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function reinforce(existing: number | undefined, incoming: number): number {
  if (existing === undefined) return incoming;
  return Math.min(0.98, Math.max(existing, incoming) + 0.04);
}

export async function extractMemoryNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.intent || state.intent.memorySignals.length === 0 || state.intent.classificationError) {
    return {};
  }

  const user = await userRepo.findByTelegramId(state.telegramId);
  if (!user) return {};

  const config = resolveUserConfig(user.settings);
  const llm = getLLMProvider();
  const semanticMemory = new SemanticMemory((t: string) => llm.getEmbedding(t));
  let scheduleAffecting = false;

  for (const signal of state.intent.memorySignals) {
    if (signal.confidence < Math.min(config.memoryConfidenceThreshold, 0.7)) {
      log.debug({ key: signal.key, confidence: signal.confidence }, 'Skipping low-confidence memory signal');
      continue;
    }

    const start = normalizeTimeString(signal.timeRange?.start);
    const end = normalizeTimeString(signal.timeRange?.end);
    const timeRange = start && end && start !== end ? { start, end } : { start: '00:00', end: '23:59' };
    const days = normalizeDays(signal.timeRange?.days);
    const expiresOn = isValidDateString(signal.until) ? signal.until : undefined;
    const key = slug(signal.key);

    try {
      switch (signal.type) {
        case MemoryType.PREFERENCE: {
          const canon = canonicalizePreference(signal.key, signal.value);
          await preferenceRepo.upsert(state.telegramId, user._id as any, {
            key: canon.key,
            value: canon.value,
            confidence: signal.confidence,
            source: 'explicit',
          });
          log.info({ key: canon.key, value: canon.value }, 'Stored preference');
          break;
        }

        case MemoryType.HABIT: {
          const existing = await Habit.findOne({ telegramId: state.telegramId, key });
          await Habit.findOneAndUpdate(
            { telegramId: state.telegramId, key },
            {
              $set: {
                userId: user._id,
                description: signal.value,
                timeRange,
                days,
                frequency: days.includes('daily') ? 'daily' : 'weekly',
                confidence: reinforce(existing?.confidence, signal.confidence),
                isActive: true,
              },
              $inc: { dataPoints: 1 },
            },
            { upsert: true, new: true }
          );
          if (!isAllDayRange(timeRange)) scheduleAffecting = true;
          log.info({ key, days, timeRange }, 'Stored habit');
          break;
        }

        case MemoryType.CONSTRAINT: {
          const existing = await Constraint.findOne({ telegramId: state.telegramId, key });
          await Constraint.findOneAndUpdate(
            { telegramId: state.telegramId, key },
            {
              $set: {
                userId: user._id,
                description: signal.value,
                timeRange,
                days,
                isRecurring: true,
                confidence: reinforce(existing?.confidence, signal.confidence),
                isActive: true,
                ...(expiresOn ? { expiresOn } : {}),
              },
              ...(expiresOn ? {} : { $unset: { expiresOn: 1 } }),
              $inc: { dataPoints: 1 },
            },
            { upsert: true, new: true }
          );
          if (!isAllDayRange(timeRange)) scheduleAffecting = true;
          log.info({ key, days, timeRange, expiresOn }, 'Stored constraint');
          break;
        }
      }

      await semanticMemory.store({
        userId: String(user._id),
        telegramId: state.telegramId,
        type: signal.type,
        content: `${signal.key}: ${signal.value}${expiresOn ? ` (until ${expiresOn})` : ''}`,
        metadata: { key, timeRange, days, expiresOn: expiresOn ?? null, source: 'user_message' },
        timestamp: new Date().toISOString(),
        confidence: signal.confidence,
      }).catch(err => {
        log.warn({ err: err?.message, key }, 'Failed to store in vector DB — MongoDB entry is still saved');
      });
    } catch (error) {
      log.error({ error, signal }, 'Failed to store memory signal');
    }
  }

  return { memoryChanged: scheduleAffecting };
}
