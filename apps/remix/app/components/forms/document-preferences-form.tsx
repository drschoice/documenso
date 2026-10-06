import { useCurrentOrganisation } from '@documenso/lib/client-only/providers/organisation';
import { useSession } from '@documenso/lib/client-only/providers/session';
import { IS_AI_FEATURES_CONFIGURED } from '@documenso/lib/constants/app';
import { DATE_FORMATS } from '@documenso/lib/constants/date-formats';
import { DOCUMENT_SIGNATURE_TYPES, DocumentSignatureType } from '@documenso/lib/constants/document';
import { isValidLanguageCode, SUPPORTED_LANGUAGE_CODES, SUPPORTED_LANGUAGES } from '@documenso/lib/constants/i18n';
import { TIME_ZONES } from '@documenso/lib/constants/time-zones';
import type { TDefaultRecipients } from '@documenso/lib/types/default-recipients';
import { ZDefaultRecipientsSchema } from '@documenso/lib/types/default-recipients';
import { type TDocumentMetaDateFormat, ZDocumentMetaDateFormatSchema } from '@documenso/lib/types/document-meta';
import { generateDefaultOrganisationSettings, isPersonalLayout } from '@documenso/lib/utils/organisations';
import { recipientAbbreviation } from '@documenso/lib/utils/recipient-formatter';
import { extractTeamSignatureSettings, generateDefaultTeamSettings } from '@documenso/lib/utils/teams';
import { DocumentSignatureSettingsTooltip } from '@documenso/ui/components/document/document-signature-settings-tooltip';
import { RecipientRoleSelect } from '@documenso/ui/components/recipient/recipient-role-select';
import { AvatarWithText } from '@documenso/ui/primitives/avatar';
import { Combobox } from '@documenso/ui/primitives/combobox';
import { Form, FormControl, FormDescription, FormField, FormMessage } from '@documenso/ui/primitives/form/form';
import { MultiSelectCombobox } from '@documenso/ui/primitives/multi-select-combobox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { zodResolver } from '@hookform/resolvers/zod';
import { msg, t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentVisibility, type RecipientRole, type TeamGlobalSettings, OrganisationType } from '@prisma/client';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { DocumentPreferencesResetDialog } from '~/components/dialogs/document-preferences-reset-dialog';
import { type TEnvelopeExpirationPeriod, ZEnvelopeExpirationPeriod } from '@documenso/lib/constants/envelope-expiration';
import { ExpirationPeriodPicker } from '@documenso/ui/components/document/expiration-period-picker';
import { Alert } from '@documenso/ui/primitives/alert';
import { Button } from '@documenso/ui/primitives/button';
import { Input } from '@documenso/ui/primitives/input';
import { useOptionalCurrentTeam } from '~/providers/team';
import { DefaultRecipientsMultiSelectCombobox } from '../general/default-recipients-multiselect-combobox';
import { FormStickySaveBar } from './form-sticky-save-bar';
import { DEFAULT_SIGNATURE_TEXT_FONT_SIZE } from '@documenso/lib/constants/pdf';
import {
  DEFAULT_SIGNATURE_FONT_FAMILY,
  MAX_SIGNATURE_FONT_SIZE,
  MIN_SIGNATURE_FONT_SIZE,
  SIGNATURE_FONTS,
  getSignatureFontFamilyString,
} from '@documenso/lib/constants/signature-fonts';

import { InheritableField } from './inheritable-field';

/**
 * Spelled out rather than derived from the Prisma enum object: this is a client component, and a
 * value import of `@prisma/client` does not survive into the browser bundle. `satisfies` keeps the
 * literals checked against the real enum, so adding or renaming a mode fails to compile here.
 */
/**
 * Can't infer this from the schema since we need to keep the schema inside the component to allow
 * it to be dynamic.
 */
export type TDocumentPreferencesFormSchema = {
  documentVisibility: DocumentVisibility | null;
  documentLanguage: (typeof SUPPORTED_LANGUAGE_CODES)[number] | null;
  documentTimezone: string | null;
  documentDateFormat: TDocumentMetaDateFormat | null;
  signatureTypes: DocumentSignatureType[];
  defaultRecipients: TDefaultRecipients | null;
  delegateDocumentOwnership: boolean | null;
  signatureFontFamily: string | null;
  signatureFontSize: number | null;
  aiFeaturesEnabled: boolean | null;
};

type SettingsSubset = Pick<
  TeamGlobalSettings,
  | 'documentVisibility'
  | 'documentLanguage'
  | 'documentTimezone'
  | 'documentDateFormat'
  | 'typedSignatureEnabled'
  | 'uploadSignatureEnabled'
  | 'drawSignatureEnabled'
  | 'defaultRecipients'
  | 'delegateDocumentOwnership'
  | 'signatureFontFamily'
  | 'signatureFontSize'
  | 'aiFeaturesEnabled'
>;

export type DocumentPreferencesFormProps = {
  settings: SettingsSubset;
  canInherit: boolean;
  onFormSubmit: (data: TDocumentPreferencesFormSchema) => Promise<void>;

  /**
   * The effective font this context would inherit when `signatureFontFamily` is null (i.e. the
   * organisation's resolved font for a team). Used to preview the "Inherit from organisation" choice
   * in the real inherited font rather than the hardcoded default.
   */
  inheritedFontFamily?: string | null;
  /**
   * The effective font size this context would inherit when `signatureFontSize` is null (i.e. the
   * organisation's resolved size for a team). Used as the placeholder/preview for the "inherit"
   * (blank) choice rather than the hardcoded default.
   */
  inheritedFontSize?: number | null;

  /**
   * The signature types the organisation permits. A team may only narrow this list further, so the
   * ones the organisation has revoked are not offered at all. Omit at organisation level, where
   * there is nothing above to cap against.
   */
  allowedSignatureTypes?: DocumentSignatureType[];
};

const getDocumentPreferencesFormValues = (settings: SettingsSubset): TDocumentPreferencesFormSchema => {
  const parsedDocumentDateFormat = ZDocumentMetaDateFormatSchema.safeParse(settings.documentDateFormat);

  return {
    documentVisibility: settings.documentVisibility,
    documentLanguage: isValidLanguageCode(settings.documentLanguage) ? settings.documentLanguage : null,
    documentTimezone: settings.documentTimezone,
    documentDateFormat: parsedDocumentDateFormat.success ? parsedDocumentDateFormat.data : null,
    signatureTypes: extractTeamSignatureSettings({ ...settings }),
    defaultRecipients: settings.defaultRecipients ? ZDefaultRecipientsSchema.parse(settings.defaultRecipients) : null,
    delegateDocumentOwnership: settings.delegateDocumentOwnership,
    signatureFontFamily: settings.signatureFontFamily ?? null,
    signatureFontSize: settings.signatureFontSize ?? null,
    aiFeaturesEnabled: settings.aiFeaturesEnabled,
  };
};

export const DocumentPreferencesForm = ({
  settings,
  onFormSubmit,
  canInherit,
  allowedSignatureTypes,
  inheritedFontFamily,
  inheritedFontSize,
}: DocumentPreferencesFormProps) => {
  const { _ } = useLingui();
  const { organisations } = useSession();
  const currentOrganisation = useCurrentOrganisation();
  const optionalTeam = useOptionalCurrentTeam();

  const isAiFeaturesConfigured = IS_AI_FEATURES_CONFIGURED();

  const isPersonalLayoutMode = isPersonalLayout(organisations);

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
    signatureTypes: z.array(z.nativeEnum(DocumentSignatureType)).min(canInherit ? 0 : 1, {
      message: msg`At least one signature type must be enabled`.id,
    }),
    defaultRecipients: ZDefaultRecipientsSchema.nullable(),
    delegateDocumentOwnership: z.boolean().nullable(),
    // Null = inherit from organisation (team only). The allowed values are validated server-side by
    // the tRPC input (`ZSignatureFontFamilySchema`); kept as a plain string here since the `Select`
    // only offers curated families.
    signatureFontFamily: z.string().nullable(),
    // Null = inherit from organisation (team only). Same bounds as the per-field `fieldMeta.fontSize`.
    signatureFontSize: z
      .number()
      .int()
      .min(MIN_SIGNATURE_FONT_SIZE)
      .max(MAX_SIGNATURE_FONT_SIZE)
      .nullable(),
    aiFeaturesEnabled: z.boolean().nullable(),
  });

  const defaultValues = getDocumentPreferencesFormValues(settings);
  const defaultSettings = canInherit ? generateDefaultTeamSettings() : generateDefaultOrganisationSettings();
  const baseResetValues = getDocumentPreferencesFormValues(defaultSettings);
  const resetValues = {
    ...baseResetValues,
    aiFeaturesEnabled: isAiFeaturesConfigured ? baseResetValues.aiFeaturesEnabled : defaultValues.aiFeaturesEnabled,
  };

  const { user } = useSession();

  const signaturePreviewName = user?.name?.trim() || t`Jane Doe`;

  const form = useForm<TDocumentPreferencesFormSchema>({
    defaultValues,
    resolver: zodResolver(ZDocumentPreferencesFormSchema),
  });

  const watchedSignatureFontFamily = form.watch('signatureFontFamily');
  const watchedSignatureFontSize = form.watch('signatureFontSize');

  // Resolve the values the signature preview should render with, applying the same inherit/default
  // fallbacks the server uses at document creation.
  const previewFontFamily = watchedSignatureFontFamily ?? inheritedFontFamily;
  const previewFontSize = watchedSignatureFontSize ?? inheritedFontSize ?? DEFAULT_SIGNATURE_TEXT_FONT_SIZE;

  // Parse both sides through the schema so we compare canonical representations
  const parsedCurrentValues = ZDocumentPreferencesFormSchema.safeParse(defaultValues);
  const parsedResetValues = ZDocumentPreferencesFormSchema.safeParse(resetValues);

  const isResetToDefaultsVisible =
    !parsedCurrentValues.success ||
    !parsedResetValues.success ||
    JSON.stringify(parsedCurrentValues.data) !== JSON.stringify(parsedResetValues.data);

  const handleResetToDefaults = async () => {
    await onFormSubmit(resetValues);
    form.reset(resetValues);
  };

  const handleFormSubmit = form.handleSubmit(async (data) => {
    try {
      await onFormSubmit(data);
    } catch {
      // The page handler surfaces its own error toast. Keep the form dirty so
      // the save bar stays visible and the user can retry.
      return;
    }

    form.reset(data);
  });
  return (
    <Form {...form}>
      <form onSubmit={handleFormSubmit}>
        <fieldset className="flex h-full flex-col gap-y-6" disabled={form.formState.isSubmitting}>
          {!isPersonalLayoutMode && (
            <FormField
              control={form.control}
              name="documentVisibility"
              render={({ field }) => (
                <InheritableField
                  className="flex-1"
                  canInherit={canInherit}
                  isInherited={field.value === null}
                  label={<Trans>Default Document Visibility</Trans>}
                  testId="document-visibility"
                >
                  <Select
                    {...field}
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
                </InheritableField>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="documentLanguage"
            render={({ field }) => (
              <InheritableField
                className="flex-1"
                canInherit={canInherit}
                isInherited={field.value === null}
                label={<Trans>Default Document Language</Trans>}
                testId="document-language"
              >
                <Select
                  {...field}
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
                    Controls the default language of an uploaded document. This will be used as the language in email
                    communications with the recipients.
                  </Trans>
                </FormDescription>
              </InheritableField>
            )}
          />

          <FormField
            control={form.control}
            name="documentDateFormat"
            render={({ field }) => (
              <InheritableField
                canInherit={canInherit}
                isInherited={field.value === null}
                label={<Trans>Default Date Format</Trans>}
                testId="document-date-format"
              >
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
              </InheritableField>
            )}
          />

          <FormField
            control={form.control}
            name="documentTimezone"
            render={({ field }) => (
              <InheritableField
                canInherit={canInherit}
                isInherited={field.value === null}
                label={<Trans>Default Time Zone</Trans>}
                testId="document-timezone"
              >
                <FormControl>
                  <Combobox
                    triggerPlaceholder={canInherit ? t`Inherit from organisation` : t`Local timezone`}
                    placeholder={t`Select a time zone`}
                    options={TIME_ZONES}
                    value={field.value}
                    onChange={(value) => field.onChange(value)}
                    testId="document-timezone-trigger"
                  />
                </FormControl>

                <FormMessage />
              </InheritableField>
            )}
          />

          <FormField
            control={form.control}
            name="signatureTypes"
            render={({ field }) => (
              <InheritableField
                className="flex-1"
                canInherit={canInherit}
                isInherited={canInherit && (field.value === null || field.value.length === 0)}
                label={
                  <span className="flex flex-row items-center">
                    <Trans>Default Signature Settings</Trans>
                    <DocumentSignatureSettingsTooltip />
                  </span>
                }
                testId="signature-types"
              >
                <FormControl>
                  <MultiSelectCombobox
                    options={Object.values(DOCUMENT_SIGNATURE_TYPES).map((option) => ({
                      label: _(option.label),
                      value: option.value,
                    }))}
                    selectedValues={field.value}
                    onChange={field.onChange}
                    className="w-full bg-background"
                    enableSearch={false}
                    emptySelectionPlaceholder={canInherit ? t`Inherit from organisation` : t`Select signature types`}
                    testId="signature-types-trigger"
                  />
                </FormControl>

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
              </InheritableField>
            )}
          />

          <FormField
            control={form.control}
            name="defaultRecipients"
            render={({ field }) => {
              const recipients = field.value ?? [];

              return (
                <InheritableField
                  className="flex-1"
                  canInherit={canInherit}
                  isInherited={field.value === null}
                  label={<Trans>Default Recipients</Trans>}
                  testId="default-recipients"
                >
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
                                <span className="font-medium text-sm">{recipient.name || recipient.email}</span>
                              }
                              secondaryText={
                                recipient.name ? (
                                  <span className="text-muted-foreground text-xs">{recipient.email}</span>
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
                </InheritableField>
              );
            }}
          />

          <FormField
            control={form.control}
            name="delegateDocumentOwnership"
            render={({ field }) => (
              <InheritableField
                className="flex-1"
                canInherit={canInherit}
                isInherited={field.value === null}
                label={<Trans>Delegate Document Ownership</Trans>}
                testId="delegate-document-ownership"
              >
                <Select
                  name={field.name}
                  value={field.value === null ? '-1' : field.value.toString()}
                  onValueChange={(value) => field.onChange(value === 'true' ? true : value === 'false' ? false : null)}
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
                  <Trans>Enable team API tokens to delegate document ownership to another team member.</Trans>
                </FormDescription>
              </InheritableField>
            )}
          />

          <FormField
            control={form.control}
            name="signatureFontFamily"
            render={({ field }) => (
              <InheritableField
                className="flex-1"
                canInherit={canInherit}
                isInherited={field.value === null}
                label={<Trans>Signature Font</Trans>}
                testId="signature-font-family"
              >
                <Select
                  value={field.value ?? (canInherit ? '-1' : DEFAULT_SIGNATURE_FONT_FAMILY)}
                  onValueChange={(value) => field.onChange(value === '-1' ? null : value)}
                >
                  <FormControl>
                    <SelectTrigger
                      className="bg-background"
                      data-testid="signature-font"
                      style={{ fontFamily: getSignatureFontFamilyString(field.value ?? inheritedFontFamily) }}
                    >
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>

                  <SelectContent className="z-[9999]">
                    {canInherit && (
                      <SelectItem value="-1">
                        <Trans>Inherit from organisation</Trans>
                      </SelectItem>
                    )}

                    {SIGNATURE_FONTS.map((signatureFont) => (
                      <SelectItem
                        key={signatureFont.family}
                        value={signatureFont.family}
                        className="text-xl"
                        style={{ fontFamily: `'${signatureFont.family}', ${signatureFont.cssFallback}` }}
                      >
                        {signatureFont.family}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="mt-2 flex h-24 items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
                  <span
                    className="text-black dark:text-white"
                    style={{
                      fontFamily: getSignatureFontFamilyString(previewFontFamily),
                      fontSize: `${previewFontSize}px`,
                      lineHeight: 1,
                    }}
                  >
                    {signaturePreviewName}
                  </span>
                </div>

                <FormDescription>
                  <Trans>
                    The font used for typed signatures. Applies to documents created after this change - already-created
                    documents keep their original font.
                  </Trans>
                </FormDescription>
              </InheritableField>
            )}
          />

          <FormField
            control={form.control}
            name="signatureFontSize"
            render={({ field }) => (
              <InheritableField
                className="flex-1"
                canInherit={canInherit}
                isInherited={field.value === null}
                label={<Trans>Signature Font Size</Trans>}
                testId="signature-font-size-field"
              >
                <FormControl>
                  <Input
                    type="number"
                    min={MIN_SIGNATURE_FONT_SIZE}
                    max={MAX_SIGNATURE_FONT_SIZE}
                    className="bg-background"
                    data-testid="signature-font-size"
                    placeholder={
                      canInherit ? (inheritedFontSize ?? DEFAULT_SIGNATURE_TEXT_FONT_SIZE).toString() : undefined
                    }
                    value={field.value ?? ''}
                    onChange={(e) => field.onChange(e.target.value === '' ? null : e.target.valueAsNumber)}
                  />
                </FormControl>

                <FormDescription>
                  <Trans>
                    The default size (in pixels, {MIN_SIGNATURE_FONT_SIZE}-{MAX_SIGNATURE_FONT_SIZE}) for typed
                    signatures. A per-field size set in the editor overrides this. Applies to documents created after
                    this change.
                  </Trans>
                </FormDescription>
              </InheritableField>
            )}
          />

          {isAiFeaturesConfigured && (
            <FormField
              control={form.control}
              name="aiFeaturesEnabled"
              render={({ field }) => (
                <InheritableField
                  className="flex-1"
                  canInherit={canInherit}
                  isInherited={field.value === null}
                  label={<Trans>AI Features</Trans>}
                  testId="ai-features-enabled"
                >
                  <Select
                    {...field}
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
                      Enable AI-powered features such as automatic recipient detection. When enabled, document content
                      will be sent to AI providers. We only use providers that do not retain data for training and
                      prefer European regions where available.
                    </Trans>
                  </FormDescription>
                </InheritableField>
              )}
            />
          )}

          <FormStickySaveBar
            isDirty={form.formState.isDirty}
            isSubmitting={form.formState.isSubmitting}
            onReset={() => form.reset()}
            resetToDefaults={
              isResetToDefaultsVisible ? (
                <DocumentPreferencesResetDialog
                  isSubmitting={form.formState.isSubmitting}
                  onReset={handleResetToDefaults}
                  showAiFeatures={isAiFeaturesConfigured}
                  showDocumentVisibility={!isPersonalLayoutMode}
                />
              ) : undefined
            }
          />
        </fieldset>
      </form>
    </Form>
  );
};
