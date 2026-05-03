import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('queue');

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    connection.on('error', (err: Error) => {
      log.error({ err }, 'Redis connection error');
    });
    connection.on('connect', () => {
      log.info('Connected to Redis');
    });
  }
  return connection;
}

// ─── Queue Definitions ─────────────────────────────────────────────────────────
export const QUEUE_NAMES = {
  REMINDERS: 'reminders',
  DAILY_PLAN: 'daily-plan',
  ANALYTICS: 'analytics',
} as const;

let reminderQueue: Queue | null = null;
let dailyPlanQueue: Queue | null = null;
let analyticsQueue: Queue | null = null;

export function getReminderQueue(): Queue {
  if (!reminderQueue) {
    reminderQueue = new Queue(QUEUE_NAMES.REMINDERS, { connection: getRedisConnection() });
  }
  return reminderQueue;
}

export function getDailyPlanQueue(): Queue {
  if (!dailyPlanQueue) {
    dailyPlanQueue = new Queue(QUEUE_NAMES.DAILY_PLAN, { connection: getRedisConnection() });
  }
  return dailyPlanQueue;
}

export function getAnalyticsQueue(): Queue {
  if (!analyticsQueue) {
    analyticsQueue = new Queue(QUEUE_NAMES.ANALYTICS, { connection: getRedisConnection() });
  }
  return analyticsQueue;
}

export async function closeQueues(): Promise<void> {
  await reminderQueue?.close();
  await dailyPlanQueue?.close();
  await analyticsQueue?.close();
  await connection?.quit();
  log.info('Closed all queues and Redis connection');
}
