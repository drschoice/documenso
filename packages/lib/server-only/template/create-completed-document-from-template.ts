import type { Field, Recipient } from '@prisma/client';
import {
  DocumentDistributionMethod,
  DocumentStatus,
  EnvelopeType,
  FieldType,
  RecipientRole,
  SendStatus,
  SigningStatus,
} from '@prisma/client';
import { DateTime } from 'luxon';

import { prisma } from '@documenso/prisma';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { ZRecipientAuthOptionsSchema } from '../../types/document-auth';
import type { TDocumentEmailSettings } from '../../types/document-email';
import {
  ZCheckboxFieldMeta,
  ZDropdownFieldMeta,
  ZFieldMetaSchema,
  ZNumberFieldMeta,
  ZRadioFieldMeta,
  ZTextFieldMeta,
} from '../../types/field-meta';
import type { TTemplateFieldFillValue } from '../../types/template-field-fill';
import { toCheckboxValue } from '../../universal/field-checkbox';
import { evaluateAllVisibility } from '../../universal/field-visibility';
import { isRequiredField } from '../../utils/advanced-fields-helpers';
import { extractDerivedDocumentMeta } from '../../utils/document';
import type { CreateDocumentAuditLogDataResponse } from '../../utils/document-audit-logs';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import { mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { extractFieldInsertionValues } from '../../utils/envelope-signing';
import { extractInitials } from '../../utils/recipient-formatter';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { getTeamSettings } from '../team/get-team-settings';
import type { CreateDocumentFromTemplateOptions } from './create-document-from-template';
import { createDocumentFromTemplate } from './create-document-from-template';
import { getOrganisationTemplateWhereInput } from './get-organisation-template-by-id';

export type CreateCompletedDocumentFromTemplateOptions = Omit<
  CreateDocumentFromTemplateOptions,
  'prefillFields'
> & {
  /**
   * The values to fill the template fields with, keyed by template field ID.
   *
   * Fields not present here are filled with derived defaults where possible
   * (recipient name/email/initials, current date, field meta default values).
   */
  fieldValues?: TTemplateFieldFillValue[];
};

const FIELD_TYPE_TO_FILL_TYPE: Record<FieldType, TTemplateFieldFillValue['type']> = {
  [FieldType.SIGNATURE]: 'signature',
  [FieldType.FREE_SIGNATURE]: 'signature',
  [FieldType.NAME]: 'name',
  [FieldType.INITIALS]: 'initials',
  [FieldType.EMAIL]: 'email',
  [FieldType.DATE]: 'date',
  [FieldType.TEXT]: 'text',
  [FieldType.NUMBER]: 'number',
  [FieldType.RADIO]: 'radio',
  [FieldType.CHECKBOX]: 'checkbox',
  [FieldType.DROPDOWN]: 'dropdown',
};

const ALL_EMAILS_DISABLED: TDocumentEmailSettings = {
  recipientSigningRequest: false,
  recipientRemoved: false,
  recipientSigned: false,
  documentPending: false,
  documentCompleted: false,
  documentDeleted: false,
  ownerDocumentCompleted: false,
  ownerRecipientExpired: false,
  ownerDocumentCreated: false,
};

type PlannedFieldInsertion = {
  templateFieldId: number;
  customText: string;
  typedSignature: string | null;
  isExplicit: boolean;
};

/**
 * Derive a fill value from the field meta default values, mirroring the
 * auto-insert behaviour in `send-document.ts` but returning option values
 * instead of encoded custom text.
 */
const getFieldMetaDefaultFillValue = (field: Field): TTemplateFieldFillValue | null => {
  if (!field.fieldMeta) {
    return null;
  }

  if (field.type === FieldType.TEXT) {
    const parsedMeta = ZTextFieldMeta.safeParse(field.fieldMeta);

    return parsedMeta.success && parsedMeta.data.text
      ? { id: field.id, type: 'text', value: parsedMeta.data.text }
      : null;
  }

  if (field.type === FieldType.NUMBER) {
    const parsedMeta = ZNumberFieldMeta.safeParse(field.fieldMeta);

    return parsedMeta.success && parsedMeta.data.value
      ? { id: field.id, type: 'number', value: parsedMeta.data.value }
      : null;
  }

  if (field.type === FieldType.RADIO) {
    const parsedMeta = ZRadioFieldMeta.safeParse(field.fieldMeta);

    const checkedItem = parsedMeta.success
      ? (parsedMeta.data.values ?? []).find((value) => value.checked)
      : null;

    return checkedItem ? { id: field.id, type: 'radio', value: checkedItem.value } : null;
  }

  if (field.type === FieldType.CHECKBOX) {
    const parsedMeta = ZCheckboxFieldMeta.safeParse(field.fieldMeta);

    const checkedValues = parsedMeta.success
      ? (parsedMeta.data.values ?? []).filter((value) => value.checked).map((value) => value.value)
      : [];

    return checkedValues.length > 0
      ? { id: field.id, type: 'checkbox', value: checkedValues }
      : null;
  }

  if (field.type === FieldType.DROPDOWN) {
    const parsedMeta = ZDropdownFieldMeta.safeParse(field.fieldMeta);

    if (!parsedMeta.success) {
      return null;
    }

    const { defaultValue, values = [] } = parsedMeta.data;

    if (defaultValue && values.some((value) => value.value === defaultValue)) {
      return { id: field.id, type: 'dropdown', value: defaultValue };
    }
  }

  return null;
};

/**
 * Derive a default fill value for fields that were not explicitly provided.
 */
const getDefaultFillValue = (
  field: Field,
  mergedRecipient: { name: string; email: string } | undefined,
): TTemplateFieldFillValue | null => {
  if (field.type === FieldType.NAME) {
    return mergedRecipient?.name
      ? { id: field.id, type: 'name', value: mergedRecipient.name }
      : null;
  }

  if (field.type === FieldType.INITIALS) {
    const initials = mergedRecipient?.name ? extractInitials(mergedRecipient.name) : '';

    return initials ? { id: field.id, type: 'initials', value: initials } : null;
  }

  if (field.type === FieldType.EMAIL) {
    return mergedRecipient?.email
      ? { id: field.id, type: 'email', value: mergedRecipient.email }
      : null;
  }

  if (field.type === FieldType.DATE) {
    return { id: field.id, type: 'date', value: DateTime.now().toISO() ?? undefined };
  }

  return getFieldMetaDefaultFillValue(field);
};

/**
 * Convert a value based fill value into the index based value shape used by
 * `extractFieldInsertionValues`.
 */
const toSignEnvelopeFieldValue = (
  field: Field,
  fillValue: TTemplateFieldFillValue,
): TSignEnvelopeFieldValue => {
  if (fillValue.type === 'radio') {
    const { values = [] } = ZRadioFieldMeta.parse(field.fieldMeta);

    const selectedIndex = values.findIndex((option) => option.value === fillValue.value);

    if (selectedIndex === -1) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `Value "${fillValue.value}" not found in options for RADIO field ${field.id}`,
      });
    }

    return { type: FieldType.RADIO, value: selectedIndex };
  }

  if (fillValue.type === 'checkbox') {
    const { values = [] } = ZCheckboxFieldMeta.parse(field.fieldMeta);

    const selectedIndexes = fillValue.value.map((selectedValue) => {
      const selectedIndex = values.findIndex((option) => option.value === selectedValue);

      if (selectedIndex === -1) {
        throw new AppError(AppErrorCode.INVALID_BODY, {
          message: `Value "${selectedValue}" not found in options for CHECKBOX field ${field.id}`,
        });
      }

      return selectedIndex;
    });

    return { type: FieldType.CHECKBOX, value: selectedIndexes };
  }

  if (fillValue.type === 'signature') {
    // FREE_SIGNATURE fields are filled as typed signatures too.
    return { type: FieldType.SIGNATURE, value: fillValue.value };
  }

  if (fillValue.type === 'date') {
    return { type: FieldType.DATE, value: fillValue.value ?? DateTime.now().toISO() };
  }

  if (fillValue.type === 'name') {
    return { type: FieldType.NAME, value: fillValue.value ?? null };
  }

  if (fillValue.type === 'initials') {
    return { type: FieldType.INITIALS, value: fillValue.value ?? null };
  }

  if (fillValue.type === 'email') {
    return { type: FieldType.EMAIL, value: fillValue.value ?? null };
  }

  if (fillValue.type === 'text') {
    return { type: FieldType.TEXT, value: fillValue.value };
  }

  if (fillValue.type === 'number') {
    return { type: FieldType.NUMBER, value: fillValue.value };
  }

  return { type: FieldType.DROPDOWN, value: fillValue.value };
};

/**
 * Create a document from a template with every field already filled and
 * signed, then queue the seal job so the completed PDF can be downloaded once
 * sealing finishes.
 *
 * No emails are sent at any point: the document is created with all email
 * settings disabled and the seal job is triggered with `sendEmail: false`.
 *
 * Signature fields only support typed signatures and always require an
 * explicit value in `fieldValues`.
 */
export const createCompletedDocumentFromTemplate = async ({
  fieldValues = [],
  ...options
}: CreateCompletedDocumentFromTemplateOptions) => {
  const { id, userId, teamId, recipients, override, requestMetadata } = options;

  const templateInclude = {
    recipients: {
      include: {
        fields: true,
      },
    },
    documentMeta: true,
  } as const;

  const { envelopeWhereInput, team: callerTeam } = await getEnvelopeWhereInput({
    id,
    type: EnvelopeType.TEMPLATE,
    userId,
    teamId,
  });

  const [teamTemplate, organisationTemplate] = await Promise.all([
    prisma.envelope.findFirst({
      where: envelopeWhereInput,
      include: templateInclude,
    }),
    prisma.envelope.findFirst({
      where: getOrganisationTemplateWhereInput({
        id,
        organisationId: callerTeam.organisationId,
        teamRole: callerTeam.currentTeamRole,
      }),
      include: templateInclude,
    }),
  ]);

  const template = teamTemplate ?? organisationTemplate;

  if (!template) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Template not found',
    });
  }

  const templateFields = template.recipients.flatMap((recipient) => recipient.fields);
  const templateFieldById = new Map(templateFields.map((field) => [field.id, field]));

  // The document cannot be completed programmatically when signing requires
  // additional recipient authentication.
  const { documentAuthOption } = extractDocumentAuthMethods({
    documentAuth: template.authOptions,
  });

  const recipientsRequiringActionAuth = template.recipients.filter((recipient) => {
    if (recipient.role === RecipientRole.CC) {
      return false;
    }

    const authOptions = ZRecipientAuthOptionsSchema.parse(recipient.authOptions);

    return authOptions.actionAuth.length > 0;
  });

  if (documentAuthOption.globalActionAuth.length > 0 || recipientsRequiringActionAuth.length > 0) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message:
        'Templates that require recipient action authentication cannot be completed programmatically.',
    });
  }

  // Validate that the provided field values reference valid template fields.
  const seenFieldValueIds = new Set<number>();

  for (const fieldValue of fieldValues) {
    if (seenFieldValueIds.has(fieldValue.id)) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `Duplicate field value provided for field ${fieldValue.id}`,
      });
    }

    seenFieldValueIds.add(fieldValue.id);

    const templateField = templateFieldById.get(fieldValue.id);

    if (!templateField) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `Field ${fieldValue.id} does not exist in the template`,
      });
    }

    const expectedFillType = FIELD_TYPE_TO_FILL_TYPE[templateField.type];

    if (expectedFillType !== fieldValue.type) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `Field type mismatch for field ${fieldValue.id}: expected ${expectedFillType}, got ${fieldValue.type}`,
      });
    }

    const parsedFieldMeta = templateField.fieldMeta
      ? ZFieldMetaSchema.safeParse(templateField.fieldMeta)
      : null;

    if (parsedFieldMeta?.success && parsedFieldMeta.data?.readOnly) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `Field ${fieldValue.id} is read only and cannot be given a value`,
      });
    }
  }

  // Derive the document meta values the created document will end up with so
  // dates are formatted identically and typed signature validation matches.
  const settings = await getTeamSettings({ userId, teamId });

  const derivedDocumentMeta = extractDerivedDocumentMeta(settings, {
    timezone: override?.timezone || template.documentMeta?.timezone,
    dateFormat: override?.dateFormat || template.documentMeta?.dateFormat,
    typedSignatureEnabled:
      override?.typedSignatureEnabled ?? template.documentMeta?.typedSignatureEnabled,
  });

  const hasSignatureFields = templateFields.some(
    (field) => field.type === FieldType.SIGNATURE || field.type === FieldType.FREE_SIGNATURE,
  );

  if (hasSignatureFields && derivedDocumentMeta.typedSignatureEnabled === false) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message:
        'Typed signatures are disabled for this template, so its signature fields cannot be filled programmatically.',
    });
  }

  // Mirror the recipient merging done in createDocumentFromTemplate so
  // defaults derived from recipient details match the created document.
  recipients.forEach((recipient) => {
    const foundRecipient = template.recipients.find(
      (templateRecipient) => templateRecipient.id === recipient.id,
    );

    if (!foundRecipient) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `Recipient with ID ${recipient.id} not found in the template.`,
      });
    }
  });

  const mergedRecipientByTemplateRecipientId = new Map(
    template.recipients.map((templateRecipient) => {
      const foundRecipient = recipients.find((recipient) => recipient.id === templateRecipient.id);

      return [
        templateRecipient.id,
        {
          name: foundRecipient ? (foundRecipient.name ?? '') : templateRecipient.name,
          email: foundRecipient ? foundRecipient.email : templateRecipient.email,
        },
      ] as const;
    }),
  );

  const fieldValueById = new Map(fieldValues.map((fieldValue) => [fieldValue.id, fieldValue]));

  // Build the insertion plan against the template fields. Values are resolved
  // as: explicit value -> derived default -> none (uninserted).
  const planByTemplateFieldId = new Map<number, PlannedFieldInsertion>();

  for (const templateRecipient of template.recipients) {
    const mergedRecipient = mergedRecipientByTemplateRecipientId.get(templateRecipient.id);

    for (const field of templateRecipient.fields) {
      const explicitValue = fieldValueById.get(field.id);

      const fillValue = explicitValue ?? getDefaultFillValue(field, mergedRecipient);

      if (!fillValue) {
        continue;
      }

      if (
        explicitValue &&
        explicitValue.type === 'date' &&
        explicitValue.value &&
        !DateTime.fromISO(explicitValue.value).isValid
      ) {
        throw new AppError(AppErrorCode.INVALID_BODY, {
          message: `Invalid date value for field ${field.id}: ${explicitValue.value}`,
        });
      }

      let insertionValues: { customText: string; inserted: boolean };

      try {
        if (
          !field.fieldMeta &&
          (field.type === FieldType.TEXT || field.type === FieldType.NUMBER)
        ) {
          // Advanced fields without field meta cannot be validated, but their
          // plain text values can still be inserted directly.
          insertionValues = {
            customText: typeof fillValue.value === 'string' ? fillValue.value : '',
            inserted: typeof fillValue.value === 'string' && fillValue.value !== '',
          };
        } else {
          insertionValues = extractFieldInsertionValues({
            fieldValue: toSignEnvelopeFieldValue(field, fillValue),
            field,
            documentMeta: derivedDocumentMeta,
          });
        }
      } catch (err) {
        // Derived defaults that fail validation are skipped rather than
        // rejected, matching the auto-insert behaviour on send. The required
        // field coverage check below will surface them if they are required.
        if (!explicitValue) {
          continue;
        }

        if (err instanceof AppError) {
          throw err;
        }

        throw new AppError(AppErrorCode.INVALID_BODY, {
          message: `Invalid value for field ${field.id}`,
        });
      }

      if (!insertionValues.inserted) {
        continue;
      }

      let customText = insertionValues.customText;

      // Version 1 envelopes store option values in the custom text, while
      // version 2 envelopes store option indexes.
      if (template.internalVersion === 1) {
        if (fillValue.type === 'radio') {
          customText = fillValue.value;
        }

        if (fillValue.type === 'checkbox') {
          customText = toCheckboxValue(fillValue.value);
        }
      }

      planByTemplateFieldId.set(field.id, {
        templateFieldId: field.id,
        customText,
        typedSignature: fillValue.type === 'signature' ? fillValue.value : null,
        isExplicit: Boolean(explicitValue),
      });
    }
  }

  // Evaluate conditional visibility against the planned state. Hidden fields
  // are stamped into the PDF when marked as inserted, so they must be dropped
  // from the plan, and required coverage only applies to visible fields.
  const visibilityMap = evaluateAllVisibility(
    templateFields.map((field) => {
      const planned = planByTemplateFieldId.get(field.id);

      return {
        id: field.id,
        type: field.type,
        customText: planned?.customText ?? '',
        inserted: Boolean(planned),
        fieldMeta: field.fieldMeta,
      };
    }),
  );

  const missingRequiredFieldIds: number[] = [];

  for (const field of templateFields) {
    const isVisible = visibilityMap.get(field.id) !== false;
    const planned = planByTemplateFieldId.get(field.id);

    if (!isVisible) {
      if (planned?.isExplicit) {
        throw new AppError(AppErrorCode.INVALID_BODY, {
          message: `Field ${field.id} is hidden by its conditional visibility rules and cannot be given a value`,
        });
      }

      planByTemplateFieldId.delete(field.id);
      continue;
    }

    if (!planned && isRequiredField(field)) {
      missingRequiredFieldIds.push(field.id);
    }
  }

  if (missingRequiredFieldIds.length > 0) {
    const missingSignatureFieldIds = missingRequiredFieldIds.filter((fieldId) => {
      const fieldType = templateFieldById.get(fieldId)?.type;

      return fieldType === FieldType.SIGNATURE || fieldType === FieldType.FREE_SIGNATURE;
    });

    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: `Required fields are missing values: ${missingRequiredFieldIds.join(', ')}.${
        missingSignatureFieldIds.length > 0
          ? ` Signature fields (${missingSignatureFieldIds.join(', ')}) always require an explicit value.`
          : ''
      }`,
    });
  }

  // Create the document from the template with all emails disabled so nothing
  // is sent even if the document is later resealed or redistributed.
  const envelope = await createDocumentFromTemplate({
    ...options,
    override: {
      ...override,
      distributionMethod: DocumentDistributionMethod.NONE,
      emailSettings: ALL_EMAILS_DISABLED,
    },
  });

  const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  const recipientById = new Map<number, Recipient>(
    envelope.recipients.map((recipient) => [recipient.id, recipient]),
  );

  const plannedFields = envelope.fields.flatMap((field) => {
    const planned = planByTemplateFieldId.get(field.templateFieldId);

    if (!planned) {
      return [];
    }

    if (field.recipientId === null) {
      throw new Error(`Field ${field.id} is missing a recipient`);
    }

    return [{ field: { ...field, recipientId: field.recipientId }, planned }];
  });

  const signedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await Promise.all(
      plannedFields.map(async ({ field, planned }) =>
        tx.field.update({
          where: {
            id: field.id,
          },
          data: {
            customText: planned.customText,
            inserted: true,
          },
        }),
      ),
    );

    const signatureFields = plannedFields.filter(({ planned }) => planned.typedSignature !== null);

    if (signatureFields.length > 0) {
      await tx.signature.createMany({
        data: signatureFields.map(({ field, planned }) => ({
          fieldId: field.id,
          recipientId: field.recipientId,
          typedSignature: planned.typedSignature,
        })),
      });
    }

    await tx.recipient.updateMany({
      where: {
        envelopeId: envelope.id,
        role: {
          not: RecipientRole.CC,
        },
      },
      data: {
        signingStatus: SigningStatus.SIGNED,
        sendStatus: SendStatus.SENT,
        signedAt,
      },
    });

    await tx.envelope.update({
      where: {
        id: envelope.id,
      },
      data: {
        status: DocumentStatus.PENDING,
      },
    });

    const auditLogsToCreate: CreateDocumentAuditLogDataResponse[] = [
      createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT,
        envelopeId: envelope.id,
        metadata: requestMetadata,
        data: {},
      }),
      ...plannedFields.map(({ field, planned }) => {
        const recipient = recipientById.get(field.recipientId);

        return createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED,
          envelopeId: envelope.id,
          metadata: requestMetadata,
          data: {
            recipientEmail: recipient?.email ?? '',
            recipientId: field.recipientId,
            recipientName: recipient?.name ?? '',
            recipientRole: recipient?.role ?? RecipientRole.SIGNER,
            fieldId: field.secondaryId,
            field:
              field.type === FieldType.SIGNATURE || field.type === FieldType.FREE_SIGNATURE
                ? {
                    type: field.type,
                    data: planned.typedSignature ?? '',
                  }
                : {
                    type: field.type,
                    data: planned.customText,
                  },
            fieldSecurity: undefined,
          },
        });
      }),
      ...envelope.recipients
        .filter((recipient) => recipient.role !== RecipientRole.CC)
        .map((recipient) =>
          createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED,
            envelopeId: envelope.id,
            metadata: requestMetadata,
            data: {
              recipientEmail: recipient.email,
              recipientId: recipient.id,
              recipientName: recipient.name,
              recipientRole: recipient.role,
              actionAuth: [],
            },
          }),
        ),
    ];

    await tx.documentAuditLog.createMany({
      data: auditLogsToCreate,
    });
  });

  try {
    await jobs.triggerJob({
      name: 'internal.seal-document',
      payload: {
        documentId: legacyDocumentId,
        sendEmail: false,
        requestMetadata: requestMetadata?.requestMetadata,
      },
    });
  } catch (err) {
    // The document is fully signed and pending at this point, so the seal
    // document sweep job will pick it up and seal it if this trigger failed.
    console.error(
      `[createCompletedDocumentFromTemplate] Failed to queue seal job for document ${legacyDocumentId}`,
      err,
    );
  }

  return envelope;
};
