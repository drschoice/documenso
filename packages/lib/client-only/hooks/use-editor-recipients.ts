import { IS_INSTANCE_CSC_MODE } from '@documenso/lib/constants/app';
import { ZRecipientActionAuthTypesSchema, ZRecipientAuthOptionsSchema } from '@documenso/lib/types/document-auth';
import type { TEditorEnvelope } from '@documenso/lib/types/envelope-editor';
import { ZRecipientEmailSchema } from '@documenso/lib/types/recipient';
import { zodResolver } from '@hookform/resolvers/zod';
import { DocumentSigningOrder, EnvelopeType, RecipientRole } from '@prisma/client';
import { useId } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { buildRecipientFullName, getRecipientNameParts, splitFullName } from '../../utils/recipient-formatter';
import { normalizeGroupedSigningOrders } from '../../utils/recipient-groups';
import { canRecipientBeModified, isCcRecipient, sortRecipientsForSigningOrder } from '../../utils/recipients';

const LocalRecipientSchema = z.object({
  formId: z.string().min(1),
  id: z.number().optional(),
  email: ZRecipientEmailSchema,
  // `name` is derived from the parts below and is not edited directly. It is kept on the form so
  // the rest of the editor (chips, selectors, previews) can keep reading a single full name.
  name: z.string(),
  firstName: z.string().max(255),
  middleName: z.string().max(255),
  lastName: z.string().max(255),
  role: z.nativeEnum(RecipientRole),
  signingOrder: z.number().optional(),
  actionAuth: z.array(ZRecipientActionAuthTypesSchema).optional().default([]),
});

type TLocalRecipient = z.infer<typeof LocalRecipientSchema>;

/**
 * Backstop validation that mirrors the CSC-mode UI overrides in
 * `EnvelopeEditorProvider`. If anything bypasses the disabled controls (URL
 * tampering, legacy form state, embedded host) the form refuses to submit
 * rather than persisting values the TSP flow can't honour.
 */
export const ZEditorRecipientsFormSchema = z
  .object({
    signers: z.array(LocalRecipientSchema),
    signingOrder: z.nativeEnum(DocumentSigningOrder),
    allowDictateNextSigner: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (!IS_INSTANCE_CSC_MODE()) {
      return;
    }

    if (data.signingOrder !== DocumentSigningOrder.SEQUENTIAL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CSC envelopes must use SEQUENTIAL signing order.',
        path: ['signingOrder'],
      });
    }

    if (data.allowDictateNextSigner) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CSC envelopes do not support next-signer dictation.',
        path: ['allowDictateNextSigner'],
      });
    }

    data.signers.forEach((signer, index) => {
      if (signer.role === RecipientRole.ASSISTANT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CSC envelopes do not support the assistant role.',
          path: ['signers', index, 'role'],
        });
      }
    });

    const seenSigningOrders = new Set<number>();

    data.signers.forEach((signer, index) => {
      if (signer.role === RecipientRole.CC || typeof signer.signingOrder !== 'number') {
        return;
      }

      if (seenSigningOrders.has(signer.signingOrder)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CSC envelopes do not support recipient signing groups.',
          path: ['signers', index, 'signingOrder'],
        });
      }

      seenSigningOrders.add(signer.signingOrder);
    });
  });

export type TEditorRecipientsFormSchema = z.infer<typeof ZEditorRecipientsFormSchema>;

/**
 * Replaces the signers array while keeping controlled inputs in sync.
 *
 * Rows are rendered with stable `formId` keys (required for drag and drop),
 * so react-hook-form `Controller`s never remount and their leaf
 * subscriptions are NOT re-notified by a root-level array `setValue`. Any
 * value that changes while a signer keeps its index (e.g. a role change)
 * must be leaf-set first so the controlled input actually re-renders.
 */
export const updateEditorSigners = (
  form: UseFormReturn<TEditorRecipientsFormSchema>,
  updatedSigners: TEditorRecipientsFormSchema['signers'],
) => {
  const previousSigners = form.getValues('signers');

  updatedSigners.forEach((signer, index) => {
    const previousSigner = previousSigners[index];

    // Only slot-stable signers need leaf notifications — moved signers get a
    // new field name and re-subscribe with fresh values on their own.
    if (!previousSigner || previousSigner.formId !== signer.formId) {
      return;
    }

    if (previousSigner.role !== signer.role) {
      form.setValue(`signers.${index}.role`, signer.role, { shouldDirty: true });
    }

    if (previousSigner.email !== signer.email) {
      form.setValue(`signers.${index}.email`, signer.email, { shouldDirty: true });
    }

    if (previousSigner.name !== signer.name) {
      form.setValue(`signers.${index}.name`, signer.name, { shouldDirty: true });
    }

    // The rows edit the name through its parts, so those are the controlled inputs to notify.
    for (const part of ['firstName', 'middleName', 'lastName'] as const) {
      if (previousSigner[part] !== signer[part]) {
        form.setValue(`signers.${index}.${part}`, signer[part], { shouldDirty: true });
      }
    }
  });

  // Fully set signers array to populate the rest of the values.
  form.setValue('signers', updatedSigners, {
    shouldValidate: true,
    shouldDirty: true,
  });
};

/**
 * Expand a full name that came from somewhere else — the signed-in user, a recipient suggestion,
 * or AI detection — into the name fields the editor form holds.
 */
export const toEditorSignerName = (fullName: string) => {
  const parts = splitFullName(fullName);

  return { name: buildRecipientFullName(parts), ...parts };
};

/**
 * Set a signer's name from a full name, splitting it into the parts the row inputs edit.
 */
export const setEditorSignerFullName = (
  form: UseFormReturn<TEditorRecipientsFormSchema>,
  signerIndex: number,
  fullName: string,
) => {
  const { name, firstName, middleName, lastName } = toEditorSignerName(fullName);

  const options = { shouldValidate: true, shouldDirty: true };

  form.setValue(`signers.${signerIndex}.name`, name, options);
  form.setValue(`signers.${signerIndex}.firstName`, firstName, options);
  form.setValue(`signers.${signerIndex}.middleName`, middleName, options);
  form.setValue(`signers.${signerIndex}.lastName`, lastName, options);
};

type EditorRecipientsProps = {
  envelope: TEditorEnvelope;
};

type ResetFormOptions = {
  recipients?: TEditorEnvelope['recipients'];
  documentMeta?: TEditorEnvelope['documentMeta'];
};

type UseEditorRecipientsResponse = {
  form: UseFormReturn<TEditorRecipientsFormSchema>;
  resetForm: (options?: ResetFormOptions) => void;
};

export const useEditorRecipients = ({ envelope }: EditorRecipientsProps): UseEditorRecipientsResponse => {
  const initialId = useId();

  const generateDefaultValues = (options?: ResetFormOptions) => {
    const { recipients, documentMeta } = options ?? {};

    const sourceRecipients = sortRecipientsForSigningOrder(recipients || envelope.recipients);

    // Locked recipients hold persisted values the server refuses to rewrite.
    // Initialization must never assign or renumber their signing orders —
    // doing so makes the very first autosave submit a "changed" locked
    // recipient, which the server rejects on every subsequent save.
    const isRecipientLocked = (recipientId: number) => {
      if (envelope.type === EnvelopeType.TEMPLATE) {
        return false;
      }

      const persistedRecipient = sourceRecipients.find((recipient) => recipient.id === recipientId);

      if (!persistedRecipient) {
        return false;
      }

      return !canRecipientBeModified(persistedRecipient, envelope.fields);
    };

    // Persisted orders round-trip as-is; `normalizeGroupedSigningOrders`
    // decides whether an unordered recipient can be numbered.
    const formRecipients = sourceRecipients.map((recipient) => ({
      id: recipient.id,
      formId: String(recipient.id),
      name: recipient.name,
      // Recipients created before the name was split — and those created through name-only APIs —
      // have no parts stored, so seed the inputs by splitting their full name.
      ...getRecipientNameParts(recipient),
      email: recipient.email,
      role: recipient.role,
      signingOrder: isCcRecipient(recipient) ? undefined : (recipient.signingOrder ?? undefined),
      actionAuth: ZRecipientAuthOptionsSchema.parse(recipient.authOptions)?.actionAuth ?? undefined,
    }));

    const signers: TLocalRecipient[] =
      formRecipients.length > 0
        ? normalizeGroupedSigningOrders(formRecipients, (formRecipient) => !isRecipientLocked(formRecipient.id))
        : [
            {
              formId: initialId,
              name: '',
              firstName: '',
              middleName: '',
              lastName: '',
              email: '',
              role: RecipientRole.SIGNER,
              signingOrder: 1,
              actionAuth: [],
            },
          ];

    return {
      signers,
      signingOrder: documentMeta?.signingOrder ?? envelope.documentMeta.signingOrder,
      allowDictateNextSigner: documentMeta?.allowDictateNextSigner ?? envelope.documentMeta.allowDictateNextSigner,
    };
  };

  const form = useForm<TEditorRecipientsFormSchema>({
    defaultValues: generateDefaultValues(),
    resolver: zodResolver(ZEditorRecipientsFormSchema),
    mode: 'onChange', // Used for autosave purposes, maybe can try onBlur instead?
  });

  const resetForm = (options?: ResetFormOptions) => {
    form.reset(generateDefaultValues(options));
  };

  return {
    form,
    resetForm,
  };
};
