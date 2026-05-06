import { SemanticMemory } from './qdrant/semantic-memory.js';
import { getLLMProvider } from '../llm/openai-compatible.provider.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('conversation-memory');

export async function storeConversationTurn(input: {
  userId: string;
  telegramId: number;
  userText: string;
  assistantText: string;
}): Promise<void> {
  try {
    const llm = getLLMProvider();
    const semanticMemory = new SemanticMemory((text) => llm.getEmbedding(text));
    const content = `User: ${input.userText}\nMemora: ${input.assistantText}`;

    await semanticMemory.store({
      userId: input.userId,
      telegramId: input.telegramId,
      type: 'conversation',
      content,
      metadata: {
        userText: input.userText,
        assistantText: input.assistantText,
      },
      timestamp: new Date().toISOString(),
      confidence: 0.65,
    });
  } catch (error) {
    log.warn({ error }, 'Failed to persist conversation turn to semantic memory');
  }
}
