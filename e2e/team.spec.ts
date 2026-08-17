/**
 * Manager mode, driven end to end in a browser: the Team panel and the
 * day-end step it adds. Same reasoning as `checkin.spec.ts` — this proves the
 * controller finds the Team panel's elements and that its writes land as
 * valid Markdown, which the unit suite cannot see.
 */

import { expect, test } from '@playwright/test';

import {
  advanceMinutes,
  dayFile,
  listVaultFiles,
  openSettings,
  openTeam,
  readSettings,
  readVaultFile,
  startApp,
  teamFile,
} from './harness.ts';

test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`Uncaught page error: ${error.message}`);
  });
});

test('opens the Team panel empty, with no reports tracked yet', async ({ page }) => {
  await startApp(page);
  await openTeam(page);

  await expect(page.locator('#team')).toBeVisible();
  await expect(page.locator('#team-empty-state')).toBeVisible();
  await expect(page.locator('#team-task-list .task')).toHaveCount(0);
});

test('creates nothing until the first task or note is logged', async ({ page }) => {
  await startApp(page);
  await openTeam(page);

  await page.fill('#team-person-input', 'alice');
  await page.press('#team-person-input', 'Enter');

  // Opening a report is not the same as logging something about them — there
  // is no roster, so no file should exist until there's something to save.
  expect(await listVaultFiles(page)).not.toContain('team.alice.md');
});

test('adds a task and a note for a report, writing their file', async ({ page }) => {
  await startApp(page);
  await openTeam(page);

  await page.fill('#team-person-input', 'alice');
  await page.press('#team-person-input', 'Enter');

  await page.fill('#team-task-input', 'Migrate the queue consumer');
  await page.press('#team-task-input', 'Enter');
  await expect(page.locator('#team-task-list .task-title')).toHaveText(
    'Migrate the queue consumer',
  );
  await expect(page.locator('#team-task-input')).toHaveValue('');

  await page.fill('#team-note-input', 'Shipped the migration script #kudos');
  await page.press('#team-note-input', 'Enter');

  const contents = await readVaultFile(page, 'team.alice.md');
  expect(contents).not.toBeNull();
  expect(contents).toContain('person: alice');
  expect(contents).toContain('- [ ] Migrate the queue consumer');
  expect(contents).toContain('Shipped the migration script #kudos');
});

test("cycles a report's task through its three states", async ({ page }) => {
  await startApp(page);
  await openTeam(page);

  await page.fill('#team-person-input', 'alice');
  await page.press('#team-person-input', 'Enter');
  await page.fill('#team-task-input', 'Ship the rollback');
  await page.press('#team-task-input', 'Enter');

  const task = page.locator('#team-task-list .task').first();
  await expect(task).not.toHaveClass(/is-in-progress|is-completed/);

  await task.locator('.task-toggle').click();
  await expect(task).toHaveClass(/is-in-progress/);

  await task.locator('.task-toggle').click();
  await expect(task).toHaveClass(/is-completed/);

  await task.locator('.task-toggle').click();
  await expect(task).not.toHaveClass(/is-in-progress|is-completed/);
});

test('removes a task from a report', async ({ page }) => {
  await startApp(page);
  await openTeam(page);

  await page.fill('#team-person-input', 'alice');
  await page.press('#team-person-input', 'Enter');
  await page.fill('#team-task-input', 'Delete me');
  await page.press('#team-task-input', 'Enter');
  await expect(page.locator('#team-task-list .task')).toHaveCount(1);

  await page.locator('#team-task-list .task-remove').click();
  await expect(page.locator('#team-task-list .task')).toHaveCount(0);
  await expect(page.locator('#team-empty-state')).toBeVisible();
});

test('tracks two reports independently', async ({ page }) => {
  await startApp(page);
  await openTeam(page);

  await page.fill('#team-person-input', 'alice');
  await page.press('#team-person-input', 'Enter');
  await page.fill('#team-task-input', 'Alice task');
  await page.press('#team-task-input', 'Enter');

  await page.fill('#team-person-input', 'bob');
  await page.press('#team-person-input', 'Enter');
  await page.fill('#team-task-input', 'Bob task');
  await page.press('#team-task-input', 'Enter');

  // Switching to bob shows only bob's tasks — alice's are not carried along.
  await expect(page.locator('#team-task-list .task-title')).toHaveText('Bob task');

  expect(await readVaultFile(page, 'team.alice.md')).toContain('Alice task');
  expect(await readVaultFile(page, 'team.bob.md')).toContain('Bob task');
});

test('reports an invalid handle instead of creating a file', async ({ page }) => {
  await startApp(page);
  await openTeam(page);

  await page.fill('#team-person-input', 'Not Valid');
  await page.press('#team-person-input', 'Enter');

  await expect(page.locator('#team-person-error')).not.toBeEmpty();
  const files = await listVaultFiles(page);
  expect(files.some((name) => name.startsWith('team.'))).toBe(false);
});

test('Esc closes the Team panel instead of snoozing the check-in behind it', async ({ page }) => {
  await startApp(page);

  await expect(page.locator('#card')).toHaveClass(/is-open/);
  await openTeam(page);

  await page.keyboard.press('Escape');

  await expect(page.locator('#team')).toBeHidden();
  await expect(page.locator('#card')).toHaveClass(/is-open/);
});

test('does not open a check-in on top of the Team panel', async ({ page }) => {
  await startApp(page, {
    files: { '2026-08-03.md': dayFile('2026-08-03', [], { lastCheckIn: '10:00' }) },
  });
  await expect(page.locator('#card')).not.toHaveClass(/is-open/);

  await openTeam(page);
  await advanceMinutes(page, 60);

  await expect(page.locator('#team')).toBeVisible();
  await expect(page.locator('#card')).not.toHaveClass(/is-open/);

  await page.click('#team-close');
  await advanceMinutes(page, 1);
  await expect(page.locator('#card')).toHaveClass(/is-open/);
});

test('the Team panel and Settings do not open on top of each other', async ({ page }) => {
  await startApp(page);
  await openTeam(page);
  await expect(page.locator('#team')).toBeVisible();

  await page.evaluate(() => {
    document.getElementById('settings-open')?.click();
  });
  await expect(page.locator('#settings')).toBeHidden();
  await expect(page.locator('#team')).toBeVisible();
});

test('shows the day-end team step only with manager mode on', async ({ page }) => {
  await startApp(page, {
    now: new Date(2026, 7, 3, 17, 30),
    settings: { managerModeEnabled: true },
  });

  await expect(page.locator('#headline')).toHaveText('Wrapping up');
  await expect(page.locator('#team-day-end-form')).toBeVisible();
});

test('hides the day-end team step when manager mode is off', async ({ page }) => {
  await startApp(page, { now: new Date(2026, 7, 3, 17, 30) });

  await expect(page.locator('#team-day-end-form')).toBeHidden();
});

test('hides the day-end team step outside day-end, even with manager mode on', async ({ page }) => {
  await startApp(page, { settings: { managerModeEnabled: true } });

  await expect(page.locator('#headline')).toHaveText("Here's your day");
  await expect(page.locator('#team-day-end-form')).toBeHidden();
});

test('shows the day-end team step immediately after enabling manager mode mid-check-in', async ({
  page,
}) => {
  // The regression: settings used to apply without re-rendering a check-in
  // already open behind the panel, so the new step wouldn't appear until some
  // unrelated interaction forced a re-render.
  await startApp(page, { now: new Date(2026, 7, 3, 17, 30) });

  await expect(page.locator('#headline')).toHaveText('Wrapping up');
  await expect(page.locator('#team-day-end-form')).toBeHidden();

  await page.evaluate(() => {
    document.getElementById('settings-open')?.click();
  });
  await page.check('#manager-mode-enabled');
  await page.click('#settings-save');
  await expect(page.locator('#settings')).toBeHidden();

  await expect(page.locator('#card')).toHaveClass(/is-open/);
  await expect(page.locator('#headline')).toHaveText('Wrapping up');
  await expect(page.locator('#team-day-end-form')).toBeVisible();
});

test('logs a day-end mention to the mentioned report, auto-creating their file', async ({
  page,
}) => {
  await startApp(page, {
    now: new Date(2026, 7, 3, 17, 30),
    settings: { managerModeEnabled: true },
  });

  await page.fill('#team-day-end-input', '@alice shipped the migration script');
  await page.press('#team-day-end-input', 'Enter');

  await expect(page.locator('#team-day-end-input')).toHaveValue('');
  const contents = await readVaultFile(page, 'team.alice.md');
  expect(contents).not.toBeNull();
  expect(contents).toContain('shipped the migration script');
});

test('asks for an @mention instead of silently doing nothing', async ({ page }) => {
  await startApp(page, {
    now: new Date(2026, 7, 3, 17, 30),
    settings: { managerModeEnabled: true },
  });

  await page.fill('#team-day-end-input', 'no mention here');
  await page.press('#team-day-end-input', 'Enter');

  await expect(page.locator('#status')).toContainText('Mention someone with @');
  expect(await listVaultFiles(page)).toHaveLength(1); // just CONTEXT.md
});

test('writes a team weekly rollup when the day is wrapped up', async ({ page }) => {
  await startApp(page, {
    now: new Date(2026, 7, 3, 17, 30),
    settings: { managerModeEnabled: true },
  });

  await page.fill('#team-day-end-input', '@alice shipped the migration script #kudos');
  await page.press('#team-day-end-input', 'Enter');

  await page.click('#done');

  const rollup = await readVaultFile(page, '2026-W32-team.md');
  expect(rollup).not.toBeNull();
  expect(rollup).toContain('## @alice');
  expect(rollup).toContain('shipped the migration script');
});

test('does not write a team rollup when manager mode is off', async ({ page }) => {
  await startApp(page, { now: new Date(2026, 7, 3, 17, 30) });

  await page.click('#done');

  expect(await readVaultFile(page, '2026-W32-team.md')).toBeNull();
});

test('copies the team week to the clipboard, framed for an agent', async ({ page }) => {
  await startApp(page, { now: new Date(2026, 7, 4, 10, 30) });
  await openTeam(page);

  await page.fill('#team-person-input', 'alice');
  await page.press('#team-person-input', 'Enter');
  await page.fill('#team-task-input', 'Migrate the queue consumer');
  await page.press('#team-task-input', 'Enter');

  await page.click('#team-copy-week');

  await expect(page.locator('#team-status')).toHaveClass(/is-visible/);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('Migrate the queue consumer');
  expect(clipboard).toContain('## @handle');
});

test('says so rather than copying an empty team week', async ({ page }) => {
  await startApp(page, { now: new Date(2026, 7, 4, 10, 30) });
  await openTeam(page);

  await page.click('#team-copy-week');

  await expect(page.locator('#team-status')).toHaveText('No reports tracked yet');
});

test('saves the manager mode setting', async ({ page }) => {
  await startApp(page);
  await openSettings(page);

  await page.check('#manager-mode-enabled');
  await page.click('#settings-save');
  await expect(page.locator('#settings')).toBeHidden();

  expect(await readSettings(page)).toMatchObject({ managerModeEnabled: true });
});

test('records a completion date when a task is marked done via the Team panel', async ({
  page,
}) => {
  await startApp(page);
  await openTeam(page);

  await page.fill('#team-person-input', 'alice');
  await page.press('#team-person-input', 'Enter');
  await page.fill('#team-task-input', 'Ship the migration');
  await page.press('#team-task-input', 'Enter');

  const toggle = page.locator('#team-task-list .task-toggle').first();
  await toggle.click(); // upcoming -> in-progress
  await toggle.click(); // in-progress -> completed

  const contents = await readVaultFile(page, 'team.alice.md');
  // 2026-08-03 is the frozen clock's date in every test that doesn't override `now`.
  expect(contents).toContain('- [x] Ship the migration _(2026-08-03)_');
});

test('drops the completion date when a task is reopened', async ({ page }) => {
  await startApp(page);
  await openTeam(page);

  await page.fill('#team-person-input', 'alice');
  await page.press('#team-person-input', 'Enter');
  await page.fill('#team-task-input', 'Ship the migration');
  await page.press('#team-task-input', 'Enter');

  const toggle = page.locator('#team-task-list .task-toggle').first();
  await toggle.click(); // -> in-progress
  await toggle.click(); // -> completed
  await toggle.click(); // -> upcoming again

  const contents = await readVaultFile(page, 'team.alice.md');
  expect(contents).toContain('- [ ] Ship the migration\n');
  expect(contents).not.toContain('_(2026-08-03)_');
});

test("excludes a task completed in a previous week from this week's team rollup", async ({
  page,
}) => {
  // The bug this guards: a team task's status is a permanent field on one
  // running file, not scoped to a day the way a personal day file's tasks
  // are — without date-scoping, every week's rollup would repeat every
  // completion the report has ever had.
  await startApp(page, {
    now: new Date(2026, 7, 3, 17, 30),
    settings: { managerModeEnabled: true },
    files: {
      'team.alice.md': teamFile('alice', [
        { title: 'Shipped last month', marker: 'x', completedDate: '2026-07-01' },
      ]),
    },
  });

  await page.click('#done');

  const rollup = await readVaultFile(page, '2026-W32-team.md');
  expect(rollup).not.toBeNull();
  expect(rollup).not.toContain('Shipped last month');
  expect(rollup).toContain('Nothing completed this week');
});

test('surfaces kudos and blockers in the team rollup, not duplicated under Notes', async ({
  page,
}) => {
  await startApp(page, {
    now: new Date(2026, 7, 3, 17, 30),
    settings: { managerModeEnabled: true },
    files: {
      'team.alice.md': teamFile(
        'alice',
        [],
        [
          { date: '2026-08-03', text: 'Shipped the release #kudos' },
          { date: '2026-08-03', text: 'Waiting on review #blocker' },
          { date: '2026-08-03', text: 'A routine update' },
        ],
      ),
    },
  });

  await page.click('#done');

  const rollup = await readVaultFile(page, '2026-W32-team.md');
  expect(rollup).not.toBeNull();
  expect(rollup).toContain('### Kudos');
  expect(rollup).toContain('- Shipped the release #kudos');
  expect(rollup).toContain('### Blockers');
  expect(rollup).toContain('- Waiting on review #blocker');

  const notesSection = (rollup ?? '').split('### Notes this week')[1]?.split('### Open')[0] ?? '';
  expect(notesSection).not.toContain('#kudos');
  expect(notesSection).not.toContain('#blocker');
  expect(notesSection).toContain('A routine update');
});
