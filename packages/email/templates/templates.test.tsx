/**
 * A render pass over every email template.
 *
 * `packages/email` had no test setup of any kind, which is how
 * `b5b70d2ac` ("move Preview component inside Body") came to be a 24-template
 * change with one template covered. The preview text is the line a mail client
 * shows next to the subject; a `<Preview>` that sits outside `<Body>` is dropped
 * by some clients and rendered as visible body text by others, and nothing about
 * that is visible from the source of any single template.
 *
 * So rather than one assertion per template, this renders all of them and
 * asserts the invariants that hold for every one. It is deliberately cheap to
 * extend: a new template is a new row.
 */
import type { ReactElement } from 'react';

import { setupI18n } from '@lingui/core';
import { OrganisationType, RecipientRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { renderWithI18N } from '../render';
import { AccessAuth2FAEmailTemplate } from './access-auth-2fa';
import { AdminUserCreatedTemplate } from './admin-user-created';
import { DocumentReminderEmailTemplate } from './document-reminder';
import { OrganisationDeleteEmailTemplate } from './organisation-delete';
import { OrganisationLimitAlertEmailTemplate } from './organisation-limit-alert';
import { BulkSendCompleteEmail } from './bulk-send-complete';
import { ConfirmEmailTemplate } from './confirm-email';
import { ConfirmTeamEmailTemplate } from './confirm-team-email';
import { DocumentCancelTemplate } from './document-cancel';
import { DocumentCompletedEmailTemplate } from './document-completed';
import { DocumentCreatedFromDirectTemplateEmailTemplate } from './document-created-from-direct-template';
import { DocumentInviteEmailTemplate } from './document-invite';
import { DocumentPendingEmailTemplate } from './document-pending';
import { DocumentRecipientSignedEmailTemplate } from './document-recipient-signed';
import { DocumentRejectedEmail } from './document-rejected';
import { DocumentRejectionConfirmedEmail } from './document-rejection-confirmed';
import { DocumentSelfSignedEmailTemplate } from './document-self-signed';
import { DocumentSuperDeleteEmailTemplate } from './document-super-delete';
import { ForgotPasswordTemplate } from './forgot-password';
import { OrganisationAccountLinkConfirmationTemplate } from './organisation-account-link-confirmation';
import { OrganisationInviteEmailTemplate } from './organisation-invite';
import { OrganisationJoinEmailTemplate } from './organisation-join';
import { OrganisationLeaveEmailTemplate } from './organisation-leave';
import { RecipientExpiredTemplate } from './recipient-expired';
import { RecipientRemovedFromDocumentTemplate } from './recipient-removed-from-document';
import { ResetPasswordTemplate } from './reset-password';
import { TeamDeleteEmailTemplate } from './team-delete';
import { TeamEmailRemovedTemplate } from './team-email-removed';

/**
 * An empty catalogue on purpose.
 *
 * Lingui falls back to the message the macro compiled in, so the templates
 * render their source English without this test depending on compiled
 * catalogues - which are a build artefact, and would make a missing `lingui
 * compile` look like a broken template.
 */
const i18n = setupI18n({ locale: 'en', messages: { en: {} } });

i18n.activate('en');

const ASSET_BASE_URL = 'http://localhost:3002';
const BASE_URL = 'http://localhost:3000';

const TEMPLATES: { name: string; element: ReactElement }[] = [
  {
    name: 'access-auth-2fa',
    element: (
      <AccessAuth2FAEmailTemplate
        documentTitle="Open Source Pledge.pdf"
        code="123456"
        userEmail="lucas@documenso.com"
        userName="Lucas Smith"
        expiresInMinutes={10}
      />
    ),
  },
  {
    name: 'admin-user-created',
    element: <AdminUserCreatedTemplate resetPasswordLink={`${BASE_URL}/reset-password`} />,
  },
  {
    name: 'document-reminder',
    element: (
      <DocumentReminderEmailTemplate
        recipientName="Lucas Smith"
        documentName="Open Source Pledge.pdf"
        signDocumentLink={`${BASE_URL}/sign/token`}
        role={RecipientRole.SIGNER}
      />
    ),
  },
  {
    name: 'organisation-delete',
    element: (
      <OrganisationDeleteEmailTemplate assetBaseUrl={ASSET_BASE_URL} organisationName="Documenso" />
    ),
  },
  {
    name: 'organisation-limit-alert',
    element: (
      <OrganisationLimitAlertEmailTemplate
        assetBaseUrl={ASSET_BASE_URL}
        organisationName="Documenso"
        counter="document"
        kind="quotaNearing"
        period="month"
      />
    ),
  },
  {
    name: 'bulk-send-complete',
    element: (
      <BulkSendCompleteEmail
        userName="Lucas Smith"
        templateName="NDA"
        totalProcessed={10}
        successCount={9}
        failedCount={1}
        errors={['Row 4: invalid email']}
      />
    ),
  },
  {
    name: 'confirm-email',
    element: <ConfirmEmailTemplate confirmationLink={`${BASE_URL}/confirm`} />,
  },
  {
    name: 'confirm-team-email',
    element: (
      <ConfirmTeamEmailTemplate
        assetBaseUrl={ASSET_BASE_URL}
        baseUrl={BASE_URL}
        teamName="Documenso"
        teamUrl="documenso"
        token="token"
      />
    ),
  },
  { name: 'document-cancel', element: <DocumentCancelTemplate /> },
  { name: 'document-completed', element: <DocumentCompletedEmailTemplate /> },
  {
    name: 'document-created-from-direct-template',
    element: (
      <DocumentCreatedFromDirectTemplateEmailTemplate recipientRole={RecipientRole.SIGNER} />
    ),
  },
  {
    name: 'document-invite',
    element: <DocumentInviteEmailTemplate role={RecipientRole.SIGNER} />,
  },
  {
    // The on-behalf-of arm: the same template takes a different preview line
    // when the sender is an organisation, which is fork behaviour (`c0ee54f81`).
    name: 'document-invite (organisation sender)',
    element: (
      <DocumentInviteEmailTemplate
        role={RecipientRole.SIGNER}
        organisationType={OrganisationType.ORGANISATION}
        senderName="Documenso"
        includeSenderDetails
      />
    ),
  },
  { name: 'document-pending', element: <DocumentPendingEmailTemplate /> },
  { name: 'document-recipient-signed', element: <DocumentRecipientSignedEmailTemplate /> },
  {
    name: 'document-rejected',
    element: (
      <DocumentRejectedEmail
        recipientName="Lucas Smith"
        documentName="Open Source Pledge.pdf"
        documentUrl={`${BASE_URL}/documents/1`}
        rejectionReason="Wrong counterparty"
      />
    ),
  },
  {
    name: 'document-rejection-confirmed',
    element: (
      <DocumentRejectionConfirmedEmail
        recipientName="Lucas Smith"
        documentName="Open Source Pledge.pdf"
        documentOwnerName="Ada Lovelace"
        reason="Wrong counterparty"
      />
    ),
  },
  { name: 'document-self-signed', element: <DocumentSelfSignedEmailTemplate /> },
  { name: 'document-super-delete', element: <DocumentSuperDeleteEmailTemplate /> },
  { name: 'forgot-password', element: <ForgotPasswordTemplate /> },
  {
    name: 'organisation-account-link-confirmation',
    element: (
      <OrganisationAccountLinkConfirmationTemplate
        type="link"
        confirmationLink={`${BASE_URL}/confirm`}
        organisationName="Documenso"
        assetBaseUrl={ASSET_BASE_URL}
      />
    ),
  },
  {
    name: 'organisation-invite',
    element: (
      <OrganisationInviteEmailTemplate
        assetBaseUrl={ASSET_BASE_URL}
        baseUrl={BASE_URL}
        senderName="Lucas Smith"
        organisationName="Documenso"
        token="token"
      />
    ),
  },
  {
    name: 'organisation-join',
    element: (
      <OrganisationJoinEmailTemplate
        assetBaseUrl={ASSET_BASE_URL}
        baseUrl={BASE_URL}
        memberName="Lucas Smith"
        memberEmail="lucas@documenso.com"
        organisationName="Documenso"
        organisationUrl="documenso"
      />
    ),
  },
  {
    name: 'organisation-leave',
    element: (
      <OrganisationLeaveEmailTemplate
        assetBaseUrl={ASSET_BASE_URL}
        baseUrl={BASE_URL}
        memberName="Lucas Smith"
        memberEmail="lucas@documenso.com"
        organisationName="Documenso"
        organisationUrl="documenso"
      />
    ),
  },
  { name: 'recipient-expired', element: <RecipientExpiredTemplate /> },
  {
    name: 'recipient-removed-from-document',
    element: <RecipientRemovedFromDocumentTemplate />,
  },
  { name: 'reset-password', element: <ResetPasswordTemplate /> },
  {
    name: 'team-delete',
    element: (
      <TeamDeleteEmailTemplate
        assetBaseUrl={ASSET_BASE_URL}
        baseUrl={BASE_URL}
        teamUrl="documenso"
      />
    ),
  },
  {
    name: 'team-email-removed',
    element: (
      <TeamEmailRemovedTemplate
        assetBaseUrl={ASSET_BASE_URL}
        baseUrl={BASE_URL}
        teamEmail="team@documenso.com"
        teamName="Documenso"
        teamUrl="documenso"
      />
    ),
  },
];

/** The marker react-email puts on the preview block, and nothing else. */
const PREVIEW_MARKER = 'data-skip-in-text="true"';

describe('email templates', () => {
  it('covers every template in the directory', async () => {
    const { readdirSync } = await import('node:fs');

    const onDisk = readdirSync(__dirname)
      .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
      .map((file) => file.replace(/\.tsx$/, ''))
      .sort();

    // Guards the table above against a template being added and quietly left
    // untested - which is the state this whole file exists to end.
    const covered = new Set(TEMPLATES.map(({ name }) => name.split(' ')[0]));

    expect(onDisk.filter((name) => !covered.has(name))).toEqual([]);
  });

  describe.each(TEMPLATES)('$name', ({ element }) => {
    it('renders with its preview text inside the body', async () => {
      const html = await renderWithI18N(element, { i18n });

      expect(html.length).toBeGreaterThan(0);

      const bodyOpensAt = html.indexOf('<body');
      const bodyClosesAt = html.indexOf('</body>');

      expect(bodyOpensAt).toBeGreaterThan(-1);
      expect(bodyClosesAt).toBeGreaterThan(bodyOpensAt);

      const previewAt = html.indexOf(PREVIEW_MARKER);

      expect(previewAt).toBeGreaterThan(-1);

      // The whole point of `b5b70d2ac`. Outside the body, the preview line is
      // dropped by some clients and shown as body text by others.
      expect(previewAt).toBeGreaterThan(bodyOpensAt);
      expect(previewAt).toBeLessThan(bodyClosesAt);
    });

    it('has non-empty preview text', async () => {
      const html = await renderWithI18N(element, { i18n });

      const previewAt = html.indexOf(PREVIEW_MARKER);
      const afterAttribute = html.indexOf('>', previewAt) + 1;
      const previewText = html.slice(afterAttribute, html.indexOf('<', afterAttribute)).trim();

      // An empty preview is what a mail client shows when a translation key is
      // missing or an interpolated value never arrived, and it is invisible in
      // the rendered email itself.
      expect(previewText.length).toBeGreaterThan(0);
    });

    it('interpolates every value it was given', async () => {
      const html = await renderWithI18N(element, { i18n });

      // A missing prop reaches the reader as the literal word, in the subject
      // preview as often as in the body.
      expect(html).not.toContain('undefined');
      expect(html).not.toContain('[object Object]');
      expect(html).not.toContain('NaN');
    });
  });
});
