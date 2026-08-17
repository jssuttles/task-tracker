/**
 * The expand/collapse toggle, driven end to end.
 *
 * The actual resize is a Tauri window call with nothing to verify in a
 * browser (`setWindowSize` no-ops outside Tauri — see `src/lib/tauri.ts`).
 * What these prove is the part a browser *can* see: one flag drives three
 * separate buttons (card, Settings, Team) and they never fall out of sync,
 * and toggling never throws with no native window behind it.
 */

import { expect, test } from '@playwright/test';

import { openSettings, openTeam, startApp } from './harness.ts';

test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`Uncaught page error: ${error.message}`);
  });
});

test('toggles the card button between Expand and Collapse', async ({ page }) => {
  await startApp(page);

  const button = page.locator('#card-expand');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).toHaveAttribute('title', 'Expand');

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAttribute('title', 'Collapse');

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).toHaveAttribute('title', 'Expand');
});

test('stays in sync across the card, Settings and Team headers', async ({ page }) => {
  await startApp(page);

  await page.click('#card-expand');
  await expect(page.locator('#card-expand')).toHaveAttribute('aria-pressed', 'true');

  // Opened fresh, Settings reflects the same expanded state — this is one
  // flag, not three independent ones.
  await openSettings(page);
  await expect(page.locator('#settings-expand')).toHaveAttribute('aria-pressed', 'true');

  // Collapsing from Settings...
  await page.click('#settings-expand');
  await expect(page.locator('#settings-expand')).toHaveAttribute('aria-pressed', 'false');
  await page.click('#settings-cancel');

  // ...is reflected back on the card, and on Team.
  await expect(page.locator('#card-expand')).toHaveAttribute('aria-pressed', 'false');
  await openTeam(page);
  await expect(page.locator('#team-expand')).toHaveAttribute('aria-pressed', 'false');
});

test('a rapid double-click nets back to the original state, not stuck expanded', async ({
  page,
}) => {
  // The regression: `expanded` used to flip only after `setWindowSize`
  // resolved, so a second click fired before that (real, IPC-latency) gap
  // closed read the same stale flag as the first and computed the same
  // target size — a double-click meant to toggle back netted out expanded
  // instead. Dispatching both clicks inside one `evaluate` call, rather than
  // two awaited `page.click()`s, is what reproduces that: it fires the second
  // click before the first's async continuation has had a chance to run,
  // which two round trips through Playwright's own IPC would not.
  await startApp(page);

  await page.evaluate(() => {
    const button = document.getElementById('card-expand');
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  await expect(page.locator('#card-expand')).toHaveAttribute('aria-pressed', 'false');
});

test('does not throw with no native window behind it', async ({ page }) => {
  // The `beforeEach` above fails the test on any uncaught page error, so a
  // clean run here is the assertion — `setWindowSize`'s no-op path in the
  // browser preview has to resolve, not reject.
  await startApp(page);

  await page.click('#card-expand');
  await page.click('#card-expand');
});
