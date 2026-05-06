import type { AgentState } from '../state.js';
import { detectAutonomyContext, EMPTY_AUTONOMY_CONTEXT } from '../autonomy-context.js';
import { IntentType } from '../../config/defaults.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { SemanticMemory } from '../../memory/qdrant/semantic-memory.js';
import { getLLMProvider } from '../../llm/openai-compatible.provider.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('node:analyze-context');

export async function analyzeContextNode(state: AgentState): Promise<Partial<AgentState>> {
  const explicitReplan = state.intent?.intent === IntentType.REPLAN;
  const autonomyContext = detectAutonomyContext(state.rawInput, explicitReplan);

  if (autonomyContext.signals.length === 0 && !autonomyContext.shouldReplan) {
    return { autonomyContext: EMPTY_AUTONOMY_CONTEXT };
  }

  const user = await userRepo.findByTelegramId(state.telegramId);
  if (!user) {
    return { autonomyContext };
  }

  try {
    const llm = getLLMProvider();
    const semanticMemory = new SemanticMemory((text) => llm.getEmbedding(text));
    await semanticMemory.store({
      userId: user._id.toString(),
      telegramId: state.telegramId,
      type: 'context_event',
      content: autonomyContext.summary || state.rawInput,
      metadata: {
        rawInput: state.rawInput,
        shouldReplan: autonomyContext.shouldReplan,
        signals: autonomyContext.signals,
        planningContext: autonomyContext.planningContext,
      },
      timestamp: new Date().toISOString(),
      confidence: autonomyContext.confidence || 0.7,
    });
  } catch (error) {
    log.warn({ error }, 'Failed to store autonomous context event');
  }

  log.info({
    telegramId: state.telegramId,
    shouldReplan: autonomyContext.shouldReplan,
    signals: autonomyContext.signals.map(s => s.type),
  }, 'Autonomous context analyzed');

  return { autonomyContext };
}
