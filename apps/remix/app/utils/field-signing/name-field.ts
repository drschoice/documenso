import { FieldType } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TFieldName } from '@documenso/lib/types/field';
import { getFieldNamePart } from '@documenso/lib/types/field-meta';
import type { RecipientNameParts } from '@documenso/lib/utils/recipient-formatter';
import { resolveRecipientNamePart } from '@documenso/lib/utils/recipient-formatter';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';

import { SignFieldNameDialog } from '~/components/dialogs/sign-field-name-dialog';

type HandleNameFieldClickOptions = {
  field: TFieldName;
  name: string | null;
  recipient?: (Partial<RecipientNameParts> & { name?: string | null }) | null;
};

export const handleNameFieldClick = async (
  options: HandleNameFieldClickOptions,
): Promise<Extract<TSignEnvelopeFieldValue, { type: typeof FieldType.NAME }> | null> => {
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

  let nameToInsert: string | null = resolveRecipientNamePart(namePart, {
    recipient,
    fullName: name,
  });

  if (!nameToInsert) {
    nameToInsert = await SignFieldNameDialog.call({
      namePart,
    });
  }

  if (!nameToInsert) {
    return null;
  }

  return {
    type: FieldType.NAME,
    value: nameToInsert,
  };
};
