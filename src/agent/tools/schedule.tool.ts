import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { planningDateString } from '../../utils/date.js';
import { replan } from '../../scheduler/replanner.js';
import { syncReminders } from '../../execution/job-manager.js';
import { getLLMProvider } from '../../llm/openai-compatible.provider.js';

export const replanScheduleTool = tool(
  async (_, { configurable }) => {
    const telegramId = configurable?.telegramId;
    if (!telegramId) return 'Error: telegramId missing from tool context.';

    const user = await userRepo.findByTelegramId(telegramId);
    if (!user) return 'Error: User not found.';

    const config = resolveUserConfig(user.settings);
    const today = planningDateString(config.timezone, config.lateNightThresholdHour);

    try {
      const tasks = await taskRepo.findPendingTasks(telegramId);
      const existingSchedule = await scheduleRepo.findByDate(telegramId, today);

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

      const schedule = await scheduleRepo.createOrReplace(telegramId, user._id, today, newEntries);
      await syncReminders(telegramId, today, schedule.entries);

      return `Successfully replanned schedule. ${newEntries.length} tasks scheduled for today. [ACTION COMPLETE: DO NOT CALL THIS TOOL AGAIN. RESPOND TO THE USER DIRECTLY.]`;
    } catch (error: any) {
      return `Failed to replan schedule: ${error.message}`;
    }
  },
  {
    name: 'replan_schedule',
    description: 'Use this tool to trigger a replanning of the day\'s schedule. Call this after adding, skipping, or completing tasks if the user asks to replan.',
    schema: z.object({
      _dummy: z.string().optional().nullable().describe('Ignore this parameter.'),
    }),
  }
);

export const getScheduleTool = tool(
  async (_, { configurable }) => {
    const telegramId = configurable?.telegramId;
    if (!telegramId) return 'Error: telegramId missing from tool context.';

    const user = await userRepo.findByTelegramId(telegramId);
    if (!user) return 'Error: User not found.';

    const config = resolveUserConfig(user.settings);
    const today = planningDateString(config.timezone, config.lateNightThresholdHour);

    const schedule = await scheduleRepo.findByDate(telegramId, today);
    if (!schedule || schedule.entries.length === 0) {
      return 'There are currently no tasks scheduled for today.';
    }

    return JSON.stringify(
      schedule.entries.map(e => ({
        title: e.title,
        startTime: e.startTime,
        endTime: e.endTime,
        status: e.status,
      })),
      null,
      2
    );
  },
  {
    name: 'get_schedule',
    description: 'Use this tool to get the user\'s current schedule for today.',
    schema: z.object({
      _dummy: z.string().optional().nullable().describe('Ignore this parameter.'),
    }),
  }
);
