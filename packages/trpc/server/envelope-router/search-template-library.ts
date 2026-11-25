import { searchTemplateLibrary } from '@documenso/lib/server-only/envelope/search-template-library';

import { authenticatedProcedure } from '../trpc';
import {
  ZSearchTemplateLibraryRequestSchema,
  ZSearchTemplateLibraryResponseSchema,
  searchTemplateLibraryMeta,
} from './search-template-library.types';

export const searchTemplateLibraryRoute = authenticatedProcedure
  .meta(searchTemplateLibraryMeta)
  .input(ZSearchTemplateLibraryRequestSchema)
  .output(ZSearchTemplateLibraryResponseSchema)
  .query(async ({ input, ctx }) => {
    const { user, teamId } = ctx;

    ctx.logger.info({
      input,
    });

    return await searchTemplateLibrary({
      userId: user.id,
      teamId,
      ...input,
    });
  });
