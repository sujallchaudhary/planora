import type { EmbeddingBackend } from '../types.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('llm:local-embeddings');

/**
 * In-process embeddings with Transformers.js (ONNX runtime). Zero API calls, ~5-10 ms per
 * text after a one-time model load (~30 MB download for bge-small, cached on disk).
 * The library is imported lazily so deployments that don't use it never load ONNX.
 */
export class LocalEmbeddingBackend implements EmbeddingBackend {
  readonly name = 'local';
  private extractor: Promise<any> | null = null;

  constructor(private model: string, readonly dimensions: number, private cacheDir: string) {}

  private load(): Promise<any> {
    if (!this.extractor) {
      this.extractor = (async () => {
        const t0 = Date.now();
        // Variable specifier: the package is optional, so neither tsc nor the bundle must resolve it.
        const moduleName = '@huggingface/transformers';
        let tf: any;
        try {
          tf = await import(moduleName);
        } catch (err: any) {
          throw new Error(`EMBEDDING_PROVIDER=local needs @huggingface/transformers installed (npm install --include=optional, or build the image with WITH_LOCAL_EMBEDDINGS=true): ${err?.message ?? err}`);
        }
        tf.env.cacheDir = this.cacheDir;
        const pipe = await tf.pipeline('feature-extraction', this.model, { dtype: 'fp32' });
        log.info({ model: this.model, ms: Date.now() - t0 }, 'Local embedding model loaded');
        return pipe;
      })().catch(err => {
        this.extractor = null;
        throw err;
      });
    }
    return this.extractor;
  }

  async warmup(): Promise<void> {
    await this.load();
  }

  async embed(text: string): Promise<number[]> {
    const extractor = await this.load();
    const output = await extractor(text.slice(0, 2000), { pooling: 'cls', normalize: true });
    const vector = Array.from(output.data as Float32Array);
    if (vector.length !== this.dimensions) {
      throw new Error(`Local embedding produced ${vector.length} dims, expected ${this.dimensions} (check LOCAL_EMBEDDING_DIMENSIONS)`);
    }
    return vector;
  }
}
