/**
 * The task model and its transitions.
 *
 * Deliberately three states, a title, and the date it first appeared. Every
 * extra field the *user* has to fill is friction on a prompt you see eight
 * times a day, and a check-in you resent filling in is a check-in you stop
 * filling in — so `added` is stamped by the app and never typed. Projects,
 * estimates and time tracking are tracked in `docs/future-work.md`, not here.
 */

import type { DateKey } from './dates.ts';

/** Where a task stands. Mirrors the checkbox markers in the day file. */
export type TaskStatus = 'upcoming' | 'in-progress' | 'completed';

export interface Task {
  /** Free text, exactly as typed. Rendered with `textContent`, never HTML. */
  title: string;
  status: TaskStatus;
  /**
   * The day this task first appeared, preserved as it carries forward.
   *
   * This is the one thing about a task that cannot be recovered by reading the
   * file it lives in. A day file's own date tells you when a task was
   * *completed* — the `[x]` is sitting in that day. Nothing tells you when it
   * started, so "this took five days" and "this kept slipping" are only
   * answerable by diffing consecutive files and matching on title, which is
   * exactly the kind of reconstruction an agent does confidently and wrong.
   *
   * Optional because team-file tasks (`team.<person>.md`) don't carry it —
   * that file spans many days and stamps completion instead.
   */
  added?: DateKey;
}

/** Statuses that mean "still on your plate". */
export const OPEN_STATUSES: readonly TaskStatus[] = ['upcoming', 'in-progress'];

/** `true` when the task still needs work. */
export function isOpen(task: Task): boolean {
  return OPEN_STATUSES.includes(task.status);
}

/**
 * Compare two titles for identity. Tasks are keyed by title within a day — no
 * synthetic IDs, because an ID in the file is noise to every human and agent
 * that reads it. Case and surrounding whitespace are ignored so re-typing a
 * carried-over task doesn't duplicate it.
 */
export function sameTask(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The status a task moves to when its checkbox is clicked:
 * upcoming → in-progress → completed → upcoming.
 */
export function cycleStatus(status: TaskStatus): TaskStatus {
  switch (status) {
    case 'upcoming':
      return 'in-progress';
    case 'in-progress':
      return 'completed';
    case 'completed':
      return 'upcoming';
  }
}

/** Order tasks for the check-in card: in-progress, then upcoming, then newly completed. */
export function tasksForCheckIn(
  tasks: readonly Task[],
  previouslyCompleted: ReadonlySet<string> = new Set(),
): Task[] {
  const inProgress: Task[] = [];
  const upcoming: Task[] = [];
  const doneThisSession: Task[] = [];

  for (const task of tasks) {
    if (task.status === 'in-progress') {
      inProgress.push(task);
    } else if (task.status === 'upcoming') {
      upcoming.push(task);
    } else if (!wasCompletedBefore(task.title, previouslyCompleted)) {
      doneThisSession.push(task);
    }
  }

  return [...inProgress, ...upcoming, ...doneThisSession];
}

/** Titles that were already done when this check-in opened — hidden until day-end. */
export function completedBeforeCheckIn(tasks: readonly Task[]): Set<string> {
  const titles = new Set<string>();
  for (const task of tasks) {
    if (task.status === 'completed') titles.add(task.title);
  }
  return titles;
}

function wasCompletedBefore(title: string, previouslyCompleted: ReadonlySet<string>): boolean {
  for (const existing of previouslyCompleted) {
    if (sameTask(existing, title)) return true;
  }
  return false;
}

/**
 * Append a task, ignoring blank titles and exact duplicates.
 *
 * Returns a new array; the input is never mutated.
 */
export function addTask(
  tasks: readonly Task[],
  title: string,
  status: TaskStatus = 'upcoming',
  added?: DateKey,
): Task[] {
  const trimmed = title.trim();
  if (trimmed === '') return [...tasks];
  if (tasks.some((task) => sameTask(task.title, trimmed))) return [...tasks];

  return [...tasks, { title: trimmed, status, ...(added === undefined ? {} : { added }) }];
}

/** Set the status of the task matching `title`. Returns a new array. */
export function setTaskStatus(tasks: readonly Task[], title: string, status: TaskStatus): Task[] {
  return tasks.map((task) => (sameTask(task.title, title) ? { ...task, status } : task));
}

/** Remove the task matching `title`. Returns a new array. */
export function removeTask(tasks: readonly Task[], title: string): Task[] {
  return tasks.filter((task) => !sameTask(task.title, title));
}

/**
 * The open tasks to seed tomorrow with.
 *
 * Completed work stays behind in the day that finished it — carrying it forward
 * would make every day file an ever-growing copy of the last. In-progress tasks
 * keep their status (you were mid-flight, you still are); upcoming tasks stay
 * upcoming.
 *
 * `previousDate` is the day being carried *from*, and stamps any task that has
 * no `added` date yet — a file written before this field existed, or one a hand
 * edit introduced a task into. It is a floor, not a correction: the task was
 * demonstrably alive on that day, even if it first appeared earlier.
 */
export function carryOverTasks(previous: readonly Task[], previousDate: DateKey): Task[] {
  return previous.filter(isOpen).map((task) => ({
    title: task.title,
    status: task.status,
    added: task.added ?? previousDate,
  }));
}

/**
 * `true` when this task reached `dayDate` from an earlier day — what the card
 * marks as "slipped".
 *
 * Derived rather than stored: a flag set at carry-over time is gone the moment
 * the app restarts and re-reads the file, so the marker used to vanish mid-day
 * for exactly the tasks it was there to highlight.
 */
export function isCarriedOver(task: Task, dayDate: DateKey): boolean {
  return task.added !== undefined && task.added < dayDate;
}

/** Counts by status, for the tray tooltip and the day heading. */
export interface TaskSummary {
  upcoming: number;
  inProgress: number;
  completed: number;
  open: number;
  total: number;
}

export function summarizeTasks(tasks: readonly Task[]): TaskSummary {
  const upcoming = tasks.filter((task) => task.status === 'upcoming').length;
  const inProgress = tasks.filter((task) => task.status === 'in-progress').length;
  const completed = tasks.filter((task) => task.status === 'completed').length;

  return {
    upcoming,
    inProgress,
    completed,
    open: upcoming + inProgress,
    total: tasks.length,
  };
}
