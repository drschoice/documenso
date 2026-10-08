import { FieldType } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TFieldInitials } from '@documenso/lib/types/field';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';

type HandleInitialsFieldClickOptions = {
  field: TFieldInitials;
  initials: string | null;
};

export const handleInitialsFieldClick = (
  options: HandleInitialsFieldClickOptions,
): Extract<TSignEnvelopeFieldValue, { type: typeof FieldType.INITIALS }> | null => {
  const { field, initials } = options;

  if (field.type !== FieldType.INITIALS) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Invalid field type',
    });
  }

  if (field.inserted) {
    return {
      type: FieldType.INITIALS,
      value: null,
    };
  }

  // The signing page types unknown initials in place rather than asking for them here.
  if (!initials) {
    return null;
  }

  return {
    type: FieldType.INITIALS,
    value: initials,
  };
};
