import { expect, test } from '@playwright/test';

import { prisma } from '@documenso/prisma';
import { EmailSenderNameMode } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';

import { apiSignin } from '../fixtures/authentication';

/**
 * UI coverage for two organisation settings that the fork added and the v2.18.0 port
 * silently dropped: the email sender name and the signature font.
 *
 * Both survived the merge everywhere except the screen - schema, tRPC input, settings
 * routes and server resolvers were all intact, so nothing failed to compile and nothing
 * failed to run. The setting simply could not be reached, and the suite did not notice
 * because neither feature had a test that opened a page: `email-sender-name.spec.ts`
 * drives the API and reads the resulting mail, and the signature font had no spec at all.
 *
 * So these tests deliberately go through the form rather than the mutation. They assert
 * the control exists, that a choice made in it reaches the database, and - for the sender
 * name - that the dependent input appears only for the mode that needs it. The resolver
 * semantics stay covered by the specs that already do it better.
 */

test.describe('organisation preferences that only the UI can reach', () => {
  test('the email sender name can be set from the email preferences page', async ({ page }) => {
    const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

    await apiSignin({
      page,
      email: user.email,
      redirectPath: `/o/${organisation.url}/settings/email`,
    });

    const modeTrigger = page.getByTestId('email-sender-name-mode-trigger');

    // Barrier: the page renders a spinner until the organisation query resolves, and the
    // save bar only appears once the form is dirty, so the control itself is what to wait on.
    await expect(modeTrigger).toBeVisible();

    // The custom name input is conditional on the mode, so it must not be there yet.
    await expect(page.getByTestId('email-sender-name-custom')).toHaveCount(0);

    await modeTrigger.click();
    await page.getByRole('option', { name: 'Custom' }).click();

    const customInput = page.getByTestId('email-sender-name-custom');
    await expect(customInput).toBeVisible();

    await customInput.fill('DrSchoice Contracts');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(async () => {
      const settings = await prisma.organisationGlobalSettings.findFirstOrThrow({
        where: { organisation: { id: organisation.id } },
      });

      expect(settings.emailSenderNameMode).toBe(EmailSenderNameMode.CUSTOM);
      expect(settings.emailSenderNameCustom).toBe('DrSchoice Contracts');
    }).toPass({ timeout: 15_000 });
  });

  test('the signature font can be set from the document preferences page', async ({ page }) => {
    const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

    await apiSignin({
      page,
      email: user.email,
      // Not the branding page. The signature font is a document default - it lives on
      // DocumentMeta alongside dateFormat and timezone, is overridable per field in the
      // editor, and never passes through the branding resolvers - so it sits with the
      // other document defaults rather than behind the custom-branding toggle.
      redirectPath: `/o/${organisation.url}/settings/document`,
    });

    const fontTrigger = page.getByTestId('signature-font');
    await expect(fontTrigger).toBeVisible();

    await fontTrigger.click();

    // Any curated family other than the Caveat default, so the assertion proves the
    // choice travelled rather than matching what was already stored.
    await page.getByRole('option', { name: 'Dancing Script' }).click();

    await page.getByTestId('signature-font-size').fill('32');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(async () => {
      const settings = await prisma.organisationGlobalSettings.findFirstOrThrow({
        where: { organisation: { id: organisation.id } },
      });

      expect(settings.signatureFontFamily).toBe('Dancing Script');
      expect(settings.signatureFontSize).toBe(32);
    }).toPass({ timeout: 15_000 });
  });
});
