import { Worker } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES, getAnalyticsQueue } from '../queue.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { taskHistoryRepo } from '../../memory/mongo/repositories/task-history.repo.js';
import { preferenceRepo } from '../../memory/mongo/repositories/preference.repo.js';
import { resolveUserConfig, type UserConfig } from '../../config/config-resolver.js';
import { PREFERENCE_KEYS, ScheduleEntryStatus, TaskStatus } from '../../config/defaults.js';
import { SemanticMemory } from '../../memory/qdrant/semantic-memory.js';
import { getLLMProvider } from '../../llm/index.js';
import { getBotInstance } from '../../bot/bot.js';
import { todayString, addDaysToDateString, formatDateString, daysBetween, weekdayOfDateString } from '../../utils/date.js';
import { md } from '../../utils/markdown.js';
import { createChildLogger } from '../../utils/logger.js';
import type { IUser } from '../../memory/mongo/models/user.model.js';

const log = createChildLogger('worker:analytics');

export function startAnalyticsWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.ANALYTICS,
    async (job) => {
      const { telegramId } = job.data as { telegramId: number };
      log.info({ telegramId }, 'Running end-of-day review + behavioral analytics');

      const user = await userRepo.findByTelegramId(telegramId);
      if (!user) return;
      const config = resolveUserConfig(user.settings);
      const today = todayString(config.timezone);

      const closeout = await closeOutDay(user, config, today);
      const insights = await learnFromHistory(user, config);
      const message = await buildReview(user, config, today, closeout, insights);

      const bot = getBotInstance();
      try {
        await bot.api.sendMessage(telegramId, message, { parse_mode: 'Markdown' });
      } catch (err: any) {
        log.warn({ err: err?.message }, 'Markdown review failed — sending plain');
        await bot.api.sendMessage(telegramId, message.replace(/[*_\\]/g, ''));
      }
    },
    {
      connection: getRedisConnection(),
      removeOnComplete: { count: 20 },
      removeOnFail: { age: 86400 },
    }
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'Analytics job failed');
  });

  log.info('Analytics worker started');
  return worker;
}

interface Closeout {
  completed: string[];
  missed: string[];
  skipped: string[];
  carriedOver: string[];
  closedPastEvents: string[];
}

/**
 * End of day: anything still "scheduled"/"active" is recorded as missed and rolled to
 * tomorrow. Fixed events whose day has passed are closed so they stop haunting the backlog.
 */
async function closeOutDay(user: IUser, config: UserConfig, today: string): Promise<Closeout> {
  const telegramId = user.telegramId;
  const tomorrow = addDaysToDateString(today, 1);
  const out: Closeout = { completed: [], missed: [], skipped: [], carriedOver: [], closedPastEvents: [] };

  const schedule = await scheduleRepo.findByDate(telegramId, today);
  for (const entry of schedule?.entries ?? []) {
    if (entry.status === ScheduleEntryStatus.COMPLETED) { if (entry.taskId) out.completed.push(entry.title); continue; }
    if (entry.status === ScheduleEntryStatus.SKIPPED) { if (entry.taskId) out.skipped.push(entry.title); continue; }
    if (entry.status === ScheduleEntryStatus.MISSED) { if (entry.taskId) out.missed.push(entry.title); continue; }
    if (!entry.taskId || !entry._id) continue;

    const task = await taskRepo.findById(entry.taskId.toString());
    if (!task || task.status === TaskStatus.COMPLETED) {
      await scheduleRepo.updateEntryStatus(telegramId, today, entry._id.toString(), ScheduleEntryStatus.COMPLETED);
      continue;
    }

    await scheduleRepo.updateEntryStatus(telegramId, today, entry._id.toString(), ScheduleEntryStatus.MISSED);
    await taskHistoryRepo.record({
      userId: user._id as any,
      telegramId,
      taskId: entry.taskId,
      title: entry.title,
      scheduledDate: today,
      scheduledStartTime: entry.startTime,
      scheduledEndTime: entry.endTime,
      outcome: 'missed',
      notes: 'end-of-day closeout',
    });
    out.missed.push(entry.title);
  }

  // Roll every open task that was planned today and not done to tomorrow.
  const open = await taskRepo.findOpenTasks(telegramId);
  for (const task of open) {
    const dueStr = task.dueDate ? formatDateString(task.dueDate, config.timezone) : null;
    const isFixedPast = task.isFixed && task.fixedStartTime && task.fixedEndTime && dueStr && dueStr <= today;
    if (isFixedPast) {
      await taskRepo.updateStatus(String(task._id), TaskStatus.MISSED);
      out.closedPastEvents.push(task.title);
      continue;
    }
    if (out.missed.includes(task.title) || out.skipped.includes(task.title)) {
      if (task.deferredUntil !== tomorrow) await taskRepo.deferTask(String(task._id), tomorrow);
      out.carriedOver.push(task.title);
    }
  }

  return out;
}

interface Insights {
  stats: Record<string, number>;
  blockStats: Awaited<ReturnType<typeof taskHistoryRepo.getCompletionRatesByTimeBlock>>;
  bestBlock?: string;
  worstBlock?: string;
  overrun: { ratio: number; samples: number };
  procrastinated: Array<{ title: string; times: number }>;
  streakDays: number;
}

async function learnFromHistory(user: IUser, config: UserConfig): Promise<Insights> {
  const telegramId = user.telegramId;
  const stats = await taskHistoryRepo.getOutcomeStats(telegramId, 7);
  const blockStats = await taskHistoryRepo.getCompletionRatesByTimeBlock(telegramId, 21, config.timezone);
  const overrun = await taskHistoryRepo.getOverrunStats(telegramId, 21);
  const procrastinated = await taskHistoryRepo.getRepeatedlyDeferred(telegramId, 14, 2);
  const minPoints = config.memoryMinDataPoints;

  const morning = blockStats.morning;
  if (morning.total >= minPoints && morning.rate < 0.35) {
    await preferenceRepo.upsert(telegramId, user._id as any, {
      key: PREFERENCE_KEYS.MORNING_TASK_DIFFICULTY,
      value: 'high',
      confidence: Math.min(0.9, 0.55 + (1 - morning.rate) * 0.3),
      source: 'inferred',
    });
  }

  const eligible = Object.entries(blockStats).filter(([, s]) => s.total >= minPoints);
  const best = eligible.filter(([, s]) => s.rate >= 0.7).sort((a, b) => b[1].rate - a[1].rate)[0];
  const worst = eligible.filter(([, s]) => s.rate <= 0.4).sort((a, b) => a[1].rate - b[1].rate)[0];

  if (best) {
    await preferenceRepo.upsert(telegramId, user._id as any, {
      key: PREFERENCE_KEYS.PEAK_FOCUS_WINDOW,
      value: best[0],
      confidence: Math.min(0.92, 0.55 + best[1].rate * 0.35),
      source: 'inferred',
    });
  }
  if (worst && worst[0] !== best?.[0]) {
    await preferenceRepo.upsert(telegramId, user._id as any, {
      key: PREFERENCE_KEYS.LOW_SUCCESS_WINDOW,
      value: worst[0],
      confidence: Math.min(0.9, 0.55 + (1 - worst[1].rate) * 0.3),
      source: 'inferred',
    });
  }

  // Adaptive time estimation: if tasks consistently overrun, plan longer slots.
  if (overrun.samples >= minPoints && Math.abs(overrun.ratio - 1) >= 0.1) {
    await preferenceRepo.upsert(telegramId, user._id as any, {
      key: PREFERENCE_KEYS.TIME_ESTIMATE_MULTIPLIER,
      value: overrun.ratio.toFixed(2),
      confidence: Math.min(0.9, 0.6 + overrun.samples * 0.03),
      source: 'inferred',
    });
  }

  // Completion streak: consecutive days (ending today) with at least one completed task
  const recent = await taskHistoryRepo.findRecentHistory(telegramId, 30);
  const doneDays = new Set(recent.filter(h => h.outcome === 'completed' || h.outcome === 'completed_late').map(h => h.scheduledDate));
  let streakDays = 0;
  let cursor = todayString(config.timezone);
  while (doneDays.has(cursor)) { streakDays += 1; cursor = addDaysToDateString(cursor, -1); }

  try {
    const llm = getLLMProvider();
    const semanticMemory = new SemanticMemory((t) => llm.getEmbedding(t));
    const summary = `Week summary: ${JSON.stringify(stats)}; best block: ${best?.[0] ?? 'n/a'}; worst block: ${worst?.[0] ?? 'n/a'}; overrun ratio ${overrun.ratio.toFixed(2)} over ${overrun.samples} tasks; streak ${streakDays} days.`;
    await semanticMemory.store({
      userId: String(user._id),
      telegramId,
      type: 'behavior',
      content: summary,
      metadata: { stats, blockStats, bestBlock: best?.[0], worstBlock: worst?.[0], overrun, streakDays },
      timestamp: new Date().toISOString(),
      confidence: 0.8,
    });
  } catch (err) {
    log.warn({ err }, 'Failed to store behavioral insight');
  }

  return { stats, blockStats, bestBlock: best?.[0], worstBlock: worst?.[0], overrun, procrastinated, streakDays };
}

async function buildReview(user: IUser, config: UserConfig, today: string, c: Closeout, i: Insights): Promise<string> {
  const total = c.completed.length + c.missed.length + c.skipped.length;
  const lines: string[] = [];
  lines.push(`🌙 *End of day, ${md(user.firstName)}.*`);

  if (total === 0) {
    lines.push('No task blocks were on today\'s plan.');
  } else {
    const pct = Math.round((c.completed.length / total) * 100);
    lines.push(`✅ ${c.completed.length}/${total} done (${pct}%)` + (c.skipped.length ? ` · ⏭ ${c.skipped.length} skipped` : '') + (c.missed.length ? ` · ⚠️ ${c.missed.length} missed` : ''));
    if (c.completed.length > 0) lines.push(`Done: ${c.completed.map(md).join(', ')}`);
  }
  if (c.carriedOver.length > 0) lines.push(`➡️ Carried to tomorrow: ${c.carriedOver.map(md).join(', ')}`);
  if (c.closedPastEvents.length > 0) lines.push(`Closed past events: ${c.closedPastEvents.map(md).join(', ')}`);
  if (i.streakDays >= 2) lines.push(`🔥 ${i.streakDays}-day streak of getting things done.`);

  const open = await taskRepo.findOpenTasks(user.telegramId);
  const tomorrow = addDaysToDateString(today, 1);
  const dueTomorrow = open.filter(t => t.dueDate && formatDateString(t.dueDate, config.timezone) === tomorrow);
  const overdue = open.filter(t => t.dueDate && daysBetween(today, formatDateString(t.dueDate, config.timezone)) < 0);
  if (dueTomorrow.length > 0) lines.push(`⏰ Due tomorrow: ${dueTomorrow.map(t => md(t.title)).join(', ')}`);
  if (overdue.length > 0) lines.push(`🔴 Still overdue: ${overdue.map(t => md(t.title)).join(', ')} — want me to reschedule, split, or drop any of these?`);

  if (i.procrastinated.length > 0) {
    const worst = i.procrastinated[0]!;
    lines.push(`🧭 *${md(worst.title)}* has slipped ${worst.times} times. Tomorrow I'll pin it first thing unless you'd rather break it into smaller steps or drop it.`);
  }

  const observations: string[] = [];
  if (i.bestBlock) observations.push(`you finish most in the ${i.bestBlock}`);
  if (i.worstBlock) observations.push(`${i.worstBlock} blocks tend to slip`);
  if (i.overrun.samples >= config.memoryMinDataPoints && i.overrun.ratio >= 1.15) observations.push(`tasks run ~${Math.round((i.overrun.ratio - 1) * 100)}% longer than planned, so I'm padding estimates`);
  if (observations.length > 0) lines.push(`📈 Pattern: ${observations.join('; ')}. I'm planning around that.`);

  if (weekdayOfDateString(today) === 'sunday') {
    const done = (i.stats['completed'] ?? 0) + (i.stats['completed_late'] ?? 0);
    const all = Object.values(i.stats).reduce((a, b) => a + b, 0);
    const rate = all > 0 ? Math.round((done / all) * 100) : 0;
    lines.push(`\n📊 *Week in review:* ${done}/${all} planned blocks completed (${rate}%).` +
      (i.bestBlock ? ` Your strongest window was the ${i.bestBlock}.` : '') +
      (i.worstBlock ? ` I'll keep deep work out of the ${i.worstBlock}.` : ''));
  }

  lines.push(`_Morning plan arrives at ${config.dailyPlanTime}. Sleep well._`);
  return lines.join('\n');
}

/** Register (or refresh) the repeatable end-of-day job for one user. */
export async function scheduleAnalyticsForUser(telegramId: number, analyticsTime: string, timezone: string): Promise<void> {
  const queue = getAnalyticsQueue();
  const [hour, minute] = analyticsTime.split(':');
  const jobId = `analytics_${telegramId}`;
  const repeatables = await queue.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.id === jobId) await queue.removeRepeatableByKey(r.key);
  }
  await queue.add(
    'analyze',
    { telegramId },
    {
      jobId,
      repeat: { pattern: `0 ${Number(minute)} ${Number(hour)} * * *`, tz: timezone },
      removeOnComplete: { count: 5 },
    }
  );
}

export async function scheduleAnalytics(): Promise<void> {
  const users = await userRepo.getAllActiveUsers();
  for (const user of users) {
    const config = resolveUserConfig(user.settings);
    await scheduleAnalyticsForUser(user.telegramId, config.analyticsTime, config.timezone);
  }
  log.info({ users: users.length }, 'Scheduled analytics');
}
