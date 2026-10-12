import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { useLingui } from '@lingui/react/macro';
import { type Field, FieldType, RecipientRole } from '@prisma/client';
import { flushSync } from 'react-dom';

import { useCurrentEnvelopeRender } from '@documenso/lib/client-only/providers/envelope-render-provider';
import { PDF_VIEWER_CONTENT_SELECTOR } from '@documenso/lib/constants/pdf-viewer';
import { ZFullFieldSchema } from '@documenso/lib/types/field';
import { ZFieldMetaSchema, isFullNameField } from '@documenso/lib/types/field-meta';
import { getInlineEditKind } from '@documenso/lib/universal/field-inline-signing/inline-edit-kind';
import {
  getAdjacentField,
  sortFieldsInReadingOrder,
} from '@documenso/lib/universal/field-inline-signing/reading-order';
import {
  type TInlineCommitError,
  type TInlineCommitOptions,
  resolveInlineCommit,
} from '@documenso/lib/universal/field-inline-signing/resolve-inline-commit';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';
import { useToast } from '@documenso/ui/primitives/use-toast';

import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';

import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';
import { useSigningIdentityValues } from './use-signing-identity-values';

export type TActiveInlineField = {
  fieldId: number;
  /**
   * What the editor starts with when it should not start with the field's saved value, e.g. a
   * known name offered when the signer tabs onto an empty name field.
   */
  initialValue?: string;
  /** For a comb field, the cell the signer clicked, so typing starts there. */
  caretIndex?: number;
};

export type TOpenInlineFieldOptions = Omit<TActiveInlineField, 'fieldId'>;

export type TInlineNavigationDirection = 'next' | 'previous';

type EnvelopeSigningInlineEditContextValue = {
  /** The field being typed into in place, if any. At most one at a time. */
  activeField: TActiveInlineField | null;

  /** How the document prints dates, which DATE editors type in. */
  commitOptions: TInlineCommitOptions;

  openInlineField: (fieldId: number, options?: TOpenInlineFieldOptions) => void;

  /** Close the editor for this field. Does nothing if another field has been opened since. */
  closeInlineField: (fieldId: number) => void;

  /**
   * Save what the signer typed into a field.
   *
   * Returns why the value cannot be saved, or null when it was handed to the server (or there was
   * nothing to save). The field shows the new value straight away; if the server rejects it, the
   * field goes back to its saved value and the signer is told.
   */
  commitInlineField: (fieldId: number, draft: string) => TInlineCommitError | null;

  /**
   * Move from one field to the next or previous one in reading order, as Tab and Shift+Tab do,
   * scrolling to it and switching documents if needed. Closes the field at either end.
   */
  navigateInlineField: (fromFieldId: number, direction: TInlineNavigationDirection) => void;

  /**
   * Open a field for typing as if the signer had tabbed onto it, scrolling to it. Returns false,
   * and does nothing, for a field that is not typed in place (a signature, or a name the page
   * fills in by itself).
   */
  openInlineFieldFromKeyboard: (field: Field) => boolean;
};

const EnvelopeSigningInlineEditContext =
  createContext<EnvelopeSigningInlineEditContextValue | null>(null);

export const useEnvelopeSigningInlineEdit = () => {
  const context = useContext(EnvelopeSigningInlineEditContext);

  if (!context) {
    throw new Error('useEnvelopeSigningInlineEdit must be used within its provider');
  }

  return context;
};

/**
 * Tracks the one field being typed into in place on the v2 signing page, saves what is typed, and
 * moves between fields with the keyboard.
 *
 * Lives inside the page view rather than in `EnvelopeSigningProvider` because it has to sit below
 * the envelope render provider: it switches documents when Tab leaves the last field of one, and
 * each page renderer reads the active field to decide whether to draw the editor over one of its
 * fields.
 */
export const EnvelopeSigningInlineEditProvider = ({ children }: { children: React.ReactNode }) => {
  const { t } = useLingui();
  const { toast } = useToast();

  const {
    envelope,
    recipient,
    recipientFieldVisibility,
    visibleRecipientFields,
    selectedAssistantRecipientFields,
    signFieldOptimistic,
    setEmail,
    setFullName,
  } = useRequiredEnvelopeSigningContext();

  const { currentEnvelopeItem, setCurrentEnvelopeItem } = useCurrentEnvelopeRender();

  const { onFieldSigned, onFieldUnsigned } = useEmbedSigningContext() || {};

  const { localEmail, placeholderEmail, isNameLocked, isEmailEditable, getKnownValue } =
    useSigningIdentityValues();

  const [activeField, setActiveField] = useState<TActiveInlineField | null>(null);

  const [pendingNavigation, setPendingNavigation] = useState<{
    fromFieldId: number;
    direction: TInlineNavigationDirection;
  } | null>(null);

  const commitOptions: TInlineCommitOptions = {
    dateFormat: envelope.documentMeta.dateFormat,
    timeZone: envelope.documentMeta.timezone,
  };

  const findField = (fieldId: number): Field | undefined =>
    recipient.fields.find((field) => field.id === fieldId) ??
    envelope.recipients
      .flatMap((envelopeRecipient) => envelopeRecipient.fields)
      .find((field) => field.id === fieldId);

  /**
   * A signer's own field that a conditional visibility rule has just hidden cannot be saved - the
   * server rejects it - so its editor is dropped along with whatever was typed.
   */
  const isHidden = (fieldId: number) => recipientFieldVisibility.get(fieldId) === false;

  useEffect(() => {
    if (activeField && (isHidden(activeField.fieldId) || !findField(activeField.fieldId))) {
      setActiveField(null);
    }
  }, [activeField, recipientFieldVisibility]);

  /**
   * How a field opens when the signer reaches it with the keyboard, or null when it is skipped:
   * read-only fields, fields that are not typed (signatures, checkboxes), and names and emails the
   * page fills in by itself that cannot be changed.
   *
   * An empty name or initials field opens with the value the page knows, so tabbing past it fills
   * it in the same way a click would.
   */
  const getKeyboardEntry = (field: Field): TOpenInlineFieldOptions | null => {
    const fieldMeta = ZFieldMetaSchema.safeParse(field.fieldMeta).data;

    if (fieldMeta?.readOnly || !getInlineEditKind({ type: field.type, fieldMeta })) {
      return null;
    }

    switch (field.type) {
      case FieldType.NAME:
      case FieldType.INITIALS: {
        if (isNameLocked) {
          return null;
        }

        return field.inserted ? {} : { initialValue: getKnownValue(field) };
      }

      case FieldType.EMAIL: {
        if (field.inserted) {
          return isEmailEditable ? {} : null;
        }

        if (!localEmail) {
          return { initialValue: placeholderEmail ?? '' };
        }

        return isEmailEditable ? { initialValue: localEmail } : null;
      }

      default:
        return {};
    }
  };

  /** The fields Tab moves between. */
  const interactiveFields = useMemo(
    () =>
      recipient.role === RecipientRole.ASSISTANT
        ? selectedAssistantRecipientFields
        : visibleRecipientFields,
    [recipient.role, selectedAssistantRecipientFields, visibleRecipientFields],
  );

  const getEnvelopeItemOrder = (envelopeItemId: string) =>
    envelope.envelopeItems.find((item) => item.id === envelopeItemId)?.order ?? 0;

  const openInlineField = (fieldId: number, options?: TOpenInlineFieldOptions) => {
    setActiveField({ fieldId, ...options });
  };

  const closeInlineField = (fieldId: number) => {
    setActiveField((current) => (current?.fieldId === fieldId ? null : current));
  };

  const openFieldAndScrollToIt = (
    field: Field,
    options: TOpenInlineFieldOptions,
    { isFromEventHandler }: { isFromEventHandler: boolean },
  ) => {
    const isEnvelopeItemSwitch = field.envelopeItemId !== currentEnvelopeItem?.id;

    if (isEnvelopeItemSwitch) {
      setCurrentEnvelopeItem(field.envelopeItemId);
    }

    // From a click, the editor is rendered synchronously so it takes focus within the click, which
    // is what lets mobile browsers raise the keyboard.
    if (isFromEventHandler) {
      flushSync(() => setActiveField({ fieldId: field.id, ...options }));
    } else {
      setActiveField({ fieldId: field.id, ...options });
    }

    // An editor scrolls itself into view once it is drawn. A page that is not drawn - far from
    // the current scroll position, or in a document that is only now opening - is scrolled to,
    // which draws it.
    setTimeout(
      () => {
        const isPageDrawn = document.querySelector(`img[data-page-number="${field.page}"]`);

        if (!isPageDrawn) {
          document
            .querySelector(PDF_VIEWER_CONTENT_SELECTOR)
            ?.setAttribute('data-scroll-to-page', String(field.page));
        }
      },
      isEnvelopeItemSwitch ? 150 : 0,
    );
  };

  const openInlineFieldFromKeyboard = (field: Field) => {
    const entry = getKeyboardEntry(field);

    if (!entry) {
      return false;
    }

    openFieldAndScrollToIt(field, entry, { isFromEventHandler: true });

    return true;
  };

  const navigateInlineField = (fromFieldId: number, direction: TInlineNavigationDirection) => {
    // Worked out once the value just saved has been drawn, so a field that value reveals is in
    // the order.
    setPendingNavigation({ fromFieldId, direction });
  };

  useEffect(() => {
    if (!pendingNavigation) {
      return;
    }

    const { fromFieldId, direction } = pendingNavigation;

    setPendingNavigation(null);

    const orderedFields = sortFieldsInReadingOrder(
      interactiveFields.filter(
        (field) => field.id === fromFieldId || getKeyboardEntry(field) !== null,
      ),
      getEnvelopeItemOrder,
    );

    const target = getAdjacentField(orderedFields, fromFieldId, direction);
    const entry = target ? getKeyboardEntry(target) : null;

    if (!target || !entry) {
      closeInlineField(fromFieldId);
      return;
    }

    openFieldAndScrollToIt(target, entry, { isFromEventHandler: false });
  }, [pendingNavigation]);

  const commitInlineField = (fieldId: number, draft: string): TInlineCommitError | null => {
    const unparsedField = findField(fieldId);

    if (!unparsedField || isHidden(fieldId)) {
      return null;
    }

    const field = ZFullFieldSchema.parse(unparsedField);

    if (field.fieldMeta?.readOnly) {
      return null;
    }

    const result = resolveInlineCommit(field, draft, commitOptions);

    if (result.action === 'noop') {
      return null;
    }

    if (result.action === 'invalid') {
      return result.error;
    }

    const { value } = result;

    let payload: TSignEnvelopeFieldValue;

    switch (field.type) {
      case FieldType.TEXT:
      case FieldType.NUMBER:
      case FieldType.NAME:
      case FieldType.EMAIL:
      case FieldType.INITIALS:
      case FieldType.DATE:
      case FieldType.DROPDOWN:
        payload = { type: field.type, value };
        break;

      default:
        return null;
    }

    void signFieldOptimistic(field.id, payload).then((isAccepted) => {
      if (!isAccepted) {
        toast({
          title: t`Error`,
          description: t`An error occurred while signing the field.`,
          variant: 'destructive',
        });

        return;
      }

      // Used within the embedding context, mirroring the click handlers.
      if (value !== null) {
        onFieldSigned?.({ fieldId: field.id, value: JSON.stringify(value), isBase64: false });
      } else {
        onFieldUnsigned?.({ fieldId: field.id });
      }
    });

    // An assistant fills fields for someone else, so what they type is not their own name or
    // email.
    if (value && recipient.role !== RecipientRole.ASSISTANT) {
      if (field.type === FieldType.EMAIL) {
        setEmail(value);
      }

      // A field bound to a single part of the name must not replace the whole name, which also
      // drives the initials and the typed signature.
      if (field.type === FieldType.NAME && isFullNameField(field.fieldMeta)) {
        setFullName(value);
      }
    }

    return null;
  };

  return (
    <EnvelopeSigningInlineEditContext.Provider
      value={{
        activeField,
        commitOptions,
        openInlineField,
        closeInlineField,
        commitInlineField,
        navigateInlineField,
        openInlineFieldFromKeyboard,
      }}
    >
      {children}
    </EnvelopeSigningInlineEditContext.Provider>
  );
};
