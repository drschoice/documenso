import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { EnvelopeType, OrganisationType, RecipientRole } from '@documenso/prisma/client';
import { setOrganisationType } from '@documenso/prisma/seed/organisations';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { TDistributeEnvelopeRequest } from '@documenso/trpc/server/envelope-router/distribute-envelope.types';

import { clearMailbox, waitForLatestMessage } from '../fixtures/mail';

/**
 * Content of the emails the app actually sends.
 *
 * `docker/development/compose.yml` has always run Inbucket and `.env.example`
 * has always pointed `NEXT_PRIVATE_SMTP_*` at it, in CI too - but no spec ever
 * read a message back, so `c8aa4bdc9` (subject lines) and the 24 rewritten
 * templates in `b5b70d2ac` shipped entirely unverified.
 */

const baseUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

const createAndDistribute = async ({
  request,
  token,
  title,
  signerEmail,
}: {
  request: import('@playwright/test').APIRequestContext;
  token: string;
  title: string;
  signerEmail: string;
}) => {
  const createPayload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title,
    recipients: [
      {
        email: signerEmail,
        name: 'Email Subject Signer',
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

  const distributeRes = await request.post(`${baseUrl}/envelope/distribute`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { envelopeId } satisfies TDistributeEnvelopeRequest,
  });

  expect(distributeRes.ok()).toBeTruthy();

  return envelopeId;
};

test('[EMAIL]: an organisation invite names the sender and the document in the subject', async ({
  request,
}) => {
  const { user, team, organisation } = await seedUser();

  // `c8aa4bdc9` gave ORGANISATION-type senders a specific subject
  // ("<sender> invited you to sign \"<title>\"") in place of the generic
  // "Please sign this document". Set the type explicitly rather than relying on
  // the seed default, so the test still means something if that default moves.
  await setOrganisationType({
    organisationId: organisation.id,
    type: OrganisationType.ORGANISATION,
  });

  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: `e2e-email-subject-${user.id}`,
    expiresIn: null,
  });

  const title = `[TEST] Email subject ${user.id}`;
  const signerEmail = `email-subject-${user.id}@test.documenso.com`;

  await clearMailbox(request, signerEmail);
  await createAndDistribute({ request, token, title, signerEmail });

  const message = await waitForLatestMessage(request, signerEmail);

  expect(message.subject).toContain('invited you to sign');
  expect(message.subject).toContain(title);

  // The invite still carries a link the recipient can act on.
  expect(message.body.html).toContain('/sign/');
});

test('[EMAIL]: a personal-account invite keeps the generic subject', async ({ request }) => {
  // `seedUser()` creates an ORGANISATION-type organisation by default
  // (`packages/prisma/seed/users.ts:35`), so a personal account has to be asked
  // for explicitly.
  const { user, team } = await seedUser({ isPersonalOrganisation: true });

  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: `e2e-email-personal-${user.id}`,
    expiresIn: null,
  });

  const title = `[TEST] Personal subject ${user.id}`;
  const signerEmail = `email-personal-${user.id}@test.documenso.com`;

  await clearMailbox(request, signerEmail);
  await createAndDistribute({ request, token, title, signerEmail });

  const message = await waitForLatestMessage(request, signerEmail);

  expect(message.subject).toBe('Please sign this document');
});
