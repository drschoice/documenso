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
 * The expiration controls in the send dialog (`6736d0b8e`).
 *
 * The editor's own settings dialog is covered by `envelope-settings.spec.ts`,
 * but the send dialog carries a second, independent copy of the picker - the
 * last chance to set a deadline before recipients are emailed - plus a guard
 * that stops a document going out with a deadline that has already passed.
 * Neither had any coverage.
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
