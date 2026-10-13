import type { Locator } from '@playwright/test';
import { expect, type Page } from '@playwright/test';

export const expectTextToBeVisible = async (page: Page, text: string) => {
  await expect(page.getByText(text).first()).toBeVisible();
};

export const expectTextToNotBeVisible = async (page: Page, text: string) => {
  await expect(page.getByText(text).first()).not.toBeVisible();
};

/**
 * Prefer asserting the OUTCOME of an action over its toast. Nearly nothing
 * should need this.
 *
 * Toasts here are observable for roughly a second - shorter than the `duration`
 * their call sites ask for - and `use-toast.ts` sets `TOAST_LIMIT = 1`, so any
 * other toast raised in the same beat (the editor's autosave, typically) evicts
 * the expected one. That made toast assertions the single largest source of
 * flakiness in this suite.
 *
 * An earlier `expectToastAfter` helper tried to fix this by starting the wait
 * before the triggering action. That was the wrong diagnosis and it was removed:
 * the race is not when the wait starts, it is that the toast may never be
 * visible at all once something evicts it. A full run still failed three of its
 * six call sites, and passed the other three, purely on machine load.
 *
 * Assert the deterministic outcome instead - a dialog closing, a navigation, a
 * row appearing, or `expect.poll` over the database. Reach for this only where
 * the toast genuinely is the sole observable, which in practice means error
 * paths. See issue #31.
 */
export const expectToastTextToBeVisible = async (page: Page, text: string) => {
  await expect(page.locator('[role="status"]').getByText(text)).toBeVisible();
};

export const openDropdownMenu = async (page: Page, dropdownButton: Locator) => {
  await page.waitForTimeout(500); // Initial timeout incase table remounts which will close the dropdown.
  await dropdownButton.focus();
  await page.keyboard.press('Enter');

  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  await dropdownButton.focus();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('menuitem').first()).toBeVisible();
};
