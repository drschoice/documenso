import { DocumentStatus, FieldType, type Prisma, RecipientRole, SigningStatus } from '@prisma/client';
import { match } from 'ts-pattern';

import { isBase64Image } from '@documenso/lib/constants/signatures';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { validateFieldAuth } from '@documenso/lib/server-only/document/validate-field-auth';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import { getLinkGroupId } from '@documenso/lib/universal/field-linking';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { extractFieldInsertionValues } from '@documenso/lib/utils/envelope-signing';
import { prisma } from '@documenso/prisma';

import { procedure } from '../trpc';
import {
  ZSignEnvelopeFieldRequestSchema,
  ZSignEnvelopeFieldResponseSchema,
} from './sign-envelope-field.types';

// Note that this is an unauthenticated public procedure route.
export const signEnvelopeFieldRoute = procedure
  .input(ZSignEnvelopeFieldRequestSchema)
  .output(ZSignEnvelopeFieldResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, metadata } = ctx;
    const { token, fieldId, fieldValue, authOptions } = input;

    ctx.logger.info({
      input: {
        fieldId,
      },
    });

    const recipient = await prisma.recipient.findFirst({
      where: {
        token,
      },
    });

    if (!recipient) {
      throw new AppError(AppErrorCode.NOT_FOUND);
    }

    const field = await prisma.field.findFirst({
      where: {
        id: fieldId,
        recipient: {
          ...(recipient.role === RecipientRole.ASSISTANT
            ? {
                signingStatus: {
                  not: SigningStatus.SIGNED,
                },
                signingOrder: {
                  gte: recipient.signingOrder ?? 0,
                },
              }
            : {
                id: recipient.id,
              }),
        },
      },
      include: {
        envelope: {
          include: {
            recipients: true,
            documentMeta: true,
          },
        },
        recipient: true,
      },
    });

    if (!field) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Field ${fieldId} not found`,
      });
    }

    const { envelope } = field;
    const { documentMeta } = envelope;

    if (envelope.internalVersion !== 2) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: `Envelope ${envelope.id} is not a version 2 envelope`,
      });
    }

    if (
      field.type === FieldType.SIGNATURE &&
      recipient.id !== field.recipientId &&
      recipient.role === RecipientRole.ASSISTANT
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Assistant recipients cannot sign signature fields`,
      });
    }

    if (fieldValue.type !== field.type) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Selected values do not match the field values',
      });
    }

    if (envelope.deletedAt) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Document ${envelope.id} has been deleted`,
      });
    }

    if (envelope.status !== DocumentStatus.PENDING) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Document ${envelope.id} must be pending for signing`,
      });
    }

    if (
      recipient.signingStatus === SigningStatus.SIGNED ||
      field.recipient.signingStatus === SigningStatus.SIGNED
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Recipient ${recipient.id} has already signed`,
      });
    }

    if (field.fieldMeta?.readOnly) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Field ${fieldId} is read only`,
      });
    }

    // Unreachable code based on the above query but we need to satisfy TypeScript
    if (field.recipientId === null) {
      throw new Error(`Field ${fieldId} has no recipientId`);
    }

    // Copy & link fields: other editable members of this field's link group get
    // the same value fanned out in the same transaction, so filling one fills
    // all (e.g. a Medicare number repeated across pages). Only TEXT/NUMBER
    // fields carry a linkGroupId; read-only members (locked pre-fills) are left
    // untouched.
    const linkGroupId =
      field.type === FieldType.TEXT || field.type === FieldType.NUMBER
        ? getLinkGroupId(field.fieldMeta as TFieldMetaSchema)
        : null;

    const linkMembers = linkGroupId
      ? (
          await prisma.field.findMany({
            where: {
              envelopeId: field.envelopeId,
              recipientId: field.recipientId,
              id: { not: field.id },
            },
          })
        ).filter(
          (member) =>
            (member.type === FieldType.TEXT || member.type === FieldType.NUMBER) &&
            getLinkGroupId(member.fieldMeta as TFieldMetaSchema) === linkGroupId &&
            !(member.fieldMeta as { readOnly?: boolean } | null)?.readOnly,
        )
      : [];

    /**
     * Write the same {customText, inserted} to every link-group member and log
     * each change. Runs inside the caller's transaction. Assistants only audit
     * their own recipient's primary action, matching the uninsert path below.
     */
    const applyLinkFanOut = async (
      tx: Prisma.TransactionClient,
      values: { customText: string; inserted: boolean },
    ) => {
      const updated = [];

      for (const member of linkMembers) {
        const updatedMember = await tx.field.update({
          where: { id: member.id },
          data: { customText: values.customText, inserted: values.inserted },
        });

        if (recipient.role !== RecipientRole.ASSISTANT) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: values.inserted
                ? DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED
                : DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_UNINSERTED,
              envelopeId: envelope.id,
              user: { name: recipient.name, email: recipient.email },
              requestMetadata: metadata.requestMetadata,
              data: values.inserted
                ? {
                    recipientEmail: recipient.email,
                    recipientId: recipient.id,
                    recipientName: recipient.name,
                    recipientRole: recipient.role,
                    fieldId: updatedMember.secondaryId,
                    field: match(updatedMember.type)
                      .with(FieldType.TEXT, FieldType.NUMBER, (type) => ({
                        type,
                        data: updatedMember.customText,
                      }))
                      .otherwise((type) => ({ type, data: updatedMember.customText })),
                  }
                : { field: updatedMember.type, fieldId: updatedMember.secondaryId },
            }),
          });
        }

        updated.push(updatedMember);
      }

      return updated;
    };

    const insertionValues = extractFieldInsertionValues({ fieldValue, field, documentMeta });

    // Early return for uninserting fields.
    if (!insertionValues.inserted) {
      return await prisma.$transaction(async (tx) => {
        const updatedField = await tx.field.update({
          where: {
            id: field.id,
          },
          data: {
            customText: '',
            inserted: false,
          },
        });

        await tx.signature.deleteMany({
          where: {
            fieldId: field.id,
          },
        });

        if (recipient.role !== RecipientRole.ASSISTANT) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_UNINSERTED,
              envelopeId: envelope.id,
              user: {
                name: recipient.name,
                email: recipient.email,
              },
              requestMetadata: metadata.requestMetadata,
              data: {
                field: field.type,
                fieldId: field.secondaryId,
              },
            }),
          });
        }

        // Clearing a linked field clears the whole group.
        const linkedFields = await applyLinkFanOut(tx, { customText: '', inserted: false });

        return {
          signedField: updatedField,
          linkedFields,
        };
      });
    }

    const derivedRecipientActionAuth = await validateFieldAuth({
      documentAuthOptions: envelope.authOptions,
      recipient,
      field,
      userId: user?.id,
      authOptions,
    });

    const assistant = recipient.role === RecipientRole.ASSISTANT ? recipient : undefined;

    let signatureImageAsBase64 = null;
    let typedSignature = null;

    if (field.type === FieldType.SIGNATURE) {
      if (fieldValue.type !== FieldType.SIGNATURE) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: `Field ${fieldId} is not a signature field`,
        });
      }

      if (fieldValue.value) {
        const isBase64 = isBase64Image(fieldValue.value);

        signatureImageAsBase64 = isBase64 ? fieldValue.value : null;
        typedSignature = !isBase64 ? fieldValue.value : null;
      }
    }

    return await prisma.$transaction(async (tx) => {
      const updatedField = await tx.field.update({
        where: {
          id: field.id,
        },
        data: {
          customText: insertionValues.customText,
          inserted: insertionValues.inserted,
        },
        include: {
          signature: true,
        },
      });

      if (field.type === FieldType.SIGNATURE) {
        const signature = await tx.signature.upsert({
          where: {
            fieldId: field.id,
          },
          create: {
            fieldId: field.id,
            recipientId: field.recipientId,
            signatureImageAsBase64: signatureImageAsBase64,
            typedSignature: typedSignature,
          },
          update: {
            signatureImageAsBase64: signatureImageAsBase64,
            typedSignature: typedSignature,
          },
        });

        // Dirty but I don't want to deal with type information
        Object.assign(updatedField, {
          signature,
        });
      }

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type:
            assistant && field.recipientId !== assistant.id
              ? DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_PREFILLED
              : DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED,
          envelopeId: envelope.id,
          user: {
            email: assistant?.email ?? recipient.email,
            name: assistant?.name ?? recipient.name,
          },
          requestMetadata: metadata.requestMetadata,
          data: {
            recipientEmail: recipient.email,
            recipientId: recipient.id,
            recipientName: recipient.name,
            recipientRole: recipient.role,
            fieldId: updatedField.secondaryId,
            field: match(updatedField.type)
              .with(FieldType.SIGNATURE, FieldType.FREE_SIGNATURE, (type) => ({
                type,
                data: signatureImageAsBase64 || typedSignature || '',
              }))
              .with(
                FieldType.DATE,
                FieldType.EMAIL,
                FieldType.NAME,
                FieldType.TEXT,
                FieldType.INITIALS,
                (type) => ({
                  type,
                  data: updatedField.customText,
                }),
              )
              .with(
                FieldType.NUMBER,
                FieldType.RADIO,
                FieldType.CHECKBOX,
                FieldType.DROPDOWN,
                (type) => ({
                  type,
                  data: updatedField.customText,
                }),
              )
              .exhaustive(),
            fieldSecurity: derivedRecipientActionAuth
              ? {
                  type: derivedRecipientActionAuth,
                }
              : undefined,
          },
        }),
      });

      // Fan the signed value out to the rest of the link group.
      const linkedFields = await applyLinkFanOut(tx, {
        customText: insertionValues.customText,
        inserted: insertionValues.inserted,
      });

      return {
        signedField: updatedField,
        linkedFields,
      };
    });
  });
