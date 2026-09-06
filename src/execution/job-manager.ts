import { getReminderQueue, getRedisConnection } from './queue.js';
import type { IScheduleEntry } from '../memory/mongo/models/schedule.model.js';
import { userRepo } from '../memory/mongo/repositories/user.repo.js';
import { resolveUserConfig } from '../config/config-resolver.js';
import { msUntil } from '../utils/date.js';
import { addMinutes } from 'date-fns';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('job-manager');

export type ReminderType = 'pre_reminder' | 'start_reminder' | 'snooze_reminder' | 'follow_up' | 'escalation';

export interface ReminderJobData {
  telegramId: number;
  date: string;
  entryId: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  type: ReminderType;
  escalationLevel?: number;
}

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { age: 86400 },
};

const jobSetKey = (telegramId: number, date: string) => `memora:reminder_jobs:${telegramId}:${date}`;

/**
 * Sync reminder jobs for a schedule.
 * Removes every job previously registered for this user+date (tracked in a Redis set,
 * so this is O(jobs for that day), not O(all jobs in the queue)) and creates new ones.
 */
export async function syncReminders(
  telegramId: number,
  date: string,
  entries: IScheduleEntry[],
): Promise<void> {
  const queue = getReminderQueue();
  const redis = getRedisConnection();
  const user = await userRepo.findByTelegramId(telegramId);
  const config = resolveUserConfig(user?.settings);
  const setKey = jobSetKey(telegramId, date);

  const previous = await redis.smembers(setKey);
  for (const jobId of previous) {
    try {
      const job = await queue.getJob(jobId);
      if (job) await job.remove();
    } catch (err: any) {
      // Active jobs cannot be removed; the worker re-checks entry state before sending anyway.
      log.debug({ jobId, err: err?.message }, 'Could not remove reminder job');
    }
  }
  await redis.del(setKey);

  const created: string[] = [];
  const add = async (type: ReminderType, entry: IScheduleEntry, entryId: string, fireAt: Date, escalationLevel?: number) => {
    const delay = msUntil(fireAt);
    if (delay <= 0) return;
    const jobId = `reminder_${telegramId}_${date}_${entryId}_${type}`;
    await queue.add(
      type,
      {
        telegramId,
        date,
        entryId,
        title: entry.title,
        description: entry.description,
        startTime: new Date(entry.startTime).toISOString(),
        endTime: new Date(entry.endTime).toISOString(),
        type,
        escalationLevel,
      } satisfies ReminderJobData,
      { ...JOB_OPTS, jobId, delay },
    );
    created.push(jobId);
  };

  for (const entry of entries) {
    if (entry.status !== 'scheduled') continue;
    const entryId = entry._id?.toString() ?? '';
    if (!entryId) continue;

    const startTime = new Date(entry.startTime);
    const endTime = new Date(entry.endTime);

    await add('pre_reminder', entry, entryId, addMinutes(startTime, -config.reminderLeadMinutes));
    await add('start_reminder', entry, entryId, startTime);

    if (entry.taskId) {
      await add('follow_up', entry, entryId, addMinutes(endTime, Math.max(5, Math.floor(config.bufferMinutes / 2))), 1);
      await add('escalation', entry, entryId, addMinutes(endTime, Math.max(30, config.snoozeMinutes * 2)), 2);
    }
  }

  if (created.length > 0) {
    await redis.sadd(setKey, ...created);
    await redis.expire(setKey, 3 * 24 * 3600);
  }

  log.info({ telegramId, date, entries: entries.length, jobs: created.length }, 'Synced reminders');
}

export async function scheduleSnoozeReminder(
  telegramId: number,
  date: string,
  entry: IScheduleEntry,
  snoozeMinutes: number,
): Promise<void> {
  const queue = getReminderQueue();
  const entryId = entry._id?.toString() ?? '';
  if (!entryId) return;

  const jobId = `reminder_${telegramId}_${date}_${entryId}_snooze_${Date.now()}`;
  await queue.add(
    'snooze_reminder',
    {
      telegramId,
      date,
      entryId,
      title: entry.title,
      description: entry.description,
      startTime: new Date(entry.startTime).toISOString(),
      endTime: new Date(entry.endTime).toISOString(),
      type: 'snooze_reminder',
    } satisfies ReminderJobData,
    { ...JOB_OPTS, jobId, delay: snoozeMinutes * 60 * 1000 },
  );
  await getRedisConnection().sadd(jobSetKey(telegramId, date), jobId);
}
