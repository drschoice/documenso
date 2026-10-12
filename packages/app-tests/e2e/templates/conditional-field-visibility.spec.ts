/**
 * Conditional field visibility on the *legacy* (`internalVersion: 1`) signer.
 *
 * This spec used to assert that a field whose rule is unmet is absent from the
 * DOM. It is not, and deliberately so: the v1 signing page mounts
 * `DocumentSigningProvider` but not `EnvelopeSigningProvider`, so
 * `DocumentSigningFieldContainer` has no visibility map to filter by. Requiring
 * that context is what took down the whole v1 page when conditional visibility
 * first landed, and making it optional is what fixed it - which silently made
 * these assertions wrong rather than failing loudly.
 *
 * What is left here is the contract that made that trade-off safe: the field is
 * shown, and `sign-field-with-token` refuses it anyway. The rest of conditional
 * visibility - hiding, revealing, completion gating, the webhook payload, the
 * audit trail and the certificate - is covered against the v2 signer, which is
 * the one this fork actually ships:
 *
 * - `envelopes/v2-signing.spec.ts` - hide/reveal and the server-side refusal
 * - `envelopes/conditional-visibility-completion.spec.ts` - sweeping, auditing,
 *   the webhook payload and the certificate's skipped-field list
 */
import { expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, ReadStatus, SendStatus, SigningStatus } from '@prisma/client';
import { nanoid } from 'nanoid';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { incrementDocumentId } from '@documenso/lib/server-only/envelope/increment-id';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { TRadioFieldMeta, TTextFieldMeta } from '@documenso/lib/types/field-meta';
import { prefixedId } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import { DocumentDataType, DocumentSource, EnvelopeType, Prisma } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';

import { apiSignin } from '../fixtures/authentication';
import { completeV2SigningViaTrpc } from '../fixtures/envelope-signing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBAPP = NEXT_PUBLIC_WEBAPP_URL();

/**
 * Seed a PENDING document that has:
 *  - one RADIO field "marital_status" (Married / Single)
 *  - one TEXT field "spouse_name" that is only visible when marital_status = "Married"
 *
 * Returns the document and the single recipient.
 */
async function seedConditionalDocument(ownerUserId: number, teamId: number, signerEmail: string) {
  // Use the example.pdf (already used by all other e2e seeds)
  const fs = await import('node:fs');
  const path = await import('node:path');
  const examplePdf = fs
    .readFileSync(path.join(__dirname, '../../../../assets/example.pdf'))
    .toString('base64');

  const documentData = await prisma.documentData.create({
    data: { type: DocumentDataType.BYTES_64, data: examplePdf, initialData: examplePdf },
  });

  const documentMeta = await prisma.documentMeta.create({ data: {} });
  const documentId = await incrementDocumentId();

  const RADIO_STABLE_ID = `radio_marital_${nanoid(8)}`;
  const TEXT_STABLE_ID = `text_spouse_${nanoid(8)}`;

  const radioMeta: TRadioFieldMeta = {
    type: 'radio',
    direction: 'vertical',
    stableId: RADIO_STABLE_ID,
    label: 'Marital Status',
    values: [
      { id: 1, checked: false, value: 'Married' },
      { id: 2, checked: false, value: 'Single' },
    ],
  };

  const textMeta: TTextFieldMeta = {
    type: 'text',
    stableId: TEXT_STABLE_ID,
    label: 'Spouse Name',
    required: true,
    visibility: {
      match: 'all',
      rules: [
        {
          operator: 'equals',
          triggerFieldStableId: RADIO_STABLE_ID,
          value: 'Married',
        },
      ],
    },
  };

  const envelope = await prisma.envelope.create({
    data: {
      id: prefixedId('envelope'),
      secondaryId: documentId.formattedDocumentId,
      internalVersion: 1,
      type: EnvelopeType.DOCUMENT,
      documentMetaId: documentMeta.id,
      source: DocumentSource.DOCUMENT,
      teamId,
      title: '[TEST] Conditional visibility e2e',
      status: DocumentStatus.PENDING,
      userId: ownerUserId,
      envelopeItems: {
        create: {
          id: prefixedId('envelope_item'),
          title: '[TEST] Conditional visibility e2e',
          documentDataId: documentData.id,
          order: 1,
        },
      },
    },
    include: { envelopeItems: true },
  });

  const envelopeItem = envelope.envelopeItems[0];

  const recipient = await prisma.recipient.create({
    data: {
      email: signerEmail,
      name: 'Test Signer',
      token: nanoid(),
      readStatus: ReadStatus.OPENED,
      sendStatus: SendStatus.SENT,
      signingStatus: SigningStatus.NOT_SIGNED,
      signedAt: new Date(),
      envelopeId: envelope.id,
    },
  });

  // Create the RADIO field
  const radioField = await prisma.field.create({
    data: {
      page: 1,
      type: FieldType.RADIO,
      inserted: false,
      customText: '',
      positionX: new Prisma.Decimal(10),
      positionY: new Prisma.Decimal(10),
      width: new Prisma.Decimal(20),
      height: new Prisma.Decimal(10),
      envelopeId: envelope.id,
      envelopeItemId: envelopeItem.id,
      recipientId: recipient.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      fieldMeta: radioMeta as any,
    },
  });

  // Create the TEXT field with the visibility rule
  const textField = await prisma.field.create({
    data: {
      page: 1,
      type: FieldType.TEXT,
      inserted: false,
      customText: '',
      positionX: new Prisma.Decimal(10),
      positionY: new Prisma.Decimal(30),
      width: new Prisma.Decimal(20),
      height: new Prisma.Decimal(5),
      envelopeId: envelope.id,
      envelopeItemId: envelopeItem.id,
      recipientId: recipient.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      fieldMeta: textMeta as any,
    },
  });

  return {
    envelope,
    // `completeDocumentWithToken` is addressed by the numeric document id, not
    // the envelope's prefixed one.
    documentId: documentId.documentId,
    recipient: {
      ...recipient,
      fields: [radioField, textField],
    },
    radioField,
    textField,
    RADIO_STABLE_ID,
    TEXT_STABLE_ID,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Conditional field visibility', () => {
  /**
   * The legacy signer paints every field, unmet rule or not, and the server is
   * what holds the line.
   */
  test('[CONDITIONAL]: a field with an unmet rule is shown on v1 but refused by the server', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const signerEmail = `signer-single-${nanoid(6)}@example.com`;

    const { recipient, radioField, textField } = await seedConditionalDocument(
      user.id,
      team.id,
      signerEmail,
    );

    await page.goto(`${WEBAPP}/sign/${recipient.token}`);

    await expect(page.locator(`#field-${radioField.id}`)).toBeVisible({ timeout: 20_000 });

    // Answer "Single", which leaves the dependent's rule unmet.
    await page.locator(`label[for="option-${radioField.id}-2"]`).click();

    await expect(async () => {
      await expect(page.locator(`#field-${radioField.id}`)).toHaveAttribute(
        'data-inserted',
        'true',
      );
    }).toPass({ timeout: 10_000 });

    // Still on the page: no client-side filtering here, by design.
    await expect(page.locator(`#field-${textField.id}`)).toBeVisible();

    // Driven through the route rather than the field, because what is under test
    // is the server's answer, not whichever control the legacy page happens to
    // put on a text field.
    const response = await page.request.post(
      `${WEBAPP}/api/trpc/field.signFieldWithToken?batch=1`,
      {
        data: {
          0: { json: { token: recipient.token, fieldId: textField.id, value: 'Jane Doe' } },
        },
        headers: { 'content-type': 'application/json' },
      },
    );

    expect(response.ok()).toBeFalsy();
    expect(await response.text()).toContain('not currently active');

    const unsigned = await prisma.field.findUniqueOrThrow({ where: { id: textField.id } });

    expect(unsigned.inserted).toBe(false);
    expect(unsigned.customText).toBe('');
  });

  test('[CONDITIONAL]: a field whose rule is met signs normally on v1', async ({ page }) => {
    const { user, team } = await seedUser();
    const signerEmail = `signer-married-${nanoid(6)}@example.com`;

    const { recipient, radioField, textField } = await seedConditionalDocument(
      user.id,
      team.id,
      signerEmail,
    );

    await page.goto(`${WEBAPP}/sign/${recipient.token}`);

    await expect(page.locator(`#field-${radioField.id}`)).toBeVisible({ timeout: 20_000 });

    // Answer "Married", which satisfies the dependent's rule.
    await page.locator(`label[for="option-${radioField.id}-1"]`).click();

    await expect(async () => {
      await expect(page.locator(`#field-${radioField.id}`)).toHaveAttribute(
        'data-inserted',
        'true',
      );
    }).toPass({ timeout: 10_000 });

    // The control arm for the refusal above: the same call now succeeds, so the
    // rejection is the rule doing its job rather than the route being broken.
    const response = await page.request.post(
      `${WEBAPP}/api/trpc/field.signFieldWithToken?batch=1`,
      {
        data: {
          0: { json: { token: recipient.token, fieldId: textField.id, value: 'Jane Doe' } },
        },
        headers: { 'content-type': 'application/json' },
      },
    );

    expect(response.ok()).toBeTruthy();

    const signed = await prisma.field.findUniqueOrThrow({ where: { id: textField.id } });

    expect(signed.inserted).toBe(true);
    expect(signed.customText).toBe('Jane Doe');
  });

  /**
   * Scenario C (database-level): verify that the webhook payload excludes
   * hidden fields by inspecting ZWebhookDocumentSchema filter.
   *
   * We verify this by seeding a completed document where the spouse_name
   * was conditionally hidden (customText = '', inserted = false) and
   * assert that the field is absent from the webhook payload shape
   * (i.e. the field's secondaryId is not in the mapped visible fields).
   */
  test('[CONDITIONAL]: completed document has skipped-field audit log when condition unmet', async ({
    page,
  }) => {
    const { user, team } = await seedUser();

    // We construct the scenario entirely at the DB level:
    // Seed the doc, then manually "sign" the radio as Single and call
    // complete-document-with-token via the server function directly.
    const signerEmail = `signer-complete-${nanoid(6)}@example.com`;
    const { recipient, radioField, textField, envelope, documentId } =
      await seedConditionalDocument(user.id, team.id, signerEmail);

    // Simulate radio field signed with "Single"
    await prisma.field.update({
      where: { id: radioField.id },
      data: { customText: 'Single', inserted: true },
    });

    // Text field remains uninserted (as if hidden)
    // Text field is required but hidden — the completion logic should skip it.

    // Over HTTP rather than by importing `completeDocumentWithToken` here.
    // Calling it in-process drags the lingui `msg` macro in through the email
    // templates, and tsx does not run the macro transform, so the import dies
    // at collection time with "import_macro.msg is not a function" and the
    // whole file reports zero tests. The route is the same function, and the
    // helper is shared with the v2 specs - it is the public signing route, not
    // a v2-only one.
    const completion = await completeV2SigningViaTrpc(page, {
      token: recipient.token,
      documentId,
    });

    expect(completion.status).toBe(200);

    // Verify FIELD_SKIPPED_CONDITIONAL was written for textField
    const skippedLogs = await prisma.documentAuditLog.findMany({
      where: {
        envelopeId: envelope.id,
        type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_SKIPPED_CONDITIONAL,
      },
    });

    expect(skippedLogs.length).toBeGreaterThan(0);

    const logData = skippedLogs[0].data as { fieldLabel?: string };
    expect(logData.fieldLabel).toMatch(/spouse/i);

    // Verify the text field was cleared (customText reset to '')
    const updatedTextField = await prisma.field.findUniqueOrThrow({
      where: { id: textField.id },
    });
    expect(updatedTextField.customText).toBe('');
    expect(updatedTextField.inserted).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // FIXME: Template creation via the UI (Task 21 full happy path)
  // ---------------------------------------------------------------------------

  test.fixme(
    '[CONDITIONAL][UI]: create template with conditional fields via the editor',
    async ({ page }) => {
      /**
       * TODO: Un-skip once the Konva-canvas drive is stabilised.
       *
       * Conditional visibility is now authored TRIGGER-CENTRICally in the v2
       * editor: you select the radio/checkbox/dropdown (the trigger), then per
       * option choose which fields to reveal via a canvas "pick-mode". The
       * underlying storage / evaluation (exercised by the DB-seeded tests above)
       * is unchanged — only the authoring UI differs.
       *
       * 1. PLACING FIELDS ON THE PDF CANVAS
       *    Fields are placed onto a Konva canvas. Pattern used by other tests:
       *      await page.getByRole('button', { name: /radio/i }).click();
       *      await page.locator(PDF_VIEWER_PAGE_SELECTOR).click({ position: { x: 100, y: 100 } });
       *    See `packages/app-tests/e2e/document-flow/autosave-fields-step.spec.ts`.
       *
       * 2. CONFIGURING THE TRIGGER
       *    Selecting the radio opens its settings in the right sidebar. Set its
       *    options (Married, Single) via the `field-form-values-*` inputs, then
       *    the trigger-centric "Conditional visibility" section renders below
       *    (test-id `conditional-visibility-section`) with one row per option.
       *
       * 3. SELECTING DEPENDENT FIELDS FOR AN OPTION
       *    Click the per-option "Select fields" button
       *    (`visibility-select-fields-<index>`) to enter pick-mode, then click
       *    the dependent field(s) on the canvas to toggle them into the
       *    condition. Click the button again (now "Done") to exit pick-mode. The
       *    click writes a `visibility` rule onto the dependent field's meta.
       *
       * 4. SAVING AND USING THE TEMPLATE
       *    Follows the existing pattern in `create-document-from-template.spec.ts`.
       *
       * 5. COMPLETING THE SIGNING FLOW
       *    Follow the same pattern used in the database-seeded tests above.
       */

      const { user, team } = await seedUser();
      const template = await import('@documenso/prisma/seed/templates').then(async (m) =>
        m.seedBlankTemplate(user, team.id),
      );

      await apiSignin({
        page,
        email: user.email,
        redirectPath: `/t/${team.url}/templates/${template.id}/edit`,
      });

      // TODO: Set title
      await page.getByLabel('Title').fill('Conditional visibility e2e');

      // TODO: Add signer
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByPlaceholder('Email').fill('signer@example.com');
      await page.getByPlaceholder('Name').fill('Test Signer');
      await page.getByRole('button', { name: 'Continue' }).click();

      // TODO: Add text field "Spouse Name" at (100, 200) — the dependent
      // await page.getByRole('button', { name: /text/i }).click();
      // await page.locator(PDF_VIEWER_PAGE_SELECTOR).click({ position: { x: 100, y: 200 } });

      // TODO: Add radio field "Marital Status" at (100, 100) — the trigger
      // await page.getByRole('button', { name: /radio/i }).click();
      // await page.locator(PDF_VIEWER_PAGE_SELECTOR).click({ position: { x: 100, y: 100 } });

      // TODO: With the radio selected, set its options (Married, Single) via the
      //       `field-form-values-*` inputs in the sidebar.

      // TODO: In the trigger-centric visibility section, reveal spouse_name for "Married":
      //   - await page.getByTestId('visibility-select-fields-0').click(); // "Married" row
      //   - click the spouse_name field on the canvas to toggle it in
      //   - await page.getByTestId('visibility-select-fields-0').click(); // "Done"

      // TODO: Save template and create document
      // await page.getByRole('button', { name: 'Save template' }).click();
      // ...

      // TODO: Sign as signer with Single → assert spouse_name absent
      // TODO: Sign as signer with Married → assert spouse_name visible and required
    },
  );
});
