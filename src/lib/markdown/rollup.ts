/**
 * Derived views over day files: the clipboard standup and the weekly rollup.
 *
 * Neither is an "export" in the usual sense — the day files are already the
 * durable artifact. These exist because the two moments where logging pays off
 * are *standup tomorrow morning* and *review season in December*, and both want
 * the data reshaped rather than re-entered.
 *
 * The weekly rollup is written back into the vault as `YYYY-Www.md` so an agent
 * asked about a quarter can read 13 rollups instead of 65 day files.
 */

import { fromDateKey, describeDate, toWeekKey, type DateKey } from '../dates.ts';
import { extractPeople, isBlocker, isKudos } from './mentions.ts';
import type { DayDocument } from './day.ts';
import type { TeamMemberDocument, TeamNote } from './team.ts';

function heading(day: DayDocument): string {
  const parsed = fromDateKey(day.date);
  return parsed === null ? day.date : describeDate(parsed);
}

function titles(day: DayDocument, statuses: readonly string[]): string[] {
  return day.tasks.filter((task) => statuses.includes(task.status)).map((task) => task.title);
}

function bulletList(items: readonly string[], empty: string): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${empty}`];
}

/**
 * The standup summary, ready to paste into Slack or a status doc.
 *
 * Plain text rather than Markdown-with-headings: it's going into a chat box, and
 * `##` renders as literal hashes in most of them.
 */
export function standupSummary(today: DayDocument, previous: DayDocument | null): string {
  const lines: string[] = [];

  if (previous !== null) {
    lines.push(`Since ${heading(previous)}:`);
    lines.push(...bulletList(titles(previous, ['completed']), 'Nothing marked complete'));
    lines.push('');
  }

  lines.push('Today:');
  lines.push(...bulletList(titles(today, ['in-progress', 'upcoming']), 'Nothing planned yet'));

  const blockers = today.notes.filter((note) => note.text.toLowerCase().includes('#blocker'));
  if (blockers.length > 0) {
    lines.push('');
    lines.push('Blockers:');
    lines.push(...blockers.map((note) => `- ${note.text}`));
  }

  return lines.join('\n');
}

/** Everything noteworthy about one person across a set of days. */
export interface PersonHighlight {
  person: string;
  moments: string[];
}

/**
 * Kudos-tagged notes grouped by the people they mention.
 *
 * This is the year-end-review payload. A note tagged `#kudos` that names nobody
 * is still worth keeping, so it's filed under `me` rather than dropped.
 */
export function collectKudos(days: readonly DayDocument[]): PersonHighlight[] {
  const byPerson = new Map<string, string[]>();

  for (const day of days) {
    for (const note of day.notes) {
      if (!isKudos(note.text)) continue;

      const people = extractPeople(note.text);
      const keys = people.length > 0 ? people : ['me'];
      for (const person of keys) {
        const moments = byPerson.get(person) ?? [];
        moments.push(`${day.date} — ${note.text}`);
        byPerson.set(person, moments);
      }
    }
  }

  return [...byPerson.entries()]
    .map(([person, moments]) => ({ person, moments }))
    .sort((a, b) => a.person.localeCompare(b.person));
}

/**
 * The weekly rollup file body.
 *
 * `days` may be any subset of the week (a four-day week, or a week still in
 * progress); the key is derived from the first day supplied.
 */
export function weeklyRollup(days: readonly DayDocument[]): string {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0];
  const weekKey =
    first === undefined ? 'unknown' : toWeekKey(fromDateKey(first.date) ?? new Date(0));

  const completed: string[] = [];
  const stillOpen: string[] = [];
  for (const day of sorted) {
    completed.push(...titles(day, ['completed']).map((title) => `${title} _(${day.date})_`));
  }
  const last = sorted[sorted.length - 1];
  if (last !== undefined) {
    stillOpen.push(...titles(last, ['in-progress', 'upcoming']));
  }

  const kudos = collectKudos(sorted);
  const kudosLines =
    kudos.length > 0
      ? kudos.flatMap(({ person, moments }) => [
          `### @${person}`,
          '',
          ...moments.map((moment) => `- ${moment}`),
          '',
        ])
      : ['_No kudos recorded this week._', ''];

  return [
    `# Week ${weekKey}`,
    '',
    `Days logged: ${String(sorted.length)}`,
    '',
    '## Completed',
    '',
    ...bulletList(completed, 'Nothing marked complete'),
    '',
    '## Still open',
    '',
    ...bulletList(stillOpen, 'Nothing outstanding'),
    '',
    '## Kudos',
    '',
    ...kudosLines,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .concat('\n');
}

/** The vault filename for the week containing `date`. */
export function weekFileName(date: DateKey): string | null {
  const parsed = fromDateKey(date);
  return parsed === null ? null : `${toWeekKey(parsed)}.md`;
}

/** The vault filename for the team rollup of the week containing `date`. */
export function teamWeekFileName(date: DateKey): string | null {
  const parsed = fromDateKey(date);
  return parsed === null ? null : `${toWeekKey(parsed)}-team.md`;
}

function formatNote(note: TeamNote): string {
  return `${note.text} _(${note.date})_`;
}

/** One completed task with the date it was finished. */
interface CompletedThisWeek {
  title: string;
  date: DateKey;
}

/**
 * A report's tasks marked completed within `[weekStart, weekEnd]`, oldest
 * first.
 *
 * Filtered by `completedDates`, not just status: a team task's status is a
 * permanent field on one running file, not scoped to a day the way a
 * personal day file's tasks are, so without this every week would repeat
 * every completion the report has ever had. A completed task with no
 * recorded date (a hand-checked box, say) is excluded rather than guessed
 * into some week it may not belong to.
 */
function completedThisWeek(
  member: TeamMemberDocument,
  weekStart: DateKey,
  weekEnd: DateKey,
): CompletedThisWeek[] {
  const entries: CompletedThisWeek[] = [];

  for (const task of member.tasks) {
    if (task.status !== 'completed') continue;

    const date = member.completedDates[task.title];
    if (date === undefined || date < weekStart || date > weekEnd) continue;

    entries.push({ title: task.title, date });
  }

  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The manager's weekly view: one section per tracked report.
 *
 * "Open" is always the *current* snapshot — there's no history of when a task
 * became open, so it reflects right now, not this week specifically. Notes
 * and completions both carry their own date and are scoped to the window;
 * without that, every week's rollup would repeat a report's entire history.
 *
 * `#kudos` and `#blocker` notes get their own sections, pulled out of "Notes
 * this week" rather than left to blend in — the same treatment the personal
 * weekly rollup already gives kudos (`collectKudos`), because in a report
 * meant for someone else to read, those are usually the whole point.
 */
export function teamWeeklyRollup(
  members: readonly TeamMemberDocument[],
  weekStart: DateKey,
  weekEnd: DateKey,
): string {
  const parsed = fromDateKey(weekStart);
  const weekKey = parsed === null ? 'unknown' : toWeekKey(parsed);
  const sorted = [...members].sort((a, b) => a.person.localeCompare(b.person));

  const sections =
    sorted.length > 0
      ? sorted.flatMap((member) => {
          const weekNotes = member.notes
            .filter((note) => note.date >= weekStart && note.date <= weekEnd)
            .sort((a, b) => a.date.localeCompare(b.date));

          const kudos = weekNotes.filter((note) => isKudos(note.text));
          const blockers = weekNotes.filter((note) => isBlocker(note.text));
          const otherNotes = weekNotes.filter(
            (note) => !isKudos(note.text) && !isBlocker(note.text),
          );

          const open = member.tasks
            .filter((task) => task.status !== 'completed')
            .map((task) => task.title);
          const completed = completedThisWeek(member, weekStart, weekEnd).map(
            (entry) => `${entry.title} _(${entry.date})_`,
          );

          return [
            `## @${member.person}`,
            '',
            ...(kudos.length > 0
              ? ['### Kudos', '', ...kudos.map((note) => `- ${formatNote(note)}`), '']
              : []),
            ...(blockers.length > 0
              ? ['### Blockers', '', ...blockers.map((note) => `- ${formatNote(note)}`), '']
              : []),
            '### Notes this week',
            '',
            ...bulletList(otherNotes.map(formatNote), 'Nothing logged this week'),
            '',
            '### Open',
            '',
            ...bulletList(open, 'Nothing tracked'),
            '',
            '### Completed',
            '',
            ...bulletList(completed, 'Nothing completed this week'),
            '',
          ];
        })
      : ['_No reports tracked yet._', ''];

  return [
    `# Team — Week ${weekKey}`,
    '',
    `Reports tracked: ${String(sorted.length)}`,
    '',
    ...sections,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .concat('\n');
}

/**
 * The team week with enough preamble to hand to an agent that cannot see the
 * vault — the manager-perspective sibling of `agentWeekBriefing`.
 *
 * Returns `null` when nothing is tracked yet, for the same reason
 * `agentWeekBriefing` does: an authoritative-looking briefing with nothing in
 * it is worse than the app saying it has nothing to give you.
 */
export function teamWeekBriefing(
  members: readonly TeamMemberDocument[],
  weekStart: DateKey,
  weekEnd: DateKey,
): string | null {
  if (members.length === 0) return null;

  return [
    "Below is one manager's notes on their direct reports, kept by Task Tracker. It",
    "reflects what the manager chose to log, not a complete record of each report's",
    'work.',
    '',
    'Conventions: each report has a `## @handle` section, with `### Kudos` and',
    '`### Blockers` pulled out separately whenever that report has a `#kudos`- or',
    '`#blocker`-tagged note this week — those are usually the most important thing in',
    'the report, so treat them as the headline, not a footnote among ordinary notes.',
    '"Open" is the *current* status of everything tracked for that person, not just',
    'this week — a task shown open may have been open for longer than the window',
    'below. "Notes this week" and "Completed" are both scoped to this window',
    'specifically: a task finished last week will not reappear under "Completed" here,',
    'and a note logged outside this window will not appear at all.',
    '',
    'Absence of a note or completion for a report this week means nothing was logged',
    'in that category, not that nothing happened.',
    '',
    '---',
    '',
    teamWeeklyRollup(members, weekStart, weekEnd),
  ].join('\n');
}

/**
 * The week's rollup with enough preamble to hand to an agent that cannot see
 * the vault.
 *
 * `CONTEXT.md` already explains the conventions, but it explains them *to a
 * reader of the folder*. This text exists for the opposite situation: it is
 * pasted into a chat with an agent that has no filesystem access and will never
 * see `CONTEXT.md`, so it has to carry its own key. Hence the preamble — and
 * hence the two disclaimers, which are the mistakes an agent reliably makes on
 * this data: reading a gap as "nothing happened" and reading "still open" as
 * "abandoned".
 *
 * Returns `null` for a week with no logged days. A briefing whose body is three
 * "Nothing" bullets tells an agent nothing while looking authoritative, and
 * that's worse than the app saying it has nothing to give you.
 */
export function agentWeekBriefing(days: readonly DayDocument[]): string | null {
  if (days.length === 0) return null;

  return [
    'Below is one week from a work journal kept by Task Tracker, a desktop app that',
    "prompts its user hourly to record what they're working on. It is the raw record,",
    'not a summary written afterwards.',
    '',
    'Conventions: `@name` is a colleague. `#tag` is a freeform label — `#kudos` marks a',
    'moment worth remembering at review time, `#blocker` something impeding progress,',
    '`#decision` a decision and its reasoning.',
    '',
    'Two things not to misread: "Still open" is the state at the end of the last logged',
    'day, not work that was abandoned; and a day with no entry means nothing was logged,',
    'not that nothing happened.',
    '',
    '---',
    '',
    weeklyRollup(days),
  ].join('\n');
}
