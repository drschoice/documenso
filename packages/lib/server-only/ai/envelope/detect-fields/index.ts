import { createCanvas, loadImage } from '@napi-rs/canvas';
import { DocumentStatus, type Field, RecipientRole } from '@prisma/client';
import { generateObject } from 'ai';
import pMap from 'p-map';

import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../../errors/app-error';
import { getFileServerSide } from '../../../../universal/upload/get-file.server';
import { resizeImageToGeminiImage } from '../../../../utils/images/resize-image-to-gemini-image';
import { logger } from '../../../../utils/logger';
import { getEnvelopeById } from '../../../envelope/get-envelope-by-id';
import { createEnvelopeRecipients } from '../../../recipient/create-envelope-recipients';
import { vertex } from '../../google';
import { pdfToImages } from '../../pdf-to-images';
import {
  buildRecipientContextMessage,
  normalizeDetectedField,
  resolveRecipientFromKey,
} from './helpers';
import { SYSTEM_PROMPT } from './prompt';
import { ZSubmitDetectedFieldsInputSchema } from './schema';
import type {
  NormalizedFieldWithContext,
  NormalizedFieldWithPage,
  RecipientContext,
} from './types';

export type DetectFieldsFromEnvelopeOptions = {
  context?: string;
  envelopeId: string;
  userId: number;
  teamId: number;
  excludeEnvelopeItemIds?: string[];
  onProgress?: (progress: DetectFieldsProgress) => void;
};

export const detectFieldsFromEnvelope = async ({
  context,
  envelopeId,
  userId,
  teamId,
  excludeEnvelopeItemIds,
  onProgress,
}: DetectFieldsFromEnvelopeOptions) => {
  const envelope = await getEnvelopeById({
    id: {
      type: 'envelopeId',
      id: envelopeId,
    },
    userId,
    teamId,
    type: null,
  });

  if (envelope.status !== DocumentStatus.DRAFT) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Cannot detect fields for a non-draft envelope',
    });
  }

  // Extract recipients for field assignment context
  const recipients: RecipientContext[] = envelope.recipients.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
  }));

  const allFields: NormalizedFieldWithContext[] = [];
  const excluded = new Set(excludeEnvelopeItemIds ?? []);

  for (const item of envelope.envelopeItems) {
    if (excluded.has(item.id)) {
      continue;
    }
    const existingFields = await prisma.field.findMany({
      where: {
        envelopeItemId: item.id,
      },
    });

    const pdfBytes = await getFileServerSide(item.documentData);
    const fields = await detectFieldsFromPdf({
      pdfBytes,
      existingFields,
      recipients,
      context,
      onProgress,
    });

    // Resolve recipientKey to actual recipient and add context
    const fieldsWithContext = await Promise.all(
      fields.map(async (field) => {
        const { recipientKey, ...fieldWithoutKey } = field;

        let resolvedRecipient = resolveRecipientFromKey(recipientKey, recipients);

        // If no recipients exist, create a blank recipient
        if (!resolvedRecipient) {
          const { recipients: createdRecipients } = await createEnvelopeRecipients({
            id: {
              id: envelope.id,
              type: 'envelopeId',
            },
            recipients: [
              {
                name: '',
                email: '',
                role: RecipientRole.SIGNER,
              },
            ],
            userId,
            teamId,
          });

          resolvedRecipient = createdRecipients[0];
        }

        return {
          ...fieldWithoutKey,
          envelopeItemId: item.id,
          recipientId: resolvedRecipient.id,
        };
      }),
    );

    allFields.push(...fieldsWithContext);
  }

  return allFields;
};

export type DetectFieldsProgress = {
  pagesProcessed: number;
  totalPages: number;
  fieldsDetected: number;
};

export type DetectFieldsFromPdfOptions = {
  pdfBytes: Uint8Array;
  recipients?: RecipientContext[];
  existingFields?: Field[];
  context?: string;
  onProgress?: (progress: DetectFieldsProgress) => void;
};

export const detectFieldsFromPdf = async ({
  pdfBytes,
  recipients = [],
  existingFields = [],
  context,
  onProgress,
}: DetectFieldsFromPdfOptions) => {
  const pageImages = await pdfToImages(pdfBytes);

  if (pageImages.length === 0) {
    return [];
  }

  let pagesProcessed = 0;
  let totalFieldsDetected = 0;

  const results = await pMap(
    pageImages,
    async (page) => {
      // Get existing fields for this page
      const fieldsOnPage = existingFields.filter((f) => f.page === page.pageNumber);

      let normalizedFields: NormalizedFieldWithPage[] = [];

      // Isolate failures per page: a single page that fails (even after retries)
      // must not abort detection for the rest of the document.
      try {
        // Mask existing fields on the image
        const maskedImage = await maskFieldsOnImage({
          image: page.image,
          width: page.width,
          height: page.height,
          fields: fieldsOnPage,
        });

        const rawFields = await detectFieldsFromPage({
          image: maskedImage,
          pageNumber: page.pageNumber,
          recipients,
          context,
        });

        // Convert bounding boxes to normalized positions and add page number
        normalizedFields = rawFields.map(
          (field): NormalizedFieldWithPage => ({
            ...normalizeDetectedField(field),
            pageNumber: page.pageNumber,
          }),
        );
      } catch (error) {
        logger.error(
          { err: error, pageNumber: page.pageNumber },
          '[ai-detect-fields] page failed, skipping',
        );
      }

      // Update progress (always advances, even for a skipped page)
      pagesProcessed += 1;
      totalFieldsDetected += normalizedFields.length;

      onProgress?.({
        pagesProcessed,
        totalPages: pageImages.length,
        fieldsDetected: totalFieldsDetected,
      });

      return normalizedFields;
    },
    { concurrency: 5 },
  );

  return results.flat();
};

type MaskFieldsOnImageOptions = {
  image: Buffer;
  width: number;
  height: number;
  fields: Field[];
};

/**
 * Draw black rectangles over existing fields to prevent re-detection.
 */
const maskFieldsOnImage = async ({ image, width, height, fields }: MaskFieldsOnImageOptions) => {
  if (fields.length === 0) {
    return image;
  }

  const img = await loadImage(image);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Draw the original image
  ctx.drawImage(img, 0, 0, width, height);

  // Draw black rectangles over existing fields
  ctx.fillStyle = '#000000';

  for (const field of fields) {
    // field positions and width,height are on a 0-100 percentage scale
    const x = (field.positionX.toNumber() / 100) * width;
    const y = (field.positionY.toNumber() / 100) * height;
    const w = (field.width.toNumber() / 100) * width;
    const h = (field.height.toNumber() / 100) * height;

    ctx.fillRect(x, y, w, h);
  }

  return canvas.encode('jpeg');
};

/** Max number of AI attempts per page before the page is skipped. */
const MAX_PAGE_DETECTION_ATTEMPTS = 3;

type DetectFieldsFromPageOptions = {
  image: Buffer;
  pageNumber: number;
  recipients: RecipientContext[];
  context?: string;
};

const detectFieldsFromPage = async ({
  image,
  pageNumber,
  recipients,
  context,
}: DetectFieldsFromPageOptions) => {
  // Resize to 1000x1000 for consistent coordinate mapping
  const resizedImage = await resizeImageToGeminiImage({ image });

  // Build messages array
  const messages: Parameters<typeof generateObject>[0]['messages'] = [
    {
      role: 'user',
      content: buildRecipientContextMessage(recipients),
    },
  ];

  // Add user-provided context if available
  if (context?.trim()) {
    messages.push({
      role: 'user',
      content: `Additional context about recipients:\n${context.trim()}`,
    });
  }

  // Add the page analysis request with image
  messages.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Analyze this document page (page ${pageNumber}) and detect all empty fillable fields. Submit the fields using the tool. Remember: only detect EMPTY fields, exclude labels from bounding boxes, use 0-1000 normalized coordinates, and IGNORE any solid black rectangles (those are existing fields).`,
      },
      {
        type: 'image',
        image: resizedImage,
      },
    ],
  });

  // The model occasionally returns output that fails schema validation (e.g. a
  // malformed box2d), which makes generateObject throw. Retry a few times since
  // the call is non-deterministic before giving up on this page.
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_PAGE_DETECTION_ATTEMPTS; attempt++) {
    try {
      const result = await generateObject({
        model: vertex('gemini-3-flash-preview'),
        system: SYSTEM_PROMPT,
        schema: ZSubmitDetectedFieldsInputSchema,
        messages,
        temperature: 0.5,
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingLevel: 'low',
            },
          },
        },
      });

      logger.debug({ pageNumber, usage: result.usage }, '[ai-detect-fields] page usage');

      return result.object?.fields ?? [];
    } catch (error) {
      lastError = error;
      logger.warn(
        { err: error, pageNumber, attempt, maxAttempts: MAX_PAGE_DETECTION_ATTEMPTS },
        '[ai-detect-fields] page attempt failed',
      );
    }
  }

  // All attempts failed — surface to the per-page handler, which skips this page.
  throw lastError;
};
