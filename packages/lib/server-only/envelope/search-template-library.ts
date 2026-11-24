import { EnvelopeType } from '@prisma/client';

import { listEnvelopeTree } from './list-envelope-tree';
import { type TemplateLibraryCriteria, matchTemplateLibrary } from './match-template-library';

export type SearchTemplateLibraryOptions = TemplateLibraryCriteria & {
  userId: number;
  teamId: number;
  /** The folder the library sits under. Everything below it, at any depth, is a candidate. */
  folderId: string;
  /** What to search for. Templates unless asked for documents. */
  type?: EnvelopeType;
};

/**
 * The templates (or documents) under `folderId` whose folders and title a
 * free-text query names, best first, typos allowed. See `matchTemplateLibrary`
 * for how.
 */
export const searchTemplateLibrary = async ({
  userId,
  teamId,
  folderId,
  type = EnvelopeType.TEMPLATE,
  ...criteria
}: SearchTemplateLibraryOptions) => {
  const { data } = await listEnvelopeTree({
    userId,
    teamId,
    folderId,
    type,
  });

  return matchTemplateLibrary(data, criteria);
};
