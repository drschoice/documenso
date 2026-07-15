import { getServerLimits } from '@documenso/ee/server-only/limits/server';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { createCompletedDocumentFromTemplate } from '@documenso/lib/server-only/template/create-completed-document-from-template';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import {
  ZUseAndCompleteEnvelopeRequestSchema,
  ZUseAndCompleteEnvelopeResponseSchema,
  useAndCompleteEnvelopeMeta,
} from './use-and-complete-envelope.types';

export const useAndCompleteEnvelopeRoute = authenticatedProcedure
  .meta(useAndCompleteEnvelopeMeta)
  .input(ZUseAndCompleteEnvelopeRequestSchema)
  .output(ZUseAndCompleteEnvelopeResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, teamId } = ctx;

    const {
      envelopeId,
      externalId,
      recipients = [],
      fieldValues,
      folderId,
      override,
      attachments,
      formValues,
    } = input;

    ctx.logger.info({
      input: {
        envelopeId,
        folderId,
      },
    });

    const limits = await getServerLimits({ userId: user.id, teamId });

    if (limits.remaining.documents === 0) {
      throw new AppError(AppErrorCode.LIMIT_EXCEEDED, {
        message: 'You have reached your document limit.',
      });
    }

    const envelope = await createCompletedDocumentFromTemplate({
      id: {
        type: 'envelopeId',
        id: envelopeId,
      },
      userId: user.id,
      teamId,
      recipients,
      fieldValues,
      externalId,
      folderId,
      override,
      attachments,
      formValues,
      requestMetadata: ctx.metadata,
    });

    // Refetch to reflect the status set after creation (PENDING, or already
    // COMPLETED if the seal job has finished).
    const createdEnvelope = await prisma.envelope.findFirstOrThrow({
      where: {
        id: envelope.id,
      },
      include: {
        envelopeItems: {
          select: {
            id: true,
            title: true,
          },
          orderBy: {
            order: 'asc',
          },
        },
        recipients: true,
      },
    });

    return {
      id: createdEnvelope.id,
      status: createdEnvelope.status,
      envelopeItems: createdEnvelope.envelopeItems,
      recipients: createdEnvelope.recipients.map((recipient) => ({
        id: recipient.id,
        name: recipient.name,
        email: recipient.email,
        role: recipient.role,
      })),
    };
  });
