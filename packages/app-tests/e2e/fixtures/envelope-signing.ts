import { type Page, expect } from '@playwright/test';
import {
  DocumentDataType,
  DocumentSource,
  DocumentStatus,
  EnvelopeType,
  type FieldType,
  Prisma,
  ReadStatus,
  RecipientRole,
  SendStatus,
  SigningStatus,
} from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { incrementDocumentId } from '@documenso/lib/server-only/envelope/increment-id';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import { prefixedId } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';

const WEBAPP = NEXT_PUBLIC_WEBAPP_URL();

const EXAMPLE_PDF_PATH = path.join(__dirname, '../../../../assets/example.pdf');

export type TSeedV2FieldInput = {
  type: FieldType;
  /** Defaults to the first recipient. */
  recipientIndex?: number;
  page?: number;
  positionX?: number;
  positionY?: number;
  width?: number;
  height?: number;
  customText?: string;
  inserted?: boolean;
  fieldMeta?: TFieldMetaSchema;
};

export type TSeedV2RecipientInput = {
  email: string;
  name?: string;
  role?: RecipientRole;
  signingOrder?: number;
  /**
   * The split name columns (`e77aacc48`). A NAME field bound to a part resolves
   * against these rather than against `name`, so a spec covering `namePart` has to
   * be able to seed them independently of the derived full name.
   */
  firstName?: string;
  middleName?: string;
  lastName?: string;
};

/**
 * Seed a PENDING `internalVersion: 2` envelope directly through Prisma.
 *
 * Every signing spec in the repo seeds `internalVersion: 1`, which routes to the
 * legacy DOM signer (`sign.$token+/_index.tsx` branches on the version). Most of
 * this fork's signing behaviour - conditional visibility, copy-and-link fan-out,
 * name parts, comb cells, the date picker, greyed-out fields for other signers -
 * only exists on the v2 Konva signer, so it needs an envelope seeded this way.
 *
 * Fields are written raw so that exotic `fieldMeta` (visibility blocks,
 * `linkGroupId`, `namePart`, `layout: 'cells'`) can be set without going through
 * the editor UI.
 */
export const seedV2PendingEnvelope = async ({
  ownerUserId,
  teamId,
  title = '[TEST] v2 signing envelope',
  recipients,
  fields,
  status = DocumentStatus.PENDING,
  documentMeta: documentMetaInput,
}: {
  ownerUserId: number;
  teamId: number;
  title?: string;
  recipients: TSeedV2RecipientInput[];
  fields: TSeedV2FieldInput[];
  status?: DocumentStatus;
  /**
   * Written straight onto the envelope's `DocumentMeta`.
   *
   * Several fork behaviours are driven entirely from here rather than from the
   * fields - the signing timezone and date format the DATE renderer formats
   * against, the `nextFieldNavigation*` completion filter, the signature font -
   * so a spec has to be able to seed them.
   */
  documentMeta?: Prisma.DocumentMetaCreateInput;
}) => {
  const pdf = fs.readFileSync(EXAMPLE_PDF_PATH).toString('base64');

  const documentData = await prisma.documentData.create({
    data: { type: DocumentDataType.BYTES_64, data: pdf, initialData: pdf },
  });

  const documentMeta = await prisma.documentMeta.create({ data: documentMetaInput ?? {} });
  const documentId = await incrementDocumentId();

  const envelope = await prisma.envelope.create({
    data: {
      id: prefixedId('envelope'),
      secondaryId: documentId.formattedDocumentId,
      internalVersion: 2,
      type: EnvelopeType.DOCUMENT,
      documentMetaId: documentMeta.id,
      source: DocumentSource.DOCUMENT,
      teamId,
      title,
      status,
      userId: ownerUserId,
      envelopeItems: {
        create: {
          id: prefixedId('envelope_item'),
          title,
          documentDataId: documentData.id,
          order: 1,
        },
      },
    },
    include: { envelopeItems: true },
  });

  const envelopeItem = envelope.envelopeItems[0];

  const createdRecipients = [];

  for (const [index, recipient] of recipients.entries()) {
    createdRecipients.push(
      await prisma.recipient.create({
        data: {
          email: recipient.email,
          name: recipient.name ?? `Signer ${index + 1}`,
          token: prefixedId('token'),
          role: recipient.role ?? RecipientRole.SIGNER,
          firstName: recipient.firstName,
          middleName: recipient.middleName,
          lastName: recipient.lastName,
          signingOrder: recipient.signingOrder ?? index + 1,
          readStatus: ReadStatus.OPENED,
          sendStatus: SendStatus.SENT,
          signingStatus: SigningStatus.NOT_SIGNED,
          envelopeId: envelope.id,
        },
      }),
    );
  }

  const createdFields = [];

  for (const [index, field] of fields.entries()) {
    createdFields.push(
      await prisma.field.create({
        data: {
          page: field.page ?? 1,
          type: field.type,
          inserted: field.inserted ?? false,
          customText: field.customText ?? '',
          positionX: new Prisma.Decimal(field.positionX ?? 10),
          positionY: new Prisma.Decimal(field.positionY ?? 10 + index * 10),
          width: new Prisma.Decimal(field.width ?? 20),
          height: new Prisma.Decimal(field.height ?? 8),
          envelopeId: envelope.id,
          envelopeItemId: envelopeItem.id,
          recipientId: createdRecipients[field.recipientIndex ?? 0].id,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
          fieldMeta: (field.fieldMeta ?? undefined) as any,
        },
      }),
    );
  }

  return {
    envelope,
    envelopeItem,
    documentMeta,
    // The public signing routes are still addressed by the legacy numeric
    // document id, not the envelope id.
    documentId: documentId.documentId,
    recipients: createdRecipients,
    fields: createdFields,
  };
};

export const getSigningUrl = (token: string) => `${WEBAPP}/sign/${token}`;

/**
 * Open the signing page and wait for the Konva stage to finish rendering.
 */
export const openV2SigningPage = async (page: Page, token: string) => {
  await page.goto(getSigningUrl(token));
  await page
    .locator('.konva-container canvas')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
};

/**
 * Click a field on the v2 signing canvas.
 *
 * `#field-<id>` only exists on the legacy DOM signer. On v2 the field is a Konva
 * node painted into the page canvas, so its stage-space rect has to be
 * translated into viewport coordinates before the mouse can reach it.
 */
export const clickV2SigningField = async (page: Page, fieldId: number, pageNumber = 1) => {
  const point = await page.evaluate(
    ({ fieldId, pageNumber }) => {
      const konva = (
        window as unknown as {
          Konva: {
            stages: Array<{
              attrs: { id?: string };
              container: () => HTMLElement;
              find: (selector: string) => Array<{
                id: () => string;
                getClientRect: () => { x: number; y: number; width: number; height: number };
              }>;
            }>;
          };
        }
      ).Konva;

      const stage = konva.stages.find((s) => s.attrs.id === `page-${pageNumber}`);
      const node = stage?.find('.field-group').find((n) => n.id() === String(fieldId));

      if (!stage || !node) {
        return null;
      }

      const container = stage.container().getBoundingClientRect();
      const rect = node.getClientRect();

      return {
        x: container.left + rect.x + rect.width / 2,
        y: container.top + rect.y + rect.height / 2,
      };
    },
    { fieldId, pageNumber },
  );

  if (!point) {
    throw new Error(`Field ${fieldId} is not on the v2 signing canvas for page ${pageNumber}`);
  }

  await page.mouse.click(point.x, point.y);

  return point;
};

/**
 * Click one option of a radio/checkbox field on the v2 signing canvas.
 *
 * `clickV2SigningField` aims at the centre of the field group, which for an
 * option field is the gap between its buttons - the click lands on nothing. The
 * individual buttons are `.field-option-group` nodes inside the field's own
 * group, in the order the options are declared.
 */
export const clickV2SigningFieldOption = async (
  page: Page,
  fieldId: number,
  optionIndex: number,
  pageNumber = 1,
) => {
  const point = await page.evaluate(
    ({ fieldId, optionIndex, pageNumber }) => {
      const konva = (
        window as unknown as {
          Konva: {
            stages: Array<{
              attrs: { id?: string };
              container: () => HTMLElement;
              find: (selector: string) => Array<{
                id: () => string;
                find: (selector: string) => Array<{
                  getClientRect: () => { x: number; y: number; width: number; height: number };
                }>;
                getClientRect: () => { x: number; y: number; width: number; height: number };
              }>;
            }>;
          };
        }
      ).Konva;

      const stage = konva.stages.find((s) => s.attrs.id === `page-${pageNumber}`);
      const field = stage?.find('.field-group').find((n) => n.id() === String(fieldId));
      const option = field?.find('.field-option-group')[optionIndex];

      if (!stage || !option) {
        return null;
      }

      const container = stage.container().getBoundingClientRect();
      const rect = option.getClientRect();

      return {
        x: container.left + rect.x + rect.width / 2,
        y: container.top + rect.y + rect.height / 2,
      };
    },
    { fieldId, optionIndex, pageNumber },
  );

  if (!point) {
    throw new Error(
      `Field ${fieldId} has no option ${optionIndex} on the v2 signing canvas for page ${pageNumber}`,
    );
  }

  await page.mouse.click(point.x, point.y);

  return point;
};

/**
 * Sign a field through the public, token-authed tRPC route.
 *
 * This is the server-side counterpart to clicking the canvas: it exercises the
 * same `envelope.field.sign` handler (and therefore its validation - hidden
 * fields, link fan-out, org-enforced signature modes) without any canvas maths,
 * which makes it the right tool for asserting rejections and for setting up
 * state that a test does not want to click through.
 *
 * Returns the raw tRPC envelope so callers can assert on either `result.data`
 * (including `linkedFields`) or `error`.
 */
export const signV2FieldViaTrpc = async (
  page: Page,
  {
    token,
    fieldId,
    fieldValue,
  }: {
    token: string;
    fieldId: number;
    // Mirrors ZSignEnvelopeFieldValue; kept loose so specs can send invalid
    // payloads deliberately.
    fieldValue: { type: FieldType; value: unknown };
  },
) => {
  const response = await page.request.post(`${WEBAPP}/api/trpc/envelope.field.sign?batch=1`, {
    data: { 0: { json: { token, fieldId, fieldValue } } },
    headers: { 'content-type': 'application/json' },
  });

  const body: unknown = await response.json();

  return { status: response.status(), body: Array.isArray(body) ? body[0] : body };
};

/**
 * Drive the completion dialog: "Complete" -> "Sign", then wait for the
 * confirmation route.
 */
export const completeV2Signing = async (page: Page, token: string) => {
  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();

  await page.waitForURL(`${WEBAPP}/sign/${token}/complete`, { timeout: 30_000 });
};

/**
 * Poll until the envelope reaches COMPLETED.
 *
 * Sealing runs as a background job, so the status lags the signing request by a
 * second or two locally.
 */
export const expectEnvelopeCompleted = async (envelopeId: string) => {
  await expect(async () => {
    const envelope = await prisma.envelope.findFirstOrThrow({ where: { id: envelopeId } });

    expect(envelope.status).toBe(DocumentStatus.COMPLETED);
  }).toPass({ timeout: 30_000 });
};

/**
 * Complete signing through the public, token-authed tRPC route.
 *
 * The counterpart to `completeV2Signing` for cases where the assertion is about
 * what the *server* accepts. The signing UI disables its own Complete button
 * while required fields are outstanding, so a test of which fields the server
 * considers mandatory - the `nextFieldNavigation*` filter, conditional
 * visibility - cannot be written by clicking.
 *
 * Returns the raw tRPC envelope; a rejection surfaces as a non-200 with
 * `error` populated rather than as a throw.
 */
export const completeV2SigningViaTrpc = async (
  page: Page,
  { token, documentId }: { token: string; documentId: number },
) => {
  const response = await page.request.post(
    `${WEBAPP}/api/trpc/recipient.completeDocumentWithToken?batch=1`,
    {
      data: { 0: { json: { token, documentId } } },
      headers: { 'content-type': 'application/json' },
    },
  );

  const body: unknown = await response.json();

  return { status: response.status(), body: Array.isArray(body) ? body[0] : body };
};
