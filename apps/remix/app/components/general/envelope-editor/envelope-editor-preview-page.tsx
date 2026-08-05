import { useEffect, useMemo, useRef, useState } from 'react';

import { Trans } from '@lingui/react/macro';
import { FieldType, SigningStatus } from '@prisma/client';
import { FileTextIcon } from 'lucide-react';
import { match } from 'ts-pattern';

import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import {
  EnvelopeRenderProvider,
  useCurrentEnvelopeRender,
} from '@documenso/lib/client-only/providers/envelope-render-provider';
import { PDF_VIEWER_ERROR_MESSAGES } from '@documenso/lib/constants/pdf-viewer-i18n';
import { ZDateFieldMeta, ZFieldAndMetaSchema } from '@documenso/lib/types/field-meta';
import { evaluateAllVisibility } from '@documenso/lib/universal/field-visibility';
import { extractFieldInsertionValues } from '@documenso/lib/utils/envelope-signing';
import { toCheckboxCustomText } from '@documenso/lib/utils/fields';
import { extractInitials } from '@documenso/lib/utils/recipient-formatter';
import { AnimateGenericFadeInOut } from '@documenso/ui/components/animate/animate-generic-fade-in-out';
import { Alert, AlertDescription, AlertTitle } from '@documenso/ui/primitives/alert';
import { RecipientSelector } from '@documenso/ui/primitives/recipient-selector';
import { Separator } from '@documenso/ui/primitives/separator';

import { EnvelopeGenericPageRenderer } from '~/components/general/envelope-editor/envelope-generic-page-renderer';
import { EnvelopePdfViewer } from '~/components/general/pdf-viewer/envelope-pdf-viewer';

import { EnvelopeRendererFileSelector } from './envelope-file-selector';

export const EnvelopeEditorPreviewPage = () => {
  const { envelope, editorFields, editorConfig } = useCurrentEnvelopeEditor();

  const { currentEnvelopeItem, fields } = useCurrentEnvelopeRender();

  const scrollableContainerRef = useRef<HTMLDivElement>(null);

  const [selectedPreviewMode, setSelectedPreviewMode] = useState<'recipient' | 'signed'>(
    'recipient',
  );

  /**
   * Build the fields shown in the preview using only their real *default* values —
   * default text/number, default-checked checkbox/radio, default dropdown value, the
   * date default, and the recipient's real name/email/initials/signature.
   *
   * Fields with no default are left empty and flagged `inserted: false`, so the
   * export-mode renderer draws them blank (no random placeholder data).
   */
  const fieldsWithPlaceholders = useMemo(() => {
    return fields.map((field) => {
      const fieldMeta = ZFieldAndMetaSchema.parse(field);

      const recipient = envelope.recipients.find((recipient) => recipient.id === field.recipientId);

      if (!recipient) {
        throw new Error('Recipient not found');
      }

      const recipientName = recipient.name ?? '';
      const recipientEmail = recipient.email ?? '';

      const overrides = match(fieldMeta)
        .with({ type: FieldType.TEXT }, ({ fieldMeta }) => {
          let text = fieldMeta?.text ?? '';

          if (fieldMeta?.characterLimit) {
            text = text.slice(0, fieldMeta.characterLimit);
          }

          return { customText: text, inserted: text !== '' };
        })
        .with({ type: FieldType.NUMBER }, ({ fieldMeta }) => {
          const number = fieldMeta?.value ?? '';

          return { customText: number, inserted: number !== '' };
        })
        .with({ type: FieldType.DATE }, (parsedFieldMeta) => {
          const dateMeta = ZDateFieldMeta.safeParse(parsedFieldMeta.fieldMeta);

          if (!dateMeta.success || !dateMeta.data.value) {
            return { customText: '', inserted: false };
          }

          const date = extractFieldInsertionValues({
            fieldValue: {
              type: FieldType.DATE,
              value: dateMeta.data.value,
            },
            field,
            documentMeta: envelope.documentMeta,
          });

          return { customText: date.customText, inserted: date.customText !== '' };
        })
        .with({ type: FieldType.EMAIL }, () => {
          return { customText: recipientEmail, inserted: recipientEmail !== '' };
        })
        .with({ type: FieldType.NAME }, () => {
          return { customText: recipientName, inserted: recipientName !== '' };
        })
        .with({ type: FieldType.INITIALS }, () => {
          const initials = recipientName ? extractInitials(recipientName) : '';

          return { customText: initials, inserted: initials !== '' };
        })
        .with({ type: FieldType.RADIO }, ({ fieldMeta }) => {
          const values = fieldMeta?.values ?? [];
          const preselectedValue = values.findIndex((value) => value.checked);

          if (preselectedValue === -1) {
            return { customText: '', inserted: false };
          }

          return { customText: preselectedValue.toString(), inserted: true };
        })
        .with({ type: FieldType.CHECKBOX }, ({ fieldMeta }) => {
          const values = fieldMeta?.values ?? [];

          const checkedValues: number[] = [];

          values.forEach((value, index) => {
            if (value.checked) {
              checkedValues.push(index);
            }
          });

          if (checkedValues.length === 0) {
            return { customText: '', inserted: false };
          }

          return { customText: toCheckboxCustomText(checkedValues), inserted: true };
        })
        .with({ type: FieldType.DROPDOWN }, ({ fieldMeta }) => {
          const customText = fieldMeta?.defaultValue ?? '';

          return { customText, inserted: customText !== '' };
        })
        .with({ type: FieldType.SIGNATURE }, () => {
          return {
            customText: '',
            inserted: recipientName !== '',
            signature: {
              signatureImageAsBase64: '',
              typedSignature: recipientName,
            },
          };
        })
        .with({ type: FieldType.FREE_SIGNATURE }, () => {
          return { customText: '', inserted: false };
        })
        .exhaustive();

      return {
        ...field,
        ...overrides,
      };
    });
  }, [fields, envelope, envelope.recipients, envelope.documentMeta]);

  /**
   * Apply conditional-visibility to the placeholder data so the preview reflects
   * what a recipient actually sees: fields whose rule isn't met by the
   * placeholder trigger value are hidden, just like at signing time.
   */
  const visibleFields = useMemo(() => {
    if (fieldsWithPlaceholders.length === 0) {
      return fieldsWithPlaceholders;
    }

    const visibility = evaluateAllVisibility(
      fieldsWithPlaceholders.map((field) => ({
        id: field.id,
        type: field.type,
        customText: typeof field.customText === 'string' ? field.customText : '',
        inserted: field.inserted,
        fieldMeta: field.fieldMeta,
      })),
    );

    return (
      fieldsWithPlaceholders
        .filter((field) => visibility.get(field.id) !== false)
        // Checkbox/radio always render in the preview (even when nothing is checked) so
        // recipients see the empty options. The generic renderer drops non-inserted fields
        // for signed recipients, so flag these inserted here. This is applied AFTER visibility
        // evaluation so conditional-visibility (which reads the real `inserted`) stays correct.
        .map((field) =>
          field.type === FieldType.RADIO || field.type === FieldType.CHECKBOX
            ? { ...field, inserted: true }
            : field,
        )
    );
  }, [fieldsWithPlaceholders]);

  /**
   * Set the selected recipient to the first recipient in the envelope.
   */
  useEffect(() => {
    editorFields.setSelectedRecipient(envelope.recipients[0]?.id ?? null);
  }, []);

  // Override the parent renderer provider so we can inject custom fields.
  return (
    <EnvelopeRenderProvider
      version="current"
      envelope={envelope}
      envelopeItems={envelope.envelopeItems}
      token={undefined}
      fields={visibleFields}
      recipients={envelope.recipients.map((recipient) => ({
        ...recipient,
        signingStatus: SigningStatus.SIGNED,
      }))}
      presignToken={editorConfig?.embedded?.presignToken}
      overrideSettings={{
        mode: 'export',
        signatureFontFamily: envelope.documentMeta?.signatureFontFamily,
        signatureFontSize: envelope.documentMeta?.signatureFontSize,
      }}
    >
      <div className="relative flex h-full">
        <div
          className="flex h-full w-full flex-col overflow-y-auto px-2"
          ref={scrollableContainerRef}
        >
          {/* Horizontal envelope item selector */}
          <EnvelopeRendererFileSelector className="px-0" fields={editorFields.localFields} />

          <Alert variant="warning" className="mx-auto max-w-[800px]">
            <AlertTitle>
              <Trans>Preview Mode</Trans>
            </AlertTitle>
            <AlertDescription>
              <Trans>Preview the document with each field's default value</Trans>
            </AlertDescription>
          </Alert>

          {/* Document View */}
          <div className="mt-4 flex h-full flex-col items-center justify-center">
            {currentEnvelopeItem !== null ? (
              <EnvelopePdfViewer
                customPageRenderer={EnvelopeGenericPageRenderer}
                scrollParentRef={scrollableContainerRef}
                errorMessage={PDF_VIEWER_ERROR_MESSAGES.preview}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-32">
                <FileTextIcon className="h-10 w-10 text-muted-foreground" />
                <p className="mt-1 text-sm text-foreground">
                  <Trans>No documents found</Trans>
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  <Trans>Please upload a document to continue</Trans>
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right Section - Form Fields Panel */}
        {currentEnvelopeItem && false && (
          <div className="sticky top-0 h-full w-80 flex-shrink-0 overflow-y-auto border-l border-gray-200 bg-white py-4">
            {/* Add fields section. */}
            <section className="px-4">
              {/* <h3 className="mb-2 text-sm font-semibold text-gray-900">
              <Trans>Preivew Mode</Trans>
            </h3> */}

              <Alert variant="neutral">
                <AlertTitle>
                  <Trans>Preview Mode</Trans>
                </AlertTitle>
                <AlertDescription>
                  <Trans>
                    Preview what the signed document will look like with placeholder data
                  </Trans>
                </AlertDescription>
              </Alert>

              {/* <Alert variant="neutral">
              <RadioGroup
                className="gap-y-1"
                value={selectedPreviewMode}
                onValueChange={(value) => setSelectedPreviewMode(value as 'recipient' | 'signed')}
              >
                <div className="flex items-center">
                  <RadioGroupItem
                    id="document-signed-preview"
                    className="pointer-events-none h-3 w-3"
                    value="signed"
                  />
                  <Label
                    htmlFor="document-signed-preview"
                    className="text-foreground ml-1.5 text-xs font-normal"
                  >
                    <Trans>Document Signed Preview</Trans>
                  </Label>
                </div>

                <div className="flex items-center">
                  <RadioGroupItem
                    id="recipient-preview"
                    className="pointer-events-none h-3 w-3"
                    value="recipient"
                  />
                  <Label
                    htmlFor="recipient-preview"
                    className="text-foreground ml-1.5 text-xs font-normal"
                  >
                    <Trans>Recipient Preview</Trans>
                  </Label>
                </div>
              </RadioGroup>
            </Alert>

            <div>Preview what a recipient will see</div>

            <div>Preview the signed document</div> */}
            </section>

            {false && (
              <AnimateGenericFadeInOut key={selectedPreviewMode}>
                {selectedPreviewMode === 'recipient' && (
                  <>
                    <Separator className="my-4" />

                    {/* Recipient selector section. */}
                    <section className="px-4">
                      <h3 className="mb-2 text-sm font-semibold text-gray-900">
                        <Trans>Selected Recipient</Trans>
                      </h3>

                      <RecipientSelector
                        selectedRecipient={editorFields.selectedRecipient}
                        onSelectedRecipientChange={(recipient) =>
                          editorFields.setSelectedRecipient(recipient.id)
                        }
                        recipients={envelope.recipients}
                        className="w-full"
                        align="end"
                      />
                    </section>
                  </>
                )}
              </AnimateGenericFadeInOut>
            )}
          </div>
        )}
      </div>
    </EnvelopeRenderProvider>
  );
};
