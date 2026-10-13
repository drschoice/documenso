import { FieldType } from '@prisma/client';

import type { TFieldMetaSchema } from '../../types/field-meta';
import { getCombFieldCells } from '../../types/field-meta';

/**
 * How a field is filled in place on the v2 signing page, instead of through a
 * dialog.
 *
 * - `text`: a text box typed straight over the field.
 * - `comb`: characters typed into the field's own character cells, one per cell.
 * - `date`: a date typed over the field, with a calendar under it to pick one instead.
 * - `dropdown`: the field's options listed under it, filtered by what is typed over it.
 */
export type TInlineEditKind = 'text' | 'comb' | 'date' | 'dropdown';

type InlineEditableField = {
  type: FieldType;
  fieldMeta?: TFieldMetaSchema | null;
};

/**
 * Returns how a field can be filled in place, or null when it still needs its
 * click handler (a dialog, a toggle, or a value the signer does not type).
 *
 * NAME, EMAIL and INITIALS can be typed in place, but the signing page only
 * does so when it has no value to fill them with: a known name or email is
 * still inserted with a single click.
 */
export const getInlineEditKind = (field: InlineEditableField): TInlineEditKind | null => {
  switch (field.type) {
    case FieldType.TEXT:
    case FieldType.NUMBER:
      return getCombFieldCells(field.fieldMeta) ? 'comb' : 'text';

    case FieldType.NAME:
    case FieldType.EMAIL:
    case FieldType.INITIALS:
      return 'text';

    case FieldType.DATE:
      return 'date';

    case FieldType.DROPDOWN:
      return 'dropdown';

    default:
      return null;
  }
};
