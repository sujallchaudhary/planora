import type { AgentState } from '../state.js';
import { getLLMProvider } from '../../llm/openai-compatible.provider.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { taskRepo } from '../../memory/mongo/repositories/task.repo.js';
import { scheduleRepo } from '../../memory/mongo/repositories/schedule.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { nowInTimezone, formatTime, formatDateString, todayString } from '../../utils/date.js';
import { IntentType } from '../../config/defaults.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('node:respond');

export async function generateResponseNode(state: AgentState): Promise<Partial<AgentState>> {
  const llm = getLLMProvider();
  const user = await userRepo.findByTelegramId(state.telegramId);
  const config = resolveUserConfig(user?.settings);
  const now = nowInTimezone(config.timezone);

  const context = {
    telegramId: state.telegramId,
    firstName: user?.firstName ?? 'User',
    timezone: config.timezone,
    currentTime: formatTime(now, config.timezone),
    currentDate: formatDateString(now, config.timezone),
    pendingTaskCount: await taskRepo.countPendingTasks(state.telegramId),
    hasScheduleToday: !!(await scheduleRepo.findByDate(state.telegramId, todayString(config.timezone))),
    // Pass retrieved memory so LLM can answer personal questions
    recentMemorySummary: buildMemorySummary(state),
  };

  // For SHOW_PLAN, format the schedule nicely before sending to LLM
  let actionResult = state.actionResult ?? {
    success: true,
    action: 'general_chat',
    message: 'Just chatting',
  };

  if (state.intent?.intent === IntentType.SHOW_PLAN && actionResult.data?.entries) {
    const entries = actionResult.data.entries as Array<{
      title: string;
      startTime: string;
      endTime: string;
      status: string;
      priority: number;
    }>;

    if (entries.length > 0) {
      const formatted = entries.map(e => {
        const start = new Date(e.startTime);
        const end = new Date(e.endTime);
        const startStr = formatTime(start, config.timezone);
        const endStr = formatTime(end, config.timezone);
        const statusEmoji = e.status === 'completed' ? '✅' : e.status === 'skipped' ? '⏭' : '📋';
        return `${statusEmoji} ${startStr} – ${endStr}: ${e.title}`;
      }).join('\n');

      actionResult = {
        ...actionResult,
        message: `Here's your plan for today:\n\n${formatted}`,
      };
    }
  }

  const response = await llm.generateResponse(
    state.rawInput,
    state.intent!,
    actionResult,
    context,
  );

  return { response };
}

/**
 * Build a compact text summary of retrieved memory for use in the response generation prompt.
 * This lets the LLM answer questions like "what do you know about me?" accurately.
 */
function buildMemorySummary(state: AgentState): string {
  const mem = state.retrievedMemory;
  if (!mem) return '';

  const parts: string[] = [];

  if (mem.preferences.length > 0) {
    const list = mem.preferences.map(p => `• ${p.key}: ${p.value}`).join('\n');
    parts.push(`Preferences:\n${list}`);
  }

  if (mem.habits.length > 0) {
    const list = mem.habits.map(h => `• ${h.key}: ${(h as any).description ?? ''} ${h.timeRange?.start ? `(${h.timeRange.start}–${h.timeRange.end})` : ''}`).join('\n');
    parts.push(`Habits:\n${list}`);
  }

  if (mem.constraints.length > 0) {
    const list = mem.constraints.map(c => `• ${c.key}: ${c.timeRange?.start ?? ''}–${c.timeRange?.end ?? ''} ${c.days?.join(', ') ?? ''}`).join('\n');
    parts.push(`Fixed commitments:\n${list}`);
  }

  if (mem.recentHistory.length > 0) {
    const list = mem.recentHistory
      .slice(0, 5)
      .map(h => `• ${h.title} — ${h.outcome} on ${h.scheduledDate}`)
      .join('\n');
    parts.push(`Recent activity:\n${list}`);
  }

  if (mem.semanticContext.length > 0) {
    const list = mem.semanticContext.slice(0, 3).map(s => `• ${s.content}`).join('\n');
    parts.push(`Relevant context:\n${list}`);
  }

  return parts.join('\n\n');
}
