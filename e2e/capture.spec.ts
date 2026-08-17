/**
 * Screenshot capture.
 *
 * These are tests rather than a separate script on purpose: each one asserts the
 * card actually rendered before saving, so a broken build produces a failure
 * instead of a picture of a blank window. The images land in `docs/screenshots/`
 * for the README and for eyeballing a change.
 *
 * Run just these with:
 *   npx playwright test capture
 */

import { expect, test } from '@playwright/test';

import { startApp, dayFile, openSettings, openTeam } from './harness.ts';

const SHOTS = 'docs/screenshots';

/** Match the real Tauri window so the shots show true proportions. */
test.use({ viewport: { width: 420, height: 470 } });

/**
 * The entrance transition is CSS, driven by the compositor rather than by the
 * mocked clock, so it needs a real wait before the card is fully opaque.
 */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('#card')).toHaveClass(/is-open/);
  await page.waitForTimeout(600);
}

test('capture: the day-start check-in', async ({ page }) => {
  await startApp(page, {
    files: {
      '2026-07-31.md': dayFile('2026-07-31', [
        { title: 'Draft the migration RFC', marker: '/' },
        { title: 'Review the release checklist', marker: ' ' },
      ]),
    },
  });

  await settle(page);
  await page.screenshot({ path: `${SHOTS}/day-start.png` });
});

test('capture: an hourly check-in mid-flow', async ({ page }) => {
  // The day must already be open, or the scheduler correctly upgrades this to a
  // day-start and the shot shows the wrong prompt.
  await startApp(page, {
    now: new Date(2026, 7, 3, 14, 20),
    files: {
      '2026-08-03.md': dayFile(
        '2026-08-03',
        [
          { title: 'Ship the rollback path', marker: '/' },
          { title: 'Review the release checklist', marker: 'x' },
          { title: 'Pair with @alice on the RFC', marker: ' ' },
        ],
        { lastCheckIn: '13:00' },
      ),
    },
  });

  await expect(page.locator('#headline')).toHaveText('Quick check-in');
  await page.fill('#note-input', '@alice unblocked the release #kudos');

  await settle(page);
  await page.screenshot({ path: `${SHOTS}/hourly.png` });
});

test('capture: the settings panel', async ({ page }) => {
  await startApp(page, {
    settings: { workStart: '08:30', workEnd: '17:00', snoozeMinutes: 10 },
  });

  await openSettings(page);
  await expect(page.locator('#settings')).toHaveClass(/is-open/);
  await page.waitForTimeout(600);

  await page.screenshot({ path: `${SHOTS}/settings.png` });
});

test('capture: the end-of-day wrap-up', async ({ page }) => {
  await startApp(page, {
    now: new Date(2026, 7, 3, 17, 15),
    files: {
      '2026-08-03.md': dayFile(
        '2026-08-03',
        [
          { title: 'Ship the rollback path', marker: 'x' },
          { title: 'Review the release checklist', marker: 'x' },
          { title: 'Draft the migration RFC', marker: '/' },
        ],
        { lastCheckIn: '16:00' },
      ),
    },
  });

  await settle(page);
  await page.screenshot({ path: `${SHOTS}/day-end.png` });
});

test('capture: the last wrap-up of the week', async ({ page }) => {
  // 2026-08-07 is a Friday. The one shot where the weekend is visible in the
  // copy — the headline and the day it hands off to both change.
  await startApp(page, {
    now: new Date(2026, 7, 7, 17, 15),
    files: {
      '2026-08-07.md': dayFile(
        '2026-08-07',
        [
          { title: 'Ship the rollback path', marker: 'x' },
          { title: 'Draft the migration RFC', marker: '/' },
          { title: 'Review the release checklist', marker: ' ' },
        ],
        { lastCheckIn: '16:00' },
      ),
    },
  });

  await expect(page.locator('#headline')).toHaveText('Wrapping up the week');
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/week-end.png` });
});

test('capture: the day-end wrap-up with manager mode on', async ({ page }) => {
  // The one shot that shows the extra day-end step manager mode adds.
  await startApp(page, {
    now: new Date(2026, 7, 3, 17, 15),
    settings: { managerModeEnabled: true },
    files: {
      '2026-08-03.md': dayFile('2026-08-03', [{ title: 'Ship the rollback path', marker: 'x' }], {
        lastCheckIn: '16:00',
      }),
    },
  });

  await expect(page.locator('#team-day-end-form')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/day-end-manager-mode.png` });
});

test('capture: the Team panel', async ({ page }) => {
  await startApp(page);
  await openTeam(page);

  await page.fill('#team-person-input', 'alice');
  await page.press('#team-person-input', 'Enter');
  await page.fill('#team-task-input', 'Migrate the queue consumer');
  await page.press('#team-task-input', 'Enter');
  await page.fill('#team-note-input', 'Shipped the migration script #kudos');
  await page.press('#team-note-input', 'Enter');

  await expect(page.locator('#team')).toHaveClass(/is-open/);
  await page.waitForTimeout(600);

  await page.screenshot({ path: `${SHOTS}/team.png` });
});
