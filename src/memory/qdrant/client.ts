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

    // Ensure payload indexes exist (Qdrant Cloud requires these for filtered search)
    await ensurePayloadIndexes(qdrant);
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

/**
 * Create payload indexes for fields used in filters.
 * Qdrant Cloud enforces this; local Qdrant allows unindexed filter fields.
 * createPayloadIndex is idempotent — safe to call on every startup.
 */
async function ensurePayloadIndexes(qdrant: QdrantClient): Promise<void> {
  const indexes: Array<{ field: string; schema: any }> = [
    { field: 'telegramId', schema: { type: 'integer', lookup: true } },
    { field: 'type',       schema: { type: 'keyword' } },
    { field: 'userId',     schema: { type: 'keyword' } },
  ];

  for (const { field, schema } of indexes) {
    try {
      await qdrant.createPayloadIndex(MEMORY_COLLECTION, {
        field_name: field,
        field_schema: schema,
      });
      log.debug({ field }, 'Payload index ensured');
    } catch (err: any) {
      // "already exists" is fine — ignore it
      if (!err?.message?.includes('already exists')) {
        log.warn({ field, err: err?.message }, 'Could not create payload index');
      }
    }
  }
  log.info('Qdrant payload indexes ready');
}
