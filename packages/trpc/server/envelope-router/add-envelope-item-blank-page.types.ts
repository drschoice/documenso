import { z } from 'zod';

import EnvelopeItemSchema from '@documenso/prisma/generated/zod/modelSchema/EnvelopeItemSchema';

export const ZAddEnvelopeItemBlankPageRequestSchema = z.object({
  envelopeId: z.string(),
  envelopeItemId: z.string(),
});

export const ZAddEnvelopeItemBlankPageResponseSchema = z.object({
  data: EnvelopeItemSchema.pick({
    id: true,
    title: true,
    envelopeId: true,
    order: true,
    documentDataId: true,
  }),
  pageCount: z.number(),
});

export type TAddEnvelopeItemBlankPageRequest = z.infer<
  typeof ZAddEnvelopeItemBlankPageRequestSchema
>;
export type TAddEnvelopeItemBlankPageResponse = z.infer<
  typeof ZAddEnvelopeItemBlankPageResponseSchema
>;
