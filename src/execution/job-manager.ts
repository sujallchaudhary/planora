import { getReminderQueue } from './queue.js';
import type { IScheduleEntry } from '../memory/mongo/models/schedule.model.js';
import { userRepo } from '../memory/mongo/repositories/user.repo.js';
import { resolveUserConfig } from '../config/config-resolver.js';
import { msUntil } from '../utils/date.js';
import { addMinutes } from 'date-fns';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('job-manager');

export interface ReminderJobData {
  telegramId: number;
  date: string;
  entryId: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  type: 'pre_reminder' | 'start_reminder' | 'snooze_reminder' | 'follow_up' | 'escalation';
  escalationLevel?: number;
}

/**
 * Sync reminder jobs for a schedule.
 * Cancels all existing jobs for this user+date and creates new ones.
 */
export async function syncReminders(
  telegramId: number,
  date: string,
  entries: IScheduleEntry[],
): Promise<void> {
  const queue = getReminderQueue();
  const user = await userRepo.findByTelegramId(telegramId);
  const config = resolveUserConfig(user?.settings);

  // Cancel existing reminders for this user+date
  const jobPrefix = `reminder_${telegramId}_${date}`;

  // Get all delayed, waiting, and active jobs to remove matching ones
  const scheduled = await queue.getJobs(['delayed', 'waiting', 'active', 'prioritized']);
  for (const job of scheduled) {
    if (job.id?.startsWith(jobPrefix)) {
      await job.remove();
    }
  }

  // Create new reminder jobs for each entry
  for (const entry of entries) {
    if (entry.status !== 'scheduled') continue;

    const entryId = (entry as any)._id?.toString() ?? '';
    if (!entryId) continue;

    const startTime = new Date(entry.startTime);
    const endTime = new Date(entry.endTime);
    const preReminderTime = addMinutes(startTime, -config.reminderLeadMinutes);

    // Pre-reminder (X minutes before)
    const preDelay = msUntil(preReminderTime);
    if (preDelay > 0) {
      const preJobId = `${jobPrefix}_${entryId}_pre`;
      await queue.add(
        'pre_reminder',
        {
          telegramId,
          date,
          entryId,
          title: entry.title,
          description: entry.description,
          startTime: entry.startTime.toISOString(),
          endTime: entry.endTime.toISOString(),
          type: 'pre_reminder',
        } satisfies ReminderJobData,
        {
          jobId: preJobId,
          delay: preDelay,
          removeOnComplete: { count: 100 },
          removeOnFail: { age: 86400 },
        }
      );
    }

    // Start reminder (at task start time)
    const startDelay = msUntil(startTime);
    if (startDelay > 0) {
      const startJobId = `${jobPrefix}_${entryId}_start`;
      await queue.add(
        'start_reminder',
        {
          telegramId,
          date,
          entryId,
          title: entry.title,
          description: entry.description,
          startTime: entry.startTime.toISOString(),
          endTime: entry.endTime.toISOString(),
          type: 'start_reminder',
        } satisfies ReminderJobData,
        {
          jobId: startJobId,
          delay: startDelay,
          removeOnComplete: { count: 100 },
          removeOnFail: { age: 86400 },
        }
      );
    }

    if (entry.taskId) {
      const followUpTime = addMinutes(endTime, Math.max(5, Math.floor(config.bufferMinutes / 2)));
      const followDelay = msUntil(followUpTime);
      if (followDelay > 0) {
        await queue.add(
          'follow_up',
          {
            telegramId,
            date,
            entryId,
            title: entry.title,
            description: entry.description,
            startTime: entry.startTime.toISOString(),
            endTime: entry.endTime.toISOString(),
            type: 'follow_up',
            escalationLevel: 1,
          } satisfies ReminderJobData,
          {
            jobId: `${jobPrefix}_${entryId}_follow`,
            delay: followDelay,
            removeOnComplete: { count: 100 },
            removeOnFail: { age: 86400 },
          }
        );
      }

      const escalationTime = addMinutes(endTime, Math.max(30, config.snoozeMinutes * 2));
      const escalationDelay = msUntil(escalationTime);
      if (escalationDelay > 0) {
        await queue.add(
          'escalation',
          {
            telegramId,
            date,
            entryId,
            title: entry.title,
            description: entry.description,
            startTime: entry.startTime.toISOString(),
            endTime: entry.endTime.toISOString(),
            type: 'escalation',
            escalationLevel: 2,
          } satisfies ReminderJobData,
          {
            jobId: `${jobPrefix}_${entryId}_escalation`,
            delay: escalationDelay,
            removeOnComplete: { count: 100 },
            removeOnFail: { age: 86400 },
          }
        );
      }
    }
  }

  log.info({ telegramId, date, entries: entries.length }, 'Synced reminders');
}

export async function scheduleSnoozeReminder(
  telegramId: number,
  date: string,
  entry: IScheduleEntry,
  snoozeMinutes: number,
): Promise<void> {
  const queue = getReminderQueue();
  const entryId = (entry as any)._id?.toString() ?? '';
  if (!entryId) return;

  await queue.add(
    'snooze_reminder',
    {
      telegramId,
      date,
      entryId,
      title: entry.title,
      description: entry.description,
      startTime: entry.startTime.toISOString(),
      endTime: entry.endTime.toISOString(),
      type: 'snooze_reminder',
    } satisfies ReminderJobData,
    {
      jobId: `reminder_${telegramId}_${date}_${entryId}_snooze_${Date.now()}`,
      delay: snoozeMinutes * 60 * 1000,
      removeOnComplete: { count: 100 },
      removeOnFail: { age: 86400 },
    }
  );
}
