import { z } from 'zod';

import { ZEnvelopeFieldSchema } from '@documenso/lib/types/field';
import EnvelopeItemSchema from '@documenso/prisma/generated/zod/modelSchema/EnvelopeItemSchema';

export const ZDeleteEnvelopeItemPageRequestSchema = z.object({
  envelopeId: z.string(),
  envelopeItemId: z.string(),
  pageNumber: z.number().int().min(1),
});

export const ZDeleteEnvelopeItemPageResponseSchema = z.object({
  data: EnvelopeItemSchema.pick({
    id: true,
    title: true,
    envelopeId: true,
    order: true,
    documentDataId: true,
  }),
  /**
   * The full list of fields for the envelope after the page deletion.
   *
   * Only populated if fields were removed or renumbered. Undefined otherwise.
   */
  fields: ZEnvelopeFieldSchema.array().optional(),
});

export type TDeleteEnvelopeItemPageRequest = z.infer<typeof ZDeleteEnvelopeItemPageRequestSchema>;
export type TDeleteEnvelopeItemPageResponse = z.infer<typeof ZDeleteEnvelopeItemPageResponseSchema>;
