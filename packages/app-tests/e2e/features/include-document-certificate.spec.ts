import { PDF } from '@libpdf/core';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { DocumentStatus, FieldType } from '@prisma/client';

import { getDocumentByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { DEFAULT_EMBEDDED_EDITOR_CONFIG } from '@documenso/lib/types/envelope-editor';
import { getEnvelopeItemPdfUrl } from '@documenso/lib/utils/envelope-download';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedTeam } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';

import { apiSignin } from '../fixtures/authentication';
import {
  getEnvelopeEditorSettingsTrigger,
  openEmbeddedEnvelopeEditor,
  persistEmbeddedEnvelope,
} from '../fixtures/envelope-editor';
import { signSignaturePad } from '../fixtures/signature';

test.describe('Signing Certificate Tests', () => {
  test('individual document should always include signing certificate', async ({ page }) => {
    const { user, team } = await seedUser({
      isPersonalOrganisation: true,
    });

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      recipients: ['signer@example.com'],
      fields: [FieldType.SIGNATURE],
      teamId: team.id,
    });

    const recipient = recipients[0];

    const documentData = await prisma.envelopeItem
      .findFirstOrThrow({
        where: {
          envelopeId: document.id,
        },
      })
      .then(async (data) => {
        const documentUrl = getEnvelopeItemPdfUrl({
          type: 'download',
          envelopeItem: data,
          token: recipient.token,
          version: 'signed',
        });
        return fetch(documentUrl).then(async (res) => await res.arrayBuffer());
      });

    const originalPdf = await PDF.load(new Uint8Array(documentData));

    // Sign the document
    await page.goto(`/sign/${recipient.token}`);

    await signSignaturePad(page);

    for (const field of recipient.fields) {
      await page.locator(`#field-${field.id}`).getByRole('button').click();

      await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
    }

    await page.getByRole('button', { name: 'Complete' }).click();

    await page.waitForTimeout(1000);

    await page.getByRole('button', { name: 'Sign' }).click({ force: true });
    await page.waitForURL(`/sign/${recipient.token}/complete`);

    await page.waitForTimeout(10000);

    await expect(async () => {
      const { status } = await getDocumentByToken({
        token: recipient.token,
      });

      expect(status).toBe(DocumentStatus.COMPLETED);
    }).toPass();

    await page.waitForTimeout(2500);

    // Get the completed document
    const completedDocument = await prisma.envelope.findFirstOrThrow({
      where: { id: document.id },
      include: {
        envelopeItems: {
          include: {
            documentData: true,
          },
        },
      },
    });

    const firstDocumentData = completedDocument.envelopeItems[0];

    const documentUrl = getEnvelopeItemPdfUrl({
      type: 'download',
      envelopeItem: firstDocumentData,
      token: recipient.token,
      version: 'signed',
    });

    const pdfData = await fetch(documentUrl).then(async (res) => await res.arrayBuffer());

    const completedDocumentData = new Uint8Array(pdfData);

    // Load the PDF and check number of pages
    const pdfDoc = await PDF.load(new Uint8Array(completedDocumentData));

    expect(pdfDoc.getPageCount()).toBe(originalPdf.getPageCount() + 1); // Original + Certificate
  });

  test('team document with signing certificate enabled should include certificate', async ({
    page,
  }) => {
    const { owner, team } = await seedTeam();

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner: owner,
      recipients: ['signer@example.com'],
      fields: [FieldType.SIGNATURE],
      teamId: team.id,
    });

    const teamSettingsId = await prisma.teamGlobalSettings.findFirstOrThrow({
      where: {
        team: {
          id: team.id,
        },
      },
    });

    await prisma.teamGlobalSettings.update({
      where: {
        id: teamSettingsId.id,
      },
      data: {
        includeSigningCertificate: true,
      },
    });

    const recipient = recipients[0];

    const documentData = await prisma.envelopeItem
      .findFirstOrThrow({
        where: {
          envelopeId: document.id,
        },
      })
      .then(async (data) => {
        const documentUrl = getEnvelopeItemPdfUrl({
          type: 'download',
          envelopeItem: data,
          token: recipient.token,
          version: 'signed',
        });
        return fetch(documentUrl).then(async (res) => await res.arrayBuffer());
      });

    const originalPdf = await PDF.load(new Uint8Array(documentData));

    // Sign the document
    await page.goto(`/sign/${recipient.token}`);

    await signSignaturePad(page);

    for (const field of recipient.fields) {
      await page.locator(`#field-${field.id}`).getByRole('button').click();

      await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
    }

    await page.getByRole('button', { name: 'Complete' }).click();
    await page.getByRole('button', { name: 'Sign' }).click();
    await page.waitForURL(`/sign/${recipient.token}/complete`);

    await expect(async () => {
      const { status } = await getDocumentByToken({
        token: recipient.token,
      });

      expect(status).toBe(DocumentStatus.COMPLETED);
    }).toPass();

    await page.waitForTimeout(2500);

    // Get the completed document
    const completedDocument = await prisma.envelope.findFirstOrThrow({
      where: { id: document.id },
      include: {
        envelopeItems: {
          include: {
            documentData: true,
          },
        },
      },
    });

    const firstDocumentData = completedDocument.envelopeItems[0];

    const documentUrl = getEnvelopeItemPdfUrl({
      type: 'download',
      envelopeItem: firstDocumentData,
      token: recipient.token,
      version: 'signed',
    });

    const pdfData = await fetch(documentUrl).then(async (res) => await res.arrayBuffer());

    const completedDocumentData = new Uint8Array(pdfData);

    // Load the PDF and check number of pages
    const completedPdf = await PDF.load(new Uint8Array(completedDocumentData));

    expect(completedPdf.getPageCount()).toBe(originalPdf.getPageCount() + 1); // Original + Certificate
  });

  test('team document with signing certificate disabled should not include certificate', async ({
    page,
  }) => {
    const { owner, team } = await seedTeam();

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner: owner,
      recipients: ['signer@example.com'],
      fields: [FieldType.SIGNATURE],
      teamId: team.id,
    });

    const teamSettingsId = await prisma.teamGlobalSettings.findFirstOrThrow({
      where: {
        team: {
          id: team.id,
        },
      },
    });

    await prisma.teamGlobalSettings.update({
      where: {
        id: teamSettingsId.id,
      },
      data: {
        includeSigningCertificate: false,
      },
    });

    const recipient = recipients[0];

    const documentData = await prisma.envelopeItem
      .findFirstOrThrow({
        where: {
          envelopeId: document.id,
        },
      })
      .then(async (data) => {
        const documentUrl = getEnvelopeItemPdfUrl({
          type: 'download',
          envelopeItem: data,
          token: recipient.token,
          version: 'signed',
        });
        return fetch(documentUrl).then(async (res) => await res.arrayBuffer());
      });

    const originalPdf = await PDF.load(new Uint8Array(documentData));

    // Sign the document
    await page.goto(`/sign/${recipient.token}`);

    await signSignaturePad(page);

    for (const field of recipient.fields) {
      await page.locator(`#field-${field.id}`).getByRole('button').click();

      await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
    }

    await page.getByRole('button', { name: 'Complete' }).click();
    await page.getByRole('button', { name: 'Sign' }).click();
    await page.waitForURL(`/sign/${recipient.token}/complete`);

    await expect(async () => {
      const { status } = await getDocumentByToken({
        token: recipient.token,
      });

      expect(status).toBe(DocumentStatus.COMPLETED);
    }).toPass();

    await page.waitForTimeout(2500);

    // Get the completed document
    const completedDocument = await prisma.envelope.findFirstOrThrow({
      where: { id: document.id },
      include: {
        envelopeItems: {
          include: {
            documentData: true,
          },
        },
      },
    });

    const documentUrl = getEnvelopeItemPdfUrl({
      type: 'download',
      envelopeItem: completedDocument.envelopeItems[0],
      token: recipient.token,
      version: 'signed',
    });

    const completedDocumentData = await fetch(documentUrl).then(
      async (res) => await res.arrayBuffer(),
    );

    // Load the PDF and check number of pages
    const completedPdf = await PDF.load(new Uint8Array(completedDocumentData));

    expect(completedPdf.getPageCount()).toBe(originalPdf.getPageCount());
  });

  /**
   * Sign every field on the recipient's document, wait for the seal job to finish, and report how
   * many pages the sealed PDF gained over the original. +1 means the certificate was appended.
   */
  const signAndCountExtraPages = async (
    page: Page,
    envelopeId: string,
    recipient: { token: string; fields: { id: number }[] },
  ) => {
    const originalPdf = await prisma.envelopeItem
      .findFirstOrThrow({ where: { envelopeId } })
      .then(async (envelopeItem) =>
        fetch(
          getEnvelopeItemPdfUrl({
            type: 'download',
            envelopeItem,
            token: recipient.token,
            version: 'signed',
          }),
        ).then(async (res) => await res.arrayBuffer()),
      )
      .then(async (data) => await PDF.load(new Uint8Array(data)));

    await page.goto(`/sign/${recipient.token}`);

    await signSignaturePad(page);

    for (const field of recipient.fields) {
      await page.locator(`#field-${field.id}`).getByRole('button').click();

      await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
    }

    await page.getByRole('button', { name: 'Complete' }).click();
    await page.getByRole('button', { name: 'Sign' }).click();
    await page.waitForURL(`/sign/${recipient.token}/complete`);

    await expect(async () => {
      const { status } = await getDocumentByToken({ token: recipient.token });

      expect(status).toBe(DocumentStatus.COMPLETED);
    }).toPass();

    await page.waitForTimeout(2500);

    const completedDocument = await prisma.envelope.findFirstOrThrow({
      where: { id: envelopeId },
      include: { envelopeItems: { include: { documentData: true } } },
    });

    const completedData = await fetch(
      getEnvelopeItemPdfUrl({
        type: 'download',
        envelopeItem: completedDocument.envelopeItems[0],
        token: recipient.token,
        version: 'signed',
      }),
    ).then(async (res) => await res.arrayBuffer());

    const completedPdf = await PDF.load(new Uint8Array(completedData));

    return completedPdf.getPageCount() - originalPdf.getPageCount();
  };

  const setTeamSigningCertificate = async (teamId: number, value: boolean | null) => {
    const teamSettings = await prisma.teamGlobalSettings.findFirstOrThrow({
      where: { team: { id: teamId } },
    });

    await prisma.teamGlobalSettings.update({
      where: { id: teamSettings.id },
      data: { includeSigningCertificate: value },
    });
  };

  const setOrganisationSigningCertificate = async (organisationId: string, value: boolean) => {
    const organisation = await prisma.organisation.findFirstOrThrow({
      where: { id: organisationId },
    });

    await prisma.organisationGlobalSettings.update({
      where: { id: organisation.organisationGlobalSettingsId },
      data: { includeSigningCertificate: value },
    });
  };

  const setEnvelopeSigningCertificate = async (envelopeId: string, value: boolean | null) => {
    const envelope = await prisma.envelope.findFirstOrThrow({ where: { id: envelopeId } });

    await prisma.documentMeta.update({
      where: { id: envelope.documentMetaId },
      data: { includeSigningCertificate: value },
    });
  };

  test('envelope override of false wins over a team setting of true', async ({ page }) => {
    const { owner, team } = await seedTeam();

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner,
      recipients: ['signer@example.com'],
      fields: [FieldType.SIGNATURE],
      teamId: team.id,
    });

    await setTeamSigningCertificate(team.id, true);
    await setEnvelopeSigningCertificate(document.id, false);

    expect(await signAndCountExtraPages(page, document.id, recipients[0])).toBe(0);
  });

  test('envelope override of true wins over a team setting of false', async ({ page }) => {
    const { owner, team } = await seedTeam();

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner,
      recipients: ['signer@example.com'],
      fields: [FieldType.SIGNATURE],
      teamId: team.id,
    });

    await setTeamSigningCertificate(team.id, false);
    await setEnvelopeSigningCertificate(document.id, true);

    expect(await signAndCountExtraPages(page, document.id, recipients[0])).toBe(1);
  });

  test('a null envelope override keeps following the team setting', async ({ page }) => {
    const { owner, team } = await seedTeam();

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner,
      recipients: ['signer@example.com'],
      fields: [FieldType.SIGNATURE],
      teamId: team.id,
    });

    await setTeamSigningCertificate(team.id, false);
    await setEnvelopeSigningCertificate(document.id, null);

    expect(await signAndCountExtraPages(page, document.id, recipients[0])).toBe(0);
  });

  /**
   * The setting is a three-level chain - organisation, then team, then envelope -
   * and the tests above only ever exercise its lower two links. A team that has
   * never opened its own settings stores `null`, so what a document does is
   * decided entirely by the organisation. Both directions are asserted, because a
   * test that only proved "no certificate" would still pass if sealing had
   * stopped appending one at all.
   */
  const seedTeamInheritingCertificate = async (organisationValue: boolean) => {
    const { owner, team, organisation } = await seedTeam();

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner,
      recipients: ['signer@example.com'],
      fields: [FieldType.SIGNATURE],
      teamId: team.id,
    });

    await setOrganisationSigningCertificate(organisation.id, organisationValue);
    await setTeamSigningCertificate(team.id, null);
    await setEnvelopeSigningCertificate(document.id, null);

    // Guards the test against quietly becoming a restatement of the team-level
    // tests if the seed or the setter ever starts writing a concrete value here.
    const teamSettings = await prisma.teamGlobalSettings.findFirstOrThrow({
      where: { team: { id: team.id } },
    });

    expect(teamSettings.includeSigningCertificate).toBeNull();

    return { document, recipients };
  };

  test('a team that has set nothing follows its organisation turning the certificate off', async ({
    page,
  }) => {
    const { document, recipients } = await seedTeamInheritingCertificate(false);

    expect(await signAndCountExtraPages(page, document.id, recipients[0])).toBe(0);
  });

  test('a team that has set nothing follows its organisation turning the certificate on', async ({
    page,
  }) => {
    const { document, recipients } = await seedTeamInheritingCertificate(true);

    expect(await signAndCountExtraPages(page, document.id, recipients[0])).toBe(1);
  });

  test('envelope editor can toggle the signing certificate', async ({ page }) => {
    const { owner, team } = await seedTeam();

    const { document } = await seedPendingDocumentWithFullFields({
      owner,
      recipients: ['signer@example.com'],
      fields: [FieldType.SIGNATURE],
      teamId: team.id,
      // `seedBlankDocument` defaults to `internalVersion: 1`, and the editor route
      // redirects anything that is not version 2 straight to `legacy_editor`, which
      // has none of the v2 sidebar. This test asserts a v2 editor control, so it has
      // to be seeded on v2.
      updateDocumentOptions: { internalVersion: 2 },
    });

    await apiSignin({
      page,
      email: owner.email,
      redirectPath: `/t/${team.url}/documents/${document.id}/edit`,
    });

    const readOverride = async () => {
      const envelope = await prisma.envelope.findFirstOrThrow({
        where: { id: document.id },
        include: { documentMeta: true },
      });

      return envelope.documentMeta.includeSigningCertificate;
    };

    // Defaults to inheriting the organisation/team setting.
    expect(await readOverride()).toBeNull();

    // Located by `title`, matching every other editor spec.
    await getEnvelopeEditorSettingsTrigger(page).click();
    await expect(page.getByRole('heading', { name: 'Document Settings' })).toBeVisible();

    const trigger = page.getByTestId('envelope-include-signing-certificate-trigger');

    await expect(trigger).toBeVisible();

    await trigger.click();
    await page.getByRole('option', { name: 'No', exact: true }).click();

    await page
      .getByRole('button', { name: /Update|Save/ })
      .last()
      .click();

    await expect(async () => {
      expect(await readOverride()).toBe(false);
    }).toPass();
  });

  /**
   * The embedded authoring surface is a separate mount with its own feature
   * gating, and `cb9cc64b4` added both halves of that: the
   * `allowConfigureSigningCertificate` flag and the team default passed down
   * through the embed loader. An integrator who turns the flag off must not be
   * shown a control their host application cannot honour.
   */
  test('the embedded editor gates the certificate control behind its feature flag', async ({
    page,
  }) => {
    const surface = await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'DOCUMENT',
      mode: 'edit',
      tokenNamePrefix: 'e2e-embed-certificate',
    });

    const trigger = page.getByTestId('envelope-include-signing-certificate-trigger');

    await getEnvelopeEditorSettingsTrigger(page).click();
    await expect(page.getByRole('heading', { name: 'Document Settings' })).toBeVisible();
    await expect(trigger).toBeVisible();

    await trigger.click();
    await page.getByRole('option', { name: 'No', exact: true }).click();

    await page
      .getByRole('button', { name: /Update|Save/ })
      .last()
      .click();

    await expect(page.getByRole('heading', { name: 'Document Settings' })).toBeHidden();

    await persistEmbeddedEnvelope(surface);

    await expect(async () => {
      const envelope = await prisma.envelope.findFirstOrThrow({
        where: { id: surface.envelopeId },
        include: { documentMeta: true },
      });

      expect(envelope.documentMeta.includeSigningCertificate).toBe(false);
    }).toPass();
  });

  test('the embedded editor hides the certificate control when the flag is off', async ({
    page,
  }) => {
    await openEmbeddedEnvelopeEditor(page, {
      envelopeType: 'DOCUMENT',
      mode: 'edit',
      tokenNamePrefix: 'e2e-embed-no-certificate',
      features: {
        ...DEFAULT_EMBEDDED_EDITOR_CONFIG,
        settings: {
          ...DEFAULT_EMBEDDED_EDITOR_CONFIG.settings,
          allowConfigureSigningCertificate: false,
        },
      },
    });

    await getEnvelopeEditorSettingsTrigger(page).click();
    await expect(page.getByRole('heading', { name: 'Document Settings' })).toBeVisible();

    await expect(page.getByTestId('envelope-include-signing-certificate-trigger')).toHaveCount(0);
  });

  test('team can toggle signing certificate setting', async ({ page }) => {
    const { owner, team } = await seedTeam();

    await apiSignin({
      page,
      email: owner.email,
      redirectPath: `/t/${team.url}/settings/document`,
    });

    await page
      .getByRole('group')
      .locator('div')
      .filter({ hasText: 'Include the Signing' })
      .getByRole('combobox')
      .click();
    await page.getByRole('option', { name: 'No' }).click();

    await page
      .getByRole('button', { name: /Update/ })
      .first()
      .click();

    await page.waitForTimeout(1000);

    // Verify the setting was saved
    const updatedTeam = await prisma.team.findFirstOrThrow({
      where: { id: team.id },
      include: { teamGlobalSettings: true },
    });

    expect(updatedTeam.teamGlobalSettings?.includeSigningCertificate).toBe(false);

    // Toggle the setting back to true
    await page
      .getByRole('group')
      .locator('div')
      .filter({ hasText: 'Include the Signing' })
      .getByRole('combobox')
      .click();
    await page.getByRole('option', { name: 'Yes' }).click();
    await page
      .getByRole('button', { name: /Update/ })
      .first()
      .click();

    await page.waitForTimeout(1000);

    // Verify the setting was saved
    const updatedTeam2 = await prisma.team.findFirstOrThrow({
      where: { id: team.id },
      include: { teamGlobalSettings: true },
    });

    expect(updatedTeam2.teamGlobalSettings?.includeSigningCertificate).toBe(true);
  });
});
