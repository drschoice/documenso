import { type APIRequestContext, expect, test } from '@playwright/test';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@documenso/prisma/client';
import { seedBlankTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

/**
 * `POST /api/v2-beta/envelope/use-and-complete` (`ec7be6ca7`).
 *
 * Creates a document from a template with every field already filled and signed,
 * queues sealing, and sends nothing. It is backed by
 * `create-completed-document-from-template.ts`, 739 lines with no test of any
 * kind - not a unit test, not an e2e test - despite being the entry point a
 * scripted integration uses to produce finished documents.
 */

const seedTemplateWithEveryFieldType = async (
  user: Parameters<typeof seedBlankTemplate>[0],
  teamId: number,
) => {
  const template = await seedBlankTemplate(user, teamId, {
    createTemplateOptions: {
      title: 'Use and complete template',
      userId: user.id,
      teamId,
    },
  });

  const envelopeItem = template.envelopeItems[0];

  const recipient = await prisma.recipient.create({
    data: {
      envelopeId: template.id,
      email: 'placeholder@example.com',
      name: 'Placeholder Recipient',
      role: RecipientRole.SIGNER,
      token: `tmpl-${Date.now()}`,
      readStatus: 'NOT_OPENED',
      sendStatus: 'NOT_SENT',
      signingStatus: 'NOT_SIGNED',
    },
  });

  const makeField = async (
    type: FieldType,
    index: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fieldMeta?: any,
  ) =>
    prisma.field.create({
      data: {
        envelopeId: template.id,
        envelopeItemId: envelopeItem.id,
        recipientId: recipient.id,
        type,
        page: 1,
        positionX: 5,
        positionY: 5 + index * 7,
        width: 20,
        height: 5,
        customText: '',
        inserted: false,
        fieldMeta,
      },
    });

  const fields = {
    signature: await makeField(FieldType.SIGNATURE, 0),
    name: await makeField(FieldType.NAME, 1),
    initials: await makeField(FieldType.INITIALS, 2),
    email: await makeField(FieldType.EMAIL, 3),
    date: await makeField(FieldType.DATE, 4),
    text: await makeField(FieldType.TEXT, 5, { type: 'text', label: 'Notes' }),
    number: await makeField(FieldType.NUMBER, 6, { type: 'number', label: 'Amount' }),
    radio: await makeField(FieldType.RADIO, 7, {
      type: 'radio',
      direction: 'vertical',
      values: [
        { id: 1, checked: false, value: 'Yes' },
        { id: 2, checked: false, value: 'No' },
      ],
    }),
    checkbox: await makeField(FieldType.CHECKBOX, 8, {
      type: 'checkbox',
      direction: 'vertical',
      values: [
        { id: 1, checked: false, value: 'Alpha' },
        { id: 2, checked: false, value: 'Beta' },
      ],
    }),
    dropdown: await makeField(FieldType.DROPDOWN, 9, {
      type: 'dropdown',
      values: [{ value: 'Red' }, { value: 'Green' }],
    }),
  };

  return { template, recipient, fields };
};

const useAndComplete = async (
  request: APIRequestContext,
  token: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>,
) =>
  request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/use-and-complete`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data,
  });

test.describe('Envelope use-and-complete API v2', () => {
  test('fills every field type, completes the document and sends nothing', async ({ request }) => {
    const { user, team } = await seedUser();

    const { token } = await createApiToken({
      userId: user.id,
      teamId: team.id,
      tokenName: 'use-and-complete-token',
      expiresIn: null,
    });

    const { template, recipient, fields } = await seedTemplateWithEveryFieldType(user, team.id);

    const response = await useAndComplete(request, token, {
      envelopeId: template.id,
      recipients: [
        { id: recipient.id, email: 'signer@example.com', name: 'Grace Brewster Hopper' },
      ],
      fieldValues: [
        { id: fields.signature.id, type: 'signature', value: 'Grace Brewster Hopper' },
        { id: fields.text.id, type: 'text', value: 'Filled by the API' },
        { id: fields.number.id, type: 'number', value: '4200' },
        { id: fields.radio.id, type: 'radio', value: 'No' },
        { id: fields.checkbox.id, type: 'checkbox', value: ['Beta'] },
        { id: fields.dropdown.id, type: 'dropdown', value: 'Green' },
        // name / initials / email / date are deliberately omitted: the route
        // documents that they fall back to values derived from the recipient
        // and the current date, and nothing has ever checked that they do.
      ],
    });

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.id).toBeTruthy();

    // Sealing is queued, so the response may be PENDING and settle afterwards.
    await expect(async () => {
      const envelope = await prisma.envelope.findFirstOrThrow({ where: { id: body.id } });

      expect(envelope.status).toBe(DocumentStatus.COMPLETED);
    }).toPass({ timeout: 60_000 });

    const createdFields = await prisma.field.findMany({
      where: { envelopeId: body.id },
      include: { signature: true },
    });

    expect(createdFields).toHaveLength(10);

    for (const field of createdFields) {
      expect(field.inserted, `${field.type} should be inserted`).toBe(true);
    }

    const byType = new Map(createdFields.map((field) => [field.type, field]));

    expect(byType.get(FieldType.TEXT)?.customText).toBe('Filled by the API');
    expect(byType.get(FieldType.NUMBER)?.customText).toBe('4200');
    expect(byType.get(FieldType.DROPDOWN)?.customText).toBe('Green');

    // Radio and checkbox are addressed by option VALUE in the request and stored
    // in whatever encoding the signer uses, so assert the option is identifiable
    // rather than pinning the encoding.
    expect(byType.get(FieldType.RADIO)?.customText).toBeTruthy();
    expect(byType.get(FieldType.CHECKBOX)?.customText).toBeTruthy();

    // Derived defaults for the fields left out of the request.
    expect(byType.get(FieldType.NAME)?.customText).toBe('Grace Brewster Hopper');
    expect(byType.get(FieldType.EMAIL)?.customText).toBe('signer@example.com');
    expect(byType.get(FieldType.INITIALS)?.customText).toBeTruthy();
    expect(byType.get(FieldType.DATE)?.customText).toBeTruthy();

    // The typed signature is stored as a Signature row, not as customText.
    expect(byType.get(FieldType.SIGNATURE)?.signature?.typedSignature).toBe(
      'Grace Brewster Hopper',
    );

    const createdRecipients = await prisma.recipient.findMany({ where: { envelopeId: body.id } });

    expect(createdRecipients).toHaveLength(1);
    expect(createdRecipients[0].email).toBe('signer@example.com');
    expect(createdRecipients[0].signingStatus).toBe(SigningStatus.SIGNED);

    // "no emails are sent" is part of the route's contract - this is the whole
    // reason it exists rather than use + distribute + sign.
    const emailsSent = await prisma.documentAuditLog.count({
      where: { envelopeId: body.id, type: 'EMAIL_SENT' },
    });

    expect(emailsSent).toBe(0);
  });

  test('rejects a signature field with no explicit value', async ({ request }) => {
    const { user, team } = await seedUser();

    const { token } = await createApiToken({
      userId: user.id,
      teamId: team.id,
      tokenName: 'use-and-complete-missing-signature',
      expiresIn: null,
    });

    const { template, recipient, fields } = await seedTemplateWithEveryFieldType(user, team.id);

    // Everything except the signature, which has no derivable default: a
    // signature the caller did not supply must never be invented.
    const response = await useAndComplete(request, token, {
      envelopeId: template.id,
      recipients: [{ id: recipient.id, email: 'signer@example.com', name: 'Grace Hopper' }],
      fieldValues: [
        { id: fields.text.id, type: 'text', value: 'Filled by the API' },
        { id: fields.number.id, type: 'number', value: '1' },
        { id: fields.radio.id, type: 'radio', value: 'Yes' },
        { id: fields.checkbox.id, type: 'checkbox', value: ['Alpha'] },
        { id: fields.dropdown.id, type: 'dropdown', value: 'Red' },
      ],
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).toContain(String(fields.signature.id));

    // Nothing was created from the failed attempt.
    const documents = await prisma.envelope.count({
      where: { teamId: team.id, type: 'DOCUMENT' },
    });

    expect(documents).toBe(0);
  });

  test('keeps the template placeholder for a recipient the request omits', async ({ request }) => {
    const { user, team } = await seedUser();

    const { token } = await createApiToken({
      userId: user.id,
      teamId: team.id,
      tokenName: 'use-and-complete-placeholder',
      expiresIn: null,
    });

    const { template, fields } = await seedTemplateWithEveryFieldType(user, team.id);

    const response = await useAndComplete(request, token, {
      envelopeId: template.id,
      // No `recipients` at all - documented to keep the template's placeholders.
      fieldValues: [
        { id: fields.signature.id, type: 'signature', value: 'Placeholder Recipient' },
        { id: fields.text.id, type: 'text', value: 'x' },
        { id: fields.number.id, type: 'number', value: '1' },
        { id: fields.radio.id, type: 'radio', value: 'Yes' },
        { id: fields.checkbox.id, type: 'checkbox', value: ['Alpha'] },
        { id: fields.dropdown.id, type: 'dropdown', value: 'Red' },
      ],
    });

    expect(response.status()).toBe(200);

    const body = await response.json();

    const createdRecipients = await prisma.recipient.findMany({ where: { envelopeId: body.id } });

    expect(createdRecipients).toHaveLength(1);
    expect(createdRecipients[0].email).toBe('placeholder@example.com');
    expect(createdRecipients[0].name).toBe('Placeholder Recipient');

    // The derived NAME/EMAIL defaults follow the placeholder, not the API caller.
    await expect(async () => {
      const envelope = await prisma.envelope.findFirstOrThrow({ where: { id: body.id } });

      expect(envelope.status).toBe(DocumentStatus.COMPLETED);
    }).toPass({ timeout: 60_000 });

    const createdFields = await prisma.field.findMany({ where: { envelopeId: body.id } });
    const byType = new Map(createdFields.map((field) => [field.type, field]));

    expect(byType.get(FieldType.NAME)?.customText).toBe('Placeholder Recipient');
    expect(byType.get(FieldType.EMAIL)?.customText).toBe('placeholder@example.com');
  });
});
