import { format, addMinutes, differenceInMinutes, isAfter, isBefore, isEqual } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Current wall-clock time in a timezone (as a "fake local" Date — only use for reading hours/minutes). */
export function nowInTimezone(timezone: string): Date {
  return toZonedTime(new Date(), timezone);
}

/**
 * Normalize loose time strings ("9", "9:30", "9am", "9:30 pm", "21:00", "10.15") into HH:mm.
 * Returns null if it cannot be understood.
 */
export function normalizeTimeString(input: string | undefined | null): string | null {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Build an absolute Date for a wall-clock HH:mm on a given calendar day in a timezone. */
export function parseTimeString(timeStr: string, date: Date | string, timezone: string): Date {
  let yyyy: string | number, MM: string | number, dd: string | number;

  if (typeof date === 'string') {
    [yyyy, MM, dd] = date.split('-') as [string, string, string];
  } else {
    const zonedDate = toZonedTime(date, timezone);
    yyyy = zonedDate.getFullYear();
    MM = String(zonedDate.getMonth() + 1).padStart(2, '0');
    dd = String(zonedDate.getDate()).padStart(2, '0');
  }

  const normalized = normalizeTimeString(timeStr) ?? '00:00';
  const isoString = `${yyyy}-${MM}-${dd}T${normalized}:00`;
  return fromZonedTime(isoString, timezone);
}

export function formatTime(date: Date, timezone: string): string {
  return format(toZonedTime(date, timezone), 'HH:mm');
}

export function formatTimeHuman(date: Date, timezone: string): string {
  return format(toZonedTime(date, timezone), 'h:mm a');
}

export function formatDateString(date: Date, timezone: string): string {
  return format(toZonedTime(date, timezone), 'yyyy-MM-dd');
}

export function formatDateHuman(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-US', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

export function todayString(timezone: string): string {
  return formatDateString(new Date(), timezone);
}

/** Wall-clock hour (0-23) of an instant in a timezone. */
export function hourInTimezone(date: Date, timezone: string): number {
  return toZonedTime(date, timezone).getHours();
}

/** The date the user considers "today" (wall-clock date). */
export function planningDateString(timezone: string, _lateNightThresholdHour = 4): string {
  return formatDateString(new Date(), timezone);
}

/**
 * "Tomorrow" from the user's perspective. Before the late-night threshold (e.g. 2 AM)
 * the user hasn't slept yet, so "tomorrow" is the current calendar day.
 */
export function tomorrowString(timezone: string, lateNightThresholdHour = 4): string {
  const now = toZonedTime(new Date(), timezone);
  if (now.getHours() < lateNightThresholdHour) {
    return format(now, 'yyyy-MM-dd');
  }
  return addDaysToDateString(format(now, 'yyyy-MM-dd'), 1);
}

export function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Pure calendar arithmetic on yyyy-MM-dd strings. */
export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Whole days from `fromStr` to `toStr` (negative if `toStr` is earlier). */
export function daysBetween(fromStr: string, toStr: string): number {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  return Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000);
}

export function weekdayOfDateString(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!))
    .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
    .toLowerCase();
}

/** Midnight at the start of a calendar day in the user's timezone. */
export function dateStringToDate(dateStr: string, timezone: string): Date {
  return parseTimeString('00:00', dateStr, timezone);
}

export function roundUpToMinutes(date: Date, stepMinutes: number): Date {
  const ms = stepMinutes * 60_000;
  return new Date(Math.ceil(date.getTime() / ms) * ms);
}

export function msUntil(targetDate: Date): number {
  return Math.max(0, targetDate.getTime() - Date.now());
}

export function isTimeInRange(time: Date, start: Date, end: Date): boolean {
  return (isAfter(time, start) || isEqual(time, start)) && isBefore(time, end);
}

export function durationMinutes(start: Date, end: Date): number {
  return differenceInMinutes(end, start);
}

export function addMins(date: Date, minutes: number): Date {
  return addMinutes(date, minutes);
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
