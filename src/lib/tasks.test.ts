import { describe, expect, it } from 'vitest';

import {
  addTask,
  carryOverTasks,
  completedBeforeCheckIn,
  cycleStatus,
  isCarriedOver,
  isOpen,
  removeTask,
  sameTask,
  setTaskStatus,
  summarizeTasks,
  tasksForCheckIn,
  type Task,
} from './tasks.ts';

const TASKS: Task[] = [
  { title: 'Draft the RFC', status: 'upcoming' },
  { title: 'Ship the rollback', status: 'in-progress' },
  { title: 'Review the checklist', status: 'completed' },
];

describe('isOpen', () => {
  it('counts upcoming and in-progress as open', () => {
    expect(isOpen({ title: 'a', status: 'upcoming' })).toBe(true);
    expect(isOpen({ title: 'b', status: 'in-progress' })).toBe(true);
    expect(isOpen({ title: 'c', status: 'completed' })).toBe(false);
  });
});

describe('sameTask', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(sameTask('Draft the RFC', '  draft the rfc  ')).toBe(true);
  });

  it('distinguishes different titles', () => {
    expect(sameTask('Draft the RFC', 'Draft the ADR')).toBe(false);
  });
});

describe('cycleStatus', () => {
  it('advances upcoming → in-progress → completed → upcoming', () => {
    expect(cycleStatus('upcoming')).toBe('in-progress');
    expect(cycleStatus('in-progress')).toBe('completed');
    expect(cycleStatus('completed')).toBe('upcoming');
  });

  it('returns to the start after three steps', () => {
    expect(cycleStatus(cycleStatus(cycleStatus('upcoming')))).toBe('upcoming');
  });
});

describe('tasksForCheckIn', () => {
  it('puts in-progress work first, then upcoming, then completed', () => {
    expect(tasksForCheckIn(TASKS).map((task) => task.title)).toEqual([
      'Ship the rollback',
      'Draft the RFC',
      'Review the checklist',
    ]);
  });

  it('preserves relative order within each group', () => {
    const tasks: Task[] = [
      { title: 'First done', status: 'completed' },
      { title: 'Still open', status: 'upcoming' },
      { title: 'Second done', status: 'completed' },
      { title: 'Also open', status: 'in-progress' },
    ];

    expect(tasksForCheckIn(tasks).map((task) => task.title)).toEqual([
      'Also open',
      'Still open',
      'First done',
      'Second done',
    ]);
  });

  it('hides tasks that were already done when the check-in opened', () => {
    const tasks: Task[] = [
      { title: 'Old done', status: 'completed' },
      { title: 'Still open', status: 'upcoming' },
      { title: 'Just finished', status: 'completed' },
    ];

    expect(tasksForCheckIn(tasks, new Set(['Old done'])).map((task) => task.title)).toEqual([
      'Still open',
      'Just finished',
    ]);
  });
});

describe('completedBeforeCheckIn', () => {
  it('snapshots completed titles from the opening task list', () => {
    expect(completedBeforeCheckIn(TASKS)).toEqual(new Set(['Review the checklist']));
  });
});

describe('addTask', () => {
  it('appends a new task as upcoming by default', () => {
    expect(addTask([], 'New thing')).toEqual([{ title: 'New thing', status: 'upcoming' }]);
  });

  it('trims the title', () => {
    expect(addTask([], '  padded  ')[0]?.title).toBe('padded');
  });

  it('ignores a blank title', () => {
    expect(addTask([], '   ')).toEqual([]);
  });

  it('ignores a duplicate regardless of case', () => {
    expect(addTask(TASKS, 'draft the rfc')).toHaveLength(TASKS.length);
  });

  it('accepts an explicit status', () => {
    expect(addTask([], 'Started', 'in-progress')[0]?.status).toBe('in-progress');
  });

  it('stamps the day it was added when one is supplied', () => {
    expect(addTask([], 'New thing', 'upcoming', '2026-08-05')[0]?.added).toBe('2026-08-05');
  });

  it('omits the date entirely when none is supplied', () => {
    expect(addTask([], 'New thing')[0]).not.toHaveProperty('added');
  });

  it('does not mutate the input', () => {
    const input: Task[] = [];
    addTask(input, 'New thing');
    expect(input).toEqual([]);
  });
});

describe('setTaskStatus', () => {
  it('updates the matching task only', () => {
    const updated = setTaskStatus(TASKS, 'Draft the RFC', 'completed');
    expect(updated[0]?.status).toBe('completed');
    expect(updated[1]?.status).toBe('in-progress');
  });

  it('matches case-insensitively', () => {
    expect(setTaskStatus(TASKS, 'draft the rfc', 'completed')[0]?.status).toBe('completed');
  });

  it('is a no-op for an unknown title', () => {
    expect(setTaskStatus(TASKS, 'Nope', 'completed')).toEqual(TASKS);
  });

  it('does not mutate the input', () => {
    setTaskStatus(TASKS, 'Draft the RFC', 'completed');
    expect(TASKS[0]?.status).toBe('upcoming');
  });
});

describe('removeTask', () => {
  it('drops the matching task', () => {
    expect(removeTask(TASKS, 'Draft the RFC').map((task) => task.title)).toEqual([
      'Ship the rollback',
      'Review the checklist',
    ]);
  });

  it('is a no-op for an unknown title', () => {
    expect(removeTask(TASKS, 'Nope')).toHaveLength(3);
  });
});

describe('carryOverTasks', () => {
  it('carries open tasks and leaves completed ones behind', () => {
    expect(carryOverTasks(TASKS, '2026-08-03').map((task) => task.title)).toEqual([
      'Draft the RFC',
      'Ship the rollback',
    ]);
  });

  it('preserves the in-progress status rather than resetting it', () => {
    const carried = carryOverTasks(TASKS, '2026-08-03');
    expect(carried.find((task) => task.title === 'Ship the rollback')?.status).toBe('in-progress');
  });

  it('stamps an undated task with the day it is carried from', () => {
    expect(carryOverTasks(TASKS, '2026-08-03').every((task) => task.added === '2026-08-03')).toBe(
      true,
    );
  });

  it('keeps the original date through repeated carry-overs', () => {
    let tasks = carryOverTasks(TASKS, '2026-08-03');
    for (const date of ['2026-08-04', '2026-08-05', '2026-08-06']) {
      tasks = carryOverTasks(tasks, date);
    }

    expect(tasks.every((task) => task.added === '2026-08-03')).toBe(true);
  });

  it('returns nothing when the previous day is fully complete', () => {
    expect(carryOverTasks([{ title: 'Done', status: 'completed' }], '2026-08-03')).toEqual([]);
  });

  it('does not mutate the previous day', () => {
    carryOverTasks(TASKS, '2026-08-03');
    expect(TASKS[0]?.added).toBeUndefined();
  });
});

describe('isCarriedOver', () => {
  it('is true when the task predates the day it is sitting in', () => {
    expect(
      isCarriedOver({ title: 'a', status: 'upcoming', added: '2026-08-03' }, '2026-08-05'),
    ).toBe(true);
  });

  it('is false for a task added on the day itself', () => {
    expect(
      isCarriedOver({ title: 'a', status: 'upcoming', added: '2026-08-05' }, '2026-08-05'),
    ).toBe(false);
  });

  it('is false when the task has no date at all', () => {
    expect(isCarriedOver({ title: 'a', status: 'upcoming' }, '2026-08-05')).toBe(false);
  });
});

describe('summarizeTasks', () => {
  it('counts by status', () => {
    expect(summarizeTasks(TASKS)).toEqual({
      upcoming: 1,
      inProgress: 1,
      completed: 1,
      open: 2,
      total: 3,
    });
  });

  it('handles an empty list', () => {
    expect(summarizeTasks([])).toEqual({
      upcoming: 0,
      inProgress: 0,
      completed: 0,
      open: 0,
      total: 0,
    });
  });
});
