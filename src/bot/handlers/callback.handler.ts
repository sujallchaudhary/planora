import type { Context } from 'grammy';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { taskHistoryRepo } from '../../memory/mongo/repositories/task-history.repo.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { scheduleSnoozeReminder, syncReminders } from '../../execution/job-manager.js';
import { replan } from '../../scheduler/replanner.js';
import { todayString } from '../../utils/date.js';
import { TaskStatus } from '../../config/defaults.js';
import { createChildLogger } from '../../utils/logger.js';
import { setPendingAction } from '../pending-action.js';

const log = createChildLogger('handler:callback');

export function registerCallbackHandler(bot: any): void {
  bot.on('callback_query:data', async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    const from = ctx.from;
    if (!data || !from) return;

    const parts = data.split('|');
    if (parts[0] !== 'task' || parts.length < 3) return;

    const action = parts[1];
    const entryId = parts.slice(2).join('|'); // entryId may contain | if it's a MongoDB ObjectId

    const user = await userRepo.findByTelegramId(from.id);
    if (!user) { await ctx.answerCallbackQuery('Please /start first'); return; }

    const config = resolveUserConfig(user.settings);
    const today = todayString(config.timezone);
    const schedule = await scheduleRepo.findByDate(from.id, today);
    if (!schedule) { await ctx.answerCallbackQuery('No schedule found'); return; }

    const entry = schedule.entries.find((e: any) => e._id.toString() === entryId);
    if (!entry) { await ctx.answerCallbackQuery('Task not found'); return; }

    switch (action) {
      case 'done': {
        await scheduleRepo.updateEntryStatus(from.id, today, entryId, 'completed');
        if (entry.taskId) {
          await taskRepo.updateStatus(entry.taskId.toString(), TaskStatus.COMPLETED);
          await taskHistoryRepo.record({
            userId: user._id, telegramId: from.id, taskId: entry.taskId,
            title: entry.title, scheduledDate: today,
            scheduledStartTime: entry.startTime, scheduledEndTime: entry.endTime,
            outcome: 'completed', completedAt: new Date(),
          });
        }
        await ctx.answerCallbackQuery('✅ Marked as done!');
        await ctx.editMessageText(`✅ *${entry.title}* — completed!`, { parse_mode: 'Markdown' });
        break;
      }
      case 'skip': {
        await scheduleRepo.updateEntryStatus(from.id, today, entryId, 'skipped');
        if (entry.taskId) {
          await taskRepo.updateStatus(entry.taskId.toString(), TaskStatus.SKIPPED);
          await taskHistoryRepo.record({
            userId: user._id, telegramId: from.id, taskId: entry.taskId,
            title: entry.title, scheduledDate: today,
            scheduledStartTime: entry.startTime, scheduledEndTime: entry.endTime,
            outcome: 'skipped',
          });
        }
        // Trigger replan
        const tasks = await taskRepo.findPendingTasks(from.id);
        const updatedSchedule = await scheduleRepo.findByDate(from.id, today);
        const newEntries = await replan(tasks, updatedSchedule?.entries ?? [], {
          preferences: [], habits: [], constraints: [], semanticContext: [], recentHistory: [],
        }, config, today);
        const savedSchedule = await scheduleRepo.createOrReplace(from.id, user._id, today, newEntries);
        await syncReminders(from.id, today, savedSchedule.entries);

        await ctx.answerCallbackQuery('⏭ Skipped! Schedule adjusted.');
        await ctx.editMessageText(`⏭ *${entry.title}* — skipped. Schedule replanned.`, { parse_mode: 'Markdown' });
        break;
      }
      case 'snooze': {
        await scheduleSnoozeReminder(from.id, today, entry, config.snoozeMinutes);
        await ctx.answerCallbackQuery(`⏰ Snoozed for ${config.snoozeMinutes} min`);
        await ctx.editMessageText(`⏰ *${entry.title}* — snoozed for ${config.snoozeMinutes} minutes.`, { parse_mode: 'Markdown' });
        break;
      }
      case 'reschedule': {
        setPendingAction(from.id, {
          type: 'reschedule',
          taskTitle: entry.title,
          taskId: entry.taskId?.toString(),
          entryId: entryId
        });
        await ctx.answerCallbackQuery('📅 Tell me when you\'d like to reschedule');
        await ctx.reply(`When would you like to reschedule *${entry.title}*? Just tell me in natural language.`, { parse_mode: 'Markdown' });
        break;
      }
    }
  });
}
