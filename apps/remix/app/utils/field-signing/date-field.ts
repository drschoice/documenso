import { FieldType } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TFieldDate } from '@documenso/lib/types/field';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';

import { SignFieldDateDialog } from '~/components/dialogs/sign-field-date-dialog';

type HandleDateFieldClickOptions = {
  field: TFieldDate;
};

export const handleDateFieldClick = async (
  options: HandleDateFieldClickOptions,
): Promise<Extract<TSignEnvelopeFieldValue, { type: typeof FieldType.DATE }> | null> => {
  const { field } = options;

  if (field.type !== FieldType.DATE) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Invalid field type',
    });
  }

  if (field.inserted) {
    return {
      type: FieldType.DATE,
      value: null,
    };
  }

  const selectedDate = await SignFieldDateDialog.call({
    fieldMeta: field.fieldMeta,
  });

  if (!selectedDate) {
    return null;
  }

  return {
    type: FieldType.DATE,
    value: selectedDate,
  };
};
