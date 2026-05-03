import { v4 as uuidv4 } from 'uuid';
import { getQdrantClient, MEMORY_COLLECTION } from './client.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('semantic-memory');

export interface SemanticMemoryEntry {
  id?: string;
  userId: string;
  telegramId: number;
  type: string;  // preference, habit, behavior, day_pattern
  content: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  confidence: number;
}

export interface SemanticMatch {
  content: string;
  type: string;
  confidence: number;
  score: number;
  metadata: Record<string, unknown>;
}

export class SemanticMemory {
  private getEmbedding: (text: string) => Promise<number[]>;

  constructor(embeddingFn: (text: string) => Promise<number[]>) {
    this.getEmbedding = embeddingFn;
  }

  async store(entry: SemanticMemoryEntry): Promise<string> {
    const qdrant = getQdrantClient();
    const id = entry.id ?? uuidv4();
    const vector = await this.getEmbedding(entry.content);

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

  async search(telegramId: number, query: string, limit: number = 5): Promise<SemanticMatch[]> {
    const qdrant = getQdrantClient();
    const queryVector = await this.getEmbedding(query);

    const results = await qdrant.search(MEMORY_COLLECTION, {
      vector: queryVector,
      limit,
      filter: {
        must: [
          {
            key: 'telegramId',
            match: { value: telegramId },
          },
        ],
      },
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
    const qdrant = getQdrantClient();
    const queryVector = await this.getEmbedding(query);

    const results = await qdrant.search(MEMORY_COLLECTION, {
      vector: queryVector,
      limit,
      filter: {
        must: [
          { key: 'telegramId', match: { value: telegramId } },
          { key: 'type', match: { value: type } },
        ],
      },
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
}
