/**
 * One-shot backfill: reconstruct task provenance for a vault written before
 * day files recorded it, and stamp those files as `format: 2`.
 *
 * This is deliberately *not* part of the app. The app cannot upgrade a legacy
 * file in place, because at the moment it touches one it has no evidence about
 * tasks that predate the field — stamping v2 there would manufacture start
 * dates nobody recorded. A backfill is a different situation entirely: it has
 * the whole vault at once, it derives each date from the file the task actually
 * first appears in, and a human reviews the result before anything is written.
 * That is reconstruction from primary sources, not invention.
 *
 * It is exact for a vault that begins when the app did, since nothing can
 * predate the first file. For a vault assembled some other way, the earliest
 * file is a floor rather than a fact — the same caveat `CONTEXT.md` states.
 *
 * Usage:
 *
 * ```
 * node --experimental-strip-types scripts/backfill-provenance.ts <vault-dir>
 * node --experimental-strip-types scripts/backfill-provenance.ts <vault-dir> --write
 * ```
 *
 * Without `--write` it prints the full diff and changes nothing. With it, the
 * whole vault is copied to a timestamped sibling folder first.
 */

import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DateKey } from '../src/lib/dates.ts';
import { parseDay, serializeDay, DAY_FORMAT_VERSION } from '../src/lib/markdown/day.ts';
import type { DayDocument } from '../src/lib/markdown/day.ts';

/**
 * Title identity. Must stay in step with `sameTask` in `src/lib/tasks.ts` — the
 * backfill has to group titles exactly as the app does, or it will date two
 * spellings of one task as two separate runs.
 */
function normalize(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * The day each task's *current run* began, per file.
 *
 * A run is a contiguous stretch of day files containing the title — contiguous
 * in file order, not calendar days, because weekends and days off leave gaps
 * that carry-over deliberately spans. When a title disappears and later comes
 * back, that is a new piece of work reusing a name, not a task that was open
 * the whole time: a naive "earliest sighting" would report a recurring title
 * like "triage the queue" as having been open for the entire fortnight.
 */
export function deriveRunStarts(
  days: readonly { date: DateKey; titles: readonly string[] }[],
): Map<DateKey, Map<string, DateKey>> {
  // Titles present in the previous file, mapped to the day their run started.
  const openRuns = new Map<string, DateKey>();
  const byDate = new Map<DateKey, Map<string, DateKey>>();

  for (const day of days) {
    const present = new Set<string>();
    const starts = new Map<string, DateKey>();

    for (const title of day.titles) {
      const key = normalize(title);
      present.add(key);

      // Absent from the previous file means this is the start of a new run.
      const start = openRuns.get(key) ?? day.date;
      openRuns.set(key, start);
      starts.set(key, start);
    }

    // A title missing from this file has ended its run; the next sighting
    // starts a fresh one.
    for (const key of [...openRuns.keys()]) {
      if (!present.has(key)) openRuns.delete(key);
    }

    byDate.set(day.date, starts);
  }

  return byDate;
}

/** Apply derived run starts to a day document, and stamp the current format. */
export function backfillDay(day: DayDocument, starts: ReadonlyMap<string, DateKey>): DayDocument {
  return {
    ...day,
    formatVersion: DAY_FORMAT_VERSION,
    tasks: day.tasks.map((task) => ({
      ...task,
      added: starts.get(normalize(task.title)) ?? day.date,
    })),
  };
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

interface Loaded {
  name: string;
  date: DateKey;
  source: string;
  document: DayDocument;
}

async function loadDays(dir: string): Promise<Loaded[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Mistyping the vault path is the likeliest way to misuse this, and a raw
    // ENOENT stack trace reads like the script is broken rather than the path.
    throw new Error(
      `Can't read a vault at ${dir}\n` +
        'Pass the folder holding your YYYY-MM-DD.md files — by default\n' +
        'Documents/TaskTracker, or whatever `vaultDir` in settings.json points at.',
    );
  }

  const loaded: Loaded[] = [];

  for (const name of entries.sort()) {
    const match = DAY_FILE.exec(name);
    const date = match?.[1];
    if (date === undefined) continue;

    const source = await readFile(join(dir, name), 'utf8');
    loaded.push({
      name,
      date,
      source,
      // The fallbacks only apply to a file missing its own frontmatter; the
      // date is recovered from the filename either way.
      document: parseDay(source, { date, workStart: '09:00', workEnd: '17:00' }),
    });
  }

  return loaded;
}

/**
 * A real diff, via longest common subsequence.
 *
 * Aligning by line index instead makes a single inserted line (`format: 2`)
 * report every subsequent line as changed, which buries the actual edits and —
 * worse — makes preserved content look deleted. Nobody can approve a rewrite of
 * their own notes from a diff that cries wolf. Files are a few dozen lines, so
 * the quadratic table costs nothing.
 */
export function diffLines(before: string, after: string): string[] {
  const from = before.split('\n');
  const to = after.split('\n');
  const n = from.length;
  const m = to.length;

  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = table[i] ?? [];
      const below = table[i + 1] ?? [];
      row[j] =
        from[i] === to[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const marks: { mark: string; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (from[i] === to[j]) {
      marks.push({ mark: ' ', line: from[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      marks.push({ mark: '-', line: from[i] ?? '' });
      i += 1;
    } else {
      marks.push({ mark: '+', line: to[j] ?? '' });
      j += 1;
    }
  }
  for (; i < n; i += 1) marks.push({ mark: '-', line: from[i] ?? '' });
  for (; j < m; j += 1) marks.push({ mark: '+', line: to[j] ?? '' });

  // Two lines of context around each change; elide the rest.
  const CONTEXT = 2;
  const keep = new Set<number>();
  marks.forEach((entry, index) => {
    if (entry.mark === ' ') return;
    for (let k = index - CONTEXT; k <= index + CONTEXT; k += 1) {
      if (k >= 0 && k < marks.length) keep.add(k);
    }
  });

  const out: string[] = [];
  let elided = false;
  marks.forEach((entry, index) => {
    if (!keep.has(index)) {
      if (!elided) out.push('  …');
      elided = true;
      return;
    }
    elided = false;
    out.push(`  ${entry.mark} ${entry.line}`);
  });

  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const dir = args.find((arg) => !arg.startsWith('--'));

  if (dir === undefined) {
    console.error(
      'Usage: node --experimental-strip-types scripts/backfill-provenance.ts <vault-dir> [--write]',
    );
    process.exitCode = 1;
    return;
  }

  const vault = resolve(dir);
  const days = await loadDays(vault);

  if (days.length === 0) {
    console.error(`No day files (YYYY-MM-DD.md) found in ${vault}`);
    process.exitCode = 1;
    return;
  }

  const runStarts = deriveRunStarts(
    days.map((day) => ({ date: day.date, titles: day.document.tasks.map((task) => task.title) })),
  );

  const changes = days
    .map((day) => {
      const next = serializeDay(backfillDay(day.document, runStarts.get(day.date) ?? new Map()));
      return { ...day, next };
    })
    .filter((day) => day.next !== day.source);

  console.log(`Vault: ${vault}`);
  console.log(`Day files: ${String(days.length)} (${days[0]?.date} … ${days.at(-1)?.date})`);
  console.log(`Files that would change: ${String(changes.length)}\n`);

  for (const change of changes) {
    console.log(change.name);

    // The summary is the thing to actually review; the diff below it is there
    // so you can satisfy yourself nothing else moved.
    const derived = runStarts.get(change.date) ?? new Map<string, DateKey>();
    for (const task of change.document.tasks) {
      const start = derived.get(normalize(task.title)) ?? change.date;
      const span = start === change.date ? 'started here' : `open since ${start}`;
      console.log(`    ${task.title} — ${span}`);
    }

    console.log('');
    for (const line of diffLines(change.source, change.next)) console.log(line);
    console.log('');
  }

  if (changes.length === 0) {
    console.log('Nothing to do — every file already carries the provenance it can.');
    return;
  }

  if (!write) {
    console.log('Dry run. Re-run with --write to apply, after reading the diff above.');
    console.log(
      'Note: files are rewritten in the app’s canonical form, so headings, note\n' +
        'order and empty-section placeholders may normalize too. That is what the\n' +
        'next check-in would have done to them anyway.',
    );
    return;
  }

  const backup = join(dirname(vault), `${basename(vault)}-backup-${Date.now().toString()}`);
  await cp(vault, backup, { recursive: true });
  console.log(`Backed up the whole vault to ${backup}`);

  for (const change of changes) {
    await writeFile(join(vault, change.name), change.next, 'utf8');
  }

  console.log(`Rewrote ${String(changes.length)} file(s).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
