import { expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { nanoid } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';

import {
  type TEnvelopeEditorSurface,
  clickAddMyselfButton,
  clickEnvelopeEditorStep,
  getEnvelopeEditorSettingsTrigger,
  getRecipientEmailInputs,
  openDocumentEnvelopeEditor,
  openTemplateEnvelopeEditor,
  placeFieldOnPdf,
  selectFieldOnCanvas,
  waitForEditorCanvas,
} from '../fixtures/envelope-editor';

/**
 * Trigger-centric ("PandaDoc style") conditional visibility authoring.
 *
 * `36feb59be` replaced the old per-dependent rule builder with this flow, but
 * only rewrote the comments inside the existing `test.fixme` - the shipping
 * authoring UI had no executable coverage at all, and neither did the pick-mode
 * banner (`8fe252acf`) or the dependency notice (`8932456ef`).
 *
 * Rules are authored on the TRIGGER (select an option, pick the fields it
 * reveals) but stored on each DEPENDENT as `fieldMeta.visibility`, so every
 * assertion here checks the dependent's meta.
 */

const RADIO_OPTIONS = ['Married', 'Single'];

const DEPENDENT_LABEL = 'Spouse name';
const UNRELATED_LABEL = 'Always visible';

// Canvas-relative placements. The selected field's floating action toolbar
// covers roughly 30-110px below it, so keep placements well apart.
const TRIGGER_POSITION = { x: 120, y: 80 };
const DEPENDENT_POSITION = { x: 450, y: 320 };
const UNRELATED_POSITION = { x: 120, y: 560 };

const openSettingsDialog = async (surface: TEnvelopeEditorSurface) => {
  await getEnvelopeEditorSettingsTrigger(surface.root).click();
  await expect(surface.root.getByRole('heading', { name: 'Document Settings' })).toBeVisible();
};

const updateExternalId = async (surface: TEnvelopeEditorSurface, externalId: string) => {
  await openSettingsDialog(surface);
  await surface.root.locator('input[name="externalId"]').fill(externalId);
  await surface.root.getByRole('button', { name: 'Update' }).click();

  // Barrier: the dialog closes (`setOpen(false)`) as soon as the update
  // mutation resolves, immediately before the success toast is raised. The
  // toast itself is not usable as a barrier - it lives about a second and
  // `TOAST_LIMIT` is 1, so any other toast in the same beat evicts it. That the
  // update really landed is proven later by looking the envelope up by this
  // externalId.
  await expect(surface.root.getByRole('heading', { name: 'Document Settings' })).toBeHidden();
};

/**
 * Place two TEXT fields and then a RADIO trigger, and use pick-mode to reveal
 * one of the TEXT fields when "Married" is selected.
 *
 * Order matters: the trigger goes down LAST so it is still the selected field
 * when the conditional-visibility section is driven. New v2 radios default to
 * free placement (`use-editor-fields.ts`), where the options are positioned by
 * offset and the field itself has no solid rect to click, so re-selecting a
 * radio from the canvas is not reliable. The dependents are ordinary boxed
 * fields, so they are what gets re-selected to prove the rule round-trips.
 */
const runConditionalVisibilityAuthoringFlow = async (surface: TEnvelopeEditorSurface) => {
  const externalId = `e2e-conditional-${nanoid()}`;
  const root = surface.root;

  await updateExternalId(surface, externalId);

  await clickAddMyselfButton(root);
  await expect(getRecipientEmailInputs(root).first()).toHaveValue(surface.userEmail);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  // --- the dependents ----------------------------------------------------
  await placeFieldOnPdf(root, 'Text', DEPENDENT_POSITION);
  await root.locator('[data-testid="field-form-label"]').fill(DEPENDENT_LABEL);

  await placeFieldOnPdf(root, 'Text', UNRELATED_POSITION);
  await root.locator('[data-testid="field-form-label"]').fill(UNRELATED_LABEL);

  // --- the trigger, placed last so it stays selected ----------------------
  await placeFieldOnPdf(root, 'Radio', TRIGGER_POSITION);

  // Radio ships with two blank options; naming them is what makes the
  // conditional-visibility section render a row per option.
  await root.locator('[data-testid="field-form-values-0-value"]').fill(RADIO_OPTIONS[0]);
  await root.locator('[data-testid="field-form-values-1-value"]').fill(RADIO_OPTIONS[1]);

  // --- author the rule ---------------------------------------------------
  const section = root.locator('[data-testid="conditional-visibility-section"]');
  await expect(section).toBeVisible();

  // One row per named option, in order.
  await expect(root.locator('[data-testid="visibility-condition-0"]')).toContainText(
    RADIO_OPTIONS[0],
  );
  await expect(root.locator('[data-testid="visibility-condition-1"]')).toContainText(
    RADIO_OPTIONS[1],
  );

  // Enter pick mode for "Married". The banner is what tells the author that the
  // canvas is now in a different mode.
  await root.locator('[data-testid="visibility-select-fields-0"]').click();
  await expect(root.locator('[data-testid="pick-mode-banner"]')).toBeVisible();
  await expect(root.locator('[data-testid="visibility-select-fields-0"]')).toContainText('Done');

  // Clicking a field on the canvas toggles it into the condition.
  await selectFieldOnCanvas(root, DEPENDENT_POSITION);
  await expect(root.locator('[data-testid="visibility-condition-0"]')).toContainText(
    DEPENDENT_LABEL,
  );

  // The unrelated field is not picked, so it must not join the condition.
  await expect(root.locator('[data-testid="visibility-condition-0"]')).not.toContainText(
    UNRELATED_LABEL,
  );

  // Leaving pick mode dismisses the banner.
  await root.locator('[data-testid="visibility-select-fields-0"]').click();
  await expect(root.locator('[data-testid="pick-mode-banner"]')).toBeHidden();

  // Let autosave settle, then round-trip through another step.
  await root.waitForTimeout(1000);
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  // The dependent advertises which trigger controls it, and still does after
  // the round trip.
  await selectFieldOnCanvas(root, DEPENDENT_POSITION);
  await expect(root.locator('[data-testid="visibility-dependency-notice"]')).toBeVisible();

  // The field nobody picked has no such notice.
  await selectFieldOnCanvas(root, UNRELATED_POSITION);
  await expect(root.locator('[data-testid="visibility-dependency-notice"]')).toBeHidden();

  return { externalId };
};

const assertVisibilityRulePersisted = async ({
  surface,
  externalId,
}: {
  surface: TEnvelopeEditorSurface;
  externalId: string;
}) => {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: {
      externalId,
      userId: surface.userId,
      teamId: surface.teamId,
      type: surface.envelopeType,
    },
    include: { fields: true },
    orderBy: { createdAt: 'desc' },
  });

  const radio = envelope.fields.find((field) => field.type === FieldType.RADIO);
  const textFields = envelope.fields.filter((field) => field.type === FieldType.TEXT);

  expect(radio).toBeDefined();
  expect(textFields).toHaveLength(2);

  const radioMeta = radio?.fieldMeta as { stableId?: string } | null;
  expect(typeof radioMeta?.stableId).toBe('string');

  const metaOf = (label: string) => {
    const field = textFields.find(
      (candidate) => (candidate.fieldMeta as { label?: string } | null)?.label === label,
    );

    expect(field, `expected a TEXT field labelled "${label}"`).toBeDefined();

    return field?.fieldMeta as {
      visibility?: {
        match: string;
        rules: Array<{ operator: string; triggerFieldStableId: string; value?: string }>;
      };
    } | null;
  };

  const dependentMeta = metaOf(DEPENDENT_LABEL);

  expect(dependentMeta?.visibility).toBeDefined();
  expect(dependentMeta?.visibility?.rules).toHaveLength(1);
  expect(dependentMeta?.visibility?.rules[0]).toMatchObject({
    // A radio is single-value, so the authored rule is an equality test
    // (operatorForTriggerType).
    operator: 'equals',
    triggerFieldStableId: radioMeta?.stableId,
    value: RADIO_OPTIONS[0],
  });

  // The field that was never picked stays unconditional.
  expect(metaOf(UNRELATED_LABEL)?.visibility).toBeUndefined();
};

test.describe('document editor', () => {
  test('author a visibility rule through trigger pick-mode', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runConditionalVisibilityAuthoringFlow(surface);

    await assertVisibilityRulePersisted({ surface, ...result });
  });
});

test.describe('template editor', () => {
  test('author a visibility rule through trigger pick-mode', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const result = await runConditionalVisibilityAuthoringFlow(surface);

    await assertVisibilityRulePersisted({ surface, ...result });
  });
});
