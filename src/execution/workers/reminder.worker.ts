import { Worker } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES } from '../queue.js';
import type { ReminderJobData } from '../job-manager.js';
import { getBotInstance } from '../../bot/bot.js';
import { buildTaskKeyboard } from '../../bot/keyboards/task.keyboard.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { taskHistoryRepo } from '../../memory/mongo/repositories/task-history.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { ScheduleEntryStatus, TaskStatus } from '../../config/defaults.js';
import { replanDay } from '../../scheduler/replan-service.js';
import { formatTimeHuman, addDaysToDateString } from '../../utils/date.js';
import { md } from '../../utils/markdown.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('worker:reminder');

const RESOLVED = [ScheduleEntryStatus.COMPLETED, ScheduleEntryStatus.SKIPPED, ScheduleEntryStatus.MISSED] as string[];

export function startReminderWorker(): Worker {
  const worker = new Worker<ReminderJobData>(
    QUEUE_NAMES.REMINDERS,
    async (job) => {
      const { telegramId, date, startTime, endTime, type, entryId } = job.data;
      log.info({ telegramId, title: job.data.title, type }, 'Processing reminder');

      const bot = getBotInstance();
      const user = await userRepo.findByTelegramId(telegramId);
      const config = resolveUserConfig(user?.settings);
      const schedule = await scheduleRepo.findByDate(telegramId, date);
      const entry = schedule?.entries.find(e => e._id?.toString() === entryId);

      if (!entry) {
        log.info({ telegramId, entryId }, 'Reminder entry no longer exists');
        return;
      }
      if (RESOLVED.includes(entry.status)) {
        log.info({ telegramId, entryId, status: entry.status }, 'Skipping reminder for resolved entry');
        return;
      }
      // The task may have been completed from another day's schedule or deleted.
      if (entry.taskId) {
        const task = await taskRepo.findById(entry.taskId.toString());
        if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.SKIPPED) {
          await scheduleRepo.updateEntryStatus(telegramId, date, entryId, task ? ScheduleEntryStatus.COMPLETED : ScheduleEntryStatus.SKIPPED);
          log.info({ telegramId, entryId }, 'Task already resolved elsewhere — reminder suppressed');
          return;
        }
      }

      const title = md(entry.title);
      const startStr = formatTimeHuman(new Date(startTime), config.timezone);
      const endStr = formatTimeHuman(new Date(endTime), config.timezone);
      let message: string;
      let withKeyboard = true;

      switch (type) {
        case 'pre_reminder':
          message = `Heads up — in ${config.reminderLeadMinutes} min:\n\n*${title}*\n${startStr} – ${endStr}`;
          withKeyboard = false;
          break;
        case 'follow_up':
          message = `Quick check-in on *${title}* (planned ${startStr} – ${endStr}).\nDone, still on it, or should I move it?`;
          break;
        case 'escalation':
          message = await handleEscalation(telegramId, date, entryId, config.timezone);
          withKeyboard = false;
          break;
        case 'snooze_reminder':
          message = `Snooze is up — back to *${title}*?`;
          break;
        default:
          message = `Time to start:\n\n*${title}*\n${startStr} – ${endStr}`;
          await scheduleRepo.updateEntryStatus(telegramId, date, entryId, ScheduleEntryStatus.ACTIVE);
          if (entry.taskId) await taskRepo.updateStatus(entry.taskId.toString(), TaskStatus.ACTIVE);
      }

      if (entry.description && type !== 'escalation') message += `\n_${md(entry.description)}_`;

      const opts = withKeyboard ? { parse_mode: 'Markdown' as const, reply_markup: buildTaskKeyboard(entryId, config.snoozeMinutes) } : { parse_mode: 'Markdown' as const };
      try {
        await bot.api.sendMessage(telegramId, message, opts);
      } catch (err: any) {
        log.warn({ err: err?.message }, 'Markdown send failed — retrying as plain text');
        await bot.api.sendMessage(telegramId, message.replace(/[*_\\]/g, ''), withKeyboard ? { reply_markup: buildTaskKeyboard(entryId, config.snoozeMinutes) } : {});
      }
    },
    {
      connection: getRedisConnection(),
      removeOnComplete: { count: 200 },
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

/**
 * No response 30+ minutes after the slot ended: record it as missed, keep the task open,
 * and re-fit it later today — or roll it to tomorrow if the day is out of room.
 */
async function handleEscalation(telegramId: number, date: string, entryId: string, timezone: string): Promise<string> {
  const user = await userRepo.findByTelegramId(telegramId);
  if (!user) return 'I lost track of this task.';

  const schedule = await scheduleRepo.findByDate(telegramId, date);
  const entry = schedule?.entries.find(e => e._id?.toString() === entryId);
  if (!entry || RESOLVED.includes(entry.status)) return '';

  await scheduleRepo.updateEntryStatus(telegramId, date, entryId, ScheduleEntryStatus.MISSED);
  const title = md(entry.title);

  if (!entry.taskId) {
    return `Looks like *${title}* didn't happen. No problem — I've noted it.`;
  }

  await taskRepo.markMissedButOpen(entry.taskId.toString());
  await taskHistoryRepo.record({
    userId: user._id as any,
    telegramId,
    taskId: entry.taskId,
    title: entry.title,
    scheduledDate: date,
    scheduledStartTime: entry.startTime,
    scheduledEndTime: entry.endTime,
    outcome: 'missed',
  });

  const outcome = await replanDay(telegramId, date, {
    trigger: 'missed_task_escalation',
    reason: `Missed ${entry.title}`,
    scheduleStability: 'preserve',
  });

  const moved = outcome.entries.find(e => e.taskId?.toString() === entry.taskId?.toString() && e.status === ScheduleEntryStatus.SCHEDULED);
  if (moved) {
    return `I didn't hear back on *${title}*, so I've moved it to ${formatTimeHuman(new Date(moved.startTime), timezone)}. If you already did it, just tell me.`;
  }

  const tomorrow = addDaysToDateString(date, 1);
  await taskRepo.deferTask(entry.taskId.toString(), tomorrow);
  return `I didn't hear back on *${title}* and there's no room left today, so it's first in line for tomorrow. If you already did it, just say so.`;
}
