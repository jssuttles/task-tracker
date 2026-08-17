import { describe, expect, it } from 'vitest';

import {
  currentSlot,
  describeCheckIn,
  describeNextWorkingDay,
  dueCheckIn,
  endsWorkingWeek,
  hasHandledToday,
  INITIAL_CHECK_IN_STATE,
  isWorkingDay,
  markHandled,
  nextWorkingDay,
  onDemandSlot,
  restoreCheckInState,
  slotClock,
  snooze,
  type CheckInState,
} from './schedule.ts';
import { DEFAULT_SETTINGS, type Settings } from './settings.ts';

/** 2026-08-03 is a Monday, so the weekday path is exercised by default. */
function at(hours: number, minutes = 0): Date {
  return new Date(2026, 7, 3, hours, minutes);
}

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, workStart: '09:00', workEnd: '17:00' };

describe('isWorkingDay', () => {
  it('treats Monday to Friday as working days by default', () => {
    // 2026-08-01 Sat, 08-02 Sun, 08-03 Mon.
    expect(isWorkingDay(new Date(2026, 7, 1), SETTINGS)).toBe(false);
    expect(isWorkingDay(new Date(2026, 7, 2), SETTINGS)).toBe(false);
    expect(isWorkingDay(new Date(2026, 7, 3), SETTINGS)).toBe(true);
  });

  it('follows a shifted week rather than assuming Sat/Sun', () => {
    // Tuesday-to-Saturday: Sunday and Monday are the weekend.
    const shifted: Settings = { ...SETTINGS, workDays: [2, 3, 4, 5, 6] };
    expect(isWorkingDay(new Date(2026, 7, 1), shifted)).toBe(true); // Saturday
    expect(isWorkingDay(new Date(2026, 7, 3), shifted)).toBe(false); // Monday
  });

  it('supports a four-day week', () => {
    const short: Settings = { ...SETTINGS, workDays: [1, 2, 3, 4] };
    expect(isWorkingDay(new Date(2026, 7, 6), short)).toBe(true); // Thursday
    expect(isWorkingDay(new Date(2026, 7, 7), short)).toBe(false); // Friday
  });
});

describe('currentSlot', () => {
  it('is null before the workday starts', () => {
    expect(currentSlot(at(8, 30), SETTINGS)).toBeNull();
  });

  it('opens with the day-start slot', () => {
    expect(currentSlot(at(9, 0), SETTINGS)).toMatchObject({
      kind: 'day-start',
      key: '2026-08-03T09:00',
    });
  });

  it('keeps the day-start slot current for its first hour', () => {
    expect(currentSlot(at(9, 45), SETTINGS)?.kind).toBe('day-start');
  });

  it('switches to hourly once the first hour is up', () => {
    expect(currentSlot(at(10, 0), SETTINGS)).toMatchObject({
      kind: 'hourly',
      key: '2026-08-03T10:00',
    });
  });

  it('anchors hourly slots to the hour, not to the work-start offset', () => {
    // A 09:30 start should still nudge at 10:00, not 10:30.
    const shifted: Settings = { ...SETTINGS, workStart: '09:30' };
    expect(currentSlot(at(10, 45), shifted)?.key).toBe('2026-08-03T10:00');
  });

  it('returns the day-end slot at and after the work end time', () => {
    expect(currentSlot(at(17, 0), SETTINGS)).toMatchObject({
      kind: 'day-end',
      key: '2026-08-03T17:00',
    });
    expect(currentSlot(at(21, 30), SETTINGS)?.kind).toBe('day-end');
  });

  it('is null on a weekend by default', () => {
    // 2026-08-01 is a Saturday.
    expect(currentSlot(new Date(2026, 7, 1, 12, 0), SETTINGS)).toBeNull();
  });

  it('prompts at the weekend when those days are working days', () => {
    const everyDay: Settings = { ...SETTINGS, workDays: [0, 1, 2, 3, 4, 5, 6] };
    expect(currentSlot(new Date(2026, 7, 1, 12, 0), everyDay)?.kind).toBe('hourly');
  });

  it('is null when the work window is inverted', () => {
    const broken: Settings = { ...SETTINGS, workStart: '17:00', workEnd: '09:00' };
    expect(currentSlot(at(12, 0), broken)).toBeNull();
  });

  it('collapses a long absence to a single slot', () => {
    // Lid closed at 11:55, reopened at 15:30. An interval-based scheduler would
    // owe four prompts; slots owe exactly one.
    expect(currentSlot(at(15, 30), SETTINGS)?.key).toBe('2026-08-03T15:00');
  });

  it('carries the local date on the slot', () => {
    expect(currentSlot(at(12, 0), SETTINGS)?.date).toBe('2026-08-03');
  });
});

describe('dueCheckIn', () => {
  /**
   * State for a day whose opener is already done, so these cases exercise the
   * ordinary hourly path. Without it every fresh-state case would be upgraded to
   * a day-start — see "the first check-in of a day is always the day's opener".
   */
  const dayOpened: CheckInState = markHandled(currentSlot(at(9, 0), SETTINGS)!);

  it('is due when the slot has not been handled', () => {
    expect(dueCheckIn(at(12, 0), SETTINGS, dayOpened)?.kind).toBe('hourly');
  });

  it('is not due once the slot is handled', () => {
    const slot = currentSlot(at(12, 0), SETTINGS)!;
    expect(dueCheckIn(at(12, 30), SETTINGS, markHandled(slot))).toBeNull();
  });

  it('becomes due again at the next hour', () => {
    const slot = currentSlot(at(12, 0), SETTINGS)!;
    const state = markHandled(slot);
    expect(dueCheckIn(at(13, 0), SETTINGS, state)?.key).toBe('2026-08-03T13:00');
  });

  it('fires only once for a whole missed stretch', () => {
    // Away 12:00–15:30, handled on return: the 13:00 and 14:00 slots never
    // reappear, because "current" is always the latest slot.
    const onReturn = currentSlot(at(15, 30), SETTINGS)!;
    const state = markHandled(onReturn);
    expect(dueCheckIn(at(15, 45), SETTINGS, state)).toBeNull();
  });

  it('is suppressed while snoozed and returns when the snooze lapses', () => {
    const snoozed = snooze(dayOpened, at(12, 0), SETTINGS);
    expect(dueCheckIn(at(12, 5), SETTINGS, snoozed)).toBeNull();
    expect(dueCheckIn(at(12, 11), SETTINGS, snoozed)?.kind).toBe('hourly');
  });

  it('still fires day-start and day-end when hourly nudges are off', () => {
    const quiet: Settings = { ...SETTINGS, hourlyEnabled: false };
    expect(dueCheckIn(at(12, 0), quiet, dayOpened)).toBeNull();
    expect(dueCheckIn(at(9, 0), quiet, INITIAL_CHECK_IN_STATE)?.kind).toBe('day-start');
    expect(dueCheckIn(at(17, 0), quiet, dayOpened)?.kind).toBe('day-end');
  });

  it('leaves the user alone outside the work window', () => {
    expect(dueCheckIn(at(7, 0), SETTINGS, INITIAL_CHECK_IN_STATE)).toBeNull();
  });

  it('keeps the day-end check-in outstanding into the evening', () => {
    // Logging off at 17:00 and reopening the laptop at 21:00 should still get
    // the wrap-up prompt rather than silence.
    expect(dueCheckIn(at(21, 0), SETTINGS, INITIAL_CHECK_IN_STATE)?.kind).toBe('day-end');
  });

  it('is due immediately when the app launches mid-day', () => {
    // No waiting an hour for the first tick.
    expect(dueCheckIn(at(14, 20), SETTINGS, INITIAL_CHECK_IN_STATE)?.key).toBe('2026-08-03T14:00');
  });

  it("does not resurrect yesterday's handled slot today", () => {
    const yesterday: CheckInState = { handledSlotKey: '2026-08-02T14:00', snoozedUntil: null };
    expect(dueCheckIn(at(14, 0), SETTINGS, yesterday)?.key).toBe('2026-08-03T14:00');
  });
});

describe("the first check-in of a day is always the day's opener", () => {
  it('shows day-start when launching mid-morning with nothing logged', () => {
    // Machine was off at 09:00; booting at 11:30 must still show you your day,
    // not a routine hourly nudge.
    const slot = dueCheckIn(at(11, 30), SETTINGS, INITIAL_CHECK_IN_STATE);
    expect(slot?.kind).toBe('day-start');
  });

  it('keys the upgraded slot to the current hour, not to work start', () => {
    // Keeping the 09:00 key would leave 11:00 outstanding and fire again a
    // minute later.
    const slot = dueCheckIn(at(11, 30), SETTINGS, INITIAL_CHECK_IN_STATE)!;
    expect(slot.key).toBe('2026-08-03T11:00');
    expect(dueCheckIn(at(11, 31), SETTINGS, markHandled(slot))).toBeNull();
  });

  it('returns to ordinary hourly nudges once the day has been opened', () => {
    const opener = dueCheckIn(at(11, 30), SETTINGS, INITIAL_CHECK_IN_STATE)!;
    const state = markHandled(opener);
    expect(dueCheckIn(at(12, 0), SETTINGS, state)?.kind).toBe('hourly');
  });

  it('does not upgrade when the day was already opened', () => {
    const state = markHandled(currentSlot(at(9, 0), SETTINGS)!);
    expect(dueCheckIn(at(11, 30), SETTINGS, state)?.kind).toBe('hourly');
  });

  it('still shows day-start after a snoozed opener lapses', () => {
    // Snoozing doesn't mean you've seen your day.
    const snoozed = snooze(INITIAL_CHECK_IN_STATE, at(11, 30), SETTINGS);
    expect(dueCheckIn(at(11, 45), SETTINGS, snoozed)?.kind).toBe('day-start');
  });

  it("treats yesterday's record as a fresh day", () => {
    const yesterday: CheckInState = { handledSlotKey: '2026-08-02T16:00', snoozedUntil: null };
    expect(dueCheckIn(at(11, 30), SETTINGS, yesterday)?.kind).toBe('day-start');
  });

  it('survives a reboot mid-morning without repeating the opener', () => {
    const opener = dueCheckIn(at(11, 30), SETTINGS, INITIAL_CHECK_IN_STATE)!;
    const afterReboot = restoreCheckInState(opener.date, slotClock(opener));
    expect(dueCheckIn(at(11, 40), SETTINGS, afterReboot)).toBeNull();
    expect(dueCheckIn(at(12, 0), SETTINGS, afterReboot)?.kind).toBe('hourly');
  });

  it('opens the day even when hourly nudges are switched off', () => {
    const quiet: Settings = { ...SETTINGS, hourlyEnabled: false };
    expect(dueCheckIn(at(11, 30), quiet, INITIAL_CHECK_IN_STATE)?.kind).toBe('day-start');
  });

  it('prefers the wrap-up past the end of the day, even if nothing was logged', () => {
    // At 18:00 on an unlogged day, "what did you get done, and what's tomorrow?"
    // beats "here's your day".
    expect(dueCheckIn(at(18, 0), SETTINGS, INITIAL_CHECK_IN_STATE)?.kind).toBe('day-end');
  });

  it('leaves the pre-work window alone', () => {
    expect(dueCheckIn(at(7, 0), SETTINGS, INITIAL_CHECK_IN_STATE)).toBeNull();
  });
});

describe('hasHandledToday', () => {
  it('is false before anything is handled', () => {
    expect(hasHandledToday(INITIAL_CHECK_IN_STATE, '2026-08-03')).toBe(false);
  });

  it('is true for a slot handled on that date', () => {
    const state = markHandled(currentSlot(at(12, 0), SETTINGS)!);
    expect(hasHandledToday(state, '2026-08-03')).toBe(true);
  });

  it('is false for a slot handled on another date', () => {
    const state = markHandled(currentSlot(at(12, 0), SETTINGS)!);
    expect(hasHandledToday(state, '2026-08-04')).toBe(false);
  });

  it('does not match on a date that merely shares a prefix', () => {
    const state: CheckInState = { handledSlotKey: '2026-08-30T12:00', snoozedUntil: null };
    expect(hasHandledToday(state, '2026-08-3')).toBe(false);
  });
});

describe('snooze', () => {
  it('defers by the configured number of minutes', () => {
    const state = snooze(INITIAL_CHECK_IN_STATE, at(12, 0), { ...SETTINGS, snoozeMinutes: 15 });
    expect(state.snoozedUntil).toBe(at(12, 15).getTime());
  });

  it('preserves the handled slot so snoozing does not re-open a finished one', () => {
    const handled = markHandled(currentSlot(at(12, 0), SETTINGS)!);
    expect(snooze(handled, at(12, 0), SETTINGS).handledSlotKey).toBe('2026-08-03T12:00');
  });
});

describe('markHandled', () => {
  it('clears a pending snooze', () => {
    const slot = currentSlot(at(12, 0), SETTINGS)!;
    const snoozed = snooze(INITIAL_CHECK_IN_STATE, at(12, 0), SETTINGS);
    expect(markHandled(slot).snoozedUntil).toBeNull();
    expect(snoozed.snoozedUntil).not.toBeNull();
  });
});

describe('onDemandSlot', () => {
  it('returns the real current slot during the workday', () => {
    expect(onDemandSlot(at(14, 30), SETTINGS).key).toBe('2026-08-03T14:00');
  });

  it('does not re-prompt after an early manual check-in', () => {
    // Regression: minting a slot keyed to 14:30 left the genuine 14:00 slot
    // unhandled, so the scheduler fired again a minute later.
    const slot = onDemandSlot(at(14, 30), SETTINGS);
    const state = markHandled(slot);
    expect(dueCheckIn(at(14, 31), SETTINGS, state)).toBeNull();
    expect(dueCheckIn(at(14, 59), SETTINGS, state)).toBeNull();
  });

  it('still lets the next real slot through', () => {
    const state = markHandled(onDemandSlot(at(14, 30), SETTINGS));
    expect(dueCheckIn(at(15, 0), SETTINGS, state)?.key).toBe('2026-08-03T15:00');
  });

  it('synthesizes a slot outside the work window', () => {
    const slot = onDemandSlot(at(7, 15), SETTINGS);
    expect(slot.key).toBe('2026-08-03T07:15');
    expect(slot.date).toBe('2026-08-03');
  });

  it('synthesizes a slot on a weekend', () => {
    expect(onDemandSlot(new Date(2026, 7, 1, 12, 0), SETTINGS).key).toBe('2026-08-01T12:00');
  });

  it('handling a synthesized slot does not suppress the next workday', () => {
    const state = markHandled(onDemandSlot(at(7, 15), SETTINGS));
    expect(dueCheckIn(at(9, 0), SETTINGS, state)?.kind).toBe('day-start');
  });
});

describe('slotClock / restoreCheckInState', () => {
  it('round-trips a handled slot through the day file', () => {
    const slot = currentSlot(at(14, 30), SETTINGS)!;
    const restored = restoreCheckInState(slot.date, slotClock(slot));
    expect(restored.handledSlotKey).toBe(slot.key);
  });

  it('does not re-prompt for a slot handled before a reboot', () => {
    // Regression: scheduler state lived only in memory, so relaunching at 14:35
    // re-prompted for the 14:00 check-in the user had already completed.
    const slot = currentSlot(at(14, 0), SETTINGS)!;
    const afterReboot = restoreCheckInState(slot.date, slotClock(slot));
    expect(dueCheckIn(at(14, 35), SETTINGS, afterReboot)).toBeNull();
  });

  it('still lets the next slot through after a reboot', () => {
    const slot = currentSlot(at(14, 0), SETTINGS)!;
    const afterReboot = restoreCheckInState(slot.date, slotClock(slot));
    expect(dueCheckIn(at(15, 0), SETTINGS, afterReboot)?.key).toBe('2026-08-03T15:00');
  });

  it('restores the day-start slot', () => {
    const slot = currentSlot(at(9, 0), SETTINGS)!;
    expect(restoreCheckInState(slot.date, slotClock(slot)).handledSlotKey).toBe('2026-08-03T09:00');
  });

  it('restores the day-end slot so the evening stays quiet', () => {
    const slot = currentSlot(at(17, 0), SETTINGS)!;
    const afterReboot = restoreCheckInState(slot.date, slotClock(slot));
    expect(dueCheckIn(at(21, 0), SETTINGS, afterReboot)).toBeNull();
  });

  it('treats a day file with no record as nothing handled', () => {
    expect(restoreCheckInState('2026-08-03', undefined)).toEqual(INITIAL_CHECK_IN_STATE);
  });

  it('ignores a malformed hand-edited value rather than trusting it', () => {
    // Trusting garbage would silently suppress every check-in for the rest of
    // the day, which is the worse failure.
    expect(restoreCheckInState('2026-08-03', 'lunchtime')).toEqual(INITIAL_CHECK_IN_STATE);
    expect(restoreCheckInState('2026-08-03', '25:99')).toEqual(INITIAL_CHECK_IN_STATE);
  });

  it('does not restore a snooze — the user is back at the keyboard', () => {
    const slot = currentSlot(at(14, 0), SETTINGS)!;
    expect(restoreCheckInState(slot.date, slotClock(slot)).snoozedUntil).toBeNull();
  });

  it("scopes the restored key to its own day, so yesterday's record is inert today", () => {
    const yesterday = restoreCheckInState('2026-08-02', '14:00');
    expect(dueCheckIn(at(14, 0), SETTINGS, yesterday)?.key).toBe('2026-08-03T14:00');
  });
});

describe('describeCheckIn', () => {
  it('labels every kind', () => {
    expect(describeCheckIn('day-start')).toBe("Here's your day");
    expect(describeCheckIn('hourly')).toBe('Quick check-in');
    expect(describeCheckIn('day-end')).toBe('Wrapping up');
  });

  it('marks the wrap-up that ends the week', () => {
    expect(describeCheckIn('day-end', true)).toBe('Wrapping up the week');
    // Only the wrap-up changes; a Friday morning is still just a morning.
    expect(describeCheckIn('day-start', true)).toBe("Here's your day");
  });
});

describe('nextWorkingDay', () => {
  it('skips the weekend', () => {
    // Friday 2026-08-07 → Monday 2026-08-10.
    expect(nextWorkingDay(new Date(2026, 7, 7), SETTINGS)).toEqual(new Date(2026, 7, 10));
  });

  it('returns tomorrow mid-week', () => {
    expect(nextWorkingDay(new Date(2026, 7, 3), SETTINGS)).toEqual(new Date(2026, 7, 4));
  });

  it('follows a shifted week rather than assuming Sat/Sun', () => {
    // Tuesday-to-Saturday: Saturday 08-08 rolls to Tuesday 08-11, not Monday.
    const shifted: Settings = { ...SETTINGS, workDays: [2, 3, 4, 5, 6] };
    expect(nextWorkingDay(new Date(2026, 7, 8), shifted)).toEqual(new Date(2026, 7, 11));
  });

  it('wraps a full week for a single-day week', () => {
    const wednesdaysOnly: Settings = { ...SETTINGS, workDays: [3] };
    expect(nextWorkingDay(new Date(2026, 7, 5), wednesdaysOnly)).toEqual(new Date(2026, 7, 12));
  });

  it('gives up rather than looping on a week with no working days', () => {
    // Unreachable through the UI; a hand-edited settings.json can still get here.
    expect(nextWorkingDay(new Date(2026, 7, 3), { ...SETTINGS, workDays: [] })).toBeNull();
  });
});

describe('describeNextWorkingDay', () => {
  it('says "tomorrow" when tomorrow is a working day', () => {
    expect(describeNextWorkingDay(new Date(2026, 7, 3), SETTINGS)).toBe('tomorrow');
  });

  it('names the day when tomorrow is not', () => {
    // The reason this function exists: "plan tomorrow?" on a Friday is a
    // question about a Saturday nobody is going to work.
    expect(describeNextWorkingDay(new Date(2026, 7, 7), SETTINGS)).toBe('Monday');
  });

  it('names the right day for a shifted week', () => {
    const shifted: Settings = { ...SETTINGS, workDays: [2, 3, 4, 5, 6] };
    expect(describeNextWorkingDay(new Date(2026, 7, 8), shifted)).toBe('Tuesday');
  });

  it('stays readable when the week is empty', () => {
    expect(describeNextWorkingDay(new Date(2026, 7, 3), { ...SETTINGS, workDays: [] })).toBe(
      'your next working day',
    );
  });
});

describe('endsWorkingWeek', () => {
  it('is true on Friday and false on Thursday', () => {
    expect(endsWorkingWeek(new Date(2026, 7, 6), SETTINGS)).toBe(false); // Thursday
    expect(endsWorkingWeek(new Date(2026, 7, 7), SETTINGS)).toBe(true); // Friday
  });

  it('follows a four-day week', () => {
    const short: Settings = { ...SETTINGS, workDays: [1, 2, 3, 4] };
    expect(endsWorkingWeek(new Date(2026, 7, 6), short)).toBe(true); // Thursday
  });

  it('is not fooled by a mid-week day off', () => {
    // Wednesdays off. Tuesday is followed by a non-working day but is emphatically
    // not the end of the week, and saying so twice a week would be worse than
    // never saying it.
    const wednesdayOff: Settings = { ...SETTINGS, workDays: [1, 2, 4, 5] };
    expect(endsWorkingWeek(new Date(2026, 7, 4), wednesdayOff)).toBe(false); // Tuesday
    expect(endsWorkingWeek(new Date(2026, 7, 7), wednesdayOff)).toBe(true); // Friday
  });

  it('follows a week that straddles the ISO boundary', () => {
    // Sunday-to-Thursday. An ISO-week comparison gets this exactly backwards:
    // Thursday and the following Sunday share an ISO week, so the label would
    // land on Sunday — the day the week *starts*.
    const sundayStart: Settings = { ...SETTINGS, workDays: [0, 1, 2, 3, 4] };
    expect(endsWorkingWeek(new Date(2026, 7, 6), sundayStart)).toBe(true); // Thursday
    expect(endsWorkingWeek(new Date(2026, 7, 9), sundayStart)).toBe(false); // Sunday
  });

  it('follows a Tuesday-to-Saturday shift', () => {
    const shifted: Settings = { ...SETTINGS, workDays: [2, 3, 4, 5, 6] };
    expect(endsWorkingWeek(new Date(2026, 7, 8), shifted)).toBe(true); // Saturday
    expect(endsWorkingWeek(new Date(2026, 7, 7), shifted)).toBe(false); // Friday
  });

  it('is true on the only working day of a one-day week', () => {
    expect(endsWorkingWeek(new Date(2026, 7, 5), { ...SETTINGS, workDays: [3] })).toBe(true);
  });

  it('is false on a day that is not a working day at all', () => {
    expect(endsWorkingWeek(new Date(2026, 7, 8), SETTINGS)).toBe(false); // Saturday
  });

  it('is false when there is no next working day at all', () => {
    expect(endsWorkingWeek(new Date(2026, 7, 3), { ...SETTINGS, workDays: [] })).toBe(false);
  });
});
