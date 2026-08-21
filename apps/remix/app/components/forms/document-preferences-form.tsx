import { zodResolver } from '@hookform/resolvers/zod';
import { msg, t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { EmailSenderNameMode, TeamGlobalSettings } from '@prisma/client';
import { DocumentVisibility, OrganisationType, type RecipientRole } from '@prisma/client';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { useCurrentOrganisation } from '@documenso/lib/client-only/providers/organisation';
import { useSession } from '@documenso/lib/client-only/providers/session';
import { DATE_FORMATS } from '@documenso/lib/constants/date-formats';
import { DOCUMENT_SIGNATURE_TYPES, DocumentSignatureType } from '@documenso/lib/constants/document';
import {
  type TEnvelopeExpirationPeriod,
  ZEnvelopeExpirationPeriod,
} from '@documenso/lib/constants/envelope-expiration';
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGE_CODES,
  isValidLanguageCode,
} from '@documenso/lib/constants/i18n';
import { TIME_ZONES } from '@documenso/lib/constants/time-zones';
import type { TDefaultRecipients } from '@documenso/lib/types/default-recipients';
import { ZDefaultRecipientsSchema } from '@documenso/lib/types/default-recipients';
import {
  type TDocumentMetaDateFormat,
  ZDocumentMetaDateFormatSchema,
} from '@documenso/lib/types/document-meta';
import { resolveEmailSenderName } from '@documenso/lib/utils/email-sender-name';
import { isPersonalLayout } from '@documenso/lib/utils/organisations';
import { recipientAbbreviation } from '@documenso/lib/utils/recipient-formatter';
import { extractTeamSignatureSettings } from '@documenso/lib/utils/teams';
import { DocumentSignatureSettingsTooltip } from '@documenso/ui/components/document/document-signature-settings-tooltip';
import { ExpirationPeriodPicker } from '@documenso/ui/components/document/expiration-period-picker';
import { RecipientRoleSelect } from '@documenso/ui/components/recipient/recipient-role-select';
import { Alert } from '@documenso/ui/primitives/alert';
import { AvatarWithText } from '@documenso/ui/primitives/avatar';
import { Button } from '@documenso/ui/primitives/button';
import { Combobox } from '@documenso/ui/primitives/combobox';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { MultiSelectCombobox } from '@documenso/ui/primitives/multi-select-combobox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@documenso/ui/primitives/select';

import { useOptionalCurrentTeam } from '~/providers/team';

import { DefaultRecipientsMultiSelectCombobox } from '../general/default-recipients-multiselect-combobox';

/**
 * Spelled out rather than derived from the Prisma enum object: this is a client component, and a
 * value import of `@prisma/client` does not survive into the browser bundle. `satisfies` keeps the
 * literals checked against the real enum, so adding or renaming a mode fails to compile here.
 */
const EMAIL_SENDER_NAME_MODES = [
  'ORGANISATION',
  'TEAM',
  'CUSTOM',
] as const satisfies readonly EmailSenderNameMode[];

/**
 * Can't infer this from the schema since we need to keep the schema inside the component to allow
 * it to be dynamic.
 */
export type TDocumentPreferencesFormSchema = {
  documentVisibility: DocumentVisibility | null;
  documentLanguage: (typeof SUPPORTED_LANGUAGE_CODES)[number] | null;
  documentTimezone: string | null;
  documentDateFormat: TDocumentMetaDateFormat | null;
  includeSenderDetails: boolean | null;
  emailSenderNameMode: EmailSenderNameMode | null;
  emailSenderNameCustom: string;
  includeSigningCertificate: boolean | null;
  includeAuditLog: boolean | null;
  signatureTypes: DocumentSignatureType[];
  defaultRecipients: TDefaultRecipients | null;
  delegateDocumentOwnership: boolean | null;
  aiFeaturesEnabled: boolean | null;
  envelopeExpirationPeriod: TEnvelopeExpirationPeriod | null;
};

type SettingsSubset = Pick<
  TeamGlobalSettings,
  | 'documentVisibility'
  | 'documentLanguage'
  | 'documentTimezone'
  | 'documentDateFormat'
  | 'includeSenderDetails'
  | 'emailSenderNameMode'
  | 'emailSenderNameCustom'
  | 'includeSigningCertificate'
  | 'includeAuditLog'
  | 'typedSignatureEnabled'
  | 'uploadSignatureEnabled'
  | 'drawSignatureEnabled'
  | 'defaultRecipients'
  | 'delegateDocumentOwnership'
  | 'aiFeaturesEnabled'
  | 'envelopeExpirationPeriod'
>;

export type DocumentPreferencesFormProps = {
  settings: SettingsSubset;
  canInherit: boolean;
  isAiFeaturesConfigured?: boolean;

  /**
   * The signature types the organisation permits. A team may only narrow this list further, so the
   * ones the organisation has revoked are not offered at all. Omit at organisation level, where
   * there is nothing above to cap against.
   */
  allowedSignatureTypes?: DocumentSignatureType[];

  /**
   * The sender name this context would fall back to when `emailSenderNameMode` is null (i.e. the
   * organisation's resolved name for a team). Used so the preview shows the real inherited name
   * rather than guessing. Omit at organisation level, which has nothing to inherit.
   */
  inheritedSenderName?: string;
  onFormSubmit: (data: TDocumentPreferencesFormSchema) => Promise<void>;
};

export const DocumentPreferencesForm = ({
  settings,
  onFormSubmit,
  canInherit,
  isAiFeaturesConfigured = false,
  allowedSignatureTypes,
  inheritedSenderName,
}: DocumentPreferencesFormProps) => {
  const { _ } = useLingui();
  const { user, organisations } = useSession();
  const currentOrganisation = useCurrentOrganisation();
  const optionalTeam = useOptionalCurrentTeam();

  const isPersonalLayoutMode = isPersonalLayout(organisations);
  const isPersonalOrganisation = currentOrganisation.type === OrganisationType.PERSONAL;

  const placeholderEmail = user.email ?? 'user@example.com';

  const signatureTypeOptions = Object.values(DOCUMENT_SIGNATURE_TYPES).filter(
    (option) => !allowedSignatureTypes || allowedSignatureTypes.includes(option.value),
  );

  const hasRestrictedSignatureTypes =
    signatureTypeOptions.length < Object.values(DOCUMENT_SIGNATURE_TYPES).length;

  const ZDocumentPreferencesFormSchema = z.object({
    documentVisibility: z.nativeEnum(DocumentVisibility).nullable(),
    documentLanguage: z.enum(SUPPORTED_LANGUAGE_CODES).nullable(),
    documentTimezone: z.string().nullable(),
    documentDateFormat: ZDocumentMetaDateFormatSchema.nullable(),
    includeSenderDetails: z.boolean().nullable(),
    emailSenderNameMode: z.enum(EMAIL_SENDER_NAME_MODES).nullable(),
    emailSenderNameCustom: z.string().max(200),
    includeSigningCertificate: z.boolean().nullable(),
    includeAuditLog: z.boolean().nullable(),
    signatureTypes: z.array(z.nativeEnum(DocumentSignatureType)).min(canInherit ? 0 : 1, {
      message: msg`At least one signature type must be enabled`.id,
    }),
    defaultRecipients: ZDefaultRecipientsSchema.nullable(),
    delegateDocumentOwnership: z.boolean().nullable(),
    aiFeaturesEnabled: z.boolean().nullable(),
    envelopeExpirationPeriod: ZEnvelopeExpirationPeriod.nullable(),
  });

  const form = useForm<TDocumentPreferencesFormSchema>({
    defaultValues: {
      documentVisibility: settings.documentVisibility,
      documentLanguage: isValidLanguageCode(settings.documentLanguage)
        ? settings.documentLanguage
        : null,
      documentTimezone: settings.documentTimezone,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      documentDateFormat: settings.documentDateFormat as TDocumentMetaDateFormat | null,
      includeSenderDetails: settings.includeSenderDetails,
      emailSenderNameMode: settings.emailSenderNameMode ?? null,
      emailSenderNameCustom: settings.emailSenderNameCustom ?? '',
      includeSigningCertificate: settings.includeSigningCertificate,
      includeAuditLog: settings.includeAuditLog,
      // Filtered so a selection stored before the organisation revoked a type is not resubmitted.
      signatureTypes: extractTeamSignatureSettings({ ...settings }).filter(
        (type) => !allowedSignatureTypes || allowedSignatureTypes.includes(type),
      ),
      defaultRecipients: settings.defaultRecipients
        ? ZDefaultRecipientsSchema.parse(settings.defaultRecipients)
        : null,
      delegateDocumentOwnership: settings.delegateDocumentOwnership,
      aiFeaturesEnabled: settings.aiFeaturesEnabled,
      envelopeExpirationPeriod: settings.envelopeExpirationPeriod ?? null,
    },
    resolver: zodResolver(ZDocumentPreferencesFormSchema),
  });

  const watchedSenderNameMode = form.watch('emailSenderNameMode');
  const watchedSenderNameCustom = form.watch('emailSenderNameCustom');

  // At organisation level there is no single team to name — each team resolves its own — so the
  // preview keeps an illustrative placeholder rather than implying the organisation name is used.
  const previewTeamName = optionalTeam?.name ?? t`Team Name`;

  // Resolved with the same helper the senders use, so the preview cannot drift from the real email.
  // A null mode means "inherit", which is what the organisation would resolve to.
  const previewSenderName =
    watchedSenderNameMode === null
      ? (inheritedSenderName ?? currentOrganisation.name)
      : resolveEmailSenderName({
          settings: {
            emailSenderNameMode: watchedSenderNameMode,
            emailSenderNameCustom: watchedSenderNameCustom,
          },
          organisationName: currentOrganisation.name,
          teamName: previewTeamName,
        });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onFormSubmit)}>
        <fieldset
          className="flex h-full max-w-2xl flex-col gap-y-6"
          disabled={form.formState.isSubmitting}
        >
          {!isPersonalLayoutMode && (
            <FormField
              control={form.control}
              name="documentVisibility"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormLabel>
                    <Trans>Default Document Visibility</Trans>
                  </FormLabel>

                  <Select
                    name={field.name}
                    value={field.value === null ? '-1' : field.value}
                    onValueChange={(value) => field.onChange(value === '-1' ? null : value)}
                  >
                    <FormControl>
                      <SelectTrigger
                        className="bg-background text-muted-foreground"
                        data-testid="document-visibility-trigger"
                      >
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>

                    <SelectContent>
                      <SelectItem value={DocumentVisibility.EVERYONE}>
                        <Trans>Everyone can access and view the document</Trans>
                      </SelectItem>
                      <SelectItem value={DocumentVisibility.MANAGER_AND_ABOVE}>
                        <Trans>Only managers and above can access and view the document</Trans>
                      </SelectItem>
                      <SelectItem value={DocumentVisibility.ADMIN}>
                        <Trans>Only admins can access and view the document</Trans>
                      </SelectItem>

                      {canInherit && (
                        <SelectItem value={'-1'}>
                          <Trans>Inherit from organisation</Trans>
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>

                  <FormDescription>
                    <Trans>Controls the default visibility of an uploaded document.</Trans>
                  </FormDescription>
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="documentLanguage"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>
                  <Trans>Default Document Language</Trans>
                </FormLabel>

                <Select
                  name={field.name}
                  value={field.value === null ? '-1' : field.value}
                  onValueChange={(value) => field.onChange(value === '-1' ? null : value)}
                >
                  <FormControl>
                    <SelectTrigger
                      className="bg-background text-muted-foreground"
                      data-testid="document-language-trigger"
                    >
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>

                  <SelectContent>
                    {Object.entries(SUPPORTED_LANGUAGES).map(([code, language]) => (
                      <SelectItem key={code} value={code}>
                        {_(language.full)}
                      </SelectItem>
                    ))}

                    <SelectItem value={'-1'}>
                      <Trans>Inherit from organisation</Trans>
                    </SelectItem>
                  </SelectContent>
                </Select>

                <FormDescription>
                  <Trans>
                    Controls the default language of an uploaded document. This will be used as the
                    language in email communications with the recipients.
                  </Trans>
                </FormDescription>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="documentDateFormat"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Default Date Format</Trans>
                </FormLabel>

                <Select
                  value={field.value === null ? '-1' : field.value}
                  onValueChange={(value) => field.onChange(value === '-1' ? null : value)}
                >
                  <FormControl>
                    <SelectTrigger data-testid="document-date-format-trigger">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>

                  <SelectContent>
                    {DATE_FORMATS.map((format) => (
                      <SelectItem key={format.key} value={format.value}>
                        {format.label}
                      </SelectItem>
                    ))}

                    {canInherit && (
                      <SelectItem value={'-1'}>
                        <Trans>Inherit from organisation</Trans>
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>

                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="documentTimezone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Default Time Zone</Trans>
                </FormLabel>

                <Combobox
                  triggerPlaceholder={canInherit ? t`Inherit from organisation` : t`Local timezone`}
                  placeholder={t`Select a time zone`}
                  options={TIME_ZONES}
                  value={field.value}
                  onChange={(value) => field.onChange(value)}
                  testId="document-timezone-trigger"
                />

                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="signatureTypes"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel className="flex flex-row items-center">
                  <Trans>Default Signature Settings</Trans>
                  <DocumentSignatureSettingsTooltip />
                </FormLabel>

                <MultiSelectCombobox
                  options={signatureTypeOptions.map((option) => ({
                    label: _(option.label),
                    value: option.value,
                  }))}
                  selectedValues={field.value}
                  onChange={field.onChange}
                  className="w-full bg-background"
                  enableSearch={false}
                  emptySelectionPlaceholder={
                    canInherit ? t`Inherit from organisation` : t`Select signature types`
                  }
                  testId="signature-types-trigger"
                />

                {form.formState.errors.signatureTypes ? (
                  <FormMessage />
                ) : (
                  <FormDescription>
                    {hasRestrictedSignatureTypes ? (
                      <Trans>
                        Controls which signatures are allowed to be used when signing a document.
                        Your organisation has disabled the remaining types.
                      </Trans>
                    ) : (
                      <Trans>
                        Controls which signatures are allowed to be used when signing a document.
                      </Trans>
                    )}
                  </FormDescription>
                )}
              </FormItem>
            )}
          />

          {!isPersonalLayoutMode && !isPersonalOrganisation && (
            <FormField
              control={form.control}
              name="emailSenderNameMode"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormLabel>
                    <Trans>Email Sender Name</Trans>
                  </FormLabel>

                  <Select
                    value={field.value === null ? '-1' : field.value}
                    // Matching against the real modes avoids a type assertion, and the "inherit"
                    // sentinel simply matches nothing and falls through to null.
                    onValueChange={(value) =>
                      field.onChange(EMAIL_SENDER_NAME_MODES.find((mode) => mode === value) ?? null)
                    }
                  >
                    <FormControl>
                      <SelectTrigger
                        className="bg-background text-muted-foreground"
                        data-testid="email-sender-name-mode-trigger"
                      >
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>

                    <SelectContent>
                      <SelectItem value={'ORGANISATION'}>
                        <Trans>Organisation name</Trans>
                      </SelectItem>

                      <SelectItem value={'TEAM'}>
                        <Trans>Team name</Trans>
                      </SelectItem>

                      <SelectItem value={'CUSTOM'}>
                        <Trans>Custom</Trans>
                      </SelectItem>

                      {canInherit && (
                        <SelectItem value={'-1'}>
                          <Trans>Inherit from organisation</Trans>
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>

                  <FormDescription>
                    <Trans>
                      The name recipients see in emails about your documents. Applies whether or not
                      branding is enabled.
                    </Trans>
                  </FormDescription>
                </FormItem>
              )}
            />
          )}

          {!isPersonalLayoutMode &&
            !isPersonalOrganisation &&
            watchedSenderNameMode === 'CUSTOM' && (
              <FormField
                control={form.control}
                name="emailSenderNameCustom"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel required>
                      <Trans>Custom Sender Name</Trans>
                    </FormLabel>

                    <FormControl>
                      <Input className="bg-background" {...field} />
                    </FormControl>

                    <FormDescription>
                      <Trans>Leave blank to fall back to the team name. Available variables:</Trans>{' '}
                      <code className="rounded bg-muted-foreground/20 p-1 text-xs">
                        {'{organisation.name}'}
                      </code>{' '}
                      <code className="rounded bg-muted-foreground/20 p-1 text-xs">
                        {'{team.name}'}
                      </code>
                    </FormDescription>

                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

          {!isPersonalLayoutMode && !isPersonalOrganisation && (
            <FormField
              control={form.control}
              name="includeSenderDetails"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormLabel>
                    <Trans>Send on Behalf of Team</Trans>
                  </FormLabel>

                  <Select
                    name={field.name}
                    value={field.value === null ? '-1' : field.value.toString()}
                    onValueChange={(value) =>
                      field.onChange(value === 'true' ? true : value === 'false' ? false : null)
                    }
                  >
                    <FormControl>
                      <SelectTrigger
                        className="bg-background text-muted-foreground"
                        data-testid="include-sender-details-trigger"
                      >
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>

                    <SelectContent>
                      <SelectItem value="true">
                        <Trans>Yes</Trans>
                      </SelectItem>

                      <SelectItem value="false">
                        <Trans>No</Trans>
                      </SelectItem>

                      {canInherit && (
                        <SelectItem value={'-1'}>
                          <Trans>Inherit from organisation</Trans>
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>

                  <div className="pt-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      <Trans>Preview</Trans>
                    </div>

                    <Alert variant="neutral" className="mt-1 px-2.5 py-1.5 text-sm">
                      {field.value ? (
                        <Trans>
                          "{placeholderEmail}" on behalf of "{previewSenderName}" has invited you to
                          sign "example document".
                        </Trans>
                      ) : (
                        <Trans>
                          "{previewSenderName}" has invited you to sign "example document".
                        </Trans>
                      )}
                    </Alert>
                  </div>

                  <FormDescription>
                    <Trans>
                      Controls whether the individual sender's name appears alongside the email
                      sender name when inviting a recipient to sign a document.
                    </Trans>
                  </FormDescription>
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="includeSigningCertificate"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>
                  <Trans>Include the Signing Certificate in the Document</Trans>
                </FormLabel>

                <Select
                  name={field.name}
                  value={field.value === null ? '-1' : field.value.toString()}
                  onValueChange={(value) =>
                    field.onChange(value === 'true' ? true : value === 'false' ? false : null)
                  }
                >
                  <FormControl>
                    <SelectTrigger
                      className="bg-background text-muted-foreground"
                      data-testid="include-signing-certificate-trigger"
                    >
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>

                  <SelectContent>
                    <SelectItem value="true">
                      <Trans>Yes</Trans>
                    </SelectItem>

                    <SelectItem value="false">
                      <Trans>No</Trans>
                    </SelectItem>

                    {canInherit && (
                      <SelectItem value={'-1'}>
                        <Trans>Inherit from organisation</Trans>
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>

                <FormDescription>
                  <Trans>
                    Controls whether the signing certificate will be included in the document when
                    it is downloaded. The signing certificate can still be downloaded from the logs
                    page separately.
                  </Trans>
                </FormDescription>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="includeAuditLog"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>
                  <Trans>Include the Audit Logs in the Document</Trans>
                </FormLabel>

                <Select
                  name={field.name}
                  value={field.value === null ? '-1' : field.value.toString()}
                  onValueChange={(value) =>
                    field.onChange(value === 'true' ? true : value === 'false' ? false : null)
                  }
                >
                  <FormControl>
                    <SelectTrigger className="bg-background text-muted-foreground">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>

                  <SelectContent>
                    <SelectItem value="true">
                      <Trans>Yes</Trans>
                    </SelectItem>

                    <SelectItem value="false">
                      <Trans>No</Trans>
                    </SelectItem>

                    {canInherit && (
                      <SelectItem value={'-1'}>
                        <Trans>Inherit from organisation</Trans>
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>

                <FormDescription>
                  <Trans>
                    Controls whether the audit logs will be included in the document when it is
                    downloaded. The audit logs can still be downloaded from the logs page
                    separately.
                  </Trans>
                </FormDescription>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="defaultRecipients"
            render={({ field }) => {
              const recipients = field.value ?? [];

              return (
                <FormItem className="flex-1">
                  <FormLabel>
                    <Trans>Default Recipients</Trans>
                  </FormLabel>

                  {canInherit && (
                    <Select
                      value={field.value === null ? '-1' : '0'}
                      onValueChange={(value) => field.onChange(value === '-1' ? null : [])}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={'-1'}>
                          <Trans>Inherit from organisation</Trans>
                        </SelectItem>
                        <SelectItem value={'0'}>
                          <Trans>Override organisation settings</Trans>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}

                  {(field.value !== null || !canInherit) && (
                    <div className="space-y-4">
                      <DefaultRecipientsMultiSelectCombobox
                        listValues={recipients}
                        onChange={field.onChange}
                        organisationId={!canInherit ? currentOrganisation.id : undefined}
                        teamId={canInherit ? optionalTeam?.id : undefined}
                      />

                      {recipients.map((recipient, index) => {
                        return (
                          <div
                            key={recipient.email}
                            className="flex items-center justify-between gap-3 rounded-lg border p-3"
                          >
                            <AvatarWithText
                              avatarFallback={recipientAbbreviation(recipient)}
                              primaryText={
                                <span className="text-sm font-medium">
                                  {recipient.name || recipient.email}
                                </span>
                              }
                              secondaryText={
                                recipient.name ? (
                                  <span className="text-xs text-muted-foreground">
                                    {recipient.email}
                                  </span>
                                ) : undefined
                              }
                              className="flex-1"
                            />
                            <div className="flex items-center gap-2">
                              <RecipientRoleSelect
                                value={recipient.role}
                                onValueChange={(role: RecipientRole) => {
                                  field.onChange(
                                    recipients.map((recipient, idx) =>
                                      idx === index ? { ...recipient, role } : recipient,
                                    ),
                                  );
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <FormDescription>
                    <Trans>Recipients that will be automatically added to new documents.</Trans>
                  </FormDescription>
                </FormItem>
              );
            }}
          />

          <FormField
            control={form.control}
            name="delegateDocumentOwnership"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>
                  <Trans>Delegate Document Ownership</Trans>
                </FormLabel>

                <Select
                  name={field.name}
                  value={field.value === null ? '-1' : field.value.toString()}
                  onValueChange={(value) =>
                    field.onChange(value === 'true' ? true : value === 'false' ? false : null)
                  }
                >
                  <FormControl>
                    <SelectTrigger className="bg-background text-muted-foreground">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>

                  <SelectContent>
                    <SelectItem value="true">
                      <Trans>Yes</Trans>
                    </SelectItem>

                    <SelectItem value="false">
                      <Trans>No</Trans>
                    </SelectItem>

                    {canInherit && (
                      <SelectItem value={'-1'}>
                        <Trans>Inherit from organisation</Trans>
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>

                <FormDescription>
                  <Trans>
                    Enable team API tokens to delegate document ownership to another team member.
                  </Trans>
                </FormDescription>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="envelopeExpirationPeriod"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>
                  <Trans>Default Envelope Expiration</Trans>
                </FormLabel>

                <ExpirationPeriodPicker
                  value={field.value}
                  onChange={field.onChange}
                  inheritLabel={canInherit ? t`Inherit from organisation` : undefined}
                />

                <FormDescription>
                  <Trans>
                    Controls how long recipients have to complete signing before the document
                    expires. After expiration, recipients can no longer sign the document.
                  </Trans>
                </FormDescription>

                <FormMessage />
              </FormItem>
            )}
          />

          {isAiFeaturesConfigured && (
            <FormField
              control={form.control}
              name="aiFeaturesEnabled"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormLabel>
                    <Trans>AI Features</Trans>
                  </FormLabel>

                  <Select
                    name={field.name}
                    value={field.value === null ? '-1' : field.value.toString()}
                    onValueChange={(value) =>
                      field.onChange(value === 'true' ? true : value === 'false' ? false : null)
                    }
                  >
                    <FormControl>
                      <SelectTrigger className="bg-background text-muted-foreground">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>

                    <SelectContent>
                      <SelectItem value="true">
                        <Trans>Enabled</Trans>
                      </SelectItem>

                      <SelectItem value="false">
                        <Trans>Disabled</Trans>
                      </SelectItem>

                      {canInherit && (
                        <SelectItem value={'-1'}>
                          <Trans>Inherit from organisation</Trans>
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>

                  <FormDescription>
                    <Trans>
                      Enable AI-powered features such as automatic recipient detection. When
                      enabled, document content will be sent to AI providers. We only use providers
                      that do not retain data for training and prefer European regions where
                      available.
                    </Trans>
                  </FormDescription>
                </FormItem>
              )}
            />
          )}

          <div className="flex flex-row justify-end space-x-4">
            <Button type="submit" loading={form.formState.isSubmitting}>
              <Trans>Update</Trans>
            </Button>
          </div>
        </fieldset>
      </form>
    </Form>
  );
};
