import { DocumentStatus, RecipientRole } from '@prisma/client';
import { z } from 'zod';

import { ZTemplateFieldFillValueSchema } from '@documenso/lib/types/template-field-fill';

import type { TrpcRouteMeta } from '../trpc';
import { ZUseEnvelopePayloadSchema } from './use-envelope.types';

export const useAndCompleteEnvelopeMeta: TrpcRouteMeta = {
  openapi: {
    method: 'POST',
    path: '/envelope/use-and-complete',
    summary: 'Use envelope and complete',
    description:
      'Create a document envelope from a template envelope with every field filled and signed, including signature, name, initials, email and date fields. Sealing is queued asynchronously and no emails are sent. Poll GET /envelope/{envelopeId} until the status is COMPLETED, then download the signed PDFs via GET /envelope/item/{envelopeItemId}/download?version=signed. Recipients not listed in the request keep the placeholder name and email defined on the template.',
    tags: ['Envelope'],
  },
};

export const ZUseAndCompleteEnvelopeRequestSchema = ZUseEnvelopePayloadSchema.omit({
  distributeDocument: true,
  prefillFields: true,
  customDocumentData: true,
}).extend({
  fieldValues: z
    .array(ZTemplateFieldFillValueSchema)
    .describe(
      'The values to fill the template fields with, keyed by template field ID. All field types are supported, including signature, name, initials, email and date fields. Fields without an explicit value fall back to derived defaults (recipient name/email/initials, current date, field meta default values). Signature fields always require an explicit value, which is inserted as a typed signature.',
    )
    .optional(),
});

export const ZUseAndCompleteEnvelopeResponseSchema = z.object({
  id: z.string().describe('The ID of the created envelope.'),
  status: z
    .nativeEnum(DocumentStatus)
    .describe(
      'The status of the created envelope. Poll GET /envelope/{envelopeId} until it is COMPLETED.',
    ),
  envelopeItems: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
      }),
    )
    .describe(
      'The envelope items of the created envelope. Once completed, download the signed PDFs via GET /envelope/item/{envelopeItemId}/download?version=signed.',
    ),
  recipients: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      email: z.string(),
      role: z.nativeEnum(RecipientRole),
    }),
  ),
});

export type TUseAndCompleteEnvelopeRequest = z.infer<typeof ZUseAndCompleteEnvelopeRequestSchema>;
export type TUseAndCompleteEnvelopeResponse = z.infer<typeof ZUseAndCompleteEnvelopeResponseSchema>;
