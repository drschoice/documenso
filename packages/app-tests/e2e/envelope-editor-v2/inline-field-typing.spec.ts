import { type Page, expect, test } from '@playwright/test';

import { prisma } from '@documenso/prisma';
import { FieldType } from '@documenso/prisma/client';

import {
  clickAddMyselfButton,
  clickEnvelopeEditorStep,
  openDocumentEnvelopeEditor,
  placeFieldOnPdf,
  selectFieldOnCanvas,
  waitForEditorCanvas,
} from '../fixtures/envelope-editor';

/**
 * Typing a value straight into a selected TEXT/NUMBER field (`3bae0956a`).
 *
 * An author who already knows what a field should say - a reference number, a
 * policy name - can select it and type, instead of opening the sidebar form.
 * A value typed this way is not a suggestion: the field locks itself read-only
 * so the signer sees it but cannot change it, and drops `required`, since a
 * field nobody can edit can't meaningfully be required of them.
 *
 * The overlay is an unlabelled, `pointer-events: none` input sitting exactly on
 * top of the Konva field - deliberately invisible chrome - so it carries a
 * testid; there is nothing else to address it by.
 */

const INLINE_INPUT = '[data-testid="inline-field-value-input"]';

const FIELD_POSITION = { x: 150, y: 200 };
const SECOND_POSITION = { x: 150, y: 320 };

const openEditorWithRecipient = async (page: Page) => {
  const surface = await openDocumentEnvelopeEditor(page);

  await clickAddMyselfButton(page);
  await clickEnvelopeEditorStep(page, 'addFields');
  await waitForEditorCanvas(page);

  return surface;
};

/**
 * The field is autosaved, so its meta has to be read back from the row rather
 * than from the form. Retried, because the save follows the keystroke.
 */
const expectFieldMeta = async (
  envelopeId: string | undefined,
  type: FieldType,
  assertion: (meta: Record<string, unknown>) => void,
) => {
  await expect(async () => {
    const field = await prisma.field.findFirstOrThrow({
      where: { envelopeId, type },
    });

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    assertion((field.fieldMeta ?? {}) as Record<string, unknown>);
  }).toPass({ timeout: 30_000 });
};

test('typing into a selected text field locks it with the typed value', async ({ page }) => {
  const surface = await openEditorWithRecipient(page);

  await placeFieldOnPdf(page, 'Text', FIELD_POSITION);

  // Placing a field selects it, so the overlay is already there and focused -
  // the author never has to aim at it, which is the point of the feature.
  await expect(page.locator(INLINE_INPUT)).toBeFocused();

  await page.keyboard.type('Policy 4417');

  await expectFieldMeta(surface.envelopeId, FieldType.TEXT, (meta) => {
    expect(meta.text).toBe('Policy 4417');

    // A typed value is an answer, not a prompt: the signer sees it and cannot
    // change it, and asking them to fill in something they cannot edit would be
    // a validation error waiting to happen.
    expect(meta.readOnly).toBe(true);
    expect(meta.required).toBe(false);
  });

  // Clearing the value hands the field back to the signer rather than leaving a
  // locked, empty box.
  await page.locator(INLINE_INPUT).fill('');

  await expectFieldMeta(surface.envelopeId, FieldType.TEXT, (meta) => {
    expect(meta.text).toBe('');
    expect(meta.readOnly).toBe(false);
  });
});

test('a number field keeps only what could be a number', async ({ page }) => {
  const surface = await openEditorWithRecipient(page);

  await placeFieldOnPdf(page, 'Number', FIELD_POSITION);

  await expect(page.locator(INLINE_INPUT)).toBeFocused();

  // Letters are dropped as they are typed rather than accepted and rejected on
  // save, so the author never sees a value they cannot keep.
  await page.keyboard.type('12ab3.45cd');

  await expect(page.locator(INLINE_INPUT)).toHaveValue('123.45');

  await expectFieldMeta(surface.envelopeId, FieldType.NUMBER, (meta) => {
    expect(meta.value).toBe('123.45');
    expect(meta.readOnly).toBe(true);
  });
});

test('a value typed on one linked field reaches the whole group', async ({ page }) => {
  const surface = await openEditorWithRecipient(page);

  await placeFieldOnPdf(page, 'Text', FIELD_POSITION);
  await placeFieldOnPdf(page, 'Text', SECOND_POSITION);

  // Link the two fields, then type into one of them. Pick mode suppresses the
  // overlay, so it has to be closed again before typing.
  await selectFieldOnCanvas(page, FIELD_POSITION);

  await page.locator('[data-testid="link-fields-select"]').click();
  await expect(page.locator('[data-testid="link-fields-select"]')).toContainText('Done');

  await selectFieldOnCanvas(page, SECOND_POSITION);

  await page.locator('[data-testid="link-fields-select"]').click();
  await expect(page.locator('[data-testid="link-fields-select"]')).toContainText('Link fields');

  await selectFieldOnCanvas(page, FIELD_POSITION);

  await expect(page.locator(INLINE_INPUT)).toBeFocused();

  await page.keyboard.type('Shared value');

  // Authoring-time analogue of the sign-time fan-out: the link is only useful if
  // the mirrored fields show the value while the author is still working.
  await expect(async () => {
    const fields = await prisma.field.findMany({
      where: { envelopeId: surface.envelopeId, type: FieldType.TEXT },
    });

    expect(fields).toHaveLength(2);

    for (const field of fields) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const meta = (field.fieldMeta ?? {}) as Record<string, unknown>;

      expect(meta.text).toBe('Shared value');
      expect(meta.readOnly).toBe(true);
    }
  }).toPass({ timeout: 30_000 });
});

test('a comb field is not typed into inline', async ({ page }) => {
  await openEditorWithRecipient(page);

  await placeFieldOnPdf(page, 'Text', FIELD_POSITION);

  await expect(page.locator(INLINE_INPUT)).toBeFocused();

  // A comb field is a row of separate character cells, so a single overlaid box
  // would line up with none of them; the overlay withdraws instead.
  await page.locator('[data-testid="field-form-combMode"]').click();

  await expect(page.locator(INLINE_INPUT)).toHaveCount(0);
});

test('an inline value survives an unrelated edit in the sidebar', async ({ page }) => {
  const surface = await openEditorWithRecipient(page);

  await placeFieldOnPdf(page, 'Text', FIELD_POSITION);

  await expect(page.locator(INLINE_INPUT)).toBeFocused();

  await page.keyboard.type('Policy 4417');

  await expectFieldMeta(surface.envelopeId, FieldType.TEXT, (meta) => {
    expect(meta.text).toBe('Policy 4417');
  });

  // The sidebar form is the same field. It seeds itself from the meta once, at
  // mount, and pushes its whole state back up on any change - so before the
  // resync it answered this font-size edit by restoring its stale copy and
  // wiping the typed value (issue #35).
  await page.locator('[data-testid="field-form-fontSize"]').fill('18');

  await expectFieldMeta(surface.envelopeId, FieldType.TEXT, (meta) => {
    expect(meta.fontSize).toBe(18);
    expect(meta.text).toBe('Policy 4417');
    expect(meta.readOnly).toBe(true);
    expect(meta.required).toBe(false);
  });

  // ... and the form now shows the lock it is being asked to preserve.
  await expect(page.locator('[data-testid="field-form-readOnly"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
