import { SignatureLevel } from '@documenso/lib/types/signature-level';
/**
 * E2E test for AI field detection per-item exclusions.
 *
 * Strategy: seed a DRAFT envelope with two envelope items, navigate to the editor,
 * open the "Detect with AI" dialog, uncheck one item, click Detect. Intercept the
 * POST /api/ai/detect-fields request and assert that the request body contains
 * excludeEnvelopeItemIds == [<unchecked item id>].
 *
 * The AI service is never actually called — the route is fulfilled by Playwright
 * with a fake streaming response containing zero detected fields.
 */
import { type Page, expect, test } from '@playwright/test';

import { incrementDocumentId } from '@documenso/lib/server-only/envelope/increment-id';
import { prefixedId } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import { DocumentDataType, DocumentSource, DocumentStatus, EnvelopeType } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';

import { apiSignin } from '../fixtures/authentication';
import { clickEnvelopeEditorStep, waitForEditorCanvas } from '../fixtures/envelope-editor';
import { expectKonvaElementCount } from '../fixtures/konva';

async function seedDraftEnvelope(
  ownerUserId: number,
  teamId: number,
  { itemTitles = ['Keep.pdf', 'Skip.pdf'], withRecipient = false } = {},
) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const examplePdf = fs
    .readFileSync(path.join(__dirname, '../../../../assets/example.pdf'))
    .toString('base64');

  // One row per item rather than a shared one, so nothing here depends on two
  // envelope items being allowed to point at the same document data.
  const documentData = await Promise.all(
    itemTitles.map(async () =>
      prisma.documentData.create({
        data: { type: DocumentDataType.BYTES_64, data: examplePdf, initialData: examplePdf },
      }),
    ),
  );

  const documentMeta = await prisma.documentMeta.create({ data: {} });
  const documentId = await incrementDocumentId();

  const envelope = await prisma.envelope.create({
    data: {
      id: prefixedId('envelope'),
      secondaryId: documentId.formattedDocumentId,
      // The editor route sends anything that is not version 2 to `legacy_editor`,
      // which has neither the step rail nor the AI sidebar this test drives.
      internalVersion: 2,
      signatureLevel: SignatureLevel.SES,
      type: EnvelopeType.DOCUMENT,
      documentMetaId: documentMeta.id,
      source: DocumentSource.DOCUMENT,
      status: DocumentStatus.DRAFT,
      title: 'AI Detect Exclusions Test',
      userId: ownerUserId,
      teamId,
      envelopeItems: {
        create: itemTitles.map((title, index) => ({
          id: prefixedId('envelope_item'),
          title,
          order: index,
          documentDataId: documentData[index].id,
        })),
      },
    },
    include: { envelopeItems: true },
  });

  // Detected fields carry a `recipientId`, so anything that applies them to the
  // canvas needs a recipient to assign them to.
  const recipient = withRecipient
    ? await prisma.recipient.create({
        data: {
          envelopeId: envelope.id,
          email: `ai-detect-${ownerUserId}@example.com`,
          name: 'AI Detect Signer',
          token: prefixedId('token'),
          readStatus: 'NOT_OPENED',
          sendStatus: 'NOT_SENT',
          signingStatus: 'NOT_SIGNED',
        },
      })
    : null;

  return { ...envelope, recipient };
}

test('uncheck one envelope item -> excludeEnvelopeItemIds contains its id', async ({ page }) => {
  const { user, organisation, team } = await seedUser();

  // Enable AI features for the organisation so the "Detect with AI" button renders.
  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { aiFeaturesEnabled: true },
  });

  const envelope = await seedDraftEnvelope(user.id, team.id);
  const skipItem = envelope.envelopeItems.find((i) => i.title === 'Skip.pdf')!;

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/documents/${envelope.id}/edit`,
  });

  // Mock the API route: fulfill with a fake "complete" stream event, zero fields.
  await page.route('**/api/ai/detect-fields', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: JSON.stringify({ type: 'complete', fields: [] }) + '\n',
    });
  });

  // "Detect with AI" lives in the fields step's sidebar, but the editor opens on
  // the upload step, so the button is not mounted yet. Together with the
  // `internalVersion` above, this is why the spec could not have passed since it
  // was written - the e2e workflow was never able to run (issue #28).
  await clickEnvelopeEditorStep(page, 'addFields');
  await waitForEditorCanvas(page);

  // Open the AI detect dialog.
  await page.getByRole('button', { name: /detect with ai/i }).click();

  // Wait for checklist to render.
  await expect(page.getByText(/analyze these documents/i)).toBeVisible();

  // Two documents is one click either way, so the select-all toggle is withheld
  // until there are three - see the arm below.
  await expect(page.getByRole('button', { name: 'Deselect all' })).toHaveCount(0);

  // Uncheck "Skip.pdf".
  await page.getByLabel('Skip.pdf').click();

  // Set up the request waiter BEFORE clicking Detect.
  const requestPromise = page.waitForRequest(
    (req) => req.url().includes('/api/ai/detect-fields') && req.method() === 'POST',
  );

  // Click Detect.
  await page.getByRole('button', { name: /^detect$/i }).click();

  const request = await requestPromise;
  const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;

  expect(body.excludeEnvelopeItemIds).toEqual([skipItem.id]);
  expect(body.envelopeId).toBe(envelope.id);
});

/**
 * Shared setup for the dialog arms below: enable AI for the organisation, seed a
 * draft envelope, sign in and open the fields step where the sidebar lives.
 */
const openDetectDialog = async (
  page: Page,
  options: { itemTitles?: string[]; withRecipient?: boolean } = {},
) => {
  const { user, organisation, team } = await seedUser();

  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { aiFeaturesEnabled: true },
  });

  const envelope = await seedDraftEnvelope(user.id, team.id, options);

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/documents/${envelope.id}/edit`,
  });

  await clickEnvelopeEditorStep(page, 'addFields');
  await waitForEditorCanvas(page);

  await page.getByRole('button', { name: /detect with ai/i }).click();

  return { envelope, team, user };
};

test('select all and deselect all drive every item, and Detect needs at least one', async ({
  page,
}) => {
  // Three items, because that is where the toggle starts being offered.
  const { envelope } = await openDetectDialog(page, {
    itemTitles: ['One.pdf', 'Two.pdf', 'Three.pdf'],
  });

  await expect(page.getByText(/analyze these documents/i)).toBeVisible();

  const detectButton = page.getByRole('button', { name: /^detect$/i });
  const checkboxes = envelope.envelopeItems.map((item) => page.getByLabel(item.title));

  // Everything starts included, so the toggle offers to clear the selection.
  for (const checkbox of checkboxes) {
    await expect(checkbox).toBeChecked();
  }

  await expect(detectButton).toBeEnabled();

  await page.getByRole('button', { name: 'Deselect all' }).click();

  for (const checkbox of checkboxes) {
    await expect(checkbox).not.toBeChecked();
  }

  // Detecting across nothing is meaningless, so the action is closed off rather
  // than sending a request that could only come back empty.
  await expect(detectButton).toBeDisabled();

  await page.getByRole('button', { name: 'Select all' }).click();

  for (const checkbox of checkboxes) {
    await expect(checkbox).toBeChecked();
  }

  await expect(detectButton).toBeEnabled();
});

test('a single-document envelope is offered no checklist', async ({ page }) => {
  await openDetectDialog(page, { itemTitles: ['Only.pdf'] });

  // With one document there is nothing to choose between, so the checklist and
  // its select-all toggle are not rendered at all.
  await expect(page.getByText(/analyze these documents/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deselect all' })).toHaveCount(0);

  await expect(page.getByRole('button', { name: /^detect$/i })).toBeEnabled();
});

test('detected radio options and comb cells reach the canvas and the database', async ({
  page,
}) => {
  const { envelope } = await openDetectDialog(page, {
    itemTitles: ['Only.pdf'],
    withRecipient: true,
  });

  const [item] = envelope.envelopeItems;
  const recipient = envelope.recipient!;

  // The stub stands in for the model. What is under test is everything after it:
  // `onFieldDetectionComplete` turning a detected shape into real editor fields.
  await page.route('**/api/ai/detect-fields', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body:
        JSON.stringify({
          type: 'complete',
          fields: [
            {
              type: 'RADIO',
              label: 'Marital status',
              pageNumber: 1,
              envelopeItemId: item.id,
              recipientId: recipient.id,
              positionX: 10,
              positionY: 10,
              width: 30,
              height: 12,
              confidence: 'high',
              options: [
                { value: 'Married', offsetX: 0, offsetY: 0 },
                { value: 'Single', offsetX: 0, offsetY: 5 },
              ],
            },
            {
              type: 'TEXT',
              label: 'Reference number',
              pageNumber: 1,
              envelopeItemId: item.id,
              recipientId: recipient.id,
              positionX: 10,
              positionY: 40,
              width: 40,
              height: 8,
              confidence: 'high',
              layout: 'cells',
              cellCount: 6,
            },
          ],
        }) + '\n',
    });
  });

  await page.getByRole('button', { name: /^detect$/i }).click();

  await expect(page.getByRole('button', { name: /^add fields$/i })).toBeEnabled({
    timeout: 30_000,
  });

  await page.getByRole('button', { name: /^add fields$/i }).click();

  await expectKonvaElementCount(page, 1, '.field-group', 2);

  await expect(async () => {
    const fields = await prisma.field.findMany({ where: { envelopeId: envelope.id } });

    expect(fields).toHaveLength(2);

    const radio = fields.find((field) => field.type === 'RADIO');
    const text = fields.find((field) => field.type === 'TEXT');

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const radioMeta = radio?.fieldMeta as Record<string, unknown> | null;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const textMeta = text?.fieldMeta as Record<string, unknown> | null;

    // The detected label becomes the group topic, and each detected option
    // becomes a real option carrying the offset it was found at - without those
    // offsets the renderer stacks every option at the field origin.
    expect(radioMeta?.label).toBe('Marital status');

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const values = (radioMeta?.values ?? []) as Array<{ value: string; offsetY?: number }>;

    expect(values.map((value) => value.value)).toEqual(['Married', 'Single']);
    expect(values[1].offsetY).toBe(5);

    // A detected comb field arrives as a cell count and has to become seeded cells.
    expect(textMeta?.label).toBe('Reference number');
    expect(textMeta?.layout).toBe('cells');
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    expect((textMeta?.cells ?? []) as unknown[]).toHaveLength(6);
  }).toPass({ timeout: 30_000 });
});
