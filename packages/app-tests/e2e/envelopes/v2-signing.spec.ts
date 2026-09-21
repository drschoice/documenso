import { expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';
import { DateTime } from 'luxon';

import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';

import {
  clickV2SigningField,
  clickV2SigningRadioOption,
  completeV2SigningViaTrpc,
  expectEnvelopeCompleted,
  openV2SigningPage,
  seedV2PendingEnvelope,
  signV2FieldViaTrpc,
} from '../fixtures/envelope-signing';
import {
  getAllKonvaNodeAttrs,
  getKonvaElementCountForPage,
  getKonvaTextContents,
  getKonvaTextContentsFor,
} from '../fixtures/konva';

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

  /**
   * `3f2264a1a`. A field appearing out of nowhere is silent to a screen reader,
   * so the provider announces it through a visually-hidden `role="status"`
   * region.
   *
   * This has to be driven by clicking the trigger: the announcement fires on the
   * transition from hidden to visible *within a session*
   * (`prev.get(id) === false`), so the test above - which signs through tRPC and
   * reloads - cannot reach it. The message also clears itself after two seconds.
   */
  test('revealing a dependent is announced to assistive technology', async ({ page }) => {
    const { user, team } = await seedUser();

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `v2-announce-${user.id}@example.com`, name: 'V2 Signer' }],
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
    const [radioField] = seeded.fields;

    await openV2SigningPage(page, recipient.token);

    const status = page.locator('[data-testid="revealed-field-announcer"]');

    // Nothing has changed yet, so there is nothing to announce.
    await expect(status).toHaveText('');

    // "Married" is the first option, and the one the dependent's rule names.
    await clickV2SigningRadioOption(page, radioField.id, 0);

    await expect(status).toHaveText(`Field revealed: ${dependentTextMeta.label}`);

    // The dependent really is on the canvas now, not just announced.
    await expect(async () => {
      expect(await getKonvaElementCountForPage(page, 1, '.field-group')).toBe(2);
    }).toPass({ timeout: 15_000 });

    // The region empties again so the next reveal is announced as a change
    // rather than being swallowed as identical text.
    await expect(status).toHaveText('', { timeout: 5_000 });
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

test.describe('the date field dialog on the v2 signer', () => {
  /**
   * `21551a2ff` replaced the auto-inserted DATE field with a calendar dialog. Every
   * pre-existing DATE test drives the v1 renderer, which still auto-inserts, so the
   * dialog has never been opened by a test.
   */
  test('clicking a date field opens the picker and persists the chosen day', async ({ page }) => {
    const { user, team } = await seedUser();

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `v2-date-${user.id}@example.com`, name: 'V2 Signer' }],
      // Date-only so the assertion is about the calendar day, which is the whole
      // point of the field, rather than about the minute the test happened to run.
      documentMeta: { dateFormat: 'yyyy-MM-dd', timezone: 'Etc/UTC' },
      fields: [
        {
          type: FieldType.DATE,
          width: 30,
          height: 10,
          fieldMeta: { type: 'date', label: 'Date of signature' },
        },
      ],
    });

    const [recipient] = seeded.recipients;
    const [dateField] = seeded.fields;

    await openV2SigningPage(page, recipient.token);
    await clickV2SigningField(page, dateField.id);

    // The dialog titles itself with the field's label rather than the generic
    // "Select Date" when the author set one.
    await expect(page.getByRole('dialog').getByText('Date of signature')).toBeVisible();

    await page.getByRole('button', { name: 'Confirm' }).click();

    // The dialog opens on today, so confirming without touching the calendar signs
    // today. `DateTime.local()` reads the same clock and zone as the browser.
    const today = DateTime.local().toFormat('yyyy-MM-dd');

    await expect(async () => {
      const persisted = await prisma.field.findFirstOrThrow({ where: { id: dateField.id } });

      expect(persisted.inserted).toBe(true);
      expect(persisted.customText).toBe(today);
    }).toPass({ timeout: 15_000 });
  });

  test('cancelling the picker leaves the field unsigned', async ({ page }) => {
    const { user, team } = await seedUser();

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `v2-date-cancel-${user.id}@example.com`, name: 'V2 Signer' }],
      documentMeta: { dateFormat: 'yyyy-MM-dd', timezone: 'Etc/UTC' },
      fields: [{ type: FieldType.DATE, width: 30, height: 10, fieldMeta: { type: 'date' } }],
    });

    const [recipient] = seeded.recipients;
    const [dateField] = seeded.fields;

    await openV2SigningPage(page, recipient.token);
    await clickV2SigningField(page, dateField.id);

    // No label was set, so the dialog falls back to its generic title.
    await expect(page.getByRole('dialog').getByText('Select Date')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    const persisted = await prisma.field.findFirstOrThrow({ where: { id: dateField.id } });

    expect(persisted.inserted).toBe(false);
    expect(persisted.customText).toBe('');
  });

  /**
   * `287d23732`. The dialog encodes the chosen day as **UTC noon** rather than as
   * local midnight, because the server formats it with
   * `.setZone(documentMeta.timezone)` before writing `customText`
   * (`packages/lib/utils/envelope-signing.ts`). Local midnight in an eastern zone
   * lands on the previous UTC day, so a signer in Sydney picking the 15th had the
   * 14th sealed into the PDF for a document rendered in New York.
   *
   * Noon leaves ~12 hours of headroom either way, which covers every zone from
   * UTC-12 to UTC+11. This asserts both ends of that range.
   */
  for (const timezone of ['Pacific/Niue', 'Asia/Tokyo']) {
    test(`a UTC-noon date renders as the same calendar day in ${timezone}`, async ({ page }) => {
      const { user, team } = await seedUser();

      const seeded = await seedV2PendingEnvelope({
        ownerUserId: user.id,
        teamId: team.id,
        recipients: [{ email: `v2-date-tz-${user.id}@example.com`, name: 'V2 Signer' }],
        documentMeta: { dateFormat: 'yyyy-MM-dd', timezone },
        fields: [{ type: FieldType.DATE, width: 30, height: 10, fieldMeta: { type: 'date' } }],
      });

      const [recipient] = seeded.recipients;
      const [dateField] = seeded.fields;

      const response = await signV2FieldViaTrpc(page, {
        token: recipient.token,
        fieldId: dateField.id,
        fieldValue: { type: FieldType.DATE, value: '2026-03-15T12:00:00.000Z' },
      });

      expect(response.status).toBe(200);

      const persisted = await prisma.field.findFirstOrThrow({ where: { id: dateField.id } });

      expect(persisted.customText).toBe('2026-03-15');
    });
  }
});

test.describe("other recipients' fields on the v2 signer", () => {
  /**
   * `520b44858`. The signer used to see only fields belonging to recipients who had
   * already finished; now every other recipient's fields are painted greyed out and
   * non-interactive so the signer can see the shape of the whole document.
   *
   * Two things there are worth protecting. The greyed fields must not swallow
   * clicks - they are drawn first, underneath, and explicitly given
   * `listening(false)` - and a *pending* recipient's in-progress value must never
   * be shown to anyone else.
   */
  test('are painted but non-interactive, and a pending signer’s input stays private', async ({
    page,
  }) => {
    const { user, team } = await seedUser();

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [
        { email: `v2-viewer-${user.id}@example.com`, name: 'First Signer' },
        { email: `v2-other-${user.id}@example.com`, name: 'Second Signer' },
      ],
      fields: [
        {
          type: FieldType.TEXT,
          recipientIndex: 0,
          positionY: 10,
          width: 30,
          fieldMeta: { type: 'text', label: 'Mine' },
        },
        {
          type: FieldType.TEXT,
          recipientIndex: 1,
          positionY: 40,
          width: 30,
          customText: 'IN PROGRESS, NOT YET SUBMITTED',
          inserted: true,
          fieldMeta: { type: 'text', label: 'Theirs' },
        },
      ],
    });

    const [firstRecipient, secondRecipient] = seeded.recipients;

    await openV2SigningPage(page, firstRecipient.token);

    await expect(async () => {
      const groups = await getAllKonvaNodeAttrs(page, 1, '.field-group');

      expect(groups).toHaveLength(2);
      // Exactly one of the two is inert: the other recipient's.
      expect(groups.filter((group) => group.listening)).toHaveLength(1);
      expect(groups.filter((group) => !group.listening)).toHaveLength(1);
    }).toPass({ timeout: 15_000 });

    // The second recipient is still NOT_SIGNED, so their value is blanked out even
    // though the field itself is drawn.
    const whilePending = await getKonvaTextContents(page, 1);
    expect(whilePending.join('\n')).not.toContain('IN PROGRESS, NOT YET SUBMITTED');

    await prisma.recipient.update({
      where: { id: secondRecipient.id },
      data: { signingStatus: SigningStatus.SIGNED, signedAt: new Date() },
    });

    await openV2SigningPage(page, firstRecipient.token);

    // Once they have finished, the same value becomes part of the document the
    // first signer is being asked to sign, so it is shown.
    await expect(async () => {
      const afterSigning = await getKonvaTextContents(page, 1);

      expect(afterSigning.join('\n')).toContain('IN PROGRESS, NOT YET SUBMITTED');
    }).toPass({ timeout: 15_000 });
  });
});

test.describe('next-field navigation restricts which fields block completion', () => {
  /**
   * `04dbd580c`. Setting `nextFieldNavigationTypes` / `nextFieldNavigationLabels` on
   * the envelope does more than steer the "next field" button: both
   * `complete-document-with-token.ts` and `seal-document.handler.ts` re-check
   * required fields against that filter, so fields outside it stop being mandatory.
   *
   * That is a completion-gating change with no coverage at all, and it is asserted
   * here against the server rather than the UI because the signing page disables
   * its own Complete button while required fields are outstanding.
   */
  const seedNavigationEnvelope = async (
    userId: number,
    teamId: number,
    documentMeta: Parameters<typeof seedV2PendingEnvelope>[0]['documentMeta'],
  ) =>
    seedV2PendingEnvelope({
      ownerUserId: userId,
      teamId,
      recipients: [{ email: `v2-nav-${userId}-${Date.now()}@example.com`, name: 'V2 Signer' }],
      documentMeta,
      fields: [
        { type: FieldType.SIGNATURE, positionY: 10, width: 30, height: 10 },
        {
          type: FieldType.TEXT,
          positionY: 40,
          width: 30,
          fieldMeta: { type: 'text', label: 'Optional under the filter', required: true },
        },
      ],
    });

  test('a required field outside the filter no longer blocks completion', async ({ page }) => {
    const { user, team } = await seedUser();

    const seeded = await seedNavigationEnvelope(user.id, team.id, {
      nextFieldNavigationTypes: [FieldType.SIGNATURE],
    });

    const [recipient] = seeded.recipients;
    const [signatureField, textField] = seeded.fields;

    const signed = await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: signatureField.id,
      fieldValue: { type: FieldType.SIGNATURE, value: 'Ada Lovelace' },
    });

    expect(signed.status).toBe(200);

    const completed = await completeV2SigningViaTrpc(page, {
      token: recipient.token,
      documentId: seeded.documentId,
    });

    expect(completed.status).toBe(200);

    // Sealing applies the same filter, so reaching COMPLETED proves both halves.
    await expectEnvelopeCompleted(seeded.envelope.id);

    const persistedText = await prisma.field.findFirstOrThrow({ where: { id: textField.id } });
    expect(persistedText.inserted).toBe(false);
  });

  test('the same envelope without a filter refuses to complete', async ({ page }) => {
    const { user, team } = await seedUser();

    const seeded = await seedNavigationEnvelope(user.id, team.id, undefined);

    const [recipient] = seeded.recipients;
    const [signatureField] = seeded.fields;

    await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: signatureField.id,
      fieldValue: { type: FieldType.SIGNATURE, value: 'Ada Lovelace' },
    });

    const completed = await completeV2SigningViaTrpc(page, {
      token: recipient.token,
      documentId: seeded.documentId,
    });

    expect(completed.status).toBeGreaterThanOrEqual(400);

    const envelope = await prisma.envelope.findFirstOrThrow({
      where: { id: seeded.envelope.id },
    });

    expect(envelope.status).toBe('PENDING');
  });

  test('the filter can be expressed by field label instead of type', async ({ page }) => {
    const { user, team } = await seedUser();

    const seeded = await seedNavigationEnvelope(user.id, team.id, {
      nextFieldNavigationLabels: ['Optional under the filter'],
    });

    const [recipient] = seeded.recipients;
    const [, textField] = seeded.fields;

    // Mirror image of the type-filtered case: here the TEXT field is the only one
    // in the filter, so the always-required SIGNATURE is what gets waived.
    const signed = await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: textField.id,
      fieldValue: { type: FieldType.TEXT, value: 'Filled in' },
    });

    expect(signed.status).toBe(200);

    const completed = await completeV2SigningViaTrpc(page, {
      token: recipient.token,
      documentId: seeded.documentId,
    });

    expect(completed.status).toBe(200);
    await expectEnvelopeCompleted(seeded.envelope.id);
  });
});

test.describe('name parts on the v2 signer', () => {
  /**
   * `e77aacc48` gave recipients first/middle/last columns and let a NAME field bind
   * to one of them via `fieldMeta.namePart`. The recipient-side columns are covered
   * by `envelope-recipients.spec.ts`; what happens at signing time is not.
   *
   * Clicking a bound NAME field signs it outright - `handleNameFieldClick` only
   * falls back to a dialog when the part resolves to nothing - so this also pins
   * down that a part-bound field never opens one.
   */
  test('each part-bound name field signs with only its own part', async ({ page }) => {
    const { user, team } = await seedUser();

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [
        {
          email: `v2-nameparts-${user.id}@example.com`,
          name: 'Ada Augusta Lovelace',
          firstName: 'Ada',
          middleName: 'Augusta',
          lastName: 'Lovelace',
        },
      ],
      fields: (['full', 'first', 'middle', 'last'] as const).map((namePart, index) => ({
        type: FieldType.NAME,
        positionY: 10 + index * 15,
        width: 30,
        height: 8,
        fieldMeta: { type: 'name' as const, namePart },
      })),
    });

    const [recipient] = seeded.recipients;
    const [fullField, firstField, middleField, lastField] = seeded.fields;

    await openV2SigningPage(page, recipient.token);

    // One at a time, waiting for each to land. Signing re-renders the stage, so
    // clicking straight through all four races the repaint and a click can be
    // delivered to a node that is being replaced.
    const signNameField = async (fieldId: number, expected: string) => {
      await expect(async () => {
        const persisted = await prisma.field.findFirstOrThrow({ where: { id: fieldId } });

        if (persisted.customText === expected) {
          return;
        }

        await clickV2SigningField(page, fieldId);

        const after = await prisma.field.findFirstOrThrow({ where: { id: fieldId } });

        expect(after.customText).toBe(expected);
      }).toPass({ timeout: 30_000 });
    };

    await signNameField(fullField.id, 'Ada Augusta Lovelace');
    await signNameField(firstField.id, 'Ada');
    await signNameField(middleField.id, 'Augusta');
    await signNameField(lastField.id, 'Lovelace');

    // No dialog at any point: every part resolved off the recipient's columns,
    // so `handleNameFieldClick` never had to fall back to asking.
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});

test.describe('comb fields on the v2 signer', () => {
  const CELL_COUNT = 6;

  const combTextMeta = {
    type: 'text' as const,
    label: 'Reference',
    required: true,
    readOnly: false,
    layout: 'cells' as const,
    cellSize: 20,
    cells: Array.from({ length: CELL_COUNT }, (_, index) => ({
      id: index + 1,
      offsetX: index * 4,
      offsetY: 0,
    })),
  };

  const seedCombEnvelope = async () => {
    const { user, team } = await seedUser();

    return await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `comb-signing-${user.id}@example.com`, name: 'Comb Signer' }],
      fields: [
        {
          type: FieldType.TEXT,
          positionY: 20,
          width: 30,
          height: 8,
          fieldMeta: combTextMeta,
        },
      ],
    });
  };

  test('the cell count is the character limit, and each character lands in a cell', async ({
    page,
  }) => {
    const seeded = await seedCombEnvelope();

    const [recipient] = seeded.recipients;
    const [combField] = seeded.fields;

    // A comb field has no separate `characterLimit`: the cells are the limit, so
    // a seventh character has nowhere to go and the server says so rather than
    // silently dropping it.
    const tooLong = await signV2FieldViaTrpc(page, {
      token: recipient.token,
      fieldId: combField.id,
      fieldValue: { type: FieldType.TEXT, value: 'ABC1234' },
    });

    // The message names the limit it hit, rather than the "Invalid email" this
    // branch used to report for any text field (issue #36).
    expect(JSON.stringify(tooLong.body)).toContain('exceeds the character limit (6)');

    const unsigned = await prisma.field.findFirstOrThrow({ where: { id: combField.id } });

    expect(unsigned.inserted).toBe(false);

    expect(
      (
        await signV2FieldViaTrpc(page, {
          token: recipient.token,
          fieldId: combField.id,
          fieldValue: { type: FieldType.TEXT, value: 'ABC123' },
        })
      ).status,
    ).toBe(200);

    await openV2SigningPage(page, recipient.token);

    // One text node per cell rather than one string in a box - that is the whole
    // difference between a comb field and a text field wearing a grid.
    await expect(async () => {
      expect(await getKonvaTextContentsFor(page, 1, '.field-cell-text')).toEqual([
        'A',
        'B',
        'C',
        '1',
        '2',
        '3',
      ]);
    }).toPass({ timeout: 30_000 });

    expect(await getKonvaElementCountForPage(page, 1, '.field-option-group')).toBe(CELL_COUNT);
  });

  test('a comb field shorter than its cells leaves the rest empty', async ({ page }) => {
    const seeded = await seedCombEnvelope();

    const [recipient] = seeded.recipients;
    const [combField] = seeded.fields;

    expect(
      (
        await signV2FieldViaTrpc(page, {
          token: recipient.token,
          fieldId: combField.id,
          fieldValue: { type: FieldType.TEXT, value: 'AB' },
        })
      ).status,
    ).toBe(200);

    await openV2SigningPage(page, recipient.token);

    // The cells stay - a partly filled comb still has to read as a form field
    // with room left, not as a two-character text box.
    await expect(async () => {
      expect(await getKonvaTextContentsFor(page, 1, '.field-cell-text')).toEqual([
        'A',
        'B',
        '',
        '',
        '',
        '',
      ]);
    }).toPass({ timeout: 30_000 });

    expect(await getKonvaElementCountForPage(page, 1, '.field-option-group')).toBe(CELL_COUNT);
  });
});
