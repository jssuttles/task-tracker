/**
 * The day file: parse and serialize `YYYY-MM-DD.md`.
 *
 * This format *is* the database. Two consequences drive every decision here:
 *
 * 1. **It has to read well.** A human opening the file, and an agent asked
 *    "what did I do in July?", both see the same plain Markdown. No synthetic
 *    IDs, no HTML comment metadata, no base64.
 * 2. **Hand edits have to survive.** You (or an agent) may edit a day file
 *    directly. Any section this module doesn't own is preserved verbatim and
 *    written back out, so an app write never eats content it didn't author.
 *
 * ```markdown
 * ---
 * format: 2
 * date: 2026-08-02
 * work_start: 09:00
 * work_end: 17:00
 * ---
 *
 * # Sunday, 2 August 2026
 *
 * ## Tasks
 *
 * - [ ] Draft the RFC _(added 2026-07-30)_
 * - [/] Ship the migration rollback
 * - [x] Review the release checklist
 *
 * ## Notes
 *
 * - 10:15 — @alice unblocked the release single-handedly #kudos
 * ```
 *
 * The `_(added …)_` suffix appears only when a task predates the file it is
 * sitting in, so its presence *is* the carried-over marker and a clean day of
 * fresh work stays free of annotation. Combined with the file's own date — the
 * day an `[x]` was finished — one line answers "how long did this take" without
 * reading a single other file. It is labelled rather than the bare `_(date)_`
 * the team file uses for *completion*, because the two files sit in one folder
 * and an unlabelled date that means opposite things in each is a trap for
 * whoever reads the vault next.
 *
 * ## `format`
 *
 * The absence of a suffix means two different things depending on who wrote the
 * file, and that difference is not otherwise visible:
 *
 * - In a file this format wrote, the task provably first appeared that day.
 * - In a file written before the suffix existed, we simply don't know — it may
 *   have been carried for weeks.
 *
 * `format` resolves it. A file the app *creates* is stamped with the current
 * version, and one it merely *edits* keeps whatever version it already had, so
 * the app never retroactively vouches for dates it can't actually prove. A
 * legacy file has no `format` key and is version 1.
 *
 * A version this build doesn't recognize is preserved rather than overwritten —
 * the same rule as unowned keys and sections. Downgrading must not strip a
 * newer format's marker and leave the file claiming to be something it isn't.
 */

import { describeDate, fromDateKey, parseClock, type Clock, type DateKey } from '../dates.ts';
import type { Task, TaskStatus } from '../tasks.ts';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { splitSections, trimBlankEdges, type ExtraSection } from './sections.ts';

export type { ExtraSection } from './sections.ts';

/** A timestamped thought. `time` is local `HH:MM`. */
export interface Note {
  time: Clock;
  text: string;
}

/**
 * The version stamped on day files this build creates.
 *
 * Bump this when the meaning of existing syntax changes, not merely when
 * something is added — a reader that ignores an unknown addition still reads
 * the file correctly, but one that misreads a changed meaning does so silently.
 *
 * - **1** — implicit; no `format` key. Tasks carry no provenance, so an
 *   undated task's start date is unknown, floored at the file's own date.
 * - **2** — tasks carry `_(added …)_` when they outlive the day they appeared,
 *   so an *un*annotated task is a positive claim: it started here.
 */
export const DAY_FORMAT_VERSION = 2;

export interface DayDocument {
  /**
   * Which revision of this format the file is written in. See
   * `DAY_FORMAT_VERSION`. Preserved on read so editing a file never upgrades
   * the claims it makes about data written by an older build.
   */
  formatVersion: number;
  date: DateKey;
  workStart: Clock;
  workEnd: Clock;
  /**
   * The check-in slot most recently handled on this day, as local `HH:MM`.
   *
   * This is the scheduler's memory, and it lives in the day file rather than in
   * app state on purpose: the machine can be rebooted, the app quit, or the
   * process killed at any point in the workday. Without it, relaunching at 14:30
   * re-prompts for the 14:00 slot you already completed — and an app that nags
   * you for work you've done is one you stop running.
   *
   * `undefined` means no check-in has been handled yet today.
   */
  lastCheckIn?: Clock;
  tasks: Task[];
  notes: Note[];
  /** Frontmatter keys we don't own, kept so hand-added keys survive a write. */
  extraFields: Record<string, string>;
  /** Sections we don't own, kept in file order and re-emitted after Notes. */
  extraSections: ExtraSection[];
}

const TASKS_HEADING = '## Tasks';
const NOTES_HEADING = '## Notes';

/** Checkbox marker ↔ status. `/` for in-progress follows the Obsidian Tasks convention. */
const MARKER_TO_STATUS: Record<string, TaskStatus> = {
  ' ': 'upcoming',
  '/': 'in-progress',
  x: 'completed',
  X: 'completed',
};

const STATUS_TO_MARKER: Record<TaskStatus, string> = {
  upcoming: ' ',
  'in-progress': '/',
  completed: 'x',
};

const TASK_PATTERN = /^\s*[-*]\s*\[(.)\]\s*(.*)$/;
/** A trailing `_(added 2026-07-30)_` — see the module doc. */
const ADDED_DATE_PATTERN = /\s*_\(added (\d{4}-\d{2}-\d{2})\)_\s*$/;
/** `- 10:15 — text`, accepting an em dash, en dash or hyphen as the separator. */
const NOTE_PATTERN = /^\s*[-*]\s*(\d{1,2}:\d{2})\s*[—–-]\s*(.*)$/;

/** Owned frontmatter keys, in the order they're written. */
const OWNED_FIELDS = ['format', 'date', 'work_start', 'work_end', 'last_check_in'];

/**
 * Read the `format` key, defaulting to 1 for a file that has none.
 *
 * Anything unparseable is also 1: a corrupt version has to mean "assume the
 * weakest guarantees", never "assume the strongest".
 */
function parseFormatVersion(raw: string | undefined): number {
  if (raw === undefined) return 1;

  const version = Number(raw);
  return Number.isInteger(version) && version >= 1 ? version : 1;
}

/**
 * `date` is the file's own date, and is the default `added` for any task
 * without the suffix: an unannotated line means "first appeared here", which is
 * what every file written before the field existed is truthfully saying.
 */
function parseTasks(lines: readonly string[], date: DateKey): Task[] {
  const tasks: Task[] = [];

  for (const line of lines) {
    const match = TASK_PATTERN.exec(line);
    if (match === null) continue;

    const status = MARKER_TO_STATUS[match[1] ?? ''];
    let title = (match[2] ?? '').trim();
    // An unknown marker means someone is using a convention we don't model;
    // skipping keeps the line intact on the next write rather than guessing.
    if (status === undefined || title === '') continue;

    let added = date;
    const dateMatch = ADDED_DATE_PATTERN.exec(title);
    if (dateMatch !== null) {
      const annotated = dateMatch[1];
      const stripped = title.slice(0, dateMatch.index).trim();
      // A suffix with nothing in front of it is someone's prose, not a task.
      if (annotated !== undefined && stripped !== '') {
        title = stripped;
        added = annotated;
      }
    }

    tasks.push({ title, status, added });
  }

  return tasks;
}

function parseNotes(lines: readonly string[]): Note[] {
  const notes: Note[] = [];

  for (const line of lines) {
    const match = NOTE_PATTERN.exec(line);
    if (match === null) continue;

    const time = match[1] ?? '';
    const text = (match[2] ?? '').trim();
    if (text === '') continue;

    // Normalize `9:05` to `09:05` so sorting and rendering stay uniform.
    notes.push({ time: time.padStart(5, '0'), text });
  }

  return notes;
}

/**
 * Parse a day file. Never throws: a malformed or empty file yields a document
 * with the supplied fallbacks, because losing a day's notes to a parse error is
 * far worse than tolerating a stray line.
 */
export function parseDay(
  source: string,
  fallback: { date: DateKey; workStart: Clock; workEnd: Clock },
): DayDocument {
  const { fields, body } = parseFrontmatter(source);
  const { sections } = splitSections(body);

  const extraFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!OWNED_FIELDS.includes(key)) extraFields[key] = value;
  }

  const date = fields.date ?? fallback.date;

  let tasks: Task[] = [];
  let notes: Note[] = [];
  const extraSections: ExtraSection[] = [];

  for (const section of sections) {
    if (section.heading === TASKS_HEADING) {
      tasks = parseTasks(section.lines, date);
    } else if (section.heading === NOTES_HEADING) {
      notes = parseNotes(section.lines);
    } else {
      extraSections.push({ heading: section.heading, lines: [...section.lines] });
    }
  }

  // A malformed hand-edited value is dropped rather than trusted: a bad slot key
  // would suppress check-ins for the rest of the day, which fails silently.
  const lastCheckIn = fields.last_check_in;
  const validLastCheckIn =
    lastCheckIn !== undefined && parseClock(lastCheckIn) !== null ? lastCheckIn : undefined;

  return {
    formatVersion: parseFormatVersion(fields.format),
    date,
    workStart: fields.work_start ?? fallback.workStart,
    workEnd: fields.work_end ?? fallback.workEnd,
    ...(validLastCheckIn === undefined ? {} : { lastCheckIn: validLastCheckIn }),
    tasks,
    notes,
    extraFields,
    extraSections,
  };
}

/** Render a day document back to Markdown. Round-trips with `parseDay`. */
export function serializeDay(day: DayDocument): string {
  const fields: Record<string, string> = {
    // Version 1 is the unversioned legacy format — writing `format: 1` would
    // invent a key the format it describes never had.
    ...(day.formatVersion <= 1 ? {} : { format: String(day.formatVersion) }),
    date: day.date,
    work_start: day.workStart,
    work_end: day.workEnd,
    ...(day.lastCheckIn === undefined ? {} : { last_check_in: day.lastCheckIn }),
    ...day.extraFields,
  };

  const parsed = fromDateKey(day.date);
  const heading = parsed === null ? day.date : describeDate(parsed);

  const blocks: string[] = [`# ${heading}`];

  const taskLines = day.tasks.map((task) => {
    // Only when it differs from this file's own date — see the module doc.
    const carried = task.added !== undefined && task.added !== day.date;
    const suffix = carried ? ` _(added ${String(task.added)})_` : '';
    return `- [${STATUS_TO_MARKER[task.status]}] ${task.title.trim()}${suffix}`;
  });
  blocks.push(
    [TASKS_HEADING, '', ...(taskLines.length > 0 ? taskLines : ['_No tasks yet._'])].join('\n'),
  );

  const noteLines = [...day.notes]
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((note) => `- ${note.time} — ${note.text.trim()}`);
  blocks.push(
    [NOTES_HEADING, '', ...(noteLines.length > 0 ? noteLines : ['_No notes yet._'])].join('\n'),
  );

  for (const section of day.extraSections) {
    blocks.push([section.heading, '', ...trimBlankEdges(section.lines)].join('\n'));
  }

  return `${serializeFrontmatter(fields)}\n${blocks.join('\n\n')}\n`;
}

/** A fresh day document, optionally seeded with tasks carried over from before. */
export function createDay(
  date: DateKey,
  workStart: Clock,
  workEnd: Clock,
  tasks: readonly Task[] = [],
): DayDocument {
  return {
    // The app is creating this file, so it can vouch for everything in it.
    formatVersion: DAY_FORMAT_VERSION,
    date,
    workStart,
    workEnd,
    // Anything arriving without provenance first appeared here, by definition.
    tasks: tasks.map((task) => ({ ...task, added: task.added ?? date })),
    notes: [],
    extraFields: {},
    extraSections: [],
  };
}

/** Append a note. Returns a new document; the input is never mutated. */
export function addNote(day: DayDocument, time: Clock, text: string): DayDocument {
  const trimmed = text.trim();
  if (trimmed === '') return day;

  return { ...day, notes: [...day.notes, { time, text: trimmed }] };
}
