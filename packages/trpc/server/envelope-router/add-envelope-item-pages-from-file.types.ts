import { z } from 'zod';
import { zfd } from 'zod-form-data';

import EnvelopeItemSchema from '@documenso/prisma/generated/zod/modelSchema/EnvelopeItemSchema';

import { zfdFile, zodFormData } from '../../utils/zod-form-data';

export const ZAddEnvelopeItemPagesFromFilePayloadSchema = z.object({
  envelopeId: z.string(),
  envelopeItemId: z.string(),
});

export const ZAddEnvelopeItemPagesFromFileRequestSchema = zodFormData({
  payload: zfd.json(ZAddEnvelopeItemPagesFromFilePayloadSchema),
  file: zfdFile(),
});

export const ZAddEnvelopeItemPagesFromFileResponseSchema = z.object({
  data: EnvelopeItemSchema.pick({
    id: true,
    title: true,
    envelopeId: true,
    order: true,
    documentDataId: true,
  }),
  pageCount: z.number(),
});

export type TAddEnvelopeItemPagesFromFilePayload = z.infer<
  typeof ZAddEnvelopeItemPagesFromFilePayloadSchema
>;
export type TAddEnvelopeItemPagesFromFileRequest = z.infer<
  typeof ZAddEnvelopeItemPagesFromFileRequestSchema
>;
export type TAddEnvelopeItemPagesFromFileResponse = z.infer<
  typeof ZAddEnvelopeItemPagesFromFileResponseSchema
>;
