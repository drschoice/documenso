import { expect, test } from '@playwright/test';
import { FieldType, WebhookTriggerEvents } from '@prisma/client';

import { encryptSecondaryData } from '@documenso/lib/server-only/crypto/encrypt';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';

import {
  completeV2SigningViaTrpc,
  expectEnvelopeCompleted,
  seedV2PendingEnvelope,
  signV2FieldViaTrpc,
} from '../fixtures/envelope-signing';

/**
 * What happens to a conditionally hidden field when the document is completed.
 *
 * The authoring UI and the signer's hide/reveal are covered elsewhere. These are
 * the three server-side consequences, none of which had a test:
 *
 * - `7692329d1` keeps hidden fields out of the webhook payload. The existing
 *   `conditional-field-visibility.spec.ts` claims this in a docblock ("Scenario
 *   C") but its body only inspects audit logs.
 * - `c7e67be3c` records a `FIELD_SKIPPED_CONDITIONAL` audit entry, carrying the
 *   human-readable reason the certificate renders.
 * - Completion sweeps a hidden field's stored value, so a value captured before
 *   the trigger changed never reaches the sealed PDF.
 *
 * The second test then follows the same audit entry to where a reader actually
 * sees it: the signing certificate.
 */

const RADIO_STABLE_ID = 'marital-status';
const DEPENDENT_STABLE_ID = 'spouse-name';

test('a hidden field is swept, audited, and kept out of the webhook payload', async ({ page }) => {
  const { user, team } = await seedUser();

  // Unroutable on purpose: the delivery attempt fails fast and the request body
  // is still recorded on the WebhookCall row, which is what is under test. The
  // discard port keeps the payload on this machine.
  const webhook = await prisma.webhook.create({
    data: {
      webhookUrl: 'http://127.0.0.1:9/webhook',
      eventTriggers: [WebhookTriggerEvents.DOCUMENT_SIGNED],
      enabled: true,
      userId: user.id,
      teamId: team.id,
    },
  });

  const seeded = await seedV2PendingEnvelope({
    ownerUserId: user.id,
    teamId: team.id,
    recipients: [{ email: `visibility-completion-${user.id}@example.com`, name: 'V2 Signer' }],
    fields: [
      {
        type: FieldType.RADIO,
        positionY: 10,
        width: 30,
        height: 12,
        fieldMeta: {
          type: 'radio',
          direction: 'vertical',
          required: true,
          stableId: RADIO_STABLE_ID,
          label: 'Marital status',
          values: [
            { id: 1, checked: false, value: 'Married' },
            { id: 2, checked: false, value: 'Single' },
          ],
        },
      },
      {
        type: FieldType.TEXT,
        positionY: 35,
        width: 30,
        // Seeded as already answered: the signer filled it in while the trigger
        // still said "Married", then changed their mind. Completion must not
        // carry that answer into the finished document.
        customText: 'Stale spouse answer',
        inserted: true,
        fieldMeta: {
          type: 'text',
          label: 'Spouse name',
          required: true,
          stableId: DEPENDENT_STABLE_ID,
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
        },
      },
      {
        type: FieldType.TEXT,
        positionY: 60,
        width: 30,
        fieldMeta: { type: 'text', label: 'Always shown', required: true, stableId: 'always' },
      },
    ],
  });

  const [recipient] = seeded.recipients;
  const [radioField, dependentField, visibleField] = seeded.fields;

  // Answer "Single" (index 1), which leaves the dependent's rule unmet.
  expect(
    (
      await signV2FieldViaTrpc(page, {
        token: recipient.token,
        fieldId: radioField.id,
        fieldValue: { type: FieldType.RADIO, value: 1 },
      })
    ).status,
  ).toBe(200);

  expect(
    (
      await signV2FieldViaTrpc(page, {
        token: recipient.token,
        fieldId: visibleField.id,
        fieldValue: { type: FieldType.TEXT, value: 'Answered' },
      })
    ).status,
  ).toBe(200);

  // The dependent is required but hidden, so it must not block completion.
  const completed = await completeV2SigningViaTrpc(page, {
    token: recipient.token,
    documentId: seeded.documentId,
  });

  expect(completed.status).toBe(200);

  await expectEnvelopeCompleted(seeded.envelope.id);

  // 1. The stale answer is gone.
  const sweptDependent = await prisma.field.findFirstOrThrow({
    where: { id: dependentField.id },
  });

  expect(sweptDependent.inserted).toBe(false);
  expect(sweptDependent.customText).toBe('');

  // 2. The skip is recorded with something a reader can act on.
  const skippedLogs = await prisma.documentAuditLog.findMany({
    where: { envelopeId: seeded.envelope.id, type: 'FIELD_SKIPPED_CONDITIONAL' },
  });

  expect(skippedLogs).toHaveLength(1);

  const logData = skippedLogs[0].data as {
    stableId?: string;
    fieldLabel?: string;
    unmetRuleSummary?: string;
  };

  expect(logData.stableId).toBe(DEPENDENT_STABLE_ID);
  expect(logData.fieldLabel).toBe('Spouse name');
  // The summary is what the certificate prints, so it has to name the trigger
  // rather than just say a rule was unmet.
  expect(logData.unmetRuleSummary).toContain('Marital status');

  // 3. The webhook consumer never learns the hidden field existed.
  await expect(async () => {
    const call = await prisma.webhookCall.findFirst({
      where: { webhookId: webhook.id, event: WebhookTriggerEvents.DOCUMENT_SIGNED },
      orderBy: { createdAt: 'desc' },
    });

    expect(call).not.toBeNull();

    const body = call!.requestBody as {
      payload?: { fields?: Array<{ id: number }> };
    };

    const fieldIds = (body.payload?.fields ?? []).map((field) => field.id);

    expect(fieldIds).toContain(radioField.id);
    expect(fieldIds).toContain(visibleField.id);
    expect(fieldIds).not.toContain(dependentField.id);
  }).toPass({ timeout: 45_000 });
});

test('the signing certificate lists the skipped field and why it was skipped', async ({ page }) => {
  const { user, team } = await seedUser();

  const seeded = await seedV2PendingEnvelope({
    ownerUserId: user.id,
    teamId: team.id,
    recipients: [{ email: `visibility-certificate-${user.id}@example.com`, name: 'V2 Signer' }],
    fields: [
      {
        type: FieldType.RADIO,
        positionY: 10,
        width: 30,
        height: 12,
        fieldMeta: {
          type: 'radio',
          direction: 'vertical',
          required: true,
          stableId: RADIO_STABLE_ID,
          label: 'Marital status',
          values: [
            { id: 1, checked: false, value: 'Married' },
            { id: 2, checked: false, value: 'Single' },
          ],
        },
      },
      {
        type: FieldType.TEXT,
        positionY: 35,
        width: 30,
        fieldMeta: {
          type: 'text',
          label: 'Spouse name',
          required: true,
          stableId: DEPENDENT_STABLE_ID,
          visibility: {
            match: 'all',
            rules: [
              { operator: 'equals', triggerFieldStableId: RADIO_STABLE_ID, value: 'Married' },
            ],
          },
        },
      },
    ],
  });

  const [recipient] = seeded.recipients;
  const [radioField] = seeded.fields;

  expect(
    (
      await signV2FieldViaTrpc(page, {
        token: recipient.token,
        fieldId: radioField.id,
        fieldValue: { type: FieldType.RADIO, value: 1 },
      })
    ).status,
  ).toBe(200);

  expect(
    (
      await completeV2SigningViaTrpc(page, {
        token: recipient.token,
        documentId: seeded.documentId,
      })
    ).status,
  ).toBe(200);

  await expectEnvelopeCompleted(seeded.envelope.id);

  // The certificate is a normal app route that the sealing job screenshots
  // through a headless browser; visiting it directly renders exactly what the
  // PDF ends up holding, without having to extract text back out of the PDF.
  const encryptedId = encryptSecondaryData({ data: seeded.documentId.toString() });

  await page.goto(`/__htmltopdf/certificate?d=${encodeURIComponent(encryptedId)}`);

  const heading = page.getByText('Fields Not Shown (Conditional)');

  await expect(heading).toBeVisible();

  const entries = heading.locator('xpath=following-sibling::ul').first().getByRole('listitem');

  // Only what was actually withheld, not every field that carries a condition -
  // the trigger itself was answered and shown, so it does not belong here.
  await expect(entries).toHaveCount(1);

  // The label, not the internal id: the certificate is read by people who were
  // never shown the field and have no idea what `spouse-name` is.
  await expect(entries.first()).toContainText('Spouse name');
  await expect(entries.first()).toContainText('not shown because');
  await expect(entries.first()).toContainText('Marital status');
});
