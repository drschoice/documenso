import { type APIRequestContext, expect, test } from '@playwright/test';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { FieldType, RecipientRole } from '@documenso/prisma/client';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const TRIGGER_STABLE_ID = 'audit-marital-status';

/**
 * `7c22c78b5`. Adding, changing or removing a field's visibility rule writes a
 * dedicated audit entry, so the certificate and the audit trail can explain why
 * a field was skipped at signing time rather than leaving it unaccounted for.
 *
 * Three entry types and, just as importantly, the `isDeepEqual` guard that stops
 * every unrelated field edit from writing one. Neither had any coverage.
 */

const marriedRule = (value: string) => ({
  match: 'all' as const,
  rules: [
    {
      operator: 'equals' as const,
      triggerFieldStableId: TRIGGER_STABLE_ID,
      value,
    },
  ],
});

const seedEnvelopeWithTrigger = async (
  user: Parameters<typeof seedBlankDocument>[0],
  teamId: number,
) => {
  const document = await seedBlankDocument(user, teamId, { internalVersion: 2 });

  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({
    where: { envelopeId: document.id },
  });

  const recipient = await prisma.recipient.create({
    data: {
      envelopeId: document.id,
      email: `visibility-audit-${user.id}@example.com`,
      name: 'Signer',
      role: RecipientRole.SIGNER,
      token: `vis-audit-${user.id}-${Date.now()}`,
      readStatus: 'NOT_OPENED',
      sendStatus: 'NOT_SENT',
      signingStatus: 'NOT_SIGNED',
    },
  });

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

  await makeField(FieldType.RADIO, 5, {
    type: 'radio',
    direction: 'vertical',
    stableId: TRIGGER_STABLE_ID,
    label: 'Marital status',
    values: [
      { id: 1, checked: false, value: 'Married' },
      { id: 2, checked: false, value: 'Single' },
    ],
  });

  // Starts with no visibility block at all, so the first update is an "added".
  const dependent = await makeField(FieldType.TEXT, 20, {
    type: 'text',
    label: 'Spouse name',
    stableId: 'audit-spouse-name',
  });

  return { document, dependent };
};

const countAuditLogs = async (envelopeId: string, type: string) =>
  prisma.documentAuditLog.count({ where: { envelopeId, type } });

const readLatestAuditLog = async (envelopeId: string, type: string) =>
  prisma.documentAuditLog.findFirstOrThrow({
    where: { envelopeId, type },
    orderBy: { createdAt: 'desc' },
  });

test.describe('Field visibility rule audit trail', () => {
  test('records added, modified and removed, and stays quiet for unrelated edits', async ({
    request,
  }) => {
    const { user, team } = await seedUser();

    const { token } = await createApiToken({
      userId: user.id,
      teamId: team.id,
      tokenName: 'visibility-audit-token',
      expiresIn: null,
    });

    const { document, dependent } = await seedEnvelopeWithTrigger(user, team.id);

    const updateDependent = async (
      request: APIRequestContext,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldMeta: any,
    ) =>
      request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/field/update-many`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          envelopeId: document.id,
          data: [{ id: dependent.id, type: FieldType.TEXT, fieldMeta }],
        },
      });

    const baseMeta = {
      type: 'text',
      label: 'Spouse name',
      stableId: 'audit-spouse-name',
    };

    // 1. Adding a rule where there was none.
    const added = await updateDependent(request, {
      ...baseMeta,
      visibility: marriedRule('Married'),
    });

    expect(added.status()).toBe(200);
    expect(await countAuditLogs(document.id, 'FIELD_VISIBILITY_RULE_ADDED')).toBe(1);

    const addedLog = await readLatestAuditLog(document.id, 'FIELD_VISIBILITY_RULE_ADDED');
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const addedData = addedLog.data as { ruleSnapshot?: { rules?: Array<{ value?: string }> } };

    // The snapshot is the point of the entry - "a rule was added" alone would not
    // let anyone reconstruct what the document did.
    expect(addedData.ruleSnapshot?.rules?.[0]?.value).toBe('Married');

    // 2. Changing the rule's value.
    const modified = await updateDependent(request, {
      ...baseMeta,
      visibility: marriedRule('Single'),
    });

    expect(modified.status()).toBe(200);
    expect(await countAuditLogs(document.id, 'FIELD_VISIBILITY_RULE_MODIFIED')).toBe(1);

    const modifiedLog = await readLatestAuditLog(document.id, 'FIELD_VISIBILITY_RULE_MODIFIED');
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const modifiedData = modifiedLog.data as {
      before?: { rules?: Array<{ value?: string }> };
      after?: { rules?: Array<{ value?: string }> };
    };

    expect(modifiedData.before?.rules?.[0]?.value).toBe('Married');
    expect(modifiedData.after?.rules?.[0]?.value).toBe('Single');

    // 3. An edit that leaves the rule alone must not write anything.
    const unrelated = await updateDependent(request, {
      ...baseMeta,
      label: 'Spouse full name',
      visibility: marriedRule('Single'),
    });

    expect(unrelated.status()).toBe(200);
    expect(await countAuditLogs(document.id, 'FIELD_VISIBILITY_RULE_ADDED')).toBe(1);
    expect(await countAuditLogs(document.id, 'FIELD_VISIBILITY_RULE_MODIFIED')).toBe(1);
    expect(await countAuditLogs(document.id, 'FIELD_VISIBILITY_RULE_REMOVED')).toBe(0);

    // 4. Dropping the rule entirely.
    const removed = await updateDependent(request, { ...baseMeta, label: 'Spouse full name' });

    expect(removed.status()).toBe(200);
    expect(await countAuditLogs(document.id, 'FIELD_VISIBILITY_RULE_REMOVED')).toBe(1);

    const removedLog = await readLatestAuditLog(document.id, 'FIELD_VISIBILITY_RULE_REMOVED');
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const removedData = removedLog.data as { ruleSnapshot?: { rules?: Array<{ value?: string }> } };

    // Removal records what was taken away, not what is left.
    expect(removedData.ruleSnapshot?.rules?.[0]?.value).toBe('Single');

    const persisted = await prisma.field.findFirstOrThrow({ where: { id: dependent.id } });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const persistedMeta = persisted.fieldMeta as { visibility?: unknown } | null;

    expect(persistedMeta?.visibility).toBeUndefined();
  });
});
