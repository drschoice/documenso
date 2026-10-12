import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  EnvelopeType,
  type Field,
  FieldType,
  type Recipient,
  RecipientRole,
  SigningStatus,
} from '@prisma/client';

import { isBase64Image } from '@documenso/lib/constants/signatures';
import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import type { EnvelopeForSigningResponse } from '@documenso/lib/server-only/envelope/get-envelope-for-recipient-signing';
import type { TRecipientActionAuth } from '@documenso/lib/types/document-auth';
import { getFieldsWrittenBySign } from '@documenso/lib/universal/field-inline-signing/optimistic-insertion';
import { sortFieldsInReadingOrder } from '@documenso/lib/universal/field-inline-signing/reading-order';
import { evaluateAllVisibility } from '@documenso/lib/universal/field-visibility';
import {
  isFieldUnsignedAndRequired,
  isRequiredField,
} from '@documenso/lib/utils/advanced-fields-helpers';
import { extractFieldInsertionValues } from '@documenso/lib/utils/envelope-signing';
import type { RecipientNameParts } from '@documenso/lib/utils/recipient-formatter';
import {
  buildRecipientFullName,
  getRecipientNameParts,
  splitFullName,
} from '@documenso/lib/utils/recipient-formatter';
import { trpc } from '@documenso/trpc/react';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';

export type EnvelopeSigningContextValue = {
  isDirectTemplate: boolean;

  fullName: string;
  setFullName: (_value: string) => void;
  /**
   * The signer's name broken into parts. NAME fields bound to a single part read from here.
   *
   * Kept in step with `fullName` in both directions: editing a part rebuilds the full name, and
   * overwriting the full name re-splits it into parts.
   */
  nameParts: RecipientNameParts;
  setNamePart: (_part: keyof RecipientNameParts, _value: string) => void;
  email: string;
  setEmail: (_value: string) => void;
  signature: string | null;
  setSignature: (_value: string | null) => void;

  showPendingFieldTooltip: boolean;
  setShowPendingFieldTooltip: (_value: boolean) => void;

  envelopeData: EnvelopeForSigningResponse;
  envelope: EnvelopeForSigningResponse['envelope'];

  recipient: EnvelopeForSigningResponse['recipient'];
  recipientFieldsRemaining: Field[];
  recipientFieldsRemainingForNavigation: Field[];
  recipientFields: Field[];
  recipientFieldVisibility: Map<number, boolean>;
  visibleRecipientFields: Field[];
  requiredRecipientFields: Field[];
  selectedAssistantRecipientFields: Field[];
  nextRecipient: EnvelopeForSigningResponse['envelope']['recipients'][number] | null;
  otherRecipientCompletedFields: (Field & {
    recipient: Pick<Recipient, 'name' | 'email' | 'signingStatus' | 'role'>;
  })[];
  assistantRecipients: EnvelopeForSigningResponse['envelope']['recipients'];
  assistantFields: Field[];
  setSelectedAssistantRecipientId: (_value: number | null) => void;
  selectedAssistantRecipient: EnvelopeForSigningResponse['envelope']['recipients'][number] | null;

  signField: (
    _fieldId: number,
    _value: TSignEnvelopeFieldValue,
    authOptions?: TRecipientActionAuth,
  ) => Promise<Pick<Field, 'id' | 'inserted'>>;

  /**
   * Sign a field and show the result straight away, before the server confirms it.
   *
   * Used for values typed in place, where waiting for the round trip would make the field blink
   * back to its old value as the signer moves on. Requests for the same field are sent one at a
   * time, and only the newest value is sent: one typed while an older request is in flight
   * replaces it. If the server rejects the newest value, the field goes back to what the server
   * last confirmed.
   *
   * Resolves `false` when the value was rejected, `true` otherwise. Never rejects.
   */
  signFieldOptimistic: (_fieldId: number, _value: TSignEnvelopeFieldValue) => Promise<boolean>;

  /**
   * Wait for every `signFieldOptimistic` request still in flight. Resolves `false` if any of them
   * was rejected while waiting, so completion can stop rather than submit a field the server does
   * not have.
   */
  flushPendingSignatures: () => Promise<boolean>;
};

type TFieldWrite = Pick<Field, 'customText' | 'inserted'>;

type TPendingSignature = {
  /** Bumped on every optimistic write, so a stale response can tell it has been superseded. */
  version: number;
  /** The requests for this field, chained so they reach the server in order. */
  queue: Promise<void>;
};

const EnvelopeSigningContext = createContext<EnvelopeSigningContextValue | null>(null);

export const useEnvelopeSigningContext = () => {
  return useContext(EnvelopeSigningContext);
};

export const useRequiredEnvelopeSigningContext = () => {
  const context = useEnvelopeSigningContext();

  if (!context) {
    throw new Error('Signing context is required');
  }

  return context;
};

export interface EnvelopeSigningProviderProps {
  fullName?: string | null;
  email?: string | null;
  signature?: string | null;
  envelopeData: EnvelopeForSigningResponse;
  children: React.ReactNode;
}

export const EnvelopeSigningProvider = ({
  fullName: initialFullName,
  email: initialEmail,
  signature: initialSignature,
  envelopeData: initialEnvelopeData,
  children,
}: EnvelopeSigningProviderProps) => {
  const [envelopeData, setEnvelopeData] = useState(initialEnvelopeData);

  const { envelope, recipient } = envelopeData;

  const [nameParts, setNameParts] = useState<RecipientNameParts>(() =>
    initialFullName && initialFullName !== recipient.name
      ? splitFullName(initialFullName)
      : getRecipientNameParts({ ...recipient, name: initialFullName || recipient.name }),
  );

  // The full name is what the parts add up to, unless the signer overwrote it with something that
  // isn't simply the parts joined (e.g. a mononym or a different ordering).
  const [fullNameOverride, setFullNameOverride] = useState<string | null>(null);

  const fullName = fullNameOverride ?? buildRecipientFullName(nameParts);

  const setFullName = (value: string) => {
    // Re-setting the same full name must not re-split it. Signing a full-name field echoes its value
    // back through here, and splitting "Jean Luc Q de la Cruz" would overwrite the parts the signer
    // actually typed with a naive first/middle/last guess.
    if (value === fullName) {
      return;
    }

    // An overwritten full name still has to feed the part-bound fields, so split it back out.
    const parts = splitFullName(value);

    setNameParts(parts);
    setFullNameOverride(buildRecipientFullName(parts) === value ? null : value);
  };

  const setNamePart = (part: keyof RecipientNameParts, value: string) => {
    setFullNameOverride(null);
    setNameParts((prev) => ({ ...prev, [part]: value }));
  };

  const [email, setEmail] = useState(initialEmail || '');

  const [showPendingFieldTooltip, setShowPendingFieldTooltip] = useState(false);

  const isDirectTemplate = envelope.type === EnvelopeType.TEMPLATE;

  // Read by the optimistic signing path, which runs outside a render and needs the fields as they
  // stand rather than as they were when the callback was created.
  const envelopeDataRef = useRef(envelopeData);
  envelopeDataRef.current = envelopeData;

  /**
   * Merge field updates into every copy of those fields: the signer's own list, and the per
   * recipient lists, which is where an assistant's fields and other signers' fields live.
   */
  const patchFields = (updates: Map<number, Partial<Field>>) => {
    if (updates.size === 0) {
      return;
    }

    const applyUpdates = <T extends { id: number }>(fields: T[]): T[] => {
      let isChanged = false;

      const nextFields = fields.map((field) => {
        const update = updates.get(field.id);

        if (!update) {
          return field;
        }

        isChanged = true;

        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        return { ...field, ...update } as T;
      });

      return isChanged ? nextFields : fields;
    };

    setEnvelopeData((prev) => ({
      ...prev,
      envelope: {
        ...prev.envelope,
        recipients: prev.envelope.recipients.map((envelopeRecipient) => {
          const fields = applyUpdates(envelopeRecipient.fields);

          return fields === envelopeRecipient.fields
            ? envelopeRecipient
            : { ...envelopeRecipient, fields };
        }),
      },
      recipient: {
        ...prev.recipient,
        fields: applyUpdates(prev.recipient.fields),
      },
    }));
  };

  const { mutateAsync: signEnvelopeField } = trpc.envelope.field.sign.useMutation({
    ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
  });

  /**
   * Apply a sign response: the signed field plus any copy-and-link group members the server
   * updated with the same value in the same transaction, so linked fields (including ones on
   * other pages) re-render immediately.
   */
  const applySignResponse = (data: Awaited<ReturnType<typeof signEnvelopeField>>) => {
    patchFields(
      new Map([data.signedField, ...data.linkedFields].map((field) => [field.id, field])),
    );
  };

  // Ensure the user signature doesn't show up if it's not allowed.
  const [signature, setSignature] = useState(
    (() => {
      const sig = initialSignature || '';
      const isBase64 = isBase64Image(sig);

      if (
        !sig &&
        (envelope.documentMeta.uploadSignatureEnabled ||
          envelope.documentMeta.drawSignatureEnabled) &&
        envelopeData.recipientSignature?.signatureImageAsBase64
      ) {
        return envelopeData.recipientSignature.signatureImageAsBase64;
      }

      if (
        !sig &&
        envelope.documentMeta.typedSignatureEnabled &&
        envelopeData.recipientSignature?.typedSignature
      ) {
        return envelopeData.recipientSignature.typedSignature;
      }

      if (
        isBase64 &&
        (envelope.documentMeta.uploadSignatureEnabled || envelope.documentMeta.drawSignatureEnabled)
      ) {
        return sig;
      }

      if (!isBase64 && envelope.documentMeta.typedSignatureEnabled) {
        return sig;
      }

      return null;
    })(),
  );

  /**
   * All the required fields for the actual recipient.
   */
  const requiredRecipientFields = useMemo(() => {
    return envelopeData.recipient.fields.filter((field) => isRequiredField(field));
  }, [envelopeData.recipient.fields]);

  /**
   * All the fields for the actual recipient.
   */
  const recipientFields = useMemo(() => {
    return envelopeData.recipient.fields;
  }, [envelopeData.recipient.fields]);

  /**
   * Visibility map for each recipient field (field id -> visible).
   * A missing entry means the field is visible by default.
   */
  const recipientFieldVisibility = useMemo(() => {
    return evaluateAllVisibility(
      recipientFields.map((f) => ({
        id: f.id,
        type: f.type,
        customText: f.customText,
        inserted: f.inserted,
        fieldMeta: f.fieldMeta,
      })),
    );
  }, [recipientFields]);

  /**
   * Recipient fields that are currently visible (not hidden by conditional logic).
   */
  const visibleRecipientFields = useMemo(() => {
    return recipientFields.filter((f) => recipientFieldVisibility.get(f.id) !== false);
  }, [recipientFields, recipientFieldVisibility]);

  const prevVisibilityRef = useRef<Map<number, boolean>>(new Map());
  const [revealedFieldLabel, setRevealedFieldLabel] = useState<string | null>(null);

  useEffect(() => {
    const prev = prevVisibilityRef.current;
    const newlyVisible = Array.from(recipientFieldVisibility.entries()).filter(
      ([id, visible]) => visible && prev.get(id) === false,
    );

    if (newlyVisible.length > 0) {
      const [firstId] = newlyVisible[0];
      const field = recipientFields.find((f) => f.id === firstId);
      const meta = field?.fieldMeta as { label?: string } | null;
      setRevealedFieldLabel(meta?.label ?? 'New required field');
      const timer = setTimeout(() => setRevealedFieldLabel(null), 2000);
      prevVisibilityRef.current = new Map(recipientFieldVisibility);
      return () => clearTimeout(timer);
    }

    prevVisibilityRef.current = new Map(recipientFieldVisibility);
  }, [recipientFieldVisibility, recipientFields]);

  const getEnvelopeItemOrder = (envelopeItemId: string) =>
    envelope.envelopeItems.find((item) => item.id === envelopeItemId)?.order ?? 0;

  /**
   * The fields that are still required to be signed by the actual recipient, in reading order.
   */
  const recipientFieldsRemaining = useMemo(() => {
    const requiredFields = envelopeData.recipient.fields
      .filter((field) => isFieldUnsignedAndRequired(field))
      .filter((field) => recipientFieldVisibility.get(field.id) !== false)
      .map((field) => {
        const envelopeItem = envelope.envelopeItems.find(
          (item) => item.id === field.envelopeItemId,
        );

        if (!envelopeItem) {
          throw new Error('Missing envelope item');
        }

        return {
          ...field,
          envelopeItemOrder: envelopeItem.order,
        };
      });

    return sortFieldsInReadingOrder(requiredFields, getEnvelopeItemOrder);
  }, [envelopeData.recipient.fields, recipientFieldVisibility]);

  /**
   * A filtered subset used for "Next" button navigation.
   * When nextFieldNavigationTypes and/or nextFieldNavigationLabels are configured,
   * only fields matching any of the specified types OR labels are included.
   * The base is all unsigned visible fields (required + optional) so that optional
   * fields matching the filter are reachable via Next.
   * Falls back to required-only remaining fields when no filter is configured.
   */
  const recipientFieldsRemainingForNavigation = useMemo(() => {
    const navigationTypes = envelope.documentMeta.nextFieldNavigationTypes;
    const navigationLabels = envelope.documentMeta.nextFieldNavigationLabels;

    const hasTypeFilter = navigationTypes && navigationTypes.length > 0;
    const hasLabelFilter = navigationLabels && navigationLabels.length > 0;

    if (!hasTypeFilter && !hasLabelFilter) {
      return recipientFieldsRemaining;
    }

    // Build a sorted list of ALL unsigned visible fields (required + optional)
    // so optional fields matching the filter are included in navigation.
    const allUnsignedFields = visibleRecipientFields
      .filter((field) => !field.inserted)
      .map((field) => {
        const envelopeItem = envelope.envelopeItems.find(
          (item) => item.id === field.envelopeItemId,
        );

        if (!envelopeItem) {
          return null;
        }

        return { ...field, envelopeItemOrder: envelopeItem.order };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    const sortedFields = sortFieldsInReadingOrder(allUnsignedFields, getEnvelopeItemOrder);

    return sortedFields.filter((field) => {
      if (hasTypeFilter && navigationTypes.includes(field.type)) {
        return true;
      }

      if (hasLabelFilter) {
        const fieldLabel = (field.fieldMeta as { label?: string } | null)?.label;
        if (fieldLabel && navigationLabels.includes(fieldLabel)) {
          return true;
        }
      }

      return false;
    });
  }, [
    recipientFieldsRemaining,
    visibleRecipientFields,
    envelope.envelopeItems,
    envelope.documentMeta.nextFieldNavigationTypes,
    envelope.documentMeta.nextFieldNavigationLabels,
  ]);

  /**
   * Assistant recipients are those that have a signing order after the assistant.
   */
  const assistantRecipients =
    recipient.role === RecipientRole.ASSISTANT
      ? envelope.recipients.filter((r) => (r.signingOrder ?? 0) > (recipient.signingOrder ?? 0))
      : [];

  /**
   * Assistant fields are those fulfill all of the following:
   * - From recipients that have not signed
   * - After the assistant signing order
   * - Are not signature fields
   */
  const assistantFields =
    recipient.role === RecipientRole.ASSISTANT
      ? assistantRecipients
          .filter((r) => r.signingStatus !== SigningStatus.SIGNED)
          .map((r) => r.fields.filter((field) => field.type !== FieldType.SIGNATURE))
          .flat()
      : [];

  /**
   * The recipient that the assistant has currently selected to sign on behalf of.
   */
  const [selectedAssistantRecipientId, setSelectedAssistantRecipientId] = useState<number | null>(
    assistantRecipients[0]?.id || null,
  );

  const selectedAssistantRecipient = useMemo(() => {
    return envelope.recipients.find((r) => r.id === selectedAssistantRecipientId) || null;
  }, [envelope.recipients, selectedAssistantRecipientId]);

  const selectedAssistantRecipientFields = useMemo(() => {
    return assistantFields.filter((field) => field.recipientId === selectedAssistantRecipient?.id);
  }, [recipientFields, selectedAssistantRecipient]);

  /**
   * Fields that have been completed by other recipients.
   */
  const otherRecipientCompletedFields = envelope.recipients
    .filter(({ signingStatus }) => signingStatus === SigningStatus.SIGNED)
    .flatMap((recipient) =>
      recipient.fields.map((field) => ({
        ...field,
        recipient: {
          name: recipient.name,
          email: recipient.email,
          signingStatus: recipient.signingStatus,
          role: recipient.role,
        },
      })),
    )
    .filter((field) => field.inserted);

  const nextRecipient = useMemo(() => {
    if (
      !envelope.documentMeta.signingOrder ||
      envelope.documentMeta.signingOrder !== 'SEQUENTIAL'
    ) {
      return null;
    }

    const sortedRecipients = envelope.recipients.sort((a, b) => {
      // Sort by signingOrder first (nulls last), then by id
      if (a.signingOrder === null && b.signingOrder === null) return a.id - b.id;
      if (a.signingOrder === null) return 1;
      if (b.signingOrder === null) return -1;
      if (a.signingOrder === b.signingOrder) return a.id - b.id;
      return a.signingOrder - b.signingOrder;
    });

    const currentIndex = sortedRecipients.findIndex((r) => r.id === recipient.id);

    return currentIndex !== -1 && currentIndex < sortedRecipients.length - 1
      ? sortedRecipients[currentIndex + 1]
      : null;
  }, [envelope.documentMeta?.signingOrder, envelope.recipients, recipient.id]);

  const signField = async (
    fieldId: number,
    fieldValue: TSignEnvelopeFieldValue,
    authOptions?: TRecipientActionAuth,
  ) => {
    // Set the field locally for direct templates.
    if (isDirectTemplate) {
      const signedField = handleDirectTemplateFieldInsertion(fieldId, fieldValue);

      return signedField;
    }

    const response = await signEnvelopeField({
      token: envelopeData.recipient.token,
      fieldId,
      fieldValue,
      authOptions,
    });

    applySignResponse(response);

    return response.signedField;
  };

  const pendingSignaturesRef = useRef(new Map<number, TPendingSignature>());
  const signatureVersionRef = useRef(0);

  /**
   * What the server last confirmed for each field an optimistic write has touched, so a rejected
   * write can be undone. Only set while a write is unconfirmed.
   */
  const confirmedFieldValuesRef = useRef(new Map<number, TFieldWrite>());

  /** Counts rolled-back writes, so a flush can tell whether one failed while it waited. */
  const rejectedSignatureCountRef = useRef(0);

  const findField = (fieldId: number) => {
    const { recipient: currentRecipient, envelope: currentEnvelope } = envelopeDataRef.current;

    return (
      currentRecipient.fields.find((field) => field.id === fieldId) ??
      currentEnvelope.recipients
        .flatMap((envelopeRecipient) => envelopeRecipient.fields)
        .find((field) => field.id === fieldId)
    );
  };

  const signFieldOptimistic = async (
    fieldId: number,
    fieldValue: TSignEnvelopeFieldValue,
  ): Promise<boolean> => {
    const field = findField(fieldId);

    if (!field) {
      return false;
    }

    const ownerFields =
      envelopeDataRef.current.envelope.recipients.find(
        (envelopeRecipient) => envelopeRecipient.id === field.recipientId,
      )?.fields ?? envelopeDataRef.current.recipient.fields;

    let fieldWrite: TFieldWrite;

    try {
      fieldWrite = extractFieldInsertionValues({
        fieldValue,
        field,
        documentMeta: envelope.documentMeta,
      });
    } catch (err) {
      // Callers validate first, so this is a value the shared validators accept but the
      // insertion rules do not. Treat it like a rejection from the server.
      console.error(err);

      return false;
    }

    const writtenFields = getFieldsWrittenBySign(ownerFields, field);

    // Remember what the server has for each field before the first unconfirmed write to it.
    for (const writtenField of writtenFields) {
      if (!confirmedFieldValuesRef.current.has(writtenField.id)) {
        confirmedFieldValuesRef.current.set(writtenField.id, {
          customText: writtenField.customText,
          inserted: writtenField.inserted,
        });
      }
    }

    patchFields(new Map(writtenFields.map((writtenField) => [writtenField.id, fieldWrite])));

    // Direct templates are filled in locally and submitted in one go at the end.
    if (isDirectTemplate) {
      for (const writtenField of writtenFields) {
        confirmedFieldValuesRef.current.delete(writtenField.id);
      }

      return true;
    }

    const pending = pendingSignaturesRef.current.get(fieldId) ?? {
      version: 0,
      queue: Promise.resolve(),
    };

    // Unique across fields, so a request left over from an earlier entry for this field can never
    // mistake a later entry for its own.
    signatureVersionRef.current += 1;

    const version = signatureVersionRef.current;

    pending.version = version;
    pendingSignaturesRef.current.set(fieldId, pending);

    const isLatest = () => pendingSignaturesRef.current.get(fieldId)?.version === version;

    let isAccepted = true;

    pending.queue = pending.queue.then(async () => {
      // A newer value was written while this one waited its turn. Sending it would only add an
      // audit log entry for a value the signer has already replaced.
      if (!isLatest()) {
        return;
      }

      try {
        const response = await signEnvelopeField({
          token: envelopeDataRef.current.recipient.token,
          fieldId,
          fieldValue,
        });

        if (isLatest()) {
          applySignResponse(response);

          for (const writtenField of writtenFields) {
            confirmedFieldValuesRef.current.delete(writtenField.id);
          }

          return;
        }

        // A newer value is waiting to be sent. Until it is confirmed, this is what the server
        // holds, and what a rejection of the newer value has to go back to.
        for (const savedField of [response.signedField, ...response.linkedFields]) {
          if (confirmedFieldValuesRef.current.has(savedField.id)) {
            confirmedFieldValuesRef.current.set(savedField.id, {
              customText: savedField.customText,
              inserted: savedField.inserted,
            });
          }
        }
      } catch (err) {
        console.error(err);

        if (!isLatest()) {
          return;
        }

        isAccepted = false;
        rejectedSignatureCountRef.current += 1;

        const rollback = new Map<number, TFieldWrite>();

        for (const writtenField of writtenFields) {
          const confirmed = confirmedFieldValuesRef.current.get(writtenField.id);

          if (confirmed) {
            rollback.set(writtenField.id, confirmed);
            confirmedFieldValuesRef.current.delete(writtenField.id);
          }
        }

        patchFields(rollback);
      } finally {
        if (isLatest()) {
          pendingSignaturesRef.current.delete(fieldId);
        }
      }
    });

    await pending.queue;

    return isAccepted;
  };

  const flushPendingSignatures = async () => {
    const rejectedBefore = rejectedSignatureCountRef.current;

    // Keep waiting until nothing is queued: a request can be added while an earlier one finishes.
    while (pendingSignaturesRef.current.size > 0) {
      const queues = Array.from(pendingSignaturesRef.current.values()).map(
        async ({ queue }) => queue,
      );

      await Promise.all(queues);
    }

    return rejectedSignatureCountRef.current === rejectedBefore;
  };

  const handleDirectTemplateFieldInsertion = (
    fieldId: number,
    fieldValue: TSignEnvelopeFieldValue,
  ) => {
    const foundField = recipient.fields.find((field) => field.id === fieldId);

    if (!foundField) {
      throw new Error('Not possible');
    }

    const insertionValues = extractFieldInsertionValues({
      fieldValue,
      field: foundField,
      documentMeta: envelope.documentMeta,
    });

    const updatedField = {
      ...foundField,
      ...insertionValues,
    };

    if (fieldValue.type === FieldType.SIGNATURE) {
      const isBase64 = isBase64Image(fieldValue.value || '');

      updatedField.signature = fieldValue.value
        ? {
            signatureImageAsBase64: isBase64 ? fieldValue.value : null,
            typedSignature: isBase64 ? null : fieldValue.value,
            recipientId: recipient.id,
            created: new Date(),
            // Dummy IDs.
            id: 0,
            fieldId: 0,
          }
        : null;
    }

    setEnvelopeData((prev) => ({
      ...prev,
      envelope: {
        ...prev.envelope,
        recipients: prev.envelope.recipients.map((r) =>
          r.id === recipient.id
            ? {
                ...r,
                fields: r.fields.map((field) => (field.id === fieldId ? updatedField : field)),
              }
            : r,
        ),
      },
      recipient: {
        ...prev.recipient,
        fields: prev.recipient.fields.map((field) => (field.id === fieldId ? updatedField : field)),
      },
    }));

    return updatedField;
  };

  return (
    <EnvelopeSigningContext.Provider
      value={{
        isDirectTemplate,
        fullName,
        setFullName,
        nameParts,
        setNamePart,
        email,
        setEmail,
        signature,
        setSignature,
        envelopeData,
        envelope,

        showPendingFieldTooltip,
        setShowPendingFieldTooltip,

        recipient,
        recipientFieldsRemaining,
        recipientFieldsRemainingForNavigation,
        recipientFields,
        recipientFieldVisibility,
        visibleRecipientFields,
        requiredRecipientFields,
        nextRecipient,

        otherRecipientCompletedFields,
        assistantRecipients,
        assistantFields,
        setSelectedAssistantRecipientId,
        selectedAssistantRecipient,
        selectedAssistantRecipientFields,

        signField,
        signFieldOptimistic,
        flushPendingSignatures,
      }}
    >
      {children}
      <div
        // Invisible chrome: clipped to a single pixel with nothing else to
        // address it by, and `role="status"` alone is shared with the toaster.
        data-testid="revealed-field-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          border: 0,
        }}
      >
        {revealedFieldLabel ? `Field revealed: ${revealedFieldLabel}` : ''}
      </div>
    </EnvelopeSigningContext.Provider>
  );
};

EnvelopeSigningProvider.displayName = 'EnvelopeSigningProvider';
