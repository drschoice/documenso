import { expect, test } from '@playwright/test';

import {
  type TEnvelopeEditorSurface,
  clickAddMyselfButton,
  clickEnvelopeEditorStep,
  getRecipientEmailInputs,
  openDocumentEnvelopeEditor,
  placeFieldOnPdf,
  waitForEditorCanvas,
} from '../fixtures/envelope-editor';
import { getKonvaElementCountForPage, getKonvaTextContents } from '../fixtures/konva';

/**
 * The editor's Preview step.
 *
 * `clickEnvelopeEditorStep(root, 'preview')` has been a valid argument the whole
 * time, but no spec had ever passed it, so three fork commits shipped with no
 * coverage at all:
 *
 * - `e6b3b4a7a` / `72cd27f9e`: the preview used to invent faker values for
 *   identity fields. It must now show only what the author actually configured -
 *   a field's default value, or its placeholder label.
 * - `1782c4e67`: radio/checkbox fields used to vanish from the preview when no
 *   option was pre-selected. They must render as unselected instead.
 */

const TEXT_DEFAULT_VALUE = 'Preset contract value';

const NAME_POSITION = { x: 120, y: 100 };
const EMAIL_POSITION = { x: 450, y: 100 };
const TEXT_POSITION = { x: 120, y: 340 };
const RADIO_POSITION = { x: 450, y: 340 };

const runPreviewFlow = async (surface: TEnvelopeEditorSurface) => {
  const root = surface.root;

  await clickAddMyselfButton(root);
  await expect(getRecipientEmailInputs(root).first()).toHaveValue(surface.userEmail);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  // Identity fields: the recipient fills these in at signing time.
  await placeFieldOnPdf(root, 'Name', NAME_POSITION);
  await placeFieldOnPdf(root, 'Email', EMAIL_POSITION);

  // A text field WITH an author-configured default value.
  await placeFieldOnPdf(root, 'Text', TEXT_POSITION);
  await root.locator('[data-testid="field-form-text"]').fill(TEXT_DEFAULT_VALUE);

  // A radio with named options but nothing pre-selected.
  await placeFieldOnPdf(root, 'Radio', RADIO_POSITION);
  await root.locator('[data-testid="field-form-values-0-value"]').fill('Yes');
  await root.locator('[data-testid="field-form-values-1-value"]').fill('No');

  // New v2 radios default to `showOptionText: false` (`use-editor-fields.ts`),
  // which paints the buttons without their labels. Turn it on so the preview
  // has text to assert against - and so `492e3f67a` gets exercised too.
  const showOptionText = root.locator('[data-testid="field-form-showOptionText"]');
  await expect(showOptionText).toBeVisible();

  if ((await showOptionText.getAttribute('aria-checked')) !== 'true') {
    await showOptionText.click();
  }

  await expect(showOptionText).toHaveAttribute('aria-checked', 'true');

  await root.waitForTimeout(1000);

  await clickEnvelopeEditorStep(root, 'preview');
  await waitForEditorCanvas(root);
};

test.describe('document editor', () => {
  test('preview shows configured defaults and placeholders, never invented data', async ({
    page,
  }) => {
    const surface = await openDocumentEnvelopeEditor(page);

    await runPreviewFlow(surface);

    // All four fields are painted - including the radio, whose options are all
    // unselected.
    await expect(async () => {
      expect(await getKonvaElementCountForPage(page, 1, '.field-group')).toBe(4);
    }).toPass({ timeout: 15_000 });

    const texts = await getKonvaTextContents(page, 1);
    const preview = texts.join('\n');

    // The author's default value is shown.
    expect(preview).toContain(TEXT_DEFAULT_VALUE);

    // Both radio buttons are painted even though neither is selected, and their
    // labels come through with "Show option text" enabled.
    expect(await getKonvaElementCountForPage(page, 1, '.field-option-group')).toBe(2);
    expect(preview).toContain('Yes');
    expect(preview).toContain('No');

    // Identity fields are NOT pre-filled: neither with faker data nor with the
    // author's own details. `example@documenso.com`-style addresses and the
    // seeded user's name must not appear anywhere on the preview.
    expect(preview).not.toContain(surface.userEmail);
    expect(preview).not.toContain(surface.userName);
    expect(preview).not.toMatch(/\S+@\S+\.\S+/);
  });
});
