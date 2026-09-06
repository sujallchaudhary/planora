import type { Context } from 'grammy';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { scheduleSnoozeReminder } from '../../execution/job-manager.js';
import { replanDay } from '../../scheduler/replan-service.js';
import { completeTask, skipTaskToday } from '../../scheduler/task-actions.js';
import { todayString, addDaysToDateString, formatTimeHuman, formatDateHuman } from '../../utils/date.js';
import { ScheduleEntryStatus } from '../../config/defaults.js';
import { md } from '../../utils/markdown.js';
import { setPendingAction } from '../pending-action.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('handler:callback');

export function registerCallbackHandler(bot: any): void {
  bot.on('callback_query:data', async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    const from = ctx.from;
    if (!data || !from) return;

    const parts = data.split('|');
    if (parts[0] !== 'task' || parts.length < 3) return;

    const action = parts[1];
    const entryId = parts.slice(2).join('|');

    const user = await userRepo.findByTelegramId(from.id);
    if (!user) { await ctx.answerCallbackQuery('Please /start first'); return; }

    const config = resolveUserConfig(user.settings);
    const today = todayString(config.timezone);

    // Reminders can arrive for yesterday's late entries — look in both.
    let date = today;
    let schedule = await scheduleRepo.findByDate(from.id, today);
    let entry = schedule?.entries.find(e => e._id?.toString() === entryId);
    if (!entry) {
      date = addDaysToDateString(today, -1);
      schedule = await scheduleRepo.findByDate(from.id, date);
      entry = schedule?.entries.find(e => e._id?.toString() === entryId);
    }
    if (!entry) { await ctx.answerCallbackQuery('That block is no longer on the plan'); return; }

    const edit = async (text: string) => {
      try { await ctx.editMessageText(text, { parse_mode: 'Markdown' }); }
      catch { await ctx.editMessageText(text.replace(/[*_\\]/g, '')).catch(() => undefined); }
    };

    try {
      switch (action) {
        case 'done': {
          if (entry.taskId) {
            const task = await taskRepo.findById(entry.taskId.toString());
            if (task) await completeTask(user, config, task, today);
            else await scheduleRepo.updateEntryStatus(from.id, date, entryId, ScheduleEntryStatus.COMPLETED);
          } else {
            await scheduleRepo.updateEntryStatus(from.id, date, entryId, ScheduleEntryStatus.COMPLETED);
          }
          const outcome = await replanDay(from.id, today, { trigger: 'task_completed', scheduleStability: 'preserve' });
          const next = outcome.entries.find(e => e.status === 'scheduled' && new Date(e.endTime) > new Date());
          await ctx.answerCallbackQuery('Done ✅');
          await edit(`✅ *${md(entry.title)}* — done.${next ? ` Next: *${md(next.title)}* at ${formatTimeHuman(new Date(next.startTime), config.timezone)}.` : ''}`);
          break;
        }
        case 'skip': {
          let deferredTo = addDaysToDateString(today, 1);
          if (entry.taskId) {
            const task = await taskRepo.findById(entry.taskId.toString());
            if (task) deferredTo = (await skipTaskToday(user, task, today)).deferredUntil;
            else await scheduleRepo.updateEntryStatus(from.id, date, entryId, ScheduleEntryStatus.SKIPPED);
          } else {
            await scheduleRepo.updateEntryStatus(from.id, date, entryId, ScheduleEntryStatus.SKIPPED);
          }
          const outcome = await replanDay(from.id, today, { trigger: 'task_skipped', reason: `Skipped ${entry.title}`, scheduleStability: 'preserve' });
          const next = outcome.entries.find(e => e.status === 'scheduled' && new Date(e.endTime) > new Date());
          await ctx.answerCallbackQuery('Skipped for today');
          await edit(`⏭ *${md(entry.title)}* — skipped${entry.taskId ? `, back on ${formatDateHuman(deferredTo)}` : ''}.${next ? ` Next: *${md(next.title)}* at ${formatTimeHuman(new Date(next.startTime), config.timezone)}.` : ''}`);
          break;
        }
        case 'snooze': {
          await scheduleSnoozeReminder(from.id, date, entry, config.snoozeMinutes);
          await ctx.answerCallbackQuery(`Snoozed ${config.snoozeMinutes} min`);
          await edit(`⏰ *${md(entry.title)}* — I'll nudge you again in ${config.snoozeMinutes} minutes.`);
          break;
        }
        case 'reschedule': {
          await setPendingAction(from.id, {
            type: 'reschedule',
            taskTitle: entry.title,
            taskId: entry.taskId?.toString(),
            entryId,
          });
          await ctx.answerCallbackQuery('Tell me when');
          await ctx.reply(`When should *${md(entry.title)}* happen instead? ("4pm", "tomorrow morning", "Friday")`, { parse_mode: 'Markdown' });
          break;
        }
        default:
          await ctx.answerCallbackQuery();
      }
    } catch (error) {
      log.error({ error, action, entryId }, 'Callback failed');
      await ctx.answerCallbackQuery('Something went wrong').catch(() => undefined);
    }
  });
}
