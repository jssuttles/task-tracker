/**
 * The vault: day files on disk, behind a port.
 *
 * `VaultPort` is the only seam between the journal logic and the filesystem.
 * The Tauri adapter talks to Rust commands; `MemoryVault` backs the tests and
 * the browser dev loop. Everything above this line is pure and testable.
 */

import { addDays, fromDateKey, isDateKey, toDateKey, type Clock, type DateKey } from './dates.ts';
import { createDay, parseDay, serializeDay, type DayDocument } from './markdown/day.ts';
import {
  createTeamMember,
  parseTeamMember,
  serializeTeamMember,
  type TeamMemberDocument,
} from './markdown/team.ts';
import { carryOverTasks } from './tasks.ts';

/** Storage for vault files, keyed by filename. */
export interface VaultPort {
  read(name: string): Promise<string | null>;
  write(name: string, contents: string): Promise<void>;
  list(): Promise<string[]>;
}

/** `YYYY-MM-DD.md`. */
const DAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/;
/** `YYYY-Www.md`. */
const WEEK_FILE_PATTERN = /^\d{4}-W\d{2}\.md$/;
/** `YYYY-Www-team.md` — the manager's weekly view across every tracked report. */
const TEAM_WEEK_FILE_PATTERN = /^\d{4}-W\d{2}-team\.md$/;
/** A lowercase handle, the same character set `@mentions` extract. */
const PERSON_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
/** `team.<person>.md`. */
const TEAM_FILE_PATTERN = /^team\.([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\.md$/;
/** Non-dated files the app owns. */
const STATIC_FILES = ['CONTEXT.md'];

/**
 * Guard every filename that reaches the filesystem.
 *
 * The Rust side validates independently — this is defense in depth, not the only
 * check. Nothing here should ever contain a separator or a `..`, so an exact
 * pattern match is both sufficient and the easiest thing to be confident about.
 */
export function isSafeVaultName(name: string): boolean {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return (
    DAY_FILE_PATTERN.test(name) ||
    WEEK_FILE_PATTERN.test(name) ||
    TEAM_WEEK_FILE_PATTERN.test(name) ||
    TEAM_FILE_PATTERN.test(name) ||
    STATIC_FILES.includes(name)
  );
}

/** `true` when `handle` is a usable person handle: the `@mention` character set, lowercase. */
export function isPersonHandle(handle: string): boolean {
  return PERSON_HANDLE_PATTERN.test(handle);
}

/** The filename for a given day. */
export function dayFileName(date: DateKey): string {
  return `${date}.md`;
}

/** The date key a day filename refers to, or `null` if it isn't one. */
export function dayKeyFromFileName(name: string): DateKey | null {
  const match = DAY_FILE_PATTERN.exec(name);
  const key = match?.[1];
  return key !== undefined && isDateKey(key) ? key : null;
}

/** Every day key present in the vault, ascending. */
export async function listDayKeys(vault: VaultPort): Promise<DateKey[]> {
  const names = await vault.list();
  return names
    .map(dayKeyFromFileName)
    .filter((key): key is DateKey => key !== null)
    .sort((a, b) => a.localeCompare(b));
}

/** The most recent day key strictly before `date`, or `null`. */
export function previousDayKey(keys: readonly DateKey[], date: DateKey): DateKey | null {
  let best: DateKey | null = null;
  for (const key of keys) {
    if (key < date && (best === null || key > best)) best = key;
  }
  return best;
}

/**
 * How far back to look for tasks to carry forward.
 *
 * Bounded on purpose. Returning from a two-week holiday should not resurrect a
 * fortnight-stale to-do list into today's check-in; past this horizon the old
 * day file is still there to read, it just doesn't auto-populate.
 */
export const CARRY_OVER_HORIZON_DAYS = 4;

/** `true` when `previous` is recent enough to carry tasks from. */
export function withinCarryOverHorizon(previous: DateKey, current: DateKey): boolean {
  const from = fromDateKey(previous);
  const to = fromDateKey(current);
  if (from === null || to === null) return false;

  return addDays(from, CARRY_OVER_HORIZON_DAYS).getTime() >= to.getTime();
}

/** Read and parse a day file, or `null` if it doesn't exist. */
export async function readDay(
  vault: VaultPort,
  date: DateKey,
  workStart: Clock,
  workEnd: Clock,
): Promise<DayDocument | null> {
  const source = await vault.read(dayFileName(date));
  if (source === null) return null;

  return parseDay(source, { date, workStart, workEnd });
}

/** Serialize and write a day file. */
export async function writeDay(vault: VaultPort, day: DayDocument): Promise<void> {
  await vault.write(dayFileName(day.date), serializeDay(day));
}

/**
 * Load today's file, creating it (seeded with carried-over tasks) if absent.
 *
 * The create path is where a workday actually begins: yesterday's unfinished
 * work becomes today's starting list, which is what the day-start prompt shows.
 */
export async function openDay(
  vault: VaultPort,
  date: DateKey,
  workStart: Clock,
  workEnd: Clock,
): Promise<DayDocument> {
  const existing = await readDay(vault, date, workStart, workEnd);
  if (existing !== null) return existing;

  const keys = await listDayKeys(vault);
  const previousKey = previousDayKey(keys, date);
  if (previousKey === null || !withinCarryOverHorizon(previousKey, date)) {
    return createDay(date, workStart, workEnd);
  }

  const previous = await readDay(vault, previousKey, workStart, workEnd);
  const carried = previous === null ? [] : carryOverTasks(previous.tasks, previousKey);
  return createDay(date, workStart, workEnd, carried);
}

/** Every day file in the vault whose key falls within `[from, to]`, ascending. */
export async function readDayRange(
  vault: VaultPort,
  from: DateKey,
  to: DateKey,
  workStart: Clock,
  workEnd: Clock,
): Promise<DayDocument[]> {
  const keys = (await listDayKeys(vault)).filter((key) => key >= from && key <= to);
  const days: DayDocument[] = [];

  for (const key of keys) {
    const day = await readDay(vault, key, workStart, workEnd);
    if (day !== null) days.push(day);
  }

  return days;
}

/** The filename for a report's team file. `person` must already be a valid handle. */
export function teamFileName(person: string): string {
  return `team.${person}.md`;
}

/** The person handle a team filename refers to, or `null` if it isn't one. */
export function personFromFileName(name: string): string | null {
  return TEAM_FILE_PATTERN.exec(name)?.[1] ?? null;
}

/** Every report with a team file in the vault, ascending. */
export async function listTeamPeople(vault: VaultPort): Promise<string[]> {
  const names = await vault.list();
  return names
    .map(personFromFileName)
    .filter((person): person is string => person !== null)
    .sort((a, b) => a.localeCompare(b));
}

/** Read and parse a report's team file, or `null` if it doesn't exist. */
export async function readTeamMember(
  vault: VaultPort,
  person: string,
): Promise<TeamMemberDocument | null> {
  const source = await vault.read(teamFileName(person));
  if (source === null) return null;

  return parseTeamMember(source, { person });
}

/** Serialize and write a report's team file. */
export async function writeTeamMember(vault: VaultPort, member: TeamMemberDocument): Promise<void> {
  await vault.write(teamFileName(member.person), serializeTeamMember(member));
}

/** Load a report's team file, creating an empty one if this is the first time they're logged. */
export async function openTeamMember(
  vault: VaultPort,
  person: string,
): Promise<TeamMemberDocument> {
  const existing = await readTeamMember(vault, person);
  return existing ?? createTeamMember(person);
}

/** Today's date key. Exists so callers don't re-import `dates` for one call. */
export function todayKey(now: Date = new Date()): DateKey {
  return toDateKey(now);
}

/**
 * An in-memory `VaultPort` for tests and the browser dev loop.
 *
 * Backed by a plain `Map`, seeded from an optional snapshot so a test can set up
 * a vault's prior history in one expression.
 */
export class MemoryVault implements VaultPort {
  private readonly files: Map<string, string>;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    this.files = new Map(Object.entries(initial));
  }

  read(name: string): Promise<string | null> {
    return Promise.resolve(this.files.get(name) ?? null);
  }

  write(name: string, contents: string): Promise<void> {
    this.files.set(name, contents);
    return Promise.resolve();
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }

  /** Test helper: the raw contents currently stored. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }
}
