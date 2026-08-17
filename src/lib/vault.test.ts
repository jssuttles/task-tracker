import { describe, expect, it } from 'vitest';

import { serializeDay, createDay } from './markdown/day.ts';
import { createTeamMember, serializeTeamMember } from './markdown/team.ts';
import {
  dayFileName,
  dayKeyFromFileName,
  isPersonHandle,
  isSafeVaultName,
  listDayKeys,
  listTeamPeople,
  MemoryVault,
  openDay,
  openTeamMember,
  personFromFileName,
  previousDayKey,
  readDay,
  readDayRange,
  readTeamMember,
  teamFileName,
  todayKey,
  withinCarryOverHorizon,
  writeDay,
  writeTeamMember,
} from './vault.ts';

const HOURS = { start: '09:00', end: '17:00' };

function dayFile(date: string, tasks: Parameters<typeof createDay>[3] = []) {
  return serializeDay(createDay(date, HOURS.start, HOURS.end, tasks));
}

describe('isSafeVaultName', () => {
  it.each([
    '2026-08-02.md',
    '2026-W32.md',
    'CONTEXT.md',
    'team.alice.md',
    'team.alice-smith.md',
    'team.a.md',
    '2026-W32-team.md',
  ])('accepts %o', (name) => {
    expect(isSafeVaultName(name)).toBe(true);
  });

  it.each([
    '../secrets.md',
    'sub/2026-08-02.md',
    'sub\\2026-08-02.md',
    '2026-08-02.txt',
    'notes.md',
    '',
    '..',
    'team..md',
    'team.Alice.md',
    'team.-alice.md',
    'team.alice-.md',
  ])('rejects %o', (name) => {
    expect(isSafeVaultName(name)).toBe(false);
  });

  it('rejects a traversal disguised with a valid-looking suffix', () => {
    expect(isSafeVaultName('..2026-08-02.md')).toBe(false);
  });
});

describe('isPersonHandle', () => {
  it.each(['alice', 'a', 'alice-smith', 'alice.smith', 'alice_smith', 'a1'])(
    'accepts %o',
    (handle) => {
      expect(isPersonHandle(handle)).toBe(true);
    },
  );

  it.each(['', 'Alice', '-alice', 'alice-', 'al ice', 'alice/bob'])('rejects %o', (handle) => {
    expect(isPersonHandle(handle)).toBe(false);
  });
});

describe('dayFileName / dayKeyFromFileName', () => {
  it('round-trips', () => {
    expect(dayKeyFromFileName(dayFileName('2026-08-02'))).toBe('2026-08-02');
  });

  it('returns null for a non-day file', () => {
    expect(dayKeyFromFileName('CONTEXT.md')).toBeNull();
    expect(dayKeyFromFileName('2026-W32.md')).toBeNull();
  });

  it('returns null for a well-formed but impossible date', () => {
    expect(dayKeyFromFileName('2026-02-31.md')).toBeNull();
  });
});

describe('listDayKeys', () => {
  it('returns day keys ascending, ignoring other files', async () => {
    const vault = new MemoryVault({
      '2026-08-04.md': '',
      '2026-08-02.md': '',
      'CONTEXT.md': '',
      '2026-W32.md': '',
    });
    expect(await listDayKeys(vault)).toEqual(['2026-08-02', '2026-08-04']);
  });

  it('returns nothing for an empty vault', async () => {
    expect(await listDayKeys(new MemoryVault())).toEqual([]);
  });
});

describe('previousDayKey', () => {
  const keys = ['2026-08-01', '2026-08-03', '2026-08-04'];

  it('finds the most recent earlier day', () => {
    expect(previousDayKey(keys, '2026-08-04')).toBe('2026-08-03');
  });

  it('skips gaps', () => {
    expect(previousDayKey(keys, '2026-08-03')).toBe('2026-08-01');
  });

  it('is null when nothing is earlier', () => {
    expect(previousDayKey(keys, '2026-08-01')).toBeNull();
  });

  it('never returns the same day', () => {
    expect(previousDayKey(['2026-08-04'], '2026-08-04')).toBeNull();
  });
});

describe('withinCarryOverHorizon', () => {
  it('accepts consecutive days', () => {
    expect(withinCarryOverHorizon('2026-08-03', '2026-08-04')).toBe(true);
  });

  it('accepts a weekend gap so Monday inherits from Friday', () => {
    // 2026-07-31 is a Friday; 2026-08-03 is the following Monday.
    expect(withinCarryOverHorizon('2026-07-31', '2026-08-03')).toBe(true);
  });

  it('rejects a stale list from a fortnight away', () => {
    expect(withinCarryOverHorizon('2026-07-20', '2026-08-03')).toBe(false);
  });

  it('rejects malformed keys', () => {
    expect(withinCarryOverHorizon('nope', '2026-08-03')).toBe(false);
  });
});

describe('readDay / writeDay', () => {
  it('returns null for a day with no file', async () => {
    expect(await readDay(new MemoryVault(), '2026-08-02', HOURS.start, HOURS.end)).toBeNull();
  });

  it('round-trips a written day', async () => {
    const vault = new MemoryVault();
    const day = createDay('2026-08-02', HOURS.start, HOURS.end, [
      { title: 'Draft the RFC', status: 'upcoming' },
    ]);
    await writeDay(vault, day);

    const loaded = await readDay(vault, '2026-08-02', HOURS.start, HOURS.end);
    expect(loaded?.tasks).toEqual([
      { title: 'Draft the RFC', status: 'upcoming', added: '2026-08-02' },
    ]);
  });

  it('writes to the expected filename', async () => {
    const vault = new MemoryVault();
    await writeDay(vault, createDay('2026-08-02', HOURS.start, HOURS.end));
    expect(Object.keys(vault.snapshot())).toEqual(['2026-08-02.md']);
  });
});

describe('openDay', () => {
  it('returns the existing file untouched', async () => {
    const vault = new MemoryVault({
      '2026-08-04.md': dayFile('2026-08-04', [{ title: 'Existing', status: 'in-progress' }]),
    });
    const day = await openDay(vault, '2026-08-04', HOURS.start, HOURS.end);
    expect(day.tasks).toEqual([{ title: 'Existing', status: 'in-progress', added: '2026-08-04' }]);
  });

  it('creates an empty day when the vault is empty', async () => {
    const day = await openDay(new MemoryVault(), '2026-08-04', HOURS.start, HOURS.end);
    expect(day.tasks).toEqual([]);
    expect(day.date).toBe('2026-08-04');
  });

  it("seeds a new day with yesterday's open tasks", async () => {
    const vault = new MemoryVault({
      '2026-08-03.md': dayFile('2026-08-03', [
        { title: 'Carried', status: 'in-progress' },
        { title: 'Planned', status: 'upcoming' },
        { title: 'Finished', status: 'completed' },
      ]),
    });

    const day = await openDay(vault, '2026-08-04', HOURS.start, HOURS.end);
    expect(day.tasks.map((task) => task.title)).toEqual(['Carried', 'Planned']);
    expect(day.tasks.every((task) => task.added === '2026-08-03')).toBe(true);
  });

  it('keeps the original added date across a multi-day carry-over chain', async () => {
    const vault = new MemoryVault({
      '2026-08-03.md': dayFile('2026-08-03', [{ title: 'Long runner', status: 'in-progress' }]),
    });

    for (const date of ['2026-08-04', '2026-08-05', '2026-08-06']) {
      await writeDay(vault, await openDay(vault, date, HOURS.start, HOURS.end));
    }

    const day = await openDay(vault, '2026-08-06', HOURS.start, HOURS.end);
    expect(day.tasks[0]?.added).toBe('2026-08-03');
    expect(vault.snapshot()['2026-08-06.md']).toContain('_(added 2026-08-03)_');
  });

  it('does not carry over from beyond the horizon', async () => {
    const vault = new MemoryVault({
      '2026-07-20.md': dayFile('2026-07-20', [{ title: 'Ancient', status: 'upcoming' }]),
    });
    expect((await openDay(vault, '2026-08-04', HOURS.start, HOURS.end)).tasks).toEqual([]);
  });

  it('carries from the most recent day, not the oldest', async () => {
    const vault = new MemoryVault({
      '2026-08-02.md': dayFile('2026-08-02', [{ title: 'Older', status: 'upcoming' }]),
      '2026-08-03.md': dayFile('2026-08-03', [{ title: 'Newer', status: 'upcoming' }]),
    });
    const day = await openDay(vault, '2026-08-04', HOURS.start, HOURS.end);
    expect(day.tasks.map((task) => task.title)).toEqual(['Newer']);
  });

  it('does not write the new day to the vault as a side effect', async () => {
    const vault = new MemoryVault();
    await openDay(vault, '2026-08-04', HOURS.start, HOURS.end);
    expect(vault.snapshot()).toEqual({});
  });
});

describe('readDayRange', () => {
  it('returns days within the inclusive range, ascending', async () => {
    const vault = new MemoryVault({
      '2026-08-02.md': dayFile('2026-08-02'),
      '2026-08-03.md': dayFile('2026-08-03'),
      '2026-08-05.md': dayFile('2026-08-05'),
    });
    const days = await readDayRange(vault, '2026-08-03', '2026-08-05', HOURS.start, HOURS.end);
    expect(days.map((day) => day.date)).toEqual(['2026-08-03', '2026-08-05']);
  });

  it('returns nothing when the range is empty', async () => {
    const vault = new MemoryVault({ '2026-08-02.md': dayFile('2026-08-02') });
    expect(await readDayRange(vault, '2026-09-01', '2026-09-30', HOURS.start, HOURS.end)).toEqual(
      [],
    );
  });
});

describe('todayKey', () => {
  it('formats the supplied date', () => {
    expect(todayKey(new Date(2026, 7, 2))).toBe('2026-08-02');
  });
});

describe('teamFileName / personFromFileName', () => {
  it('round-trips', () => {
    expect(personFromFileName(teamFileName('alice'))).toBe('alice');
  });

  it('returns null for a non-team file', () => {
    expect(personFromFileName('CONTEXT.md')).toBeNull();
    expect(personFromFileName('2026-08-02.md')).toBeNull();
    expect(personFromFileName('2026-W32-team.md')).toBeNull();
  });
});

describe('listTeamPeople', () => {
  it('returns handles ascending, ignoring other files', async () => {
    const vault = new MemoryVault({
      'team.bob.md': '',
      'team.alice.md': '',
      'CONTEXT.md': '',
      '2026-08-02.md': '',
    });
    expect(await listTeamPeople(vault)).toEqual(['alice', 'bob']);
  });

  it('returns nothing for an empty vault', async () => {
    expect(await listTeamPeople(new MemoryVault())).toEqual([]);
  });
});

describe('readTeamMember / writeTeamMember', () => {
  it('returns null for a report with no file', async () => {
    expect(await readTeamMember(new MemoryVault(), 'alice')).toBeNull();
  });

  it('round-trips a written team member', async () => {
    const vault = new MemoryVault();
    const member = {
      ...createTeamMember('alice'),
      tasks: [{ title: 'Ship it', status: 'upcoming' as const }],
    };
    await writeTeamMember(vault, member);

    const loaded = await readTeamMember(vault, 'alice');
    expect(loaded?.tasks).toEqual([{ title: 'Ship it', status: 'upcoming' }]);
  });

  it('writes to the expected filename', async () => {
    const vault = new MemoryVault();
    await writeTeamMember(vault, createTeamMember('alice'));
    expect(Object.keys(vault.snapshot())).toEqual(['team.alice.md']);
  });
});

describe('openTeamMember', () => {
  it('returns the existing file untouched', async () => {
    const vault = new MemoryVault({
      'team.alice.md': serializeTeamMember({
        ...createTeamMember('alice'),
        tasks: [{ title: 'Existing', status: 'in-progress' }],
      }),
    });
    const member = await openTeamMember(vault, 'alice');
    expect(member.tasks).toEqual([{ title: 'Existing', status: 'in-progress' }]);
  });

  it('creates an empty document when no file exists yet, without writing it', async () => {
    const vault = new MemoryVault();
    const member = await openTeamMember(vault, 'alice');
    expect(member).toEqual(createTeamMember('alice'));
    expect(vault.snapshot()).toEqual({});
  });
});

describe('MemoryVault', () => {
  it('returns null for a missing file', async () => {
    expect(await new MemoryVault().read('nope.md')).toBeNull();
  });

  it('overwrites on a second write', async () => {
    const vault = new MemoryVault();
    await vault.write('a.md', 'one');
    await vault.write('a.md', 'two');
    expect(await vault.read('a.md')).toBe('two');
  });

  it('seeds from a snapshot', async () => {
    expect(await new MemoryVault({ 'a.md': 'hello' }).read('a.md')).toBe('hello');
  });
});
