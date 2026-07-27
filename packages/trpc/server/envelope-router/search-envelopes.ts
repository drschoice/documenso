import { searchEnvelopes } from '@documenso/lib/server-only/envelope/search-envelopes';

import { authenticatedProcedure } from '../trpc';
import {
  ZSearchEnvelopesRequestSchema,
  ZSearchEnvelopesResponseSchema,
  searchEnvelopesMeta,
} from './search-envelopes.types';

export const searchEnvelopesRoute = authenticatedProcedure
  .meta(searchEnvelopesMeta)
  .input(ZSearchEnvelopesRequestSchema)
  .output(ZSearchEnvelopesResponseSchema)
  .query(async ({ input, ctx }) => {
    const { user, teamId } = ctx;

    const { query, type, folderId, threshold, page, perPage } = input;

    ctx.logger.info({
      input: {
        query,
        type,
        folderId,
        threshold,
        page,
        perPage,
      },
    });

    return await searchEnvelopes({
      userId: user.id,
      teamId,
      query,
      type,
      folderId,
      threshold,
      page,
      perPage,
    });
  });
