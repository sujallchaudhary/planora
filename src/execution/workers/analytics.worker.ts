import { Worker } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES, getAnalyticsQueue } from '../queue.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskHistoryRepo } from '../../memory/mongo/repositories/task-history.repo.js';
import { preferenceRepo } from '../../memory/mongo/repositories/preference.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { SemanticMemory } from '../../memory/qdrant/semantic-memory.js';
import { getLLMProvider } from '../../llm/openai-compatible.provider.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('worker:analytics');

export function startAnalyticsWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.ANALYTICS,
    async (job) => {
      const { telegramId } = job.data as { telegramId: number };
      log.info({ telegramId }, 'Running behavioral analytics');

      const user = await userRepo.findByTelegramId(telegramId);
      if (!user) return;

      const config = resolveUserConfig(user.settings);
      const stats = await taskHistoryRepo.getOutcomeStats(telegramId, 7);
      const morningRate = await taskHistoryRepo.getMorningCompletionRate(telegramId, 7);

      // Conservative pattern detection
      if (morningRate < 0.3 && (stats['missed'] ?? 0) > config.memoryMinDataPoints) {
        await preferenceRepo.upsert(telegramId, user._id, {
          key: 'morning_task_difficulty',
          value: 'high',
          confidence: Math.min(0.9, 0.5 + ((stats['missed'] ?? 0) * 0.05)),
          source: 'inferred',
        });
        log.info({ telegramId, morningRate }, 'Detected morning task difficulty pattern');
      }

      // Store behavioral insight as semantic memory
      try {
        const llm = getLLMProvider();
        const semanticMemory = new SemanticMemory((t) => llm.getEmbedding(t));
        const summary = `Week summary: ${JSON.stringify(stats)}, morning completion: ${(morningRate * 100).toFixed(0)}%`;
        await semanticMemory.store({
          userId: user._id.toString(),
          telegramId,
          type: 'behavior',
          content: summary,
          metadata: { stats, morningRate },
          timestamp: new Date().toISOString(),
          confidence: 0.8,
        });
      } catch (err) {
        log.warn({ err }, 'Failed to store behavioral insight');
      }
    },
    {
      connection: getRedisConnection(),
      removeOnComplete: { count: 20 },
      removeOnFail: { age: 86400 },
    }
  );

  log.info('Analytics worker started');
  return worker;
}

export async function scheduleAnalytics(): Promise<void> {
  const users = await userRepo.getAllActiveUsers();
  const queue = getAnalyticsQueue();

  for (const user of users) {
    const config = resolveUserConfig(user.settings);
    const [hour, minute] = config.analyticsTime.split(':');
    await queue.add(
      'analyze',
      { telegramId: user.telegramId },
      {
        jobId: `analytics_${user.telegramId}`,
        repeat: { pattern: `0 ${minute} ${hour} * * *`, tz: config.timezone },
        removeOnComplete: { count: 5 },
      }
    );
  }
  log.info({ users: users.length }, 'Scheduled analytics');
}
