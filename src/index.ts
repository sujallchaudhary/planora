import { env } from './config/env.js';
import { connectMongoDB, disconnectMongoDB } from './memory/mongo/connection.js';
import { initQdrantCollections } from './memory/qdrant/client.js';
import { createBot, startBot, stopBot } from './bot/bot.js';
import { createServer, startServer } from './server/fastify.js';
import { startReminderWorker } from './execution/workers/reminder.worker.js';
import { startDailyPlanWorker, scheduleDailyPlans } from './execution/workers/daily-plan.worker.js';
import { startAnalyticsWorker, scheduleAnalytics } from './execution/workers/analytics.worker.js';
import { closeQueues } from './execution/queue.js';
import { logger } from './utils/logger.js';

async function main() {
  logger.info('🚀 Starting Telegram Personal Assistant...');
  logger.info({ nodeEnv: env.NODE_ENV, port: env.PORT }, 'Configuration loaded');

  // Step 1: Connect to MongoDB
  await connectMongoDB();

  // Step 2: Initialize Qdrant collections
  try {
    await initQdrantCollections();
  } catch (err) {
    logger.warn({ err }, 'Qdrant initialization failed — semantic memory will be unavailable');
  }

  // Step 3: Create Telegram bot
  createBot();

  // Step 4: Start BullMQ workers
  const reminderWorker = startReminderWorker();
  const dailyPlanWorker = startDailyPlanWorker();
  const analyticsWorker = startAnalyticsWorker();

  // Step 5: Create and start Fastify server
  const server = await createServer();
  await startServer(server);

  // Step 6: Start Telegram bot (polling or webhook)
  try {
    await startBot();
  } catch (err) {
    logger.warn({ err }, 'Webhook registration failed — falling back to polling mode. Fix DNS and restart to enable webhook.');
    // Fall back to polling so the bot stays alive
    const { getBotInstance } = await import('./bot/bot.js');
    const b = getBotInstance();
    await b.api.deleteWebhook();
    b.start({ onStart: () => logger.info('Bot started (polling fallback)') });
  }


  // Step 7: Schedule periodic jobs
  try {
    await scheduleDailyPlans();
    await scheduleAnalytics();
  } catch (err) {
    logger.warn({ err }, 'Failed to schedule periodic jobs — will retry on next user interaction');
  }

  logger.info('✅ All systems operational');

  // ─── Graceful Shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');

    await stopBot();
    await server.close();
    await reminderWorker.close();
    await dailyPlanWorker.close();
    await analyticsWorker.close();
    await closeQueues();
    await disconnectMongoDB();

    logger.info('👋 Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
