import type { FastifyInstance } from 'fastify';
import { webhookCallback } from 'grammy';
import { getBotInstance } from '../../bot/bot.js';
import { env } from '../../config/env.js';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  if (!env.TELEGRAM_WEBHOOK_URL) return;

  const bot = getBotInstance();
  const handleWebhook = webhookCallback(bot, 'fastify');

  app.post('/telegram/webhook', async (request, reply) => {
    // Verify secret token if configured
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const token = request.headers['x-telegram-bot-api-secret-token'];
      if (token !== env.TELEGRAM_WEBHOOK_SECRET) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    }
    await handleWebhook(request, reply);
  });
}
