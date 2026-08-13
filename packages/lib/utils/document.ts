import type {
  DocumentMeta,
  Envelope,
  OrganisationGlobalSettings,
  Recipient,
  Team,
  User,
} from '@prisma/client';
import { DocumentDistributionMethod, DocumentSigningOrder, DocumentStatus } from '@prisma/client';

import { DEFAULT_DOCUMENT_TIME_ZONE } from '../constants/time-zones';
import type { TDocumentLite, TDocumentMany } from '../types/document';
import { DEFAULT_DOCUMENT_EMAIL_SETTINGS } from '../types/document-email';
import { mapSecondaryIdToDocumentId } from './envelope';
import { mapRecipientToLegacyRecipient } from './recipients';

export const isDocumentCompleted = (document: Pick<Envelope, 'status'> | DocumentStatus) => {
  const status = typeof document === 'string' ? document : document.status;

  return status === DocumentStatus.COMPLETED || status === DocumentStatus.REJECTED;
};

type SignatureSettings = Pick<
  OrganisationGlobalSettings,
  'typedSignatureEnabled' | 'uploadSignatureEnabled' | 'drawSignatureEnabled'
>;

type PartialSignatureSettings = Partial<{
  [K in keyof SignatureSettings]: boolean | null;
}>;

/**
 * The organisation/team settings are a ceiling, not a default.
 *
 * A signature type disabled upstream can never be re-enabled by a team, a template or a document —
 * downstream values may only narrow the allowance further. Applied both when writing a document and
 * when reading one back, so disabling a signature type also takes effect on envelopes which already
 * exist.
 *
 * @param settings - The merged organisation/team settings acting as the cap.
 * @param value - The downstream value to narrow. Missing/null keys mean "no opinion".
 */
export const capSignatureSettings = (
  settings: SignatureSettings,
  value: PartialSignatureSettings | undefined | null,
): SignatureSettings => {
  const narrowed = value ?? {};

  return {
    typedSignatureEnabled:
      settings.typedSignatureEnabled && (narrowed.typedSignatureEnabled ?? true),
    uploadSignatureEnabled:
      settings.uploadSignatureEnabled && (narrowed.uploadSignatureEnabled ?? true),
    drawSignatureEnabled: settings.drawSignatureEnabled && (narrowed.drawSignatureEnabled ?? true),
  };
};

type LiveResolvableMeta = SignatureSettings & Pick<DocumentMeta, 'dateFormat'>;

/**
 * Resolve a stored date format, where null means "inherit from the organisation/team".
 *
 * @param settings - The merged organisation/team settings.
 * @param meta - The stored document meta.
 */
export const resolveDateFormat = (
  settings: Pick<OrganisationGlobalSettings, 'documentDateFormat'>,
  meta: Pick<DocumentMeta, 'dateFormat'> | undefined | null,
): string => meta?.dateFormat ?? settings.documentDateFormat;

/**
 * Re-cap a stored document meta's signature types against the organisation/team settings as they are
 * *now*, so revoking a signature type also applies to envelopes which already exist.
 *
 * Use this for authoring surfaces, which need `dateFormat` left raw so they can tell an inherited
 * format from a pinned one. Everything that consumes the meta wants `resolveLiveDocumentMeta`.
 *
 * Completed and rejected envelopes are returned untouched — there is nothing left to sign.
 *
 * @param settings - The merged organisation/team settings.
 * @param meta - The stored document meta.
 * @param status - The status of the envelope owning the meta.
 */
export const capLiveDocumentMeta = <T extends SignatureSettings>(
  settings: SignatureSettings,
  meta: T,
  status: DocumentStatus,
): T => {
  if (isDocumentCompleted(status)) {
    return meta;
  }

  return {
    ...meta,
    ...capSignatureSettings(settings, meta),
  };
};

/**
 * Resolve a stored document meta against the organisation/team settings as they are *now*.
 *
 * - Signature types are re-capped, so revoking one applies to envelopes created before the change.
 * - A null `dateFormat` means "inherit", and is filled in from the current settings.
 *
 * Completed and rejected envelopes are returned untouched: their fields are already stamped with the
 * format they were signed under, and there is nothing left to sign.
 *
 * @param settings - The merged organisation/team settings.
 * @param meta - The stored document meta.
 * @param status - The status of the envelope owning the meta.
 */
export const resolveLiveDocumentMeta = <T extends LiveResolvableMeta>(
  settings: SignatureSettings & Pick<OrganisationGlobalSettings, 'documentDateFormat'>,
  meta: T,
  status: DocumentStatus,
): T => {
  if (isDocumentCompleted(status)) {
    return meta;
  }

  return {
    ...capLiveDocumentMeta(settings, meta, status),
    dateFormat: resolveDateFormat(settings, meta),
  };
};

/**
 * Extracts the derived document meta which should be used when creating a document
 * from scratch, or from a template.
 *
 * Uses the following, the lower number overrides the higher number:
 * 1. Merged organisation/team settings
 * 2. Meta overrides
 *
 * @param settings - The merged organisation/team settings.
 * @param overrideMeta - The meta to override the settings with.
 * @returns The derived document meta.
 */
export const extractDerivedDocumentMeta = (
  settings: Omit<OrganisationGlobalSettings, 'id'>,
  overrideMeta: Partial<DocumentMeta> | undefined | null,
) => {
  const meta = overrideMeta ?? {};

  // Note: If you update this you will also need to update `create-document-from-template.ts`
  // since there is custom work there which allows 3 overrides.
  return {
    language: meta.language || settings.documentLanguage,
    timezone: meta.timezone || settings.documentTimezone || DEFAULT_DOCUMENT_TIME_ZONE,
    // Only pinned when explicitly chosen — null keeps inheriting the org/team format on read.
    dateFormat: meta.dateFormat || null,
    message: meta.message || null,
    subject: meta.subject || null,
    redirectUrl: meta.redirectUrl || null,

    signingOrder: meta.signingOrder || DocumentSigningOrder.PARALLEL,
    allowDictateNextSigner: meta.allowDictateNextSigner ?? false,
    nextFieldNavigationTypes: meta.nextFieldNavigationTypes ?? [],
    nextFieldNavigationLabels: meta.nextFieldNavigationLabels ?? [],
    distributionMethod: meta.distributionMethod || DocumentDistributionMethod.EMAIL, // Todo: Make this a setting.

    // Signature settings. The org/team allowance is a cap — the meta may only narrow it.
    ...capSignatureSettings(settings, meta),
    signatureFontFamily: meta.signatureFontFamily ?? settings.signatureFontFamily,
    signatureFontSize: meta.signatureFontSize ?? settings.signatureFontSize,

    // Email settings.
    emailId: meta.emailId ?? settings.emailId,
    emailReplyTo: meta.emailReplyTo ?? settings.emailReplyTo,
    emailSettings:
      meta.emailSettings || settings.emailDocumentSettings || DEFAULT_DOCUMENT_EMAIL_SETTINGS,

    // Envelope expiration.
    envelopeExpirationPeriod:
      meta.envelopeExpirationPeriod ?? settings.envelopeExpirationPeriod ?? null,
  } satisfies Omit<DocumentMeta, 'id'>;
};

/**
 * Map an envelope to a legacy document lite response entity.
 *
 * Do not use spread operator here to avoid unexpected behavior.
 */
export const mapEnvelopeToDocumentLite = (envelope: Envelope): TDocumentLite => {
  const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  return {
    id: documentId, // Use legacy ID.
    envelopeId: envelope.id,
    internalVersion: envelope.internalVersion,
    visibility: envelope.visibility,
    status: envelope.status,
    source: envelope.source,
    externalId: envelope.externalId,
    userId: envelope.userId,
    authOptions: envelope.authOptions,
    formValues: envelope.formValues,
    title: envelope.title,
    createdAt: envelope.createdAt,
    documentDataId: '', // Backwards compatibility.
    updatedAt: envelope.updatedAt,
    completedAt: envelope.completedAt,
    deletedAt: envelope.deletedAt,
    teamId: envelope.teamId,
    folderId: envelope.folderId,
    useLegacyFieldInsertion: envelope.useLegacyFieldInsertion,
    templateId: envelope.templateId,
  };
};

type MapEnvelopeToDocumentManyOptions = Envelope & {
  user: Pick<User, 'id' | 'name' | 'email'>;
  team: Pick<Team, 'id' | 'url'>;
  recipients: Recipient[];
};

/**
 * Map an envelope to a legacy document many response entity.
 *
 * Do not use spread operator here to avoid unexpected behavior.
 */
export const mapEnvelopesToDocumentMany = (
  envelope: MapEnvelopeToDocumentManyOptions,
): TDocumentMany => {
  const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  return {
    id: legacyDocumentId, // Use legacy ID.
    envelopeId: envelope.id,
    internalVersion: envelope.internalVersion,
    visibility: envelope.visibility,
    status: envelope.status,
    source: envelope.source,
    externalId: envelope.externalId,
    userId: envelope.userId,
    authOptions: envelope.authOptions,
    formValues: envelope.formValues,
    title: envelope.title,
    createdAt: envelope.createdAt,
    documentDataId: '', // Backwards compatibility.
    updatedAt: envelope.updatedAt,
    completedAt: envelope.completedAt,
    deletedAt: envelope.deletedAt,
    teamId: envelope.teamId,
    folderId: envelope.folderId,
    useLegacyFieldInsertion: envelope.useLegacyFieldInsertion,
    templateId: envelope.templateId,
    user: {
      id: envelope.userId,
      name: envelope.user.name,
      email: envelope.user.email,
    },
    team: {
      id: envelope.teamId,
      url: envelope.team.url,
    },
    recipients: envelope.recipients.map((recipient) =>
      mapRecipientToLegacyRecipient(recipient, envelope),
    ),
  };
};
