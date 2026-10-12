import { useEffect, useMemo } from 'react';

import { Trans, useLingui } from '@lingui/react/macro';
import {
  type Field,
  FieldType,
  type Recipient,
  RecipientRole,
  type Signature,
  SigningStatus,
} from '@prisma/client';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { flushSync } from 'react-dom';
import { match } from 'ts-pattern';

import { usePageRenderer } from '@documenso/lib/client-only/hooks/use-page-renderer';
import {
  type PageRenderData,
  useCurrentEnvelopeRender,
} from '@documenso/lib/client-only/providers/envelope-render-provider';
import { isBase64Image } from '@documenso/lib/constants/signatures';
import type { TRecipientActionAuth } from '@documenso/lib/types/document-auth';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import { ZFullFieldSchema } from '@documenso/lib/types/field';
import { getFieldNamePart, isFullNameField } from '@documenso/lib/types/field-meta';
import { getInlineEditKind } from '@documenso/lib/universal/field-inline-signing/inline-edit-kind';
import { getInlineInitialText } from '@documenso/lib/universal/field-inline-signing/resolve-inline-commit';
import { createSpinner } from '@documenso/lib/universal/field-renderer/field-generic-items';
import { renderField } from '@documenso/lib/universal/field-renderer/render-field';
import { evaluateAllVisibility } from '@documenso/lib/universal/field-visibility';
import { getClientSideFieldTranslations } from '@documenso/lib/utils/fields';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';
import { EnvelopeRecipientFieldTooltip } from '@documenso/ui/components/document/envelope-recipient-field-tooltip';
import { EnvelopeFieldToolTip } from '@documenso/ui/components/field/envelope-field-tooltip';
import { useToast } from '@documenso/ui/primitives/use-toast';

import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';
import { handleCheckboxFieldClick } from '~/utils/field-signing/checkbox-field';
import { handleEmailFieldClick } from '~/utils/field-signing/email-field';
import { handleInitialsFieldClick } from '~/utils/field-signing/initial-field';
import { handleNameFieldClick } from '~/utils/field-signing/name-field';
import { handleSignatureFieldClick } from '~/utils/field-signing/signature-field';

import { useRequiredDocumentSigningAuthContext } from '../document-signing/document-signing-auth-provider';
import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';
import { EnvelopeSignerInlineCombEditor } from './envelope-signer-inline-comb-editor';
import { EnvelopeSignerInlineDateEditor } from './envelope-signer-inline-date-editor';
import { EnvelopeSignerInlineDropdownEditor } from './envelope-signer-inline-dropdown-editor';
import { EnvelopeSignerInlineFieldEditor } from './envelope-signer-inline-field-editor';
import {
  type TOpenInlineFieldOptions,
  useEnvelopeSigningInlineEdit,
} from './envelope-signing-inline-edit-provider';
import { useSigningIdentityValues } from './use-signing-identity-values';

/**
 * How far, in CSS pixels, the pointer may move between pressing and releasing on a field for it to
 * still count as a click that opens the field for typing. Further than this is a drag or a scroll.
 */
const INLINE_OPEN_MAX_POINTER_TRAVEL = 8;

/** The comb cell a click landed on, if it landed on one. */
const getClickedCellIndex = (target: Konva.Node): number | undefined => {
  const cellIndex = Number(target.getAttr('internalCellIndex'));

  return Number.isNaN(cellIndex) ? undefined : cellIndex;
};

type GenericLocalField = TEnvelope['fields'][number] & {
  signature?: Pick<Signature, 'signatureImageAsBase64' | 'typedSignature'> | null;
  recipient: Pick<Recipient, 'id' | 'name' | 'email' | 'signingStatus'>;
};

export const EnvelopeSignerPageRenderer = ({ pageData }: { pageData: PageRenderData }) => {
  const { t, i18n } = useLingui();
  const { currentEnvelopeItem, setRenderError } = useCurrentEnvelopeRender();

  const { executeActionAuthProcedure } = useRequiredDocumentSigningAuthContext();
  const { toast } = useToast();

  const {
    envelopeData,
    recipient,
    recipientFields,
    visibleRecipientFields,
    recipientFieldsRemaining,
    recipientFieldsRemainingForNavigation,
    showPendingFieldTooltip,
    signField: signFieldInternal,
    email,
    setEmail,
    fullName,
    setFullName,
    signature,
    setSignature,
    selectedAssistantRecipientFields,
    selectedAssistantRecipient,
  } = useRequiredEnvelopeSigningContext();

  const { onFieldSigned, onFieldUnsigned } = useEmbedSigningContext() || {};

  const {
    activeField,
    commitOptions,
    openInlineField,
    closeInlineField,
    commitInlineField,
    navigateInlineField,
  } = useEnvelopeSigningInlineEdit();

  const {
    localEmail,
    localFullName,
    localRecipient,
    placeholderEmail,
    isNameLocked,
    isEmailEditable,
    getKnownValue,
  } = useSigningIdentityValues();

  const { stage, pageLayer, konvaContainer, unscaledViewport } = usePageRenderer(
    ({ stage, pageLayer }) => createPageCanvas(stage, pageLayer),
    pageData,
  );

  const { scale, pageNumber } = pageData;

  const { envelope } = envelopeData;

  const localPageFields = useMemo(() => {
    let fieldsToRender = visibleRecipientFields;

    if (recipient.role === RecipientRole.ASSISTANT) {
      fieldsToRender = selectedAssistantRecipientFields;
    }

    return fieldsToRender.filter(
      (field) => field.page === pageNumber && field.envelopeItemId === currentEnvelopeItem?.id,
    );
  }, [
    visibleRecipientFields,
    selectedAssistantRecipientFields,
    pageNumber,
    currentEnvelopeItem?.id,
  ]);

  /**
   * Returns the fields of every *other* recipient for this specific page, so the
   * signer can see the full shape of the document rather than only their own blanks.
   *
   * These are rendered greyed out and non-interactive. Values are only carried
   * through for recipients who have fully signed — a pending recipient's in-progress
   * input is blanked in `renderFields` so it is never shown to another signer.
   */
  const localPageOtherRecipientFields = useMemo((): GenericLocalField[] => {
    const currentFieldIds = new Set(localPageFields.map((field) => field.id));

    return envelope.recipients
      .filter((otherRecipient) => otherRecipient.id !== recipient.id)
      .flatMap((otherRecipient) => {
        // Conditional visibility is evaluated over the owning recipient's own field
        // set, mirroring how `visibleRecipientFields` is derived for the signer.
        const visibility = evaluateAllVisibility(
          otherRecipient.fields.map((field) => ({
            id: field.id,
            type: field.type,
            customText: field.customText,
            inserted: field.inserted,
            fieldMeta: field.fieldMeta,
          })),
        );

        return otherRecipient.fields
          .filter(
            (field) =>
              field.page === pageNumber &&
              field.envelopeItemId === currentEnvelopeItem?.id &&
              // Assistants render another recipient's fields as their own interactive
              // set, so skip anything already drawn for the current recipient.
              !currentFieldIds.has(field.id) &&
              visibility.get(field.id) !== false,
          )
          .map((field) => ({
            ...field,
            recipient: {
              id: otherRecipient.id,
              name: otherRecipient.name,
              email: otherRecipient.email,
              signingStatus: otherRecipient.signingStatus,
              role: otherRecipient.role,
            },
          }));
      });
  }, [envelope.recipients, recipient.id, localPageFields, pageNumber, currentEnvelopeItem?.id]);

  // Only the page holding the field being typed into redraws when it opens or closes.
  const activeFieldIdOnPage =
    activeField && localPageFields.some((field) => field.id === activeField.fieldId)
      ? activeField.fieldId
      : null;

  /**
   * Open a field for typing in place once the press that started on it is released.
   *
   * Opening on the press itself would lose the new editor straight away: the browser moves focus
   * after the press, which blurs the editor. Konva's own click event does not work either. Saving
   * the field that was open before redraws every field between press and release, so the release
   * no longer lands on the shape that was pressed and Konva never fires the click. Listening on
   * the window avoids depending on the shape at all.
   *
   * The editor is rendered and focused synchronously inside the release, which is what lets
   * mobile browsers raise the keyboard.
   */
  const openInlineFieldOnRelease = (
    event: KonvaEventObject<Event>,
    fieldId: number,
    options?: TOpenInlineFieldOptions,
  ) => {
    const pressEvent = event.evt;

    if (!(pressEvent instanceof PointerEvent)) {
      flushSync(() => openInlineField(fieldId, options));
      return;
    }

    const { pointerId, clientX: startX, clientY: startY } = pressEvent;

    const stopListening = () => {
      window.removeEventListener('pointerup', handleRelease, true);
      window.removeEventListener('pointercancel', stopListening, true);
    };

    const handleRelease = (releaseEvent: PointerEvent) => {
      if (releaseEvent.pointerId !== pointerId) {
        return;
      }

      stopListening();

      const travel = Math.hypot(releaseEvent.clientX - startX, releaseEvent.clientY - startY);

      if (travel > INLINE_OPEN_MAX_POINTER_TRAVEL) {
        return;
      }

      flushSync(() => openInlineField(fieldId, options));
    };

    window.addEventListener('pointerup', handleRelease, true);
    // The browser took the gesture over, e.g. to scroll the page.
    window.addEventListener('pointercancel', stopListening, true);
  };

  const unsafeRenderFieldOnLayer = (unparsedField: Field & { signature?: Signature | null }) => {
    if (!pageLayer.current) {
      console.error('Layer not loaded yet');
      return;
    }

    const fieldToRender = ZFullFieldSchema.parse(unparsedField);

    const color = fieldToRender.fieldMeta?.readOnly
      ? 'readOnly'
      : showPendingFieldTooltip &&
          recipientFieldsRemainingForNavigation.some((f) => f.id === fieldToRender.id)
        ? 'orange'
        : 'green';

    const { fieldGroup } = renderField({
      scale,
      pageLayer: pageLayer.current,
      field: {
        renderId: fieldToRender.id.toString(),
        ...fieldToRender,
        width: Number(fieldToRender.width),
        height: Number(fieldToRender.height),
        positionX: Number(fieldToRender.positionX),
        positionY: Number(fieldToRender.positionY),
        signature: unparsedField.signature,
      },
      translations: getClientSideFieldTranslations(i18n),
      pageWidth: unscaledViewport.width,
      pageHeight: unscaledViewport.height,
      color,
      mode: 'sign',
      signatureFontFamily: envelope.documentMeta.signatureFontFamily,
      signatureFontSize: envelope.documentMeta.signatureFontSize,
    });

    // The editor typed into in place draws the value itself. Rendering re-creates the text node,
    // so it is hidden again on every render rather than once.
    if (activeFieldIdOnPage === fieldToRender.id) {
      fieldGroup.find('.field-text').forEach((node) => node.visible(false));
      fieldGroup.find('.field-cell-text').forEach((node) => node.visible(false));
      fieldGroup.find('.dropdown-selected-text').forEach((node) => node.visible(false));
    }

    const handleFieldGroupClick = (e: KonvaEventObject<Event>) => {
      const currentTarget = e.currentTarget as Konva.Group;
      const target = e.target as Konva.Shape;

      const { width: fieldWidth, height: fieldHeight } = fieldGroup.getClientRect();

      const foundField = localPageFields.find((f) => f.id === unparsedField.id);
      const foundLoadingGroup = currentTarget.findOne('.loading-spinner-group');

      if (!foundField || foundLoadingGroup || foundField.fieldMeta?.readOnly) {
        return;
      }

      // Free-layout radio/checkbox options render as their own subgroups, so
      // attach the spinner to the clicked option instead of the whole field
      // union which may be mostly empty space.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const clickedOptionGroup = target.findAncestor('.field-option-group') as Konva.Group | null;
      const spinnerParent = clickedOptionGroup ?? fieldGroup;

      const { width: spinnerWidth, height: spinnerHeight } = clickedOptionGroup
        ? clickedOptionGroup.getClientRect()
        : { width: fieldWidth, height: fieldHeight };

      const loadingSpinnerGroup = createSpinner({
        fieldWidth: spinnerWidth / scale,
        fieldHeight: spinnerHeight / scale,
      });

      const parsedFoundField = ZFullFieldSchema.parse(foundField);

      match(parsedFoundField)
        /**
         * CHECKBOX FIELD.
         */
        .with({ type: FieldType.CHECKBOX }, (field) => {
          const clickedCheckboxIndex = Number(target.getAttr('internalCheckboxIndex'));

          if (Number.isNaN(clickedCheckboxIndex)) {
            return;
          }

          handleCheckboxFieldClick({ field, clickedCheckboxIndex })
            .then(async (payload) => {
              if (payload) {
                spinnerParent.add(loadingSpinnerGroup);
                await signField(field.id, payload);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        /**
         * RADIO FIELD.
         */
        .with({ type: FieldType.RADIO }, (field) => {
          const selectedRadioIndex = Number(target.getAttr('internalRadioIndex'));
          const fieldCustomText = Number(field.customText);

          if (Number.isNaN(selectedRadioIndex)) {
            return;
          }

          spinnerParent.add(loadingSpinnerGroup);

          // Uncheck the value if it's already pressed.
          const value =
            field.inserted && selectedRadioIndex === fieldCustomText ? null : selectedRadioIndex;

          void signField(field.id, {
            type: FieldType.RADIO,
            value,
          }).finally(() => {
            loadingSpinnerGroup.destroy();
          });
        })
        /**
         * NUMBER FIELD.
         */
        .with({ type: FieldType.NUMBER }, (field) => {
          openInlineFieldOnRelease(e, field.id, { caretIndex: getClickedCellIndex(target) });
        })
        /**
         * TEXT FIELD.
         */
        .with({ type: FieldType.TEXT }, (field) => {
          openInlineFieldOnRelease(e, field.id, { caretIndex: getClickedCellIndex(target) });
        })
        /**
         * EMAIL FIELD.
         */
        .with({ type: FieldType.EMAIL }, (field) => {
          // A recipient's email is fixed, so a filled field only toggles back off. Only a direct
          // template signer chooses their own email, and can change what they typed.
          if (field.inserted ? isEmailEditable : !localEmail) {
            openInlineFieldOnRelease(e, field.id, {
              initialValue: field.inserted ? undefined : (placeholderEmail ?? ''),
            });

            return;
          }

          const payload = handleEmailFieldClick({ field, email: localEmail });

          if (!payload) {
            return;
          }

          fieldGroup.add(loadingSpinnerGroup);

          void signField(field.id, payload)
            .then(() => {
              if (payload.value) {
                setEmail(payload.value);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        /**
         * INITIALS FIELD.
         */
        .with({ type: FieldType.INITIALS }, (field) => {
          const initials = getKnownValue(field) || null;

          // Known initials fill the field in one click. Typed ones, or a filled field, are edited
          // in place - unless an embedding host has locked the signer's name.
          if (field.inserted ? !isNameLocked : !initials) {
            openInlineFieldOnRelease(e, field.id);
            return;
          }

          const payload = handleInitialsFieldClick({ field, initials });

          if (!payload) {
            return;
          }

          fieldGroup.add(loadingSpinnerGroup);

          void signField(field.id, payload).finally(() => {
            loadingSpinnerGroup.destroy();
          });
        })
        /**
         * NAME FIELD.
         */
        .with({ type: FieldType.NAME }, (field) => {
          const knownName = getKnownValue(field);

          // A known name fills the field in one click. A name the page does not know yet, or a
          // filled field, is typed in place - unless an embedding host has locked the name.
          if (field.inserted ? !isNameLocked : !knownName) {
            openInlineFieldOnRelease(e, field.id);
            return;
          }

          const payload = handleNameFieldClick({
            field,
            name: localFullName,
            recipient: localRecipient,
          });

          if (!payload) {
            return;
          }

          fieldGroup.add(loadingSpinnerGroup);

          void signField(field.id, payload)
            .then(() => {
              // Only a field holding the whole name may update the signer's full name. A field
              // bound to a single part would otherwise reduce it to just that part, which also
              // drives the initials and typed signature.
              if (payload.value && isFullNameField(field.fieldMeta)) {
                setFullName(payload.value);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        /**
         * DROPDOWN FIELD.
         */
        .with({ type: FieldType.DROPDOWN }, (field) => {
          openInlineFieldOnRelease(e, field.id);
        })
        /**
         * DATE FIELD.
         */
        .with({ type: FieldType.DATE }, (field) => {
          openInlineFieldOnRelease(e, field.id);
        })
        /**
         * SIGNATURE FIELD.
         */
        .with({ type: FieldType.SIGNATURE }, (field) => {
          handleSignatureFieldClick({
            field,
            fullName,
            signature,
            typedSignatureEnabled: envelope.documentMeta.typedSignatureEnabled,
            uploadSignatureEnabled: envelope.documentMeta.uploadSignatureEnabled,
            drawSignatureEnabled: envelope.documentMeta.drawSignatureEnabled,
            signatureFontFamily: envelope.documentMeta.signatureFontFamily,
          })
            .then(async (payload) => {
              if (payload) {
                fieldGroup.add(loadingSpinnerGroup);

                if (payload.value) {
                  void executeActionAuthProcedure({
                    onReauthFormSubmit: async (authOptions) => {
                      await signField(field.id, payload, authOptions);

                      loadingSpinnerGroup.destroy();
                    },
                    actionTarget: field.type,
                  });

                  setSignature(payload.value);
                } else {
                  await signField(field.id, payload);
                }
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        .exhaustive();
    };

    fieldGroup.off('pointerdown');
    fieldGroup.on('pointerdown', handleFieldGroupClick);
  };

  const renderFieldOnLayer = (unparsedField: Field & { signature?: Signature | null }) => {
    try {
      unsafeRenderFieldOnLayer(unparsedField);
    } catch (err) {
      console.error(err);
      setRenderError(true);
    }
  };

  const renderFields = () => {
    if (!pageLayer.current) {
      console.error('Layer not loaded yet');
      return;
    }

    // Render other recipient fields first so the current recipient's fields end up
    // above them in the layer's z-order.
    for (const field of localPageOtherRecipientFields) {
      try {
        // Only recipients who have fully signed have their values shown. Everyone
        // else renders as an empty placeholder so their in-progress input is never
        // exposed to another signer. Read-only prefilled values are author-provided
        // rather than signer-entered, so they still render either way.
        const isSigned = field.recipient.signingStatus === SigningStatus.SIGNED;

        const { fieldGroup } = renderField({
          scale,
          pageLayer: pageLayer.current,
          field: {
            renderId: field.id.toString(),
            ...field,
            width: Number(field.width),
            height: Number(field.height),
            positionX: Number(field.positionX),
            positionY: Number(field.positionY),
            fieldMeta: field.fieldMeta,
            inserted: isSigned && field.inserted,
            customText: isSigned ? field.customText : '',
            signature: isSigned ? field.signature : null,
          },
          translations: getClientSideFieldTranslations(i18n),
          pageWidth: unscaledViewport.width,
          pageHeight: unscaledViewport.height,
          color: 'readOnly',
          editable: false,
          mode: 'sign',
          signatureFontFamily: envelope.documentMeta.signatureFontFamily,
          signatureFontSize: envelope.documentMeta.signatureFontSize,
        });

        // Konva dispatches a click to the topmost hit shape only, so without this a
        // greyed field overlapping one of the current recipient's fields would
        // swallow the pointerdown and make it impossible to sign.
        fieldGroup.listening(false);
      } catch (err) {
        console.error('Unable to render one or more fields belonging to other recipients.');
        console.error(err);
      }
    }

    // Render current recipient fields.
    for (const field of localPageFields) {
      renderFieldOnLayer(field);
    }
  };

  const signField = async (
    fieldId: number,
    payload: TSignEnvelopeFieldValue,
    authOptions?: TRecipientActionAuth,
  ) => {
    try {
      const { inserted } = await signFieldInternal(fieldId, payload, authOptions);

      // ?: The two callbacks below are used within the embedding context
      if (inserted && onFieldSigned) {
        const value = payload.value ? JSON.stringify(payload.value) : undefined;
        const isBase64 = value ? isBase64Image(value) : undefined;

        onFieldSigned({ fieldId, value, isBase64 });
      }

      if (!inserted && onFieldUnsigned) {
        onFieldUnsigned({ fieldId });
      }
    } catch (err) {
      console.error(err);

      toast({
        title: t`Error`,
        description: t`An error occurred while signing the field.`,
        variant: 'destructive',
      });

      throw err;
    }
  };

  /**
   * Initialize the Konva page canvas and all fields and interactions.
   */
  const createPageCanvas = (currentStage: Konva.Stage, currentPageLayer: Konva.Layer) => {
    renderFields();
    currentPageLayer.batchDraw();
  };

  /**
   * Render fields when they are changed or inserted.
   */
  useEffect(() => {
    if (!pageLayer.current || !stage.current) {
      return;
    }

    // Destroy groups for fields that are no longer in localPageFields (e.g. hidden
    // by a conditional visibility rule). Without this, groups for hidden fields stay
    // on the canvas and newly-visible fields (whose groups were previously added and
    // then orphaned) are never re-added because isFirstRender evaluates to false.
    const currentRecipientFieldIds = new Set(localPageFields.map((f) => f.id.toString()));
    const otherRecipientFieldIds = new Set(
      localPageOtherRecipientFields.map((f) => f.id.toString()),
    );
    pageLayer.current.find('Group').forEach((group) => {
      if (
        group.name() === 'field-group' &&
        !currentRecipientFieldIds.has(group.id()) &&
        !otherRecipientFieldIds.has(group.id())
      ) {
        group.destroy();
      }
    });

    renderFields();

    pageLayer.current.batchDraw();
  }, [
    localPageFields,
    localPageOtherRecipientFields,
    showPendingFieldTooltip,
    fullName,
    signature,
    email,
    activeFieldIdOnPage,
  ]);

  /**
   * Rerender the whole page if the selected assistant recipient changes.
   */
  useEffect(() => {
    if (!pageLayer.current || !stage.current) {
      return;
    }

    // Rerender the whole page.
    pageLayer.current.destroyChildren();

    renderFields();

    pageLayer.current.batchDraw();
  }, [selectedAssistantRecipient]);

  const activeLocalField = useMemo(() => {
    const field = activeField
      ? localPageFields.find((localField) => localField.id === activeField.fieldId)
      : undefined;

    return field ? ZFullFieldSchema.parse(field) : null;
  }, [activeField, localPageFields]);

  const getInlineInitialValue = (field: NonNullable<typeof activeLocalField>) =>
    activeField?.initialValue ?? getInlineInitialText(field, commitOptions);

  const getInlineFieldPlaceholder = (field: NonNullable<typeof activeLocalField>) => {
    const translations = getClientSideFieldTranslations(i18n);

    const typeName =
      field.type === FieldType.NAME
        ? translations.namePart[getFieldNamePart(field.fieldMeta)]
        : translations[field.type];

    return field.fieldMeta?.placeholder || field.fieldMeta?.label || typeName;
  };

  if (!currentEnvelopeItem) {
    return null;
  }

  return (
    <>
      {showPendingFieldTooltip &&
        recipientFieldsRemainingForNavigation.length > 0 &&
        recipientFieldsRemainingForNavigation[0]?.envelopeItemId === currentEnvelopeItem?.id &&
        recipientFieldsRemainingForNavigation[0]?.page === pageNumber &&
        recipientFieldsRemainingForNavigation[0]?.id !== activeField?.fieldId && (
          <EnvelopeFieldToolTip
            key={recipientFieldsRemainingForNavigation[0].id}
            field={recipientFieldsRemainingForNavigation[0]}
            color="warning"
          >
            <Trans>Click to insert field</Trans>
          </EnvelopeFieldToolTip>
        )}

      {localPageOtherRecipientFields.map((field) => (
        <EnvelopeRecipientFieldTooltip
          key={field.id}
          field={field}
          showFieldStatus={true}
          showRecipientTooltip={true}
        />
      ))}

      {activeLocalField && getInlineEditKind(activeLocalField) === 'comb' && (
        <EnvelopeSignerInlineCombEditor
          key={activeLocalField.id}
          field={activeLocalField}
          pageWidth={unscaledViewport.width}
          pageHeight={unscaledViewport.height}
          scale={scale}
          initialValue={getInlineInitialValue(activeLocalField)}
          initialCaret={activeField?.caretIndex}
          label={getInlineFieldPlaceholder(activeLocalField)}
          onCommit={(draft) => commitInlineField(activeLocalField.id, draft)}
          onClose={() => closeInlineField(activeLocalField.id)}
          onNavigate={(direction) => navigateInlineField(activeLocalField.id, direction)}
        />
      )}

      {activeLocalField && getInlineEditKind(activeLocalField) === 'text' && (
        <EnvelopeSignerInlineFieldEditor
          key={activeLocalField.id}
          field={activeLocalField}
          pageWidth={unscaledViewport.width}
          pageHeight={unscaledViewport.height}
          scale={scale}
          initialValue={getInlineInitialValue(activeLocalField)}
          placeholder={getInlineFieldPlaceholder(activeLocalField)}
          onCommit={(draft) => commitInlineField(activeLocalField.id, draft)}
          onClose={() => closeInlineField(activeLocalField.id)}
          onNavigate={(direction) => navigateInlineField(activeLocalField.id, direction)}
        />
      )}

      {activeLocalField && getInlineEditKind(activeLocalField) === 'date' && (
        <EnvelopeSignerInlineDateEditor
          key={activeLocalField.id}
          field={activeLocalField}
          pageWidth={unscaledViewport.width}
          pageHeight={unscaledViewport.height}
          scale={scale}
          initialValue={getInlineInitialValue(activeLocalField)}
          label={getInlineFieldPlaceholder(activeLocalField)}
          commitOptions={commitOptions}
          onCommit={(draft) => commitInlineField(activeLocalField.id, draft)}
          onClose={() => closeInlineField(activeLocalField.id)}
          onNavigate={(direction) => navigateInlineField(activeLocalField.id, direction)}
        />
      )}

      {activeLocalField && getInlineEditKind(activeLocalField) === 'dropdown' && (
        <EnvelopeSignerInlineDropdownEditor
          key={activeLocalField.id}
          field={activeLocalField}
          pageWidth={unscaledViewport.width}
          pageHeight={unscaledViewport.height}
          scale={scale}
          label={getInlineFieldPlaceholder(activeLocalField)}
          onCommit={(value) => commitInlineField(activeLocalField.id, value)}
          onClose={() => closeInlineField(activeLocalField.id)}
          onNavigate={(direction) => navigateInlineField(activeLocalField.id, direction)}
        />
      )}

      {/* The element Konva will inject it's canvas into. */}
      <div className="konva-container absolute inset-0 z-10 w-full" ref={konvaContainer}></div>
    </>
  );
};
