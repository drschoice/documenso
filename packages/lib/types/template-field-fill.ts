import { z } from 'zod';

/**
 * The values used to fill a template field when creating a completed document
 * from a template.
 *
 * Unlike `ZFieldMetaPrefillFieldsSchema`, this covers every field type,
 * including the ones normally left for recipients to action (signature, name,
 * initials, email, date).
 */
export const ZTemplateFieldFillValueSchema = z
  .object({
    id: z.number().describe('The ID of the field in the template.'),
  })
  .and(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('signature'),
        value: z
          .string()
          .min(1)
          .describe("The typed signature text, usually the signer's full name."),
      }),
      z.object({
        type: z.literal('name'),
        value: z
          .string()
          .min(1)
          .optional()
          .describe("Defaults to the recipient's name when omitted."),
      }),
      z.object({
        type: z.literal('initials'),
        value: z
          .string()
          .min(1)
          .optional()
          .describe("Defaults to the initials of the recipient's name when omitted."),
      }),
      z.object({
        type: z.literal('email'),
        value: z
          .string()
          .email()
          .optional()
          .describe("Defaults to the recipient's email when omitted."),
      }),
      z.object({
        type: z.literal('date'),
        value: z
          .string()
          .optional()
          .describe(
            'An ISO 8601 datetime. Defaults to the current time when omitted. Rendered using the document date format and timezone.',
          ),
      }),
      z.object({
        type: z.literal('text'),
        value: z.string(),
      }),
      z.object({
        type: z.literal('number'),
        value: z.string(),
      }),
      z.object({
        type: z.literal('radio'),
        value: z.string().describe('The value of the option to select, not the index.'),
      }),
      z.object({
        type: z.literal('checkbox'),
        value: z
          .array(z.string())
          .min(1)
          .describe('The values of the options to check, not the indices.'),
      }),
      z.object({
        type: z.literal('dropdown'),
        value: z.string(),
      }),
    ]),
  );

export type TTemplateFieldFillValue = z.infer<typeof ZTemplateFieldFillValueSchema>;
