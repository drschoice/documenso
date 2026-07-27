import type { EnvelopeType } from '@prisma/client';
import type { SelectQueryBuilder, SqlBool } from 'kysely';

import { kyselyPrisma, prisma, sql } from '@documenso/prisma';
import type { DB } from '@documenso/prisma/generated/types';

import { TEAM_DOCUMENT_VISIBILITY_MAP } from '../../constants/teams';
import type { FindResultResponse } from '../../types/search-params';
import { maskRecipientTokensForDocument } from '../../utils/mask-recipient-tokens-for-document';
import {
  FOLDER_PATH_SEPARATOR,
  buildFolderPathMap,
  collectFolderSubtree,
} from '../folder/build-folder-paths';
import { getTeamById } from '../team/get-team';
import { buildEnvelopeAccessControlFilter } from './envelope-access-control-filter';

export type SearchEnvelopesOptions = {
  userId: number;
  teamId: number;
  /** The fuzzy search query, matched against the envelope's full folder path + title. */
  query: string;
  /** Restrict to a single envelope type (DOCUMENT or TEMPLATE). Searches both when omitted. */
  type?: EnvelopeType;
  /**
   * When provided, scope the search to this folder AND all of its descendants
   * (recursively). When omitted, all folders (and root-level envelopes) are searched.
   */
  folderId?: string;
  page?: number;
  perPage?: number;
  /**
   * pg_trgm `word_similarity` threshold in [0, 1]. Envelopes whose path-name
   * similarity to the query is at or below this are excluded. Lower = more permissive.
   */
  threshold?: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EnvelopeQueryBuilder = SelectQueryBuilder<DB, 'Envelope', any>;

/**
 * Fuzzy-search envelopes by their full "path name" — every ancestor folder name
 * plus the envelope title (e.g. `ClientA / Contracts / 2026 / NDA`).
 *
 * Unlike `findEnvelopes`, this does NOT require a `folderId` and is not limited to a
 * single folder level: it searches across the whole folder tree at once and ranks
 * results by pg_trgm `word_similarity` (typo-tolerant) against the computed path name.
 *
 * Access control matches `findEnvelopes` (see `buildEnvelopeAccessControlFilter`).
 */
export const searchEnvelopes = async ({
  userId,
  teamId,
  query,
  type,
  folderId,
  page = 1,
  perPage = 10,
  threshold = 0.3,
}: SearchEnvelopesOptions) => {
  const user = await prisma.user.findFirstOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });

  const team = await getTeamById({ userId, teamId });

  const searchQuery = query.trim();
  const teamEmail = team.teamEmail?.email ?? null;
  const allowedVisibilities = TEAM_DOCUMENT_VISIBILITY_MAP[team.currentTeamRole];

  // ─── Build folder path map (in JS, arbitrary depth, no N+1) ───────────

  const folders = await prisma.folder.findMany({
    where: { teamId },
    select: { id: true, name: true, parentId: true },
  });

  const folderPathMap = buildFolderPathMap(folders);

  // Resolve the optional subtree scope: the folder itself + all descendants.
  const scopeFolderIds =
    folderId !== undefined ? collectFolderSubtree(folders, folderId) : undefined;

  // ─── pg_trgm ranking query (Kysely) ───────────────────────────────────

  // Provide each folder's path to Postgres as a small derived table so the
  // similarity can be computed over `folder path || title` in-DB. Elements are
  // bound as scalar params (never string-concatenated) to avoid injection.
  const folderIdArray = sql`ARRAY[${sql.join(folders.map((folder) => sql`${folder.id}`))}]::text[]`;
  const folderPathArray = sql`ARRAY[${sql.join(
    folders.map((folder) => sql`${folderPathMap.get(folder.id) ?? ''}`),
  )}]::text[]`;

  const folderPaths = sql`(
    SELECT t.id, t.path
    FROM unnest(${folderIdArray}, ${folderPathArray}) AS t(id, path)
  )`.as('fp');

  // The full path-name expression the query is fuzzily matched against.
  const pathNameExpr = sql`coalesce(fp.path || ${FOLDER_PATH_SEPARATOR}, '') || "Envelope"."title"`;
  const scoreExpr = sql<number>`word_similarity(${searchQuery}, ${pathNameExpr})`;

  let qb: EnvelopeQueryBuilder = kyselyPrisma.$kysely
    .selectFrom('Envelope')
    .leftJoin(folderPaths, (join) =>
      join.on(sql<SqlBool>`fp.id = "Envelope"."folderId"`),
    )
    .select('Envelope.id')
    .select(scoreExpr.as('score'));

  // Exclude soft-deleted envelopes.
  qb = qb.where('Envelope.deletedAt', 'is', null);

  // Type filter (enum cast).
  if (type) {
    qb = qb.where('Envelope.type', '=', sql.lit(type));
  }

  // Optional subtree scope.
  if (scopeFolderIds !== undefined) {
    qb =
      scopeFolderIds.length > 0
        ? qb.where('Envelope.folderId', 'in', scopeFolderIds)
        : qb.where(sql<SqlBool>`false`);
  }

  // Fuzzy threshold — only keep envelopes that actually resemble the query.
  qb = qb.where(sql<SqlBool>`word_similarity(${searchQuery}, ${pathNameExpr}) > ${threshold}`);

  // Access control (shared with findEnvelopes).
  qb = qb.where((eb) =>
    buildEnvelopeAccessControlFilter(eb, {
      teamId: team.id,
      userId: user.id,
      teamEmail,
      allowedVisibilities,
    }),
  );

  // ─── Execute: ranked page + exact count ───────────────────────────────

  const offset = Math.max(page - 1, 0) * perPage;

  const dataQuery = qb
    .orderBy(sql`score`, 'desc')
    .orderBy('Envelope.createdAt', 'desc')
    .limit(perPage)
    .offset(offset);

  const baseCountQuery = qb.clearSelect().select('Envelope.id');
  const countQuery = kyselyPrisma.$kysely
    .selectFrom(baseCountQuery.as('filtered'))
    .select(({ fn }) => fn.count<number>('id').as('total'));

  const [dataResult, countResult] = await Promise.all([
    dataQuery.execute(),
    countQuery.executeTakeFirstOrThrow(),
  ]);

  const ids = dataResult.map((row) => row.id);
  const scoreById = new Map(dataResult.map((row) => [row.id, Number(row.score)]));
  const totalCount = Number(countResult.total ?? 0);

  if (ids.length === 0) {
    return {
      data: [],
      count: totalCount,
      currentPage: Math.max(page, 1),
      perPage,
      totalPages: Math.ceil(totalCount / perPage),
    } satisfies FindResultResponse<never[]>;
  }

  // ─── Hydrate with Prisma (mirrors findEnvelopes) ──────────────────────

  const data = await prisma.envelope.findMany({
    where: { id: { in: ids } },
    include: {
      user: { select: { id: true, name: true, email: true } },
      recipients: { orderBy: { id: 'asc' } },
      team: { select: { id: true, url: true } },
    },
  });

  // Preserve the ranked ordering from the Kysely query.
  const idOrder = new Map(ids.map((id, index) => [id, index]));
  data.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));

  const maskedData = data.map((envelope) =>
    maskRecipientTokensForDocument({
      document: envelope,
      user,
    }),
  );

  const mappedData = maskedData.map((envelope) => ({
    ...envelope,
    recipients: envelope.Recipient,
    user: {
      id: envelope.user.id,
      name: envelope.user.name || '',
      email: envelope.user.email,
    },
    folderPath: envelope.folderId ? (folderPathMap.get(envelope.folderId) ?? null) : null,
    matchScore: scoreById.get(envelope.id) ?? 0,
  }));

  return {
    data: mappedData,
    count: totalCount,
    currentPage: Math.max(page, 1),
    perPage,
    totalPages: Math.ceil(totalCount / perPage),
  } satisfies FindResultResponse<typeof mappedData>;
};
