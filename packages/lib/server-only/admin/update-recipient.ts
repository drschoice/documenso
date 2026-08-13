import { type RecipientRole, SigningStatus } from '@prisma/client';

import { resolveRecipientNameOnUpdate } from '@documenso/lib/utils/recipient-formatter';
import { prisma } from '@documenso/prisma';

export type UpdateRecipientOptions = {
  id: number;
  name: string | undefined;
  firstName?: string | undefined;
  middleName?: string | undefined;
  lastName?: string | undefined;
  email: string | undefined;
  role: RecipientRole | undefined;
};

export const updateRecipient = async ({
  id,
  name,
  firstName,
  middleName,
  lastName,
  email,
  role,
}: UpdateRecipientOptions) => {
  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      id,
    },
  });

  if (recipient.signingStatus === SigningStatus.SIGNED) {
    throw new Error('Cannot update a recipient that has already signed.');
  }

  return await prisma.recipient.update({
    where: {
      id,
    },
    data: {
      ...resolveRecipientNameOnUpdate({ name, firstName, middleName, lastName }, recipient),
      email,
      role,
    },
  });
};
