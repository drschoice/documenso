/**
 * Server-side AI field detection: the code wrapped *around* the model call.
 *
 * `ai-detect-exclusions.spec.ts` covers the dialog, but it fulfils
 * `/api/ai/detect-fields` in the browser, so it only ever proves what the client
 * asks for. Nothing proved the server did anything with the answer - that
 * `excludeEnvelopeItemIds` is honoured, that one bad page does not take the
 * document down with it, that a page which fails once is retried.
 *
 * Those three live around a non-deterministic network call, so they were
 * untestable until the detector gained a model seam. With
 * `NEXT_PRIVATE_AI_STUB_MODEL=true` the model is a deterministic stand-in
 * steered per request through the `context` field; everything else on the path -
 * the exclusion loop, `pMap`, the retry, the per-page catch, the progress
 * stream - is the production code.
 *
 * The suite sets that variable in `test:e2e`. Against a hand-started server,
 * export it there too or these tests are skipped.
 */
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { IS_AI_STUB_MODEL_ENABLED, NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { buildAiStubDirective } from '@documenso/lib/server-only/ai/stub-model';
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

test.describe.configure({ mode: 'parallel' });

// Rasterising three pages and running detection over them is not a two-second
// job even with the model stubbed out.
test.setTimeout(120_000);

test.skip(
  () => !IS_AI_STUB_MODEL_ENABLED(),
  'requires NEXT_PRIVATE_AI_STUB_MODEL=true on the server under test',
);

type SeedItem = {
  title: string;
  /** File name under the repo-root `assets/` directory. */
  asset: string;
};

const readAsset = (asset: string) =>
  fs.readFileSync(path.join(__dirname, '../../../../assets', asset)).toString('base64');

const seedAiDraftEnvelope = async (ownerUserId: number, teamId: number, items: SeedItem[]) => {
  const documentData = await Promise.all(
    items.map(async (item) => {
      const data = readAsset(item.asset);

      return prisma.documentData.create({
        data: { type: DocumentDataType.BYTES_64, data, initialData: data },
      });
    }),
  );

  const documentMeta = await prisma.documentMeta.create({ data: {} });
  const documentId = await incrementDocumentId();

  const envelope = await prisma.envelope.create({
    data: {
      id: prefixedId('envelope'),
      secondaryId: documentId.formattedDocumentId,
      internalVersion: 2,
      type: EnvelopeType.DOCUMENT,
      documentMetaId: documentMeta.id,
      source: DocumentSource.DOCUMENT,
      status: DocumentStatus.DRAFT,
      title: 'AI detect server test',
      userId: ownerUserId,
      teamId,
      envelopeItems: {
        create: items.map((item, index) => ({
          id: prefixedId('envelope_item'),
          title: item.title,
          order: index,
          documentDataId: documentData[index].id,
        })),
      },
    },
    include: { envelopeItems: { orderBy: { order: 'asc' } } },
  });

  // Detected fields are resolved onto a recipient. Seeding one keeps the
  // detector off the "no recipients, create a blank one" branch, which would
  // otherwise write to the envelope as a side effect of a read-shaped call.
  await prisma.recipient.create({
    data: {
      envelopeId: envelope.id,
      email: `ai-detect-server-${ownerUserId}@example.com`,
      name: 'AI Detect Signer',
      token: prefixedId('token'),
      readStatus: 'NOT_OPENED',
      sendStatus: 'NOT_SENT',
      signingStatus: 'NOT_SIGNED',
    },
  });

  return envelope;
};

type StreamEvent = {
  type: 'progress' | 'complete' | 'error' | 'keepalive';
  message?: string;
  fields?: { envelopeItemId: string; pageNumber: number; label: string }[];
  pagesProcessed?: number;
  totalPages?: number;
  fieldsDetected?: number;
};

/**
 * Drives the real route and splits its NDJSON stream into events.
 *
 * `page.context().request` carries the session cookie `apiSignin` set, so this
 * is the same authenticated call the dialog makes.
 */
const detectFields = async (request: APIRequestContext, body: Record<string, unknown>) => {
  const response = await request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/ai/detect-fields`, {
    data: body,
    timeout: 100_000,
  });

  expect(response.status()).toBe(200);

  const events: StreamEvent[] = (await response.text())
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StreamEvent);

  const failure = events.find((event) => event.type === 'error');

  // Errors arrive inside the stream with a 200, so without this a failed
  // detection reads as "zero fields detected" rather than as a failure.
  expect(failure?.message ?? null).toBeNull();

  const complete = events.find((event) => event.type === 'complete');

  expect(complete).toBeDefined();

  return {
    events,
    fields: complete?.fields ?? [],
    progress: events.filter((event) => event.type === 'progress'),
  };
};

const seedAiTeam = async () => {
  const { user, organisation, team } = await seedUser();

  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { aiFeaturesEnabled: true },
  });

  return { user, team };
};

test('the server skips the envelope items the request excluded', async ({ page }) => {
  const { user, team } = await seedAiTeam();

  const envelope = await seedAiDraftEnvelope(user.id, team.id, [
    { title: 'Keep.pdf', asset: 'example.pdf' },
    { title: 'Skip.pdf', asset: 'example.pdf' },
  ]);

  const [keep, skip] = envelope.envelopeItems;

  await apiSignin({ page, email: user.email });

  const { request } = page.context();

  // Control first: with nothing excluded both items are detected, so the arm
  // below is measuring the exclusion and not some other reason for one item to
  // be missing.
  const control = await detectFields(request, {
    envelopeId: envelope.id,
    teamId: team.id,
    context: buildAiStubDirective({ fieldsPerPage: 1 }),
  });

  expect(control.fields.map((field) => field.envelopeItemId).sort()).toEqual(
    [keep.id, skip.id].sort(),
  );

  const excluded = await detectFields(request, {
    envelopeId: envelope.id,
    teamId: team.id,
    context: buildAiStubDirective({ fieldsPerPage: 1 }),
    excludeEnvelopeItemIds: [skip.id],
  });

  expect(excluded.fields).toHaveLength(1);
  expect(excluded.fields[0].envelopeItemId).toBe(keep.id);
});

test('a page that fails every attempt is skipped, the rest of the document still returns', async ({
  page,
}) => {
  const { user, team } = await seedAiTeam();

  // Three pages, so a failing middle page has a page either side of it. A
  // single-page document cannot tell "skipped the page" from "skipped the
  // document".
  const envelope = await seedAiDraftEnvelope(user.id, team.id, [
    { title: 'Three pages.pdf', asset: 'field-font-alignment.pdf' },
  ]);

  await apiSignin({ page, email: user.email });

  const { fields, progress } = await detectFields(page.context().request, {
    envelopeId: envelope.id,
    teamId: team.id,
    context: buildAiStubDirective({ fieldsPerPage: 1, failPages: [2] }),
  });

  expect(fields.map((field) => field.pageNumber).sort()).toEqual([1, 3]);

  // Progress has to account for the skipped page too. It drives the dialog's
  // counter, so a page that silently stops reporting leaves it stuck below its
  // own total for the rest of the run.
  const last = progress.at(-1);

  expect(last?.pagesProcessed).toBe(3);
  expect(last?.totalPages).toBe(3);
  expect(last?.fieldsDetected).toBe(2);
});

test('a page that fails once is retried rather than skipped', async ({ page }) => {
  const { user, team } = await seedAiTeam();

  const envelope = await seedAiDraftEnvelope(user.id, team.id, [
    { title: 'Three pages.pdf', asset: 'field-font-alignment.pdf' },
  ]);

  await apiSignin({ page, email: user.email });

  const { fields } = await detectFields(page.context().request, {
    envelopeId: envelope.id,
    teamId: team.id,
    context: buildAiStubDirective({ fieldsPerPage: 1, flakyPages: [2] }),
  });

  // The whole point of the retry: the model is non-deterministic, so one bad
  // answer for a page must not cost the page.
  expect(fields.map((field) => field.pageNumber).sort()).toEqual([1, 2, 3]);
});
