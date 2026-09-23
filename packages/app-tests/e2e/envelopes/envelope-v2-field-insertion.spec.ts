import { DEFAULT_DOCUMENT_DATE_FORMAT } from '@documenso/lib/constants/date-formats';
import { DEFAULT_DOCUMENT_TIME_ZONE } from '@documenso/lib/constants/time-zones';
import { prisma } from '@documenso/prisma';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType } from '@prisma/client';
import { DateTime } from 'luxon';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';

const PDF_PAGE_SELECTOR = 'img[data-page-number]';

/**
 * Sign the DATE field through the calendar dialog.
 *
 * DATE is not in ADVANCED_FIELD_TYPES_WITH_OPTIONAL_SETTING, so `isRequiredField`
 * reports it required whatever its meta says - there is no way to make a date
 * optional. Upstream gets away with never touching it because their signing page
 * marks every date inserted and read-only on load; this fork replaced that with a
 * picker (`21551a2ff`), so the signer has to open it before the document can be
 * completed. The dialog opens on today and Confirm accepts it, which is the same
 * value upstream's auto-insert would have written.
 */
const signDateFieldViaDialog = async (page: Page, canvas: Locator, field: { positionX: unknown; positionY: unknown; width: unknown; height: unknown }) => {
  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('Canvas bounding box not found');
  }

  await canvas.click({
    position: {
      x: (Number(field.positionX) / 100) * box.width + ((Number(field.width) / 100) * box.width) / 2,
      y: (Number(field.positionY) / 100) * box.height + ((Number(field.height) / 100) * box.height) / 2,
    },
  });

  await page.getByRole('button', { name: 'Confirm' }).click();
};

test.describe('V2 envelope field insertion during signing', () => {
  test('date fields are signed through the picker and persist when completing a V2 envelope', async ({ page, request }) => {
    const now = DateTime.now().setZone(DEFAULT_DOCUMENT_TIME_ZONE);

    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'signer-date@test.documenso.com', name: 'Date Signer' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.DATE, page: 1, positionX: 5, positionY: 5, width: 5, height: 5 },
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 15, width: 5, height: 5 },
        ],
      ],
    });

    const { token } = distributeResult.recipients[0];

    await page.goto(`/sign/${token}`);

    // wait for PDF to be visible
    await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });

    // Wait for the Konva canvas to be ready.
    const canvas = page.locator('.konva-container canvas').first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Nothing is filled in yet: this fork leaves DATE to the signer's calendar
    // dialog rather than stamping it on load, so it is still outstanding here.
    await expect(page.getByText('2 Fields Remaining').first()).toBeVisible();

    // Set up a signature via the sidebar form.
    await page.getByTestId('signature-pad-dialog-button').click();
    await page.getByRole('tab', { name: 'Type' }).click();
    await page.getByTestId('signature-pad-type-input').fill('Signature');
    await page.getByRole('button', { name: 'Next' }).click();

    // Click the signature field on the canvas.
    const canvasBox = await canvas.boundingBox();

    if (!canvasBox) {
      throw new Error('Canvas bounding box not found');
    }

    const sigField = envelope.fields.find((f) => f.type === FieldType.SIGNATURE);

    if (!sigField) {
      throw new Error('Signature field not found');
    }

    const x =
      (Number(sigField.positionX) / 100) * canvasBox.width + ((Number(sigField.width) / 100) * canvasBox.width) / 2;
    const y =
      (Number(sigField.positionY) / 100) * canvasBox.height + ((Number(sigField.height) / 100) * canvasBox.height) / 2;

    await canvas.click({ position: { x, y } });
    await page.waitForTimeout(500);

    // The date still has to be signed - see signDateFieldViaDialog.
    await expect(page.getByText('1 Field Remaining').first()).toBeVisible({ timeout: 10_000 });

    const dateFieldToSign = envelope.fields.find((f) => f.type === FieldType.DATE);

    if (!dateFieldToSign) {
      throw new Error('Date field not found');
    }

    await signDateFieldViaDialog(page, canvas, dateFieldToSign);

    await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign' }).click();

    await page.waitForURL(`/sign/${token}/complete`);
    await expect(page.getByText('Document Signed')).toBeVisible();

    // Verify the date field was inserted in the database with the correct format.
    const dateField = await prisma.field.findFirstOrThrow({
      where: {
        envelopeId: envelope.id,
        type: FieldType.DATE,
      },
    });

    expect(dateField.inserted).toBe(true);
    expect(dateField.customText).toBeTruthy();

    // The calendar picker records the day the signer chose, normalised to midday, where
    // upstream's auto-insert wrote a live timestamp. The day is what a date field means,
    // so that is what is asserted; a to-the-minute comparison would only be testing that
    // the picker had stamped a clock reading it has no reason to carry.
    const insertedDate = DateTime.fromFormat(dateField.customText, DEFAULT_DOCUMENT_DATE_FORMAT, {
      zone: DEFAULT_DOCUMENT_TIME_ZONE,
    });

    expect(insertedDate.isValid).toBe(true);
    expect(insertedDate.toFormat('yyyy-MM-dd')).toBe(now.toFormat('yyyy-MM-dd'));

    // Verify the document reached COMPLETED status.
    await expect(async () => {
      const dbEnvelope = await prisma.envelope.findUniqueOrThrow({
        where: { id: envelope.id },
      });

      expect(dbEnvelope.status).toBe(DocumentStatus.COMPLETED);
    }).toPass();
  });

  test('email is auto-inserted and date is picked when completing a V2 envelope with multiple field types', async ({
    page,
    request,
  }) => {
    const now = DateTime.now().setZone(DEFAULT_DOCUMENT_TIME_ZONE);

    const recipientEmail = 'signer-multi@test.documenso.com';

    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: recipientEmail, name: 'Multi Signer' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.DATE, page: 1, positionX: 5, positionY: 5, width: 5, height: 5 },
          { type: FieldType.EMAIL, page: 1, positionX: 5, positionY: 10, width: 5, height: 5 },
          { type: FieldType.NAME, page: 1, positionX: 5, positionY: 15, width: 5, height: 5 },
          {
            type: FieldType.SIGNATURE,
            page: 1,
            positionX: 5,
            positionY: 20,
            width: 5,
            height: 5,
          },
        ],
      ],
    });

    const { token } = distributeResult.recipients[0];

    // Resolve the fields from the envelope for position calculations.
    const fields = envelope.fields;

    await page.goto(`/sign/${token}`);

    // wait for PDF to be visible
    await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });

    // Wait for the Konva canvas to be ready.
    const canvas = page.locator('.konva-container canvas').first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // EMAIL is filled server side when the envelope is sent. DATE is not - this
    // fork hands it to the signer's calendar dialog - so DATE, NAME and SIGNATURE
    // are all still outstanding.
    await expect(page.getByText('3 Fields Remaining').first()).toBeVisible();

    // Set up a signature via the sidebar form.
    await page.getByTestId('signature-pad-dialog-button').click();
    await page.getByRole('tab', { name: 'Type' }).click();
    await page.getByTestId('signature-pad-type-input').fill('Signature');
    await page.getByRole('button', { name: 'Next' }).click();

    // Click each non-date field on the Konva canvas to insert it.
    // Fields are seeded with positions as percentages of the page.
    // We need to convert these percentages to pixel positions on the canvas.
    const canvasBox = await canvas.boundingBox();

    if (!canvasBox) {
      throw new Error('Canvas bounding box not found');
    }

    // EMAIL is filled server side when the envelope is sent. DATE is signed through the
    // calendar dialog below, which needs its own handling, so it is excluded here too.
    const manualFields = fields.filter((f) => f.type !== FieldType.DATE && f.type !== FieldType.EMAIL);

    for (const field of manualFields) {
      const x = (Number(field.positionX) / 100) * canvasBox.width + ((Number(field.width) / 100) * canvasBox.width) / 2;
      const y =
        (Number(field.positionY) / 100) * canvasBox.height + ((Number(field.height) / 100) * canvasBox.height) / 2;

      await canvas.click({ position: { x, y } });

      if (field.type === FieldType.NAME) {
        const nameDialog = page.getByRole('dialog');
        const isDialogVisible = await nameDialog.isVisible().catch(() => false);

        if (isDialogVisible) {
          const nameInput = nameDialog.locator('input[type="text"], input[name="name"]').first();
          const isInputVisible = await nameInput.isVisible().catch(() => false);

          if (isInputVisible) {
            await nameInput.fill('Test Signer');
          }

          const saveButton = nameDialog.getByRole('button', { name: 'Save' });
          const isButtonVisible = await saveButton.isVisible().catch(() => false);

          if (isButtonVisible) {
            await saveButton.click();
          }
        }
      }

      // Small delay to allow the field signing to complete.
      await page.waitForTimeout(500);
    }

    // Everything but the date is done.
    await expect(page.getByText('1 Field Remaining').first()).toBeVisible({ timeout: 10_000 });

    const dateFieldToSign = fields.find((f) => f.type === FieldType.DATE);

    if (!dateFieldToSign) {
      throw new Error('Date field not found');
    }

    await signDateFieldViaDialog(page, canvas, dateFieldToSign);

    await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign' }).click();

    await page.waitForURL(`/sign/${token}/complete`);
    await expect(page.getByText('Document Signed')).toBeVisible();

    // Verify the date field was auto-inserted with the correct format.
    const dateField = await prisma.field.findFirstOrThrow({
      where: {
        envelopeId: envelope.id,
        type: FieldType.DATE,
      },
    });

    expect(dateField.inserted).toBe(true);
    expect(dateField.customText).toBeTruthy();

    const insertedDate = DateTime.fromFormat(dateField.customText, DEFAULT_DOCUMENT_DATE_FORMAT, {
      zone: DEFAULT_DOCUMENT_TIME_ZONE,
    });

    expect(insertedDate.isValid).toBe(true);
    expect(insertedDate.toFormat('yyyy-MM-dd')).toBe(now.toFormat('yyyy-MM-dd'));

    // Verify the email field was inserted with the recipient's email.
    const emailField = await prisma.field.findFirstOrThrow({
      where: {
        envelopeId: envelope.id,
        type: FieldType.EMAIL,
      },
    });

    expect(emailField.inserted).toBe(true);
    expect(emailField.customText).toBe(recipientEmail);

    // Verify all fields are inserted.
    const allFields = await prisma.field.findMany({
      where: { envelopeId: envelope.id },
    });

    for (const field of allFields) {
      expect(field.inserted).toBe(true);
    }

    // Verify the document reached COMPLETED status.
    await expect(async () => {
      const dbEnvelope = await prisma.envelope.findUniqueOrThrow({
        where: { id: envelope.id },
      });

      expect(dbEnvelope.status).toBe(DocumentStatus.COMPLETED);
    }).toPass();
  });
});
