import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const checkDocumentTabCount = async (page: Page, tabName: string, count: number) => {
  const tab = page.getByRole('tab', { name: tabName });

  // Each tab renders as a <Link>, so its href is a snapshot of the search params
  // from the render that produced it. Callers usually arrive here immediately
  // after typing into the search box, which only writes `query` to the URL after
  // a 500ms debounce - clicking a tab whose href predates that write navigates
  // back to the unfiltered list, and the count then never converges no matter how
  // long we wait for it. Make the href agree with the URL before clicking.
  const query = new URL(page.url()).searchParams.get('query');

  if (query) {
    const expectedParam = new URLSearchParams({ query }).toString();

    await expect(tab).toHaveAttribute(
      'href',
      new RegExp(`[?&]${escapeRegExp(expectedParam)}(&|$)`),
    );
  }

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
