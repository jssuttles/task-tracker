/**
 * The check-in loop, driven end to end in a browser.
 *
 * These assertions are deliberately about things the unit suite *cannot* see:
 * that the controller finds its elements, that clicks reach the model, that a
 * finished check-in lands on disk as valid Markdown, and that the scheduler
 * behaves across a simulated restart.
 */

import { expect, test } from '@playwright/test';

import { advanceMinutes, dayFile, listVaultFiles, readVaultFile, startApp } from './harness.ts';

/** Fail loudly on any uncaught page error — a dead app often logs before it dies. */
test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`Uncaught page error: ${error.message}`);
  });
});

test('opens a fresh day with the day-start check-in', async ({ page }) => {
  await startApp(page);

  await expect(page.locator('#card')).toHaveClass(/is-open/);
  await expect(page.locator('#headline')).toHaveText("Here's your day");
  await expect(page.locator('#empty-state')).toBeVisible();
});

test('shows the day-start prompt on a late start, not an hourly nudge', async ({ page }) => {
  // Machine was off at 09:00; first launch of the day is at 14:20.
  await startApp(page, { now: new Date(2026, 7, 3, 14, 20) });

  await expect(page.locator('#headline')).toHaveText("Here's your day");
});

test('adds a task and renders it', async ({ page }) => {
  await startApp(page);

  await page.fill('#task-input', 'Draft the migration RFC');
  await page.press('#task-input', 'Enter');

  await expect(page.locator('.task-title')).toHaveText('Draft the migration RFC');
  await expect(page.locator('#empty-state')).toBeHidden();
  // The input clears so the next task can be typed straight away.
  await expect(page.locator('#task-input')).toHaveValue('');
});

test('cycles a task through its three states', async ({ page }) => {
  await startApp(page, { now: new Date(2026, 7, 3, 17, 30) });

  await page.fill('#task-input', 'Ship the rollback');
  await page.press('#task-input', 'Enter');

  const task = page.locator('.task').first();
  await expect(task).not.toHaveClass(/is-in-progress|is-completed/);

  await task.locator('.task-toggle').click();
  await expect(task).toHaveClass(/is-in-progress/);

  await task.locator('.task-toggle').click();
  await expect(task).toHaveClass(/is-completed/);
  await expect(page.locator('#subhead')).toHaveText('1 done, 0 open — plan tomorrow?');

  await task.locator('.task-toggle').click();
  await expect(task).not.toHaveClass(/is-in-progress|is-completed/);
  await expect(page.locator('#subhead')).toHaveText('0 done, 1 open — plan tomorrow?');
});

test('hides completed tasks on the next hourly check-in', async ({ page }) => {
  await startApp(page, {
    now: new Date(2026, 7, 3, 10, 0),
    files: { '2026-08-03.md': dayFile('2026-08-03', [], { lastCheckIn: '09:00' }) },
  });

  await page.fill('#task-input', 'Ship the rollback');
  await page.press('#task-input', 'Enter');
  await page.locator('.task-toggle').first().click();
  await page.locator('.task-toggle').first().click();
  await expect(page.locator('#subhead')).toHaveText('1 of 1 done');

  await page.click('#done');
  await expect(page.locator('#card')).not.toHaveClass(/is-open/);

  await advanceMinutes(page, 61);
  await expect(page.locator('#card')).toHaveClass(/is-open/);
  await expect(page.locator('#headline')).toHaveText('Quick check-in');
  await expect(page.locator('.task')).toHaveCount(0);
  await expect(page.locator('#subhead')).toHaveText('1 of 1 done');
});

test('moves a completed task to the bottom while the check-in is still open', async ({ page }) => {
  await startApp(page, {
    now: new Date(2026, 7, 3, 10, 0),
    files: { '2026-08-03.md': dayFile('2026-08-03', [], { lastCheckIn: '09:00' }) },
  });

  await page.fill('#task-input', 'Keep working');
  await page.press('#task-input', 'Enter');
  await page.fill('#task-input', 'Finish this one');
  await page.press('#task-input', 'Enter');

  const titles = page.locator('.task-title');
  await expect(titles).toHaveText(['Keep working', 'Finish this one']);

  await page.locator('.task').first().locator('.task-toggle').click();
  await expect(page.locator('.task').first()).toHaveClass(/is-in-progress/);
  await page.locator('.task').first().locator('.task-toggle').click();
  await expect(titles).toHaveText(['Finish this one', 'Keep working']);
  await expect(page.locator('.task').last()).toHaveClass(/is-completed/);
});

test('removes a task', async ({ page }) => {
  await startApp(page);

  await page.fill('#task-input', 'Delete me');
  await page.press('#task-input', 'Enter');
  await expect(page.locator('.task')).toHaveCount(1);

  await page.locator('.task-remove').click();
  await expect(page.locator('.task')).toHaveCount(0);
  await expect(page.locator('#empty-state')).toBeVisible();
});

test('writes a well-formed day file when the check-in is finished', async ({ page }) => {
  await startApp(page);

  await page.fill('#task-input', 'Ship the rollback');
  await page.press('#task-input', 'Enter');
  await page.locator('.task-toggle').first().click();

  await page.fill('#note-input', '@alice unblocked the release #kudos');
  await page.press('#note-input', 'Enter');

  await page.click('#done');
  await expect(page.locator('#card')).not.toHaveClass(/is-open/);

  const contents = await readVaultFile(page, '2026-08-03.md');
  expect(contents).not.toBeNull();
  expect(contents).toContain('date: 2026-08-03');
  expect(contents).toContain('# Monday, 3 August 2026');
  expect(contents).toContain('- [/] Ship the rollback');
  expect(contents).toContain('- 10:30 — @alice unblocked the release #kudos');
  // The scheduler's memory, without which a restart re-prompts.
  expect(contents).toContain('last_check_in: 10:00');
});

test('publishes the agent guide into the vault on launch', async ({ page }) => {
  await startApp(page);

  expect(await listVaultFiles(page)).toContain('CONTEXT.md');
  const guide = await readVaultFile(page, 'CONTEXT.md');
  expect(guide).toContain('Task Tracker');
  expect(guide).toContain('#kudos');
});

test("carries yesterday's unfinished work into today", async ({ page }) => {
  await startApp(page, {
    files: {
      '2026-07-31.md': dayFile('2026-07-31', [
        { title: 'Carried over', marker: '/' },
        { title: 'Also carried', marker: ' ' },
        { title: 'Already finished', marker: 'x' },
      ]),
    },
  });

  const titles = page.locator('.task-title');
  await expect(titles).toHaveText(['Carried over', 'Also carried']);
  // The marker that says "this one keeps slipping".
  await expect(page.locator('.task').first()).toHaveClass(/is-carried/);

  // And the day file records when each one first appeared, so the span from
  // start to finish is readable off a single line later.
  await page.click('#done');
  const written = await readVaultFile(page, '2026-08-03.md');
  expect(written).toContain('- [/] Carried over _(added 2026-07-31)_');
  expect(written).toContain('- [ ] Also carried _(added 2026-07-31)_');
});

test('still marks slipped work as carried after a restart', async ({ page }) => {
  // The regression: "carried" was a flag set at carry-over time and never
  // written to the file, so a relaunch mid-day re-read today's tasks with the
  // flag gone and the marker silently vanished from exactly the work it exists
  // to highlight. It is derived from the recorded date now.
  await startApp(page, {
    now: new Date(2026, 7, 3, 10, 45),
    files: {
      '2026-08-03.md': dayFile('2026-08-03', [
        { title: 'Slipped from Friday', marker: '/', added: '2026-07-31' },
        { title: 'Started today', marker: ' ' },
      ]),
    },
  });

  await expect(page.locator('.task').first()).toHaveClass(/is-carried/);
  await expect(page.locator('.task').nth(1)).not.toHaveClass(/is-carried/);
});

test('a task added today is not annotated as if it predated the day', async ({ page }) => {
  await startApp(page);

  await page.fill('#task-input', 'Started this morning');
  await page.press('#task-input', 'Enter');
  await page.click('#done');

  const written = await readVaultFile(page, '2026-08-03.md');
  expect(written).toContain('- [ ] Started this morning\n');
  expect(written).not.toContain('Started this morning _(added');
});

test('does not re-prompt for a check-in completed before a restart', async ({ page }) => {
  // The regression: scheduler state used to live only in memory, so relaunching
  // mid-morning re-asked for a check-in the user had already finished.
  await startApp(page, {
    now: new Date(2026, 7, 3, 10, 45),
    files: { '2026-08-03.md': dayFile('2026-08-03', [], { lastCheckIn: '10:00' }) },
  });

  await expect(page.locator('#card')).not.toHaveClass(/is-open/);
});

test('prompts again at the next hour', async ({ page }) => {
  await startApp(page);

  await page.click('#done');
  await expect(page.locator('#card')).not.toHaveClass(/is-open/);

  await advanceMinutes(page, 31);
  await expect(page.locator('#card')).toHaveClass(/is-open/);
  await expect(page.locator('#headline')).toHaveText('Quick check-in');
});

test('Esc snoozes, and the card returns when the snooze lapses', async ({ page }) => {
  await startApp(page);

  await page.press('body', 'Escape');
  await expect(page.locator('#card')).not.toHaveClass(/is-open/);

  await advanceMinutes(page, 5);
  await expect(page.locator('#card')).not.toHaveClass(/is-open/);

  await advanceMinutes(page, 7);
  await expect(page.locator('#card')).toHaveClass(/is-open/);
});

test('copies a standup summary to the clipboard', async ({ page }) => {
  await startApp(page, {
    files: {
      '2026-07-31.md': dayFile('2026-07-31', [{ title: 'Finished on Friday', marker: 'x' }]),
    },
  });

  await page.fill('#task-input', 'Today’s work');
  await page.press('#task-input', 'Enter');
  await page.click('#copy-standup');

  await expect(page.locator('#status')).toHaveClass(/is-visible/);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('Finished on Friday');
  expect(clipboard).toContain('Today’s work');
});

test('copies the week to the clipboard, framed for an agent', async ({ page }) => {
  // Monday 2026-08-03 and Tuesday 2026-08-04 are the same ISO week, so both
  // land in the briefing — this is the assertion that it reads a *week* off
  // disk rather than whatever the open card happens to hold.
  await startApp(page, {
    now: new Date(2026, 7, 4, 10, 30),
    files: {
      '2026-08-03.md': dayFile('2026-08-03', [{ title: 'Shipped on Monday', marker: 'x' }]),
      '2026-08-04.md': dayFile('2026-08-04', [{ title: 'Still going on Tuesday', marker: '/' }], {
        lastCheckIn: '09:00',
      }),
    },
  });

  await page.evaluate(() => {
    document.getElementById('copy-week')?.click();
  });
  await expect(page.locator('#status')).toHaveClass(/is-visible/);

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('# Week 2026-W32');
  expect(clipboard).toContain('Shipped on Monday');
  expect(clipboard).toContain('Still going on Tuesday');
  // The schema key that makes it stand alone in a chat.
  expect(clipboard).toContain('`@name` is a colleague');
});

test('says so rather than copying an empty week', async ({ page }) => {
  await startApp(page, { now: new Date(2026, 7, 4, 10, 30) });

  await page.evaluate(() => {
    document.getElementById('copy-week')?.click();
  });

  await expect(page.locator('#status')).toHaveText('No entries this week');
});

test('renders task titles as text, never as markup', async ({ page }) => {
  // Vault content round-trips through files other tools can write.
  await startApp(page);

  await page.fill('#task-input', '<img src=x onerror="window.__pwned=1">');
  await page.press('#task-input', 'Enter');

  await expect(page.locator('.task-title')).toHaveText('<img src=x onerror="window.__pwned=1">');
  expect(await page.evaluate(() => '__pwned' in window)).toBe(false);
});

test('stays quiet outside the work window', async ({ page }) => {
  await startApp(page, { now: new Date(2026, 7, 3, 7, 0) });

  await expect(page.locator('#card')).not.toHaveClass(/is-open/);
});

test('stays quiet at the weekend', async ({ page }) => {
  // 2026-08-01 is a Saturday.
  await startApp(page, { now: new Date(2026, 7, 1, 12, 0) });

  await expect(page.locator('#card')).not.toHaveClass(/is-open/);
});

test('prompts on a Saturday when Saturday is a working day', async ({ page }) => {
  await startApp(page, {
    now: new Date(2026, 7, 1, 12, 0),
    settings: { workDays: [2, 3, 4, 5, 6] },
  });

  await expect(page.locator('#card')).toHaveClass(/is-open/);
});

test('stays quiet on a Monday that is not a working day', async ({ page }) => {
  // A Tuesday-to-Saturday week: Monday is the weekend.
  await startApp(page, { settings: { workDays: [2, 3, 4, 5, 6] } });

  await expect(page.locator('#card')).not.toHaveClass(/is-open/);
});

test("Monday inherits Friday's unfinished work across the weekend", async ({ page }) => {
  await startApp(page, {
    files: {
      '2026-07-31.md': dayFile('2026-07-31', [
        { title: 'Still going on Monday', marker: '/' },
        { title: 'Shipped on Friday', marker: 'x' },
      ]),
    },
  });

  await expect(page.locator('.task-title')).toHaveText(['Still going on Monday']);
});

test('heals a weekly rollup that a skipped Friday wrap-up never wrote', async ({ page }) => {
  // Knocking off early on Friday used to lose that week's rollup permanently,
  // because the rollup was only ever written by a day-end check-in.
  await startApp(page, {
    files: {
      '2026-07-31.md': dayFile('2026-07-31', [{ title: 'Shipped on Friday', marker: 'x' }]),
    },
  });

  expect(await readVaultFile(page, '2026-W31.md')).toBeNull();

  await page.click('#done');
  await expect(page.locator('#card')).not.toHaveClass(/is-open/);

  const healed = await readVaultFile(page, '2026-W31.md');
  expect(healed).not.toBeNull();
  expect(healed).toContain('# Week 2026-W31');
  expect(healed).toContain('Shipped on Friday');

  // …and the current week is written too, not replaced by the healed one.
  expect(await readVaultFile(page, '2026-W32.md')).toContain('# Week 2026-W32');
});

test('refreshes the rollup on an ordinary check-in, not only at day-end', async ({ page }) => {
  await startApp(page, {
    now: new Date(2026, 7, 3, 14, 20),
    files: { '2026-08-03.md': dayFile('2026-08-03', [], { lastCheckIn: '13:00' }) },
  });

  await page.fill('#task-input', 'Mid-afternoon work');
  await page.press('#task-input', 'Enter');
  await page.locator('.task-toggle').first().click();
  await page.click('#done');

  expect(await readVaultFile(page, '2026-W32.md')).toContain('Mid-afternoon work');
});

test('asks for the wrap-up after the work day ends', async ({ page }) => {
  await startApp(page, { now: new Date(2026, 7, 3, 17, 30) });

  await expect(page.locator('#card')).toHaveClass(/is-open/);
  await expect(page.locator('#headline')).toHaveText('Wrapping up');
});

test("Friday's wrap-up plans Monday, not a Saturday nobody works", async ({ page }) => {
  // 2026-08-07 is a Friday. The unit suite proves the arithmetic; this proves
  // the controller actually asks the scheduler instead of hard-coding the word.
  await startApp(page, { now: new Date(2026, 7, 7, 17, 30) });

  await expect(page.locator('#headline')).toHaveText('Wrapping up the week');
  await expect(page.locator('#subhead')).toHaveText('0 done, 0 open — plan Monday?');
});

test('a shifted week ends on its own last day', async ({ page }) => {
  // Sunday-to-Thursday: Thursday 2026-08-06 is the wrap-up that matters, and
  // the day it hands off to is Sunday.
  await startApp(page, {
    now: new Date(2026, 7, 6, 17, 30),
    settings: { workDays: [0, 1, 2, 3, 4] },
  });

  await expect(page.locator('#headline')).toHaveText('Wrapping up the week');
  await expect(page.locator('#subhead')).toContainText('plan Sunday?');
});

test('a mid-week wrap-up stays an ordinary wrap-up', async ({ page }) => {
  // Wednesdays off. Tuesday is followed by a day off but is not the end of the
  // week — the headline must not claim otherwise.
  await startApp(page, {
    now: new Date(2026, 7, 4, 17, 30),
    settings: { workDays: [1, 2, 4, 5] },
  });

  await expect(page.locator('#headline')).toHaveText('Wrapping up');
  await expect(page.locator('#subhead')).toContainText('plan Thursday?');
});

test('writes a weekly rollup when the day is wrapped up', async ({ page }) => {
  await startApp(page, { now: new Date(2026, 7, 3, 17, 30) });

  await page.fill('#task-input', 'Shipped it');
  await page.press('#task-input', 'Enter');
  await page.locator('.task-toggle').first().click();

  await page.click('#done');

  const rollup = await readVaultFile(page, '2026-W32.md');
  expect(rollup).not.toBeNull();
  expect(rollup).toContain('# Week 2026-W32');
  expect(rollup).toContain('Shipped it');
});
