import { env } from './env.js';

// ─── Intent Types ──────────────────────────────────────────────────────────────
export enum IntentType {
  ADD_TASK = 'ADD_TASK',
  MODIFY_TASK = 'MODIFY_TASK',
  DELETE_TASK = 'DELETE_TASK',
  COMPLETE_TASK = 'COMPLETE_TASK',
  SKIP_TASK = 'SKIP_TASK',
  ADD_PREFERENCE = 'ADD_PREFERENCE',
  ADD_CONSTRAINT = 'ADD_CONSTRAINT',
  ADD_HABIT = 'ADD_HABIT',
  REPLAN = 'REPLAN',
  SHOW_PLAN = 'SHOW_PLAN',
  GENERAL_CHAT = 'GENERAL_CHAT',
  IMAGE_CONTEXT = 'IMAGE_CONTEXT',
}

// ─── Task Status ───────────────────────────────────────────────────────────────
export enum TaskStatus {
  PENDING = 'pending',
  SCHEDULED = 'scheduled',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  SKIPPED = 'skipped',
  MISSED = 'missed',
  DEFERRED = 'deferred',
}

// ─── Schedule Entry Status ─────────────────────────────────────────────────────
export enum ScheduleEntryStatus {
  SCHEDULED = 'scheduled',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  SKIPPED = 'skipped',
  MISSED = 'missed',
}

// ─── Task Outcome (for history tracking) ───────────────────────────────────────
export enum TaskOutcome {
  COMPLETED = 'completed',
  COMPLETED_LATE = 'completed_late',
  SKIPPED = 'skipped',
  MISSED = 'missed',
  DEFERRED = 'deferred',
}

// ─── Memory Types ──────────────────────────────────────────────────────────────
export enum MemoryType {
  PREFERENCE = 'preference',
  HABIT = 'habit',
  CONSTRAINT = 'constraint',
}

// ─── Priority Levels ───────────────────────────────────────────────────────────
export enum Priority {
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
  URGENT = 4,
  CRITICAL = 5,
}

// ─── Cognitive Load ────────────────────────────────────────────────────────────
export enum CognitiveLoad {
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
}

// ─── System Defaults (from env vars) ───────────────────────────────────────────
export const SYSTEM_DEFAULTS = {
  timezone: env.DEFAULT_TIMEZONE,
  workingHours: {
    start: env.DEFAULT_WORKING_HOURS_START,
    end: env.DEFAULT_WORKING_HOURS_END,
  },
  bufferMinutes: env.DEFAULT_BUFFER_MINUTES,
  reminderLeadMinutes: env.DEFAULT_REMINDER_LEAD_MINUTES,
  slackPercentage: env.DEFAULT_SLACK_PERCENTAGE,
  maxReplanFrequencyMinutes: env.DEFAULT_MAX_REPLAN_FREQUENCY_MINUTES,
  dailyPlanTime: env.DEFAULT_DAILY_PLAN_TIME,
  analyticsTime: env.DEFAULT_ANALYTICS_TIME,
  snoozeMinutes: env.DEFAULT_SNOOZE_MINUTES,
  memoryConfidenceThreshold: env.DEFAULT_MEMORY_CONFIDENCE_THRESHOLD,
  memoryMinDataPoints: env.DEFAULT_MEMORY_MIN_DATA_POINTS,
} as const;

export type SystemDefaults = typeof SYSTEM_DEFAULTS;
