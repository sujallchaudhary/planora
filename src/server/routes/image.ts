import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { extractImageContent } from '../../llm/ai-provider.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('route:image');

export async function imageRoutes(app: FastifyInstance): Promise<void> {
  // Register multipart support
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

  app.post('/api/image', async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'No image file provided' });
      }

      const buffer = await data.toBuffer();
      const base64 = buffer.toString('base64');
      const mimeType = data.mimetype || 'image/jpeg';

      log.info({ mimeType, size: buffer.length }, 'Processing image');

      const result = await extractImageContent(base64, mimeType);

      return reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      log.error({ error }, 'Image processing failed');
      return reply.status(500).send({ error: 'Failed to process image' });
    }
  });
}
