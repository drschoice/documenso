import { FieldType } from '@prisma/client';
import z from 'zod';

import { FIELD_MAX_CELL_COUNT, FIELD_MIN_CELL_COUNT } from '../../../../types/field-meta';

export const DETECTABLE_FIELD_TYPES = [
  FieldType.SIGNATURE,
  FieldType.INITIALS,
  FieldType.NAME,
  FieldType.EMAIL,
  FieldType.DATE,
  FieldType.TEXT,
  FieldType.NUMBER,
  FieldType.RADIO,
  FieldType.CHECKBOX,
] as const;

export const ZDetectableFieldType = z.enum(DETECTABLE_FIELD_TYPES);

export const ZConfidenceLevel = z.enum(['low', 'medium-low', 'medium', 'medium-high', 'high']);

export type TConfidenceLevel = z.infer<typeof ZConfidenceLevel>;

/**
 * Schema for a detected field's bounding box.
 * All values are normalized to a 0-1000 scale relative to the page dimensions.
 */
const ZBox2DSchema = z.array(z.number().min(0).max(1000)).length(4);

/**
 * Schema for a detected field.
 */
export const ZDetectedFieldSchema = z.object({
  type: ZDetectableFieldType.describe(
    `The field type based on nearby labels and visual appearance`,
  ),
  label: z
    .string()
    .describe(
      'For CHECKBOX and RADIO fields: the plain-language topic/question of the WHOLE group — NOT an individual option and NOT a question number (e.g., "Gender", "Heart Disease History", "Marital Status", "Do you smoke?"). The individual option texts go in the "options" array, not here. For all other fields: the form label printed near the field (e.g., "Social Security Number", "Date of Birth", "First Name", "Phone Number"). 3-8 words.',
    ),
  recipientKey: z
    .string()
    .describe(
      'Recipient identifier from nearby labels (e.g., "Tenant", "Landlord", "Buyer", "Seller"). Empty string if no recipient indicated.',
    ),
  box2d: ZBox2DSchema.describe(
    'Box2D [yMin, xMin, yMax, xMax] coordinates of the FILLABLE AREA only (exclude labels). For a CHECKBOX/RADIO group with an "options" array, this is the bounding box enclosing ALL of the group\'s buttons.',
  ),
  options: z
    .array(
      z.object({
        value: z
          .string()
          .describe('The text/value of this single option (e.g., "Male", "Female", "Yes", "No").'),
        box2d: ZBox2DSchema.describe(
          "Box2D of THIS option's checkbox square or radio circle ONLY — exclude the option's printed label text.",
        ),
      }),
    )
    .optional()
    .describe(
      'RADIO and CHECKBOX ONLY. One entry per selectable option in the group. Report the whole group as a SINGLE field and list every option here, each with its own button box. Omit entirely for all non-option field types.',
    ),
  layout: z
    .enum(['box', 'cells'])
    .optional()
    .describe(
      'Set to "cells" ONLY for a TEXT or NUMBER field that appears as a comb/character grid (a row of individual boxes, one per character — e.g. SSN, phone, ZIP, account number). Omit (single box) for every other field and type.',
    ),
  cellCount: z
    .number()
    .int()
    .min(FIELD_MIN_CELL_COUNT)
    .max(FIELD_MAX_CELL_COUNT)
    .optional()
    .describe(
      'When layout is "cells", the exact number of character boxes in the grid. Count the individual cells only; do NOT count separator dashes, slashes, or spaces. Omit when layout is not "cells".',
    ),
  confidence: ZConfidenceLevel.describe('The confidence in the detection'),
});

export type DetectedField = z.infer<typeof ZDetectedFieldSchema>;

export const ZSubmitDetectedFieldsInputSchema = z.object({
  fields: z
    .array(ZDetectedFieldSchema)
    .describe('List of detected EMPTY fillable fields. Exclude pre-filled content and label text.'),
});

export type SubmitDetectedFieldsInput = z.infer<typeof ZSubmitDetectedFieldsInputSchema>;
