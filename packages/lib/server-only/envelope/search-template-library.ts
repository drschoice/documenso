import { EnvelopeType } from '@prisma/client';

import { listEnvelopeTree } from './list-envelope-tree';
import { type TemplateLibraryCriteria, matchTemplateLibrary } from './match-template-library';

export type SearchTemplateLibraryOptions = TemplateLibraryCriteria & {
  userId: number;
  teamId: number;
  /** The folder the library sits under. Every template below it, at any depth, is a candidate. */
  folderId: string;
};

/**
 * The templates under `folderId` whose folders and title a free-text query
 * names, best first, typos allowed. See `matchTemplateLibrary` for how.
 */
export const searchTemplateLibrary = async ({
  userId,
  teamId,
  folderId,
  ...criteria
}: SearchTemplateLibraryOptions) => {
  const { data } = await listEnvelopeTree({
    userId,
    teamId,
    folderId,
    type: EnvelopeType.TEMPLATE,
  });

  return matchTemplateLibrary(data, criteria);
};
