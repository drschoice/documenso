import { FieldType } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TFieldName } from '@documenso/lib/types/field';
import { getFieldNamePart } from '@documenso/lib/types/field-meta';
import type { RecipientNameParts } from '@documenso/lib/utils/recipient-formatter';
import { resolveRecipientNamePart } from '@documenso/lib/utils/recipient-formatter';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';

type HandleNameFieldClickOptions = {
  field: TFieldName;
  name: string | null;
  recipient?: (Partial<RecipientNameParts> & { name?: string | null }) | null;
};

export const handleNameFieldClick = (
  options: HandleNameFieldClickOptions,
): Extract<TSignEnvelopeFieldValue, { type: typeof FieldType.NAME }> | null => {
  const { field, name, recipient } = options;

  if (field.type !== FieldType.NAME) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Invalid field type',
    });
  }

  if (field.inserted) {
    return {
      type: FieldType.NAME,
      value: null,
    };
  }

  const namePart = getFieldNamePart(field.fieldMeta);

  const nameToInsert = resolveRecipientNamePart(namePart, {
    recipient,
    fullName: name,
  });

  // The signing page types an unknown name in place rather than asking for it here.
  if (!nameToInsert) {
    return null;
  }

  return {
    type: FieldType.NAME,
    value: nameToInsert,
  };
};
