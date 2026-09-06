import type { Context } from 'grammy';
import { runAgent } from '../../agent/graph.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { appendHistory } from '../conversation-history.js';
import { storeConversationTurn } from '../../memory/conversation-memory.js';
import { sendReply } from './message.handler.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('handler:photo');

export function registerPhotoHandler(bot: any): void {
  bot.on('message:photo', async (ctx: Context) => {
    const from = ctx.from;
    if (!from || !ctx.message?.photo) return;

    log.info({ telegramId: from.id }, 'Received photo message');

    const user = await userRepo.createOrUpdate(from.id, {
      firstName: from.first_name,
      lastName: from.last_name,
      username: from.username,
    });

    try {
      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1]!;
      const file = await ctx.api.getFile(largestPhoto.file_id);
      if (!file.file_path) {
        await ctx.reply("I couldn't download that photo. Please try again.");
        return;
      }

      const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');

      const caption = ctx.message.caption ?? 'Extract any tasks, schedules or deadlines from this image and add them.';
      let inputText = caption;
      if (ctx.message?.reply_to_message?.text) {
        inputText = `[Replying to your message: "${ctx.message.reply_to_message.text.substring(0, 100)}"]\n${caption}`;
      }

      void ctx.replyWithChatAction('typing').catch(() => undefined);
      await appendHistory(from.id, 'user', `[Sent an image] ${inputText}`);

      const run = await runAgent({
        userId: String(user._id),
        telegramId: from.id,
        chatId: ctx.chat!.id,
        rawInput: inputText,
        imageBase64: base64,
        imageMimeType: 'image/jpeg',
      });

      const result = run.response;
      await appendHistory(from.id, 'assistant', result);
      if (run.memorable) {
        void storeConversationTurn({ userId: String(user._id), telegramId: from.id, userText: `[Image] ${inputText}`, assistantText: result });
      }
      await sendReply(ctx, result);
    } catch (error) {
      log.error({ error }, 'Photo processing error');
      await ctx.reply('Failed to process the photo. Please try again.');
    }
  });
}
