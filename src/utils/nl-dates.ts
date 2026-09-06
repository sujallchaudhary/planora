import * as chrono from 'chrono-node';
import { getTimezoneOffset } from 'date-fns-tz';
import { formatDateString, formatTime } from './date.js';

export interface DateHint {
  /** yyyy-MM-dd in the user's timezone */
  date: string;
  /** HH:mm if the text stated a time */
  time?: string;
  endTime?: string;
  /** the matched substring, e.g. "tomorrow at 3pm" */
  text: string;
}

/**
 * Deterministic natural-language date parsing (chrono-node). Used to sanity-check and
 * fill in dates the LLM extracted — it never replaces a date the model got right, but it
 * catches "tomorrow" resolved to last year, or a stated time the model dropped.
 */
export function extractDateHints(text: string, reference: Date, timezone: string): DateHint[] {
  const offsetMinutes = getTimezoneOffset(timezone, reference) / 60_000;
  let results: chrono.ParsedResult[];
  try {
    results = chrono.parse(text, { instant: reference, timezone: offsetMinutes }, { forwardDate: true });
  } catch {
    return [];
  }
  const hints: DateHint[] = [];
  for (const r of results) {
    // "for 2 hours" / "30 minutes" are durations, not dates.
    if (DURATION_RE.test(r.text.trim())) continue;
    if (!r.start.isCertain('day') && !r.start.isCertain('weekday') && !r.start.isCertain('hour')) continue;

    const start = r.start.date();
    const hasTime = r.start.isCertain('hour');
    if (hasTime && !r.start.isCertain('meridiem')) bumpToAfternoon(start, timezone);
    let end = r.end?.isCertain('hour') ? r.end.date() : null;
    if (end && r.end && !r.end.isCertain('meridiem')) {
      bumpToAfternoon(end, timezone);
      if (end <= start) end = new Date(end.getTime() + 12 * 3600_000);
    }
    hints.push({
      date: formatDateString(start, timezone),
      time: hasTime ? formatTime(start, timezone) : undefined,
      endTime: end ? formatTime(end, timezone) : undefined,
      text: r.text,
    });
  }
  return hints;
}

const DURATION_RE = /^(for|in|about|around)?\s*\d+(\.\d+)?\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/i;

/** "meeting at 2" means 14:00 for anything a person would schedule; 1-5 without am/pm → PM. */
function bumpToAfternoon(date: Date, timezone: string): void {
  const hour = Number(formatTime(date, timezone).split(':')[0]);
  if (hour >= 1 && hour <= 5) date.setTime(date.getTime() + 12 * 3600_000);
}
