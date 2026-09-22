import { nanoid } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import {
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
  type TEnvelopeEditorSurface,
  waitForEditorCanvas,
} from '../fixtures/envelope-editor';
import { expectToastTextToBeVisible } from '../fixtures/generic';
import { getKonvaElementCountForPage, getKonvaTransformerNodeCountForPage } from '../fixtures/konva';
import {
  dragKonvaNode,
  expectKonvaElementCount,
  getAllKonvaNodeAttrs,
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

/**
 * Shift+click a field on the canvas to toggle it in/out of the current multi-selection.
 */
const shiftClickFieldOnCanvas = async (root: Page, position: { x: number; y: number }) => {
  const canvas = root.locator('.konva-container canvas').first();
  await expect(canvas).toBeVisible();
  await root.waitForTimeout(300);
  // Use force:true to bypass any floating action toolbar buttons that may intercept clicks.
  await canvas.click({ position, modifiers: ['Shift'], force: true });
};

const runAddAndPersistSignatureTextFields = async (surface: TEnvelopeEditorSurface): Promise<TFieldFlowResult> => {
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

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

  const recipient = envelope.recipients.find((currentRecipient) => currentRecipient.email === recipientEmail);

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

const runMultiRecipientFieldFlow = async (surface: TEnvelopeEditorSurface): Promise<TMultiRecipientFlowResult> => {
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

  // Unbranched on purpose (it used to except the embedded surfaces, see #30).
  //
  // Removing the recipient prunes its fields from editor state, but the editor
  // then re-seeded itself from `envelopeRef.current` on the next step change,
  // and that ref was written from inside a React state updater - so it still
  // held the pre-removal envelope and put the orphan back. The native surfaces
  // were rescued by the server round trip returning the corrected list;
  // embedded has no round trip, so the stale copy won.
  //
  // The database assertion below is what proves the cascade persisted; this one
  // is what proves the canvas agrees with it without a reload.
  await expectKonvaElementCount(root, 1, '.field-group', 1);

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

const runAllFieldTypesFlow = async (surface: TEnvelopeEditorSurface): Promise<TAllFieldTypesFlowResult> => {
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

const runDuplicateDeleteFieldFlow = async (surface: TEnvelopeEditorSurface): Promise<TDuplicateDeleteFlowResult> => {
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

// --- Change field type flow ---

type TChangeFieldTypeFlowResult = {
  externalId: string;
};

const FIELD_A_POSITION = { x: 150, y: 150 };
const FIELD_B_POSITION = { x: 150, y: 250 };

const changeFieldTypeViaToolbar = async (root: Page, newTypeLabel: FieldButtonName) => {
  await expect(root.locator('button[title="Change Field Type"]')).toBeVisible();
  await root.locator('button[title="Change Field Type"]').click();

  // The CommandDialog uses role="option" for items; sidebar palette buttons use role="button".
  const option = root.getByRole('option', { name: newTypeLabel, exact: true });
  await expect(option).toBeVisible();
  await option.click();

  // Wait for the CommandDialog to close (selection persists so the toolbar remains).
  await expect(root.getByRole('dialog')).toHaveCount(0);
};

/**
 * Multi-select fields on the konva canvas by drawing a marquee selection rectangle.
 *
 * The editor's stage mousedown/mousemove/mouseup handlers create a Konva selection
 * rectangle when the user drags on empty stage area. All field groups that intersect
 * the rectangle are selected at once. This is the canonical multi-select gesture.
 */
const marqueeSelectFieldsOnCanvas = async (
  root: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
) => {
  const canvas = root.locator('.konva-container canvas').first();
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('Canvas bounding box not available for marquee selection.');
  }

  // The marquee gesture must start on empty stage (not on a field) and pass through
  // intermediate points so the editor's mousemove handler can grow the rectangle.
  await root.mouse.move(box.x + start.x, box.y + start.y);
  await root.mouse.down();
  await root.mouse.move(box.x + (start.x + end.x) / 2, box.y + (start.y + end.y) / 2, { steps: 5 });
  await root.mouse.move(box.x + end.x, box.y + end.y, { steps: 5 });
  await root.mouse.up();
};

const runChangeFieldTypeFlow = async (surface: TEnvelopeEditorSurface): Promise<TChangeFieldTypeFlowResult> => {
  const externalId = `e2e-change-type-${nanoid()}`;
  const root = surface.root;

  if (surface.isEmbedded && !surface.envelopeId) {
    await addEnvelopeItemPdf(root, 'embedded-fields.pdf');
  }

  await updateExternalId(surface, externalId);
  await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(root, 'addFields');
  await expect(root.locator('.konva-container canvas').first()).toBeVisible();

  // Place two fields of different types: Signature (A) and Name (B).
  await placeFieldOnPdf(root, 'Signature', FIELD_A_POSITION);
  await placeFieldOnPdf(root, 'Name', FIELD_B_POSITION);
  let fieldCount = await getKonvaElementCountForPage(root, 1, '.field-group');
  expect(fieldCount).toBe(2);

  // --- Phase 1: single field type change ---
  // Select field A (Signature) and change it to Text via the toolbar.
  await selectFieldOnCanvas(root, FIELD_A_POSITION);
  await changeFieldTypeViaToolbar(root, 'Text');

  // Field count must remain stable -- changing type doesn't add/remove fields.
  fieldCount = await getKonvaElementCountForPage(root, 1, '.field-group');
  expect(fieldCount).toBe(2);

  // Navigate away and back to verify the change is persisted in local state.
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  fieldCount = await getKonvaElementCountForPage(root, 1, '.field-group');
  expect(fieldCount).toBe(2);

  // --- Phase 2: multi-field type change ---
  // Use a marquee drag-selection rectangle to capture both fields at once.
  // Fields are at (150, 150) and (150, 250) with default dims ~90x30; drag from
  // (50, 100) to (260, 290) encloses both with margin.
  await marqueeSelectFieldsOnCanvas(root, { x: 50, y: 100 }, { x: 260, y: 290 });

  // With mixed-type selection (Text + Name), change both to Date.
  await changeFieldTypeViaToolbar(root, 'Date');

  fieldCount = await getKonvaElementCountForPage(root, 1, '.field-group');
  expect(fieldCount).toBe(2);

  // Navigate away and back to verify persistence.
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  fieldCount = await getKonvaElementCountForPage(root, 1, '.field-group');
  expect(fieldCount).toBe(2);

  return { externalId };
};

const assertChangeFieldTypePersistedInDatabase = async ({
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

  // Started with Signature + Name, then both were converted to Date.
  // Use sorted .map() in the assertion so any failure prints which types were found.
  const actualTypes = envelope.fields.map((field) => field.type).sort();
  const expectedTypes = [FieldType.DATE, FieldType.DATE];

  expect(envelope.fields).toHaveLength(2);
  expect(actualTypes).toEqual(expectedTypes);

  // Each field's meta must have been reset to the new type's defaults.
  const actualMetaTypes = envelope.fields.map((field) => getFieldMetaType(field.fieldMeta)).sort();
  expect(actualMetaTypes).toEqual(['date', 'date']);
};

// --- Shift+click multi-select flow ---

type TShiftClickFlowResult = {
  externalId: string;
};

const SHIFT_CLICK_FIELD_POSITIONS = {
  signature: { x: 150, y: 120 },
  text: { x: 150, y: 260 },
  name: { x: 150, y: 400 },
};

const runShiftClickMultiSelectFlow = async (surface: TEnvelopeEditorSurface): Promise<TShiftClickFlowResult> => {
  const externalId = `e2e-shift-click-${nanoid()}`;
  const root = surface.root;

  if (surface.isEmbedded && !surface.envelopeId) {
    await addEnvelopeItemPdf(root, 'embedded-fields.pdf');
  }

  await updateExternalId(surface, externalId);
  await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(root, 'addFields');
  await expect(root.locator('.konva-container canvas').first()).toBeVisible();

  // Place three fields, spaced far enough apart that their action toolbars don't
  // overlap a neighbouring field's click target.
  await placeFieldOnPdf(root, 'Signature', SHIFT_CLICK_FIELD_POSITIONS.signature);
  await placeFieldOnPdf(root, 'Text', SHIFT_CLICK_FIELD_POSITIONS.text);
  await placeFieldOnPdf(root, 'Name', SHIFT_CLICK_FIELD_POSITIONS.name);
  expect(await getKonvaElementCountForPage(root, 1, '.field-group')).toBe(3);

  // A plain click selects exactly one field.
  await selectFieldOnCanvas(root, SHIFT_CLICK_FIELD_POSITIONS.signature);
  await expect.poll(() => getKonvaTransformerNodeCountForPage(root, 1)).toBe(1);

  // Shift+click a second field ADDS it to the selection (the new behaviour).
  await shiftClickFieldOnCanvas(root, SHIFT_CLICK_FIELD_POSITIONS.text);
  await expect.poll(() => getKonvaTransformerNodeCountForPage(root, 1)).toBe(2);

  // Shift+click an already-selected field REMOVES it from the selection.
  await shiftClickFieldOnCanvas(root, SHIFT_CLICK_FIELD_POSITIONS.signature);
  await expect.poll(() => getKonvaTransformerNodeCountForPage(root, 1)).toBe(1);

  // Shift+click it again RE-ADDS it, leaving Signature + Text selected and Name excluded.
  await shiftClickFieldOnCanvas(root, SHIFT_CLICK_FIELD_POSITIONS.signature);
  await expect.poll(() => getKonvaTransformerNodeCountForPage(root, 1)).toBe(2);

  // Delete the two selected fields via the floating action toolbar. Only the
  // un-selected Name field should remain -- proving the multi-selection contained
  // exactly the two Shift-clicked fields.
  await expect(root.locator('button[title="Remove"]')).toBeVisible();
  await root.locator('button[title="Remove"]').click();
  expect(await getKonvaElementCountForPage(root, 1, '.field-group')).toBe(1);

  // Navigate away and back to verify persistence.
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  expect(await getKonvaElementCountForPage(root, 1, '.field-group')).toBe(1);

  return { externalId };
};

const assertShiftClickMultiSelectPersistedInDatabase = async ({
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

  // Signature + Text were multi-selected via Shift+click and deleted; only Name remains.
  expect(envelope.fields).toHaveLength(1);
  expect(envelope.fields[0].type).toBe(FieldType.NAME);
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

// --- Dragging a field that is not the selected one ---

type TDragUnselectedFieldFlowResult = {
  externalId: string;
  before: { x: number; y: number };
};

const readFieldPositions = async (surface: TEnvelopeEditorSurface, externalId: string) => {
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

  return envelope.fields.map((field) => ({
    type: field.type,
    x: Number(field.positionX),
    y: Number(field.positionY),
  }));
};

/**
 * `d3188261b`. Starting a drag on a field that is not currently selected also
 * selects it, and selection re-runs the effect that (re)builds the page's Konva
 * nodes. That used to destroy and recreate the very node the mouse was holding:
 * Konva force-stops the drag, then fires `dragend` on a group already detached
 * from the layer, and the coordinates written back are not where the field was
 * dropped.
 *
 * The fix skips the rebuild while the field or one of its free-layout options is
 * mid-drag. It is only reachable when the dragged field is NOT the selected one,
 * which is why the other drag coverage here misses it entirely - those drag the
 * field they have just placed, and placing a field selects it.
 */
const runDragUnselectedFieldFlow = async (
  surface: TEnvelopeEditorSurface,
): Promise<TDragUnselectedFieldFlowResult> => {
  const externalId = `e2e-drag-unselected-${nanoid()}`;
  const root = surface.root;

  await updateExternalId(surface, externalId);
  await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  await placeFieldOnPdf(root, 'Text', { x: LEFT_COLUMN, y: 200 });
  await expectKonvaElementCount(root, 1, '.field-group', 1);

  await placeFieldOnPdf(root, 'Signature', { x: RIGHT_COLUMN, y: 420 });
  await expectKonvaElementCount(root, 1, '.field-group', 2);

  // The signature was placed last, so it is the selected field. Select the text
  // field to deselect it: the signature is the one about to be dragged, and the
  // whole point is that it is dragged from an unselected state.
  await selectFieldOnCanvas(root, { x: LEFT_COLUMN, y: 200 });

  // The text field's own settings form is the barrier: it only renders once the
  // selection has actually moved off the signature.
  await expect(root.locator('[data-testid="field-form-characterLimit"]')).toBeVisible();

  let before: Awaited<ReturnType<typeof readFieldPositions>> = [];

  await expect(async () => {
    before = await readFieldPositions(surface, externalId);

    expect(before).toHaveLength(2);
  }).toPass({ timeout: 20_000 });

  const signatureBefore = before.find((field) => field.type === FieldType.SIGNATURE);
  const textBefore = before.find((field) => field.type === FieldType.TEXT);

  expect(signatureBefore).toBeDefined();
  expect(textBefore).toBeDefined();

  // Address the signature by its rendered position rather than by index: render
  // order is not a contract, and picking the wrong node would make this pass for
  // the wrong reason.
  const nodes = await getAllKonvaNodeAttrs(root, 1, '.field-group');

  expect(nodes).toHaveLength(2);

  const signatureIndex = nodes.indexOf(
    nodes.reduce((furthest, node) => (node.x > furthest.x ? node : furthest)),
  );

  await dragKonvaNode(root, 1, '.field-group', signatureIndex, { x: -60, y: 80 });

  // Left and down on screen is left and down in the stored percentages. The
  // magnitude depends on the canvas scale, so only the direction is asserted -
  // under the bug the drop coordinates were the ones lost.
  await expect(async () => {
    const after = await readFieldPositions(surface, externalId);

    expect(after).toHaveLength(2);

    const signatureAfter = after.find((field) => field.type === FieldType.SIGNATURE);
    const textAfter = after.find((field) => field.type === FieldType.TEXT);

    expect(signatureAfter?.x).toBeLessThan(signatureBefore!.x);
    expect(signatureAfter?.y).toBeGreaterThan(signatureBefore!.y);

    // The field that was selected throughout must not have been dragged along
    // with it.
    expect(textAfter?.x).toBeCloseTo(textBefore!.x, 1);
    expect(textAfter?.y).toBeCloseTo(textBefore!.y, 1);
  }).toPass({ timeout: 20_000 });

  // Both fields survive the round trip: a drag that ended on a detached node
  // used to leave the layer short of the node it destroyed.
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  await expectKonvaElementCount(root, 1, '.field-group', 2);

  return { externalId, before: { x: signatureBefore!.x, y: signatureBefore!.y } };
};

const assertDragUnselectedFieldPersistedInDatabase = async ({
  surface,
  externalId,
  before,
}: {
  surface: TEnvelopeEditorSurface;
} & TDragUnselectedFieldFlowResult) => {
  const positions = await readFieldPositions(surface, externalId);

  expect(positions).toHaveLength(2);

  const signature = positions.find((field) => field.type === FieldType.SIGNATURE);

  expect(signature).toBeDefined();
  expect(signature!.x).toBeLessThan(before.x);
  expect(signature!.y).toBeGreaterThan(before.y);

  // A field pushed off the page is the other shape this bug took: the detached
  // group reported coordinates relative to the wrong parent.
  expect(signature!.x).toBeGreaterThanOrEqual(0);
  expect(signature!.y).toBeGreaterThanOrEqual(0);
  expect(signature!.x).toBeLessThanOrEqual(100);
  expect(signature!.y).toBeLessThanOrEqual(100);
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
 *   button optional, for forms whose labels are already printed on the page, and
 *   made hidden-and-free-placed the default for newly placed v2 option fields.
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

  // Two field-meta defaults the fork changed, neither of which was asserted
  // anywhere: `fb4346ae6` ships a new radio with two options rather than one, so
  // there is something to choose between, and `d6c587010` made every new field
  // required by default. Both are silent if they regress - the author just gets
  // a different form than they expected.
  await expect(root.locator('[data-testid="field-form-values-1-value"]')).toBeVisible();
  await expect(root.locator('[data-testid="field-form-values-2-value"]')).toHaveCount(0);
  await expect(root.locator('[data-testid="field-form-required"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await root.locator('[data-testid="field-form-values-0-value"]').fill('Visible label');
  await root.locator('[data-testid="field-form-values-1-value"]').fill('Second label');

  // A radio placed into a v2 envelope arrives with its captions already hidden
  // and free placement on (`withOptionFieldDefaults`), because the case the fork
  // built the feature for is a scanned form whose labels are printed on the page
  // already. Fields that predate the change keep rendering their captions, so
  // this default is only observable on a freshly placed one - here.
  await expect(root.locator('[data-testid="field-form-showOptionText"]')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(root.locator('[data-testid="field-form-freePlacement"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await expect(async () => {
    expect(await getKonvaTextContents(root, 1)).not.toContain('Visible label');
  }).toPass({ timeout: 15_000 });

  // The buttons are painted either way - only the caption is optional.
  await expectKonvaElementCount(root, 1, '.field-option-group', 2);

  await setFieldFormCheckbox(root, 'field-form-showOptionText', true);

  await expect(async () => {
    expect(await getKonvaTextContents(root, 1)).toContain('Visible label');
  }).toPass({ timeout: 15_000 });

  await setFieldFormCheckbox(root, 'field-form-showOptionText', false);

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
  expect(radioMeta.layout).toBe('free');

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const values = (radioMeta.values ?? []) as TPersistedOption[];
  // Hiding the caption must not discard it - it is still the option's value.
  expect(values.map((value) => value.value)).toEqual(['Visible label', 'Second label']);
};

// --- Duplicate on all pages flow ---

type TDuplicateAllPagesFlowResult = {
  externalId: string;
};

/**
 * `dd142b00b`. The canvas toolbar's second duplicate button copies the selected
 * field onto every page of the document, which is how a signer-facing form gets
 * an initials box in the same spot on all of them.
 *
 * The plain Duplicate arm is covered; this one never was, because
 * `example.pdf` - what every editor surface seeds - is a single page, so the
 * feature had nowhere to copy to and any assertion would have passed vacuously.
 */
const runDuplicateAllPagesFlow = async (
  surface: TEnvelopeEditorSurface,
): Promise<TDuplicateAllPagesFlowResult> => {
  const externalId = `e2e-dup-all-pages-${nanoid()}`;
  const root = surface.root;

  await updateExternalId(surface, externalId);
  await setupRecipientsForFieldPlacement(surface);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  await placeFieldOnPdf(root, 'Initials', { x: LEFT_COLUMN, y: 200 });
  await expectKonvaElementCount(root, 1, '.field-group', 1);

  // Pages 2 and 3 start empty, so the copies can't be confused with anything
  // already there.
  await expectKonvaElementCount(root, 2, '.field-group', 0);
  await expectKonvaElementCount(root, 3, '.field-group', 0);

  await selectFieldOnCanvas(root, { x: LEFT_COLUMN, y: 200 });

  const duplicateAllButton = root.locator('button[title="Duplicate on all pages"]');
  await expect(duplicateAllButton).toBeVisible();
  await duplicateAllButton.click();

  await confirmDuplicateDialog(root, 'Duplicate on all pages?');

  // One per page, and the original is not duplicated onto its own page.
  await expectKonvaElementCount(root, 1, '.field-group', 1);
  await expectKonvaElementCount(root, 2, '.field-group', 1);
  await expectKonvaElementCount(root, 3, '.field-group', 1);

  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  await expectKonvaElementCount(root, 2, '.field-group', 1);

  return { externalId };
};

const assertDuplicateAllPagesPersistedInDatabase = async ({
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

  expect(envelope.fields).toHaveLength(3);

  for (const field of envelope.fields) {
    expect(field.type).toBe(FieldType.INITIALS);
  }

  expect(envelope.fields.map((field) => field.page).sort()).toEqual([1, 2, 3]);

  // The copies land in the same place on each page, which is the point of the
  // feature - a field that drifted per page would be useless for a form.
  const positions = envelope.fields.map((field) => ({
    x: Number(field.positionX),
    y: Number(field.positionY),
  }));

  for (const position of positions) {
    expect(position.x).toBeCloseTo(positions[0].x, 1);
    expect(position.y).toBeCloseTo(positions[0].y, 1);
  }
};

// --- Test describe blocks ---

test.describe('document editor', () => {
  test('shift+click adds and removes fields from the selection', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runShiftClickMultiSelectFlow(surface);

    await assertShiftClickMultiSelectPersistedInDatabase({
      surface,
      ...result,
    });
  });

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

  test('change field type via canvas action toolbar (single and multi-select)', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runChangeFieldTypeFlow(surface);

    await assertChangeFieldTypePersistedInDatabase({
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

  test('drag a field that is not the selected one', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runDragUnselectedFieldFlow(surface);

    await assertDragUnselectedFieldPersistedInDatabase({
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

  test('duplicate a field onto every page', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page, { multiPage: true });
    const result = await runDuplicateAllPagesFlow(surface);

    await assertDuplicateAllPagesPersistedInDatabase({
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
  test('shift+click adds and removes fields from the selection', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const result = await runShiftClickMultiSelectFlow(surface);

    await assertShiftClickMultiSelectPersistedInDatabase({
      surface,
      ...result,
    });
  });

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

  test('change field type via canvas action toolbar (single and multi-select)', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const result = await runChangeFieldTypeFlow(surface);

    await assertChangeFieldTypePersistedInDatabase({
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
  test('shift+click adds and removes fields from the selection', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'DOCUMENT',
      tokenNamePrefix: 'e2e-embed-shift-click',
    });
    const result = await runShiftClickMultiSelectFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertShiftClickMultiSelectPersistedInDatabase({
      surface,
      ...result,
    });
  });

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

  test('change field type via canvas action toolbar (single and multi-select)', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'DOCUMENT',
      tokenNamePrefix: 'e2e-embed-change-type',
    });
    const result = await runChangeFieldTypeFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertChangeFieldTypePersistedInDatabase({
      surface,
      ...result,
    });
  });

  // The comb layout is a fork feature and the embedded editor is a separate
  // mount of the same settings forms, with its own token-scoped persistence -
  // covered on the document and template surfaces, never here.
  test('place and configure a comb text field', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'DOCUMENT',
      tokenNamePrefix: 'e2e-embed-comb',
    });
    const result = await runCombFieldFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertCombFieldPersistedInDatabase({
      surface,
      ...result,
    });
  });
});

test.describe('embedded edit', () => {
  test('shift+click adds and removes fields from the selection', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'TEMPLATE',
      mode: 'edit',
      tokenNamePrefix: 'e2e-embed-shift-click',
    });
    const result = await runShiftClickMultiSelectFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertShiftClickMultiSelectPersistedInDatabase({
      surface,
      ...result,
    });
  });

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

  test('change field type via canvas action toolbar (single and multi-select)', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'TEMPLATE',
      mode: 'edit',
      tokenNamePrefix: 'e2e-embed-change-type',
    });
    const result = await runChangeFieldTypeFlow(surface);

    await persistEmbeddedEnvelope(surface);

    await assertChangeFieldTypePersistedInDatabase({
      surface,
      ...result,
    });
  });
});
