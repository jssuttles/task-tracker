/**
 * User settings: the work window, the vault location, and nudge behavior.
 *
 * Settings live in the app config directory rather than the vault, because the
 * vault path itself is a setting — storing it inside the vault would be
 * circular. Parsing is defensive: the file is on disk and hand-editable, so
 * every field is validated and falls back to its default rather than trusting
 * the shape.
 *
 * Two entry points, deliberately different in temperament:
 *
 * - `parseSettings` reads the **file**, and silently falls back per field. A
 *   corrupt `settings.json` must never stop the app from starting.
 * - `validateDraft` reads the **form**, and reports what is wrong. Silently
 *   reverting someone's typing is the worst thing a settings panel can do — if
 *   `17:00` won't be accepted, say so rather than snapping back to the old value
 *   and leaving them to guess.
 */

import { formatClock, parseClock } from './dates.ts';

export interface Settings {
  /** Local `HH:MM` when the workday starts. */
  workStart: string;
  /** Local `HH:MM` when the workday ends. */
  workEnd: string;
  /**
   * Absolute path to the vault folder. Empty means "use the platform default",
   * resolved on the Rust side (`$DOCUMENT/TaskTracker`) since the frontend has
   * no business knowing OS path conventions.
   */
  vaultDir: string;
  /** Whether the hourly nudge fires at all (day start/end still do). */
  hourlyEnabled: boolean;
  /** How long "Snooze" defers the current check-in. */
  snoozeMinutes: number;
  /**
   * The days that count as working days, as `Date.getDay()` numbers
   * (0 = Sunday … 6 = Saturday), ascending.
   *
   * A list rather than an `includeWeekends` flag because "the weekend" is not
   * universally Saturday and Sunday: a Tuesday-to-Saturday shift, a four-day
   * week, and a Sunday-to-Thursday week are all ordinary, and none of them can
   * be expressed by a boolean.
   */
  workDays: number[];
  /**
   * Whether the day-end check-in offers an extra step for logging what a
   * report is up to. The Team panel itself (reachable from the tray, like
   * Settings) is always available regardless of this — it costs nothing to
   * open with no reports tracked yet, and files are created from usage, not
   * from a roster kept here. This setting only controls whether the
   * *recurring, timer-driven* prompt grows an extra field, the same way
   * `hourlyEnabled` only controls scheduling and never hides a feature.
   */
  managerModeEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  workStart: '09:00',
  workEnd: '17:00',
  vaultDir: '',
  hourlyEnabled: true,
  snoozeMinutes: 10,
  workDays: [1, 2, 3, 4, 5],
  managerModeEnabled: false,
};

/** Every day of the week, for the "I work whenever" case. */
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Snooze bounds. Below a minute is a busy-loop; above an hour is the next slot. */
export const MIN_SNOOZE_MINUTES = 1;
export const MAX_SNOOZE_MINUTES = 60;

function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readClock(source: Record<string, unknown>, key: string, fallback: string): string {
  const raw = readString(source, key, fallback);
  const minutes = parseClock(raw);
  // Re-format through `formatClock` so `9:00` is normalized to `09:00`.
  return minutes === null ? fallback : formatClock(minutes);
}

/**
 * Read the working-day list, de-duplicated and sorted.
 *
 * Falls back to the default for anything unusable — including an *empty* list,
 * because a work week with no days in it would silence the app permanently, and
 * a user who wanted silence would quit it rather than edit JSON.
 *
 * Understands the superseded `includeWeekends` boolean so an existing
 * settings.json keeps working after an upgrade.
 */
function readWorkDays(source: Record<string, unknown>, fallback: number[]): number[] {
  const raw = source.workDays;

  if (Array.isArray(raw)) {
    const days = [
      ...new Set(
        raw.filter(
          (day): day is number =>
            typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6,
        ),
      ),
    ].sort((a, b) => a - b);

    return days.length > 0 ? days : [...fallback];
  }

  if (source.includeWeekends === true) return [...ALL_DAYS];
  return [...fallback];
}

/**
 * Parse settings from parsed JSON of unknown shape.
 *
 * Returns fully-populated `Settings` for any input, including `null` and
 * non-objects — a corrupt settings file must not stop the app from starting.
 */
export function parseSettings(input: unknown): Settings {
  if (typeof input !== 'object' || input === null) {
    return { ...DEFAULT_SETTINGS };
  }

  const source = input as Record<string, unknown>;
  const snoozeRaw = source.snoozeMinutes;
  const snooze =
    typeof snoozeRaw === 'number' && Number.isFinite(snoozeRaw)
      ? Math.min(MAX_SNOOZE_MINUTES, Math.max(MIN_SNOOZE_MINUTES, Math.round(snoozeRaw)))
      : DEFAULT_SETTINGS.snoozeMinutes;

  const settings: Settings = {
    workStart: readClock(source, 'workStart', DEFAULT_SETTINGS.workStart),
    workEnd: readClock(source, 'workEnd', DEFAULT_SETTINGS.workEnd),
    vaultDir: readString(source, 'vaultDir', DEFAULT_SETTINGS.vaultDir),
    hourlyEnabled: readBoolean(source, 'hourlyEnabled', DEFAULT_SETTINGS.hourlyEnabled),
    snoozeMinutes: snooze,
    workDays: readWorkDays(source, DEFAULT_SETTINGS.workDays),
    managerModeEnabled: readBoolean(
      source,
      'managerModeEnabled',
      DEFAULT_SETTINGS.managerModeEnabled,
    ),
  };

  // A window that ends before it starts would make every slot calculation
  // nonsense, so fall back to the defaults as a pair rather than half-fixing it.
  const start = parseClock(settings.workStart);
  const end = parseClock(settings.workEnd);
  if (start === null || end === null || start >= end) {
    settings.workStart = DEFAULT_SETTINGS.workStart;
    settings.workEnd = DEFAULT_SETTINGS.workEnd;
  }

  return settings;
}

/** Serialize settings for `settings.json`. */
export function serializeSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/* ------------------------------------------------------------------ the form */

/** Short labels for the work-day toggles, indexed by `Date.getDay()`. */
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * The settings panel's state, as the DOM holds it.
 *
 * Clock and snooze fields are **strings**, not parsed values: they mirror what
 * is in the input right now, including the half-typed and the nonsensical. That
 * is the point — the draft is what the user has said so far, and validation is a
 * separate question from storage.
 *
 * `vaultDir` is absent because the panel shows it read-only; the folder picker
 * is post-MVP (see `docs/future-work.md`), and `applyDraft` carries the existing
 * value through untouched.
 */
export interface SettingsDraft {
  workStart: string;
  workEnd: string;
  hourlyEnabled: boolean;
  /** Raw input text, so `''` and `'abc'` are representable and reportable. */
  snoozeMinutes: string;
  workDays: number[];
  managerModeEnabled: boolean;
}

/** A field the panel can highlight. */
export type SettingsField = 'workStart' | 'workEnd' | 'snoozeMinutes' | 'workDays';

export interface SettingsIssue {
  field: SettingsField;
  message: string;
}

function isWeekday(day: number): boolean {
  return Number.isInteger(day) && day >= 0 && day <= 6;
}

/** Fill a draft from the settings currently in force. */
export function toDraft(settings: Settings): SettingsDraft {
  return {
    workStart: settings.workStart,
    workEnd: settings.workEnd,
    hourlyEnabled: settings.hourlyEnabled,
    snoozeMinutes: String(settings.snoozeMinutes),
    workDays: [...settings.workDays],
    managerModeEnabled: settings.managerModeEnabled,
  };
}

/**
 * Add or remove a working day, keeping the list sorted and de-duplicated.
 *
 * Turning off the last remaining day is *allowed* here and rejected by
 * `validateDraft`. Refusing the click would leave the user pressing a button
 * that does nothing with no explanation; letting it happen and then saying
 * "pick at least one working day" is the same guard with a reason attached.
 */
export function toggleWorkDay(days: readonly number[], day: number): number[] {
  if (!isWeekday(day)) return [...days];

  const next = days.includes(day) ? days.filter((existing) => existing !== day) : [...days, day];
  return [...new Set(next)].sort((a, b) => a - b);
}

/**
 * Everything wrong with a draft, in the order the fields appear on the panel.
 *
 * An empty array means the draft is safe to apply.
 */
export function validateDraft(draft: SettingsDraft): SettingsIssue[] {
  const issues: SettingsIssue[] = [];

  const start = parseClock(draft.workStart);
  const end = parseClock(draft.workEnd);

  if (start === null) {
    issues.push({ field: 'workStart', message: 'Start time needs to look like 09:00.' });
  }
  if (end === null) {
    issues.push({ field: 'workEnd', message: 'End time needs to look like 17:00.' });
  }
  // Only meaningful once both parse; otherwise the message above is the useful one.
  if (start !== null && end !== null && start >= end) {
    issues.push({ field: 'workEnd', message: 'The work day has to end after it starts.' });
  }

  // Deliberately stricter than `parseInt`, which reads `10abc` as 10 and would
  // silently accept a typo the user meant to fix.
  const snooze = draft.snoozeMinutes.trim();
  if (!/^\d+$/.test(snooze)) {
    issues.push({
      field: 'snoozeMinutes',
      message: 'Snooze needs to be a whole number of minutes.',
    });
  } else {
    const minutes = Number(snooze);
    if (minutes < MIN_SNOOZE_MINUTES || minutes > MAX_SNOOZE_MINUTES) {
      issues.push({
        field: 'snoozeMinutes',
        message: `Snooze has to be between ${String(MIN_SNOOZE_MINUTES)} and ${String(MAX_SNOOZE_MINUTES)} minutes.`,
      });
    }
  }

  if (draft.workDays.filter(isWeekday).length === 0) {
    issues.push({ field: 'workDays', message: 'Pick at least one working day.' });
  }

  return issues;
}

/**
 * Fold a draft into settings, normalizing as it goes (`9:00` becomes `09:00`).
 *
 * Total by construction: anything unusable keeps the value from `base` rather
 * than throwing. Callers are expected to run `validateDraft` first and show the
 * issues — this fallback exists so that a validation gap can only ever cost an
 * unapplied field, never a corrupted settings file.
 *
 * Fields the panel doesn't edit (`vaultDir`) ride along from `base`.
 */
export function applyDraft(base: Settings, draft: SettingsDraft): Settings {
  const start = parseClock(draft.workStart);
  const end = parseClock(draft.workEnd);
  const snooze = Number(draft.snoozeMinutes.trim());
  const days = [...new Set(draft.workDays.filter(isWeekday))].sort((a, b) => a - b);

  const settings: Settings = {
    ...base,
    workStart: start === null ? base.workStart : formatClock(start),
    workEnd: end === null ? base.workEnd : formatClock(end),
    hourlyEnabled: draft.hourlyEnabled,
    snoozeMinutes:
      draft.snoozeMinutes.trim() !== '' && Number.isFinite(snooze)
        ? Math.min(MAX_SNOOZE_MINUTES, Math.max(MIN_SNOOZE_MINUTES, Math.round(snooze)))
        : base.snoozeMinutes,
    workDays: days.length > 0 ? days : [...base.workDays],
    managerModeEnabled: draft.managerModeEnabled,
  };

  // The same pairing rule `parseSettings` applies: a window that ends before it
  // starts makes every slot calculation nonsense, so the pair reverts together
  // rather than half-applying and leaving an unschedulable day.
  const resolvedStart = parseClock(settings.workStart);
  const resolvedEnd = parseClock(settings.workEnd);
  if (resolvedStart === null || resolvedEnd === null || resolvedStart >= resolvedEnd) {
    settings.workStart = base.workStart;
    settings.workEnd = base.workEnd;
  }

  return settings;
}
