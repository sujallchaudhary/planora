import Fastify from 'fastify';
import { env } from '../config/env.js';
import { healthRoutes } from './routes/health.js';
import { webhookRoutes } from './routes/webhook.js';
import { imageRoutes } from './routes/image.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('server');

export async function createServer() {
  const app = Fastify({
    logger: false, // We use our own Pino logger
  });

  // Register routes
  await app.register(healthRoutes);
  await app.register(webhookRoutes);
  await app.register(imageRoutes);

  return app;
}

export async function startServer(app: Awaited<ReturnType<typeof createServer>>): Promise<void> {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    log.info({ port: env.PORT }, 'Server started');
  } catch (err) {
    log.error({ err }, 'Failed to start server');
    throw err;
  }
}
