import { type Page, expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { nanoid } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';

import {
  type TEnvelopeEditorSurface,
  clickEnvelopeEditorStep,
  getEnvelopeEditorSettingsTrigger,
  multiPagePdfBuffer,
  openTemplateEnvelopeEditor,
  placeFieldOnPdf,
  waitForEditorCanvas,
} from '../fixtures/envelope-editor';
import { expectKonvaElementCount } from '../fixtures/konva';

/**
 * Adding and removing pages inside the editor (`c5484fd21`, `fb28d0556`,
 * `ae975785b`).
 *
 * Nothing covered any of it. The part most worth protecting is what deleting a
 * page does to the fields around it: fields on the deleted page are removed and
 * every field after it is renumbered down a page
 * (`delete-envelope-item-page.ts`). Get that wrong and an author silently ends
 * up with signature boxes on the wrong pages of a document they are about to
 * send.
 */

const openSettingsDialog = async (root: Page) => {
  await getEnvelopeEditorSettingsTrigger(root).click();
  await expect(root.getByRole('heading', { name: 'Document Settings' })).toBeVisible();
};

const updateExternalId = async (surface: TEnvelopeEditorSurface, externalId: string) => {
  await openSettingsDialog(surface.root);
  await surface.root.locator('input[name="externalId"]').fill(externalId);
  await surface.root.getByRole('button', { name: 'Update' }).click();
  await expect(surface.root.getByRole('heading', { name: 'Document Settings' })).toBeHidden();
};

const getEnvelopeItem = async (envelopeId: string) =>
  prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

const addPage = async (root: Page, source: 'blank' | 'upload', buffer?: Buffer) => {
  await root.getByRole('button', { name: 'Add page' }).first().click();

  const dialog = root.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.locator(`[data-testid="envelope-add-page-source-${source}"]`).click();

  if (source === 'upload') {
    await dialog
      .locator('[data-testid="envelope-add-page-dropzone"] input[type="file"]')
      .setInputFiles({
        name: 'appended-pages.pdf',
        mimeType: 'application/pdf',
        buffer: buffer ?? multiPagePdfBuffer,
      });

    // The dialog reads the page count out of the file before it will submit.
    await expect(dialog.locator('[data-testid="envelope-add-page-selected-file"]')).toBeVisible({
      timeout: 15_000,
    });
  }

  await dialog.locator('[data-testid="envelope-add-page-submit"]').click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
};

const deletePage = async (root: Page, pageNumber: number) => {
  await root.getByRole('button', { name: `Delete page ${pageNumber}` }).click();

  const dialog = root.getByRole('dialog');
  await expect(dialog.getByText('Do you want to delete this page?')).toBeVisible();

  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
};

test.describe('template editor page management', () => {
  test('adds a blank page, then deleting a page removes and renumbers fields', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const externalId = `e2e-template-pages-${nanoid()}`;

    await updateExternalId(surface, externalId);

    await clickEnvelopeEditorStep(page, 'addFields');
    await waitForEditorCanvas(page);

    // A single-page document offers no delete button at all - there would be
    // nothing left.
    await expect(page.getByRole('button', { name: 'Delete page 1' })).toHaveCount(0);

    await placeFieldOnPdf(page, 'Signature', { x: 150, y: 200 });
    await expectKonvaElementCount(page, 1, '.field-group', 1);

    await addPage(page, 'blank');

    // Now that there are two, either can be removed.
    await expect(page.getByRole('button', { name: 'Delete page 2' })).toHaveCount(1);

    await waitForEditorCanvas(page);
    await expectKonvaElementCount(page, 2, '.field-group', 0);

    // Put something on the new page so the renumbering has a subject.
    // `placeFieldOnPdf` always targets the first canvas, so page 2 is clicked
    // directly.
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page
      .locator('.konva-container canvas')
      .nth(1)
      .click({ position: { x: 200, y: 260 } });

    await expect(async () => {
      const envelope = await prisma.envelope.findFirstOrThrow({
        where: { externalId, teamId: surface.teamId },
        include: { fields: true },
      });

      expect(envelope.fields).toHaveLength(2);
      expect(envelope.fields.map((field) => field.page).sort()).toEqual([1, 2]);
    }).toPass({ timeout: 20_000 });

    await deletePage(page, 1);

    await expect(async () => {
      const envelope = await prisma.envelope.findFirstOrThrow({
        where: { externalId, teamId: surface.teamId },
        include: { fields: true },
      });

      // The SIGNATURE that lived on the deleted page is gone; the TEXT that was
      // on page 2 has moved down to page 1 rather than being orphaned on a page
      // that no longer exists.
      expect(envelope.fields).toHaveLength(1);
      expect(envelope.fields[0].type).toBe(FieldType.TEXT);
      expect(envelope.fields[0].page).toBe(1);
    }).toPass({ timeout: 30_000 });

    // Back to one page, so the delete affordance disappears again.
    await expect(page.getByRole('button', { name: 'Delete page 1' })).toHaveCount(0);
  });

  test('appends every page of an uploaded file', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const externalId = `e2e-template-pages-upload-${nanoid()}`;

    await updateExternalId(surface, externalId);

    await clickEnvelopeEditorStep(page, 'addFields');
    await waitForEditorCanvas(page);

    const before = await getEnvelopeItem(surface.envelopeId!);

    // `ae975785b` added the upload arm beside the blank one. The asset is three
    // pages, so appending it must add three, not one.
    await addPage(page, 'upload');

    // Counted through the thumbnails' own numbering rather than by counting
    // canvas elements, since how many of those Konva emits per page is an
    // implementation detail.
    await expect(page.getByRole('button', { name: 'Delete page 4' })).toHaveCount(1, {
      timeout: 45_000,
    });
    await expect(page.getByRole('button', { name: 'Delete page 5' })).toHaveCount(0);

    const after = await getEnvelopeItem(surface.envelopeId!);

    // The item keeps its identity; only the bytes behind it change.
    expect(after.id).toBe(before.id);
  });
});
