import { InlineKeyboard } from 'grammy';

export function buildTaskKeyboard(entryId: string, snoozeMinutes: number): InlineKeyboard {
  // grammY does not allow ":" in callback_data — use "|" as separator
  return new InlineKeyboard()
    .text('✅ Done', `task|done|${entryId}`)
    .text('⏭ Skip', `task|skip|${entryId}`)
    .row()
    .text(`⏰ Snooze ${snoozeMinutes}m`, `task|snooze|${entryId}`)
    .text('📅 Reschedule', `task|reschedule|${entryId}`);
}
