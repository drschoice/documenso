import { expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';

import { seedV2PendingEnvelope, signV2FieldViaTrpc } from '../fixtures/envelope-signing';

/**
 * `4b92dfa5c`. A document's `DocumentMeta` is a snapshot taken when it was
 * created, so an organisation that revokes typed signatures - or changes its date
 * format - would historically have had no effect on documents already out for
 * signature. `resolveLiveDocumentMeta` re-resolves the snapshot against the
 * current organisation/team settings on every signing request.
 *
 * Nothing covered it, and it is the kind of setting a customer changes precisely
 * because they need it to apply to work already in flight.
 */

const updateTeamSettings = async (
  teamId: number,
  data: { typedSignatureEnabled?: boolean | null; documentDateFormat?: string | null },
) => {
  const team = await prisma.team.findFirstOrThrow({ where: { id: teamId } });

  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data,
  });
};

test.describe('organisation settings are enforced live', () => {
  test('revoking typed signatures rejects them on an already-pending envelope', async ({
    page,
  }) => {
    const { user, team } = await seedUser();

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `enforce-typed-${user.id}@example.com`, name: 'V2 Signer' }],
      // The envelope's own stored meta says typed signatures are fine. The
      // settings change below must override it anyway.
      documentMeta: { typedSignatureEnabled: true },
      fields: [
        { type: FieldType.SIGNATURE, positionY: 10, width: 30, height: 10 },
        { type: FieldType.SIGNATURE, positionY: 40, width: 30, height: 10 },
      ],
    });

    const [recipient] = seeded.recipients;
    const [firstSignature, secondSignature] = seeded.fields;

    // Baseline: with the setting on, a typed signature is accepted.
    const accepted = await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: firstSignature.id,
      fieldValue: { type: FieldType.SIGNATURE, value: 'Grace Hopper' },
    });

    expect(accepted.status).toBe(200);

    await updateTeamSettings(team.id, { typedSignatureEnabled: false });

    const rejected = await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: secondSignature.id,
      fieldValue: { type: FieldType.SIGNATURE, value: 'Grace Hopper' },
    });

    expect(rejected.status).toBeGreaterThanOrEqual(400);

    const persisted = await prisma.field.findFirstOrThrow({ where: { id: secondSignature.id } });

    expect(persisted.inserted).toBe(false);

    // The one signed before the change is left alone: the setting governs new
    // signing requests, it does not retroactively strip signatures.
    const untouched = await prisma.field.findFirstOrThrow({ where: { id: firstSignature.id } });

    expect(untouched.inserted).toBe(true);
  });

  test('a null date format inherits the current team setting rather than the one at creation', async ({
    page,
  }) => {
    const { user, team } = await seedUser();

    await updateTeamSettings(team.id, { documentDateFormat: 'yyyy-MM-dd' });

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `enforce-date-${user.id}@example.com`, name: 'V2 Signer' }],
      // null means "inherit", which is what makes this live rather than frozen.
      documentMeta: { dateFormat: null, timezone: 'Etc/UTC' },
      fields: [
        { type: FieldType.DATE, positionY: 10, width: 30, height: 10 },
        { type: FieldType.DATE, positionY: 40, width: 30, height: 10 },
      ],
    });

    const [recipient] = seeded.recipients;
    const [firstDate, secondDate] = seeded.fields;

    await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: firstDate.id,
      fieldValue: { type: FieldType.DATE, value: '2026-03-15T12:00:00.000Z' },
    });

    expect((await prisma.field.findFirstOrThrow({ where: { id: firstDate.id } })).customText).toBe(
      '2026-03-15',
    );

    await updateTeamSettings(team.id, { documentDateFormat: 'dd/MM/yyyy' });

    await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: secondDate.id,
      fieldValue: { type: FieldType.DATE, value: '2026-03-15T12:00:00.000Z' },
    });

    expect((await prisma.field.findFirstOrThrow({ where: { id: secondDate.id } })).customText).toBe(
      '15/03/2026',
    );
  });

  test('an explicit date format on the envelope is not overridden by the team setting', async ({
    page,
  }) => {
    const { user, team } = await seedUser();

    await updateTeamSettings(team.id, { documentDateFormat: 'dd/MM/yyyy' });

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `enforce-date-fixed-${user.id}@example.com`, name: 'V2 Signer' }],
      documentMeta: { dateFormat: 'yyyy-MM-dd', timezone: 'Etc/UTC' },
      fields: [{ type: FieldType.DATE, positionY: 10, width: 30, height: 10 }],
    });

    const [recipient] = seeded.recipients;
    const [dateField] = seeded.fields;

    await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: dateField.id,
      fieldValue: { type: FieldType.DATE, value: '2026-03-15T12:00:00.000Z' },
    });

    // Only `null` means inherit. An author who chose a format keeps it.
    expect((await prisma.field.findFirstOrThrow({ where: { id: dateField.id } })).customText).toBe(
      '2026-03-15',
    );
  });
});
