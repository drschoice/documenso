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
import { expect, test } from '@playwright/test';

import { incrementDocumentId } from '@documenso/lib/server-only/envelope/increment-id';
import { prefixedId } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import {
  DocumentDataType,
  DocumentSource,
  DocumentStatus,
  EnvelopeType,
} from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';

import { apiSignin } from '../fixtures/authentication';

async function seedDraftEnvelopeWithTwoItems(ownerUserId: number, teamId: number) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const examplePdf = fs
    .readFileSync(path.join(__dirname, '../../../../assets/example.pdf'))
    .toString('base64');

  const dataA = await prisma.documentData.create({
    data: { type: DocumentDataType.BYTES_64, data: examplePdf, initialData: examplePdf },
  });
  const dataB = await prisma.documentData.create({
    data: { type: DocumentDataType.BYTES_64, data: examplePdf, initialData: examplePdf },
  });

  const documentMeta = await prisma.documentMeta.create({ data: {} });
  const documentId = await incrementDocumentId();

  const envelope = await prisma.envelope.create({
    data: {
      id: prefixedId('envelope'),
      secondaryId: documentId.formattedDocumentId,
      internalVersion: 1,
      type: EnvelopeType.DOCUMENT,
      documentMetaId: documentMeta.id,
      source: DocumentSource.DOCUMENT,
      status: DocumentStatus.DRAFT,
      title: 'AI Detect Exclusions Test',
      userId: ownerUserId,
      teamId,
      envelopeItems: {
        create: [
          {
            id: prefixedId('envelope_item'),
            title: 'Keep.pdf',
            order: 0,
            documentDataId: dataA.id,
          },
          {
            id: prefixedId('envelope_item'),
            title: 'Skip.pdf',
            order: 1,
            documentDataId: dataB.id,
          },
        ],
      },
    },
    include: { envelopeItems: true },
  });

  return envelope;
}

test('uncheck one envelope item -> excludeEnvelopeItemIds contains its id', async ({ page }) => {
  const { user, organisation, team } = await seedUser();

  // Enable AI features for the organisation so the "Detect with AI" button renders.
  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { aiFeaturesEnabled: true },
  });

  const envelope = await seedDraftEnvelopeWithTwoItems(user.id, team.id);
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

  // Open the AI detect dialog.
  await page.getByRole('button', { name: /detect with ai/i }).click();

  // Wait for checklist to render.
  await expect(page.getByText(/analyze these documents/i)).toBeVisible();

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
