import type { AgentState } from '../state.js';
import { detectAutonomyContext, EMPTY_AUTONOMY_CONTEXT } from '../autonomy-context.js';
import { IntentType } from '../../config/defaults.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { SemanticMemory } from '../../memory/qdrant/semantic-memory.js';
import { getLLMProvider } from '../../llm/index.js';
import { parseTimeString, todayString, isValidDateString, normalizeTimeString, dateStringToDate } from '../../utils/date.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('node:analyze-context');

export async function analyzeContextNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.intent || state.intent.classificationError) return { autonomyContext: EMPTY_AUTONOMY_CONTEXT };

  const user = await userRepo.findByTelegramId(state.telegramId);
  const config = resolveUserConfig(user?.settings);
  const today = todayString(config.timezone);

  const resolveUntil = (value: string): Date | undefined => {
    if (isValidDateString(value)) return dateStringToDate(value, config.timezone);
    const t = normalizeTimeString(value);
    return t ? parseTimeString(t, today, config.timezone) : undefined;
  };

  const explicitReplan = state.intent.intent === IntentType.REPLAN
    || state.intent.secondaryIntents.some(s => s.intent === IntentType.REPLAN);
  const autonomyContext = detectAutonomyContext(state.rawInput, explicitReplan, state.intent.userState, resolveUntil);

  if (autonomyContext.signals.length === 0 && !autonomyContext.shouldReplan) {
    return { autonomyContext: EMPTY_AUTONOMY_CONTEXT };
  }

  if (user && autonomyContext.signals.length > 0) {
    try {
      const llm = getLLMProvider();
      const semanticMemory = new SemanticMemory((text) => llm.getEmbedding(text));
      await semanticMemory.store({
        userId: String(user._id),
        telegramId: state.telegramId,
        type: 'context_event',
        content: `${today}: ${autonomyContext.summary || state.rawInput}`,
        metadata: {
          rawInput: state.rawInput.slice(0, 500),
          shouldReplan: autonomyContext.shouldReplan,
          signals: autonomyContext.signals,
        },
        timestamp: new Date().toISOString(),
        confidence: autonomyContext.confidence || 0.7,
      });
    } catch (error) {
      log.warn({ error }, 'Failed to store autonomous context event');
    }
  }

  log.info({ telegramId: state.telegramId, shouldReplan: autonomyContext.shouldReplan, signals: autonomyContext.signals.map(s => s.type) }, 'Autonomous context analyzed');
  return { autonomyContext };
}
