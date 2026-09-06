import type { Context } from 'grammy';
import { runAgent } from '../../agent/graph.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { appendHistory } from '../conversation-history.js';
import { getPendingAction, clearPendingAction } from '../pending-action.js';
import { storeConversationTurn } from '../../memory/conversation-memory.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('handler:message');

export async function sendReply(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/[*_\\]/g, ''));
  }
}

export function registerMessageHandler(bot: any): void {
  bot.on('message:text', async (ctx: Context) => {
    const from = ctx.from;
    const text = ctx.message?.text;
    if (!from || !text) return;
    if (text.startsWith('/')) return; // commands are handled elsewhere

    log.info({ telegramId: from.id, text: text.substring(0, 50) }, 'Received text message');

    let inputText = text;
    if (ctx.message?.reply_to_message?.text) {
      inputText = `[Replying to your message: "${ctx.message.reply_to_message.text.substring(0, 100)}"]\n${text}`;
    }

    const pending = await getPendingAction(from.id).catch(() => null);
    if (pending) {
      if (pending.type === 'reschedule') {
        inputText = `[Context: user is answering your prompt to reschedule task "${pending.taskTitle}" — classify as MODIFY_TASK with taskReference "${pending.taskTitle}" and put the new time/date in tasks[0]]\n${inputText}`;
      } else if (pending.type === 'clarify_task') {
        inputText = `[Context: you asked which task they meant; candidates: ${(pending.candidates ?? []).join(' | ')}. Set taskReference to the matching candidate and keep the intent you were about to perform]\n${inputText}`;
      }
      await clearPendingAction(from.id).catch(() => undefined);
    }

    const user = await userRepo.createOrUpdate(from.id, {
      firstName: from.first_name,
      lastName: from.last_name,
      username: from.username,
    });

    await appendHistory(from.id, 'user', inputText);
    void ctx.replyWithChatAction('typing').catch(() => undefined);

    try {
      const run = await runAgent({
        userId: String(user._id),
        telegramId: from.id,
        chatId: ctx.chat!.id,
        rawInput: inputText,
      });

      const response = run.response;
      await appendHistory(from.id, 'assistant', response);
      if (run.memorable) {
        void storeConversationTurn({ userId: String(user._id), telegramId: from.id, userText: inputText, assistantText: response });
      }
      await sendReply(ctx, response);
    } catch (error) {
      log.error({ error, telegramId: from.id }, 'Agent pipeline error');
      await ctx.reply('Something broke on my side while handling that. Try again in a moment — nothing was changed.');
    }

    await userRepo.updateLastInteraction(from.id);
  });
}
