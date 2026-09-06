import { v4 as uuidv4 } from 'uuid';
import { getQdrantClient, MEMORY_COLLECTION } from './client.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('semantic-memory');

export interface SemanticMemoryEntry {
  id?: string;
  userId: string;
  telegramId: number;
  type: string;  // preference, habit, constraint, conversation, context_event, behavior, day_pattern
  content: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  confidence: number;
  /** Embed this instead of `content` (lets callers reuse an already-computed embedding). */
  embedText?: string;
}

export interface SemanticMatch {
  content: string;
  type: string;
  confidence: number;
  score: number;
  metadata: Record<string, unknown>;
}

export interface SemanticSearchOptions {
  /** Only return these types */
  types?: string[];
  /** Never return these types */
  excludeTypes?: string[];
}

export class SemanticMemory {
  private getEmbedding: (text: string) => Promise<number[]>;

  constructor(embeddingFn: (text: string) => Promise<number[]>) {
    this.getEmbedding = embeddingFn;
  }

  async store(entry: SemanticMemoryEntry): Promise<string> {
    const qdrant = getQdrantClient();
    const id = entry.id ?? uuidv4();
    const vector = await this.getEmbedding(entry.embedText ?? entry.content);

    await qdrant.upsert(MEMORY_COLLECTION, {
      wait: true,
      points: [
        {
          id,
          vector,
          payload: {
            userId: entry.userId,
            telegramId: entry.telegramId,
            type: entry.type,
            content: entry.content,
            metadata: entry.metadata,
            timestamp: entry.timestamp,
            confidence: entry.confidence,
          },
        },
      ],
    });

    log.debug({ id, type: entry.type }, 'Stored semantic memory');
    return id;
  }

  async search(telegramId: number, query: string, limit: number = 5, options: SemanticSearchOptions = {}): Promise<SemanticMatch[]> {
    const queryVector = await this.getEmbedding(query);
    return this.searchByVector(telegramId, queryVector, limit, options);
  }

  /** Search with a precomputed vector — one embedding can serve several filtered searches. */
  async searchByVector(telegramId: number, queryVector: number[], limit: number = 5, options: SemanticSearchOptions = {}): Promise<SemanticMatch[]> {
    const qdrant = getQdrantClient();

    const must: Array<Record<string, unknown>> = [{ key: 'telegramId', match: { value: telegramId } }];
    if (options.types && options.types.length > 0) {
      must.push({ key: 'type', match: { any: options.types } });
    }
    const must_not: Array<Record<string, unknown>> = [];
    if (options.excludeTypes && options.excludeTypes.length > 0) {
      must_not.push({ key: 'type', match: { any: options.excludeTypes } });
    }

    const results = await qdrant.search(MEMORY_COLLECTION, {
      vector: queryVector,
      limit,
      filter: { must, ...(must_not.length > 0 ? { must_not } : {}) } as any,
      with_payload: true,
    });

    return results.map(r => ({
      content: (r.payload?.content as string) ?? '',
      type: (r.payload?.type as string) ?? '',
      confidence: (r.payload?.confidence as number) ?? 0,
      score: r.score,
      metadata: (r.payload?.metadata as Record<string, unknown>) ?? {},
    }));
  }

  async searchByType(telegramId: number, query: string, type: string, limit: number = 5): Promise<SemanticMatch[]> {
    return this.search(telegramId, query, limit, { types: [type] });
  }

  embed(text: string): Promise<number[]> {
    return this.getEmbedding(text);
  }

  /** Delete memories of a given type whose metadata.key matches (used when the user retracts a habit/constraint). */
  async deleteByKey(telegramId: number, key: string): Promise<void> {
    const qdrant = getQdrantClient();
    await qdrant.delete(MEMORY_COLLECTION, {
      wait: true,
      filter: {
        must: [
          { key: 'telegramId', match: { value: telegramId } },
          { key: 'metadata.key', match: { value: key } },
        ],
      },
    });
  }
}
