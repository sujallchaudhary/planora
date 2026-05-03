import type { AgentState } from '../state.js';
import { HybridRetriever } from '../../memory/hybrid-retriever.js';
import { SemanticMemory } from '../../memory/qdrant/semantic-memory.js';
import { getLLMProvider } from '../../llm/openai-compatible.provider.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { resolveUserConfig } from '../../config/config-resolver.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('node:retrieve-memory');

let retriever: HybridRetriever | null = null;

function getRetriever(): HybridRetriever {
  if (!retriever) {
    const llm = getLLMProvider();
    const semanticMemory = new SemanticMemory((text) => llm.getEmbedding(text));
    retriever = new HybridRetriever(semanticMemory);
  }
  return retriever;
}

export async function retrieveMemoryNode(state: AgentState): Promise<Partial<AgentState>> {
  log.debug({ telegramId: state.telegramId }, 'Retrieving memory');

  const user = await userRepo.findByTelegramId(state.telegramId);
  const config = resolveUserConfig(user?.settings);

  try {
    const memory = await getRetriever().retrieve(
      state.telegramId,
      state.rawInput,
      config.memoryConfidenceThreshold,
    );
    return { retrievedMemory: memory };
  } catch (error) {
    log.error({ error }, 'Failed to retrieve memory, continuing without it');
    return {
      retrievedMemory: {
        preferences: [],
        habits: [],
        constraints: [],
        semanticContext: [],
        recentHistory: [],
      },
    };
  }
}
