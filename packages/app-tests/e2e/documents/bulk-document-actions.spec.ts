import { expect, test } from '@playwright/test';

import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { seedBlankFolder } from '@documenso/prisma/seed/folders';
import { seedUser } from '@documenso/prisma/seed/users';

import { apiSignin } from '../fixtures/authentication';

test.describe.configure({ mode: 'parallel' });

const seedBulkActionsTestRequirements = async () => {
  const sender = await seedUser({ setTeamEmailAsOwner: true });

  const [doc1, doc2, doc3] = await Promise.all([
    seedDraftDocument(sender.user, sender.team.id, [], {
      createDocumentOptions: { title: 'Bulk Test Doc 1' },
    }),
    seedDraftDocument(sender.user, sender.team.id, [], {
      createDocumentOptions: { title: 'Bulk Test Doc 2' },
    }),
    seedDraftDocument(sender.user, sender.team.id, [], {
      createDocumentOptions: { title: 'Bulk Test Doc 3' },
    }),
  ]);

  const folder = await seedBlankFolder(sender.user, sender.team.id, {
    createFolderOptions: {
      name: 'Target Folder',
      teamId: sender.team.id,
    },
  });

  return {
    sender,
    documents: [doc1, doc2, doc3],
    folder,
  };
};

test('[BULK_ACTIONS]: can select multiple documents with checkboxes', async ({ page }) => {
  const { sender } = await seedBulkActionsTestRequirements();

  await apiSignin({
    page,
    email: sender.user.email,
    redirectPath: `/t/${sender.team.url}/documents`,
  });

  await page.locator('tr', { hasText: 'Bulk Test Doc 1' }).getByRole('checkbox').click();
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.locator('tr', { hasText: 'Bulk Test Doc 2' }).getByRole('checkbox').click();
  await expect(page.getByText('2 selected')).toBeVisible();
});

test('[BULK_ACTIONS]: header checkbox selects all documents on page', async ({ page }) => {
  const { sender, documents } = await seedBulkActionsTestRequirements();

  await apiSignin({
    page,
    email: sender.user.email,
    redirectPath: `/t/${sender.team.url}/documents`,
  });

  // "Select all" acts on whatever rows are currently rendered, so clicking it
  // before the table has loaded selects nothing and the count never appears.
  // Tests that locate a row by name first avoid this implicitly.
  await expect(page.getByRole('link', { name: 'Bulk Test Doc 1' })).toBeVisible();

  await page.locator('thead').getByRole('checkbox').click();

  await expect(page.getByText(`${documents.length} selected`)).toBeVisible();
});

test('[BULK_ACTIONS]: can clear selection with X button', async ({ page }) => {
  const { sender } = await seedBulkActionsTestRequirements();

  await apiSignin({
    page,
    email: sender.user.email,
    redirectPath: `/t/${sender.team.url}/documents`,
  });

  // Same load race as the test above: select-all acts on whatever rows are
  // rendered, so clicking before the table has loaded selects nothing.
  await expect(page.getByRole('link', { name: 'Bulk Test Doc 1' })).toBeVisible();

  await page.locator('thead').getByRole('checkbox').click();
  await expect(page.getByText(/\d+ selected/)).toBeVisible();

  await page.getByLabel('Clear selection').click();

  await expect(page.getByText(/\d+ selected/)).not.toBeVisible();
});

test('[BULK_ACTIONS]: can move multiple documents to a folder', async ({ page }) => {
  const { sender, folder } = await seedBulkActionsTestRequirements();

  await apiSignin({
    page,
    email: sender.user.email,
    redirectPath: `/t/${sender.team.url}/documents`,
  });

  await page.locator('tr', { hasText: 'Bulk Test Doc 1' }).getByRole('checkbox').click();
  await page.locator('tr', { hasText: 'Bulk Test Doc 2' }).getByRole('checkbox').click();
  await page.getByRole('button', { name: 'Move to Folder' }).click();

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Move Documents to Folder')).toBeVisible();

  await page.getByRole('button', { name: folder.name }).click();
  await page.getByRole('button', { name: 'Move' }).click();

  // The move dialog closes once the mutation resolves. That is the barrier the
  // toast used to provide before the navigation below; the toast itself is
  // evicted within about a second (TOAST_LIMIT = 1). See issue #31.
  //
  // Barrier on the dialog rather than the "N selected" text: while the dialog is
  // open that pattern also matches its description ("... move the 2 selected
  // documents"), so the wait fails strict mode instead of waiting.
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await page.goto(`/t/${sender.team.url}/documents/f/${folder.id}`);
  await expect(page.getByRole('link', { name: 'Bulk Test Doc 1' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Bulk Test Doc 2' })).toBeVisible();
});

test('[BULK_ACTIONS]: can delete multiple draft documents', async ({ page }) => {
  const { sender } = await seedBulkActionsTestRequirements();

  await apiSignin({
    page,
    email: sender.user.email,
    redirectPath: `/t/${sender.team.url}/documents`,
  });

  await page.locator('tr', { hasText: 'Bulk Test Doc 1' }).getByRole('checkbox').click();
  await page.locator('tr', { hasText: 'Bulk Test Doc 2' }).getByRole('checkbox').click();

  await page.getByRole('button', { name: 'Delete' }).click();

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Delete Documents')).toBeVisible();
  await expect(page.getByText('You are about to delete 2 documents')).toBeVisible();
  await expect(page.getByText('irreversible')).toBeVisible();

  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();

  await expect(page.getByRole('link', { name: 'Bulk Test Doc 1' })).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'Bulk Test Doc 2' })).not.toBeVisible();

  await expect(page.getByRole('link', { name: 'Bulk Test Doc 3' })).toBeVisible();
});

test('[BULK_ACTIONS]: selection clears after successful move', async ({ page }) => {
  const { sender, folder } = await seedBulkActionsTestRequirements();

  await apiSignin({
    page,
    email: sender.user.email,
    redirectPath: `/t/${sender.team.url}/documents`,
  });

  await page.locator('tr', { hasText: 'Bulk Test Doc 1' }).getByRole('checkbox').click();
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Move to Folder' }).click();
  await page.getByRole('button', { name: folder.name }).click();
  await page.getByRole('button', { name: 'Move' }).click();
  await expect(page.getByText(/\d+ selected/)).not.toBeVisible();
});

test('[BULK_ACTIONS]: selection clears after successful delete', async ({ page }) => {
  const { sender } = await seedBulkActionsTestRequirements();

  await apiSignin({
    page,
    email: sender.user.email,
    redirectPath: `/t/${sender.team.url}/documents`,
  });

  await page.locator('tr', { hasText: 'Bulk Test Doc 1' }).getByRole('checkbox').click();
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/\d+ selected/)).not.toBeVisible();
});

test('[BULK_ACTIONS]: can search for folders in move dialog', async ({ page }) => {
  const { sender, folder } = await seedBulkActionsTestRequirements();

  const otherFolder = await seedBlankFolder(sender.user, sender.team.id, {
    createFolderOptions: {
      name: 'Other Folder',
      teamId: sender.team.id,
    },
  });

  await apiSignin({
    page,
    email: sender.user.email,
    redirectPath: `/t/${sender.team.url}/documents`,
  });

  await page.locator('tr', { hasText: 'Bulk Test Doc 1' }).getByRole('checkbox').click();

  await page.getByRole('button', { name: 'Move to Folder' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await expect(page.getByRole('button', { name: folder.name })).toBeVisible();
  await expect(page.getByRole('button', { name: otherFolder.name })).toBeVisible();

  await page.getByPlaceholder('Search folders...').fill('Target');
  await expect(page.getByRole('button', { name: folder.name })).toBeVisible();
  await expect(page.getByRole('button', { name: otherFolder.name })).not.toBeVisible();

  await page.getByPlaceholder('Search folders...').fill('Other');
  await expect(page.getByRole('button', { name: folder.name })).not.toBeVisible();
  await expect(page.getByRole('button', { name: otherFolder.name })).toBeVisible();

  await page.getByPlaceholder('Search folders...').fill('NonExistent');
  await expect(page.getByText('No folders found')).toBeVisible();
});

test('[BULK_ACTIONS]: can move documents from folder to home (root)', async ({ page }) => {
  const { sender, documents, folder } = await seedBulkActionsTestRequirements();

  const { prisma } = await import('@documenso/prisma');

  await prisma.envelope.updateMany({
    where: { id: documents[0].id },
    data: { folderId: folder.id },
  });

  await apiSignin({
    page,
    email: sender.user.email,
    redirectPath: `/t/${sender.team.url}/documents/f/${folder.id}`,
  });

  await expect(page.getByRole('link', { name: 'Bulk Test Doc 1' })).toBeVisible();

  await page.locator('tr', { hasText: 'Bulk Test Doc 1' }).getByRole('checkbox').click();
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Move to Folder' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.getByRole('button', { name: 'Home (No Folder)' }).click();

  await page.getByRole('button', { name: 'Move' }).click();

  // The move dialog closes once the mutation resolves. That is the barrier the
  // toast used to provide before the navigation below; the toast itself is
  // evicted within about a second (TOAST_LIMIT = 1). See issue #31.
  //
  // Barrier on the dialog rather than the "N selected" text: while the dialog is
  // open that pattern also matches its description ("... move the 2 selected
  // documents"), so the wait fails strict mode instead of waiting.
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await page.goto(`/t/${sender.team.url}/documents`);
  await expect(page.getByRole('link', { name: 'Bulk Test Doc 1' })).toBeVisible();

  await page.goto(`/t/${sender.team.url}/documents/f/${folder.id}`);

  // The folder page's own data has to be in before an absence means anything:
  // `not.toBeVisible()` is equally satisfied by a page that has not painted.
  // The breadcrumb resolves to the folder name only once the route's query has
  // settled, which is the signal that the list below it is the real one.
  await expect(page.getByTestId('folder-grid-breadcrumbs').getByText(folder.name)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Bulk Test Doc 1' })).not.toBeVisible();
});
