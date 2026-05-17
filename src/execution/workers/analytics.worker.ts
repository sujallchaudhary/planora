import { Worker } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES, getAnalyticsQueue } from '../queue.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskHistoryRepo } from '../../memory/mongo/repositories/task-history.repo.js';
import { preferenceRepo } from '../../memory/mongo/repositories/preference.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { storeInsight } from '../../memory/mem0-memory.js';
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
      const blockStats = await taskHistoryRepo.getCompletionRatesByTimeBlock(telegramId, 21);

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

      const eligibleBlocks = Object.entries(blockStats).filter(([, s]) => s.total >= config.memoryMinDataPoints);
      const bestBlock = eligibleBlocks
        .filter(([, s]) => s.rate >= 0.7)
        .sort((a, b) => b[1].rate - a[1].rate)[0];
      const worstBlock = eligibleBlocks
        .filter(([, s]) => s.rate <= 0.4)
        .sort((a, b) => a[1].rate - b[1].rate)[0];

      if (bestBlock) {
        await preferenceRepo.upsert(telegramId, user._id, {
          key: 'peak_focus_window',
          value: bestBlock[0],
          confidence: Math.min(0.92, 0.55 + bestBlock[1].rate * 0.35),
          source: 'inferred',
        });
        log.info({ telegramId, block: bestBlock[0], rate: bestBlock[1].rate }, 'Detected peak focus window');
      }

      if (worstBlock) {
        await preferenceRepo.upsert(telegramId, user._id, {
          key: 'low_success_window',
          value: worstBlock[0],
          confidence: Math.min(0.9, 0.55 + (1 - worstBlock[1].rate) * 0.3),
          source: 'inferred',
        });
        log.info({ telegramId, block: worstBlock[0], rate: worstBlock[1].rate }, 'Detected low-success window');
      }

      // Store behavioral insight in Mem0
      try {
        const summary = `Week summary: ${JSON.stringify(stats)}, morning completion: ${(morningRate * 100).toFixed(0)}%, block stats: ${JSON.stringify(blockStats)}`;
        await storeInsight(summary, user._id.toString());
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
