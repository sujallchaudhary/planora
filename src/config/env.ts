import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  // LLM Configuration — Chat/Text
  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1, 'LLM_API_KEY is required'),
  LLM_CHAT_MODEL: z.string().default('MiniMax-M2.7'),
  LLM_REASONING_MODEL: z.string().default('MiniMax-M2.7'),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  LLM_MAX_TOKENS: z.coerce.number().positive().default(2048),

  // LLM Configuration — Vision (falls back to LLM_BASE_URL / LLM_API_KEY if not set)
  VISION_BASE_URL: z.string().url().optional(),
  VISION_API_KEY: z.string().optional(),
  LLM_VISION_MODEL: z.string().default('gpt-4o'),

  // LLM Configuration — Embedding (falls back to LLM_BASE_URL / LLM_API_KEY if not set)
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  LLM_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().positive().default(1536),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_WEBHOOK_URL: z.string().optional().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(''),

  // Infrastructure
  MONGODB_URI: z.string().default('mongodb://localhost:27017/assistant'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  QDRANT_URL: z.string().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().optional().default(''),

  // Default User Settings
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

  // Server
  PORT: z.coerce.number().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
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
export type Env = z.infer<typeof envSchema>;
