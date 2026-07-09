import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { deleteEnvelopeItemPage } from '@documenso/lib/server-only/envelope-item/delete-envelope-item-page';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { getEnvelopeItemPermissions } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import {
  ZDeleteEnvelopeItemPageRequestSchema,
  ZDeleteEnvelopeItemPageResponseSchema,
} from './delete-envelope-item-page.types';

export const deleteEnvelopeItemPageRoute = authenticatedProcedure
  .input(ZDeleteEnvelopeItemPageRequestSchema)
  .output(ZDeleteEnvelopeItemPageResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, teamId } = ctx;

    const { envelopeId, envelopeItemId, pageNumber } = input;

    ctx.logger.info({
      input: {
        envelopeId,
        envelopeItemId,
        pageNumber,
      },
    });

    const { envelopeWhereInput } = await getEnvelopeWhereInput({
      id: {
        type: 'envelopeId',
        id: envelopeId,
      },
      type: 'TEMPLATE',
      userId: user.id,
      teamId,
    });

    const envelope = await prisma.envelope.findUnique({
      where: envelopeWhereInput,
      include: {
        recipients: true,
        envelopeItems: {
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!envelope) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Envelope not found',
      });
    }

    if (envelope.internalVersion !== 2) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Page management is only supported for version 2 envelopes',
      });
    }

    const { canFileBeChanged } = getEnvelopeItemPermissions(envelope, envelope.recipients);

    if (!canFileBeChanged) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Envelope item is not editable',
      });
    }

    const { updatedItem, fields } = await deleteEnvelopeItemPage({
      envelope,
      envelopeItemId,
      pageNumber,
    });

    return {
      data: updatedItem,
      fields,
    };
  });
