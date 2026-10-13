import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import {
  EmailSenderNameMode,
  EnvelopeType,
  OrganisationType,
  RecipientRole,
} from '@documenso/prisma/client';
import { setOrganisationType } from '@documenso/prisma/seed/organisations';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import type { TDistributeEnvelopeRequest } from '@documenso/trpc/server/envelope-router/distribute-envelope.types';

import { clearMailbox, waitForLatestMessage } from '../fixtures/mail';

/**
 * The name envelope emails speak as (`c8aa4bdc9`).
 *
 * Upstream always said the team name. That reads wrong for an organisation
 * whose teams are internal divisions - "General invited you to sign" - when the
 * brand the recipient recognises is the organisation. The fork made it a
 * setting, per organisation and overridable per team, and `resolveEmailSenderName`
 * has unit tests; what had no coverage at all was whether the resolved name ever
 * reaches a sent message. Everything below reads the real mail back out of
 * Inbucket.
 */

const baseUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

/**
 * An organisation-type account whose organisation and team are named distinctly,
 * so a subject line naming one of them can never be mistaken for the other.
 */
const seedNamedOrganisation = async () => {
  const { user, team, organisation } = await seedUser();

  await setOrganisationType({
    organisationId: organisation.id,
    type: OrganisationType.ORGANISATION,
  });

  const organisationName = `Acme Holdings ${user.id}`;
  const teamName = `Legal Division ${user.id}`;

  await prisma.organisation.update({
    where: { id: organisation.id },
    data: { name: organisationName },
  });

  await prisma.team.update({
    where: { id: team.id },
    data: { name: teamName },
  });

  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: `e2e-sender-name-${user.id}`,
    expiresIn: null,
  });

  return { user, team, organisation, organisationName, teamName, token };
};

const setOrganisationSenderName = async (
  organisationGlobalSettingsId: string,
  data: { emailSenderNameMode?: EmailSenderNameMode; emailSenderNameCustom?: string },
) =>
  await prisma.organisationGlobalSettings.update({
    where: { id: organisationGlobalSettingsId },
    data,
  });

const setTeamSenderName = async (
  teamGlobalSettingsId: string,
  data: { emailSenderNameMode?: EmailSenderNameMode | null; emailSenderNameCustom?: string | null },
) =>
  await prisma.teamGlobalSettings.update({
    where: { id: teamGlobalSettingsId },
    data,
  });

const distributeEnvelopeTo = async ({
  request,
  token,
  title,
  signerEmail,
  message,
}: {
  request: APIRequestContext;
  token: string;
  title: string;
  signerEmail: string;
  message?: string;
}) => {
  const createPayload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title,
    meta: message ? { message } : undefined,
    recipients: [
      {
        email: signerEmail,
        name: 'Sender Name Signer',
        role: RecipientRole.SIGNER,
        fields: [
          {
            type: 'SIGNATURE',
            page: 1,
            positionX: 10,
            positionY: 10,
            width: 10,
            height: 5,
            fieldMeta: { type: 'signature', overflow: 'auto' },
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

/**
 * Distribute and read back the one message the signer receives.
 *
 * The mailbox is emptied before the envelope is created rather than after, so a
 * message that arrives while the job queue is still draining cannot be deleted
 * unread.
 */
const distributeAndReadMail = async (options: {
  request: APIRequestContext;
  token: string;
  title: string;
  signerEmail: string;
  message?: string;
}) => {
  await clearMailbox(options.request, options.signerEmail);

  await distributeEnvelopeTo(options);

  return await waitForLatestMessage(options.request, options.signerEmail);
};

test('[EMAIL]: the default sender name is the organisation, not the team', async ({ request }) => {
  const { user, organisation, organisationName, teamName, token } = await seedNamedOrganisation();

  // `generateDefaultOrganisationSettings` ships ORGANISATION and
  // `generateDefaultTeamSettings` ships null (inherit), so this is what an
  // account that never touched the setting sends. Asserted explicitly rather
  // than assumed, since the whole point of the change was to move this default.
  const settings = await prisma.organisationGlobalSettings.findFirstOrThrow({
    where: { id: organisation.organisationGlobalSettingsId },
  });

  expect(settings.emailSenderNameMode).toBe(EmailSenderNameMode.ORGANISATION);

  const title = `[TEST] Default sender ${user.id}`;
  const message = await distributeAndReadMail({
    request,
    token,
    title,
    signerEmail: `sender-default-${user.id}@test.documenso.com`,
  });

  expect(message.subject).toBe(`${organisationName} invited you to sign "${title}"`);
  expect(message.subject).not.toContain(teamName);
});

test('[EMAIL]: a team can override the organisation and speak as itself', async ({ request }) => {
  const { user, team, organisationName, teamName, token } = await seedNamedOrganisation();

  const teamRow = await prisma.team.findFirstOrThrow({ where: { id: team.id } });

  await setTeamSenderName(teamRow.teamGlobalSettingsId, {
    emailSenderNameMode: EmailSenderNameMode.TEAM,
  });

  const title = `[TEST] Team sender ${user.id}`;
  const message = await distributeAndReadMail({
    request,
    token,
    title,
    signerEmail: `sender-team-${user.id}@test.documenso.com`,
  });

  expect(message.subject).toBe(`${teamName} invited you to sign "${title}"`);
  expect(message.subject).not.toContain(organisationName);
});

test('[EMAIL]: a custom sender name resolves both placeholders', async ({ request }) => {
  const { user, organisation, organisationName, teamName, token } = await seedNamedOrganisation();

  // The custom string runs through the same placeholder renderer as the subject
  // and message fields, so a name can combine both without hardcoding either.
  await setOrganisationSenderName(organisation.organisationGlobalSettingsId, {
    emailSenderNameMode: EmailSenderNameMode.CUSTOM,
    emailSenderNameCustom: '{organisation.name} - {team.name}',
  });

  const title = `[TEST] Custom sender ${user.id}`;
  const message = await distributeAndReadMail({
    request,
    token,
    title,
    signerEmail: `sender-custom-${user.id}@test.documenso.com`,
  });

  expect(message.subject).toBe(`${organisationName} - ${teamName} invited you to sign "${title}"`);
});

test('[EMAIL]: an invite without a custom message does not restate its own headline', async ({
  request,
}) => {
  const { user, organisationName, token } = await seedNamedOrganisation();

  const title = `[TEST] Redundant body ${user.id}`;
  const message = await distributeAndReadMail({
    request,
    token,
    title,
    signerEmail: `sender-body-${user.id}@test.documenso.com`,
  });

  // The resolved name reaches the body, not only the subject.
  expect(message.body.html).toContain(organisationName);

  // The headline above the button already says who invited whom. The old default
  // body said it a second time in the paragraph below, in near-identical words
  // ("... has invited you to sign the document \"<title>\"."); `c8aa4bdc9` dropped
  // it, leaving that paragraph empty unless someone actually wrote a message.
  expect(message.body.text).not.toContain('has invited you to sign the document');
});

test('[EMAIL]: a custom message is rendered in the body', async ({ request }) => {
  const { user, token } = await seedNamedOrganisation();

  const title = `[TEST] Custom body ${user.id}`;
  const message = await distributeAndReadMail({
    request,
    token,
    title,
    signerEmail: `sender-message-${user.id}@test.documenso.com`,
    message: 'First paragraph.\n\nSecond paragraph.',
  });

  expect(message.body.text).toContain('First paragraph.');
  expect(message.body.text).toContain('Second paragraph.');

  // Blank-line separated text becomes separate paragraphs rather than one run-on
  // line, which is the whole reason `TemplateCustomMessageBody` exists.
  expect(message.body.html).toContain('First paragraph.');
  expect(message.body.html).toContain('Second paragraph.');
});
