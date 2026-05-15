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
import { getLLMProvider } from '../../llm/openai-compatible.provider.js';
import { planningDateString } from '../../utils/date.js';
import { createChildLogger } from '../../utils/logger.js';
import type { PlanningContext } from '../../scheduler/planning-context.js';

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
  // Use late-night-aware planning date — before 4 AM, "today" = yesterday
  const today = planningDateString(config.timezone, config.lateNightThresholdHour);

  let result: ActionResult;
  let replanAlreadyDone = false;
  const effectiveIntent = state.autonomyContext?.shouldReplan && state.intent.intent === IntentType.GENERAL_CHAT
    ? IntentType.REPLAN
    : state.intent.intent;

  switch (effectiveIntent) {
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
      // Smart replan: target the earliest due date among added tasks, falling back to today
      const dueDates = tasks.map(t => t.dueDate).filter(Boolean) as string[];
      const earliestDue = dueDates.length > 0
        ? dueDates.sort()[0]!
        : today;
      const replanTarget = earliestDue < today ? today : earliestDue;

      // Always replan today to fit the new tasks, and if the early due date is different, replan that too
      const datesToReplan = Array.from(new Set([today, replanTarget]));
      for (const targetDate of datesToReplan) {
        await triggerReplan(state.telegramId, user._id.toString(), config, targetDate, state.autonomyContext?.planningContext);
      }
      
      replanAlreadyDone = true;
      result.message += ' and updated your schedule.';
      break;
    }

    case IntentType.MODIFY_TASK: {
      const ref = state.intent.taskReference;
      if (!ref) {
        result = { success: false, action: 'modify_task', message: 'Which task do you want to modify?' };
        break;
      }
      const task = await taskRepo.findById(ref) ?? (await taskRepo.findByTitle(state.telegramId, ref))[0];
      if (!task) {
        result = { success: false, action: 'modify_task', message: `I couldn't find that task.` };
        break;
      }
      const updates: Record<string, unknown> = {};
      if (state.intent.tasks[0]) {
        const t = state.intent.tasks[0];
        if (t.title) updates.title = t.title;
        if (t.description) updates.description = t.description;
        if (t.priority) updates.priority = t.priority;
        if (t.estimatedMinutes) updates.estimatedMinutes = t.estimatedMinutes;
        if (t.preferredTime) updates.preferredTime = t.preferredTime;
        if (t.dueDate !== undefined) updates.dueDate = t.dueDate ? new Date(t.dueDate) : null;
        if (t.isFixed !== undefined) updates.isFixed = t.isFixed;
        if (t.fixedStartTime !== undefined) updates.fixedStartTime = t.fixedStartTime;
        if (t.fixedEndTime !== undefined) updates.fixedEndTime = t.fixedEndTime;
      }
      await taskRepo.updateTask(task._id!.toString(), updates);
      
      // Determine which day to replan (the new due date if changed, otherwise today)
      let replanTarget = today;
      if (updates.dueDate) {
        replanTarget = (updates.dueDate as Date).toISOString().split('T')[0]!;
      } else if (task.dueDate) {
        replanTarget = task.dueDate.toISOString().split('T')[0]!;
      }
      
      result = { success: true, action: 'modify_task', message: `Updated task "${task.title}"` };
      await triggerReplan(state.telegramId, user._id.toString(), config, replanTarget, state.autonomyContext?.planningContext);
      replanAlreadyDone = true;
      result.message += ' and updated your schedule.';
      break;
    }

    case IntentType.DELETE_TASK: {
      const ref = state.intent.taskReference;
      if (!ref) {
        result = { success: false, action: 'delete_task', message: 'Which task do you want to delete?' };
        break;
      }
      const taskToDelete = await taskRepo.findById(ref) ?? (await taskRepo.findByTitle(state.telegramId, ref))[0];
      if (!taskToDelete) {
        result = { success: false, action: 'delete_task', message: `I couldn't find that task.` };
        break;
      }
      await taskRepo.deleteTask(taskToDelete._id!.toString());
      result = { success: true, action: 'delete_task', message: `Deleted task "${taskToDelete.title}"` };
      await triggerReplan(state.telegramId, user._id.toString(), config, today, state.autonomyContext?.planningContext);
      replanAlreadyDone = true;
      result.message += ' and updated your schedule.';
      break;
    }

    case IntentType.COMPLETE_TASK: {
      const ref = state.intent.taskReference;

      const todaySchedule = await scheduleRepo.findByDate(state.telegramId, today);
      let countComplete = 0;
      let taskTitle = ref ?? 'task';

      // No specific task referenced → complete everything
      if (!ref) {
        if (todaySchedule) {
          for (const e of todaySchedule.entries) {
            if (e.status === 'scheduled' || e.status === 'active') {
              await scheduleRepo.updateEntryStatus(state.telegramId, today, (e as any)._id.toString(), 'completed');
              if (e.taskId) {
                await taskRepo.updateStatus(e.taskId.toString(), TaskStatus.COMPLETED);
              }
              countComplete++;
            }
          }
        }
        const pending = await taskRepo.findPendingTasks(state.telegramId);
        for (const pt of pending) {
          await taskRepo.updateStatus(pt._id!.toString(), TaskStatus.COMPLETED);
          countComplete++;
        }
        result = { success: true, action: 'complete_task', message: `Marked ${countComplete} tasks as completed ✅` };
        replanAlreadyDone = true;
        await triggerReplan(state.telegramId, user._id.toString(), config, today, state.autonomyContext?.planningContext);
        result.message += ' and updated your schedule.';
        break;
      }

      let found = false;

      // Look up by task _id first (from LLM), then check schedule
      const taskById = await taskRepo.findById(ref);
      if (taskById) {
        await taskRepo.updateStatus(taskById._id!.toString(), TaskStatus.COMPLETED);
        taskTitle = taskById.title;
        found = true;

        // Also update the schedule entry if it exists
        if (todaySchedule) {
          const scheduleEntry = todaySchedule.entries.find(e => e.taskId?.toString() === taskById._id!.toString());
          if (scheduleEntry) {
            await scheduleRepo.updateEntryStatus(state.telegramId, today, (scheduleEntry as any)._id.toString(), 'completed');
            await taskHistoryRepo.record({
              userId: user._id,
              telegramId: state.telegramId,
              taskId: taskById._id!,
              title: taskById.title,
              scheduledDate: today,
              scheduledStartTime: scheduleEntry.startTime,
              scheduledEndTime: scheduleEntry.endTime,
              outcome: 'completed',
              completedAt: new Date(),
            });
          }
        }
      }

      result = {
        success: true,
        action: 'complete_task',
        message: found ? `Marked "${taskTitle}" as completed ✅` : 'I couldn\'t find that task in your schedule. Try /schedule to see your tasks.',
      };
      if (found) {
        await triggerReplan(state.telegramId, user._id.toString(), config, today, state.autonomyContext?.planningContext);
        replanAlreadyDone = true;
        result.message += ' and updated your schedule.';
      }
      break;
    }

    case IntentType.SKIP_TASK: {
      const ref = state.intent.taskReference;
      const todaySchedule = await scheduleRepo.findByDate(state.telegramId, today);
      let taskTitle = ref ?? 'current task';
      let skipped = false;

      // Look up by task _id first
      if (ref) {
        const taskById = await taskRepo.findById(ref);
        if (taskById) {
          await taskRepo.updateStatus(taskById._id!.toString(), TaskStatus.SKIPPED);
          taskTitle = taskById.title;
          skipped = true;

          if (todaySchedule) {
            const scheduleEntry = todaySchedule.entries.find(e => e.taskId?.toString() === taskById._id!.toString());
            if (scheduleEntry) {
              await scheduleRepo.updateEntryStatus(state.telegramId, today, (scheduleEntry as any)._id.toString(), 'skipped');
              await taskHistoryRepo.record({
                userId: user._id,
                telegramId: state.telegramId,
                taskId: taskById._id!,
                title: taskById.title,
                scheduledDate: today,
                scheduledStartTime: scheduleEntry.startTime,
                scheduledEndTime: scheduleEntry.endTime,
                outcome: 'skipped',
              });
            }
          }
        }
      }

      // Fallback: skip first active/scheduled entry if no ref
      if (!skipped && todaySchedule) {
        const activeEntry = todaySchedule.entries.find(e =>
          e.status === 'scheduled' || e.status === 'active'
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
      await triggerReplan(state.telegramId, user._id.toString(), config, today, state.autonomyContext?.planningContext);
      replanAlreadyDone = true;
      result = { success: true, action: 'skip_task', message: `Skipped "${taskTitle}" and replanned the rest of your day` };
      break;
    }

    case IntentType.ADD_PREFERENCE:
    case IntentType.ADD_CONSTRAINT:
    case IntentType.ADD_HABIT: {
      // Memory signals are already stored in the extract-memory node
      // BUT if the LLM also extracted tasks (e.g. "exam from 2-5 PM"), we must create them!
      const memTasks = state.intent.tasks;
      if (memTasks.length > 0) {
        const created = [];
        for (const task of memTasks) {
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
        // Smart replan: target the task's due date
        const dueDates = memTasks.map(t => t.dueDate).filter(Boolean) as string[];
        const replanTarget = dueDates.length > 0
          ? (dueDates.sort()[0]! < today ? today : dueDates.sort()[0]!)
          : today;
        await triggerReplan(state.telegramId, user._id.toString(), config, replanTarget, state.autonomyContext?.planningContext);
        replanAlreadyDone = true;
        result = {
          success: true,
          action: 'add_memory',
          message: `Got it! Added ${created.length} task(s) and updated your schedule.`,
          data: { tasks: created.map(t => ({ id: t._id, title: t.title })) },
        };
      } else {
        result = { success: true, action: 'add_memory', message: 'Got it! I\'ll remember that for future planning.' };
      }
      break;
    }

    case IntentType.REPLAN: {
      const replanDate = state.intent.targetDate ?? today;
      const newEntries = await triggerReplan(state.telegramId, user._id.toString(), config, replanDate, state.autonomyContext?.planningContext);
      const dateLabel = replanDate === today ? 'your day' : replanDate;
      result = {
        success: true,
        action: 'replan',
        message: `Replanned ${dateLabel} — ${newEntries} tasks scheduled`,
        data: { scheduledCount: newEntries, reason: state.intent.replanContext ?? state.autonomyContext?.summary, targetDate: replanDate },
      };
      break;
    }

    case IntentType.SHOW_PLAN: {
      const showDate = state.intent.targetDate ?? today;
      const schedule = await scheduleRepo.findByDate(state.telegramId, showDate);
      const pendingTasks = await taskRepo.findPendingTasks(state.telegramId);
      const dateLabel = showDate === today ? 'today' : showDate;

      if (!schedule || schedule.entries.length === 0) {
        if (pendingTasks.length > 0) {
          result = {
            success: true,
            action: 'show_plan',
            message: `No schedule for ${dateLabel} yet, but you have ${pendingTasks.length} pending task(s). Say "plan my day" to schedule them.`,
            data: {
              entries: [],
              targetDate: showDate,
              pendingTasks: pendingTasks.map(t => ({ id: t._id, title: t.title, priority: t.priority, estimatedMinutes: t.estimatedMinutes })),
            },
          };
        } else {
          result = { success: true, action: 'show_plan', message: `No schedule or pending tasks for ${dateLabel}.`, data: { entries: [], targetDate: showDate, pendingTasks: [] } };
        }
      } else {
        result = {
          success: true,
          action: 'show_plan',
          message: `Here's your plan for ${dateLabel}`,
          data: {
            targetDate: showDate,
            entries: schedule.entries.map(e => ({
              title: e.title,
              startTime: e.startTime,
              endTime: e.endTime,
              status: e.status,
              priority: e.priority,
            })),
            pendingTasks: pendingTasks.map(t => ({ id: t._id, title: t.title, priority: t.priority, estimatedMinutes: t.estimatedMinutes })),
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

  // Process secondary intents (compound messages like "add gym and delete math")
  if (state.intent.secondaryIntents && state.intent.secondaryIntents.length > 0) {
    const secondaryResults: string[] = [];
    for (const secondary of state.intent.secondaryIntents) {
      try {
        let msg = '';
        switch (secondary.intent) {
          case IntentType.ADD_TASK: {
            if (secondary.tasks.length > 0) {
              for (const task of secondary.tasks) {
                await taskRepo.create({
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
              }
              msg = `Added ${secondary.tasks.length} task(s): ${secondary.tasks.map(t => t.title).join(', ')}`;
            }
            break;
          }
          case IntentType.DELETE_TASK: {
            if (secondary.taskReference) {
              const delTask = await taskRepo.findById(secondary.taskReference) ?? (await taskRepo.findByTitle(state.telegramId, secondary.taskReference))[0];
              if (delTask) {
                await taskRepo.deleteTask(delTask._id!.toString());
                msg = `Deleted "${delTask.title}"`;
              }
            }
            break;
          }
          case IntentType.MODIFY_TASK: {
            if (secondary.taskReference) {
              const modTask = await taskRepo.findById(secondary.taskReference) ?? (await taskRepo.findByTitle(state.telegramId, secondary.taskReference))[0];
              if (modTask && secondary.tasks[0]) {
                const t = secondary.tasks[0];
                const updates: Record<string, unknown> = {};
                if (t.title) updates.title = t.title;
                if (t.description) updates.description = t.description;
                if (t.priority) updates.priority = t.priority;
                if (t.estimatedMinutes) updates.estimatedMinutes = t.estimatedMinutes;
                if (t.preferredTime) updates.preferredTime = t.preferredTime;
                await taskRepo.updateTask(modTask._id!.toString(), updates);
                msg = `Updated "${modTask.title}"`;
              }
            }
            break;
          }
          case IntentType.COMPLETE_TASK: {
            if (secondary.taskReference) {
              const compTask = await taskRepo.findById(secondary.taskReference) ?? (await taskRepo.findByTitle(state.telegramId, secondary.taskReference))[0];
              if (compTask) {
                await taskRepo.updateStatus(compTask._id!.toString(), TaskStatus.COMPLETED);
                msg = `Completed "${compTask.title}"`;
              }
            }
            break;
          }
          case IntentType.REPLAN: {
            if (replanAlreadyDone) {
              msg = 'Schedule already updated';
            } else {
              const replanDate = secondary.targetDate ?? today;
              const count = await triggerReplan(state.telegramId, user._id.toString(), config, replanDate, state.autonomyContext?.planningContext);
              replanAlreadyDone = true;
              msg = `Replanned — ${count} tasks scheduled`;
            }
            break;
          }
          default:
            break;
        }
        if (msg) {
          secondaryResults.push(msg);
          log.info({ secondaryIntent: secondary.intent, msg }, 'Executed secondary intent');
        }
      } catch (err) {
        log.error({ err, secondaryIntent: secondary.intent }, 'Secondary intent failed');
      }
    }

    if (secondaryResults.length > 0) {
      result.message += ' | ' + secondaryResults.join(' | ');
    }
  }

  return { actionResult: result };
}

async function triggerReplan(
  telegramId: number,
  userId: string,
  config: any,
  today: string,
  planningContext?: PlanningContext,
): Promise<number> {
  try {
    const tasks = await taskRepo.findPendingTasks(telegramId);
    const existingSchedule = await scheduleRepo.findByDate(telegramId, today);
    const userDoc = await userRepo.findByTelegramId(telegramId);
    if (!userDoc) return 0;

    // Fetch real memory so replan respects habits and constraints
    const llm = getLLMProvider();
    const { SemanticMemory } = await import('../../memory/qdrant/semantic-memory.js');
    const { HybridRetriever } = await import('../../memory/hybrid-retriever.js');
    const semanticMemory = new SemanticMemory((t: string) => llm.getEmbedding(t));
    const retriever = new HybridRetriever(semanticMemory);
    const memory = await retriever.retrieve(telegramId, `Replan for ${today}`, config.memoryConfidenceThreshold ?? 0.6).catch(() => ({
      preferences: [],
      habits: [],
      constraints: [],
      semanticContext: [],
      recentHistory: [],
    }));

    const newEntries = await replan(
      tasks,
      existingSchedule?.entries ?? [],
      memory,
      config,
      today,
      planningContext,
    );

    const schedule = await scheduleRepo.createOrReplace(telegramId, userDoc._id, today, newEntries);
    await syncReminders(telegramId, today, schedule.entries);
    log.info({ telegramId, entries: newEntries.length }, 'Replanned schedule');
    return newEntries.length;
  } catch (error) {
    log.error({ error }, 'Failed to replan');
    return 0;
  }
}
