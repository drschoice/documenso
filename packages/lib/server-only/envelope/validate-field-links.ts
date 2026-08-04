import type { FieldType } from '@prisma/client';

import type { TFieldMetaSchema } from '../../types/field-meta';
import { getLinkGroupId } from '../../universal/field-linking';

export type FieldLinkErrorCode = 'FIELD_LINK_CROSS_RECIPIENT' | 'FIELD_LINK_TYPE_MISMATCH';

export type FieldLinkError = {
  fieldId: number;
  code: FieldLinkErrorCode;
  message: string;
};

export type ValidatableLinkField = {
  id: number;
  type: FieldType;
  recipientId: number;
  fieldMeta: unknown;
};

/**
 * Validates copy-and-link groups across a complete envelope field set.
 *
 * A link group (all fields sharing a non-empty `linkGroupId`) must be
 * single-recipient and single-type, so a value fanned out from one member at
 * signing time is always valid for every other member. This is a cross-field
 * structural check only — callers must have already Zod-parsed each field's
 * `fieldMeta` (mirrors validateFieldVisibility).
 */
export const validateFieldLinks = (input: {
  fields: ValidatableLinkField[];
}): { ok: true } | { ok: false; errors: FieldLinkError[] } => {
  const errors: FieldLinkError[] = [];

  const groups = new Map<string, ValidatableLinkField[]>();

  for (const field of input.fields) {
    const groupId = getLinkGroupId(field.fieldMeta as TFieldMetaSchema);

    if (!groupId) {
      continue;
    }

    const members = groups.get(groupId) ?? [];
    members.push(field);
    groups.set(groupId, members);
  }

  for (const members of groups.values()) {
    const [first, ...rest] = members;

    for (const member of rest) {
      if (member.recipientId !== first.recipientId) {
        errors.push({
          fieldId: member.id,
          code: 'FIELD_LINK_CROSS_RECIPIENT',
          message: 'Linked fields must all belong to the same recipient.',
        });
      }

      if (member.type !== first.type) {
        errors.push({
          fieldId: member.id,
          code: 'FIELD_LINK_TYPE_MISMATCH',
          message: 'Linked fields must all be the same field type.',
        });
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
};
