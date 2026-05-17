import { env } from '../config/env.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('mem0-memory');

const MEM0_BASE = 'https://api.mem0.ai/v1';

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Token ${env.MEM0_API_KEY}`,
});

/**
 * Store a conversation turn in Mem0 for automatic memory extraction.
 */
export async function addConversationMemory(
  messages: Array<{ role: string; content: string }>,
  userId: string,
): Promise<void> {
  try {
    const res = await fetch(`${MEM0_BASE}/memories/`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ messages, user_id: userId }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    log.debug({ userId, messageCount: messages.length }, 'Stored conversation in Mem0');
  } catch (error) {
    log.warn({ error, userId }, 'Failed to store conversation in Mem0');
  }
}

/**
 * Search Mem0 for memories relevant to the current query.
 */
export async function searchMemory(
  query: string,
  userId: string,
  limit = 10,
): Promise<string[]> {
  try {
    const res = await fetch(`${MEM0_BASE}/memories/search/`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ query, user_id: userId, limit }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const results = (await res.json()) as any[];
    const memories = results.map((r: any) => r.memory ?? r.content ?? r.text ?? String(r));
    log.debug({ userId, resultCount: memories.length }, 'Searched Mem0 memories');
    return memories;
  } catch (error) {
    log.warn({ error, userId }, 'Failed to search Mem0 memories');
    return [];
  }
}

/**
 * Get all stored memories for a user.
 */
export async function getAllMemories(userId: string): Promise<string[]> {
  try {
    const res = await fetch(`${MEM0_BASE}/memories/?user_id=${encodeURIComponent(userId)}`, {
      method: 'GET',
      headers: headers(),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const results = (await res.json()) as any[];
    return results.map((r: any) => r.memory ?? r.content ?? r.text ?? String(r));
  } catch (error) {
    log.warn({ error, userId }, 'Failed to get Mem0 memories');
    return [];
  }
}

/**
 * Store a specific fact/insight as a memory.
 */
export async function storeInsight(
  content: string,
  userId: string,
): Promise<void> {
  try {
    const res = await fetch(`${MEM0_BASE}/memories/`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ messages: [{ role: 'system', content }], user_id: userId }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  } catch (error) {
    log.warn({ error, userId }, 'Failed to store insight in Mem0');
  }
}
