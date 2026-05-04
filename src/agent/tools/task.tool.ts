import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { Priority, CognitiveLoad } from '../../config/defaults.js';
import { planningDateString } from '../../utils/date.js';
import { resolveUserConfig } from '../../config/config-resolver.js';

export const manageTaskTool = tool(
  async ({ action, title, description, priority, cognitiveLoad, estimatedMinutes, dueDate, preferredTime, isFixed, fixedStartTime, fixedEndTime, targetTaskName }, { configurable }) => {
    const telegramId = configurable?.telegramId;
    if (!telegramId) return 'Error: telegramId missing from tool context.';

    const user = await userRepo.findByTelegramId(telegramId);
    if (!user) return 'Error: User not found.';

    const config = resolveUserConfig(user.settings);
    const today = planningDateString(config.timezone, config.lateNightThresholdHour);

    if (action === 'add') {
      if (!title) return 'Error: Title is required for adding a task.';
      const newTask = await taskRepo.create({
        userId: user._id,
        telegramId,
        title,
        description,
        priority,
        cognitiveLoad,
        estimatedMinutes,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        preferredTime,
        isFixed,
        fixedStartTime,
        fixedEndTime,
      });
      return `Added task: "${newTask.title}"`;
    }

    if (action === 'delete') {
      if (!targetTaskName) return 'Error: targetTaskName is required for deleting a task.';
      const matches = await taskRepo.findByTitle(telegramId, targetTaskName);
      if (matches.length > 0) {
        await taskRepo.deleteTask(matches[0]!._id!.toString());
        return `Deleted task: "${matches[0]!.title}"`;
      }
      return `Task matching "${targetTaskName}" not found.`;
    }

    if (action === 'modify') {
      if (!targetTaskName) return 'Error: targetTaskName is required for modifying a task.';
      const matches = await taskRepo.findByTitle(telegramId, targetTaskName);
      if (matches.length > 0) {
        const updates: Record<string, unknown> = {};
        if (title) updates.title = title;
        if (description) updates.description = description;
        if (priority) updates.priority = priority;
        if (estimatedMinutes) updates.estimatedMinutes = estimatedMinutes;
        if (preferredTime) updates.preferredTime = preferredTime;
        await taskRepo.updateTask(matches[0]!._id!.toString(), updates);
        return `Updated task: "${matches[0]!.title}"`;
      }
      return `Task matching "${targetTaskName}" not found.`;
    }

    if (action === 'complete') {
      if (!targetTaskName) return 'Error: targetTaskName is required to complete a task.';
      const schedule = await scheduleRepo.findByDate(telegramId, today);
      if (schedule) {
        const entry = schedule.entries.find(e =>
          e.title.toLowerCase().includes(targetTaskName.toLowerCase())
        );
        if (entry) {
          entry.status = 'completed' as any;
          await schedule.save();
          return `Marked "${entry.title}" as completed in today's schedule.`;
        }
      }
      // Also try to find it in general tasks and delete/complete it?
      // In execute-action, COMPLETE_TASK just marks it completed in schedule.
      return `Could not find "${targetTaskName}" in today's schedule to complete.`;
    }

    if (action === 'skip') {
      if (!targetTaskName) return 'Error: targetTaskName is required to skip a task.';
      const schedule = await scheduleRepo.findByDate(telegramId, today);
      if (schedule) {
        const entry = schedule.entries.find(e =>
          e.title.toLowerCase().includes(targetTaskName.toLowerCase())
        );
        if (entry) {
          entry.status = 'skipped' as any;
          await schedule.save();
          return `Marked "${entry.title}" as skipped in today's schedule. (Note: you should call replanScheduleTool next to adjust the rest of the day).`;
        }
      }
      return `Could not find "${targetTaskName}" in today's schedule to skip.`;
    }

    return 'Unknown action.';
  },
  {
    name: 'manage_task',
    description: 'Use this tool to add, delete, modify, complete, or skip a task.',
    schema: z.object({
      action: z.enum(['add', 'delete', 'modify', 'complete', 'skip']).describe('The action to perform'),
      title: z.string().optional().describe('Title of the task (required for add)'),
      description: z.string().optional().describe('Description of the task'),
      priority: z.nativeEnum(Priority).optional().describe('1=LOW, 2=MEDIUM, 3=HIGH, 4=URGENT, 5=CRITICAL'),
      cognitiveLoad: z.nativeEnum(CognitiveLoad).optional().describe('1=LOW, 2=MEDIUM, 3=HIGH'),
      estimatedMinutes: z.number().positive().optional().describe('Estimated duration in minutes (default 30)'),
      dueDate: z.string().optional().describe('Due date in YYYY-MM-DD format, if applicable'),
      preferredTime: z.string().optional().describe('Preferred time of day (e.g. morning, afternoon, night, or specific time)'),
      isFixed: z.boolean().optional().describe('Whether this task MUST happen at a fixed time'),
      fixedStartTime: z.string().optional().describe('Fixed start time (HH:mm) if isFixed is true'),
      fixedEndTime: z.string().optional().describe('Fixed end time (HH:mm) if isFixed is true'),
      targetTaskName: z.string().optional().describe('The name of the existing task to delete, modify, complete, or skip. (Not needed for add)'),
    }),
  }
);
