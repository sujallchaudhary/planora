import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../../config/env.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('qdrant');

let client: QdrantClient;

export function getQdrantClient(): QdrantClient {
  if (!client) {
    client = new QdrantClient({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY || undefined,
    });
  }
  return client;
}

export const MEMORY_COLLECTION = 'memory_vectors';

export async function initQdrantCollections(): Promise<void> {
  const qdrant = getQdrantClient();
  const requiredSize = env.EMBEDDING_DIMENSIONS;

  try {
    const collections = await qdrant.getCollections();
    const exists = collections.collections.some(c => c.name === MEMORY_COLLECTION);

    if (exists) {
      // Check if the existing collection has the right dimensions
      const info = await qdrant.getCollection(MEMORY_COLLECTION);
      const currentSize = (info.config?.params?.vectors as any)?.size;

      if (currentSize && currentSize !== requiredSize) {
        log.warn({ currentSize, requiredSize }, 'Vector dimension mismatch — recreating collection');
        await qdrant.deleteCollection(MEMORY_COLLECTION);
        await createCollection(qdrant, requiredSize);
      } else {
        log.info(`Qdrant collection already exists: ${MEMORY_COLLECTION} (dim=${currentSize})`);
      }
    } else {
      await createCollection(qdrant, requiredSize);
    }
  } catch (error) {
    log.error({ error }, 'Failed to initialize Qdrant collections');
    throw error;
  }
}

async function createCollection(qdrant: QdrantClient, size: number): Promise<void> {
  await qdrant.createCollection(MEMORY_COLLECTION, {
    vectors: {
      size,
      distance: 'Cosine',
    },
  });
  log.info({ size }, `Created Qdrant collection: ${MEMORY_COLLECTION}`);
}
