import type { EnvelopeType } from '@prisma/client';

import { kyselyPrisma, prisma, sql } from '@documenso/prisma';

import { TEAM_DOCUMENT_VISIBILITY_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { buildTeamWhereQuery } from '../../utils/teams';
import { getTeamById } from '../team/get-team';
import { buildEnvelopeAccessControlFilter } from './envelope-access-control-filter';

/**
 * The most envelopes one listing returns. Past it the call fails instead of
 * truncating, so a caller filtering the list can never silently miss one.
 */
export const ENVELOPE_TREE_MAX_ROWS = 5000;

export type ListEnvelopeTreeOptions = {
  userId: number;
  teamId: number;
  /** The folder whose whole subtree is listed. */
  folderId: string;
  /** Restrict to one envelope type. Both are listed when omitted. */
  type?: EnvelopeType;
};

/**
 * Every envelope in a folder and all of its subfolders, each with the folder
 * names from below `folderId` down to the envelope's folder, in one call.
 *
 * The candidates for `searchTemplateLibrary`: a template library laid out as
 * folders (`Region / Department / Client / <title>`), read in one query instead of a
 * folder at a time.
 *
 * Order: `folderId`'s own envelopes first, then each subfolder breadth-first,
 * siblings newest first (the order `GET /folder` lists them); within a folder,
 * newest first (the order `GET /envelope` lists them).
 *
 * Folders the user's role can't see are skipped along with everything under
 * them. Envelope access matches `findEnvelopes`.
 */
export const listEnvelopeTree = async ({
  userId,
  teamId,
  folderId,
  type,
}: ListEnvelopeTreeOptions) => {
  const team = await getTeamById({ userId, teamId });

  const allowedVisibilities = TEAM_DOCUMENT_VISIBILITY_MAP[team.currentTeamRole];

  const folders = await prisma.folder.findMany({
    where: {
      team: buildTeamWhereQuery({ teamId, userId }),
      visibility: { in: allowedVisibilities },
    },
    select: { id: true, name: true, parentId: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });

  if (!folders.some((folder) => folder.id === folderId)) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Folder not found',
    });
  }

  const childrenByParent = new Map<string, typeof folders>();

  for (const folder of folders) {
    if (folder.parentId) {
      const siblings = childrenByParent.get(folder.parentId) ?? [];
      siblings.push(folder);
      childrenByParent.set(folder.parentId, siblings);
    }
  }

  // Breadth first from the folder asked for. `pathById` doubles as the
  // visited set, so a cycle in parentId can't loop.
  const pathById = new Map<string, string[]>([[folderId, []]]);
  const folderOrder = [folderId];

  for (let i = 0; i < folderOrder.length; i++) {
    const parentPath = pathById.get(folderOrder[i]) ?? [];

    for (const child of childrenByParent.get(folderOrder[i]) ?? []) {
      if (!pathById.has(child.id)) {
        pathById.set(child.id, [...parentPath, child.name]);
        folderOrder.push(child.id);
      }
    }
  }

  let qb = kyselyPrisma.$kysely
    .selectFrom('Envelope')
    .select(['Envelope.id', 'Envelope.title', 'Envelope.type', 'Envelope.folderId'])
    .where('Envelope.folderId', 'in', folderOrder)
    .where('Envelope.deletedAt', 'is', null);

  if (type) {
    qb = qb.where('Envelope.type', '=', sql.lit(type));
  }

  qb = qb.where((eb) =>
    buildEnvelopeAccessControlFilter(eb, {
      teamId: team.id,
      userId,
      teamEmail: team.teamEmail?.email ?? null,
      allowedVisibilities,
    }),
  );

  const rows = await qb
    .orderBy('Envelope.createdAt', 'desc')
    .orderBy('Envelope.id', 'asc')
    .limit(ENVELOPE_TREE_MAX_ROWS + 1)
    .execute();

  if (rows.length > ENVELOPE_TREE_MAX_ROWS) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `More than ${ENVELOPE_TREE_MAX_ROWS} envelopes under this folder. List a subfolder instead.`,
    });
  }

  const rankById = new Map(folderOrder.map((id, index) => [id, index]));

  // Array.prototype.sort is stable, so newest-first holds within a folder.
  const sorted = rows
    .filter((row): row is typeof row & { folderId: string } => row.folderId !== null)
    .sort((a, b) => (rankById.get(a.folderId) ?? 0) - (rankById.get(b.folderId) ?? 0));

  return {
    data: sorted.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      folderId: row.folderId,
      path: pathById.get(row.folderId) ?? [],
    })),
  };
};
