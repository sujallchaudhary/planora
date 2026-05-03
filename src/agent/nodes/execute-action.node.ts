import type { AgentState } from '../state.js';
import type { ActionResult } from '../../llm/provider.js';
import { IntentType, TaskStatus } from '../../config/defaults.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { taskHistoryRepo } from '../../memory/mongo/repositories/task-history.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { planSchedule } from '../../scheduler/planner.js';
import { replan } from '../../scheduler/replanner.js';
import { syncReminders } from '../../execution/job-manager.js';
import { todayString, nowInTimezone } from '../../utils/date.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('node:execute');

export async function executeActionNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.intent) {
    return { actionResult: { success: false, action: 'none', message: 'No intent classified' } };
  }

  const user = await userRepo.findByTelegramId(state.telegramId);
  if (!user) {
    return { actionResult: { success: false, action: 'none', message: 'User not found. Please send /start first.' } };
  }

  const config = resolveUserConfig(user.settings);
  const today = todayString(config.timezone);

  let result: ActionResult;

  switch (state.intent.intent) {
    case IntentType.ADD_TASK: {
      const tasks = state.intent.tasks;
      // Also include tasks extracted from images
      if (state.imageContext?.tasks) {
        tasks.push(...state.imageContext.tasks.map(t => ({
          ...t,
          cognitiveLoad: 2 as const,
          preferredTime: undefined,
          tags: [] as string[],
        })));
      }

      if (tasks.length === 0) {
        result = { success: false, action: 'add_task', message: 'I couldn\'t extract any tasks from your message.' };
        break;
      }

      const created = [];
      for (const task of tasks) {
        const newTask = await taskRepo.create({
          userId: user._id,
          telegramId: state.telegramId,
          title: task.title,
          description: task.description ?? undefined,
          priority: task.priority ?? undefined,
          cognitiveLoad: task.cognitiveLoad ?? undefined,
          estimatedMinutes: task.estimatedMinutes ?? undefined,
          dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
          preferredTime: task.preferredTime ?? undefined,
          tags: task.tags ?? undefined,
          isFixed: task.isFixed ?? undefined,
          fixedStartTime: task.fixedStartTime ?? undefined,
          fixedEndTime: task.fixedEndTime ?? undefined,
        });
        created.push(newTask);
      }

      result = {
        success: true,
        action: 'add_task',
        message: `Added ${created.length} task(s)`,
        data: { tasks: created.map(t => ({ id: t._id, title: t.title, priority: t.priority })) },
      };
      break;
    }

    case IntentType.MODIFY_TASK: {
      const ref = state.intent.taskReference;
      if (!ref) {
        result = { success: false, action: 'modify_task', message: 'Which task do you want to modify?' };
        break;
      }
      const matches = await taskRepo.findByTitle(state.telegramId, ref);
      if (matches.length === 0) {
        result = { success: false, action: 'modify_task', message: `I couldn't find a task matching "${ref}".` };
        break;
      }
      const task = matches[0]!;
      const updates: Record<string, unknown> = {};
      if (state.intent.tasks[0]) {
        const t = state.intent.tasks[0];
        if (t.title) updates.title = t.title;
        if (t.description) updates.description = t.description;
        if (t.priority) updates.priority = t.priority;
        if (t.estimatedMinutes) updates.estimatedMinutes = t.estimatedMinutes;
        if (t.preferredTime) updates.preferredTime = t.preferredTime;
      }
      await taskRepo.updateTask(task._id!.toString(), updates);
      result = { success: true, action: 'modify_task', message: `Updated task "${task.title}"` };
      break;
    }

    case IntentType.DELETE_TASK: {
      const ref = state.intent.taskReference;
      if (!ref) {
        result = { success: false, action: 'delete_task', message: 'Which task do you want to delete?' };
        break;
      }
      const matches = await taskRepo.findByTitle(state.telegramId, ref);
      if (matches.length === 0) {
        result = { success: false, action: 'delete_task', message: `I couldn't find a task matching "${ref}".` };
        break;
      }
      await taskRepo.deleteTask(matches[0]!._id!.toString());
      result = { success: true, action: 'delete_task', message: `Deleted task "${matches[0]!.title}"` };
      break;
    }

    case IntentType.COMPLETE_TASK: {
      const ref = state.intent.taskReference;
      const todaySchedule = await scheduleRepo.findByDate(state.telegramId, today);
      let taskTitle = ref ?? 'task';
      let found = false;

      if (todaySchedule && todaySchedule.entries.length > 0) {
        // First try to match by taskReference title
        let targetEntry = ref
          ? todaySchedule.entries.find(e =>
              (e.status === 'scheduled' || e.status === 'active') &&
              e.title.toLowerCase().includes(ref.toLowerCase())
            )
          : undefined;

        // Fall back to the first active/scheduled entry
        if (!targetEntry) {
          targetEntry = todaySchedule.entries.find(e =>
            e.status === 'scheduled' || e.status === 'active'
          );
        }

        if (targetEntry) {
          await scheduleRepo.updateEntryStatus(state.telegramId, today, (targetEntry as any)._id.toString(), 'completed');
          taskTitle = targetEntry.title;
          found = true;
          if (targetEntry.taskId) {
            await taskRepo.updateStatus(targetEntry.taskId.toString(), TaskStatus.COMPLETED);
            await taskHistoryRepo.record({
              userId: user._id,
              telegramId: state.telegramId,
              taskId: targetEntry.taskId,
              title: targetEntry.title,
              scheduledDate: today,
              scheduledStartTime: targetEntry.startTime,
              scheduledEndTime: targetEntry.endTime,
              outcome: 'completed',
              completedAt: new Date(),
            });
          }
        }
      }

      // Also mark the underlying task as complete if found by title alone (no schedule)
      if (!found && ref) {
        const matches = await taskRepo.findByTitle(state.telegramId, ref);
        if (matches.length > 0) {
          await taskRepo.updateStatus(matches[0]!._id!.toString(), TaskStatus.COMPLETED);
          taskTitle = matches[0]!.title;
          found = true;
        }
      }

      result = {
        success: true,
        action: 'complete_task',
        message: found ? `Marked "${taskTitle}" as completed ✅` : 'I couldn\'t find that task in your schedule. Try /schedule to see your tasks.',
      };
      break;
    }

    case IntentType.SKIP_TASK: {
      const ref = state.intent.taskReference;
      const todaySchedule = await scheduleRepo.findByDate(state.telegramId, today);
      let taskTitle = ref ?? 'current task';

      if (todaySchedule) {
        const activeEntry = todaySchedule.entries.find(e =>
          (e.status === 'scheduled' || e.status === 'active') &&
          (!ref || e.title.toLowerCase().includes(ref.toLowerCase()))
        );
        if (activeEntry) {
          await scheduleRepo.updateEntryStatus(state.telegramId, today, (activeEntry as any)._id.toString(), 'skipped');
          taskTitle = activeEntry.title;
          if (activeEntry.taskId) {
            await taskRepo.updateStatus(activeEntry.taskId.toString(), TaskStatus.SKIPPED);
            await taskHistoryRepo.record({
              userId: user._id,
              telegramId: state.telegramId,
              taskId: activeEntry.taskId,
              title: activeEntry.title,
              scheduledDate: today,
              scheduledStartTime: activeEntry.startTime,
              scheduledEndTime: activeEntry.endTime,
              outcome: 'skipped',
            });
          }
        }
      }

      // Trigger partial replan
      await triggerReplan(state.telegramId, user._id.toString(), config, today);
      result = { success: true, action: 'skip_task', message: `Skipped "${taskTitle}" and replanned the rest of your day` };
      break;
    }

    case IntentType.ADD_PREFERENCE:
    case IntentType.ADD_CONSTRAINT:
    case IntentType.ADD_HABIT: {
      // Memory signals are already stored in the extract-memory node
      result = { success: true, action: 'add_memory', message: 'Got it! I\'ll remember that for future planning.' };
      break;
    }

    case IntentType.REPLAN: {
      await triggerReplan(state.telegramId, user._id.toString(), config, today);
      result = {
        success: true,
        action: 'replan',
        message: 'Replanned the rest of your day',
        data: { reason: state.intent.replanContext },
      };
      break;
    }

    case IntentType.SHOW_PLAN: {
      const schedule = await scheduleRepo.findByDate(state.telegramId, today);
      if (!schedule || schedule.entries.length === 0) {
        result = { success: true, action: 'show_plan', message: 'No schedule for today yet.', data: { entries: [] } };
      } else {
        result = {
          success: true,
          action: 'show_plan',
          message: 'Here\'s your plan for today',
          data: {
            entries: schedule.entries.map(e => ({
              title: e.title,
              startTime: e.startTime,
              endTime: e.endTime,
              status: e.status,
              priority: e.priority,
            })),
          },
        };
      }
      break;
    }

    case IntentType.IMAGE_CONTEXT: {
      if (state.imageContext) {
        const tasks = state.imageContext.tasks;
        if (tasks.length > 0) {
          const created = [];
          for (const task of tasks) {
            const newTask = await taskRepo.create({
              userId: user._id,
              telegramId: state.telegramId,
              title: task.title,
              description: task.description ?? undefined,
              priority: task.priority ?? undefined,
              estimatedMinutes: task.estimatedMinutes ?? undefined,
              dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
              isFixed: task.isFixed ?? undefined,
              fixedStartTime: task.fixedStartTime ?? undefined,
              fixedEndTime: task.fixedEndTime ?? undefined,
            });
            created.push(newTask);
          }
          result = {
            success: true,
            action: 'image_context',
            message: `Extracted ${created.length} task(s) from your image`,
            data: {
              imageContent: state.imageContext.content,
              tasks: created.map(t => ({ title: t.title })),
            },
          };
        } else {
          result = {
            success: true,
            action: 'image_context',
            message: 'I analyzed your image but didn\'t find specific tasks.',
            data: { imageContent: state.imageContext.content },
          };
        }
      } else {
        result = { success: false, action: 'image_context', message: 'No image provided.' };
      }
      break;
    }

    default:
      result = { success: true, action: 'general_chat', message: 'Chat response' };
  }

  return { actionResult: result };
}

async function triggerReplan(telegramId: number, userId: string, config: any, today: string): Promise<void> {
  try {
    const tasks = await taskRepo.findPendingTasks(telegramId);
    const existingSchedule = await scheduleRepo.findByDate(telegramId, today);
    const userDoc = await userRepo.findByTelegramId(telegramId);
    if (!userDoc) return;

    const newEntries = await replan(
      tasks,
      existingSchedule?.entries ?? [],
      {
        preferences: [],
        habits: [],
        constraints: [],
        semanticContext: [],
        recentHistory: [],
      },
      config,
      today,
    );

    const schedule = await scheduleRepo.createOrReplace(telegramId, userDoc._id, today, newEntries);
    await syncReminders(telegramId, today, schedule.entries);
    log.info({ telegramId, entries: newEntries.length }, 'Replanned schedule');
  } catch (error) {
    log.error({ error }, 'Failed to replan');
  }
}
