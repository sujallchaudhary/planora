import { generateText } from 'ai';
import { chatModel, extractImageContent } from '../llm/ai-provider.js';
import { createAgentTools } from './tools.js';
import { buildSystemPrompt, type AgentContext } from './system-prompt.js';
import { searchMemory, addConversationMemory } from '../memory/mem0-memory.js';
import { userRepo } from '../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../memory/mongo/repositories/schedule.repo.js';
import { preferenceRepo } from '../memory/mongo/repositories/preference.repo.js';
import { Habit } from '../memory/mongo/models/habit.model.js';
import { Constraint } from '../memory/mongo/models/constraint.model.js';
import { resolveUserConfig } from '../config/config-resolver.js';
import { getHistory } from '../bot/conversation-history.js';
import { nowInTimezone, planningDateString, formatTimeHuman, todayString } from '../utils/date.js';
import { format } from 'date-fns';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('agent');

export async function runAgent(input: {
  userId: string;
  telegramId: number;
  chatId: number;
  rawInput: string;
  imageBase64?: string;
  imageMimeType?: string;
}): Promise<string> {
  const user = await userRepo.findByTelegramId(input.telegramId);
  if (!user) {
    return 'Please send /start first to register.';
  }

  const config = resolveUserConfig(user.settings);
  const now = nowInTimezone(config.timezone);
  const today = planningDateString(config.timezone, config.lateNightThresholdHour);
  const currentTime = format(now, 'h:mm a');
  const currentDate = format(now, 'EEEE, MMMM d, yyyy');
  const isLateNight = now.getHours() < config.lateNightThresholdHour;

  // Enrich input with image content if present
  let enrichedInput = input.rawInput;
  if (input.imageBase64 && input.imageMimeType) {
    const imageResult = await extractImageContent(input.imageBase64, input.imageMimeType);
    if (imageResult.content && imageResult.content !== 'Failed to extract content from the image.') {
      enrichedInput = `[Image content: ${imageResult.content}]\n\nUser message: ${input.rawInput}`;
    }
  }

  // Fetch context in parallel
  const [pendingTasks, todaySchedule, preferences, habits, constraints, memories] = await Promise.all([
    taskRepo.findPendingTasks(input.telegramId),
    scheduleRepo.findByDate(input.telegramId, today),
    preferenceRepo.findHighConfidence(input.telegramId, config.memoryConfidenceThreshold),
    Habit.find({ telegramId: input.telegramId, isActive: true, confidence: { $gte: config.memoryConfidenceThreshold } }),
    Constraint.find({ telegramId: input.telegramId, isActive: true }),
    searchMemory(enrichedInput, input.userId).catch(() => []),
  ]);

  // Build context for system prompt
  const agentCtx: AgentContext = {
    firstName: user.firstName,
    telegramId: input.telegramId,
    timezone: config.timezone,
    currentTime,
    currentDate,
    planningDate: today,
    isLateNight,
    pendingTasks: pendingTasks.map(t => ({
      id: t._id!.toString(),
      title: t.title,
      priority: t.priority,
      estimatedMinutes: t.estimatedMinutes,
      dueDate: t.dueDate ? format(t.dueDate, 'yyyy-MM-dd') : undefined,
    })),
    todaySchedule: (todaySchedule?.entries ?? []).map(e => ({
      title: e.title,
      startTime: formatTimeHuman(e.startTime, config.timezone),
      endTime: formatTimeHuman(e.endTime, config.timezone),
      status: e.status,
    })),
    preferences,
    habits,
    constraints,
    memories,
  };

  // Build conversation history for the LLM
  // The current user message is already appended to history by the handler,
  // but we may need to replace it with an enriched version (e.g., with image content)
  const history = getHistory(input.telegramId);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = history.map(h => ({
    role: h.role,
    content: h.content,
  }));

  // If we enriched the input (e.g., image extraction), replace the last user message
  if (enrichedInput !== input.rawInput && messages.length > 0) {
    const lastIdx = messages.length - 1;
    if (messages[lastIdx].role === 'user') {
      messages[lastIdx] = { role: 'user', content: enrichedInput };
    }
  }

  // Create tools with the current context
  const tools = createAgentTools({
    telegramId: input.telegramId,
    userId: user._id,
    config,
    today,
  });

  try {
    const result = await generateText({
      model: chatModel,
      system: buildSystemPrompt(agentCtx),
      messages,
      tools,
      maxSteps: 5,
      temperature: config.lateNightThresholdHour ? 0.3 : 0.4,
    });

    const response = result.text || 'I processed your message but couldn\'t generate a response.';

    // Store conversation in Mem0 (async, don't block response)
    void addConversationMemory(
      [
        { role: 'user', content: input.rawInput },
        { role: 'assistant', content: response },
      ],
      input.userId,
    );

    log.info({
      telegramId: input.telegramId,
      toolCalls: result.steps.flatMap(s => s.toolCalls).map(tc => tc.toolName),
      responseLength: response.length,
    }, 'Agent completed');

    return response;
  } catch (error) {
    log.error({ error, telegramId: input.telegramId }, 'Agent error');
    return '😅 Something went wrong processing your message. Please try again.';
  }
}
