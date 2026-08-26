import { expect, test } from '@playwright/test';
import { DateTime } from 'luxon';

import { getTeamSettings } from '@documenso/lib/server-only/team/get-team-settings';
import { prisma } from '@documenso/prisma';
import { seedBlankTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';

import { apiSignin } from '../fixtures/authentication';

test.describe.configure({ mode: 'parallel' });

test('[ENVELOPE_EXPIRATION]: set custom expiration period at organisation level', async ({
  page,
}) => {
  const { user, organisation } = await seedUser({
    isPersonalOrganisation: false,
  });

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/o/${organisation.url}/settings/document`,
  });

  // Wait for the form to load.
  await expect(page.getByRole('button', { name: 'Update' }).first()).toBeVisible();

  // Change the amount to 2.
  const amountInput = page.getByRole('spinbutton');
  await amountInput.clear();
  await amountInput.fill('2');

  // Find all triggers, the unit picker is the one showing Months/Days/etc.
  // In the duration mode, there's a mode select and a unit select.
  // The unit select is inside the duration row, after the number input.
  // Let's find the select trigger that contains the unit text.
  const unitTrigger = page
    .locator('button[role="combobox"]')
    .filter({ hasText: /Months|Days|Weeks|Years/ });

  await unitTrigger.click();
  await page.getByRole('option', { name: 'Weeks' }).click();

  await page.getByRole('button', { name: 'Update' }).first().click();
  await expect(page.getByText('Your document preferences have been updated').first()).toBeVisible();

  // Verify via database.
  const orgSettings = await prisma.organisationGlobalSettings.findUniqueOrThrow({
    where: { id: organisation.organisationGlobalSettingsId },
  });

  expect(orgSettings.envelopeExpirationPeriod).toEqual({ unit: 'week', amount: 2 });
});

test('[ENVELOPE_EXPIRATION]: disable expiration at organisation level', async ({ page }) => {
  const { user, organisation } = await seedUser({
    isPersonalOrganisation: false,
  });

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/o/${organisation.url}/settings/document`,
  });

  await expect(page.getByRole('button', { name: 'Update' }).first()).toBeVisible();

  // Find the mode select (shows "Custom duration") and change to "Never expires".
  const modeTrigger = page
    .locator('button[role="combobox"]')
    .filter({ hasText: 'Custom duration' });
  await modeTrigger.click();
  await page.getByRole('option', { name: 'Never expires' }).click();

  await page.getByRole('button', { name: 'Update' }).first().click();
  await expect(page.getByText('Your document preferences have been updated').first()).toBeVisible();

  // Verify via database.
  const orgSettings = await prisma.organisationGlobalSettings.findUniqueOrThrow({
    where: { id: organisation.organisationGlobalSettingsId },
  });

  expect(orgSettings.envelopeExpirationPeriod).toEqual({ disabled: true });
});

test('[ENVELOPE_EXPIRATION]: team inherits expiration from organisation', async () => {
  const { organisation, team } = await seedUser({
    isPersonalOrganisation: false,
  });

  // Set org expiration to 2 weeks directly.
  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { envelopeExpirationPeriod: { unit: 'week', amount: 2 } },
  });

  // Verify team settings inherit the org setting.
  const teamSettings = await getTeamSettings({ teamId: team.id });

  expect(teamSettings.envelopeExpirationPeriod).toEqual({ unit: 'week', amount: 2 });
});

test('[ENVELOPE_EXPIRATION]: team overrides organisation expiration', async ({ page }) => {
  const { user, organisation, team } = await seedUser({
    isPersonalOrganisation: false,
  });

  // Set org expiration to 2 weeks.
  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { envelopeExpirationPeriod: { unit: 'week', amount: 2 } },
  });

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/settings/document`,
  });

  await expect(page.getByRole('button', { name: 'Update' }).first()).toBeVisible();

  // Scope to the "Default Envelope Expiration" form field section.
  const expirationSection = page.getByText('Default Envelope Expiration').locator('..');

  // The expiration picker mode select should show "Inherit from organisation" by default.
  const modeTrigger = expirationSection.locator('button[role="combobox"]').first();
  await expect(modeTrigger).toBeVisible();

  // Switch to custom duration.
  await modeTrigger.click();
  await page.getByRole('option', { name: 'Custom duration' }).click();

  // Set to 5 days.
  const amountInput = expirationSection.getByRole('spinbutton');
  await amountInput.clear();
  await amountInput.fill('5');

  const unitTrigger = expirationSection
    .locator('button[role="combobox"]')
    .filter({ hasText: /Months|Days|Weeks|Years/ });
  await unitTrigger.click();
  await page.getByRole('option', { name: 'Days' }).click();

  await page.getByRole('button', { name: 'Update' }).first().click();
  await expect(page.getByText('Your document preferences have been updated').first()).toBeVisible();

  // Verify team setting is overridden.
  const teamSettings = await getTeamSettings({ teamId: team.id });

  expect(teamSettings.envelopeExpirationPeriod).toEqual({ unit: 'day', amount: 5 });
});

test('[ENVELOPE_EXPIRATION]: the use-template dialog seeds and overrides the expiration', async ({
  page,
}) => {
  const { user, team } = await seedUser();
  const template = await seedBlankTemplate(user, team.id);

  await prisma.documentMeta.update({
    where: { id: template.documentMetaId },
    data: { envelopeExpirationPeriod: { unit: 'week', amount: 2 }, timezone: 'Etc/UTC' },
  });

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/templates`,
  });

  await page.getByRole('button', { name: 'Use Template' }).click();

  const dialog = page.getByRole('dialog');
  const expirationTrigger = dialog
    .locator('label:has-text("Expiration")')
    .locator('xpath=..')
    .locator('[role="combobox"]')
    .first();

  // The dialog starts from whatever the template is configured with.
  await expect(expirationTrigger).toContainText('Custom duration');
  await expect(dialog.getByRole('spinbutton')).toHaveValue('2');

  // Override it with a fixed deadline for this one document.
  await expirationTrigger.click();
  await page.getByRole('option', { name: 'Specific date and time' }).click();

  const target = DateTime.now().plus({ days: 4 });

  await dialog.locator('button:has(svg.lucide-calendar)').first().click();
  await page.locator('[role="grid"]').first().waitFor();
  await page
    .locator('button[name="day"]:not([disabled])')
    .filter({ hasText: new RegExp(`^${target.day}$`) })
    .first()
    .click();
  await dialog.locator('input[type="time"]').fill('18:45');

  await dialog.getByRole('button', { name: 'Create as draft' }).click();
  await page.waitForURL(/\/documents\/[^/]+/);

  const createdId = page.url().match(/documents\/([^/?]+)/)?.[1];

  const created = await prisma.envelope.findFirstOrThrow({
    where: { id: createdId },
    include: { documentMeta: true },
  });

  expect(created.documentMeta.envelopeExpirationPeriod).toEqual({
    expiresAt: `${target.toFormat('yyyy-MM-dd')}T18:45`,
  });
});
