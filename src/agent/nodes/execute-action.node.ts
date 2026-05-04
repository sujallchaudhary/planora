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
import { planningDateString, nowInTimezone } from '../../utils/date.js';
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
  // Use late-night-aware planning date — before 4 AM, "today" = yesterday
  const today = planningDateString(config.timezone, config.lateNightThresholdHour);

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
      await triggerReplan(state.telegramId, user._id.toString(), config, today);
      result.message += ' and updated your schedule.';
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
      await triggerReplan(state.telegramId, user._id.toString(), config, today);
      result.message += ' and updated your schedule.';
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
      await triggerReplan(state.telegramId, user._id.toString(), config, today);
      result.message += ' and updated your schedule.';
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
      if (found) {
        await triggerReplan(state.telegramId, user._id.toString(), config, today);
        result.message += ' and updated your schedule.';
      }
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
      const replanDate = state.intent.targetDate ?? today;
      const newEntries = await triggerReplan(state.telegramId, user._id.toString(), config, replanDate);
      const dateLabel = replanDate === today ? 'your day' : replanDate;
      result = {
        success: true,
        action: 'replan',
        message: `Replanned ${dateLabel} — ${newEntries} tasks scheduled`,
        data: { scheduledCount: newEntries, reason: state.intent.replanContext, targetDate: replanDate },
      };
      break;
    }

    case IntentType.SHOW_PLAN: {
      const showDate = state.intent.targetDate ?? today;
      const schedule = await scheduleRepo.findByDate(state.telegramId, showDate);
      const dateLabel = showDate === today ? 'today' : showDate;
      if (!schedule || schedule.entries.length === 0) {
        result = { success: true, action: 'show_plan', message: `No schedule for ${dateLabel} yet. Say "plan ${dateLabel}" to create one.`, data: { entries: [], targetDate: showDate } };
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
              const matches = await taskRepo.findByTitle(state.telegramId, secondary.taskReference);
              if (matches.length > 0) {
                await taskRepo.deleteTask(matches[0]!._id!.toString());
                msg = `Deleted "${matches[0]!.title}"`;
              }
            }
            break;
          }
          case IntentType.MODIFY_TASK: {
            if (secondary.taskReference) {
              const matches = await taskRepo.findByTitle(state.telegramId, secondary.taskReference);
              if (matches.length > 0 && secondary.tasks[0]) {
                const t = secondary.tasks[0];
                const updates: Record<string, unknown> = {};
                if (t.title) updates.title = t.title;
                if (t.description) updates.description = t.description;
                if (t.priority) updates.priority = t.priority;
                if (t.estimatedMinutes) updates.estimatedMinutes = t.estimatedMinutes;
                if (t.preferredTime) updates.preferredTime = t.preferredTime;
                await taskRepo.updateTask(matches[0]!._id!.toString(), updates);
                msg = `Updated "${matches[0]!.title}"`;
              }
            }
            break;
          }
          case IntentType.COMPLETE_TASK: {
            if (secondary.taskReference) {
              const schedule = await scheduleRepo.findByDate(state.telegramId, today);
              if (schedule) {
                const entry = schedule.entries.find(e =>
                  e.title.toLowerCase().includes(secondary.taskReference!.toLowerCase())
                );
                if (entry) {
                  entry.status = 'completed' as any;
                  await schedule.save();
                  msg = `Completed "${entry.title}"`;
                }
              }
            }
            break;
          }
          case IntentType.REPLAN: {
            const count = await triggerReplan(state.telegramId, user._id.toString(), config, today);
            msg = `Replanned — ${count} tasks scheduled`;
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

async function triggerReplan(telegramId: number, userId: string, config: any, today: string): Promise<number> {
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
