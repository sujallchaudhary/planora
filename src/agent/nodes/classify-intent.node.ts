import type { AgentState } from '../state.js';
import { getLLMProvider } from '../../llm/openai-compatible.provider.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { nowInTimezone, formatTime, formatDateString, todayString, planningDateString, tomorrowString } from '../../utils/date.js';
import { getHistory } from '../../bot/conversation-history.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('node:classify');

export async function classifyIntentNode(state: AgentState): Promise<Partial<AgentState>> {
  log.debug({ telegramId: state.telegramId }, 'Classifying intent');

  const llm = getLLMProvider();
  const user = await userRepo.findByTelegramId(state.telegramId);
  const config = resolveUserConfig(user?.settings);
  const now = nowInTimezone(config.timezone);
  const pendingTasks = await taskRepo.findPendingTasks(state.telegramId);
  const pendingCount = pendingTasks.length;
  const pendingTasksList = pendingTasks.map(t => `- ${t.title}`).join('\n');
  const todaySchedule = await scheduleRepo.findByDate(state.telegramId, todayString(config.timezone));

  const context = {
    telegramId: state.telegramId,
    firstName: user?.firstName ?? 'User',
    timezone: config.timezone,
    currentTime: formatTime(now, config.timezone),
    currentDate: formatDateString(now, config.timezone),
    // Late-night aware planning dates
    planningDate: planningDateString(config.timezone, config.lateNightThresholdHour),
    tomorrowDate: tomorrowString(config.timezone, config.lateNightThresholdHour),
    isLateNight: now.getHours() < config.lateNightThresholdHour,
    pendingTaskCount: pendingCount,
    pendingTasksList: pendingTasksList,
    hasScheduleToday: !!todaySchedule && todaySchedule.entries.length > 0,
    conversationHistory: getHistory(state.telegramId),
  };


  // If there's an image, process it first and include context
  let inputText = state.rawInput;
  if (state.imageBase64 && state.imageMimeType) {
    const imageResult = await llm.extractImageContent(state.imageBase64, state.imageMimeType);
    inputText = inputText
      ? `${inputText}\n\n[Image Context]: ${imageResult.content}`
      : `[Image Context]: ${imageResult.content}`;

    return {
      intent: await llm.classifyAndExtract(inputText, context),
      imageContext: imageResult,
    };
  }

  const classification = await llm.classifyAndExtract(inputText, context);
  return { intent: classification };
}
