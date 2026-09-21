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
 * Authoring side of copy-and-link fields (`27e8b4090`).
 *
 * The feature had unit coverage for the pure helpers
 * (`universal/field-linking/authoring.test.ts`,
 * `server-only/envelope/validate-field-links.test.ts`) but nothing end-to-end:
 * `link-fields-section` / `link-fields-select` had zero references in
 * `packages/app-tests`. The signing-time fan-out is covered separately in
 * `e2e/envelopes/v2-signing.spec.ts`.
 */

const FIRST_POSITION = { x: 120, y: 100 };
const SECOND_POSITION = { x: 450, y: 340 };
const UNLINKED_POSITION = { x: 120, y: 580 };

const FIRST_LABEL = 'Applicant name';
const SECOND_LABEL = 'Applicant name (copy)';
const UNLINKED_LABEL = 'Notes';

const updateExternalId = async (surface: TEnvelopeEditorSurface, externalId: string) => {
  await getEnvelopeEditorSettingsTrigger(surface.root).click();
  await expect(surface.root.getByRole('heading', { name: 'Document Settings' })).toBeVisible();

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

const runFieldLinkingFlow = async (surface: TEnvelopeEditorSurface) => {
  const externalId = `e2e-linking-${nanoid()}`;
  const root = surface.root;

  await updateExternalId(surface, externalId);

  await clickAddMyselfButton(root);
  await expect(getRecipientEmailInputs(root).first()).toHaveValue(surface.userEmail);

  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  await placeFieldOnPdf(root, 'Text', FIRST_POSITION);
  await root.locator('[data-testid="field-form-label"]').fill(FIRST_LABEL);

  await placeFieldOnPdf(root, 'Text', SECOND_POSITION);
  await root.locator('[data-testid="field-form-label"]').fill(SECOND_LABEL);

  await placeFieldOnPdf(root, 'Text', UNLINKED_POSITION);
  await root.locator('[data-testid="field-form-label"]').fill(UNLINKED_LABEL);

  // Link the first two fields from the first field's panel.
  await selectFieldOnCanvas(root, FIRST_POSITION);
  await expect(root.locator('[data-testid="link-fields-section"]')).toBeVisible();

  await root.locator('[data-testid="link-fields-select"]').click();
  await expect(root.locator('[data-testid="link-fields-select"]')).toContainText('Done');

  await selectFieldOnCanvas(root, SECOND_POSITION);
  await expect(root.locator('[data-testid="link-fields-section"]')).toContainText(SECOND_LABEL);

  await root.locator('[data-testid="link-fields-select"]').click();
  await expect(root.locator('[data-testid="link-fields-select"]')).toContainText('Link fields');

  await root.waitForTimeout(1000);
  await clickEnvelopeEditorStep(root, 'upload');
  await clickEnvelopeEditorStep(root, 'addFields');
  await waitForEditorCanvas(root);

  // The link is symmetric: the second field lists the first as a member.
  await selectFieldOnCanvas(root, SECOND_POSITION);
  await expect(root.locator('[data-testid="link-fields-section"]')).toContainText(FIRST_LABEL);

  // The third field stays out of the group.
  await selectFieldOnCanvas(root, UNLINKED_POSITION);
  await expect(root.locator('[data-testid="link-fields-section"]')).toContainText(
    'Not linked to any other fields yet',
  );

  return { externalId };
};

const assertLinkGroupPersisted = async ({
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

  const textFields = envelope.fields.filter((field) => field.type === FieldType.TEXT);
  expect(textFields).toHaveLength(3);

  const metaFor = (label: string) => {
    const field = textFields.find(
      (candidate) => (candidate.fieldMeta as { label?: string } | null)?.label === label,
    );

    expect(field, `expected a TEXT field labelled "${label}"`).toBeDefined();

    return field?.fieldMeta as { linkGroupId?: string } | null;
  };

  const firstGroupId = metaFor(FIRST_LABEL)?.linkGroupId;
  const secondGroupId = metaFor(SECOND_LABEL)?.linkGroupId;

  expect(typeof firstGroupId).toBe('string');
  expect(secondGroupId).toBe(firstGroupId);

  expect(metaFor(UNLINKED_LABEL)?.linkGroupId).toBeUndefined();
};

test.describe('document editor', () => {
  test('link two text fields into a shared link group', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const result = await runFieldLinkingFlow(surface);

    await assertLinkGroupPersisted({ surface, ...result });
  });
});

test.describe('template editor', () => {
  test('link two text fields into a shared link group', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const result = await runFieldLinkingFlow(surface);

    await assertLinkGroupPersisted({ surface, ...result });
  });
});
