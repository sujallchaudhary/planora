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
  REMOVE_MEMORY = 'REMOVE_MEMORY',
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

/** Statuses that mean "this task still needs doing". */
export const OPEN_TASK_STATUSES = [TaskStatus.PENDING, TaskStatus.SCHEDULED, TaskStatus.ACTIVE];

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

/**
 * Canonical preference keys. The intent-classification prompt tells the LLM to use
 * these, extract-memory normalizes synonyms onto them, and the planner reads them.
 * Keeping one list here is what makes "I focus better at night" actually change the plan.
 */
export const PREFERENCE_KEYS = {
  /** morning | afternoon | evening | night — when deep work succeeds */
  PEAK_FOCUS_WINDOW: 'peak_focus_window',
  /** morning | afternoon | evening | night — when tasks tend to be missed */
  LOW_SUCCESS_WINDOW: 'low_success_window',
  /** high | normal — analytics-inferred */
  MORNING_TASK_DIFFICULTY: 'morning_task_difficulty',
  /** numeric string, e.g. "1.25" — how much longer tasks take than estimated */
  TIME_ESTIMATE_MULTIPLIER: 'time_estimate_multiplier',
  /** morning | afternoon | evening | night — when the user prefers workouts */
  WORKOUT_TIME: 'workout_time',
  /** HH:mm — usual wake-up time */
  WAKE_TIME: 'wake_time',
  /** HH:mm — usual bedtime */
  SLEEP_TIME: 'sleep_time',
  /** yes | no — does work go better after exercise */
  WORKOUT_BOOSTS_FOCUS: 'workout_boosts_focus',
} as const;

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

// ─── Planning constants ────────────────────────────────────────────────────────
export const PLANNING = {
  /** Tasks due within this many days are scheduled as "primary"; later ones only fill spare capacity. */
  LOOKAHEAD_DAYS: 3,
  /** Fraction of daily capacity that must remain free before "work ahead" tasks are added. */
  AHEAD_FILL_RATIO: 0.6,
  /** Round schedule start times to this many minutes. */
  ROUND_MINUTES: 5,
  /** Skip the LLM blueprint when there are fewer flexible tasks than this. */
  BLUEPRINT_MIN_TASKS: 3,
  /** Cache blueprints for this long (ms). */
  BLUEPRINT_CACHE_MS: 20 * 60 * 1000,
} as const;

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
