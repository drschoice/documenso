import { type Page, expect, test } from '@playwright/test';
import { DocumentDistributionMethod, DocumentVisibility } from '@prisma/client';
import { DateTime } from 'luxon';

import { nanoid } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';

import { apiSignin } from '../fixtures/authentication';
import {
  type TEnvelopeEditorSurface,
  getEnvelopeEditorSettingsTrigger,
  openDocumentEnvelopeEditor,
  openEmbeddedEnvelopeEditor,
  openTemplateEnvelopeEditor,
  persistEmbeddedEnvelope,
} from '../fixtures/envelope-editor';
import { expectToastTextToBeVisible } from '../fixtures/generic';

type SettingsFlowData = {
  externalId: string;
  isEmbedded: boolean;
};

const TEST_SETTINGS_VALUES = {
  replyTo: 'e2e-settings@example.com',
  redirectUrl: 'https://example.com/e2e-settings-complete',
  subject: 'E2E settings subject',
  message: 'E2E settings message',
  language: 'French',
  dateFormat: 'DD/MM/YYYY',
  timezone: 'Europe/London',
  distributionMethod: 'None',
  expirationMode: 'Custom duration',
  expirationAmount: 5,
  expirationUnit: 'Weeks',
  accessAuth: 'Require account',
  actionAuth: 'Require password',
  visibility: 'Managers and above',
};

const DB_EXPECTED_VALUES = {
  language: 'fr',
  dateFormat: 'dd/MM/yyyy',
  timezone: 'Europe/London',
  distributionMethod: DocumentDistributionMethod.NONE,
  envelopeExpirationPeriod: { unit: 'week', amount: 5 },
  visibility: DocumentVisibility.MANAGER_AND_ABOVE,
  globalAccessAuth: ['ACCOUNT'],
  globalActionAuth: ['PASSWORD'],
  emailSettings: {
    recipientSigned: false,
    recipientSigningRequest: false,
    recipientRemoved: false,
    documentPending: false,
    documentCompleted: false,
    documentDeleted: false,
    ownerDocumentCompleted: false,
    ownerRecipientExpired: false,
    ownerDocumentCreated: false,
  },
};

const openSettingsDialog = async (root: Page) => {
  await getEnvelopeEditorSettingsTrigger(root).click();
  await expect(root.getByRole('heading', { name: 'Document Settings' })).toBeVisible();
};

const clickSettingsDialogHeader = async (root: Page) => {
  await root.locator('[data-testid="envelope-editor-settings-dialog-header"]').click();
};

const getComboboxByLabel = (root: Page, label: string) =>
  root
    .locator(`label:has-text("${label}")`)
    .locator('xpath=..')
    .locator('[role="combobox"]')
    .first();

const selectMultiSelectOption = async (
  root: Page,
  dataTestId: 'documentAccessSelectValue' | 'documentActionSelectValue',
  optionLabel: string,
) => {
  const select = root.locator(`[data-testid="${dataTestId}"]`);

  await select.click();
  await root.locator('[cmdk-item]').filter({ hasText: optionLabel }).first().click();
  await clickSettingsDialogHeader(root);
};

const runSettingsFlow = async (
  { root }: TEnvelopeEditorSurface,
  { externalId, isEmbedded }: SettingsFlowData,
) => {
  await openSettingsDialog(root);

  await getComboboxByLabel(root, 'Language').click();
  await root.getByRole('option', { name: TEST_SETTINGS_VALUES.language }).click();
  await clickSettingsDialogHeader(root);

  const signatureTypesCombobox = getComboboxByLabel(root, 'Allowed Signature Types');

  await signatureTypesCombobox.click();
  await root.getByRole('option', { name: 'Upload' }).click();
  await clickSettingsDialogHeader(root);

  await getComboboxByLabel(root, 'Date Format').click();
  await root.getByRole('option', { name: TEST_SETTINGS_VALUES.dateFormat, exact: true }).click();
  await clickSettingsDialogHeader(root);

  await getComboboxByLabel(root, 'Time Zone').click();
  await root.locator('[cmdk-input]').last().fill(TEST_SETTINGS_VALUES.timezone);
  await root.getByRole('option', { name: TEST_SETTINGS_VALUES.timezone }).click();
  await clickSettingsDialogHeader(root);

  await root.locator('input[name="externalId"]').fill(externalId);
  await root.locator('input[name="meta.redirectUrl"]').fill(TEST_SETTINGS_VALUES.redirectUrl);

  await root.locator('[data-testid="documentDistributionMethodSelectValue"]').click();
  await root.getByRole('option', { name: TEST_SETTINGS_VALUES.distributionMethod }).click();
  await clickSettingsDialogHeader(root);

  await getComboboxByLabel(root, 'Expiration').click();
  await root.getByRole('option', { name: TEST_SETTINGS_VALUES.expirationMode }).click();
  await root.getByRole('spinbutton').clear();
  await root.getByRole('spinbutton').fill(String(TEST_SETTINGS_VALUES.expirationAmount));
  const expirationUnitTrigger = root
    .locator('button[role="combobox"]')
    .filter({ hasText: /Months|Days|Weeks|Years/ })
    .first();
  await expirationUnitTrigger.click();
  await root.getByRole('option', { name: TEST_SETTINGS_VALUES.expirationUnit }).click();
  await clickSettingsDialogHeader(root);

  await root.getByRole('button', { name: 'Email' }).click();
  await root.locator('#recipientSigned').click();
  await root.locator('#recipientSigningRequest').click();
  await root.locator('#recipientRemoved').click();
  await root.locator('#documentPending').click();
  await root.locator('#documentCompleted').click();
  await root.locator('#documentDeleted').click();
  await root.locator('#ownerDocumentCompleted').click();
  await root.locator('#ownerRecipientExpired').click();
  await root.locator('#ownerDocumentCreated').click();
  await root.locator('input[name="meta.emailReplyTo"]').fill(TEST_SETTINGS_VALUES.replyTo);
  await root.locator('input[name="meta.subject"]').fill(TEST_SETTINGS_VALUES.subject);
  await root.locator('textarea[name="meta.message"]').fill(TEST_SETTINGS_VALUES.message);

  await root.getByRole('button', { name: 'Security' }).click();
  await selectMultiSelectOption(root, 'documentAccessSelectValue', TEST_SETTINGS_VALUES.accessAuth);

  const actionAuthSelect = root.locator('[data-testid="documentActionSelectValue"]');
  const hasActionAuthSelect = (await actionAuthSelect.count()) > 0;

  if (hasActionAuthSelect) {
    await selectMultiSelectOption(
      root,
      'documentActionSelectValue',
      TEST_SETTINGS_VALUES.actionAuth,
    );
  }

  if (isEmbedded) {
    await expect(root.locator('[data-testid="documentVisibilitySelectValue"]')).toHaveCount(0);
  } else {
    await root.locator('[data-testid="documentVisibilitySelectValue"]').click();
    await root.getByRole('option', { name: TEST_SETTINGS_VALUES.visibility }).click();
    await clickSettingsDialogHeader(root);
  }

  await root.getByRole('button', { name: 'Update' }).click();

  if (!isEmbedded) {
    await expectToastTextToBeVisible(root, 'Envelope updated');
  }

  await openSettingsDialog(root);

  await expect(root.locator('input[name="externalId"]')).toHaveValue(externalId);
  await expect(root.locator('input[name="meta.redirectUrl"]')).toHaveValue(
    TEST_SETTINGS_VALUES.redirectUrl,
  );
  await expect(getComboboxByLabel(root, 'Language')).toContainText(TEST_SETTINGS_VALUES.language);
  await expect(getComboboxByLabel(root, 'Allowed Signature Types')).not.toContainText('Upload');
  await expect(getComboboxByLabel(root, 'Date Format')).toContainText(
    TEST_SETTINGS_VALUES.dateFormat,
  );
  await expect(getComboboxByLabel(root, 'Time Zone')).toContainText(TEST_SETTINGS_VALUES.timezone);
  await expect(root.locator('[data-testid="documentDistributionMethodSelectValue"]')).toContainText(
    TEST_SETTINGS_VALUES.distributionMethod,
  );
  await expect(getComboboxByLabel(root, 'Expiration')).toContainText(
    TEST_SETTINGS_VALUES.expirationMode,
  );
  await expect(root.getByRole('spinbutton')).toHaveValue(
    String(TEST_SETTINGS_VALUES.expirationAmount),
  );
  await expect(
    root
      .locator('button[role="combobox"]')
      .filter({ hasText: TEST_SETTINGS_VALUES.expirationUnit })
      .first(),
  ).toBeVisible();

  await root.getByRole('button', { name: 'Email' }).click();
  await expect(root.locator('#recipientSigned')).toHaveAttribute('aria-checked', 'false');
  await expect(root.locator('#recipientSigningRequest')).toHaveAttribute('aria-checked', 'false');
  await expect(root.locator('#recipientRemoved')).toHaveAttribute('aria-checked', 'false');
  await expect(root.locator('#documentPending')).toHaveAttribute('aria-checked', 'false');
  await expect(root.locator('#documentCompleted')).toHaveAttribute('aria-checked', 'false');
  await expect(root.locator('#documentDeleted')).toHaveAttribute('aria-checked', 'false');
  await expect(root.locator('#ownerDocumentCompleted')).toHaveAttribute('aria-checked', 'false');
  await expect(root.locator('#ownerRecipientExpired')).toHaveAttribute('aria-checked', 'false');
  await expect(root.locator('#ownerDocumentCreated')).toHaveAttribute('aria-checked', 'false');
  await expect(root.locator('input[name="meta.emailReplyTo"]')).toHaveValue(
    TEST_SETTINGS_VALUES.replyTo,
  );
  await expect(root.locator('input[name="meta.subject"]')).toHaveValue(
    TEST_SETTINGS_VALUES.subject,
  );
  await expect(root.locator('textarea[name="meta.message"]')).toHaveValue(
    TEST_SETTINGS_VALUES.message,
  );

  await root.getByRole('button', { name: 'Security' }).click();
  await expect(root.locator('[data-testid="documentAccessSelectValue"]')).toContainText(
    TEST_SETTINGS_VALUES.accessAuth,
  );

  if (hasActionAuthSelect) {
    await expect(root.locator('[data-testid="documentActionSelectValue"]')).toContainText(
      TEST_SETTINGS_VALUES.actionAuth,
    );
  }

  if (isEmbedded) {
    await expect(root.locator('[data-testid="documentVisibilitySelectValue"]')).toHaveCount(0);
  } else {
    await expect(root.locator('[data-testid="documentVisibilitySelectValue"]')).toContainText(
      TEST_SETTINGS_VALUES.visibility,
    );
  }

  await root.getByRole('button', { name: 'Update' }).click();

  if (!isEmbedded) {
    await expectToastTextToBeVisible(root, 'Envelope updated');
  }

  return {
    hasActionAuthSelect,
  };
};

const assertEnvelopeSettingsPersistedInDatabase = async ({
  externalId,
  surface,
  hasActionAuthSelect,
  shouldAssertVisibility,
}: {
  externalId: string;
  surface: TEnvelopeEditorSurface;
  hasActionAuthSelect: boolean;
  shouldAssertVisibility: boolean;
}) => {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: {
      externalId,
      userId: surface.userId,
      teamId: surface.teamId,
      type: surface.envelopeType,
    },
    orderBy: { createdAt: 'desc' },
    include: {
      documentMeta: true,
    },
  });

  expect(envelope.externalId).toBe(externalId);
  if (shouldAssertVisibility) {
    expect(envelope.visibility).toBe(DB_EXPECTED_VALUES.visibility);
  }
  expect(envelope.documentMeta.language).toBe(DB_EXPECTED_VALUES.language);
  expect(envelope.documentMeta.dateFormat).toBe(DB_EXPECTED_VALUES.dateFormat);
  expect(envelope.documentMeta.timezone).toBe(DB_EXPECTED_VALUES.timezone);
  expect(envelope.documentMeta.distributionMethod).toBe(DB_EXPECTED_VALUES.distributionMethod);
  expect(envelope.documentMeta.envelopeExpirationPeriod).toEqual(
    DB_EXPECTED_VALUES.envelopeExpirationPeriod,
  );
  expect(envelope.documentMeta.redirectUrl).toBe(TEST_SETTINGS_VALUES.redirectUrl);
  expect(envelope.documentMeta.emailReplyTo).toBe(TEST_SETTINGS_VALUES.replyTo);
  expect(envelope.documentMeta.subject).toBe(TEST_SETTINGS_VALUES.subject);
  expect(envelope.documentMeta.message).toBe(TEST_SETTINGS_VALUES.message);
  expect(envelope.documentMeta.drawSignatureEnabled).toBe(true);
  expect(envelope.documentMeta.typedSignatureEnabled).toBe(true);
  expect(envelope.documentMeta.uploadSignatureEnabled).toBe(false);
  expect(envelope.documentMeta.emailSettings).toMatchObject(DB_EXPECTED_VALUES.emailSettings);

  const authOptions = parseAuthOptions(envelope.authOptions);

  expect(authOptions.globalAccessAuth ?? []).toEqual(DB_EXPECTED_VALUES.globalAccessAuth);

  if (hasActionAuthSelect) {
    expect(authOptions.globalActionAuth ?? []).toEqual(DB_EXPECTED_VALUES.globalActionAuth);
  }
};

const parseAuthOptions = (
  authOptions: unknown,
): { globalAccessAuth: string[]; globalActionAuth: string[] } => {
  if (!isRecord(authOptions)) {
    return {
      globalAccessAuth: [],
      globalActionAuth: [],
    };
  }

  return {
    globalAccessAuth: Array.isArray(authOptions.globalAccessAuth)
      ? authOptions.globalAccessAuth.filter((entry): entry is string => typeof entry === 'string')
      : [],
    globalActionAuth: Array.isArray(authOptions.globalActionAuth)
      ? authOptions.globalActionAuth.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

test.describe('document editor', () => {
  test('update and persist settings', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const externalId = `e2e-settings-${nanoid()}`;

    const { hasActionAuthSelect } = await runSettingsFlow(surface, {
      externalId,
      isEmbedded: false,
    });

    await assertEnvelopeSettingsPersistedInDatabase({
      externalId,
      surface,
      hasActionAuthSelect,
      shouldAssertVisibility: true,
    });
  });
});

test.describe('template editor', () => {
  test('update and persist settings', async ({ page }) => {
    const surface = await openTemplateEnvelopeEditor(page);
    const externalId = `e2e-settings-${nanoid()}`;

    const { hasActionAuthSelect } = await runSettingsFlow(surface, {
      externalId,
      isEmbedded: false,
    });

    await assertEnvelopeSettingsPersistedInDatabase({
      externalId,
      surface,
      hasActionAuthSelect,
      shouldAssertVisibility: true,
    });
  });
});

test.describe('embedded create', () => {
  test('update and persist settings', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'DOCUMENT',
      tokenNamePrefix: 'e2e-embed-settings',
    });
    const externalId = `e2e-settings-${nanoid()}`;

    const { hasActionAuthSelect } = await runSettingsFlow(surface, {
      externalId,
      isEmbedded: true,
    });

    await persistEmbeddedEnvelope(surface);

    await assertEnvelopeSettingsPersistedInDatabase({
      externalId,
      surface,
      hasActionAuthSelect,
      shouldAssertVisibility: false,
    });
  });
});

test.describe('embedded edit', () => {
  test('update and persist settings', async ({ page }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'TEMPLATE',
      mode: 'edit',
      tokenNamePrefix: 'e2e-embed-settings',
    });
    const externalId = `e2e-settings-${nanoid()}`;

    const { hasActionAuthSelect } = await runSettingsFlow(surface, {
      externalId,
      isEmbedded: true,
    });

    await persistEmbeddedEnvelope(surface);

    await assertEnvelopeSettingsPersistedInDatabase({
      externalId,
      surface,
      hasActionAuthSelect,
      shouldAssertVisibility: false,
    });
  });
});

test.describe('fixed expiration date', () => {
  test('set, persist and round-trip a specific date and time', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);
    const { root } = surface;
    const externalId = `e2e-expiry-date-${nanoid()}`;

    await openSettingsDialog(root);
    await root.locator('input[name="externalId"]').fill(externalId);

    // The deadline is read in the envelope timezone, so pin it rather than relying on the default.
    await getComboboxByLabel(root, 'Time Zone').click();
    await root.locator('[cmdk-input]').last().fill('Etc/UTC');
    await root.getByRole('option', { name: 'Etc/UTC' }).click();
    await clickSettingsDialogHeader(root);

    await getComboboxByLabel(root, 'Expiration').click();
    await root.getByRole('option', { name: 'Specific date and time' }).click();

    // Seeded as tomorrow at 8pm; the time is editable, the date comes from the calendar.
    const timeInput = root.locator('input[type="time"]');
    await expect(timeInput).toHaveValue('20:00');
    await timeInput.fill('09:30');

    // Pick the day through the calendar rather than trusting the seed — the popover has to render
    // above the dialog to be clickable at all.
    const target = DateTime.now().plus({ days: 3 });

    await root.locator('button:has(svg.lucide-calendar)').first().click();
    await root.locator('[role="grid"]').first().waitFor();
    await root
      .locator('button[name="day"]:not([disabled])')
      .filter({ hasText: new RegExp(`^${target.day}$`) })
      .first()
      .click();

    const expectedDate = target.toFormat('yyyy-MM-dd');

    await root.getByRole('button', { name: 'Update' }).click();
    await expectToastTextToBeVisible(root, 'Envelope updated');

    // Reopening shows the fixed date back, not a duration.
    await openSettingsDialog(root);
    await expect(getComboboxByLabel(root, 'Expiration')).toContainText('Specific date and time');
    await expect(root.locator('input[type="time"]')).toHaveValue('09:30');

    const envelope = await prisma.envelope.findFirstOrThrow({
      where: {
        externalId,
        userId: surface.userId,
        teamId: surface.teamId,
        type: surface.envelopeType,
      },
      orderBy: { createdAt: 'desc' },
      include: { documentMeta: true },
    });

    expect(envelope.documentMeta.timezone).toBe('Etc/UTC');
    expect(envelope.documentMeta.envelopeExpirationPeriod).toEqual({
      expiresAt: `${expectedDate}T09:30`,
    });
  });

  test('is not offered as an organisation-wide default', async ({ page }) => {
    const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

    await apiSignin({
      page,
      email: user.email,
      redirectPath: `/o/${organisation.url}/settings/document`,
    });

    await expect(page.getByRole('button', { name: 'Update' }).first()).toBeVisible();

    const modeTrigger = page
      .locator('button[role="combobox"]')
      .filter({ hasText: 'Custom duration' });

    await modeTrigger.click();

    // A fixed calendar date as a standing default for every future document would go stale, so the
    // organisation and team pickers stay duration-or-never.
    await expect(page.getByRole('option', { name: 'Never expires' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Specific date and time' })).toHaveCount(0);
  });
});
