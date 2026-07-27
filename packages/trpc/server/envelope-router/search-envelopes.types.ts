import { EnvelopeType } from '@prisma/client';
import { z } from 'zod';

import { ZEnvelopeManySchema } from '@documenso/lib/types/envelope';
import { ZFindResultResponse, ZFindSearchParamsSchema } from '@documenso/lib/types/search-params';

import type { TrpcRouteMeta } from '../trpc';

export const searchEnvelopesMeta: TrpcRouteMeta = {
  openapi: {
    method: 'GET',
    path: '/envelope/search',
    summary: 'Search envelopes',
    description:
      'Fuzzy-search envelopes across all folders by their full path name (ancestor folder names + title), ranked by match quality. Does not require a folder ID.',
    tags: ['Envelope'],
  },
};

export const ZSearchEnvelopesRequestSchema = ZFindSearchParamsSchema.extend({
  // Search requires a non-empty query (unlike the paginated `find` endpoint).
  query: z.string().min(1).describe('The fuzzy search query, matched against the envelope path name.'),
  type: z
    .nativeEnum(EnvelopeType)
    .describe('Restrict results to a single envelope type (DOCUMENT or TEMPLATE).')
    .optional(),
  folderId: z
    .string()
    .describe('Scope the search to this folder and all of its descendants (recursively).')
    .optional(),
  threshold: z
    .coerce.number()
    .min(0)
    .max(1)
    .describe('pg_trgm similarity threshold in [0, 1]. Lower is more permissive. Defaults to 0.3.')
    .optional(),
});

export const ZSearchEnvelopeRowSchema = ZEnvelopeManySchema.extend({
  folderPath: z
    .string()
    .nullable()
    .describe("The envelope's folder path (ancestor folder names), or null when at the root."),
  matchScore: z.number().describe('The pg_trgm similarity score of the path name against the query.'),
});

export const ZSearchEnvelopesResponseSchema = ZFindResultResponse.extend({
  data: ZSearchEnvelopeRowSchema.array(),
});

export type TSearchEnvelopesRequest = z.infer<typeof ZSearchEnvelopesRequestSchema>;
export type TSearchEnvelopesResponse = z.infer<typeof ZSearchEnvelopesResponseSchema>;
