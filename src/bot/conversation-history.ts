/**
 * Lightweight in-memory conversation history per user.
 * Stores the last N message pairs so the LLM has context for follow-up messages.
 * Resets on server restart (acceptable for a personal assistant).
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_HISTORY = 16; // 8 user + 8 assistant turns

// Map<telegramId, messages>
const store = new Map<number, ChatMessage[]>();

export function appendHistory(telegramId: number, role: 'user' | 'assistant', content: string): void {
  if (!store.has(telegramId)) {
    store.set(telegramId, []);
  }
  const history = store.get(telegramId)!;
  history.push({ role, content });

  // Keep only last MAX_HISTORY messages
  if (history.length > MAX_HISTORY) {
    store.set(telegramId, history.slice(-MAX_HISTORY));
  }
}

export function getHistory(telegramId: number): ChatMessage[] {
  return store.get(telegramId) ?? [];
}

export function clearHistory(telegramId: number): void {
  store.delete(telegramId);
}
