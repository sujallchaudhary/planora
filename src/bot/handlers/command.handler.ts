import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { planSchedule } from '../../scheduler/planner.js';
import { syncReminders } from '../../execution/job-manager.js';
import { getStructuredMemory } from '../../memory/hybrid-retriever.js';
import { todayString, formatTimeHuman } from '../../utils/date.js';
import { scheduleDailyPlans } from '../../execution/workers/daily-plan.worker.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('handler:command');

/** Escape special Markdown v1 characters in dynamic content. */
const md = (s: string) => s.replace(/[_*[\]`]/g, '\\$&');

export function registerCommandHandlers(bot: any): void {
  bot.command('start', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const user = await userRepo.createOrUpdate(from.id, {
      firstName: from.first_name,
      lastName: from.last_name,
      username: from.username,
    });

    // Schedule daily plan for THIS user only, not all users
    try {
      const config = resolveUserConfig(user.settings);
      const [hour, minute] = config.dailyPlanTime.split(':');
      const { getDailyPlanQueue } = await import('../../execution/queue.js');
      await getDailyPlanQueue().add(
        'generate-plan',
        { telegramId: user.telegramId },
        {
          jobId: `daily-plan_${user.telegramId}`,
          repeat: { pattern: `0 ${minute} ${hour} * * *`, tz: config.timezone },
          removeOnComplete: { count: 10 },
        }
      );
    } catch (e) { /* ignore */ }

    await ctx.reply(
      `👋 Hey ${from.first_name}! I'm Memora, your personal operating system.\n\n` +
      `Here's what I can do:\n` +
      `📋 Tell me your tasks in natural language\n` +
      `📸 Send me photos of schedules or task lists\n` +
      `⏰ I'll plan your day and send reminders\n` +
      `🔄 Say "replan" anytime to adjust\n\n` +
      `Just start telling me what you need to do today!`
    );
  });

  bot.command('plan', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const user = await userRepo.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply('Please send /start first to register.');
      return;
    }

    const config = resolveUserConfig(user.settings);
    const today = todayString(config.timezone);

    await ctx.reply('🔄 Planning your day...');

    const tasks = await taskRepo.findPendingTasks(from.id);

    const memory = await getStructuredMemory(from.id, config.memoryConfidenceThreshold);
    const entries = await planSchedule(tasks, memory, config, today);
    const schedule = await scheduleRepo.createOrReplace(from.id, user._id, today, entries);
    await syncReminders(from.id, today, schedule.entries);

    const lines = entries.map(e => {
      const s = formatTimeHuman(e.startTime, config.timezone);
      const end = formatTimeHuman(e.endTime, config.timezone);
      return `📋 ${s} – ${end}: *${md(e.title)}*`;
    });

    await ctx.reply(
      `📅 *Your plan for today:*\n\n${lines.join('\n')}\n\n` +
      `_${entries.length} tasks scheduled. Say "replan" to adjust._`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('status', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const user = await userRepo.findByTelegramId(from.id);
    if (!user) { await ctx.reply('Please /start first.'); return; }

    const config = resolveUserConfig(user.settings);
    const today = todayString(config.timezone);
    const schedule = await scheduleRepo.findByDate(from.id, today);
    const pendingCount = await taskRepo.countPendingTasks(from.id);

    if (!schedule || schedule.entries.length === 0) {
      await ctx.reply(`📊 *Status*\n\nPending tasks: ${pendingCount}\nNo schedule for today. Use /plan to create one.`, { parse_mode: 'Markdown' });
      return;
    }

    const completed = schedule.entries.filter(e => e.status === 'completed').length;
    const remaining = schedule.entries.filter(e => e.status === 'scheduled').length;
    const skipped = schedule.entries.filter(e => e.status === 'skipped').length;

    await ctx.reply(
      `📊 *Today's Status*\n\n` +
      `✅ Completed: ${completed}\n` +
      `📋 Remaining: ${remaining}\n` +
      `⏭ Skipped: ${skipped}\n` +
      `📝 Pending tasks: ${pendingCount}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('clear', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const user = await userRepo.findByTelegramId(from.id);
    if (!user) { await ctx.reply('Please /start first.'); return; }

    const config = resolveUserConfig(user.settings);
    const today = todayString(config.timezone);
    await scheduleRepo.createOrReplace(from.id, user._id, today, []);
    await syncReminders(from.id, today, []);

    await ctx.reply('🗑 Schedule cleared for today. Use /plan to create a new one.');
  });

  bot.command('tasks', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const user = await userRepo.findByTelegramId(from.id);
    if (!user) { await ctx.reply('Please /start first.'); return; }

    const tasks = await taskRepo.findByTelegramId(from.id, ['pending', 'scheduled']);
    if (tasks.length === 0) {
      await ctx.reply('📭 You have no pending tasks. Tell me what you need to do!');
      return;
    }

    // Group by priority
    const priorityEmoji: Record<number, string> = { 5: '🔴', 4: '🟠', 3: '🟡', 2: '🔵', 1: '⚪' };
    const priorityLabel: Record<number, string> = { 5: 'Critical', 4: 'Urgent', 3: 'High', 2: 'Medium', 1: 'Low' };
    const groups: Record<number, string[]> = { 5: [], 4: [], 3: [], 2: [], 1: [] };

    for (const task of tasks) {
      const p = task.priority ?? 2;
      const emoji = priorityEmoji[p] ?? '🔵';
      let line = `${emoji} *${md(task.title)}*`;

      // Time info
      if (task.isFixed && task.fixedStartTime && task.fixedEndTime) {
        line += ` _(fixed: ${task.fixedStartTime}–${task.fixedEndTime})_`;
      } else if (task.estimatedMinutes) {
        const hrs = Math.floor(task.estimatedMinutes / 60);
        const mins = task.estimatedMinutes % 60;
        const timeStr = hrs > 0 ? `${hrs}h${mins > 0 ? ` ${mins}m` : ''}` : `${mins}m`;
        line += ` _[${timeStr}]_`;
      }

      // Due date
      if (task.dueDate) {
        const due = new Date(task.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        line += ` \u2014 due ${md(due)}`;
      }

      // Status badge
      if (task.status === 'scheduled') line += ' ✓ _scheduled_';

      (groups[p] ?? groups[2]!).push(line);
    }

    const sections: string[] = [];
    for (const p of [5, 4, 3, 2, 1]) {
      const group = groups[p]!;
      if (group.length > 0) {
        sections.push(`*${priorityEmoji[p]} ${priorityLabel[p]}*\n${group.join('\n')}`);
      }
    }

    const config = resolveUserConfig(user.settings);
    const totalMins = tasks.reduce((sum, t) => sum + (t.estimatedMinutes ?? 30), 0);
    const totalHrs = Math.floor(totalMins / 60);
    const totalRemMins = totalMins % 60;
    const totalStr = totalHrs > 0 ? `${totalHrs}h ${totalRemMins}m` : `${totalMins}m`;

    await ctx.reply(
      `📋 *Your Tasks* (${tasks.length} pending · ${totalStr} total)\n\n` +
      sections.join('\n\n') +
      `\n\n_Use /plan to schedule them_`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('schedule', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const user = await userRepo.findByTelegramId(from.id);
    if (!user) { await ctx.reply('Please /start first.'); return; }

    const config = resolveUserConfig(user.settings);
    const today = todayString(config.timezone);
    const schedule = await scheduleRepo.findByDate(from.id, today);

    if (!schedule || schedule.entries.length === 0) {
      await ctx.reply('📭 No schedule for today. Use /plan to create one.');
      return;
    }

    const statusEmoji = (s: string) =>
      s === 'completed' ? '✅' : s === 'skipped' ? '⏭' : s === 'active' ? '▶️' : '📋';

    const sorted = [...schedule.entries].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );

    const completed = sorted.filter(e => e.status === 'completed').length;
    const remaining = sorted.filter(e => e.status === 'scheduled' || e.status === 'active').length;

    const lines = sorted.map(e => {
      const s = formatTimeHuman(new Date(e.startTime), config.timezone);
      const end = formatTimeHuman(new Date(e.endTime), config.timezone);
      return `${statusEmoji(e.status)} ${s}–${end} *${md(e.title)}*`;
    });

    await ctx.reply(
      `📅 *Today's Schedule* — ${today}\n` +
      `✅ ${completed} done · 📋 ${remaining} remaining\n\n` +
      lines.join('\n') +
      `\n\n_Tap ✅ Done on an entry below, or say "done with taskname"_`,
      { parse_mode: 'Markdown' }
    );

    // Send a button row for each pending entry
    for (const entry of sorted) {
      if (entry.status !== 'scheduled' && entry.status !== 'active') continue;
      const entryId = (entry as any)._id?.toString() ?? '';
      const s = formatTimeHuman(new Date(entry.startTime), config.timezone);
      const end = formatTimeHuman(new Date(entry.endTime), config.timezone);

      const kb = new InlineKeyboard()
        .text('✅ Done', `task|done|${entryId}`)
        .text('⏭ Skip', `task|skip|${entryId}`);

      await ctx.reply(
        `📋 *${md(entry.title)}* — ${s}–${end}`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
    }
  });

  bot.command('help', async (ctx: Context) => {

    await ctx.reply(
      `🤖 *Memora Personal Operating System*\n\n` +
      `*Commands:*\n` +
      `/start — Register and get started\n` +
      `/tasks — View all your pending tasks\n` +
      `/plan — Generate today's schedule\n` +
      `/schedule — View today's schedule with action buttons\n` +
      `/status — See today's progress\n` +
      `/clear — Clear today's schedule\n\n` +
      `*Mark tasks complete by:*\n` +
      `• Tapping ✅ Done button on a reminder or /schedule entry\n` +
      `• Saying _"done with gym"_ or _"finished math"_\n\n` +
      `*Just chat naturally:*\n` +
      `• _"Study math for 2 hours, high priority"_\n` +
      `• _"I have class at 10am–11:30am"_\n` +
      `• _"Skip gym today"_\n` +
      `• _"I'm tired, replan my day"_\n\n` +
      `📸 You can also send me photos of schedules or task lists!`,
      { parse_mode: 'Markdown' }
    );
  });
}
