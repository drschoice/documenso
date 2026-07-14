import { useEffect, useMemo, useRef, useState } from 'react';

import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, FieldType, RecipientRole } from '@prisma/client';
import { FileTextIcon, PencilIcon, SparklesIcon } from 'lucide-react';
import { useRevalidator, useSearchParams } from 'react-router';
import { isDeepEqual } from 'remeda';
import { match } from 'ts-pattern';

import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import { useCurrentEnvelopeRender } from '@documenso/lib/client-only/providers/envelope-render-provider';
import { PDF_VIEWER_ERROR_MESSAGES } from '@documenso/lib/constants/pdf-viewer-i18n';
import type { NormalizedFieldWithContext } from '@documenso/lib/server-only/ai/envelope/detect-fields/types';
import {
  FIELD_META_DEFAULT_VALUES,
  type TCheckboxFieldMeta,
  type TDateFieldMeta,
  type TDropdownFieldMeta,
  type TEmailFieldMeta,
  type TFieldMetaSchema,
  type TFieldOptionValue,
  type TInitialsFieldMeta,
  type TNameFieldMeta,
  type TNumberFieldMeta,
  type TRadioFieldMeta,
  type TSignatureFieldMeta,
  type TTextFieldMeta,
} from '@documenso/lib/types/field-meta';
import { getEnvelopeItemPermissions } from '@documenso/lib/utils/envelope';
import { canRecipientFieldsBeModified } from '@documenso/lib/utils/recipients';
import { trpc } from '@documenso/trpc/react';
import { AnimateGenericFadeInOut } from '@documenso/ui/components/animate/animate-generic-fade-in-out';
import { cn } from '@documenso/ui/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@documenso/ui/primitives/alert';
import { Button } from '@documenso/ui/primitives/button';
import { Separator } from '@documenso/ui/primitives/separator';
import { useToast } from '@documenso/ui/primitives/use-toast';

import { AiFeaturesEnableDialog } from '~/components/dialogs/ai-features-enable-dialog';
import { AiFieldDetectionDialog } from '~/components/dialogs/ai-field-detection-dialog';
import { EnvelopeItemEditDialog } from '~/components/dialogs/envelope-item-edit-dialog';
import { EditorFieldCheckboxForm } from '~/components/forms/editor/editor-field-checkbox-form';
import { EditorFieldDateForm } from '~/components/forms/editor/editor-field-date-form';
import { EditorFieldDropdownForm } from '~/components/forms/editor/editor-field-dropdown-form';
import { EditorFieldEmailForm } from '~/components/forms/editor/editor-field-email-form';
import { EditorFieldInitialsForm } from '~/components/forms/editor/editor-field-initials-form';
import { EditorFieldNameForm } from '~/components/forms/editor/editor-field-name-form';
import { EditorFieldNumberForm } from '~/components/forms/editor/editor-field-number-form';
import { EditorFieldRadioForm } from '~/components/forms/editor/editor-field-radio-form';
import { EditorFieldSignatureForm } from '~/components/forms/editor/editor-field-signature-form';
import { EditorFieldTextForm } from '~/components/forms/editor/editor-field-text-form';
import { EnvelopePdfViewer } from '~/components/general/pdf-viewer/envelope-pdf-viewer';
import { useCurrentTeam } from '~/providers/team';

import { EnvelopeEditorFieldDragDrop } from './envelope-editor-fields-drag-drop';
import { EnvelopeEditorFieldsPageRenderer } from './envelope-editor-fields-page-renderer';
import { EnvelopeEditorPageThumbnails } from './envelope-editor-page-thumbnails';
import { EnvelopeRendererFileSelector } from './envelope-file-selector';
import { EnvelopeRecipientSelector } from './envelope-recipient-selector';

const FieldSettingsTypeTranslations: Record<FieldType, MessageDescriptor> = {
  [FieldType.SIGNATURE]: msg`Signature Settings`,
  [FieldType.FREE_SIGNATURE]: msg`Free Signature Settings`,
  [FieldType.TEXT]: msg`Text Settings`,
  [FieldType.DATE]: msg`Date Settings`,
  [FieldType.EMAIL]: msg`Email Settings`,
  [FieldType.NAME]: msg`Name Settings`,
  [FieldType.INITIALS]: msg`Initials Settings`,
  [FieldType.NUMBER]: msg`Number Settings`,
  [FieldType.RADIO]: msg`Radio Settings`,
  [FieldType.CHECKBOX]: msg`Checkbox Settings`,
  [FieldType.DROPDOWN]: msg`Dropdown Settings`,
};

export const EnvelopeEditorFieldsPage = () => {
  const [searchParams] = useSearchParams();

  const team = useCurrentTeam();

  const scrollableContainerRef = useRef<HTMLDivElement>(null);

  const {
    envelope,
    editorFields,
    navigateToStep,
    editorConfig,
    isTemplate,
    isEmbedded,
    setLocalEnvelope,
    registerPendingMutation,
  } = useCurrentEnvelopeEditor();

  const { currentEnvelopeItem } = useCurrentEnvelopeRender();

  const { _ } = useLingui();

  const { toast } = useToast();

  const [isAiFieldDialogOpen, setIsAiFieldDialogOpen] = useState(false);
  const [isAiEnableDialogOpen, setIsAiEnableDialogOpen] = useState(false);
  const { revalidate } = useRevalidator();

  const [pageCount, setPageCount] = useState<number>(0);
  const [pageImages, setPageImages] = useState<Map<number, string>>(new Map());
  const [isPageOperationLoading, setIsPageOperationLoading] = useState(false);

  const { mutateAsync: addBlankPage } = trpc.envelope.item.addBlankPage.useMutation();
  const { mutateAsync: deletePage } = trpc.envelope.item.deletePage.useMutation();

  // Reset page images whenever the current envelope item changes (PDF replaced).
  const currentEnvelopeItemDocumentDataId = envelope.envelopeItems.find(
    (item) => item.id === currentEnvelopeItem?.id,
  )?.documentDataId;

  useEffect(() => {
    setPageImages(new Map());
    setPageCount(0);
  }, [currentEnvelopeItem?.id, currentEnvelopeItemDocumentDataId]);

  const onPageRendered = (pageNumber: number, dataUrl: string) => {
    setPageImages((prev) => new Map(prev).set(pageNumber, dataUrl));
  };

  const onPageCountChange = (count: number) => {
    setPageCount(count);
  };

  const onAddBlankPage = async () => {
    if (!currentEnvelopeItem) {
      return;
    }

    setIsPageOperationLoading(true);

    try {
      const addPromise = addBlankPage({
        envelopeId: envelope.id,
        envelopeItemId: currentEnvelopeItem.id,
      });

      registerPendingMutation(addPromise);

      const { data } = await addPromise;

      setLocalEnvelope({
        envelopeItems: envelope.envelopeItems.map((item) =>
          item.id === data.id ? { ...item, documentDataId: data.documentDataId } : item,
        ),
      });
    } catch {
      toast({
        title: _(msg`Failed to add page`),
        description: _(msg`Something went wrong while adding the page`),
        duration: 5000,
        variant: 'destructive',
      });
    } finally {
      setIsPageOperationLoading(false);
    }
  };

  const onDeletePage = async (pageNumber: number) => {
    if (!currentEnvelopeItem) {
      return;
    }

    setIsPageOperationLoading(true);

    try {
      const deletePromise = deletePage({
        envelopeId: envelope.id,
        envelopeItemId: currentEnvelopeItem.id,
        pageNumber,
      });

      registerPendingMutation(deletePromise);

      const { data, fields } = await deletePromise;

      setLocalEnvelope({
        envelopeItems: envelope.envelopeItems.map((item) =>
          item.id === data.id ? { ...item, documentDataId: data.documentDataId } : item,
        ),
        ...(fields ? { fields } : {}),
      });

      if (fields) {
        editorFields.resetForm(fields);
      }
    } catch {
      toast({
        title: _(msg`Failed to delete page`),
        description: _(msg`Something went wrong while deleting the page`),
        duration: 5000,
        variant: 'destructive',
      });
    } finally {
      setIsPageOperationLoading(false);
    }
  };

  const envelopeItemPermissions = useMemo(
    () => getEnvelopeItemPermissions(envelope, envelope.recipients),
    [envelope, envelope.recipients],
  );

  const selectedField = useMemo(
    () => structuredClone(editorFields.selectedField),
    [editorFields.selectedField],
  );

  const updateSelectedFieldMeta = (fieldMeta: TFieldMetaSchema) => {
    if (!selectedField) {
      return;
    }

    // Preserve stableId and visibility from the existing meta — the editor
    // form schemas use .pick() and don't include these keys, so they would
    // otherwise be silently dropped on every sidebar edit.
    const existingMeta = selectedField.fieldMeta as Record<string, unknown> | undefined;
    let mergedMeta: TFieldMetaSchema =
      fieldMeta && existingMeta
        ? ({
            ...(existingMeta.stableId !== undefined ? { stableId: existingMeta.stableId } : {}),
            ...(existingMeta.visibility !== undefined
              ? { visibility: existingMeta.visibility }
              : {}),
            ...(fieldMeta as Record<string, unknown>),
          } as TFieldMetaSchema)
        : fieldMeta;

    // Free-layout option offsets live on the canvas, not in the sidebar form,
    // so the form may emit values without them (e.g. when the field was
    // selected before the offsets were seeded). Preserve them by option id,
    // and strip them when leaving free layout.
    if (mergedMeta && (mergedMeta.type === 'radio' || mergedMeta.type === 'checkbox')) {
      const isFreeLayout = mergedMeta.layout === 'free';

      const existingValues =
        existingMeta && (existingMeta.type === 'radio' || existingMeta.type === 'checkbox')
          ? ((existingMeta.values as TFieldOptionValue[] | undefined) ?? [])
          : [];

      mergedMeta = {
        ...mergedMeta,
        values: mergedMeta.values?.map((value) => {
          const { offsetX, offsetY, ...rest } = value;

          if (!isFreeLayout) {
            return rest;
          }

          const existingValue = existingValues.find((v) => v.id === value.id);

          const resolvedOffsetX = offsetX ?? existingValue?.offsetX;
          const resolvedOffsetY = offsetY ?? existingValue?.offsetY;

          return {
            ...rest,
            ...(resolvedOffsetX !== undefined ? { offsetX: resolvedOffsetX } : {}),
            ...(resolvedOffsetY !== undefined ? { offsetY: resolvedOffsetY } : {}),
          };
        }),
      };
    }

    const isMetaSame = isDeepEqual(selectedField.fieldMeta, mergedMeta);

    if (!isMetaSame) {
      editorFields.updateFieldByFormId(selectedField.formId, {
        fieldMeta: mergedMeta,
      });
    }
  };

  const onFieldDetectionComplete = (fields: NormalizedFieldWithContext[]) => {
    for (const field of fields) {
      const fieldMeta = structuredClone(FIELD_META_DEFAULT_VALUES[field.type]);

      if (fieldMeta && field.label) {
        fieldMeta.label = field.label;

        if (
          (field.type === FieldType.RADIO || field.type === FieldType.CHECKBOX) &&
          'values' in fieldMeta &&
          Array.isArray(fieldMeta.values) &&
          fieldMeta.values.length > 0
        ) {
          fieldMeta.values[0].value = field.label;
        }
      }

      editorFields.addField({
        height: field.height,
        width: field.width,
        positionX: field.positionX,
        positionY: field.positionY,
        type: field.type,
        envelopeItemId: field.envelopeItemId,
        recipientId: field.recipientId,
        page: field.pageNumber,
        fieldMeta,
      });
    }

    setIsAiFieldDialogOpen(false);
  };

  /**
   * Set the selected recipient to the first recipient in the envelope.
   */
  useEffect(() => {
    const firstSelectableRecipient = envelope.recipients.find(
      (recipient) =>
        recipient.role === RecipientRole.SIGNER || recipient.role === RecipientRole.APPROVER,
    );

    editorFields.setSelectedRecipient(firstSelectableRecipient?.id ?? null);
  }, []);

  const onDetectClick = () => {
    if (!team.preferences.aiFeaturesEnabled) {
      setIsAiEnableDialogOpen(true);
      return;
    }

    setIsAiFieldDialogOpen(true);
  };

  const onAiFeaturesEnabled = () => {
    void revalidate().then(() => {
      setIsAiEnableDialogOpen(false);
      setIsAiFieldDialogOpen(true);
    });
  };

  return (
    <div className="relative flex h-full">
      {/* Page Thumbnails Sidebar — templates only */}
      {isTemplate && !isEmbedded && currentEnvelopeItem && pageCount > 0 && (
        <EnvelopeEditorPageThumbnails
          pageCount={pageCount}
          pageImages={pageImages}
          isLoading={isPageOperationLoading}
          onDeletePage={(pageNumber) => void onDeletePage(pageNumber)}
          onAddBlankPage={() => void onAddBlankPage()}
        />
      )}

      <div
        className="flex h-full w-full flex-col overflow-y-auto px-2"
        ref={scrollableContainerRef}
      >
        {/* Horizontal envelope item selector */}
        <EnvelopeRendererFileSelector
          className="px-0"
          fields={editorFields.localFields}
          renderItemAction={
            editorConfig.envelopeItems !== null &&
            editorConfig.envelopeItems.allowReplace &&
            envelopeItemPermissions.canFileBeChanged
              ? (item) => (
                  <div className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <div
                      className={cn(
                        'h-2 w-2 rounded-full transition-opacity duration-150 group-hover:opacity-0',
                        { 'bg-green-500': currentEnvelopeItem?.id === item.id },
                      )}
                    />
                    <EnvelopeItemEditDialog
                      envelopeItem={item}
                      allowConfigureTitle={editorConfig.envelopeItems?.allowConfigureTitle ?? false}
                      trigger={
                        <span
                          className="absolute inset-0 flex cursor-pointer items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`envelope-item-edit-button-${item.id}`}
                        >
                          <PencilIcon className="h-3.5 w-3.5" />
                        </span>
                      }
                    />
                  </div>
                )
              : undefined
          }
        />

        {/* Document View */}
        <div className="mt-4 flex h-full flex-col items-center justify-center">
          {envelope.recipients.length === 0 && (
            <Alert
              variant="neutral"
              className="mb-4 flex max-w-[800px] flex-row items-center justify-between space-y-0 rounded-sm border border-border bg-background"
            >
              <div className="flex flex-col gap-1">
                <AlertTitle>
                  <Trans>Missing Recipients</Trans>
                </AlertTitle>
                <AlertDescription>
                  <Trans>You need at least one recipient to add fields</Trans>
                </AlertDescription>
              </div>

              <Button variant="outline" onClick={() => void navigateToStep('upload')}>
                <Trans>Add Recipients</Trans>
              </Button>
            </Alert>
          )}

          {currentEnvelopeItem !== null ? (
            <EnvelopePdfViewer
              customPageRenderer={EnvelopeEditorFieldsPageRenderer}
              scrollParentRef={scrollableContainerRef}
              errorMessage={PDF_VIEWER_ERROR_MESSAGES.editor}
              onPageRendered={onPageRendered}
              onPageCountChange={onPageCountChange}
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
      {currentEnvelopeItem && envelope.recipients.length > 0 && (
        <div className="sticky top-0 h-full w-80 flex-shrink-0 overflow-y-auto border-l border-border bg-background py-4">
          {/* Recipient selector section. */}
          <section className="px-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              <Trans>Selected Recipient</Trans>
            </h3>

            <EnvelopeRecipientSelector
              selectedRecipient={editorFields.selectedRecipient}
              onSelectedRecipientChange={(recipient) =>
                editorFields.setSelectedRecipient(recipient.id)
              }
              recipients={envelope.recipients}
              fields={envelope.fields}
              className="w-full"
              align="end"
            />

            {editorFields.selectedRecipient &&
              !canRecipientFieldsBeModified(editorFields.selectedRecipient, envelope.fields) && (
                <Alert className="mt-4" variant="warning">
                  <AlertDescription>
                    <Trans>
                      This recipient can no longer be modified as they have signed a field, or
                      completed the document.
                    </Trans>
                  </AlertDescription>
                </Alert>
              )}
          </section>

          <Separator className="my-4" />

          {/* Add fields section. */}
          <section className="px-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              <Trans>Add Fields</Trans>
            </h3>

            <EnvelopeEditorFieldDragDrop
              selectedRecipientId={editorFields.selectedRecipient?.id ?? null}
              selectedEnvelopeItemId={currentEnvelopeItem?.id ?? null}
            />

            {editorConfig.fields?.allowAIDetection && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-4 w-full"
                  onClick={onDetectClick}
                  disabled={envelope.status !== DocumentStatus.DRAFT}
                  title={
                    envelope.status !== DocumentStatus.DRAFT
                      ? _(msg`You can only detect fields in draft envelopes`)
                      : undefined
                  }
                >
                  <SparklesIcon className="-ml-1 mr-2 h-4 w-4" />
                  <Trans>Detect with AI</Trans>
                </Button>

                <AiFieldDetectionDialog
                  open={isAiFieldDialogOpen}
                  onOpenChange={setIsAiFieldDialogOpen}
                  onComplete={onFieldDetectionComplete}
                  envelopeId={envelope.id}
                  teamId={envelope.teamId}
                  envelopeItems={envelope.envelopeItems.map((item) => ({
                    id: item.id,
                    title: item.title,
                    order: item.order,
                  }))}
                />

                <AiFeaturesEnableDialog
                  open={isAiEnableDialogOpen}
                  onOpenChange={setIsAiEnableDialogOpen}
                  onEnabled={onAiFeaturesEnabled}
                />
              </>
            )}
          </section>

          {/* Field details section. */}
          <AnimateGenericFadeInOut key={editorFields.selectedField?.formId}>
            {selectedField && (
              <section>
                <Separator className="my-4" />

                {searchParams.get('devmode') && (
                  <>
                    <div className="px-4">
                      <h3 className="mb-3 text-sm font-semibold text-foreground">
                        <Trans>Developer Mode</Trans>
                      </h3>

                      <div className="space-y-2 rounded-md border border-border bg-muted/50 p-3 text-sm text-foreground">
                        {selectedField.id && (
                          <p>
                            <span className="min-w-12 text-muted-foreground">
                              <Trans>Field ID:</Trans>
                            </span>{' '}
                            {selectedField.id}
                          </p>
                        )}
                        <p>
                          <span className="min-w-12 text-muted-foreground">
                            <Trans>Recipient ID:</Trans>
                          </span>{' '}
                          {selectedField.recipientId}
                        </p>
                        <p>
                          <span className="min-w-12 text-muted-foreground">
                            <Trans>Pos X:</Trans>
                          </span>{' '}
                          {selectedField.positionX.toFixed(2)}
                        </p>
                        <p>
                          <span className="min-w-12 text-muted-foreground">
                            <Trans>Pos Y:</Trans>
                          </span>{' '}
                          {selectedField.positionY.toFixed(2)}
                        </p>
                        <p>
                          <span className="min-w-12 text-muted-foreground">
                            <Trans>Width:</Trans>
                          </span>{' '}
                          {selectedField.width.toFixed(2)}
                        </p>
                        <p>
                          <span className="min-w-12 text-muted-foreground">
                            <Trans>Height:</Trans>
                          </span>{' '}
                          {selectedField.height.toFixed(2)}
                        </p>
                      </div>
                    </div>

                    <Separator className="my-4" />
                  </>
                )}

                <div className="px-4 [&_label]:text-xs [&_label]:text-foreground/70">
                  <h3 className="text-sm font-semibold">
                    {_(FieldSettingsTypeTranslations[selectedField.type])}
                  </h3>

                  {match(selectedField.type)
                    .with(FieldType.SIGNATURE, () => (
                      <EditorFieldSignatureForm
                        value={selectedField?.fieldMeta as TSignatureFieldMeta | undefined}
                        onValueChange={(value) => updateSelectedFieldMeta(value)}
                      />
                    ))
                    .with(FieldType.CHECKBOX, () => (
                      <EditorFieldCheckboxForm
                        value={selectedField?.fieldMeta as TCheckboxFieldMeta | undefined}
                        onValueChange={(value) => updateSelectedFieldMeta(value)}
                        isEnvelopeV2={envelope.internalVersion === 2}
                      />
                    ))
                    .with(FieldType.DATE, () => (
                      <EditorFieldDateForm
                        value={selectedField?.fieldMeta as TDateFieldMeta | undefined}
                        onValueChange={(value) => updateSelectedFieldMeta(value)}
                      />
                    ))
                    .with(FieldType.DROPDOWN, () => (
                      <EditorFieldDropdownForm
                        value={selectedField?.fieldMeta as TDropdownFieldMeta | undefined}
                        onValueChange={(value) => updateSelectedFieldMeta(value)}
                      />
                    ))
                    .with(FieldType.EMAIL, () => (
                      <EditorFieldEmailForm
                        value={selectedField?.fieldMeta as TEmailFieldMeta | undefined}
                        onValueChange={(value) => updateSelectedFieldMeta(value)}
                      />
                    ))
                    .with(FieldType.INITIALS, () => (
                      <EditorFieldInitialsForm
                        value={selectedField?.fieldMeta as TInitialsFieldMeta | undefined}
                        onValueChange={(value) => updateSelectedFieldMeta(value)}
                      />
                    ))
                    .with(FieldType.NAME, () => (
                      <EditorFieldNameForm
                        value={selectedField?.fieldMeta as TNameFieldMeta | undefined}
                        onValueChange={(value) => updateSelectedFieldMeta(value)}
                      />
                    ))
                    .with(FieldType.NUMBER, () => (
                      <EditorFieldNumberForm
                        value={selectedField?.fieldMeta as TNumberFieldMeta | undefined}
                        onValueChange={(value) => updateSelectedFieldMeta(value)}
                      />
                    ))
                    .with(FieldType.RADIO, () => (
                      <EditorFieldRadioForm
                        value={selectedField?.fieldMeta as TRadioFieldMeta | undefined}
                        onValueChange={(value) => updateSelectedFieldMeta(value)}
                        isEnvelopeV2={envelope.internalVersion === 2}
                      />
                    ))
                    .with(FieldType.TEXT, () => (
                      <EditorFieldTextForm
                        value={selectedField?.fieldMeta as TTextFieldMeta | undefined}
                        onValueChange={(value) => updateSelectedFieldMeta(value)}
                      />
                    ))
                    .otherwise(() => null)}
                </div>
              </section>
            )}
          </AnimateGenericFadeInOut>
        </div>
      )}
    </div>
  );
};
