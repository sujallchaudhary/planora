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
  entryId: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  type: 'pre_reminder' | 'start_reminder';
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

  // Get all delayed jobs and remove matching ones
  const delayed = await queue.getDelayed();
  for (const job of delayed) {
    if (job.id?.startsWith(jobPrefix)) {
      await job.remove();
    }
  }

  // Create new reminder jobs for each entry
  for (const entry of entries) {
    if (entry.status !== 'scheduled') continue;

    const entryId = (entry as any)._id?.toString() ?? '';
    const startTime = new Date(entry.startTime);
    const preReminderTime = addMinutes(startTime, -config.reminderLeadMinutes);

    // Pre-reminder (X minutes before)
    const preDelay = msUntil(preReminderTime);
    if (preDelay > 0) {
      const preJobId = `${jobPrefix}_${entryId}_pre`;
      await queue.add(
        'pre_reminder',
        {
          telegramId,
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
  }

  log.info({ telegramId, date, entries: entries.length }, 'Synced reminders');
}
