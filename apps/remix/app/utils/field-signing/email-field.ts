import { FieldType } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TFieldEmail } from '@documenso/lib/types/field';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';

type HandleEmailFieldClickOptions = {
  field: TFieldEmail;
  email: string | null;
};

export const handleEmailFieldClick = (
  options: HandleEmailFieldClickOptions,
): Extract<TSignEnvelopeFieldValue, { type: typeof FieldType.EMAIL }> | null => {
  const { field, email } = options;

  if (field.type !== FieldType.EMAIL) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Invalid field type',
    });
  }

  if (field.inserted) {
    return {
      type: FieldType.EMAIL,
      value: null,
    };
  }

  // The signing page types an unknown email in place rather than asking for it here.
  if (!email) {
    return null;
  }

  return {
    type: FieldType.EMAIL,
    value: email,
  };
};
