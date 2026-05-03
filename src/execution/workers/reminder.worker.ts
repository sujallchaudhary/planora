import { Worker } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES } from '../queue.js';
import type { ReminderJobData } from '../job-manager.js';
import { getBotInstance } from '../../bot/bot.js';
import { buildTaskKeyboard } from '../../bot/keyboards/task.keyboard.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { formatTimeHuman } from '../../utils/date.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('worker:reminder');

export function startReminderWorker(): Worker {
  const worker = new Worker<ReminderJobData>(
    QUEUE_NAMES.REMINDERS,
    async (job) => {
      const { telegramId, title, description, startTime, endTime, type, entryId } = job.data;
      log.info({ telegramId, title, type }, 'Processing reminder');

      const bot = getBotInstance();
      const user = await userRepo.findByTelegramId(telegramId);
      const config = resolveUserConfig(user?.settings);
      const startStr = formatTimeHuman(new Date(startTime), config.timezone);
      const endStr = formatTimeHuman(new Date(endTime), config.timezone);

      let message: string;
      if (type === 'pre_reminder') {
        message = `⏰ Coming up in ${config.reminderLeadMinutes} min:\n\n📋 *${title}*\n🕐 ${startStr} – ${endStr}`;
      } else {
        message = `🚀 Time to start:\n\n📋 *${title}*\n🕐 ${startStr} – ${endStr}`;
      }
      if (description) message += `\n📝 ${description}`;

      await bot.api.sendMessage(telegramId, message, {
        parse_mode: 'Markdown',
        reply_markup: buildTaskKeyboard(entryId, config.snoozeMinutes),
      });
    },
    {
      connection: getRedisConnection(),
      removeOnComplete: { count: 100 },
      removeOnFail: { age: 7 * 24 * 3600 },
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'Reminder job failed');
  });

  log.info('Reminder worker started');
  return worker;
}
