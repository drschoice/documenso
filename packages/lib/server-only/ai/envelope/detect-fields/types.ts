import type { Recipient } from '@prisma/client';

import type { DETECTABLE_FIELD_TYPES, TConfidenceLevel } from './schema';

export type DetectableFieldType = (typeof DETECTABLE_FIELD_TYPES)[number];

/**
 * Normalized field position using 0-100 percentage scale (matching Field model).
 */
export type NormalizedField = {
  type: DetectableFieldType;
  label: string;
  recipientKey: string;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
  confidence: TConfidenceLevel;
  /** 'cells' marks a TEXT/NUMBER comb field; absent/'box' is a single input box. */
  layout?: 'box' | 'cells';
  /** Number of character cells when layout is 'cells'. */
  cellCount?: number;
  /**
   * CHECKBOX/RADIO groups: one entry per option, with a free-layout offset
   * (page-percent) from the field's top-left. Absent for non-option fields.
   */
  options?: { value: string; offsetX: number; offsetY: number }[];
};

export type RecipientContext = Pick<Recipient, 'id' | 'name' | 'email'>;

export type NormalizedFieldWithPage = NormalizedField & {
  pageNumber: number;
};

export type NormalizedFieldWithContext = Omit<NormalizedField, 'recipientKey'> & {
  pageNumber: number;
  envelopeItemId: string;
  recipientId: number;
};
