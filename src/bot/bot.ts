import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { registerCommandHandlers } from './handlers/command.handler.js';
import { registerMessageHandler } from './handlers/message.handler.js';
import { registerPhotoHandler } from './handlers/photo.handler.js';
import { registerCallbackHandler } from './handlers/callback.handler.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('bot');

let bot: Bot | null = null;

export function createBot(): Bot {
  bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Error handling
  bot.catch((err) => {
    log.error({ err: err.message }, 'Bot error');
  });

  // Register handlers (order matters!)
  registerCallbackHandler(bot);
  registerCommandHandlers(bot);
  registerPhotoHandler(bot);
  registerMessageHandler(bot);

  log.info('Bot handlers registered');
  return bot;
}

export function getBotInstance(): Bot {
  if (!bot) {
    throw new Error('Bot not initialized. Call createBot() first.');
  }
  return bot;
}

export async function startBot(): Promise<void> {
  const b = getBotInstance();

  // Register command list with Telegram (shows in the "/" menu)
  await b.api.setMyCommands([
    { command: 'start',    description: 'Register and get started' },
    { command: 'tasks',    description: 'View all your pending tasks' },
    { command: 'plan',     description: 'Generate today\'s schedule' },
    { command: 'schedule', description: 'View schedule with action buttons' },
    { command: 'status',   description: 'See today\'s progress' },
    { command: 'clear',    description: 'Clear today\'s schedule' },
    { command: 'help',     description: 'Show all commands and usage' },
  ]);

  if (env.TELEGRAM_WEBHOOK_URL) {
    // Webhook mode — handled by Fastify route
    await b.api.setWebhook(env.TELEGRAM_WEBHOOK_URL, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET || undefined,
    });
    log.info({ url: env.TELEGRAM_WEBHOOK_URL }, 'Webhook set');
  } else {
    // Polling mode for development
    await b.api.deleteWebhook();
    b.start({
      onStart: () => log.info('Bot started (polling mode)'),
    });
  }
}

export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stop();
    log.info('Bot stopped');
  }
}
