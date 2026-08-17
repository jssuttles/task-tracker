/**
 * Local-time date helpers.
 *
 * Every date key in the vault is a **local** calendar date, never UTC. A user in
 * UTC-07:00 logging a note at 18:00 on the 2nd must write it to `2026-08-02.md`,
 * but `toISOString()` would return `2026-08-03T01:00:00Z` and file it under the
 * wrong day — silently shifting an evening's work into tomorrow. So the day key
 * is always built from the local getters.
 */

import { MINUTES_PER_DAY } from './time.ts';

/** `YYYY-MM-DD` in local time. */
export type DateKey = string;
/** `HH:MM` on a 24-hour clock. */
export type Clock = string;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Format a `Date` as a local `YYYY-MM-DD` key. */
export function toDateKey(date: Date): DateKey {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate(),
  )}`;
}

/** Parse a `YYYY-MM-DD` key into local midnight, or `null` if malformed. */
export function fromDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(year, month - 1, day);
  // Reject dates the Date constructor silently rolled over (e.g. 2026-02-31).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/** `true` when `key` is a well-formed, real calendar date. */
export function isDateKey(key: string): boolean {
  return fromDateKey(key) !== null;
}

/** Format a `Date` as local `HH:MM`. */
export function toClock(date: Date): Clock {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Minutes since local midnight for `HH:MM`, or `null` if malformed. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Render minutes-since-midnight as `HH:MM`. Values outside a day are clamped. */
export function formatClock(minutes: number): Clock {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY - 1, Math.trunc(minutes)));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

/** Minutes elapsed since local midnight on `date`. */
export function minutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** A new `Date` `days` after `date` (negative goes backwards). */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * The Monday of the ISO week containing `date`, at local midnight. ISO weeks
 * start on Monday, but `getDay()` calls Sunday 0 — so Sunday maps back six days,
 * not forward one.
 */
export function startOfIsoWeek(date: Date): Date {
  const day = date.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  const monday = addDays(date, offset);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/**
 * ISO-8601 week key, e.g. `2026-W31`.
 *
 * The ISO week-numbering year is not always the calendar year: 2027-01-01 falls
 * in week 53 of 2026. The standard trick is to jump to the Thursday of the same
 * week — whichever calendar year that Thursday lands in *is* the week year.
 */
export function toWeekKey(date: Date): string {
  const monday = startOfIsoWeek(date);
  const thursday = addDays(monday, 3);
  const weekYear = thursday.getFullYear();

  const firstThursday = new Date(weekYear, 0, 4);
  const firstMonday = startOfIsoWeek(firstThursday);
  const week = Math.round((monday.getTime() - firstMonday.getTime()) / (7 * 24 * 60 * 60_000)) + 1;

  return `${String(weekYear).padStart(4, '0')}-W${pad2(week)}`;
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * Human heading for a day file, e.g. `Sunday, 2 August 2026`.
 *
 * Deliberately not `toLocaleDateString`: the vault is a durable artifact that
 * should read the same on every machine and in CI, regardless of system locale.
 */
export function describeDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** The English name of a date's weekday, e.g. `Monday`. */
export function weekdayName(date: Date): string {
  return WEEKDAYS[date.getDay()];
}
