import { format, parse, addMinutes, differenceInMinutes, isAfter, isBefore, isEqual, startOfDay, setHours, setMinutes } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

/**
 * Get the current time in a specific timezone.
 */
export function nowInTimezone(timezone: string): Date {
  return toZonedTime(new Date(), timezone);
}

/**
 * Parse a time string (HH:mm) into a Date object for a given date and timezone.
 */
export function parseTimeString(timeStr: string, date: Date, timezone: string): Date {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const zonedDate = toZonedTime(date, timezone);
  const start = startOfDay(zonedDate);
  return addMinutes(setMinutes(setHours(start, hours!), minutes!), 0);
}

/**
 * Format a Date to a time string (HH:mm) in a specific timezone.
 */
export function formatTime(date: Date, timezone: string): string {
  const zoned = toZonedTime(date, timezone);
  return format(zoned, 'HH:mm');
}

/**
 * Format a Date to a human-friendly time string (h:mm a) in a specific timezone.
 */
export function formatTimeHuman(date: Date, timezone: string): string {
  const zoned = toZonedTime(date, timezone);
  return format(zoned, 'h:mm a');
}

/**
 * Format a Date to a date string (yyyy-MM-dd) in a specific timezone.
 */
export function formatDateString(date: Date, timezone: string): string {
  const zoned = toZonedTime(date, timezone);
  return format(zoned, 'yyyy-MM-dd');
}

/**
 * Get today's date string in a specific timezone.
 */
export function todayString(timezone: string): string {
  return formatDateString(new Date(), timezone);
}

/**
 * Calculate the delay in milliseconds from now to a target time.
 * Returns 0 if the target is in the past.
 */
export function msUntil(targetDate: Date): number {
  const now = new Date();
  const diff = targetDate.getTime() - now.getTime();
  return Math.max(0, diff);
}

/**
 * Check if a time falls within a range (inclusive of start, exclusive of end).
 */
export function isTimeInRange(time: Date, start: Date, end: Date): boolean {
  return (isAfter(time, start) || isEqual(time, start)) && isBefore(time, end);
}

/**
 * Get the duration in minutes between two dates.
 */
export function durationMinutes(start: Date, end: Date): number {
  return differenceInMinutes(end, start);
}

/**
 * Add minutes to a date.
 */
export function addMins(date: Date, minutes: number): Date {
  return addMinutes(date, minutes);
}
