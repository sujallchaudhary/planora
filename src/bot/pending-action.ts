/**
 * Pending multi-step actions per user (e.g. "Reschedule" button → next message is the answer).
 * Stored in Redis with a TTL so it survives restarts.
 */
import { getRedisConnection } from '../execution/queue.js';

export interface PendingAction {
  type: 'reschedule' | 'clarify_task';
  taskTitle?: string;
  taskId?: string;
  entryId?: string;
  /** Candidate task titles when asking "which one?" */
  candidates?: string[];
  createdAt: number;
}

const TTL_SECONDS = 5 * 60;
const key = (telegramId: number) => `memora:pending:${telegramId}`;

export async function setPendingAction(telegramId: number, action: Omit<PendingAction, 'createdAt'>): Promise<void> {
  await getRedisConnection().set(key(telegramId), JSON.stringify({ ...action, createdAt: Date.now() }), 'EX', TTL_SECONDS);
}

export async function getPendingAction(telegramId: number): Promise<PendingAction | null> {
  const raw = await getRedisConnection().get(key(telegramId));
  return raw ? (JSON.parse(raw) as PendingAction) : null;
}

export async function clearPendingAction(telegramId: number): Promise<void> {
  await getRedisConnection().del(key(telegramId));
}
