import { EnvelopeType } from '@prisma/client';
import { z } from 'zod';

import {
  TEMPLATE_MATCH_THRESHOLD,
  TEMPLATE_SEARCH_DEFAULT_LIMIT,
} from '@documenso/lib/server-only/envelope/match-template-library';

import type { TrpcRouteMeta } from '../trpc';

export const searchTemplateLibraryMeta: TrpcRouteMeta = {
  openapi: {
    method: 'GET',
    path: '/envelope/search-templates',
    summary: 'Search templates or documents in a folder tree',
    description:
      'Finds the templates (or, with `type=DOCUMENT`, documents) at any depth under a folder whose folder names and title a free-text query names, best first. Typos are allowed ("Globex" names a folder called "GOLBEX") and query words that name nothing are ignored, so the query can carry everything the caller knows about what it wants.',
    tags: ['Envelope'],
  },
};

export const ZSearchTemplateLibraryRequestSchema = z.object({
  folderId: z
    .string()
    .min(1)
    .describe('The folder to search under. Everything below it, at any depth, is searched.'),
  query: z
    .string()
    .min(1)
    .describe(
      'Free text that may name folders on a template’s (or document’s) path and words of its title, e.g. "Initech Inc. EU Europe Sales".',
    ),
  type: z
    .nativeEnum(EnvelopeType)
    .optional()
    .describe('What to search for: TEMPLATE (the default) or DOCUMENT.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(`The most results to return. Defaults to ${TEMPLATE_SEARCH_DEFAULT_LIMIT}.`),
  threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      `How alike two words must be, 0 to 1. Defaults to ${TEMPLATE_MATCH_THRESHOLD}: one typo in 4+ letters, two in 8+, short codes and numbers exact.`,
    ),
});

export const ZTemplateLibraryMatchSchema = z.object({
  id: z.string(),
  title: z.string(),
  folderId: z.string().describe('The folder the template or document sits in.'),
  path: z
    .string()
    .array()
    .describe('Folder names below `folderId` down to its folder, outermost first.'),
  score: z.number().describe('The sum of `pathScores` and `titleScore`. Higher is better.'),
  pathScores: z
    .number()
    .array()
    .describe('How much of each folder in `path` the query named, 0 to 1, in the same order.'),
  titleScore: z.number().describe('How much of the title the query named, 0 to 1.'),
});

export const ZSearchTemplateLibraryResponseSchema = z.object({
  data: ZTemplateLibraryMatchSchema.array(),
  count: z
    .number()
    .describe('How many templates or documents the query named anything of, before `limit`.'),
});

export type TSearchTemplateLibraryRequest = z.infer<typeof ZSearchTemplateLibraryRequestSchema>;
export type TSearchTemplateLibraryResponse = z.infer<typeof ZSearchTemplateLibraryResponseSchema>;
