import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { DateTime } from 'luxon';
import fs from 'node:fs';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, RecipientRole } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { TDistributeEnvelopeRequest } from '@documenso/trpc/server/envelope-router/distribute-envelope.types';
import type { TRedistributeEnvelopeRequest } from '@documenso/trpc/server/envelope-router/redistribute-envelope.types';

/**
 * The two arms of `6736d0b8e` that live on the server rather than in a dialog.
 *
 * A fixed expiration date is stored as a zone-less wall clock and only becomes an
 * instant at send time, so nothing before sending can tell that a deadline has
 * lapsed. Resending is exactly what an owner reaches for after an expiry
 * notification, which is where a lapsed deadline would otherwise produce a
 * reminder pointing at a dead signing page. The editor's own picker is covered
 * in `envelope-distribute-dialog.spec.ts`; this is the API refusing it.
 *
 * The second test covers the audit diff type the same commit added, which is
 * what makes a change of deadline reconstructable after the fact.
 */

const baseUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../../assets/example.pdf'));

const seedEnvelopeWithRecipient = async (request: APIRequestContext) => {
  const { user, team } = await seedUser();

  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: `e2e-expiration-resend-${user.id}`,
    expiresIn: null,
  });

  const createPayload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: `[TEST] Expiration resend ${user.id}`,
    recipients: [
      {
        email: `expiration-resend-${user.id}@test.documenso.com`,
        name: 'Expiration Signer',
        role: RecipientRole.SIGNER,
        fields: [
          {
            type: 'SIGNATURE',
            page: 1,
            positionX: 10,
            positionY: 10,
            width: 10,
            height: 5,
            fieldMeta: { type: 'signature' },
          },
        ],
      },
    ],
  };

  const formData = new FormData();
  formData.append('payload', JSON.stringify(createPayload));
  formData.append('files', new File([examplePdf], 'example.pdf', { type: 'application/pdf' }));

  const createRes = await request.post(`${baseUrl}/envelope/create`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });

  expect(createRes.ok()).toBeTruthy();

  const { id: envelopeId }: TCreateEnvelopeResponse = await createRes.json();

  return { user, team, token, envelopeId };
};

const distribute = async (request: APIRequestContext, token: string, envelopeId: string) => {
  const res = await request.post(`${baseUrl}/envelope/distribute`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { envelopeId } satisfies TDistributeEnvelopeRequest,
  });

  expect(res.ok()).toBeTruthy();
};

const setFixedExpiration = async (envelopeId: string, expiresAt: string) => {
  const envelope = await prisma.envelope.findFirstOrThrow({ where: { id: envelopeId } });

  await prisma.documentMeta.update({
    where: { id: envelope.documentMetaId },
    data: { envelopeExpirationPeriod: { expiresAt } },
  });
};

const redistribute = async (
  request: APIRequestContext,
  token: string,
  envelopeId: string,
  recipientIds: number[],
) =>
  await request.post(`${baseUrl}/envelope/redistribute`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { envelopeId, recipients: recipientIds } satisfies TRedistributeEnvelopeRequest,
  });

test('resending is refused while the fixed expiration date is in the past', async ({ request }) => {
  const { token, envelopeId } = await seedEnvelopeWithRecipient(request);

  // Set while the deadline is still ahead, which is the only state the sender
  // could have created it in - a past date is blocked at send time.
  await setFixedExpiration(
    envelopeId,
    DateTime.now().plus({ days: 5 }).toFormat("yyyy-MM-dd'T'HH:mm"),
  );

  await distribute(request, token, envelopeId);

  const envelope = await prisma.envelope.findFirstOrThrow({
    where: { id: envelopeId },
    include: { recipients: true },
  });

  const recipientIds = envelope.recipients.map((recipient) => recipient.id);

  // Still in the future: the reminder goes out.
  expect((await redistribute(request, token, envelopeId, recipientIds)).ok()).toBeTruthy();

  // Time passes. The deadline is now behind us.
  await setFixedExpiration(
    envelopeId,
    DateTime.now().minus({ days: 1 }).toFormat("yyyy-MM-dd'T'HH:mm"),
  );

  const lapsedRes = await redistribute(request, token, envelopeId, recipientIds);

  expect(lapsedRes.ok()).toBeFalsy();

  const body = await lapsedRes.text();

  // The refusal has to say what to do about it - the owner is holding a document
  // nobody can sign and no other screen explains why.
  expect(body).toContain('expiration date');
  expect(body).toContain('Update it before resending');
});

test('a duration is only refused once it has actually elapsed for the recipient', async ({
  request,
}) => {
  const { token, envelopeId } = await seedEnvelopeWithRecipient(request);

  await distribute(request, token, envelopeId);

  const envelope = await prisma.envelope.findFirstOrThrow({
    where: { id: envelopeId },
    include: { documentMeta: true, recipients: true },
  });

  // A relative period is re-resolved from "now" on every resend, so it can never
  // be in the past; only a fixed date can lapse. The guard must not reach it.
  await prisma.documentMeta.update({
    where: { id: envelope.documentMetaId },
    data: { envelopeExpirationPeriod: { unit: 'day', amount: 1 } },
  });

  const res = await redistribute(
    request,
    token,
    envelopeId,
    envelope.recipients.map((recipient) => recipient.id),
  );

  expect(res.ok()).toBeTruthy();
});

test('changing the expiration period at send time is recorded as a document meta diff', async ({
  request,
}) => {
  const { token, envelopeId } = await seedEnvelopeWithRecipient(request);

  // Through distribute rather than update: the send dialog is where a deadline
  // is set, and it is the distribute route - not `envelope/update` - that runs
  // the change through `updateDocumentMeta` and its diff builder.
  const res = await request.post(`${baseUrl}/envelope/distribute`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      envelopeId,
      meta: { envelopeExpirationPeriod: { unit: 'week', amount: 2 } },
    } satisfies TDistributeEnvelopeRequest,
  });

  expect(res.ok()).toBeTruthy();

  const logs = await prisma.documentAuditLog.findMany({
    where: { envelopeId, type: 'DOCUMENT_META_UPDATED' },
    orderBy: { createdAt: 'desc' },
  });

  expect(logs.length).toBeGreaterThan(0);

  const diffs = logs.flatMap((log) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const data = log.data as { changes?: Array<{ type: string; from: unknown; to: unknown }> };

    return data.changes ?? [];
  });

  const expirationDiff = diffs.find((diff) => diff.type === 'ENVELOPE_EXPIRATION_PERIOD');

  expect(expirationDiff).toBeDefined();

  // Both sides are recorded, so the old deadline is recoverable - the point of
  // an audit entry over a "something changed" flag.
  expect(expirationDiff!.to).toBe(JSON.stringify({ unit: 'week', amount: 2 }));
  expect(expirationDiff!.from).not.toBe(expirationDiff!.to);
});
