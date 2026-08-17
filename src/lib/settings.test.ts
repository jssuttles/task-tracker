import { describe, expect, it } from 'vitest';

import {
  applyDraft,
  DEFAULT_SETTINGS,
  MAX_SNOOZE_MINUTES,
  MIN_SNOOZE_MINUTES,
  parseSettings,
  serializeSettings,
  toDraft,
  toggleWorkDay,
  validateDraft,
  type SettingsDraft,
} from './settings.ts';

describe('parseSettings', () => {
  it('returns defaults for a non-object', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('reads a full settings object', () => {
    const settings = parseSettings({
      workStart: '08:30',
      workEnd: '18:00',
      vaultDir: 'C:\\vault',
      hourlyEnabled: false,
      snoozeMinutes: 20,
      workDays: [2, 3, 4, 5, 6],
      managerModeEnabled: true,
    });
    expect(settings).toEqual({
      workStart: '08:30',
      workEnd: '18:00',
      vaultDir: 'C:\\vault',
      hourlyEnabled: false,
      snoozeMinutes: 20,
      workDays: [2, 3, 4, 5, 6],
      managerModeEnabled: true,
    });
  });

  it('reads managerModeEnabled, defaulting to false', () => {
    expect(parseSettings({ managerModeEnabled: true }).managerModeEnabled).toBe(true);
    expect(parseSettings({}).managerModeEnabled).toBe(false);
  });

  it('ignores a non-boolean managerModeEnabled', () => {
    expect(parseSettings({ managerModeEnabled: 'yes' }).managerModeEnabled).toBe(
      DEFAULT_SETTINGS.managerModeEnabled,
    );
  });

  it('normalizes a single-digit hour', () => {
    expect(parseSettings({ workStart: '9:00' }).workStart).toBe('09:00');
  });

  it('falls back for a malformed clock value', () => {
    expect(parseSettings({ workStart: 'lunchtime' }).workStart).toBe(DEFAULT_SETTINGS.workStart);
  });

  it('ignores fields of the wrong type', () => {
    const settings = parseSettings({ hourlyEnabled: 'yes', vaultDir: 42 });
    expect(settings.hourlyEnabled).toBe(DEFAULT_SETTINGS.hourlyEnabled);
    expect(settings.vaultDir).toBe(DEFAULT_SETTINGS.vaultDir);
  });

  it('clamps the snooze into range', () => {
    expect(parseSettings({ snoozeMinutes: 0 }).snoozeMinutes).toBe(MIN_SNOOZE_MINUTES);
    expect(parseSettings({ snoozeMinutes: 9999 }).snoozeMinutes).toBe(MAX_SNOOZE_MINUTES);
  });

  it('rounds a fractional snooze', () => {
    expect(parseSettings({ snoozeMinutes: 10.6 }).snoozeMinutes).toBe(11);
  });

  it('rejects a non-finite snooze', () => {
    expect(parseSettings({ snoozeMinutes: Number.NaN }).snoozeMinutes).toBe(
      DEFAULT_SETTINGS.snoozeMinutes,
    );
  });

  it('restores both ends of an inverted work window', () => {
    const settings = parseSettings({ workStart: '18:00', workEnd: '09:00' });
    expect(settings.workStart).toBe(DEFAULT_SETTINGS.workStart);
    expect(settings.workEnd).toBe(DEFAULT_SETTINGS.workEnd);
  });

  it('rejects a zero-length work window', () => {
    const settings = parseSettings({ workStart: '09:00', workEnd: '09:00' });
    expect(settings.workEnd).toBe(DEFAULT_SETTINGS.workEnd);
  });

  it('keeps other fields when the work window is repaired', () => {
    expect(
      parseSettings({ workStart: '18:00', workEnd: '09:00', snoozeMinutes: 5 }).snoozeMinutes,
    ).toBe(5);
  });
});

describe('parseSettings — the working week', () => {
  it('defaults to Monday through Friday', () => {
    expect(parseSettings({}).workDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('sorts and de-duplicates', () => {
    expect(parseSettings({ workDays: [5, 1, 5, 3] }).workDays).toEqual([1, 3, 5]);
  });

  it('drops values that are not real day numbers', () => {
    expect(parseSettings({ workDays: [1, 7, -1, 2.5, 'mon', null, 3] }).workDays).toEqual([1, 3]);
  });

  it('falls back rather than accepting an empty week', () => {
    // A week with no working days would silence the app permanently.
    expect(parseSettings({ workDays: [] }).workDays).toEqual([1, 2, 3, 4, 5]);
    expect(parseSettings({ workDays: ['nope'] }).workDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('accepts a full seven-day week', () => {
    expect(parseSettings({ workDays: [0, 1, 2, 3, 4, 5, 6] }).workDays).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it('honours the superseded includeWeekends flag', () => {
    // An existing settings.json must keep working across the upgrade.
    expect(parseSettings({ includeWeekends: true }).workDays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseSettings({ includeWeekends: false }).workDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('prefers an explicit workDays list over the old flag', () => {
    expect(parseSettings({ includeWeekends: true, workDays: [1, 2] }).workDays).toEqual([1, 2]);
  });

  it('does not alias the default array between calls', () => {
    const first = parseSettings({});
    first.workDays.push(6);
    expect(parseSettings({}).workDays).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('serializeSettings', () => {
  it('round-trips through parseSettings', () => {
    const settings = parseSettings({ workStart: '08:00', workEnd: '16:30', snoozeMinutes: 5 });
    expect(parseSettings(JSON.parse(serializeSettings(settings)))).toEqual(settings);
  });

  it('ends with a newline', () => {
    expect(serializeSettings(DEFAULT_SETTINGS).endsWith('\n')).toBe(true);
  });
});

/** A valid draft, so each test can vary the one field it cares about. */
function draft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return { ...toDraft(DEFAULT_SETTINGS), ...overrides };
}

/** The fields flagged by a draft, for terse assertions. */
function fieldsIn(input: SettingsDraft): string[] {
  return validateDraft(input).map((issue) => issue.field);
}

describe('toDraft', () => {
  it('renders the numeric snooze as input text', () => {
    expect(toDraft(DEFAULT_SETTINGS).snoozeMinutes).toBe('10');
  });

  it('copies the day list rather than aliasing it', () => {
    const settings = parseSettings({});
    const copy = toDraft(settings);
    copy.workDays.push(6);
    expect(settings.workDays).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('toggleWorkDay', () => {
  it('adds a missing day, sorted', () => {
    expect(toggleWorkDay([1, 2, 5], 3)).toEqual([1, 2, 3, 5]);
  });

  it('removes a present day', () => {
    expect(toggleWorkDay([1, 2, 3], 2)).toEqual([1, 3]);
  });

  it('allows emptying the list, leaving the complaint to validation', () => {
    // Refusing the click would be a button that silently does nothing.
    expect(toggleWorkDay([3], 3)).toEqual([]);
    expect(fieldsIn(draft({ workDays: [] }))).toContain('workDays');
  });

  it('de-duplicates an already-dirty list', () => {
    expect(toggleWorkDay([1, 1, 2], 3)).toEqual([1, 2, 3]);
  });

  it('ignores a day outside 0–6', () => {
    expect(toggleWorkDay([1, 2], 9)).toEqual([1, 2]);
    expect(toggleWorkDay([1, 2], -1)).toEqual([1, 2]);
  });

  it('does not mutate its input', () => {
    const days = [1, 2, 3];
    toggleWorkDay(days, 4);
    expect(days).toEqual([1, 2, 3]);
  });
});

describe('validateDraft', () => {
  it('accepts the defaults', () => {
    expect(validateDraft(draft())).toEqual([]);
  });

  it('rejects a malformed clock', () => {
    expect(fieldsIn(draft({ workStart: 'lunchtime' }))).toEqual(['workStart']);
    expect(fieldsIn(draft({ workEnd: '' }))).toEqual(['workEnd']);
  });

  it('rejects a day that ends before it starts', () => {
    expect(fieldsIn(draft({ workStart: '17:00', workEnd: '09:00' }))).toEqual(['workEnd']);
  });

  it('rejects a zero-length day', () => {
    expect(fieldsIn(draft({ workStart: '09:00', workEnd: '09:00' }))).toEqual(['workEnd']);
  });

  it('does not add the ordering complaint when a clock is already unparseable', () => {
    // Two messages about one field is noise; the format error is the actionable one.
    expect(fieldsIn(draft({ workEnd: 'nope' }))).toEqual(['workEnd']);
  });

  it('rejects a non-numeric snooze', () => {
    expect(fieldsIn(draft({ snoozeMinutes: '' }))).toEqual(['snoozeMinutes']);
    expect(fieldsIn(draft({ snoozeMinutes: 'ten' }))).toEqual(['snoozeMinutes']);
    // `parseInt` would read this as 10 and quietly accept a typo.
    expect(fieldsIn(draft({ snoozeMinutes: '10abc' }))).toEqual(['snoozeMinutes']);
  });

  it('rejects a snooze outside its bounds', () => {
    expect(fieldsIn(draft({ snoozeMinutes: '0' }))).toEqual(['snoozeMinutes']);
    expect(fieldsIn(draft({ snoozeMinutes: '61' }))).toEqual(['snoozeMinutes']);
  });

  it('accepts the snooze bounds themselves', () => {
    expect(validateDraft(draft({ snoozeMinutes: String(MIN_SNOOZE_MINUTES) }))).toEqual([]);
    expect(validateDraft(draft({ snoozeMinutes: String(MAX_SNOOZE_MINUTES) }))).toEqual([]);
  });

  it('rejects a week with no working days', () => {
    expect(fieldsIn(draft({ workDays: [] }))).toEqual(['workDays']);
  });

  it('reports every problem at once, in panel order', () => {
    expect(fieldsIn(draft({ workStart: 'x', snoozeMinutes: '99', workDays: [] }))).toEqual([
      'workStart',
      'snoozeMinutes',
      'workDays',
    ]);
  });

  it('carries a message with every issue', () => {
    for (const issue of validateDraft(draft({ workStart: 'x', workDays: [] }))) {
      expect(issue.message).not.toBe('');
    }
  });
});

describe('applyDraft', () => {
  it('applies every edited field', () => {
    const next = applyDraft(
      DEFAULT_SETTINGS,
      draft({
        workStart: '08:30',
        workEnd: '18:00',
        hourlyEnabled: false,
        snoozeMinutes: '25',
        workDays: [2, 3, 4, 5, 6],
        managerModeEnabled: true,
      }),
    );

    expect(next).toEqual({
      workStart: '08:30',
      workEnd: '18:00',
      vaultDir: '',
      hourlyEnabled: false,
      snoozeMinutes: 25,
      workDays: [2, 3, 4, 5, 6],
      managerModeEnabled: true,
    });
  });

  it('normalizes a single-digit hour', () => {
    expect(applyDraft(DEFAULT_SETTINGS, draft({ workStart: '8:05' })).workStart).toBe('08:05');
  });

  it('preserves fields the panel does not edit', () => {
    const base = parseSettings({ vaultDir: 'C:\\vault' });
    expect(applyDraft(base, draft({ workStart: '10:00' })).vaultDir).toBe('C:\\vault');
  });

  it('round-trips settings through a draft unchanged', () => {
    const settings = parseSettings({
      workStart: '07:15',
      workEnd: '15:45',
      vaultDir: '/home/j/vault',
      hourlyEnabled: false,
      snoozeMinutes: 3,
      workDays: [0, 6],
      managerModeEnabled: true,
    });
    expect(applyDraft(settings, toDraft(settings))).toEqual(settings);
  });

  it('sorts and de-duplicates the day list', () => {
    expect(applyDraft(DEFAULT_SETTINGS, draft({ workDays: [5, 1, 5, 3] })).workDays).toEqual([
      1, 3, 5,
    ]);
  });

  it('clamps a snooze outside its bounds', () => {
    expect(applyDraft(DEFAULT_SETTINGS, draft({ snoozeMinutes: '900' })).snoozeMinutes).toBe(
      MAX_SNOOZE_MINUTES,
    );
    expect(applyDraft(DEFAULT_SETTINGS, draft({ snoozeMinutes: '0' })).snoozeMinutes).toBe(
      MIN_SNOOZE_MINUTES,
    );
  });

  it('keeps the base value for anything unusable', () => {
    // The panel gates on validateDraft; this is the belt to that pair of braces.
    const next = applyDraft(
      DEFAULT_SETTINGS,
      draft({ workStart: 'nope', snoozeMinutes: '', workDays: [] }),
    );
    expect(next.workStart).toBe(DEFAULT_SETTINGS.workStart);
    expect(next.snoozeMinutes).toBe(DEFAULT_SETTINGS.snoozeMinutes);
    expect(next.workDays).toEqual(DEFAULT_SETTINGS.workDays);
  });

  it('reverts the work window as a pair when it would invert', () => {
    // Half-applying would leave a window no slot calculation can make sense of.
    const next = applyDraft(DEFAULT_SETTINGS, draft({ workStart: '18:00', workEnd: '09:00' }));
    expect(next.workStart).toBe(DEFAULT_SETTINGS.workStart);
    expect(next.workEnd).toBe(DEFAULT_SETTINGS.workEnd);
  });

  it('does not alias the day list back to the base settings', () => {
    const base = parseSettings({});
    const next = applyDraft(base, draft({ workDays: [] }));
    next.workDays.push(6);
    expect(base.workDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('produces settings that survive a save/load round trip', () => {
    const next = applyDraft(DEFAULT_SETTINGS, draft({ workStart: '06:00', snoozeMinutes: '45' }));
    expect(parseSettings(JSON.parse(serializeSettings(next)))).toEqual(next);
  });
});
