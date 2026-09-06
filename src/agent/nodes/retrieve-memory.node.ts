import type { AgentState } from '../state.js';
import { EMPTY_MEMORY } from '../../memory/hybrid-retriever.js';
import { getRetriever } from '../../scheduler/replan-service.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { todayString } from '../../utils/date.js';
import { IntentType } from '../../config/defaults.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('node:retrieve-memory');

export async function retrieveMemoryNode(state: AgentState): Promise<Partial<AgentState>> {
  if (state.intent?.classificationError) return { retrievedMemory: EMPTY_MEMORY };

  const user = await userRepo.findByTelegramId(state.telegramId);
  const config = resolveUserConfig(user?.settings);

  // Vector context only feeds the conversational reply. Routine actions (done/skip/show)
  // get templated replies, so skip the embedding call for them.
  const intent = state.intent;
  const needsSemantic = !!intent && (
    intent.intent === IntentType.GENERAL_CHAT
    || intent.intent === IntentType.IMAGE_CONTEXT
    || intent.intent === IntentType.REMOVE_MEMORY
    || intent.memorySignals.length > 0
    || !!intent.userState?.energy
    || !!intent.userState?.mood
  ) && !intent.reasoning?.startsWith('fast:');

  try {
    const memory = await getRetriever().retrieve(state.telegramId, state.rawInput, config.memoryConfidenceThreshold, {
      asOfDate: todayString(config.timezone),
      skipSemantic: !needsSemantic,
    });
    return { retrievedMemory: memory };
  } catch (error) {
    log.error({ error }, 'Failed to retrieve memory, continuing without it');
    return { retrievedMemory: EMPTY_MEMORY };
  }
}
