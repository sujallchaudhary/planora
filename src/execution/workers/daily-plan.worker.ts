import { Worker } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES } from '../queue.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { getStructuredMemory } from '../../memory/hybrid-retriever.js';
import { planSchedule } from '../../scheduler/planner.js';
import { syncReminders } from '../job-manager.js';
import { getBotInstance } from '../../bot/bot.js';
import { todayString, formatTimeHuman } from '../../utils/date.js';
import { getDailyPlanQueue } from '../queue.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('worker:daily-plan');

export function startDailyPlanWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.DAILY_PLAN,
    async (job) => {
      const { telegramId } = job.data as { telegramId: number };
      log.info({ telegramId }, 'Generating daily plan');

      const user = await userRepo.findByTelegramId(telegramId);
      if (!user) return;

      const config = resolveUserConfig(user.settings);
      const today = todayString(config.timezone);
      const tasks = await taskRepo.findPendingTasks(telegramId);

      const memory = await getStructuredMemory(telegramId, config.memoryConfidenceThreshold);
      const entries = await planSchedule(tasks, memory, config, today);

      if (entries.length === 0) {
        if (tasks.length === 0) {
           await getBotInstance().api.sendMessage(telegramId, '☀️ Good morning! You have no pending tasks and no habits/constraints scheduled. Enjoy your free day!');
        }
        return;
      }

      const schedule = await scheduleRepo.createOrReplace(telegramId, user._id, today, entries);
      await syncReminders(telegramId, today, schedule.entries);

      // Format and send
      const lines = entries.map(e => {
        const s = formatTimeHuman(e.startTime, config.timezone);
        const end = formatTimeHuman(e.endTime, config.timezone);
        return `📋 ${s} – ${end}: *${e.title}*`;
      });

      const msg = `☀️ *Your plan for today:*\n\n${lines.join('\n')}\n\n_${entries.length} tasks scheduled. Say "replan" anytime to adjust._`;
      await getBotInstance().api.sendMessage(telegramId, msg, { parse_mode: 'Markdown' });
    },
    {
      connection: getRedisConnection(),
      removeOnComplete: { count: 50 },
      removeOnFail: { age: 86400 },
    }
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'Daily plan job failed');
  });

  log.info('Daily plan worker started');
  return worker;
}

/**
 * Schedule daily plan generation for all active users.
 */
export async function scheduleDailyPlans(): Promise<void> {
  const users = await userRepo.getAllActiveUsers();
  const queue = getDailyPlanQueue();

  for (const user of users) {
    const config = resolveUserConfig(user.settings);
    const [hour, minute] = config.dailyPlanTime.split(':');
    // Use a repeatable job — runs daily
    await queue.add(
      'generate-plan',
      { telegramId: user.telegramId },
      {
        jobId: `daily-plan_${user.telegramId}`,
        repeat: {
          pattern: `0 ${minute} ${hour} * * *`,
          tz: config.timezone,
        },
        removeOnComplete: { count: 10 },
      }
    );
  }

  log.info({ users: users.length }, 'Scheduled daily plans');
}
