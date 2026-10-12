import { type Locator, type Page, expect, test } from '@playwright/test';
import { DateTime } from 'luxon';

import { prisma } from '@documenso/prisma';

import {
  clickAddMyselfButton,
  clickEnvelopeEditorStep,
  openDocumentEnvelopeEditor,
  placeFieldOnPdf,
  waitForEditorCanvas,
} from '../fixtures/envelope-editor';

/**
 * The send dialog's own controls.
 *
 * The dialog is the last chance to change how a document behaves before its
 * recipients are emailed, and it carries settings that exist nowhere else in the
 * editor. None of them had coverage.
 *
 * - Expiration (`6736d0b8e`): a second, independent copy of the picker from the
 *   settings dialog, plus a guard that stops a document going out with a
 *   deadline that has already passed.
 * - Next-button navigation (`04dbd580c`): which fields the signing page's Next
 *   button is allowed to jump to. The signing-time half of this is covered in
 *   `v2-signing.spec.ts`; what is here is the only place the filter can be set.
 */

const getComboboxByLabel = (root: Page | Locator, label: string) =>
  root
    .locator(`label:has-text("${label}")`)
    .locator('xpath=..')
    .locator('[role="combobox"]')
    .first();

const prepareSendableEnvelope = async (page: Page) => {
  const surface = await openDocumentEnvelopeEditor(page);

  await clickAddMyselfButton(page);

  await clickEnvelopeEditorStep(page, 'addFields');
  await waitForEditorCanvas(page);

  // An envelope with no signature field cannot be sent at all, so one has to
  // exist before the dialog's own validation is the thing under test.
  await placeFieldOnPdf(page, 'Signature', { x: 150, y: 200 });

  return surface;
};

const openSendDialog = async (page: Page) => {
  await page.locator('button[title="Send Envelope"]').click();
  await expect(page.getByRole('heading', { name: 'Send Document' })).toBeVisible();
};

test.describe('expiration in the send dialog', () => {
  test('a duration set at send time reaches the envelope and its recipients', async ({ page }) => {
    const surface = await prepareSendableEnvelope(page);

    await openSendDialog(page);

    const dialog = page.getByRole('dialog');

    await getComboboxByLabel(dialog, 'Expiration').click();
    await page.getByRole('option', { name: 'Custom duration' }).click();

    await dialog.getByRole('spinbutton').fill('3');

    // The unit select is the second combobox in the expiration block; the first
    // is the mode.
    await getComboboxByLabel(dialog, 'Expiration')
      .locator('xpath=..')
      .getByRole('combobox')
      .nth(1)
      .click();
    await page.getByRole('option', { name: 'Days' }).click();

    await dialog.getByRole('button', { name: 'Send' }).click();

    await expect(async () => {
      const envelope = await prisma.envelope.findFirstOrThrow({
        where: { id: surface.envelopeId },
        include: { documentMeta: true, recipients: true },
      });

      expect(envelope.status).toBe('PENDING');
      expect(envelope.documentMeta.envelopeExpirationPeriod).toEqual({ unit: 'day', amount: 3 });

      // The stored period is only half of it - sending has to resolve it into a
      // concrete deadline on each recipient, which is what actually locks them
      // out.
      const [recipient] = envelope.recipients;

      expect(recipient.expiresAt).not.toBeNull();

      const daysOut = DateTime.fromJSDate(recipient.expiresAt!).diffNow('days').days;

      expect(daysOut).toBeGreaterThan(2);
      expect(daysOut).toBeLessThan(4);
    }).toPass({ timeout: 30_000 });
  });

  test('a deadline that has already passed blocks sending', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);

    // A fixed date is stored as a zone-less wall clock and resolved to an
    // instant at send time, so a date in the past is only detectable here - the
    // recipients have no `expiresAt` yet.
    const lapsed = DateTime.now().minus({ days: 5 }).toFormat("yyyy-MM-dd'T'HH:mm");

    const envelope = await prisma.envelope.findFirstOrThrow({
      where: { id: surface.envelopeId },
    });

    await prisma.documentMeta.update({
      where: { id: envelope.documentMetaId },
      data: { envelopeExpirationPeriod: { expiresAt: lapsed } },
    });

    await page.reload();

    await clickAddMyselfButton(page);
    await clickEnvelopeEditorStep(page, 'addFields');
    await waitForEditorCanvas(page);
    await placeFieldOnPdf(page, 'Signature', { x: 150, y: 200 });

    await openSendDialog(page);

    const dialog = page.getByRole('dialog');

    await expect(
      dialog.getByText('This expiration date has already passed. Pick a later one to send.'),
    ).toBeVisible();

    // The warning is not advisory: Send is disabled until the date is fixed.
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();

    const unchanged = await prisma.envelope.findFirstOrThrow({
      where: { id: surface.envelopeId },
    });

    expect(unchanged.status).toBe('DRAFT');
  });
});

test.describe('next-button navigation in the send dialog', () => {
  test('field types and labels chosen at send time reach the envelope', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);

    await clickAddMyselfButton(page);
    await clickEnvelopeEditorStep(page, 'addFields');
    await waitForEditorCanvas(page);

    await placeFieldOnPdf(page, 'Signature', { x: 150, y: 150 });

    // Two labelled fields sharing one label, so the dropdown has something to
    // deduplicate. A signature carries no label and must contribute nothing.
    await placeFieldOnPdf(page, 'Text', { x: 150, y: 250 });
    await page.locator('[data-testid="field-form-label"]').fill('Amount');

    await placeFieldOnPdf(page, 'Number', { x: 150, y: 350 });
    await page.locator('[data-testid="field-form-label"]').fill('Amount');

    // The dialog builds its label list from the envelope it was handed, so the
    // fields have to have reached the server before it opens.
    await expect(async () => {
      const fields = await prisma.field.findMany({ where: { envelopeId: surface.envelopeId } });

      expect(fields).toHaveLength(3);
      expect(
        fields.filter(
          (field) => (field.fieldMeta as { label?: string } | null)?.label === 'Amount',
        ),
      ).toHaveLength(2);
    }).toPass({ timeout: 30_000 });

    await openSendDialog(page);

    const dialog = page.getByRole('dialog');

    const typesTrigger = getComboboxByLabel(dialog, 'Next Button Field Types');
    const labelsTrigger = getComboboxByLabel(dialog, 'Next Button Field Labels');

    // An empty filter is not "no navigation" but "navigate to everything", and
    // the placeholders are what tell the sender that.
    await expect(typesTrigger).toContainText('All field types');
    await expect(labelsTrigger).toContainText('All field labels');

    await typesTrigger.click();
    await page.getByRole('option', { name: 'Signature', exact: true }).click();
    await page.getByRole('option', { name: 'Text', exact: true }).click();
    await page.keyboard.press('Escape');

    await labelsTrigger.click();

    // Only labels that exist on this document are offered, once each - the
    // signature is absent and the two 'Amount' fields collapse into one entry.
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option', { name: 'Amount', exact: true })).toBeVisible();

    await page.getByRole('option', { name: 'Amount', exact: true }).click();
    await page.keyboard.press('Escape');

    await dialog.getByRole('button', { name: 'Send' }).click();

    await expect(async () => {
      const envelope = await prisma.envelope.findFirstOrThrow({
        where: { id: surface.envelopeId },
        include: { documentMeta: true },
      });

      expect(envelope.status).toBe('PENDING');
      expect(envelope.documentMeta.nextFieldNavigationTypes).toEqual(['SIGNATURE', 'TEXT']);
      expect(envelope.documentMeta.nextFieldNavigationLabels).toEqual(['Amount']);
    }).toPass({ timeout: 30_000 });
  });
});
