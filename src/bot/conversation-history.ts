/**
 * Conversation history per user, kept in Redis so it survives restarts and
 * works across multiple bot instances. Holds the last N turns for LLM context.
 */
import { getRedisConnection } from '../execution/queue.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('conversation-history');

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_HISTORY = 8;          // 4 user + 4 assistant turns
const MAX_CONTENT_CHARS = 1500; // keep prompts small
const TTL_SECONDS = 12 * 3600;

const key = (telegramId: number) => `memora:conv:${telegramId}`;

export async function appendHistory(telegramId: number, role: 'user' | 'assistant', content: string): Promise<void> {
  try {
    const redis = getRedisConnection();
    const msg: ChatMessage = { role, content: content.slice(0, MAX_CONTENT_CHARS) };
    await redis.rpush(key(telegramId), JSON.stringify(msg));
    await redis.ltrim(key(telegramId), -MAX_HISTORY, -1);
    await redis.expire(key(telegramId), TTL_SECONDS);
  } catch (err) {
    log.warn({ err }, 'Failed to append conversation history');
  }
}

export async function getHistory(telegramId: number): Promise<ChatMessage[]> {
  try {
    const raw = await getRedisConnection().lrange(key(telegramId), 0, -1);
    return raw.map(r => JSON.parse(r) as ChatMessage);
  } catch (err) {
    log.warn({ err }, 'Failed to read conversation history');
    return [];
  }
}

export async function clearHistory(telegramId: number): Promise<void> {
  await getRedisConnection().del(key(telegramId)).catch(() => undefined);
}
