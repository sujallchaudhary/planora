import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { MemoryType } from '../../config/defaults.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { preferenceRepo } from '../../memory/mongo/repositories/preference.repo.js';
import { Habit } from '../../memory/mongo/models/habit.model.js';
import { Constraint } from '../../memory/mongo/models/constraint.model.js';
import { SemanticMemory } from '../../memory/qdrant/semantic-memory.js';
import { getLLMProvider } from '../../llm/openai-compatible.provider.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { HybridRetriever } from '../../memory/hybrid-retriever.js';

export const storeMemoryTool = tool(
  async ({ type, key, value, timeRangeStart, timeRangeEnd, timeRangeDays }, { configurable }) => {
    const telegramId = configurable?.telegramId;
    if (!telegramId) return 'Error: telegramId missing from tool context.';

    const user = await userRepo.findByTelegramId(telegramId);
    if (!user) return 'Error: User not found.';

    try {
      if (type === MemoryType.PREFERENCE) {
        await preferenceRepo.upsert(telegramId, user._id, {
          key,
          value,
          confidence: 1.0, // Explicitly stored via tool implies high confidence
          source: 'explicit',
        });
      } else if (type === MemoryType.HABIT) {
        await Habit.findOneAndUpdate(
          { telegramId, key },
          {
            $set: {
              userId: user._id,
              description: value,
              timeRange: {
                start: timeRangeStart ?? '00:00',
                end: timeRangeEnd ?? '23:59',
              },
              days: timeRangeDays ?? ['daily'],
              frequency: 'daily',
              confidence: 1.0,
              isActive: true,
            },
            $inc: { dataPoints: 1 },
          },
          { upsert: true, new: true }
        );
      } else if (type === MemoryType.CONSTRAINT) {
        await Constraint.findOneAndUpdate(
          { telegramId, key },
          {
            $set: {
              userId: user._id,
              description: value,
              timeRange: {
                start: timeRangeStart ?? '00:00',
                end: timeRangeEnd ?? '23:59',
              },
              days: timeRangeDays ?? ['daily'],
              isRecurring: true,
              isActive: true,
            },
          },
          { upsert: true, new: true }
        );
      }

      // Also store in Qdrant for semantic search
      const llm = getLLMProvider();
      const semanticMemory = new SemanticMemory((t: string) => llm.getEmbedding(t));
      await semanticMemory.store({
        userId: user._id.toString(),
        telegramId,
        type,
        content: `${key}: ${value}`,
        metadata: {
          key,
          timeRange: { start: timeRangeStart, end: timeRangeEnd, days: timeRangeDays },
          source: 'user_message',
        },
        timestamp: new Date().toISOString(),
        confidence: 1.0,
      }).catch(() => { /* Fire and forget, MongoDB is source of truth */ });

      return `Successfully stored ${type} memory: ${key}`;
    } catch (error: any) {
      return `Failed to store memory: ${error.message}`;
    }
  },
  {
    name: 'store_memory',
    description: 'Use this tool to actively remember a user\'s habit, preference, or constraint. ONLY use this when the user explicitly mentions a long-term pattern, e.g. "I usually gym at 7am".',
    schema: z.object({
      type: z.nativeEnum(MemoryType).describe('The type of memory to store: preference, habit, or constraint'),
      key: z.string().describe('A short identifier key, e.g. "morning_gym"'),
      value: z.string().describe('The full description of the memory, e.g. "Goes to gym from 7:00 to 9:00"'),
      timeRangeStart: z.string().optional().describe('Start time in HH:mm format if applicable'),
      timeRangeEnd: z.string().optional().describe('End time in HH:mm format if applicable'),
      timeRangeDays: z.array(z.string()).optional().describe('Array of days (e.g. ["monday", "tuesday"]) if applicable, otherwise omit or ["daily"]'),
    }),
  }
);

export const searchMemoryTool = tool(
  async ({ query }, { configurable }) => {
    const telegramId = configurable?.telegramId;
    if (!telegramId) return 'Error: telegramId missing from tool context.';

    const user = await userRepo.findByTelegramId(telegramId);
    if (!user) return 'Error: User not found.';

    const config = resolveUserConfig(user.settings);

    try {
      const llm = getLLMProvider();
      const semanticMemory = new SemanticMemory((t: string) => llm.getEmbedding(t));
      const retriever = new HybridRetriever(semanticMemory);

      const memory = await retriever.retrieve(telegramId, query, config.memoryConfidenceThreshold ?? 0.6);

      // We omit recentHistory here to save context window, focusing on habits/preferences
      return JSON.stringify({
        preferences: memory.preferences.map(p => ({ key: p.key, value: p.value })),
        habits: memory.habits.map(h => ({ description: h.description, timeRange: h.timeRange })),
        constraints: memory.constraints.map(c => ({ description: c.description, timeRange: c.timeRange })),
        semanticContext: memory.semanticContext.map(s => s.content),
      }, null, 2);
    } catch (error: any) {
      return `Failed to search memory: ${error.message}`;
    }
  },
  {
    name: 'search_memory',
    description: 'Use this tool to search the user\'s past memories, habits, preferences, and constraints based on a semantic query.',
    schema: z.object({
      query: z.string().describe('The search query, e.g. "gym preferences" or "diet restrictions"'),
    }),
  }
);
