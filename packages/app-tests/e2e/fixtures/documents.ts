import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Params the tab links deliberately rewrite; everything else must survive a tab click.
 */
const TAB_OWNED_PARAMS = new Set(['status', 'page']);

/**
 * Wait for a tab's href to catch up with the current URL.
 *
 * Each tab renders as a <Link> whose href is a snapshot of the search params from
 * the render that produced it. Callers usually arrive here right after driving a
 * filter - the search box writes `query` only after a 500ms debounce, and the
 * sender filter writes `senderIds` - so a tab clicked too early navigates to an
 * href that predates the filter, landing on the unfiltered list. The count then
 * never converges no matter how long we wait for it.
 */
const waitForTabHrefToMatchUrl = async (page: Page, tab: ReturnType<Page['getByRole']>) => {
  const expected = [...new URL(page.url()).searchParams.entries()].filter(
    ([key]) => !TAB_OWNED_PARAMS.has(key),
  );

  if (expected.length === 0) {
    return;
  }

  await expect(async () => {
    const href = await tab.getAttribute('href');
    const actual = new URL(href ?? '', 'http://localhost').searchParams;

    for (const [key, value] of expected) {
      expect(actual.get(key)).toBe(value);
    }
  }).toPass({ timeout: 15_000 });
};

export const checkDocumentTabCount = async (page: Page, tabName: string, count: number) => {
  const tab = page.getByRole('tab', { name: tabName });

  await waitForTabHrefToMatchUrl(page, tab);

  await tab.click();

  if (tabName !== 'All') {
    await expect(tab).toContainText(count.toString());
  }

  if (count === 0) {
    await expect(page.getByTestId('empty-document-state')).toBeVisible();
    return;
  }

  await expect(page.getByTestId('data-table-count')).toContainText(`Showing ${count}`);
};
