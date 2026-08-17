/**
 * Shared setup for driving the app in a browser.
 *
 * Two things have to be controlled to make the check-in loop deterministic:
 * the clock (the scheduler asks "what time is it?" on every tick) and the vault
 * (carry-over and restart behavior depend on what's already on disk). Both are
 * seeded through the same `localStorage` keys the browser build already uses, so
 * no test-only hooks leak into the app itself.
 */

import type { Page } from '@playwright/test';

/** Mirrors the prefixes in `src/lib/tauri.ts`. */
const VAULT_PREFIX = 'task-tracker:vault:';
const SETTINGS_KEY = 'task-tracker:settings';

/** A fixed Monday, 10:30 local — inside a 09:00–17:00 workday. */
export const MONDAY_1030 = new Date(2026, 7, 3, 10, 30);

export interface SeedOptions {
  /** Simulated wall-clock time. */
  now?: Date;
  /** Settings overrides, merged over a standard 09:00–17:00 weekday. */
  settings?: Record<string, unknown>;
  /** Vault files keyed by name, e.g. `{ '2026-07-31.md': '…' }`. */
  files?: Record<string, string>;
}

/**
 * Prepare a page: freeze the clock and seed `localStorage`, then load the app.
 *
 * Playwright's fake clock does not advance on its own, which is what makes the
 * scheduler testable — but it also freezes `requestAnimationFrame`, and the card
 * adds its `.is-open` class inside a rAF callback. So we advance a beat after
 * load to let that flush.
 */
export async function startApp(page: Page, options: SeedOptions = {}): Promise<void> {
  const now = options.now ?? MONDAY_1030;

  await page.clock.install({ time: now });

  const settings = {
    workStart: '09:00',
    workEnd: '17:00',
    vaultDir: '',
    hourlyEnabled: true,
    snoozeMinutes: 10,
    workDays: [1, 2, 3, 4, 5],
    ...options.settings,
  };

  await page.addInitScript(
    ({ settingsKey, vaultPrefix, settingsJson, files }) => {
      localStorage.clear();
      localStorage.setItem(settingsKey, settingsJson);
      for (const [name, contents] of Object.entries(files)) {
        localStorage.setItem(vaultPrefix + name, contents);
      }
    },
    {
      settingsKey: SETTINGS_KEY,
      vaultPrefix: VAULT_PREFIX,
      settingsJson: JSON.stringify(settings),
      files: options.files ?? {},
    },
  );

  await page.goto('/');
  // Flush the rAF that reveals the card, plus any startup awaits.
  await page.clock.runFor(100);
}

/** Read a file out of the browser-backed vault. */
export function readVaultFile(page: Page, name: string): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), VAULT_PREFIX + name);
}

/** The settings the app has persisted, parsed. */
export function readSettings(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  }, SETTINGS_KEY);
}

/**
 * Open the settings panel and let its entrance animation start.
 *
 * The click is dispatched through the DOM rather than Playwright's normal click
 * because the gear lives in the card header, and the card is parked off-stage
 * (`translateX(-110%)`) whenever no check-in is up. On the desktop that case is
 * reached from the tray instead, which a browser has no way to emulate — the
 * controller runs the same `openSettings()` either way, so this exercises the
 * real path including the standalone-window branch.
 */
export async function openSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('settings-open')?.click();
  });
  // Flush the rAF that adds `.is-open`, the same beat `startApp` gives the card.
  await page.clock.runFor(100);
}

/** Open the Team panel the same way `openSettings` opens Settings — see there for why. */
export async function openTeam(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('team-open')?.click();
  });
  await page.clock.runFor(100);
}

/** Every filename currently in the browser-backed vault. */
export function listVaultFiles(page: Page): Promise<string[]> {
  return page.evaluate((prefix) => {
    const names: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix) === true) names.push(key.slice(prefix.length));
    }
    return names.sort();
  }, VAULT_PREFIX);
}

/**
 * Advance the simulated clock and let the scheduler tick.
 *
 * The controller re-evaluates once a minute, so anything shorter can't surface a
 * new check-in no matter how the slots fall.
 */
export async function advanceMinutes(page: Page, minutes: number): Promise<void> {
  await page.clock.runFor(minutes * 60_000);
}

/**
 * A minimal day file, written the way the app writes them.
 *
 * `added` puts the `_(added …)_` suffix on a task, which is how a file records
 * that the task predates it. Omit it for work that started on `date`.
 */
export function dayFile(
  date: string,
  tasks: readonly { title: string; marker: ' ' | '/' | 'x'; added?: string }[],
  extra: { lastCheckIn?: string; formatVersion?: number } = {},
): string {
  const version = extra.formatVersion ?? 2;
  const frontmatter = [
    '---',
    // Version 1 is the legacy format, which had no such key. Pass it to seed a
    // file as an older build would have written it.
    ...(version <= 1 ? [] : [`format: ${String(version)}`]),
    `date: ${date}`,
    'work_start: 09:00',
    'work_end: 17:00',
    ...(extra.lastCheckIn === undefined ? [] : [`last_check_in: ${extra.lastCheckIn}`]),
    '---',
  ];

  const taskLines =
    tasks.length > 0
      ? tasks.map(
          (task) =>
            `- [${task.marker}] ${task.title}${task.added === undefined ? '' : ` _(added ${task.added})_`}`,
        )
      : ['_No tasks yet._'];

  return [
    ...frontmatter,
    '',
    `# ${date}`,
    '',
    '## Tasks',
    '',
    ...taskLines,
    '',
    '## Notes',
    '',
    '_No notes yet._',
    '',
  ].join('\n');
}

/** A minimal team file, written the way the app writes them. */
export function teamFile(
  person: string,
  tasks: readonly { title: string; marker: ' ' | '/' | 'x'; completedDate?: string }[],
  notes: readonly { date: string; text: string }[] = [],
): string {
  const taskLines =
    tasks.length > 0
      ? tasks.map((task) => {
          const suffix =
            task.marker === 'x' && task.completedDate !== undefined
              ? ` _(${task.completedDate})_`
              : '';
          return `- [${task.marker}] ${task.title}${suffix}`;
        })
      : ['_Nothing tracked yet._'];

  const noteLines =
    notes.length > 0 ? notes.map((note) => `- ${note.date} — ${note.text}`) : ['_No notes yet._'];

  return [
    '---',
    `person: ${person}`,
    '---',
    '',
    `# @${person}`,
    '',
    '## Tasks',
    '',
    ...taskLines,
    '',
    '## Notes',
    '',
    ...noteLines,
    '',
  ].join('\n');
}
