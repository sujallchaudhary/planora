export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * System prompts are split so backends with prefix caching (Anthropic) can cache the
 * stable part. Keep anything that changes per request (time, task list) in `dynamic`.
 */
export interface SystemPrompt {
  stable: string;
  dynamic?: string;
}

export interface ChatRequest {
  /** For logging and per-call tuning. */
  label: 'classify' | 'respond' | 'blueprint';
  /** 'reasoning' picks the stronger model; 'chat' the faster one (same model by default). */
  tier: 'chat' | 'reasoning';
  system: SystemPrompt;
  messages: ChatTurn[];
  maxTokens: number;
  /** Only honoured by backends that accept sampling params. */
  temperature?: number;
  /** Ask for JSON (json_object mode / stricter instruction). The caller still parses defensively. */
  json?: boolean;
}

export interface ChatBackend {
  readonly name: string;
  complete(request: ChatRequest): Promise<string>;
  describeImage(prompt: string, imageBase64: string, mimeType: string, maxTokens: number): Promise<string>;
}

export interface EmbeddingBackend {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  /** Optional eager initialisation (model download / load). */
  warmup?(): Promise<void>;
}

export function joinSystemPrompt(system: SystemPrompt): string {
  return system.dynamic ? `${system.stable}\n\n${system.dynamic}` : system.stable;
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Retry transient HTTP failures with linear backoff. Works for any SDK error carrying `.status`. */
export async function withRetry<T>(label: string, fn: () => Promise<T>, maxRetries = 2, onRetry?: (status: number, attempt: number) => void): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastErr = error;
      const status: number | undefined = error?.status ?? error?.response?.status;
      if (!status || !RETRYABLE.has(status) || attempt === maxRetries) throw error;
      onRetry?.(status, attempt + 1);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}
