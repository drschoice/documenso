import { FieldType } from '@prisma/client';

import type { TFieldMetaSchema } from '../../types/field-meta';
import { getLinkGroupId } from '../field-linking/authoring';

type SignableField = {
  id: number;
  type: FieldType;
  recipientId: number;
  fieldMeta?: TFieldMetaSchema | null;
};

/**
 * The fields one sign request writes, so the signing page can show the result
 * before the server confirms it.
 *
 * Mirrors `sign-envelope-field.ts`: the signed field itself, plus - for a
 * TEXT/NUMBER field in a copy-and-link group - every other editable member of
 * that group that belongs to the same recipient. Read-only members are locked
 * pre-fills and are never overwritten.
 */
export const getFieldsWrittenBySign = <T extends SignableField>(fields: T[], field: T): T[] => {
  const linkGroupId =
    field.type === FieldType.TEXT || field.type === FieldType.NUMBER
      ? getLinkGroupId(field.fieldMeta ?? undefined)
      : null;

  if (!linkGroupId) {
    return [field];
  }

  const members = fields.filter(
    (member) =>
      member.id !== field.id &&
      member.recipientId === field.recipientId &&
      (member.type === FieldType.TEXT || member.type === FieldType.NUMBER) &&
      getLinkGroupId(member.fieldMeta ?? undefined) === linkGroupId &&
      !(member.fieldMeta as { readOnly?: boolean } | null | undefined)?.readOnly,
  );

  return [field, ...members];
};
