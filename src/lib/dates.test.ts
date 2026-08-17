import { describe, expect, it } from 'vitest';

import {
  addDays,
  describeDate,
  formatClock,
  fromDateKey,
  isDateKey,
  minutesSinceMidnight,
  parseClock,
  startOfIsoWeek,
  toClock,
  toDateKey,
  toWeekKey,
  weekdayName,
} from './dates.ts';

describe('toDateKey', () => {
  it('formats a local date', () => {
    expect(toDateKey(new Date(2026, 7, 2))).toBe('2026-08-02');
  });

  it('pads single-digit months and days', () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('uses the local calendar date, not the UTC one', () => {
    // 23:30 local. In any timezone east of UTC this is already "tomorrow" in
    // UTC, and toISOString() would file the note under the wrong day.
    const late = new Date(2026, 7, 2, 23, 30);
    expect(toDateKey(late)).toBe('2026-08-02');
  });
});

describe('fromDateKey', () => {
  it('round-trips with toDateKey', () => {
    const key = '2026-08-02';
    expect(toDateKey(fromDateKey(key)!)).toBe(key);
  });

  it('returns local midnight', () => {
    const date = fromDateKey('2026-08-02')!;
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
  });

  it.each(['', 'nope', '2026-8-2', '26-08-02', '2026/08/02'])('rejects %o', (input) => {
    expect(fromDateKey(input)).toBeNull();
  });

  it('rejects out-of-range components', () => {
    expect(fromDateKey('2026-13-01')).toBeNull();
    expect(fromDateKey('2026-00-01')).toBeNull();
    expect(fromDateKey('2026-01-32')).toBeNull();
  });

  it('rejects a date the Date constructor would silently roll over', () => {
    // Without the round-trip check this becomes 2026-03-03.
    expect(fromDateKey('2026-02-31')).toBeNull();
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(fromDateKey('2028-02-29')).not.toBeNull();
    expect(fromDateKey('2026-02-29')).toBeNull();
  });
});

describe('isDateKey', () => {
  it('agrees with fromDateKey', () => {
    expect(isDateKey('2026-08-02')).toBe(true);
    expect(isDateKey('2026-02-31')).toBe(false);
  });
});

describe('parseClock', () => {
  it('converts to minutes since midnight', () => {
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('23:59')).toBe(1439);
  });

  it('accepts a single-digit hour', () => {
    expect(parseClock('9:05')).toBe(545);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseClock('  09:30  ')).toBe(570);
  });

  it.each(['', '24:00', '09:60', '9', '09:5', 'oops', '09:30:00'])('rejects %o', (input) => {
    expect(parseClock(input)).toBeNull();
  });
});

describe('formatClock', () => {
  it('renders zero-padded HH:MM', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(545)).toBe('09:05');
    expect(formatClock(1439)).toBe('23:59');
  });

  it('clamps values outside a single day', () => {
    expect(formatClock(-30)).toBe('00:00');
    expect(formatClock(5000)).toBe('23:59');
  });

  it('round-trips with parseClock', () => {
    expect(parseClock(formatClock(570))).toBe(570);
  });
});

describe('toClock / minutesSinceMidnight', () => {
  it('reads the local wall clock', () => {
    const date = new Date(2026, 7, 2, 9, 5);
    expect(toClock(date)).toBe('09:05');
    expect(minutesSinceMidnight(date)).toBe(545);
  });
});

describe('addDays', () => {
  it('moves forward and backward across a month boundary', () => {
    expect(toDateKey(addDays(new Date(2026, 7, 31), 1))).toBe('2026-09-01');
    expect(toDateKey(addDays(new Date(2026, 8, 1), -1))).toBe('2026-08-31');
  });

  it('does not mutate its argument', () => {
    const original = new Date(2026, 7, 2);
    addDays(original, 5);
    expect(toDateKey(original)).toBe('2026-08-02');
  });
});

describe('startOfIsoWeek', () => {
  it('returns the same Monday for every day of that week', () => {
    // 2026-08-03 is a Monday.
    const monday = '2026-08-03';
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays(new Date(2026, 7, 3), offset);
      expect(toDateKey(startOfIsoWeek(day))).toBe(monday);
    }
  });

  it('maps Sunday back to the preceding Monday, not forward', () => {
    // 2026-08-09 is a Sunday; ISO weeks end on it.
    expect(toDateKey(startOfIsoWeek(new Date(2026, 7, 9)))).toBe('2026-08-03');
  });
});

describe('toWeekKey', () => {
  it('formats a zero-padded ISO week', () => {
    expect(toWeekKey(new Date(2026, 0, 8))).toBe('2026-W02');
  });

  it('is stable across a whole week', () => {
    const keys = new Set<string>();
    for (let offset = 0; offset < 7; offset += 1) {
      keys.add(toWeekKey(addDays(new Date(2026, 7, 3), offset)));
    }
    expect([...keys]).toEqual(['2026-W32']);
  });

  it('uses the ISO week-numbering year, which can differ from the calendar year', () => {
    // 2027-01-01 is a Friday, so it belongs to the last ISO week of 2026.
    expect(toWeekKey(new Date(2027, 0, 1))).toBe('2026-W53');
  });
});

describe('describeDate', () => {
  it('renders a locale-independent heading', () => {
    expect(describeDate(new Date(2026, 7, 2))).toBe('Sunday, 2 August 2026');
  });
});

describe('weekdayName', () => {
  it('names each day, indexed the way getDay() counts', () => {
    expect(weekdayName(new Date(2026, 7, 2))).toBe('Sunday');
    expect(weekdayName(new Date(2026, 7, 3))).toBe('Monday');
    expect(weekdayName(new Date(2026, 7, 8))).toBe('Saturday');
  });
});
