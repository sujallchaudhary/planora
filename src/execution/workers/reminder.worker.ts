import { Worker } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES } from '../queue.js';
import { syncReminders, type ReminderJobData } from '../job-manager.js';
import { getBotInstance } from '../../bot/bot.js';
import { buildTaskKeyboard } from '../../bot/keyboards/task.keyboard.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { taskHistoryRepo } from '../../memory/mongo/repositories/task-history.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { ScheduleEntryStatus, TaskStatus } from '../../config/defaults.js';
import { replan } from '../../scheduler/replanner.js';
import { getStructuredMemory } from '../../memory/hybrid-retriever.js';
import { formatTimeHuman } from '../../utils/date.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('worker:reminder');

export function startReminderWorker(): Worker {
  const worker = new Worker<ReminderJobData>(
    QUEUE_NAMES.REMINDERS,
    async (job) => {
      const { telegramId, date, title, description, startTime, endTime, type, entryId } = job.data;
      log.info({ telegramId, title, type }, 'Processing reminder');

      const bot = getBotInstance();
      const user = await userRepo.findByTelegramId(telegramId);
      const config = resolveUserConfig(user?.settings);
      const schedule = await scheduleRepo.findByDate(telegramId, date);
      const entry = schedule?.entries.find((e: any) => e._id.toString() === entryId);

      if (!entry) {
        log.info({ telegramId, entryId }, 'Reminder entry no longer exists');
        return;
      }

      if ([ScheduleEntryStatus.COMPLETED, ScheduleEntryStatus.SKIPPED, ScheduleEntryStatus.MISSED].includes(entry.status as ScheduleEntryStatus)) {
        log.info({ telegramId, entryId, status: entry.status }, 'Skipping reminder for resolved entry');
        return;
      }

      const startStr = formatTimeHuman(new Date(startTime), config.timezone);
      const endStr = formatTimeHuman(new Date(endTime), config.timezone);

      let message: string;
      if (type === 'pre_reminder') {
        message = `Coming up in ${config.reminderLeadMinutes} min:\n\n*${title}*\n${startStr} - ${endStr}`;
      } else if (type === 'follow_up') {
        message = `Quick check-in:\n\n*${title}*\nPlanned ${startStr} - ${endStr}\n\nStill working on it, or should I adjust the day?`;
      } else if (type === 'escalation') {
        message = `I did not see an update for:\n\n*${title}*\nPlanned ${startStr} - ${endStr}\n\nI am marking it missed for now and reshaping the remaining schedule.`;
        await markMissedAndReplan(telegramId, date, entryId);
      } else if (type === 'snooze_reminder') {
        message = `Snooze ended:\n\n*${title}*\n${startStr} - ${endStr}`;
      } else {
        message = `Time to start:\n\n*${title}*\n${startStr} - ${endStr}`;
        await scheduleRepo.updateEntryStatus(telegramId, date, entryId, ScheduleEntryStatus.ACTIVE);
      }

      if (description) message += `\n${description}`;

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

async function markMissedAndReplan(telegramId: number, date: string, entryId: string): Promise<void> {
  const user = await userRepo.findByTelegramId(telegramId);
  if (!user) return;

  const schedule = await scheduleRepo.findByDate(telegramId, date);
  const entry = schedule?.entries.find((e: any) => e._id.toString() === entryId);
  if (!entry || entry.status === ScheduleEntryStatus.COMPLETED || entry.status === ScheduleEntryStatus.SKIPPED) {
    return;
  }

  await scheduleRepo.updateEntryStatus(telegramId, date, entryId, ScheduleEntryStatus.MISSED);

  if (entry.taskId) {
    await taskRepo.updateStatus(entry.taskId.toString(), TaskStatus.MISSED);
    await taskHistoryRepo.record({
      userId: user._id,
      telegramId,
      taskId: entry.taskId,
      title: entry.title,
      scheduledDate: date,
      scheduledStartTime: entry.startTime,
      scheduledEndTime: entry.endTime,
      outcome: 'missed',
    });
  }

  const config = resolveUserConfig(user.settings);
  const tasks = await taskRepo.findPendingTasks(telegramId);
  const updatedSchedule = await scheduleRepo.findByDate(telegramId, date);
  const memory = await getStructuredMemory(telegramId, config.memoryConfidenceThreshold);
  const entries = await replan(
    tasks,
    updatedSchedule?.entries ?? [],
    memory,
    config,
    date,
    {
      trigger: 'missed_task_escalation',
      reason: `Missed ${entry.title}`,
      scheduleStability: 'preserve',
    },
  );

  const saved = await scheduleRepo.createOrReplace(telegramId, user._id, date, entries);
  await syncReminders(telegramId, date, saved.entries);
}
