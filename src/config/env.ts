import { config } from 'dotenv';
import { z } from 'zod';

config();

const bool = (def: 'true' | 'false') => z.enum(['true', 'false']).default(def).transform(v => v === 'true');

const envSchema = z.object({
  // ── Provider selection ──────────────────────────────────────────────────────
  /** Which backend answers chat/classification/planning prompts. */
  LLM_PROVIDER: z.enum(['openai', 'anthropic']).default('openai'),
  /** Which backend reads images. Defaults to LLM_PROVIDER. */
  VISION_PROVIDER: z.enum(['openai', 'anthropic']).optional(),
  /** 'local' runs an open-source embedding model in-process (no API calls). */
  EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('openai'),

  // ── OpenAI-compatible (SambaNova, Groq, Ollama, OpenAI, ...) ───────────────
  LLM_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_CHAT_MODEL: z.string().default('MiniMax-M2.7'),
  LLM_REASONING_MODEL: z.string().default('MiniMax-M2.7'),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  LLM_MAX_TOKENS: z.coerce.number().positive().default(2048),
  /** Send response_format=json_object for JSON prompts (not every OpenAI-compatible host supports it). */
  LLM_JSON_MODE: bool('false'),

  VISION_BASE_URL: z.string().url().optional(),
  VISION_API_KEY: z.string().optional(),
  LLM_VISION_MODEL: z.string().default('gpt-4o'),

  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  LLM_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().positive().default(1536),

  // ── Anthropic ───────────────────────────────────────────────────────────────
  /** Optional: the SDK also resolves ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile. */
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_CHAT_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_REASONING_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_VISION_MODEL: z.string().default('claude-opus-5'),
  /** Server-side refusal fallbacks (recommended on Opus 5 / Fable). */
  ANTHROPIC_FALLBACKS: bool('true'),
  ANTHROPIC_EFFORT_CHAT: z.enum(['low', 'medium', 'high']).default('low'),
  ANTHROPIC_EFFORT_PLANNING: z.enum(['low', 'medium', 'high']).default('medium'),

  // ── Local embeddings (Transformers.js / ONNX) ──────────────────────────────
  LOCAL_EMBEDDING_MODEL: z.string().default('Xenova/bge-small-en-v1.5'),
  LOCAL_EMBEDDING_DIMENSIONS: z.coerce.number().positive().default(384),
  TRANSFORMERS_CACHE_DIR: z.string().default('./.cache/transformers'),

  // ── Behaviour toggles ───────────────────────────────────────────────────────
  /** Answer routine confirmations (done/skip/delete/add) from templates instead of an LLM call. */
  LLM_TEMPLATE_ROUTINE_REPLIES: bool('true'),
  /** Recognise trivial commands ("done", "show plan") without calling the classifier. */
  LLM_FAST_CLASSIFY: bool('true'),

  // ── Telegram ────────────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_WEBHOOK_URL: z.string().optional().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(''),

  // ── Infrastructure ──────────────────────────────────────────────────────────
  MONGODB_URI: z.string().default('mongodb://localhost:27017/assistant'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  QDRANT_URL: z.string().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().optional().default(''),

  // ── Default User Settings ───────────────────────────────────────────────────
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  DEFAULT_WORKING_HOURS_START: z.string().default('08:00'),
  DEFAULT_WORKING_HOURS_END: z.string().default('23:00'),
  DEFAULT_BUFFER_MINUTES: z.coerce.number().positive().default(10),
  DEFAULT_REMINDER_LEAD_MINUTES: z.coerce.number().positive().default(10),
  DEFAULT_SLACK_PERCENTAGE: z.coerce.number().min(0).max(100).default(20),
  DEFAULT_MAX_REPLAN_FREQUENCY_MINUTES: z.coerce.number().positive().default(5),
  DEFAULT_DAILY_PLAN_TIME: z.string().default('07:30'),
  DEFAULT_ANALYTICS_TIME: z.string().default('23:30'),
  DEFAULT_SNOOZE_MINUTES: z.coerce.number().positive().default(15),
  DEFAULT_MEMORY_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  DEFAULT_MEMORY_MIN_DATA_POINTS: z.coerce.number().positive().int().default(3),

  // ── Server ──────────────────────────────────────────────────────────────────
  PORT: z.coerce.number().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
}).superRefine((e, ctx) => {
  const vision = e.VISION_PROVIDER ?? e.LLM_PROVIDER;
  const needsOpenAI = e.LLM_PROVIDER === 'openai' || (vision === 'openai' && !e.VISION_BASE_URL) || (e.EMBEDDING_PROVIDER === 'openai' && !e.EMBEDDING_BASE_URL);
  if (needsOpenAI && !e.LLM_BASE_URL) ctx.addIssue({ code: 'custom', path: ['LLM_BASE_URL'], message: 'required when an OpenAI-compatible backend is selected' });
  if (needsOpenAI && !e.LLM_API_KEY) ctx.addIssue({ code: 'custom', path: ['LLM_API_KEY'], message: 'required when an OpenAI-compatible backend is selected' });
  if (vision === 'openai' && e.VISION_BASE_URL && !(e.VISION_API_KEY || e.LLM_API_KEY)) ctx.addIssue({ code: 'custom', path: ['VISION_API_KEY'], message: 'required with VISION_BASE_URL' });
  if (e.EMBEDDING_PROVIDER === 'openai' && e.EMBEDDING_BASE_URL && !(e.EMBEDDING_API_KEY || e.LLM_API_KEY)) ctx.addIssue({ code: 'custom', path: ['EMBEDDING_API_KEY'], message: 'required with EMBEDDING_BASE_URL' });
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  → ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
