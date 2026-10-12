import { type APIRequestContext, expect, test } from '@playwright/test';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { FieldType, RecipientRole } from '@documenso/prisma/client';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/**
 * `380b634b9`. A field that other fields point at through
 * `visibility.rules[].triggerFieldStableId` cannot simply be deleted: the
 * dependents would be left evaluating a trigger that no longer exists, which
 * `evaluateAllVisibility` fails closed on - the dependents would vanish from the
 * document with no explanation. Deleting one is refused unless the caller passes
 * `force`, which strips the orphaned rules instead.
 */
test.describe('Envelope field delete guards visibility references', () => {
  const seedTriggerAndDependent = async (
    userId: number,
    teamId: number,
    user: Parameters<typeof seedBlankDocument>[0],
  ) => {
    const document = await seedBlankDocument(user, teamId, { internalVersion: 2 });

    // `seedBlankDocument` returns the bare envelope row, so the item it created
    // has to be looked up separately.
    const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({
      where: { envelopeId: document.id },
    });

    const recipient = await prisma.recipient.create({
      data: {
        envelopeId: document.id,
        email: `trigger-ref-${userId}@example.com`,
        name: 'Signer',
        role: RecipientRole.SIGNER,
        token: `field-delete-${userId}-${Date.now()}`,
        readStatus: 'NOT_OPENED',
        sendStatus: 'NOT_SENT',
        signingStatus: 'NOT_SIGNED',
      },
    });

    const stableId = `trigger-${userId}`;

    const makeField = async (
      type: FieldType,
      positionY: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldMeta: any,
    ) =>
      prisma.field.create({
        data: {
          envelopeId: document.id,
          envelopeItemId: envelopeItem.id,
          recipientId: recipient.id,
          type,
          page: 1,
          positionX: 5,
          positionY,
          width: 20,
          height: 5,
          customText: '',
          inserted: false,
          fieldMeta,
        },
      });

    const trigger = await makeField(FieldType.RADIO, 5, {
      type: 'radio',
      direction: 'vertical',
      stableId,
      values: [
        { id: 1, checked: false, value: 'Married' },
        { id: 2, checked: false, value: 'Single' },
      ],
    });

    const dependent = await makeField(FieldType.TEXT, 20, {
      type: 'text',
      label: 'Spouse name',
      stableId: `dependent-${userId}`,
      visibility: {
        match: 'all',
        rules: [{ operator: 'equals', triggerFieldStableId: stableId, value: 'Married' }],
      },
    });

    return { document, trigger, dependent };
  };

  const deleteField = async (
    request: APIRequestContext,
    token: string,
    fieldId: number,
    force?: boolean,
  ) =>
    request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/field/delete`, {
      headers: authHeaders(token),
      data: force === undefined ? { fieldId } : { fieldId, force },
    });

  test('refuses to delete a trigger, then strips the rules when forced', async ({ request }) => {
    const { user, team } = await seedUser();

    const { token } = await createApiToken({
      userId: user.id,
      teamId: team.id,
      tokenName: 'field-delete-token',
      expiresIn: null,
    });

    const { trigger, dependent } = await seedTriggerAndDependent(user.id, team.id, user);

    const refused = await deleteField(request, token, trigger.id);

    expect(refused.status()).toBeGreaterThanOrEqual(400);

    // The trigger is still there, and so is the rule pointing at it.
    expect(await prisma.field.count({ where: { id: trigger.id } })).toBe(1);

    const forced = await deleteField(request, token, trigger.id, true);

    expect(forced.status()).toBe(200);
    expect(await prisma.field.count({ where: { id: trigger.id } })).toBe(0);

    // The dependent survives, with its now-meaningless rule removed rather than
    // left pointing at a field that no longer exists.
    const survivor = await prisma.field.findFirstOrThrow({ where: { id: dependent.id } });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const meta = survivor.fieldMeta as { visibility?: { rules?: unknown[] } } | null;

    expect(meta?.visibility?.rules ?? []).toHaveLength(0);
  });

  test('a field nothing depends on deletes without force', async ({ request }) => {
    const { user, team } = await seedUser();

    const { token } = await createApiToken({
      userId: user.id,
      teamId: team.id,
      tokenName: 'field-delete-unreferenced',
      expiresIn: null,
    });

    const { dependent } = await seedTriggerAndDependent(user.id, team.id, user);

    // The dependent is the far end of the reference - deleting it breaks nothing.
    const response = await deleteField(request, token, dependent.id);

    expect(response.status()).toBe(200);
    expect(await prisma.field.count({ where: { id: dependent.id } })).toBe(0);
  });
});

/**
 * `545b12a75`. `envelope.search` is a pg_trgm fuzzy search over the envelope's
 * full path name (ancestor folder names + title), unlike the ILIKE
 * `document.search` the existing upstream specs cover. It has no UI consumer
 * yet, which is exactly why it needs a test: nothing else would notice it break.
 */
test.describe('Envelope search API v2', () => {
  test('matches an approximate title and ranks it, and respects the threshold', async ({
    request,
  }) => {
    const { user, team } = await seedUser();

    const { token } = await createApiToken({
      userId: user.id,
      teamId: team.id,
      tokenName: 'envelope-search-token',
      expiresIn: null,
    });

    const target = await seedBlankDocument(user, team.id, { internalVersion: 2 });
    const decoy = await seedBlankDocument(user, team.id, { internalVersion: 2 });

    await prisma.envelope.update({
      where: { id: target.id },
      data: { title: 'Quarterly Revenue Agreement' },
    });

    await prisma.envelope.update({
      where: { id: decoy.id },
      data: { title: 'Kitchen Renovation Invoice' },
    });

    const search = async (query: string, extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({ query, type: 'DOCUMENT', ...extra });

      return request.get(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/search?${params.toString()}`, {
        headers: authHeaders(token),
      });
    };

    // Misspelt on purpose: an ILIKE search would return nothing here.
    const response = await search('Quarterly Revenu Agreement');

    expect(response.status()).toBe(200);

    const body = await response.json();
    const titles = body.data.map((row: { title: string }) => row.title);

    expect(titles).toContain('Quarterly Revenue Agreement');
    expect(titles).not.toContain('Kitchen Renovation Invoice');

    // Every row carries its similarity score and folder path.
    const match = body.data.find(
      (row: { title: string }) => row.title === 'Quarterly Revenue Agreement',
    );

    expect(typeof match.matchScore).toBe('number');
    expect(match.matchScore).toBeGreaterThan(0);
    expect(match.folderPath).toBeNull();

    // A threshold of 1 demands an exact match, so the misspelling drops out.
    const strict = await search('Quarterly Revenu Agreement', { threshold: '1' });

    expect(strict.status()).toBe(200);
    expect((await strict.json()).data).toHaveLength(0);
  });

  test('does not return another team’s envelopes', async ({ request }) => {
    const { user: owner, team: ownerTeam } = await seedUser();
    const { user: outsider, team: outsiderTeam } = await seedUser();

    const hidden = await seedBlankDocument(owner, ownerTeam.id, { internalVersion: 2 });

    await prisma.envelope.update({
      where: { id: hidden.id },
      data: { title: 'Strictly Confidential Merger Terms' },
    });

    const { token } = await createApiToken({
      userId: outsider.id,
      teamId: outsiderTeam.id,
      tokenName: 'envelope-search-outsider',
      expiresIn: null,
    });

    const params = new URLSearchParams({ query: 'Strictly Confidential Merger Terms' });

    const response = await request.get(
      `${WEBAPP_BASE_URL}/api/v2-beta/envelope/search?${params.toString()}`,
      { headers: authHeaders(token) },
    );

    expect(response.status()).toBe(200);
    expect((await response.json()).data).toHaveLength(0);
  });
});
