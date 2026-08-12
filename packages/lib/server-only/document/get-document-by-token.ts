import { EnvelopeType } from '@prisma/client';

import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { TDocumentAuthMethods } from '../../types/document-auth';
import { resolveLiveDocumentMeta } from '../../utils/document';
import { mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { getTeamSettings } from '../team/get-team-settings';
import { isRecipientAuthorized } from './is-recipient-authorized';

export interface GetDocumentAndSenderByTokenOptions {
  token: string;
  userId?: number;
  accessAuth?: TDocumentAuthMethods;

  /**
   * Whether we enforce the access requirement.
   *
   * Defaults to true.
   */
  requireAccessAuth?: boolean;
}

export interface GetDocumentAndRecipientByTokenOptions {
  token: string;
  userId?: number;
  accessAuth?: TDocumentAuthMethods;

  /**
   * Whether we enforce the access requirement.
   *
   * Defaults to true.
   */
  requireAccessAuth?: boolean;
}
export type GetDocumentByTokenOptions = {
  token: string;
};

export const getDocumentByToken = async ({ token }: GetDocumentByTokenOptions) => {
  if (!token) {
    throw new Error('Missing token');
  }

  const result = await prisma.envelope.findFirstOrThrow({
    where: {
      type: EnvelopeType.DOCUMENT,
      recipients: {
        some: {
          token,
        },
      },
    },
  });

  return result;
};

export type DocumentAndSender = Awaited<ReturnType<typeof getDocumentAndSenderByToken>>;

export const getDocumentAndSenderByToken = async ({
  token,
  userId,
  accessAuth,
  requireAccessAuth = true,
}: GetDocumentAndSenderByTokenOptions) => {
  if (!token) {
    throw new Error('Missing token');
  }

  const result = await prisma.envelope.findFirstOrThrow({
    where: {
      type: EnvelopeType.DOCUMENT,
      recipients: {
        some: {
          token,
        },
      },
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
      documentMeta: true,
      recipients: {
        where: {
          token,
        },
      },
      envelopeItems: {
        select: {
          id: true,
          title: true,
          order: true,
          envelopeId: true,
          documentDataId: true,
          documentData: true,
        },
      },
      team: {
        select: {
          name: true,
          teamEmail: true,
          url: true,
          teamGlobalSettings: {
            select: {
              brandingEnabled: true,
              brandingLogo: true,
            },
          },
        },
      },
    },
  });

  const firstDocumentData = result.envelopeItems[0].documentData;

  if (!firstDocumentData) {
    throw new Error('Missing document data');
  }

  const recipient = result.recipients[0];

  // Sanity check, should not be possible.
  if (!recipient) {
    throw new Error('Missing recipient');
  }

  let documentAccessValid = true;

  if (requireAccessAuth) {
    documentAccessValid = await isRecipientAuthorized({
      type: 'ACCESS',
      documentAuthOptions: result.authOptions,
      recipient,
      userId,
      authOptions: accessAuth,
    });
  }

  if (!documentAccessValid) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'Invalid access values',
    });
  }

  const legacyDocumentId = mapSecondaryIdToDocumentId(result.secondaryId);

  const settings = await getTeamSettings({ teamId: result.teamId });

  return {
    ...result,
    // Re-cap the signature types and fill in an inherited date format from the organisation/team
    // settings as they are now, so revoking either also applies to documents already out for
    // signature. Completed documents keep their snapshot.
    documentMeta: resolveLiveDocumentMeta(settings, result.documentMeta, result.status),
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
    },
    documentData: firstDocumentData,
    id: legacyDocumentId,
    envelopeId: result.id,
  };
};
