import { describe, expect, it } from 'vitest';

import { backfillDay, deriveRunStarts } from './backfill-provenance.ts';
import { createDay, parseDay, serializeDay } from '../src/lib/markdown/day.ts';

const FALLBACK = { date: '2026-08-03', workStart: '09:00', workEnd: '17:00' };

function startOf(
  days: readonly { date: string; titles: string[] }[],
  date: string,
  title: string,
): string | undefined {
  return deriveRunStarts(days).get(date)?.get(title);
}

describe('deriveRunStarts', () => {
  const WEEK = [
    { date: '2026-08-03', titles: ['Migrate the queue', 'Triage'] },
    { date: '2026-08-04', titles: ['Migrate the queue'] },
    { date: '2026-08-05', titles: ['Migrate the queue', 'Write the RFC'] },
  ];

  it('dates a task to the first file of its run', () => {
    expect(startOf(WEEK, '2026-08-05', 'migrate the queue')).toBe('2026-08-03');
  });

  it('dates a task that appears later to the day it appeared', () => {
    expect(startOf(WEEK, '2026-08-05', 'write the rfc')).toBe('2026-08-05');
  });

  it('spans a gap in the calendar, since day files skip weekends', () => {
    const overWeekend = [
      { date: '2026-07-31', titles: ['Long runner'] },
      { date: '2026-08-03', titles: ['Long runner'] },
    ];
    expect(startOf(overWeekend, '2026-08-03', 'long runner')).toBe('2026-07-31');
  });

  it('starts a new run when a title comes back after disappearing', () => {
    // Otherwise a recurring title reads as one task open for the whole
    // fortnight, which is the headline number someone would quote.
    const recurring = [
      { date: '2026-08-03', titles: ['Triage the queue'] },
      { date: '2026-08-04', titles: [] },
      { date: '2026-08-05', titles: ['Triage the queue'] },
    ];

    expect(startOf(recurring, '2026-08-03', 'triage the queue')).toBe('2026-08-03');
    expect(startOf(recurring, '2026-08-05', 'triage the queue')).toBe('2026-08-05');
  });

  it('matches titles the way the app does — case and padding insensitive', () => {
    const retyped = [
      { date: '2026-08-03', titles: ['Migrate the queue'] },
      { date: '2026-08-04', titles: ['  migrate the QUEUE  '] },
    ];
    expect(startOf(retyped, '2026-08-04', 'migrate the queue')).toBe('2026-08-03');
  });

  it('handles an empty vault without complaint', () => {
    expect(deriveRunStarts([]).size).toBe(0);
  });
});

describe('backfillDay', () => {
  it('stamps the derived date and upgrades the format', () => {
    const legacy = parseDay(
      '---\ndate: 2026-08-05\n---\n\n## Tasks\n\n- [/] Migrate the queue\n',
      FALLBACK,
    );
    expect(legacy.formatVersion).toBe(1);

    const filled = backfillDay(legacy, new Map([['migrate the queue', '2026-08-03']]));
    expect(filled.formatVersion).toBe(2);
    expect(filled.tasks[0]?.added).toBe('2026-08-03');
    expect(serializeDay(filled)).toContain('- [/] Migrate the queue _(added 2026-08-03)_');
    expect(serializeDay(filled)).toContain('format: 2');
  });

  it("falls back to the file's own date for a task it has no run for", () => {
    const day = parseDay('---\ndate: 2026-08-05\n---\n\n## Tasks\n\n- [ ] Orphan\n', FALLBACK);
    expect(backfillDay(day, new Map()).tasks[0]?.added).toBe('2026-08-05');
  });

  it('leaves an already-correct file byte-identical', () => {
    const day = createDay('2026-08-05', '09:00', '17:00', [
      { title: 'Fresh', status: 'upcoming', added: '2026-08-05' },
    ]);
    const filled = backfillDay(day, new Map([['fresh', '2026-08-05']]));
    expect(serializeDay(filled)).toBe(serializeDay(day));
  });

  it('preserves hand-edited sections and unowned frontmatter', () => {
    const day = parseDay(
      '---\ndate: 2026-08-05\nmood: focused\n---\n\n## Tasks\n\n- [ ] Thing\n\n## Retro\n\nWent well.\n',
      FALLBACK,
    );
    const output = serializeDay(backfillDay(day, new Map([['thing', '2026-08-04']])));

    expect(output).toContain('mood: focused');
    expect(output).toContain('## Retro');
    expect(output).toContain('Went well.');
  });

  it('round-trips what it writes', () => {
    const day = parseDay('---\ndate: 2026-08-05\n---\n\n## Tasks\n\n- [x] Done\n', FALLBACK);
    const filled = backfillDay(day, new Map([['done', '2026-08-03']]));

    expect(parseDay(serializeDay(filled), FALLBACK)).toEqual(filled);
  });
});
