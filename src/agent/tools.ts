import { tool } from 'ai';
import { z } from 'zod';
import mongoose from 'mongoose';
import { taskRepo } from '../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../memory/mongo/repositories/schedule.repo.js';
import { taskHistoryRepo } from '../memory/mongo/repositories/task-history.repo.js';
import { preferenceRepo } from '../memory/mongo/repositories/preference.repo.js';
import { Habit } from '../memory/mongo/models/habit.model.js';
import { Constraint } from '../memory/mongo/models/constraint.model.js';
import { TaskStatus } from '../config/defaults.js';
import type { UserConfig } from '../config/config-resolver.js';
import { planSchedule } from '../scheduler/planner.js';
import { replan } from '../scheduler/replanner.js';
import { syncReminders } from '../execution/job-manager.js';
import { getStructuredMemory } from '../memory/hybrid-retriever.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('agent-tools');

interface ToolContext {
  telegramId: number;
  userId: mongoose.Types.ObjectId;
  config: UserConfig;
  today: string;
}

async function triggerReplan(ctx: ToolContext, targetDate: string, reason?: string): Promise<number> {
  try {
    const tasks = await taskRepo.findPendingTasks(ctx.telegramId);
    const existingSchedule = await scheduleRepo.findByDate(ctx.telegramId, targetDate);
    const memory = await getStructuredMemory(ctx.telegramId, ctx.config.memoryConfidenceThreshold);

    const newEntries = await replan(
      tasks,
      existingSchedule?.entries ?? [],
      memory,
      ctx.config,
      targetDate,
      {
        trigger: 'user_request',
        reason,
      },
    );

    const schedule = await scheduleRepo.createOrReplace(ctx.telegramId, ctx.userId, targetDate, newEntries);
    await syncReminders(ctx.telegramId, targetDate, schedule.entries);
    log.info({ telegramId: ctx.telegramId, entries: newEntries.length, targetDate }, 'Replanned schedule');
    return newEntries.length;
  } catch (error) {
    log.error({ error }, 'Failed to replan');
    return 0;
  }
}

export function createAgentTools(ctx: ToolContext) {
  return {
    add_tasks: tool({
      description: 'Add one or more tasks to the user\'s task list and update the schedule.',
      parameters: z.object({
        tasks: z.array(z.object({
          title: z.string().describe('Task title'),
          description: z.string().optional().describe('Optional description'),
          priority: z.number().min(1).max(5).default(2).describe('1=low, 2=medium, 3=high, 4=urgent, 5=critical'),
          cognitiveLoad: z.number().min(1).max(3).default(2).describe('1=low, 2=medium, 3=high mental effort'),
          estimatedMinutes: z.number().min(5).default(30).describe('Estimated duration in minutes'),
          dueDate: z.string().optional().describe('Due date in YYYY-MM-DD format'),
          preferredTime: z.string().optional().describe('morning, afternoon, or evening'),
          isFixed: z.boolean().default(false).describe('True if the task has a fixed time slot'),
          fixedStartTime: z.string().optional().describe('Fixed start time in HH:mm format'),
          fixedEndTime: z.string().optional().describe('Fixed end time in HH:mm format'),
        })),
      }),
      execute: async ({ tasks }) => {
        const created = [];
        for (const t of tasks) {
          const newTask = await taskRepo.create({
            userId: ctx.userId,
            telegramId: ctx.telegramId,
            title: t.title,
            description: t.description,
            priority: t.priority,
            cognitiveLoad: t.cognitiveLoad,
            estimatedMinutes: t.estimatedMinutes,
            dueDate: t.dueDate ? new Date(t.dueDate) : undefined,
            preferredTime: t.preferredTime,
            isFixed: t.isFixed,
            fixedStartTime: t.fixedStartTime,
            fixedEndTime: t.fixedEndTime,
          });
          created.push({ id: newTask._id!.toString(), title: newTask.title });
        }

        // Smart replan
        const dueDates = tasks.map(t => t.dueDate).filter(Boolean) as string[];
        const replanTarget = dueDates.length > 0
          ? (dueDates.sort()[0]! < ctx.today ? ctx.today : dueDates.sort()[0]!)
          : ctx.today;
        const datesToReplan = Array.from(new Set([ctx.today, replanTarget]));
        for (const d of datesToReplan) {
          await triggerReplan(ctx, d, `New tasks added: ${created.map(c => c.title).join(', ')}`);
        }

        return { success: true, message: `Added ${created.length} task(s): ${created.map(c => c.title).join(', ')}. Schedule updated.`, tasks: created };
      },
    }),

    modify_task: tool({
      description: 'Modify an existing task by searching for it by title.',
      parameters: z.object({
        taskSearch: z.string().describe('Title or partial title of the task to modify'),
        updates: z.object({
          title: z.string().optional(),
          description: z.string().optional(),
          priority: z.number().min(1).max(5).optional(),
          estimatedMinutes: z.number().min(5).optional(),
          preferredTime: z.string().optional(),
          dueDate: z.string().optional().describe('YYYY-MM-DD format, or empty to clear'),
          isFixed: z.boolean().optional(),
          fixedStartTime: z.string().optional(),
          fixedEndTime: z.string().optional(),
        }),
      }),
      execute: async ({ taskSearch, updates }) => {
        const task = await taskRepo.findById(taskSearch) ?? (await taskRepo.findByTitle(ctx.telegramId, taskSearch))[0];
        if (!task) {
          return { success: false, message: `Couldn't find a task matching "${taskSearch}".` };
        }

        const mongoUpdates: Record<string, unknown> = {};
        if (updates.title) mongoUpdates.title = updates.title;
        if (updates.description) mongoUpdates.description = updates.description;
        if (updates.priority) mongoUpdates.priority = updates.priority;
        if (updates.estimatedMinutes) mongoUpdates.estimatedMinutes = updates.estimatedMinutes;
        if (updates.preferredTime) mongoUpdates.preferredTime = updates.preferredTime;
        if (updates.dueDate !== undefined) mongoUpdates.dueDate = updates.dueDate ? new Date(updates.dueDate) : null;
        if (updates.isFixed !== undefined) mongoUpdates.isFixed = updates.isFixed;
        if (updates.fixedStartTime !== undefined) mongoUpdates.fixedStartTime = updates.fixedStartTime;
        if (updates.fixedEndTime !== undefined) mongoUpdates.fixedEndTime = updates.fixedEndTime;

        await taskRepo.updateTask(task._id!.toString(), mongoUpdates);

        let replanTarget = ctx.today;
        if (mongoUpdates.dueDate) {
          replanTarget = (mongoUpdates.dueDate as Date).toISOString().split('T')[0]!;
        } else if (task.dueDate) {
          replanTarget = task.dueDate.toISOString().split('T')[0]!;
        }
        await triggerReplan(ctx, replanTarget, `Task "${task.title}" modified`);

        return { success: true, message: `Updated "${task.title}". Schedule adjusted.` };
      },
    }),

    delete_task: tool({
      description: 'Delete a task by searching for it by title.',
      parameters: z.object({
        taskSearch: z.string().describe('Title or partial title of the task to delete'),
      }),
      execute: async ({ taskSearch }) => {
        const task = await taskRepo.findById(taskSearch) ?? (await taskRepo.findByTitle(ctx.telegramId, taskSearch))[0];
        if (!task) {
          return { success: false, message: `Couldn't find a task matching "${taskSearch}".` };
        }

        await taskRepo.deleteTask(task._id!.toString());
        await triggerReplan(ctx, ctx.today, `Task "${task.title}" deleted — freed capacity`);

        return { success: true, message: `Deleted "${task.title}". Schedule updated.` };
      },
    }),

    complete_task: tool({
      description: 'Mark a task as completed. If no specific task is mentioned, completes the currently active task.',
      parameters: z.object({
        taskSearch: z.string().optional().describe('Title or partial title of the task to complete. Omit to complete the active/current task.'),
      }),
      execute: async ({ taskSearch }) => {
        const todaySchedule = await scheduleRepo.findByDate(ctx.telegramId, ctx.today);

        if (!taskSearch) {
          // Complete all active/scheduled tasks
          let count = 0;
          if (todaySchedule) {
            for (const e of todaySchedule.entries) {
              if (e.status === 'scheduled' || e.status === 'active') {
                await scheduleRepo.updateEntryStatus(ctx.telegramId, ctx.today, (e as any)._id.toString(), 'completed');
                if (e.taskId) {
                  await taskRepo.updateStatus(e.taskId.toString(), TaskStatus.COMPLETED);
                }
                count++;
              }
            }
          }
          await triggerReplan(ctx, ctx.today, 'Task(s) completed — freed time');
          return { success: true, message: `Marked ${count} task(s) as completed ✅. Schedule updated.` };
        }

        const task = await taskRepo.findById(taskSearch) ?? (await taskRepo.findByTitle(ctx.telegramId, taskSearch))[0];
        if (!task) {
          return { success: false, message: `Couldn't find a task matching "${taskSearch}".` };
        }

        await taskRepo.updateStatus(task._id!.toString(), TaskStatus.COMPLETED);

        // Update schedule entry too
        if (todaySchedule) {
          const entry = todaySchedule.entries.find(e => e.taskId?.toString() === task._id!.toString());
          if (entry) {
            await scheduleRepo.updateEntryStatus(ctx.telegramId, ctx.today, (entry as any)._id.toString(), 'completed');
            await taskHistoryRepo.record({
              userId: ctx.userId,
              telegramId: ctx.telegramId,
              taskId: task._id!,
              title: task.title,
              scheduledDate: ctx.today,
              scheduledStartTime: entry.startTime,
              scheduledEndTime: entry.endTime,
              outcome: 'completed',
              completedAt: new Date(),
            });
          }
        }

        await triggerReplan(ctx, ctx.today, `Task "${task.title}" completed — freed time`);
        return { success: true, message: `Marked "${task.title}" as completed ✅. Schedule updated.` };
      },
    }),

    skip_task: tool({
      description: 'Skip a task for today.',
      parameters: z.object({
        taskSearch: z.string().optional().describe('Title or partial title of the task to skip. Omit to skip the current/next task.'),
      }),
      execute: async ({ taskSearch }) => {
        const todaySchedule = await scheduleRepo.findByDate(ctx.telegramId, ctx.today);
        let taskTitle = taskSearch ?? 'current task';

        if (taskSearch) {
          const task = await taskRepo.findById(taskSearch) ?? (await taskRepo.findByTitle(ctx.telegramId, taskSearch))[0];
          if (task) {
            await taskRepo.updateStatus(task._id!.toString(), TaskStatus.SKIPPED);
            taskTitle = task.title;

            if (todaySchedule) {
              const entry = todaySchedule.entries.find(e => e.taskId?.toString() === task._id!.toString());
              if (entry) {
                await scheduleRepo.updateEntryStatus(ctx.telegramId, ctx.today, (entry as any)._id.toString(), 'skipped');
                await taskHistoryRepo.record({
                  userId: ctx.userId,
                  telegramId: ctx.telegramId,
                  taskId: task._id!,
                  title: task.title,
                  scheduledDate: ctx.today,
                  scheduledStartTime: entry.startTime,
                  scheduledEndTime: entry.endTime,
                  outcome: 'skipped',
                });
              }
            }
          }
        } else if (todaySchedule) {
          // Skip first active/scheduled entry
          const entry = todaySchedule.entries.find(e => e.status === 'scheduled' || e.status === 'active');
          if (entry) {
            await scheduleRepo.updateEntryStatus(ctx.telegramId, ctx.today, (entry as any)._id.toString(), 'skipped');
            taskTitle = entry.title;
            if (entry.taskId) {
              await taskRepo.updateStatus(entry.taskId.toString(), TaskStatus.SKIPPED);
              await taskHistoryRepo.record({
                userId: ctx.userId,
                telegramId: ctx.telegramId,
                taskId: entry.taskId,
                title: entry.title,
                scheduledDate: ctx.today,
                scheduledStartTime: entry.startTime,
                scheduledEndTime: entry.endTime,
                outcome: 'skipped',
              });
            }
          }
        }

        await triggerReplan(ctx, ctx.today, `Task "${taskTitle}" skipped — redistribute time`);
        return { success: true, message: `Skipped "${taskTitle}". Rest of the day replanned.` };
      },
    }),

    show_plan: tool({
      description: 'Show the schedule/plan for a specific date. Defaults to today.',
      parameters: z.object({
        date: z.string().optional().describe('Date in YYYY-MM-DD format. Omit for today.'),
      }),
      execute: async ({ date }) => {
        const targetDate = date ?? ctx.today;
        const schedule = await scheduleRepo.findByDate(ctx.telegramId, targetDate);
        const pendingTasks = await taskRepo.findPendingTasks(ctx.telegramId);
        const dateLabel = targetDate === ctx.today ? 'today' : targetDate;

        if (!schedule || schedule.entries.length === 0) {
          return {
            success: true,
            message: pendingTasks.length > 0
              ? `No schedule for ${dateLabel}, but ${pendingTasks.length} pending task(s). Say "plan my day" to schedule them.`
              : `No schedule or pending tasks for ${dateLabel}.`,
            entries: [],
            pendingCount: pendingTasks.length,
          };
        }

        const entries = schedule.entries.map(e => ({
          title: e.title,
          startTime: e.startTime,
          endTime: e.endTime,
          status: e.status,
          priority: e.priority,
        }));

        return {
          success: true,
          message: `Schedule for ${dateLabel}: ${entries.length} entries.`,
          entries,
          pendingCount: pendingTasks.length,
        };
      },
    }),

    replan: tool({
      description: 'Replan/reschedule the day. Use when user is tired, overwhelmed, running late, or explicitly asks to replan.',
      parameters: z.object({
        date: z.string().optional().describe('Date to replan in YYYY-MM-DD format. Omit for today.'),
        reason: z.string().optional().describe('Why replanning is needed (tired, overwhelmed, running late, etc.)'),
      }),
      execute: async ({ date, reason }) => {
        const targetDate = date ?? ctx.today;
        const count = await triggerReplan(ctx, targetDate, reason);
        const dateLabel = targetDate === ctx.today ? 'your day' : targetDate;

        return {
          success: true,
          message: `Replanned ${dateLabel} — ${count} tasks scheduled.${reason ? ` (Reason: ${reason})` : ''}`,
          scheduledCount: count,
        };
      },
    }),

    remember_preference: tool({
      description: 'Store a user preference for future planning. Examples: "prefers mornings", "likes 25-min blocks", "works better after coffee".',
      parameters: z.object({
        key: z.string().describe('Short key like "preferred_time", "block_duration", "deep_work_time"'),
        value: z.string().describe('The preference value'),
      }),
      execute: async ({ key, value }) => {
        await preferenceRepo.upsert(ctx.telegramId, ctx.userId, {
          key,
          value,
          confidence: 0.8,
          source: 'explicit',
        });
        return { success: true, message: `Noted: ${key} = "${value}". I'll use this for future planning.` };
      },
    }),

    remember_habit: tool({
      description: 'Store a recurring habit/routine. Examples: "gym 7-9 AM daily", "nap 2-3 PM weekdays", "meditation 6-6:30 AM".',
      parameters: z.object({
        key: z.string().describe('Short key like "gym", "nap", "meditation"'),
        description: z.string().describe('Description of the habit'),
        startTime: z.string().describe('Start time in HH:mm format'),
        endTime: z.string().describe('End time in HH:mm format'),
        days: z.array(z.string()).default(['daily']).describe('Days: daily, monday, tuesday, etc.'),
        frequency: z.string().default('daily').describe('daily, weekdays, weekly, etc.'),
      }),
      execute: async ({ key, description, startTime, endTime, days, frequency }) => {
        await Habit.findOneAndUpdate(
          { telegramId: ctx.telegramId, key },
          {
            $set: {
              userId: ctx.userId,
              description,
              timeRange: { start: startTime, end: endTime },
              days,
              frequency,
              confidence: 0.85,
              isActive: true,
            },
            $inc: { dataPoints: 1 },
          },
          { upsert: true, new: true },
        );

        await triggerReplan(ctx, ctx.today, `New habit "${key}" blocks ${startTime}–${endTime}`);
        return { success: true, message: `Habit saved: ${key} (${startTime}–${endTime}, ${days.join(', ')}). Schedule updated.` };
      },
    }),

    remember_constraint: tool({
      description: 'Store a fixed commitment that blocks time. Examples: "class 10-12 weekdays", "meeting 3-4 PM on monday".',
      parameters: z.object({
        key: z.string().describe('Short key like "class", "meeting", "work"'),
        description: z.string().default('').describe('Description of the constraint'),
        startTime: z.string().describe('Start time in HH:mm format'),
        endTime: z.string().describe('End time in HH:mm format'),
        days: z.array(z.string()).default(['daily']).describe('Days: daily, monday, tuesday, etc.'),
        isRecurring: z.boolean().default(true),
      }),
      execute: async ({ key, description, startTime, endTime, days, isRecurring }) => {
        await Constraint.findOneAndUpdate(
          { telegramId: ctx.telegramId, key },
          {
            $set: {
              userId: ctx.userId,
              description,
              timeRange: { start: startTime, end: endTime },
              days,
              isRecurring,
              isActive: true,
            },
          },
          { upsert: true, new: true },
        );

        await triggerReplan(ctx, ctx.today, `New constraint "${key}" blocks ${startTime}–${endTime}`);
        return { success: true, message: `Constraint saved: ${key} (${startTime}–${endTime}, ${days.join(', ')}). Schedule updated.` };
      },
    }),
  };
}
