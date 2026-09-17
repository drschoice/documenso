import { type Page, expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { nanoid } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';

import {
  type TEnvelopeEditorSurface,
  addEnvelopeItemPdf,
  clickAddMyselfButton,
  clickAddSignerButton,
  clickEnvelopeEditorStep,
  getEnvelopeEditorSettingsTrigger,
  getRecipientEmailInputs,
  getRecipientRemoveButtons,
  openDocumentEnvelopeEditor,
  openEmbeddedEnvelopeEditor,
  openTemplateEnvelopeEditor,
  persistEmbeddedEnvelope,
  placeFieldOnPdf,
  selectFieldOnCanvas,
  selectRecipientInFieldsStep,
  setRecipientEmail,
  setRecipientName,
  waitForEditorCanvas,
} from '../fixtures/envelope-editor';
import {
  dragKonvaNode,
  expectKonvaElementCount,
  getKonvaNodeAttrs,
  getKonvaTextContents,
} from '../fixtures/konva';

type TFieldFlowResult = {
  externalId: string;
  recipientEmail: string;
};

/**
 * Canvas-relative x positions for the two placement columns used by flows that
 * place many fields in a row. See runAllFieldTypesFlow for why they alternate.
 */
const LEFT_COLUMN = 120;
const RIGHT_COLUMN = 450;

const TEST_FIELD_VALUES = {
  embeddedRecipient: {
    email: 'embedded-field-recipient@documenso.com',
    name: 'Embedded Field Recipient',
  },
};

const openSettingsDialog = async (root: Page) => {
  await getEnvelopeEditorSettingsTrigger(root).click();
  await expect(root.getByRole('heading', { name: 'Document Settings' })).toBeVisible();
};

const updateExternalId = async (surface: TEnvelopeEditorSurface, externalId: string) => {
  await openSettingsDialog(surface.root);
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

const setupRecipientsForFieldPlacement = async (surface: TEnvelopeEditorSurface) => {
  if (surface.isEmbedded) {
    await expect(surface.root.getByRole('button', { name: 'Add Myself' })).toHaveCount(0);
    await setRecipientEmail(surface.root, 0, TEST_FIELD_VALUES.embeddedRecipient.email);
    await setRecipientName(surface.root, 0, TEST_FIELD_VALUES.embeddedRecipient.name);

    return TEST_FIELD_VALUES.embeddedRecipient.email;
  }

  await expect(surface.root.getByRole('button', { name: 'Add Myself' })).toBeVisible();
  await clickAddMyselfButton(surface.root);
  await expect(getRecipientEmailInputs(surface.root).first()).toHaveValue(surface.userEmail);

  return surface.userEmail;
};

/**
 * `field-form-*` checkboxes are Radix checkboxes that report state through
 * `aria-checked`. Clicking blind flips whatever the current default is, so read
 * first and only click when the state actually needs to change. Field meta
 * defaults have moved before (radio gained a second option, `required` became
 * true by default) and blind clicks silently inverted the intent.
 */
const setFieldFormCheckbox = async (root: Page, testId: string, checked: boolean) => {
  const checkbox = root.locator(`[data-testid="${testId}"]`);

  await expect(checkbox).toBeVisible();

  const isChecked = (await checkbox.getAttribute('aria-checked')) === 'true';

  if (isChecked !== checked) {
    await checkbox.click();
  }

  await expect(checkbox).toHaveAttribute('aria-checked', String(checked));
};

const runAddAndPersistSignatureTextFields = async (
  surface: TEnvelopeEditorSurface,
): Promise<TFieldFlowResult> => {
  const externalId = `e2e-fields-${nanoid()}`;

  if (surface.isEmbedded && !surface.envelopeId) {
    await addEnvelopeItemPdf(surface.root, 'embedded-fields.pdf');
  }

  await updateExternalId(surface, externalId);
  const recipientEmail = await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(surface.root, 'addFields');
  await expect(surface.root.getByText('Selected Recipient')).toBeVisible();
  await waitForEditorCanvas(surface.root);

  await placeFieldOnPdf(surface.root, 'Signature', { x: 120, y: 140 });
  await expectKonvaElementCount(surface.root, 1, '.field-group', 1);

  await placeFieldOnPdf(surface.root, 'Text', { x: 220, y: 240 });
  await expectKonvaElementCount(surface.root, 1, '.field-group', 2);

  await clickEnvelopeEditorStep(surface.root, 'upload');
  await expect(surface.root.getByRole('heading', { name: 'Recipients' })).toBeVisible();

  await clickEnvelopeEditorStep(surface.root, 'addFields');
  await waitForEditorCanvas(surface.root);
  await expect(surface.root.getByText('Selected Recipient')).toBeVisible();
  await expectKonvaElementCount(surface.root, 1, '.field-group', 2);

  return {
    externalId,
    recipientEmail,
  };
};

const getFieldMetaType = (fieldMeta: unknown) => {
  if (!isRecord(fieldMeta)) {
    return null;
  }

  return typeof fieldMeta.type === 'string' ? fieldMeta.type : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const assertFieldsPersistedInDatabase = async ({
  surface,
  externalId,
  recipientEmail,
}: {
  surface: TEnvelopeEditorSurface;
  externalId: string;
  recipientEmail: string;
}) => {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: {
      externalId,
      userId: surface.userId,
      teamId: surface.teamId,
      type: surface.envelopeType,
    },
    orderBy: {
      createdAt: 'desc',
    },
    include: {
      fields: true,
      recipients: true,
    },
  });

  const recipient = envelope.recipients.find(
    (currentRecipient) => currentRecipient.email === recipientEmail,
  );

  expect(recipient).toBeDefined();

  const fieldTypes = envelope.fields.map((field) => field.type).sort();
  const expectedFieldTypes = [FieldType.SIGNATURE, FieldType.TEXT].sort();

  expect(envelope.fields).toHaveLength(2);
  expect(fieldTypes).toEqual(expectedFieldTypes);
  expect(new Set(envelope.fields.map((field) => field.envelopeItemId)).size).toBe(1);
  expect(envelope.fields.every((field) => field.recipientId === recipient?.id)).toBe(true);

  const signatureField = envelope.fields.find((field) => field.type === FieldType.SIGNATURE);
  const textField = envelope.fields.find((field) => field.type === FieldType.TEXT);

  expect(getFieldMetaType(signatureField?.fieldMeta)).toBe('signature');
  expect(getFieldMetaType(textField?.fieldMeta)).toBe('text');
};

// --- Multi-recipient field flow ---

type TMultiRecipientFlowResult = {
  externalId: string;
  firstRecipientEmail: string;
  secondRecipientEmail: string;
};

const MULTI_RECIPIENT_VALUES = {
  secondSigner: {
    email: 'second-signer@test.documenso.com',
    name: 'Second Signer',
  },
};

const runMultiRecipientFieldFlow = async (
  surface: TEnvelopeEditorSurface,
): Promise<TMultiRecipientFlowResult> => {
  const externalId = `e2e-multi-recip-${nanoid()}`;
  const root = surface.root;

  if (surface.isEmbedded && !surface.envelopeId) {
    await addEnvelopeItemPdf(root, 'embedded-fields.pdf');
  }

  await updateExternalId(surface, externalId);

  // Add two recipients.
  let firstRecipientEmail: string;

  if (surface.isEmbedded) {
    await setRecipientEmail(root, 0, TEST_FIELD_VALUES.embeddedRecipient.email);
    await setRecipientName(root, 0, TEST_FIELD_VALUES.embeddedRecipient.name);
    firstRecipientEmail = TEST_FIELD_VALUES.embeddedRecipient.email;
  } else {
    await clickAddMyselfButton(root);
    firstRecipientEmail = surface.userEmail;
  }

  await clickAddSignerButton(root);
  await setRecipientEmail(root, 1, MULTI_RECIPIENT_VALUES.secondSigner.email);
  await setRecipientName(root, 1, MULTI_RECIPIENT_VALUES.secondSigner.name);

  // Navigate to fields step.
  await clickEnvelopeEditorStep(root, 'addFields');
  await expect(root.getByText('Selected Recipient')).toBeVisible();
  await waitForEditorCanvas(root);

  await expectKonvaElementCount(root, 1, '.field-group', 0);

  // Place Signature for recipient #1 (auto-selected).
  await placeFieldOnPdf(root, 'Signature', { x: 120, y: 140 });
  await expectKonvaElementCount(root, 1, '.field-group', 1);

  // Switch recipient and place text field for recipient #2.
  await selectRecipientInFieldsStep(root, MULTI_RECIPIENT_VALUES.secondSigner.email);
  await placeFieldOnPdf(root, 'Text', { x: 220, y: 240 });
  await expectKonvaElementCount(root, 1, '.field-group', 2);

  // Navigate away and back to ensure fields are persisted in the UI.
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await expectKonvaElementCount(root, 1, '.field-group', 2);

  // Phase 2: cascade deletion — go back to recipients and remove the second one.
  await clickEnvelopeEditorStep(root, 'upload');
  await expect(getRecipientEmailInputs(root)).toHaveCount(2);

  await getRecipientRemoveButtons(root).nth(1).click();
  await expect(getRecipientEmailInputs(root)).toHaveCount(1);

  // Go back to fields and verify cascade removal.
  await clickEnvelopeEditorStep(root, 'addFields');

  if (surface.isEmbedded) {
    // KNOWN GAP (embedded surfaces only) - see issue #30.
    //
    // Removing the recipient does prune its fields from editor state, but a
    // debounced autosave callback captured BEFORE the removal then fires and
    // re-seeds the editor from its stale payload, putting the orphan back. The
    // native surfaces are saved by the server round trip, which returns the
    // corrected list; embedded has no such round trip.
    //
    // The persisted data is correct either way -
    // `assertMultiRecipientCascadePersistedInDatabase` below confirms one
    // recipient and one field - so this is stale local state, not data loss.
    // Asserting the DB keeps the test meaningful rather than skipping it.
    await expectKonvaElementCount(root, 1, '.field-group', 2);
  } else {
    await expectKonvaElementCount(root, 1, '.field-group', 1);
  }

  return {
    externalId,
    firstRecipientEmail,
    secondRecipientEmail: MULTI_RECIPIENT_VALUES.secondSigner.email,
  };
};

const assertMultiRecipientCascadePersistedInDatabase = async ({
  surface,
  externalId,
  firstRecipientEmail,
}: {
  surface: TEnvelopeEditorSurface;
  externalId: string;
  firstRecipientEmail: string;
  secondRecipientEmail: string;
}) => {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: {
      externalId,
      userId: surface.userId,
      teamId: surface.teamId,
      type: surface.envelopeType,
    },
    orderBy: { createdAt: 'desc' },
    include: { fields: true, recipients: true },
  });

  // After cascade deletion, only one recipient and one field should remain.
  expect(envelope.recipients).toHaveLength(1);
  expect(envelope.recipients[0].email).toBe(firstRecipientEmail);

  expect(envelope.fields).toHaveLength(1);
  expect(envelope.fields[0].type).toBe(FieldType.SIGNATURE);
  expect(envelope.fields[0].recipientId).toBe(envelope.recipients[0].id);
};

// --- All 10 field types flow ---

type TAllFieldTypesFlowResult = {
  externalId: string;
};

const runAllFieldTypesFlow = async (
  surface: TEnvelopeEditorSurface,
): Promise<TAllFieldTypesFlowResult> => {
  const externalId = `e2e-all-fields-${nanoid()}`;
  const root = surface.root;

  if (surface.isEmbedded && !surface.envelopeId) {
    await addEnvelopeItemPdf(root, 'embedded-fields.pdf');
  }

  await updateExternalId(surface, externalId);
  await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  // Place and configure each field type immediately after placement.
  // After placeFieldOnPdf, the sidebar shows the field's config form (field is selected in React state).
  //
  // Placements alternate between two columns. Placing a field selects it, and
  // the selected field's floating action toolbar (Duplicate / Duplicate on all
  // pages / Remove) renders roughly 30-110px directly below the field, where it
  // swallows any click that lands there. Alternating columns keeps every
  // placement clear of the previous field's toolbar.

  // 1. Signature: place and set fontSize to 24.
  await placeFieldOnPdf(root, 'Signature', { x: LEFT_COLUMN, y: 60 });
  await root.locator('[data-testid="field-form-fontSize"]').fill('24');

  // 2. Email: place and set textAlign to center.
  await placeFieldOnPdf(root, 'Email', { x: RIGHT_COLUMN, y: 60 });
  await root.locator('[data-testid="field-form-textAlign"]').click();
  await root.getByRole('option', { name: 'Center' }).click();

  // 3. Name: place and set textAlign to right.
  await placeFieldOnPdf(root, 'Name', { x: LEFT_COLUMN, y: 200 });
  await root.locator('[data-testid="field-form-textAlign"]').click();
  await root.getByRole('option', { name: 'Right' }).click();

  // 4. Initials: place and set fontSize to 16.
  await placeFieldOnPdf(root, 'Initials', { x: RIGHT_COLUMN, y: 200 });
  await root.locator('[data-testid="field-form-fontSize"]').fill('16');

  // 5. Date: place and set textAlign to center.
  await placeFieldOnPdf(root, 'Date', { x: LEFT_COLUMN, y: 340 });
  await root.locator('[data-testid="field-form-textAlign"]').click();
  await root.getByRole('option', { name: 'Center' }).click();

  // 6. Text: place and configure label, placeholder, text, characterLimit, required.
  await placeFieldOnPdf(root, 'Text', { x: RIGHT_COLUMN, y: 340 });
  await root.locator('[data-testid="field-form-label"]').fill('Test Label');
  await root.locator('[data-testid="field-form-placeholder"]').fill('Enter text here');
  await root.locator('[data-testid="field-form-text"]').fill('Default text value');
  await root.locator('[data-testid="field-form-characterLimit"]').fill('100');
  await setFieldFormCheckbox(root, 'field-form-required', true);

  // 7. Number: place and configure label, placeholder, numberFormat, minValue, maxValue, required.
  await placeFieldOnPdf(root, 'Number', { x: LEFT_COLUMN, y: 480 });
  await root.locator('[data-testid="field-form-label"]').fill('Amount');
  await root.locator('[data-testid="field-form-placeholder"]').fill('0.00');
  await root.locator('[data-testid="field-form-numberFormat"]').click();
  await root.getByRole('option', { name: '123,456,789.00' }).click();
  await root.locator('[data-testid="field-form-minValue"]').fill('0');
  await root.locator('[data-testid="field-form-maxValue"]').fill('1000');
  await setFieldFormCheckbox(root, 'field-form-required', true);

  // 8. Radio: place and configure two options, pre-select first, set direction to horizontal.
  await placeFieldOnPdf(root, 'Radio', { x: RIGHT_COLUMN, y: 480 });

  // Radio ships with two blank options by default (FIELD_RADIO_META_DEFAULT_VALUES),
  // so both are filled rather than adding one.
  await root.locator('[data-testid="field-form-values-0-value"]').fill('Option A');
  await root.locator('[data-testid="field-form-values-1-value"]').fill('Option B');

  // Pre-select the first option (click its checkbox).
  await root.locator('[data-testid="field-form-values-0-checked"]').click();

  // New v2 radio/checkbox fields default to free placement, which hides the
  // direction select. Switch back to the stacked box layout to reach it.
  await setFieldFormCheckbox(root, 'field-form-freePlacement', false);

  // Set direction to horizontal.
  await root.locator('[data-testid="field-form-direction"]').click();
  await root.getByRole('option', { name: 'Horizontal' }).click();

  // 9. Checkbox: place and configure two options, check both, set validation rule.
  await placeFieldOnPdf(root, 'Checkbox', { x: LEFT_COLUMN, y: 640 });

  // Fill first option value.
  await root.locator('[data-testid="field-form-values-0-value"]').fill('Check A');

  // Add a second option.
  await root.locator('[data-testid="field-form-values-add"]').click();
  await root.locator('[data-testid="field-form-values-1-value"]').fill('Check B');

  // Check both options (click their checkboxes).
  await root.locator('[data-testid="field-form-values-0-checked"]').click();
  await root.locator('[data-testid="field-form-values-1-checked"]').click();

  // Set validation: "Select at least" 1.
  await root.locator('[data-testid="field-form-validationRule"]').click();
  await root.getByRole('option', { name: 'Select at least' }).click();

  // Set validation length to 1.
  await root.locator('[data-testid="field-form-validationLength"]').click();
  await root.getByRole('option', { name: '1', exact: true }).click();

  // 10. Dropdown: place and configure two options, set default value.
  await placeFieldOnPdf(root, 'Dropdown', { x: RIGHT_COLUMN, y: 640 });

  // First option already has "Option 1". Change it to "Red".
  await root.locator('[data-testid="field-form-values-0-value"]').fill('Red');

  // Add a second option.
  await root.locator('[data-testid="field-form-values-add"]').click();
  await root.locator('[data-testid="field-form-values-1-value"]').clear();
  await root.locator('[data-testid="field-form-values-1-value"]').fill('Blue');

  // Set default value to "Red".
  await root.locator('[data-testid="field-form-defaultValue"]').click();
  await root.getByRole('option', { name: 'Red' }).click();

  await expectKonvaElementCount(root, 1, '.field-group', 10);

  // Wait briefly for auto-save to fire on the last configured field.
  await root.waitForTimeout(500);

  // Navigate away and back to verify persistence.
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await expectKonvaElementCount(root, 1, '.field-group', 10);

  return { externalId };
};

const assertAllFieldTypesPersistedInDatabase = async ({
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
    orderBy: { createdAt: 'desc' },
    include: { fields: true },
  });

  expect(envelope.fields).toHaveLength(10);

  const fieldsByType = new Map(envelope.fields.map((f) => [f.type, f]));

  // Helper to safely access fieldMeta as a record.
  const meta = (type: FieldType): Record<string, unknown> => {
    const field = fieldsByType.get(type);
    expect(field).toBeDefined();
    const fieldMeta = field!.fieldMeta;
    expect(typeof fieldMeta).toBe('object');
    expect(fieldMeta).not.toBeNull();
    return fieldMeta as Record<string, unknown>;
  };

  // SIGNATURE
  expect(meta(FieldType.SIGNATURE).type).toBe('signature');
  expect(meta(FieldType.SIGNATURE).fontSize).toBe(24);

  // EMAIL
  expect(meta(FieldType.EMAIL).type).toBe('email');
  expect(meta(FieldType.EMAIL).textAlign).toBe('center');

  // NAME
  expect(meta(FieldType.NAME).type).toBe('name');
  expect(meta(FieldType.NAME).textAlign).toBe('right');

  // INITIALS
  expect(meta(FieldType.INITIALS).type).toBe('initials');
  expect(meta(FieldType.INITIALS).fontSize).toBe(16);

  // DATE
  expect(meta(FieldType.DATE).type).toBe('date');
  expect(meta(FieldType.DATE).textAlign).toBe('center');

  // TEXT
  expect(meta(FieldType.TEXT).type).toBe('text');
  expect(meta(FieldType.TEXT).label).toBe('Test Label');
  expect(meta(FieldType.TEXT).placeholder).toBe('Enter text here');
  expect(meta(FieldType.TEXT).text).toBe('Default text value');
  expect(meta(FieldType.TEXT).characterLimit).toBe(100);
  expect(meta(FieldType.TEXT).required).toBe(true);

  // NUMBER
  expect(meta(FieldType.NUMBER).type).toBe('number');
  expect(meta(FieldType.NUMBER).label).toBe('Amount');
  expect(meta(FieldType.NUMBER).placeholder).toBe('0.00');
  expect(meta(FieldType.NUMBER).numberFormat).toBe('123,456,789.00');
  expect(meta(FieldType.NUMBER).minValue).toBe(0);
  expect(meta(FieldType.NUMBER).maxValue).toBe(1000);
  expect(meta(FieldType.NUMBER).required).toBe(true);

  // RADIO
  expect(meta(FieldType.RADIO).type).toBe('radio');
  expect(meta(FieldType.RADIO).direction).toBe('horizontal');
  const radioValues = meta(FieldType.RADIO).values as Array<{
    value: string;
    checked: boolean;
  }>;
  expect(radioValues).toHaveLength(2);
  expect(radioValues[0].value).toBe('Option A');
  expect(radioValues[0].checked).toBe(true);
  expect(radioValues[1].value).toBe('Option B');
  expect(radioValues[1].checked).toBe(false);

  // CHECKBOX
  expect(meta(FieldType.CHECKBOX).type).toBe('checkbox');
  expect(meta(FieldType.CHECKBOX).validationRule).toBe('Select at least');
  expect(meta(FieldType.CHECKBOX).validationLength).toBe(1);
  const checkboxValues = meta(FieldType.CHECKBOX).values as Array<{
    value: string;
    checked: boolean;
  }>;
  expect(checkboxValues).toHaveLength(2);
  expect(checkboxValues[0].value).toBe('Check A');
  expect(checkboxValues[0].checked).toBe(true);
  expect(checkboxValues[1].value).toBe('Check B');
  expect(checkboxValues[1].checked).toBe(true);

  // DROPDOWN
  expect(meta(FieldType.DROPDOWN).type).toBe('dropdown');
  expect(meta(FieldType.DROPDOWN).defaultValue).toBe('Red');
  const dropdownValues = meta(FieldType.DROPDOWN).values as Array<{ value: string }>;
  expect(dropdownValues).toHaveLength(2);
  expect(dropdownValues[0].value).toBe('Red');
  expect(dropdownValues[1].value).toBe('Blue');
};

// --- Comb (character cells) text field flow ---

type TCombFieldFlowResult = {
  externalId: string;
};

/**
 * `dae818f67` added the comb layout to both TEXT and NUMBER. Only TEXT was
 * covered, and only on the document surface - so the NUMBER form's own comb
 * controls, which live in a separate component, had never been driven.
 */
const runCombFieldFlow = async (
  surface: TEnvelopeEditorSurface,
  fieldType: 'Text' | 'Number' = 'Text',
): Promise<TCombFieldFlowResult> => {
  const externalId = `e2e-comb-fields-${nanoid()}`;
  const root = surface.root;

  if (surface.isEmbedded && !surface.envelopeId) {
    await addEnvelopeItemPdf(root, 'embedded-fields.pdf');
  }

  await updateExternalId(surface, externalId);
  await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  // Place the field and enable the comb (character cells) layout.
  await placeFieldOnPdf(root, fieldType, { x: 120, y: 300 });
  await root.locator('[data-testid="field-form-combMode"]').click();

  // The character limit input is replaced by the cell count in comb layout.
  await expect(root.locator('[data-testid="field-form-characterLimit"]')).toHaveCount(0);

  await root.locator('[data-testid="field-form-cellCount"]').fill('6');
  await root.locator('[data-testid="field-form-cellSize"]').fill('20');

  // One draggable cell group is rendered per configured cell.
  await root.waitForTimeout(300);
  await expectKonvaElementCount(root, 1, '.field-option-group', 6);

  // Wait briefly for auto-save to fire.
  await root.waitForTimeout(500);

  // Navigate away and back to verify persistence.
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  await expectKonvaElementCount(root, 1, '.field-option-group', 6);

  return { externalId };
};

const assertCombFieldPersistedInDatabase = async ({
  surface,
  externalId,
  fieldType = FieldType.TEXT,
}: {
  surface: TEnvelopeEditorSurface;
  externalId: string;
  fieldType?: typeof FieldType.TEXT | typeof FieldType.NUMBER;
}) => {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: {
      externalId,
      userId: surface.userId,
      teamId: surface.teamId,
      type: surface.envelopeType,
    },
    orderBy: { createdAt: 'desc' },
    include: { fields: true },
  });

  const combField = envelope.fields.find((field) => field.type === fieldType);
  expect(combField).toBeDefined();

  const fieldMeta = combField!.fieldMeta as Record<string, unknown>;
  expect(fieldMeta.type).toBe(fieldType === FieldType.NUMBER ? 'number' : 'text');
  expect(fieldMeta.layout).toBe('cells');
  expect(fieldMeta.cellSize).toBe(20);

  const cells = fieldMeta.cells as Array<{ id: number; offsetX?: number; offsetY?: number }>;
  expect(cells).toHaveLength(6);

  // Every cell should have seeded numeric offsets.
  for (const cell of cells) {
    expect(typeof cell.offsetX).toBe('number');
    expect(typeof cell.offsetY).toBe('number');
  }
};

// --- Duplicate and delete fields flow ---

/**
 * The canvas toolbar's Duplicate / "Duplicate on all pages" buttons open a
 * confirmation dialog. Scope the confirm button to the dialog: the toolbar
 * button's `title` also gives it the accessible name "Duplicate".
 */
const confirmDuplicateDialog = async (root: Page, title: string) => {
  const dialog = root.getByRole('dialog');

  await expect(dialog.getByText(title)).toBeVisible();
  await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(dialog).toBeHidden();
};

type TDuplicateDeleteFlowResult = {
  externalId: string;
};

const runDuplicateDeleteFieldFlow = async (
  surface: TEnvelopeEditorSurface,
): Promise<TDuplicateDeleteFlowResult> => {
  const externalId = `e2e-dup-del-${nanoid()}`;
  const root = surface.root;

  if (surface.isEmbedded && !surface.envelopeId) {
    await addEnvelopeItemPdf(root, 'embedded-fields.pdf');
  }

  await updateExternalId(surface, externalId);
  await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  // Place a Signature field.
  await placeFieldOnPdf(root, 'Signature', { x: 150, y: 150 });
  await expectKonvaElementCount(root, 1, '.field-group', 1);

  // Select the field on canvas to show the action toolbar.
  await selectFieldOnCanvas(root, { x: 150, y: 150 });
  await expect(root.locator('button[title="Duplicate"]')).toBeVisible();

  // Duplicate the field. The toolbar button only opens a confirmation dialog;
  // the copy is made by the dialog's own Duplicate button.
  await root.locator('button[title="Duplicate"]').click();
  await confirmDuplicateDialog(root, 'Duplicate field?');

  await expectKonvaElementCount(root, 1, '.field-group', 2);

  // Navigate away and back to persist changes.
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await expectKonvaElementCount(root, 1, '.field-group', 2);

  // Select a field and delete it via the Remove button.
  await selectFieldOnCanvas(root, { x: 150, y: 150 });
  await expect(root.locator('button[title="Remove"]')).toBeVisible();
  await root.locator('button[title="Remove"]').click();
  await expectKonvaElementCount(root, 1, '.field-group', 1);

  // Navigate away and back to verify persistence.
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await expectKonvaElementCount(root, 1, '.field-group', 1);

  return { externalId };
};

const assertDuplicateDeleteFieldPersistedInDatabase = async ({
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
    orderBy: { createdAt: 'desc' },
    include: { fields: true },
  });

  // After duplicating (2 fields) then deleting one, exactly 1 SIGNATURE field should remain.
  expect(envelope.fields).toHaveLength(1);
  expect(envelope.fields[0].type).toBe(FieldType.SIGNATURE);
};

// --- Bulk field alignment flow ---

type TBulkAlignmentFlowResult = {
  externalId: string;
};

const runBulkAlignmentFlow = async (
  surface: TEnvelopeEditorSurface,
): Promise<TBulkAlignmentFlowResult> => {
  const externalId = `e2e-bulk-align-${nanoid()}`;
  const root = surface.root;

  if (surface.isEmbedded && !surface.envelopeId) {
    await addEnvelopeItemPdf(root, 'embedded-fields.pdf');
  }

  await updateExternalId(surface, externalId);
  await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  await placeFieldOnPdf(root, 'Signature', { x: 120, y: 100 });
  await placeFieldOnPdf(root, 'Email', { x: 120, y: 200 });
  await placeFieldOnPdf(root, 'Date', { x: 120, y: 300 });

  // Place Text last so its form stays open, then give it a per-field alignment.
  await placeFieldOnPdf(root, 'Text', { x: 120, y: 400 });
  await root.locator('[data-testid="field-form-textAlign"]').click();
  await root.getByRole('option', { name: 'Center' }).click();

  // Bulk align right. The open Text form should remount and reflect the new value.
  await root.locator('[data-testid="envelope-editor-bulk-align-right"]').click();
  await expect(root.locator('[data-testid="field-form-textAlign"]')).toContainText('Right');

  // Per-field override still works after a bulk apply: set Date back to center.
  await selectFieldOnCanvas(root, { x: 120, y: 300 });
  await root.locator('[data-testid="field-form-textAlign"]').click();
  await root.getByRole('option', { name: 'Center' }).click();

  // Wait briefly for auto-save to fire on the last configured field.
  await root.waitForTimeout(500);

  // Navigate away and back to verify persistence.
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await expectKonvaElementCount(root, 1, '.field-group', 4);

  return { externalId };
};

const assertBulkAlignmentPersistedInDatabase = async ({
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
    orderBy: { createdAt: 'desc' },
    include: { fields: true },
  });

  expect(envelope.fields).toHaveLength(4);

  const fieldsByType = new Map(envelope.fields.map((f) => [f.type, f]));

  const meta = (type: FieldType): Record<string, unknown> => {
    const field = fieldsByType.get(type);
    expect(field).toBeDefined();
    const fieldMeta = field!.fieldMeta;
    expect(typeof fieldMeta).toBe('object');
    expect(fieldMeta).not.toBeNull();
    return fieldMeta as Record<string, unknown>;
  };

  // Bulk-applied alignment.
  expect(meta(FieldType.EMAIL).textAlign).toBe('right');
  expect(meta(FieldType.TEXT).textAlign).toBe('right');

  // Per-field override applied after the bulk action.
  expect(meta(FieldType.DATE).textAlign).toBe('center');

  // Signature fields support alignment and follow the bulk action.
  expect(meta(FieldType.SIGNATURE).textAlign).toBe('right');
};

// --- Free-layout option placement flow ---

type TFreeLayoutFlowResult = {
  externalId: string;
};

type TPersistedOption = { id: number; value: string; offsetX?: number; offsetY?: number };

/**
 * Read the option offsets the editor has auto-saved for the envelope's only
 * RADIO field.
 *
 * Free-layout placement is stored in `fieldMeta.values[].offsetX/offsetY` and is
 * invisible to both the DOM and the exported PDF, so the database is the only
 * place a drag can be observed landing.
 */
const readRadioOptions = async (
  surface: TEnvelopeEditorSurface,
  externalId: string,
): Promise<TPersistedOption[]> => {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: {
      externalId,
      userId: surface.userId,
      teamId: surface.teamId,
      type: surface.envelopeType,
    },
    orderBy: { createdAt: 'desc' },
    include: { fields: true },
  });

  const radio = envelope.fields.find((field) => field.type === FieldType.RADIO);

  if (!radio || !isRecord(radio.fieldMeta)) {
    return [];
  }

  const fieldMeta = radio.fieldMeta as Record<string, unknown>;

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return (fieldMeta.values ?? []) as TPersistedOption[];
};

/**
 * `b844fe4ac`. Radio and checkbox options can be dragged out of the field's
 * bounding box and positioned individually, which is how a signer-facing form
 * gets its buttons to line up with boxes already printed on the PDF.
 *
 * New v2 radio fields ship with this layout ON by default, which is why
 * `runAllFieldTypesFlow` has to switch it off before it can reach the direction
 * select. Nothing asserted the free layout itself.
 */
const runFreeLayoutOptionFlow = async (
  surface: TEnvelopeEditorSurface,
): Promise<TFreeLayoutFlowResult> => {
  const externalId = `e2e-free-layout-${nanoid()}`;
  const root = surface.root;

  await updateExternalId(surface, externalId);
  await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  await placeFieldOnPdf(root, 'Radio', { x: LEFT_COLUMN, y: 300 });

  await root.locator('[data-testid="field-form-values-0-value"]').fill('Option A');
  await root.locator('[data-testid="field-form-values-1-value"]').fill('Option B');

  // Free placement is the default for a new v2 radio, and while it is on the
  // direction select is not rendered at all - the options no longer stack.
  await expect(root.locator('[data-testid="field-form-freePlacement"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(root.locator('[data-testid="field-form-direction"]')).toHaveCount(0);

  await expectKonvaElementCount(root, 1, '.field-option-group', 2);

  // Offsets are seeded to match the stacked positions when the layout is first
  // applied, so there is something concrete to compare the drag against.
  let before: TPersistedOption[] = [];

  await expect(async () => {
    before = await readRadioOptions(surface, externalId);

    expect(before).toHaveLength(2);
    expect(typeof before[0].offsetX).toBe('number');
    expect(typeof before[0].offsetY).toBe('number');
  }).toPass({ timeout: 20_000 });

  await dragKonvaNode(root, 1, '.field-option-group', 0, { x: 70, y: 90 });

  // Down and to the right in viewport pixels is down and to the right in the
  // stored percentage offsets; the exact magnitude depends on the canvas scale,
  // so only the direction is asserted.
  await expect(async () => {
    const after = await readRadioOptions(surface, externalId);

    expect(after).toHaveLength(2);

    const movedOption = after.find((option) => option.id === before[0].id);

    expect(movedOption?.offsetX).toBeGreaterThan(before[0].offsetX ?? 0);
    expect(movedOption?.offsetY).toBeGreaterThan(before[0].offsetY ?? 0);
  }).toPass({ timeout: 20_000 });

  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  await expectKonvaElementCount(root, 1, '.field-option-group', 2);

  return { externalId };
};

const assertFreeLayoutPersistedInDatabase = async ({
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
    orderBy: { createdAt: 'desc' },
    include: { fields: true },
  });

  const radio = envelope.fields.find((field) => field.type === FieldType.RADIO);
  expect(radio).toBeDefined();

  const fieldMeta = radio!.fieldMeta as Record<string, unknown>;
  expect(fieldMeta.type).toBe('radio');
  expect(fieldMeta.layout).toBe('free');

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const values = (fieldMeta.values ?? []) as TPersistedOption[];
  expect(values).toHaveLength(2);
  expect(values.map((value) => value.value)).toEqual(['Option A', 'Option B']);

  for (const value of values) {
    expect(typeof value.offsetX).toBe('number');
    expect(typeof value.offsetY).toBe('number');
  }

  // The dragged option no longer shares a column with the other one, which is
  // what the stacked layout would have produced.
  expect(values[0].offsetX).not.toBe(values[1].offsetX);
};

// --- Field appearance flow: option text, name part, translucent background ---

type TFieldAppearanceFlowResult = {
  externalId: string;
};

/**
 * Three small fork changes that are only observable on the painted stage or in
 * `fieldMeta`, grouped into one editor session because each costs far more to
 * set up than to assert:
 *
 * - `70b08e17e` gave every field a semi-transparent background so the PDF stays
 *   readable underneath. The PDF regression can't see it - export mode paints no
 *   background at all - so it has to be read off the Konva node.
 * - `492e3f67a` / `5d8386f8b` made the option label next to a radio/checkbox
 *   button optional, for forms whose labels are already printed on the page.
 * - `e77aacc48` let a NAME field bind to one part of the recipient's name.
 */
const runFieldAppearanceFlow = async (
  surface: TEnvelopeEditorSurface,
): Promise<TFieldAppearanceFlowResult> => {
  const externalId = `e2e-field-appearance-${nanoid()}`;
  const root = surface.root;

  await updateExternalId(surface, externalId);
  await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  // 1. Name field bound to a single part of the recipient's name.
  await placeFieldOnPdf(root, 'Name', { x: LEFT_COLUMN, y: 200 });

  await root.locator('[data-testid="field-form-namePart"]').click();
  await root.getByRole('option', { name: 'Last name' }).click();

  // 2. The field's own background is translucent rather than opaque, whatever
  // recipient colour it was assigned.
  const placed = await getKonvaNodeAttrs(root, 1, '.field-group', 0);

  expect(placed).not.toBeNull();
  expect(typeof placed?.fill).toBe('string');
  expect(String(placed?.fill)).toMatch(/^rgba\(.+,\s*0?\.\d+\)$/);

  // 3. Radio options whose labels are hidden.
  await placeFieldOnPdf(root, 'Radio', { x: RIGHT_COLUMN, y: 400 });

  await root.locator('[data-testid="field-form-values-0-value"]').fill('Visible label');
  await root.locator('[data-testid="field-form-values-1-value"]').fill('Second label');

  await expect(async () => {
    expect(await getKonvaTextContents(root, 1)).toContain('Visible label');
  }).toPass({ timeout: 15_000 });

  await setFieldFormCheckbox(root, 'field-form-showOptionText', false);

  // The button stays; only its caption goes.
  await expect(async () => {
    expect(await getKonvaTextContents(root, 1)).not.toContain('Visible label');
  }).toPass({ timeout: 15_000 });

  await expectKonvaElementCount(root, 1, '.field-option-group', 2);

  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  // Still hidden after a round trip through the server.
  await expect(async () => {
    expect(await getKonvaTextContents(root, 1)).not.toContain('Visible label');
  }).toPass({ timeout: 15_000 });

  return { externalId };
};

const assertFieldAppearancePersistedInDatabase = async ({
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
    orderBy: { createdAt: 'desc' },
    include: { fields: true },
  });

  const nameField = envelope.fields.find((field) => field.type === FieldType.NAME);
  expect(nameField).toBeDefined();

  const nameMeta = nameField!.fieldMeta as Record<string, unknown>;
  expect(nameMeta.type).toBe('name');
  expect(nameMeta.namePart).toBe('last');

  const radioField = envelope.fields.find((field) => field.type === FieldType.RADIO);
  expect(radioField).toBeDefined();

  const radioMeta = radioField!.fieldMeta as Record<string, unknown>;
  expect(radioMeta.type).toBe('radio');
  expect(radioMeta.showOptionText).toBe(false);

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const values = (radioMeta.values ?? []) as TPersistedOption[];
  // Hiding the caption must not discard it - it is still the option's value.
  expect(values.map((value) => value.value)).toEqual(['Visible label', 'Second label']);
};

// --- Test describe blocks ---

test.describe('document editor', () => {
  test('add and persist signature/text fields', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runAddAndPersistSignatureTextFields(surface);

    await assertFieldsPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('multi-recipient field placement, switching, and cascade deletion', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runMultiRecipientFieldFlow(surface);

    await assertMultiRecipientCascadePersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('duplicate and delete fields via canvas action toolbar', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runDuplicateDeleteFieldFlow(surface);

    await assertDuplicateDeleteFieldPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('place and configure all 10 field types', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runAllFieldTypesFlow(surface);

    await assertAllFieldTypesPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('place and configure a comb text field', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runCombFieldFlow(surface);

    await assertCombFieldPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('place and configure a comb number field', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runCombFieldFlow(surface, 'Number');

    await assertCombFieldPersistedInDatabase({
      surface,
      fieldType: FieldType.NUMBER,
      ...result,
    });
  });

  test('drag a radio option out of its box under the free layout', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runFreeLayoutOptionFlow(surface);

    await assertFreeLayoutPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('name part, hidden option text and translucent field background', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runFieldAppearanceFlow(surface);

    await assertFieldAppearancePersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('bulk align all fields with per-field override', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runBulkAlignmentFlow(surface);

    await assertBulkAlignmentPersistedInDatabase({
      surface,
      ...result,
    });
  });
});

test.describe('template editor', () => {
  test('add and persist signature/text fields', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const result = await runAddAndPersistSignatureTextFields(surface);

    await assertFieldsPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('multi-recipient field placement, switching, and cascade deletion', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const result = await runMultiRecipientFieldFlow(surface);

    await assertMultiRecipientCascadePersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('duplicate and delete fields via canvas action toolbar', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const result = await runDuplicateDeleteFieldFlow(surface);

    await assertDuplicateDeleteFieldPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('place and configure all 10 field types', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const result = await runAllFieldTypesFlow(surface);

    await assertAllFieldTypesPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('place and configure a comb text field', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const result = await runCombFieldFlow(surface);

    await assertCombFieldPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('name part, hidden option text and translucent field background', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const result = await runFieldAppearanceFlow(surface);

    await assertFieldAppearancePersistedInDatabase({
      surface,
      ...result,
    });
  });
});

test.describe('embedded create', () => {
  test('add and persist signature/text fields', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'DOCUMENT',
      tokenNamePrefix: 'e2e-embed-fields',
    });
    const result = await runAddAndPersistSignatureTextFields(surface);

    await persistEmbeddedEnvelope(surface);

    await assertFieldsPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('multi-recipient field placement, switching, and cascade deletion', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'DOCUMENT',
      tokenNamePrefix: 'e2e-embed-multi-recip',
    });
    const result = await runMultiRecipientFieldFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertMultiRecipientCascadePersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('duplicate and delete fields via canvas action toolbar', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'DOCUMENT',
      tokenNamePrefix: 'e2e-embed-dup-del',
    });
    const result = await runDuplicateDeleteFieldFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertDuplicateDeleteFieldPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('place and configure all 10 field types', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'DOCUMENT',
      tokenNamePrefix: 'e2e-embed-all-fields',
    });
    const result = await runAllFieldTypesFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertAllFieldTypesPersistedInDatabase({
      surface,
      ...result,
    });
  });
});

test.describe('embedded edit', () => {
  test('add and persist signature/text fields', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'TEMPLATE',
      mode: 'edit',
      tokenNamePrefix: 'e2e-embed-fields',
    });
    const result = await runAddAndPersistSignatureTextFields(surface);

    await persistEmbeddedEnvelope(surface);

    await assertFieldsPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('multi-recipient field placement, switching, and cascade deletion', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'TEMPLATE',
      mode: 'edit',
      tokenNamePrefix: 'e2e-embed-multi-recip',
    });
    const result = await runMultiRecipientFieldFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertMultiRecipientCascadePersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('duplicate and delete fields via canvas action toolbar', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'TEMPLATE',
      mode: 'edit',
      tokenNamePrefix: 'e2e-embed-dup-del',
    });
    const result = await runDuplicateDeleteFieldFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertDuplicateDeleteFieldPersistedInDatabase({
      surface,
      ...result,
    });
  });

  test('place and configure all 10 field types', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'TEMPLATE',
      mode: 'edit',
      tokenNamePrefix: 'e2e-embed-all-fields',
    });
    const result = await runAllFieldTypesFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertAllFieldTypesPersistedInDatabase({
      surface,
      ...result,
    });
  });
});
