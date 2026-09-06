import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { preferenceRepo } from '../../memory/mongo/repositories/preference.repo.js';
import { Habit } from '../../memory/mongo/models/habit.model.js';
import { Constraint } from '../../memory/mongo/models/constraint.model.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { replanDay, formatScheduleLines, describeUnscheduled } from '../../scheduler/replan-service.js';
import { syncReminders } from '../../execution/job-manager.js';
import { scheduleDailyPlanForUser } from '../../execution/workers/daily-plan.worker.js';
import { scheduleAnalyticsForUser } from '../../execution/workers/analytics.worker.js';
import { todayString, formatTimeHuman, formatDateString, formatDateHuman, formatMinutes } from '../../utils/date.js';
import { describeDays } from '../../memory/memory-utils.js';
import { md } from '../../utils/markdown.js';
import { sendReply } from './message.handler.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('handler:command');

export function registerCommandHandlers(bot: any): void {
  bot.command('start', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const user = await userRepo.createOrUpdate(from.id, {
      firstName: from.first_name,
      lastName: from.last_name,
      username: from.username,
    });

    try {
      const config = resolveUserConfig(user.settings);
      await scheduleDailyPlanForUser(user.telegramId, config.dailyPlanTime, config.timezone);
      await scheduleAnalyticsForUser(user.telegramId, config.analyticsTime, config.timezone);
    } catch (e) {
      log.warn({ e }, 'Failed to schedule recurring jobs on /start');
    }

    await sendReply(ctx,
      `Hey ${md(from.first_name)} — I'm Memora, and I run your day so you don't have to.\n\n` +
      `Just talk to me like you would to a chief of staff:\n` +
      `• _"Finish the report by Friday, 2 hours, high priority"_\n` +
      `• _"I have class every day 10–11:30"_ · _"I focus better at night"_\n` +
      `• _"Done with the report"_ · _"Skip gym today"_ · _"I'm exhausted"_\n` +
      `• 📸 Send a photo of a timetable or to-do list\n\n` +
      `Every morning I'll send your plan, nudge you through it, replan when life happens, and review the day at night. ` +
      `The more you tell me, the better I get.`
    );
  });

  bot.command('plan', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;
    const user = await userRepo.findByTelegramId(from.id);
    if (!user) { await ctx.reply('Please send /start first.'); return; }

    const config = resolveUserConfig(user.settings);
    const today = todayString(config.timezone);
    void ctx.replyWithChatAction('typing').catch(() => undefined);

    const outcome = await replanDay(from.id, today, { trigger: 'manual_plan', scheduleStability: 'moderate' });
    if (outcome.entries.length === 0) {
      const open = await taskRepo.countPendingTasks(from.id);
      await ctx.reply(open === 0 ? 'Nothing to plan — tell me what you need to do.' : `Nothing fits into what's left of today. ${describeUnscheduled(outcome.unscheduled, { escape: false })}`);
      return;
    }
    const leftovers = describeUnscheduled(outcome.unscheduled);
    await sendReply(ctx,
      `📅 *Today's plan*\n\n${formatScheduleLines(outcome.entries, config.timezone).join('\n')}\n\n` +
      `_${outcome.scheduledTaskCount} task block${outcome.scheduledTaskCount === 1 ? '' : 's'} to go. Say "replan" or just tell me what changed._` +
      (leftovers ? `\n\n${leftovers}` : '')
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
      await sendReply(ctx, `📊 *Status*\n\nOpen tasks: ${pendingCount}\nNo plan for today yet — /plan or just tell me what's on.`);
      return;
    }

    const taskEntries = schedule.entries.filter(e => e.taskId);
    const count = (s: string) => taskEntries.filter(e => e.status === s).length;
    const next = schedule.entries.filter(e => e.status === 'scheduled' && new Date(e.endTime) > new Date()).sort((a, b) => +new Date(a.startTime) - +new Date(b.startTime))[0];

    await sendReply(ctx,
      `📊 *Today*\n\n` +
      `✅ Done: ${count('completed')}\n` +
      `📋 Remaining: ${count('scheduled') + count('active')}\n` +
      `⏭ Skipped: ${count('skipped')} · ⚠️ Missed: ${count('missed')}\n` +
      `📝 Open tasks overall: ${pendingCount}` +
      (next ? `\n\nNext up: *${md(next.title)}* at ${formatTimeHuman(new Date(next.startTime), config.timezone)}` : '')
    );
  });

  bot.command('clear', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;
    const user = await userRepo.findByTelegramId(from.id);
    if (!user) { await ctx.reply('Please /start first.'); return; }

    const config = resolveUserConfig(user.settings);
    const today = todayString(config.timezone);
    await scheduleRepo.createOrReplace(from.id, user._id as any, today, []);
    await syncReminders(from.id, today, []);
    await ctx.reply("Cleared today's plan and reminders. Your tasks are untouched — /plan rebuilds it.");
  });

  bot.command('tasks', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;
    const user = await userRepo.findByTelegramId(from.id);
    if (!user) { await ctx.reply('Please /start first.'); return; }

    const config = resolveUserConfig(user.settings);
    const today = todayString(config.timezone);
    const tasks = await taskRepo.findOpenTasks(from.id);
    if (tasks.length === 0) {
      await ctx.reply('No open tasks. Tell me what you need to do.');
      return;
    }

    const priorityEmoji: Record<number, string> = { 5: '🔴', 4: '🟠', 3: '🟡', 2: '🔵', 1: '⚪' };
    const priorityLabel: Record<number, string> = { 5: 'Critical', 4: 'Urgent', 3: 'High', 2: 'Medium', 1: 'Low' };
    const groups: Record<number, string[]> = { 5: [], 4: [], 3: [], 2: [], 1: [] };

    for (const task of tasks) {
      const p = task.priority ?? 2;
      let line = `${priorityEmoji[p] ?? '🔵'} *${md(task.title)}*`;
      if (task.isFixed && task.fixedStartTime && task.fixedEndTime) line += ` _(${task.fixedStartTime}–${task.fixedEndTime})_`;
      else line += ` _[${formatMinutes(task.estimatedMinutes ?? 30)}]_`;
      if (task.dueDate) {
        const dueStr = formatDateString(task.dueDate, config.timezone);
        line += dueStr < today ? ` — *overdue* (${md(formatDateHuman(dueStr))})` : ` — due ${md(formatDateHuman(dueStr))}`;
      }
      if (task.recurrence?.pattern) line += ` 🔁`;
      if (task.deferredUntil && task.deferredUntil > today) line += ` _(from ${md(formatDateHuman(task.deferredUntil))})_`;
      if (task.deferCount >= 2) line += ` _(slipped ${task.deferCount}x)_`;
      (groups[p] ?? groups[2]!).push(line);
    }

    const sections: string[] = [];
    for (const p of [5, 4, 3, 2, 1]) {
      if (groups[p]!.length > 0) sections.push(`*${priorityEmoji[p]} ${priorityLabel[p]}*\n${groups[p]!.join('\n')}`);
    }
    const totalMins = tasks.reduce((sum, t) => sum + (t.estimatedMinutes ?? 30), 0);

    await sendReply(ctx, `📋 *Open tasks* (${tasks.length} · ${formatMinutes(totalMins)} of work)\n\n${sections.join('\n\n')}`);
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
      await ctx.reply('No plan for today yet. /plan builds one.');
      return;
    }

    const sorted = [...schedule.entries].sort((a, b) => +new Date(a.startTime) - +new Date(b.startTime));
    const completed = sorted.filter(e => e.status === 'completed').length;
    const remaining = sorted.filter(e => e.status === 'scheduled' || e.status === 'active').length;

    await sendReply(ctx,
      `📅 *Today* — ${formatDateHuman(today)}\n✅ ${completed} done · 📋 ${remaining} remaining\n\n` +
      formatScheduleLines(sorted, config.timezone).join('\n') +
      `\n\n_Tap a button below, or just say "done with X"._`
    );

    for (const entry of sorted) {
      if (entry.status !== 'scheduled' && entry.status !== 'active') continue;
      if (new Date(entry.endTime) < new Date()) continue;
      const entryId = entry._id?.toString() ?? '';
      const kb = new InlineKeyboard()
        .text('✅ Done', `task|done|${entryId}`)
        .text('⏭ Skip', `task|skip|${entryId}`)
        .text('📅 Move', `task|reschedule|${entryId}`);
      await sendReply(ctx, `${md(entry.title)} — ${formatTimeHuman(new Date(entry.startTime), config.timezone)}–${formatTimeHuman(new Date(entry.endTime), config.timezone)}`).catch(() => undefined);
      await ctx.reply('▸', { reply_markup: kb }).catch(() => undefined);
    }
  });

  bot.command('memory', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;
    const user = await userRepo.findByTelegramId(from.id);
    if (!user) { await ctx.reply('Please /start first.'); return; }

    const [habits, constraints, prefs] = await Promise.all([
      Habit.find({ telegramId: from.id, isActive: true }),
      Constraint.find({ telegramId: from.id, isActive: true }),
      preferenceRepo.findByTelegramId(from.id),
    ]);

    const sections: string[] = ['🧠 *What I know about you*'];
    if (constraints.length) sections.push('*Fixed commitments*\n' + constraints.map(c => `• ${md(c.key.replace(/_/g, ' '))}${c.timeRange.start !== '00:00' ? ` ${c.timeRange.start}–${c.timeRange.end}` : ''} (${describeDays(c.days)})${c.expiresOn ? ` until ${c.expiresOn}` : ''}`).join('\n'));
    if (habits.length) sections.push('*Routines*\n' + habits.map(h => `• ${md(h.key.replace(/_/g, ' '))} ${h.timeRange.start}–${h.timeRange.end} (${describeDays(h.days)})`).join('\n'));
    if (prefs.length) sections.push('*Preferences*\n' + prefs.map(p => `• ${md(p.key.replace(/_/g, ' '))}: ${md(p.value)}${p.source === 'inferred' ? ' _(learned)_' : ''}`).join('\n'));
    if (sections.length === 1) sections.push("Nothing yet. Tell me about your routines, commitments and when you work best.");
    sections.push('_Say "I stopped ..." or "forget that ..." to remove any of these._');

    await sendReply(ctx, sections.join('\n\n'));
  });

  bot.command('help', async (ctx: Context) => {
    await sendReply(ctx,
      `🤖 *Memora*\n\n` +
      `*Commands*\n` +
      `/plan — build or rebuild today\n` +
      `/schedule — today's timeline with buttons\n` +
      `/tasks — everything open\n` +
      `/status — how today is going\n` +
      `/memory — what I've learned about you\n` +
      `/clear — wipe today's plan\n\n` +
      `*Or just talk*\n` +
      `• _"Study math 2h, due Friday"_ · _"Dentist tomorrow at 3"_\n` +
      `• _"Done with math"_ · _"Skip gym today"_ · _"Move the report to Friday"_\n` +
      `• _"I'm exhausted"_ · _"Running late"_ · _"I'm out till 5"_ — I'll replan\n` +
      `• _"I focus better at night"_ · _"I nap 2–3"_ — I'll remember\n` +
      `• _"Exams are over"_ — I'll forget the exam constraint\n` +
      `📸 Photos of timetables or lists work too.`
    );
  });
}
