import type { Context } from 'grammy';
import { runAgent } from '../../agent/graph.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { appendHistory } from '../conversation-history.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('handler:message');

export function registerMessageHandler(bot: any): void {
  bot.on('message:text', async (ctx: Context) => {
    const from = ctx.from;
    const text = ctx.message?.text;
    if (!from || !text) return;

    // Skip commands (handled by command handler)
    if (text.startsWith('/')) return;

    log.info({ telegramId: from.id, text: text.substring(0, 50) }, 'Received text message');

    // Ensure user exists
    const user = await userRepo.createOrUpdate(from.id, {
      firstName: from.first_name,
      lastName: from.last_name,
      username: from.username,
    });

    // Save user message to history BEFORE running agent (so it's available to classify)
    appendHistory(from.id, 'user', text);

    try {
      const response = await runAgent({
        userId: user._id.toString(),
        telegramId: from.id,
        chatId: ctx.chat!.id,
        rawInput: text,
      });

      // Save bot response so next message has full context
      appendHistory(from.id, 'assistant', response);

      await ctx.reply(response, { parse_mode: 'Markdown' }).catch(() => {
        return ctx.reply(response);
      });
    } catch (error) {
      log.error({ error, telegramId: from.id }, 'Agent pipeline error');
      await ctx.reply('😅 Something went wrong processing your message. Please try again.');
    }

    await userRepo.updateLastInteraction(from.id);
  });
}
