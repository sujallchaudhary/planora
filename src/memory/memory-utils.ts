import { PREFERENCE_KEYS } from '../config/defaults.js';
import { normalizeTimeString } from '../utils/date.js';

export type TimeBlock = 'morning' | 'afternoon' | 'evening' | 'night';
export const TIME_BLOCKS: TimeBlock[] = ['morning', 'afternoon', 'evening', 'night'];

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const WEEKENDS = ['saturday', 'sunday'];
const ALL_DAYS = [...WEEKDAYS, ...WEEKENDS];

const DAY_ALIASES: Record<string, string> = {
  mon: 'monday', monday: 'monday',
  tue: 'tuesday', tues: 'tuesday', tuesday: 'tuesday',
  wed: 'wednesday', wednesday: 'wednesday',
  thu: 'thursday', thur: 'thursday', thurs: 'thursday', thursday: 'thursday',
  fri: 'friday', friday: 'friday',
  sat: 'saturday', saturday: 'saturday',
  sun: 'sunday', sunday: 'sunday',
  daily: 'daily', everyday: 'daily', 'every day': 'daily', always: 'daily',
  weekdays: 'weekdays', weekday: 'weekdays', 'mon-fri': 'weekdays',
  weekends: 'weekends', weekend: 'weekends',
};

/** Normalize an LLM-provided day list. Empty / missing / garbage → ['daily']. */
export function normalizeDays(days?: (string | null | undefined)[] | null): string[] {
  if (!days || days.length === 0) return ['daily'];
  const out = new Set<string>();
  for (const raw of days) {
    if (!raw) continue;
    const key = String(raw).trim().toLowerCase();
    const mapped = DAY_ALIASES[key];
    if (mapped) out.add(mapped);
  }
  if (out.size === 0) return ['daily'];
  if (out.has('daily')) return ['daily'];
  return Array.from(out);
}

/** Does a normalized day list apply on a given weekday name ("monday")? */
export function dayApplies(days: string[] | undefined | null, weekday: string): boolean {
  const list = days && days.length > 0 ? days : ['daily'];
  if (list.includes('daily')) return true;
  if (list.includes(weekday)) return true;
  if (list.includes('weekdays') && WEEKDAYS.includes(weekday)) return true;
  if (list.includes('weekends') && WEEKENDS.includes(weekday)) return true;
  return false;
}

export function describeDays(days: string[] | undefined | null): string {
  const list = normalizeDays(days);
  if (list.includes('daily')) return 'daily';
  if (list.length === ALL_DAYS.length) return 'daily';
  return list.map(d => d.slice(0, 3)).join('/');
}

export function inferBlockFromText(value: string | undefined | null): TimeBlock | null {
  if (!value) return null;
  const text = value.toLowerCase();
  if (/\b(late night|night|midnight|after 9|after 10|after 11)\b/.test(text)) return 'night';
  if (/\b(evening|after work|after dinner|after 5|after 6)\b/.test(text)) return 'evening';
  if (/\b(afternoon|after lunch|midday|noon)\b/.test(text)) return 'afternoon';
  if (/\b(morning|early|after waking|first thing|before noon)\b/.test(text)) return 'morning';
  const t = normalizeTimeString(text);
  if (t) {
    const h = Number(t.split(':')[0]);
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    if (h < 21) return 'evening';
    return 'night';
  }
  return null;
}

const CANONICAL = new Set<string>(Object.values(PREFERENCE_KEYS));
const WINDOW_KEYS = new Set<string>([
  PREFERENCE_KEYS.PEAK_FOCUS_WINDOW,
  PREFERENCE_KEYS.LOW_SUCCESS_WINDOW,
  PREFERENCE_KEYS.WORKOUT_TIME,
]);

/**
 * Map whatever key/value the LLM produced onto the canonical keys the planner reads.
 * Unknown preferences are kept as-is (they still reach the blueprint prompt as free text).
 */
export function canonicalizePreference(rawKey: string, rawValue: string): { key: string; value: string } {
  const key = rawKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const value = rawValue.trim();
  const combined = `${key} ${value}`.toLowerCase();
  const block = inferBlockFromText(value) ?? inferBlockFromText(key.replace(/_/g, ' '));

  if (CANONICAL.has(key)) {
    if (WINDOW_KEYS.has(key)) {
      return { key, value: block ?? value.toLowerCase() };
    }
    return { key, value };
  }

  const negative = /\b(hate|hates|avoid|avoids|worst|bad at|struggle|struggles|dislike|dislikes|can'?t focus|cannot focus|useless|unproductive|not productive|never works)\b/.test(combined);
  const workout = /\b(gym|workout|work out|exercise|run|running|jog|swim|yoga|training)\b/.test(combined);
  const focus = /\b(focus|deep work|deep_work|productive|productivity|concentrat|study|studying|work best|works best|best time|peak|sharp|energetic|energy)\b/.test(combined);

  if (block && workout && !negative) return { key: PREFERENCE_KEYS.WORKOUT_TIME, value: block };
  if (block && negative) return { key: PREFERENCE_KEYS.LOW_SUCCESS_WINDOW, value: block };
  if (block && focus) return { key: PREFERENCE_KEYS.PEAK_FOCUS_WINDOW, value: block };

  if (/\b(after (a )?(workout|gym|exercise|run))\b/.test(combined) && /\b(focus|work|productive|better)\b/.test(combined)) {
    return { key: PREFERENCE_KEYS.WORKOUT_BOOSTS_FOCUS, value: 'yes' };
  }

  const time = normalizeTimeString(value);
  if (time && /\b(wake|wakes|waking|get up|gets up)\b/.test(combined)) return { key: PREFERENCE_KEYS.WAKE_TIME, value: time };
  if (time && /\b(sleep|sleeps|bed|bedtime)\b/.test(combined)) return { key: PREFERENCE_KEYS.SLEEP_TIME, value: time };

  return { key, value };
}

export function isAllDayRange(range: { start?: string | null; end?: string | null } | undefined | null): boolean {
  if (!range?.start || !range?.end) return true;
  return range.start === '00:00' && (range.end === '23:59' || range.end === '24:00' || range.end === '00:00');
}
