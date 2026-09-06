import type { AgentState } from '../state.js';
import { getLLMProvider } from '../../llm/index.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { formatTime, formatDateString, todayString } from '../../utils/date.js';
import { IntentType } from '../../config/defaults.js';
import { getHistory } from '../../bot/conversation-history.js';
import { describeDays } from '../../memory/memory-utils.js';
import { md } from '../../utils/markdown.js';
import { createChildLogger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import { ackReply } from '../fast-classify.js';

const log = createChildLogger('node:respond');

export async function generateResponseNode(state: AgentState): Promise<Partial<AgentState>> {
  if (state.intent?.classificationError) {
    log.warn({ err: state.intent.classificationError }, 'Responding without LLM — classification failed');
    return { response: "I couldn't reach my language model just now, so I didn't act on that. Please send it again in a moment." };
  }

  const llm = getLLMProvider();
  const user = await userRepo.findByTelegramId(state.telegramId);
  const config = resolveUserConfig(user?.settings);
  const now = new Date();
  const today = todayString(config.timezone);

  const actionResult = state.actionResult ?? { success: true, action: 'general_chat', message: 'Just chatting.' };
  const scheduleText = typeof actionResult.data?.scheduleText === 'string' ? actionResult.data.scheduleText : null;

  if (state.intent?.reasoning === 'fast:ack') {
    return { response: ackReply() };
  }

  // Routine confirmations are fully determined by what execute-action did — no model needed.
  if (env.LLM_TEMPLATE_ROUTINE_REPLIES && canTemplate(state)) {
    log.debug({ intent: state.intent?.intent }, 'Templated reply (no LLM call)');
    return { response: scheduleText ? `${actionResult.message}\n\n${scheduleText}` : actionResult.message };
  }

  // SHOW_PLAN is deterministic — no need to pay for (or risk) an LLM rewrite of a timeline.
  if (state.intent?.intent === IntentType.SHOW_PLAN && scheduleText && actionResult.success) {
    const pending = Array.isArray(actionResult.data?.pendingTasks) ? actionResult.data.pendingTasks as Array<{ title: string }> : [];
    const unsched = typeof actionResult.data?.unscheduledSummary === 'string' ? `\n\n${md(actionResult.data.unscheduledSummary)}` : '';
    const backlog = pending.length > 0 ? `\n\n_Open tasks: ${pending.map(p => md(p.title)).join(', ')}_` : '';
    return { response: `${scheduleText}${unsched}${backlog}` };
  }

  const [openTasks, todaySchedule, history] = await Promise.all([
    taskRepo.findOpenTasks(state.telegramId),
    scheduleRepo.findByDate(state.telegramId, today),
    getHistory(state.telegramId),
  ]);

  const context = {
    telegramId: state.telegramId,
    firstName: user?.firstName ?? 'there',
    timezone: config.timezone,
    currentTime: formatTime(now, config.timezone),
    currentDate: formatDateString(now, config.timezone),
    pendingTaskCount: openTasks.length,
    pendingTasksList: openTasks.slice(0, 15).map(t => `- ${t.title}${t.dueDate ? ` (due ${formatDateString(t.dueDate, config.timezone)})` : ''}`).join('\n'),
    hasScheduleToday: !!todaySchedule && todaySchedule.entries.length > 0,
    recentMemorySummary: buildMemorySummary(state),
    conversationHistory: history,
  };

  // The LLM gets facts, not the pre-rendered timeline (it is appended verbatim below).
  const { scheduleText: _omit, ...dataForLlm } = (actionResult.data ?? {}) as Record<string, unknown>;
  const response = await llm.generateResponse(
    state.rawInput,
    state.intent!,
    { ...actionResult, data: dataForLlm },
    context,
  );

  return { response: scheduleText ? `${response}\n\n${scheduleText}` : response };
}

const ROUTINE = new Set<string>([
  IntentType.COMPLETE_TASK, IntentType.SKIP_TASK, IntentType.DELETE_TASK, IntentType.MODIFY_TASK, IntentType.ADD_TASK, IntentType.REPLAN,
]);

/** True when the outcome is simple enough that the deterministic message already says everything. */
function canTemplate(state: AgentState): boolean {
  const intent = state.intent;
  const result = state.actionResult;
  if (!intent || !result || !result.success) return false;
  if (!ROUTINE.has(intent.intent)) return false;
  if (intent.secondaryIntents.length > 0 || intent.memorySignals.length > 0) return false;
  if (intent.userState?.energy || intent.userState?.mood || intent.userState?.unavailableUntil) return false;
  if (state.autonomyContext?.signals.length) return false;
  const data = result.data ?? {};
  if (data.unscheduledSummary || data.candidates) return false;
  // A REPLAN the user explicitly asked for deserves a framing sentence — unless it was the fast path.
  if (intent.intent === IntentType.REPLAN && !intent.reasoning?.startsWith('fast:')) return false;
  return true;
}

function buildMemorySummary(state: AgentState): string {
  const mem = state.retrievedMemory;
  if (!mem) return '';
  const parts: string[] = [];

  if (mem.preferences.length > 0) {
    parts.push(`Preferences:\n${mem.preferences.map(p => `• ${p.key.replace(/_/g, ' ')}: ${p.value}${p.source === 'inferred' ? ' (learned from behavior)' : ''}`).join('\n')}`);
  }
  if (mem.habits.length > 0) {
    parts.push(`Habits:\n${mem.habits.map(h => `• ${h.key.replace(/_/g, ' ')}: ${h.description} ${h.timeRange?.start ? `(${h.timeRange.start}–${h.timeRange.end}, ${describeDays(h.days)})` : ''}`).join('\n')}`);
  }
  if (mem.constraints.length > 0) {
    parts.push(`Fixed commitments:\n${mem.constraints.map(c => `• ${c.key.replace(/_/g, ' ')}: ${c.description} ${c.timeRange?.start && c.timeRange.start !== '00:00' ? `(${c.timeRange.start}–${c.timeRange.end}, ${describeDays(c.days)})` : ''}${c.expiresOn ? ` until ${c.expiresOn}` : ''}`).join('\n')}`);
  }
  if (mem.recentHistory.length > 0) {
    parts.push(`Recent activity:\n${mem.recentHistory.slice(0, 5).map(h => `• ${h.title} — ${h.outcome} on ${h.scheduledDate}`).join('\n')}`);
  }
  if (mem.semanticContext.length > 0) {
    parts.push(`Relevant context:\n${mem.semanticContext.slice(0, 4).map(s => `• [${s.type}] ${s.content.slice(0, 200)}`).join('\n')}`);
  }
  return parts.join('\n\n');
}
