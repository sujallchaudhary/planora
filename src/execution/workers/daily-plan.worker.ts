import { Worker } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES, getDailyPlanQueue } from '../queue.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { replanDay, formatScheduleLines, describeUnscheduled } from '../../scheduler/replan-service.js';
import { getBotInstance } from '../../bot/bot.js';
import { todayString, formatDateString, daysBetween, formatMinutes, formatDateHuman } from '../../utils/date.js';
import { md } from '../../utils/markdown.js';
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
      const bot = getBotInstance();

      const openTasks = await taskRepo.findOpenTasks(telegramId);
      const outcome = await replanDay(telegramId, today, { trigger: 'daily_plan' });

      if (outcome.entries.length === 0 && openTasks.length === 0) {
        await bot.api.sendMessage(telegramId, `☀️ Morning, ${user.firstName}. Nothing on the books today — enjoy the open day. Tell me if something comes up.`);
        return;
      }

      // Deadline tracking
      const overdue = openTasks.filter(t => t.dueDate && daysBetween(today, formatDateString(t.dueDate, config.timezone)) < 0);
      const dueToday = openTasks.filter(t => t.dueDate && formatDateString(t.dueDate, config.timezone) === today);
      const dueSoon = openTasks.filter(t => {
        if (!t.dueDate) return false;
        const d = daysBetween(today, formatDateString(t.dueDate, config.timezone));
        return d >= 1 && d <= 2;
      });

      const taskEntries = outcome.entries.filter(e => e.taskId && e.status === 'scheduled');
      const plannedMinutes = taskEntries.reduce((sum, e) => sum + (new Date(e.endTime).getTime() - new Date(e.startTime).getTime()) / 60_000, 0);
      const focus = [...taskEntries].sort((a, b) => b.priority - a.priority)[0];

      const sections: string[] = [];
      sections.push(`☀️ *Morning, ${md(user.firstName)}.* Here's ${formatDateHuman(today)}:`);
      if (overdue.length > 0) sections.push(`🔴 Overdue: ${overdue.map(t => md(t.title)).join(', ')}`);
      if (dueToday.length > 0) sections.push(`⏰ Due today: ${dueToday.map(t => md(t.title)).join(', ')}`);
      if (dueSoon.length > 0) sections.push(`📅 Due in the next 2 days: ${dueSoon.map(t => md(t.title)).join(', ')}`);
      sections.push(formatScheduleLines(outcome.entries, config.timezone).join('\n'));
      if (focus) sections.push(`🎯 The one thing that matters most today: *${md(focus.title)}*.`);
      sections.push(`_${taskEntries.length} task${taskEntries.length === 1 ? '' : 's'} · ${formatMinutes(plannedMinutes)} of planned work._`);
      const leftovers = describeUnscheduled(outcome.unscheduled);
      if (leftovers) sections.push(leftovers);
      sections.push(`_Tell me how the day goes — "done with X", "I'm exhausted", "running late" — and I'll keep the plan honest._`);

      const msg = sections.join('\n\n');
      try {
        await bot.api.sendMessage(telegramId, msg, { parse_mode: 'Markdown' });
      } catch (err: any) {
        log.warn({ err: err?.message }, 'Markdown briefing failed — sending plain');
        await bot.api.sendMessage(telegramId, msg.replace(/[*_\\]/g, ''));
      }
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

/** Register (or refresh) the repeatable morning-plan job for one user. */
export async function scheduleDailyPlanForUser(telegramId: number, dailyPlanTime: string, timezone: string): Promise<void> {
  const queue = getDailyPlanQueue();
  const [hour, minute] = dailyPlanTime.split(':');
  const jobId = `daily-plan_${telegramId}`;

  // Drop any stale repeat registration (e.g. the user changed their plan time)
  const repeatables = await queue.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.id === jobId) await queue.removeRepeatableByKey(r.key);
  }

  await queue.add(
    'generate-plan',
    { telegramId },
    {
      jobId,
      repeat: { pattern: `0 ${Number(minute)} ${Number(hour)} * * *`, tz: timezone },
      removeOnComplete: { count: 10 },
    }
  );
}

/** Schedule daily plan generation for all active users. */
export async function scheduleDailyPlans(): Promise<void> {
  const users = await userRepo.getAllActiveUsers();
  for (const user of users) {
    const config = resolveUserConfig(user.settings);
    await scheduleDailyPlanForUser(user.telegramId, config.dailyPlanTime, config.timezone);
  }
  log.info({ users: users.length }, 'Scheduled daily plans');
}
