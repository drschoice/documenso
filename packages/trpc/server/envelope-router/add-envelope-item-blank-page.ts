import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { addEnvelopeItemBlankPage } from '@documenso/lib/server-only/envelope-item/add-envelope-item-blank-page';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { getEnvelopeItemPermissions } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import {
  ZAddEnvelopeItemBlankPageRequestSchema,
  ZAddEnvelopeItemBlankPageResponseSchema,
} from './add-envelope-item-blank-page.types';

export const addEnvelopeItemBlankPageRoute = authenticatedProcedure
  .input(ZAddEnvelopeItemBlankPageRequestSchema)
  .output(ZAddEnvelopeItemBlankPageResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, teamId } = ctx;

    const { envelopeId, envelopeItemId } = input;

    ctx.logger.info({
      input: {
        envelopeId,
        envelopeItemId,
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

    const { updatedItem, pageCount } = await addEnvelopeItemBlankPage({
      envelope,
      envelopeItemId,
    });

    return {
      data: updatedItem,
      pageCount,
    };
  });
