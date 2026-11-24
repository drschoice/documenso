import { type APIRequestContext, expect, test } from '@playwright/test';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import type { User } from '@documenso/prisma/client';
import { DocumentVisibility, FolderType, TeamMemberRole } from '@documenso/prisma/client';
import { seedBlankFolder } from '@documenso/prisma/seed/folders';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedBlankTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import { ZSearchTemplateLibraryResponseSchema } from '@documenso/trpc/server/envelope-router/search-template-library.types';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const searchTemplates = async (
  request: APIRequestContext,
  token: string,
  params: Record<string, string>,
) =>
  request.get(
    `${WEBAPP_BASE_URL}/api/v2/envelope/search-templates?${new URLSearchParams(params).toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

const tokenFor = async (userId: number, teamId: number) =>
  (
    await createApiToken({
      userId,
      teamId,
      tokenName: `search-templates-${userId}`,
      expiresIn: null,
    })
  ).token;

/**
 * A template library filed by region, department and client, with the client
 * folder misspelt. Only that folder says "Globex" (wrongly), so a client match
 * has to come through it; the one template titled Globex is outside the library.
 *
 *   Library
 *     Root form
 *     EU/                    (older)
 *       Sales/
 *         GOLBEX/
 *           Sales form older
 *           Sales form newer
 *           Sales form gone  (soft-deleted)
 *     Shared (All Regions)/  (newer)
 *       Shared form
 *   Elsewhere/               (outside the library)
 *     Globex elsewhere
 */
const seedLibrary = async (user: User, teamId: number) => {
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

  const folder = async (name: string, parentId: string | null, createdAt: Date) =>
    seedBlankFolder(user, teamId, {
      createFolderOptions: { name, parentId, type: FolderType.TEMPLATE, createdAt },
    });

  const template = async (title: string, folderId: string, createdAt: Date, deleted = false) =>
    seedBlankTemplate(user, teamId, {
      createTemplateOptions: { title, folderId, createdAt, deletedAt: deleted ? at(59) : null },
    });

  const root = await folder('Library', null, at(0));
  const eu = await folder('EU', root.id, at(1));
  const shared = await folder('Shared (All Regions)', root.id, at(2));
  const sales = await folder('Sales', eu.id, at(3));
  const client = await folder('GOLBEX', sales.id, at(4));
  const elsewhere = await folder('Elsewhere', null, at(5));

  await template('Root form', root.id, at(10));
  await template('Sales form older', client.id, at(11));
  await template('Sales form newer', client.id, at(12));
  await template('Sales form gone', client.id, at(13), true);
  const sharedForm = await template('Shared form', shared.id, at(14));
  await template('Globex elsewhere', elsewhere.id, at(15));

  return { root, eu, client, sharedForm };
};

/**
 * `GET /envelope/search-templates` finds templates at any depth under a folder
 * from a free-text query that names their folders, with typos allowed.
 */
test.describe('Template library search API v2', () => {
  test('finds templates deep in the tree through a misspelt folder', async ({ request }) => {
    const { user, team } = await seedUser();
    const token = await tokenFor(user.id, team.id);
    const { root, client } = await seedLibrary(user, team.id);

    // The client with its legal suffix, the region's code and name, the
    // department's names, and words that name nothing.
    const response = await searchTemplates(request, token, {
      folderId: root.id,
      query: 'Globex Holdings Company EU Europe Sales Commercial',
    });

    expect(response.status()).toBe(200);

    const body = ZSearchTemplateLibraryResponseSchema.parse(await response.json());

    // Newest first among equal scores; nothing deleted, nothing outside the
    // root, nothing the query names none of.
    expect(body.data.map((row) => row.title)).toEqual(['Sales form newer', 'Sales form older']);
    expect(body.count).toBe(2);
    expect(body.data[0]).toMatchObject({
      folderId: client.id,
      path: ['EU', 'Sales', 'GOLBEX'],
      pathScores: [1, 1, 0.833],
    });

    // `/envelope/search-templates` is registered before `/envelope/{envelopeId}`,
    // which must still resolve an id.
    const single = await request.get(`${WEBAPP_BASE_URL}/api/v2/envelope/${body.data[0].id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(single.status()).toBe(200);
  });

  test('a manager does not see folders or templates kept for admins', async ({ request }) => {
    const { team, owner } = await seedTeam();
    const manager = await seedTeamMember({ teamId: team.id, role: TeamMemberRole.MANAGER });
    const { root, eu, sharedForm } = await seedLibrary(owner, team.id);

    // EU is admin-only, so Sales and GOLBEX under it are out of reach even
    // though their own visibility is EVERYONE.
    await prisma.folder.update({
      where: { id: eu.id },
      data: { visibility: DocumentVisibility.ADMIN },
    });
    await prisma.envelope.update({
      where: { id: sharedForm.id },
      data: { visibility: DocumentVisibility.ADMIN },
    });

    const titles = async (userId: number) => {
      const response = await searchTemplates(request, await tokenFor(userId, team.id), {
        folderId: root.id,
        query: 'form',
      });

      expect(response.status()).toBe(200);

      return ZSearchTemplateLibraryResponseSchema.parse(await response.json()).data.map(
        (row) => row.title,
      );
    };

    expect(await titles(manager.id)).toEqual(['Root form']);
    expect(await titles(owner.id)).toEqual([
      'Root form',
      'Shared form',
      'Sales form newer',
      'Sales form older',
    ]);

    // Asking for the hidden folder is the same as asking for one that doesn't exist.
    const hidden = await searchTemplates(request, await tokenFor(manager.id, team.id), {
      folderId: eu.id,
      query: 'form',
    });

    expect(hidden.status()).toBe(404);
  });

  test('another team’s folder is not found', async ({ request }) => {
    const { user: owner, team: ownerTeam } = await seedUser();
    const { user: outsider, team: outsiderTeam } = await seedUser();
    const { root } = await seedLibrary(owner, ownerTeam.id);

    const response = await searchTemplates(request, await tokenFor(outsider.id, outsiderTeam.id), {
      folderId: root.id,
      query: 'form',
    });

    expect(response.status()).toBe(404);
  });
});
