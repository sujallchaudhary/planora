/**
 * Pending action state per user.
 * When a callback button triggers a multi-step flow (like "Reschedule"),
 * we store the pending context here so the next text message handler
 * can inject it into the LLM pipeline.
 */

export interface PendingAction {
  type: 'reschedule';
  taskTitle: string;
  taskId?: string;
  entryId: string;
  createdAt: number;
}

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Map<telegramId, PendingAction>
const pending = new Map<number, PendingAction>();

export function setPendingAction(telegramId: number, action: Omit<PendingAction, 'createdAt'>): void {
  pending.set(telegramId, { ...action, createdAt: Date.now() });
}

export function getPendingAction(telegramId: number): PendingAction | null {
  const action = pending.get(telegramId);
  if (!action) return null;

  // Expire after TTL
  if (Date.now() - action.createdAt > PENDING_TTL_MS) {
    pending.delete(telegramId);
    return null;
  }

  return action;
}

export function clearPendingAction(telegramId: number): void {
  pending.delete(telegramId);
}
