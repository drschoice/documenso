import { expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';

import {
  openV2SigningPage,
  seedV2PendingEnvelope,
  signV2FieldViaTrpc,
} from '../fixtures/envelope-signing';
import { getKonvaElementCountForPage } from '../fixtures/konva';

/**
 * Signing behaviour that only exists on the `internalVersion: 2` Konva signer.
 *
 * Every other signing spec in the repo seeds `internalVersion: 1`, which routes
 * to the legacy DOM signer, so none of this fork's v2 signing work was covered:
 * conditional visibility (`c470f6e68`, `971bc97de`) and copy-and-link fan-out
 * (`27e8b4090`) in particular.
 */

const RADIO_STABLE_ID = 'trigger-marital-status';

const radioMeta = {
  type: 'radio' as const,
  // Boxed layout keeps the seeded field a plain rect; new editor-created radios
  // default to free placement, which is not what is under test here.
  layout: 'box' as const,
  direction: 'vertical' as const,
  required: true,
  readOnly: false,
  stableId: RADIO_STABLE_ID,
  values: [
    { id: 1, checked: false, value: 'Married' },
    { id: 2, checked: false, value: 'Single' },
  ],
};

const dependentTextMeta = {
  type: 'text' as const,
  label: 'Spouse name',
  required: true,
  readOnly: false,
  stableId: 'dependent-spouse-name',
  visibility: {
    match: 'all' as const,
    rules: [
      {
        operator: 'equals' as const,
        triggerFieldStableId: RADIO_STABLE_ID,
        value: 'Married',
      },
    ],
  },
};

test.describe('conditional visibility on the v2 signer', () => {
  test('a dependent is hidden until its trigger matches, and visible once it does', async ({
    page,
  }) => {
    const { user, team } = await seedUser();

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `v2-visibility-${user.id}@example.com`, name: 'V2 Signer' }],
      fields: [
        {
          type: FieldType.RADIO,
          positionX: 10,
          positionY: 10,
          width: 30,
          height: 12,
          fieldMeta: radioMeta,
        },
        {
          type: FieldType.TEXT,
          positionX: 10,
          positionY: 40,
          width: 30,
          height: 8,
          fieldMeta: dependentTextMeta,
        },
      ],
    });

    const [recipient] = seeded.recipients;
    const [radioField, textField] = seeded.fields;

    await openV2SigningPage(page, recipient.token);

    // Only the trigger is painted: the dependent's rule is unmet, so the signer
    // never sees it.
    expect(await getKonvaElementCountForPage(page, 1, '.field-group')).toBe(1);

    // Satisfy the rule through the same handler the canvas would call.
    const signed = await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: radioField.id,
      // The v2 signer addresses radio options by index.
      fieldValue: { type: FieldType.RADIO, value: 0 },
    });

    expect(signed.status).toBe(200);

    await openV2SigningPage(page, recipient.token);

    // The dependent is revealed now that "Married" is selected.
    await expect(async () => {
      expect(await getKonvaElementCountForPage(page, 1, '.field-group')).toBe(2);
    }).toPass({ timeout: 15_000 });

    const persistedText = await prisma.field.findFirstOrThrow({ where: { id: textField.id } });
    expect(persistedText.inserted).toBe(false);
  });

  test('the server refuses to sign a field whose visibility rule is unmet', async ({ page }) => {
    const { user, team } = await seedUser();

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `v2-hidden-${user.id}@example.com`, name: 'V2 Signer' }],
      fields: [
        { type: FieldType.RADIO, fieldMeta: radioMeta },
        { type: FieldType.TEXT, positionY: 40, fieldMeta: dependentTextMeta },
      ],
    });

    const [recipient] = seeded.recipients;
    const [, textField] = seeded.fields;

    // The trigger has not been answered, so the dependent is hidden. A client
    // that posts to it anyway must be rejected rather than quietly accepted.
    const rejected = await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: textField.id,
      fieldValue: { type: FieldType.TEXT, value: 'Should not stick' },
    });

    expect(rejected.status).toBeGreaterThanOrEqual(400);

    const persisted = await prisma.field.findFirstOrThrow({ where: { id: textField.id } });
    expect(persisted.inserted).toBe(false);
    expect(persisted.customText).toBe('');
  });
});

test.describe('copy-and-link fields on the v2 signer', () => {
  test('signing one member of a link group fans the value out to the others', async ({ page }) => {
    const { user, team } = await seedUser();

    const linkGroupId = 'link-group-under-test';

    const linkedTextMeta = (stableId: string) => ({
      type: 'text' as const,
      label: 'Full name',
      required: true,
      readOnly: false,
      stableId,
      linkGroupId,
    });

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `v2-linked-${user.id}@example.com`, name: 'V2 Signer' }],
      fields: [
        { type: FieldType.TEXT, positionY: 10, fieldMeta: linkedTextMeta('linked-a') },
        { type: FieldType.TEXT, positionY: 30, fieldMeta: linkedTextMeta('linked-b') },
        // A field outside the group must not be touched.
        {
          type: FieldType.TEXT,
          positionY: 50,
          fieldMeta: { type: 'text' as const, label: 'Unlinked', stableId: 'unlinked' },
        },
      ],
    });

    const [recipient] = seeded.recipients;
    const [firstLinked, secondLinked, unlinked] = seeded.fields;

    const response = await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: firstLinked.id,
      fieldValue: { type: FieldType.TEXT, value: 'Ada Lovelace' },
    });

    expect(response.status).toBe(200);

    // The handler reports the other group members it updated in the same
    // transaction so the client can patch its local state.
    const linkedFields = (
      response.body as {
        result?: { data?: { json?: { linkedFields?: Array<{ id: number }> } } };
      }
    ).result?.data?.json?.linkedFields;

    expect(linkedFields?.map((field) => field.id)).toEqual([secondLinked.id]);

    const [persistedFirst, persistedSecond, persistedUnlinked] = await Promise.all([
      prisma.field.findFirstOrThrow({ where: { id: firstLinked.id } }),
      prisma.field.findFirstOrThrow({ where: { id: secondLinked.id } }),
      prisma.field.findFirstOrThrow({ where: { id: unlinked.id } }),
    ]);

    expect(persistedFirst.customText).toBe('Ada Lovelace');
    expect(persistedFirst.inserted).toBe(true);

    expect(persistedSecond.customText).toBe('Ada Lovelace');
    expect(persistedSecond.inserted).toBe(true);

    expect(persistedUnlinked.customText).toBe('');
    expect(persistedUnlinked.inserted).toBe(false);
  });
});
