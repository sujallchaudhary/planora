import type { Context } from 'grammy';
import { runAgent } from '../../agent/graph.js';
import { userRepo } from '../../memory/mongo/repositories/user.repo.js';
import { appendHistory } from '../conversation-history.js';
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
      // Get the largest photo
      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1]!;
      const file = await ctx.api.getFile(largestPhoto.file_id);

      if (!file.file_path) {
        await ctx.reply('❌ Couldn\'t download the photo. Please try again.');
        return;
      }

      // Download file content
      const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');

      const caption = ctx.message.caption ?? 'Extract content from this image and help me plan.';
      
      let inputText = caption;
      if (ctx.message?.reply_to_message && ctx.message.reply_to_message.text) {
        inputText = `[Replying to your message: "${ctx.message.reply_to_message.text.substring(0, 100)}..."]\n${caption}`;
      }

      await ctx.reply('📸 Analyzing your image...');

      // Save user message to history BEFORE running agent
      appendHistory(from.id, 'user', `[Sent an image] ${inputText}`);

      const result = await runAgent({
        userId: user._id.toString(),
        telegramId: from.id,
        chatId: ctx.chat!.id,
        rawInput: inputText,
        imageBase64: base64,
        imageMimeType: 'image/jpeg',
      });

      // Save bot response so next message has full context
      appendHistory(from.id, 'assistant', result);

      await ctx.reply(result, { parse_mode: 'Markdown' }).catch(() => ctx.reply(result));
    } catch (error) {
      log.error({ error }, 'Photo processing error');
      await ctx.reply('😅 Failed to process the photo. Please try again.');
    }
  });
}
