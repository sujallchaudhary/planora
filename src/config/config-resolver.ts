import { SYSTEM_DEFAULTS } from './defaults.js';

// ─── UserConfig shape ──────────────────────────────────────────────────────────
export interface UserConfig {
  timezone: string;
  workingHours: { start: string; end: string };
  bufferMinutes: number;
  reminderLeadMinutes: number;
  slackPercentage: number;
  maxReplanFrequencyMinutes: number;
  dailyPlanTime: string;
  analyticsTime: string;
  snoozeMinutes: number;
  memoryConfidenceThreshold: number;
  memoryMinDataPoints: number;
  /** Hour (0-23) before which midnight is treated as still the previous night. Default: 4 */
  lateNightThresholdHour: number;
}

// ─── Per-user settings stored in MongoDB (all optional overrides) ──────────────
export interface UserSettings {
  timezone?: string;
  workingHours?: { start?: string; end?: string };
  bufferMinutes?: number;
  reminderLeadMinutes?: number;
  slackPercentage?: number;
  maxReplanFrequencyMinutes?: number;
  dailyPlanTime?: string;
  analyticsTime?: string;
  snoozeMinutes?: number;
  memoryConfidenceThreshold?: number;
  memoryMinDataPoints?: number;
  lateNightThresholdHour?: number;
}

/**
 * Merges system defaults with per-user overrides.
 * Per-user settings always win over system defaults.
 * Missing user settings fall back to system defaults.
 */
export function resolveUserConfig(userSettings?: UserSettings | null): UserConfig {
  const s = userSettings ?? {};

  return {
    timezone: s.timezone ?? SYSTEM_DEFAULTS.timezone,
    workingHours: {
      start: s.workingHours?.start ?? SYSTEM_DEFAULTS.workingHours.start,
      end: s.workingHours?.end ?? SYSTEM_DEFAULTS.workingHours.end,
    },
    bufferMinutes: s.bufferMinutes ?? SYSTEM_DEFAULTS.bufferMinutes,
    reminderLeadMinutes: s.reminderLeadMinutes ?? SYSTEM_DEFAULTS.reminderLeadMinutes,
    slackPercentage: s.slackPercentage ?? SYSTEM_DEFAULTS.slackPercentage,
    maxReplanFrequencyMinutes: s.maxReplanFrequencyMinutes ?? SYSTEM_DEFAULTS.maxReplanFrequencyMinutes,
    dailyPlanTime: s.dailyPlanTime ?? SYSTEM_DEFAULTS.dailyPlanTime,
    analyticsTime: s.analyticsTime ?? SYSTEM_DEFAULTS.analyticsTime,
    snoozeMinutes: s.snoozeMinutes ?? SYSTEM_DEFAULTS.snoozeMinutes,
    memoryConfidenceThreshold: s.memoryConfidenceThreshold ?? SYSTEM_DEFAULTS.memoryConfidenceThreshold,
    memoryMinDataPoints: s.memoryMinDataPoints ?? SYSTEM_DEFAULTS.memoryMinDataPoints,
    lateNightThresholdHour: s.lateNightThresholdHour ?? 4,
  };
}
