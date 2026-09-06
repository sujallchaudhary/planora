import type { AgentState } from '../state.js';
import { getLLMProvider } from '../../llm/index.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { nowInTimezone, formatTime, formatDateString, todayString, planningDateString, tomorrowString } from '../../utils/date.js';
import { getHistory } from '../../bot/conversation-history.js';
import { fastClassify } from '../fast-classify.js';
import { env } from '../../config/env.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('node:classify');

export async function classifyIntentNode(state: AgentState): Promise<Partial<AgentState>> {
  log.debug({ telegramId: state.telegramId }, 'Classifying intent');

  const llm = getLLMProvider();
  const user = await userRepo.findByTelegramId(state.telegramId);
  const config = resolveUserConfig(user?.settings);
  const now = new Date();
  const zonedNow = nowInTimezone(config.timezone);
  const today = todayString(config.timezone);
  const planningDate = planningDateString(config.timezone, config.lateNightThresholdHour);
  const tomorrowDate = tomorrowString(config.timezone, config.lateNightThresholdHour);

  if (env.LLM_FAST_CLASSIFY && !state.imageBase64) {
    const fast = fastClassify(state.rawInput, { today: planningDate, tomorrow: tomorrowDate });
    if (fast) {
      log.info({ telegramId: state.telegramId, intent: fast.intent }, 'Fast-path classification (no LLM call)');
      return { intent: fast };
    }
  }

  const [openTasks, todaySchedule, history] = await Promise.all([
    taskRepo.findOpenTasks(state.telegramId),
    scheduleRepo.findByDate(state.telegramId, today),
    getHistory(state.telegramId),
  ]);

  const pendingTasksList = openTasks.map(t => {
    const bits: string[] = [];
    if (t.dueDate) bits.push(`due ${formatDateString(t.dueDate, config.timezone)}`);
    if (t.isFixed && t.fixedStartTime && t.fixedEndTime) bits.push(`fixed ${t.fixedStartTime}-${t.fixedEndTime}`);
    else bits.push(`${t.estimatedMinutes}m`);
    if (t.deferredUntil && t.deferredUntil > today) bits.push(`deferred to ${t.deferredUntil}`);
    if (t.recurrence?.pattern) bits.push(t.recurrence.pattern);
    return `- ${t._id} → ${t.title} (${bits.join(', ')})`;
  }).join('\n');

  const context = {
    telegramId: state.telegramId,
    firstName: user?.firstName ?? 'User',
    timezone: config.timezone,
    currentTime: formatTime(now, config.timezone),
    currentDate: formatDateString(now, config.timezone),
    planningDate,
    tomorrowDate,
    isLateNight: zonedNow.getHours() < config.lateNightThresholdHour,
    pendingTaskCount: openTasks.length,
    pendingTasksList,
    hasScheduleToday: !!todaySchedule && todaySchedule.entries.length > 0,
    conversationHistory: history,
  };

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

  return { intent: await llm.classifyAndExtract(inputText, context) };
}
