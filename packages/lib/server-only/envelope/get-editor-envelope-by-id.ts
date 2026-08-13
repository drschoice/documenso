import { EnvelopeType } from '@prisma/client';

import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { capLiveDocumentMeta, isDocumentCompleted } from '../../utils/document';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { getTeamSettings } from '../team/get-team-settings';

export type GetEditorEnvelopeByIdOptions = {
  id: EnvelopeIdOptions;

  /**
   * The validated team ID.
   */
  userId: number;

  /**
   * The unvalidated team ID.
   */
  teamId: number;

  /**
   * The type of envelope to get.
   *
   * Set to null to bypass check.
   */
  type: EnvelopeType | null;
};

export const getEditorEnvelopeById = async ({
  id,
  userId,
  teamId,
  type,
}: GetEditorEnvelopeByIdOptions) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    userId,
    teamId,
    type,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      envelopeItems: {
        include: {
          documentData: true,
        },
        orderBy: {
          order: 'asc',
        },
      },
      folder: true,
      documentMeta: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      recipients: {
        orderBy: {
          id: 'asc',
        },
      },
      fields: true,
      team: {
        select: {
          id: true,
          url: true,
          organisationId: true,
        },
      },
      directLink: {
        select: {
          directTemplateRecipientId: true,
          enabled: true,
          id: true,
          token: true,
        },
      },
      envelopeAttachments: {
        select: {
          id: true,
          type: true,
          label: true,
          data: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Envelope could not be found',
    });
  }

  if (envelope.documentMeta && !isDocumentCompleted(envelope.status)) {
    const settings = await getTeamSettings({ userId, teamId });

    // Templates do not pin the signature font family/size — documents generated from them re-resolve
    // both from the current org/team settings (see the template creation paths). Surface those
    // resolved values in the editor/preview so the template accurately previews what its documents
    // will look like, instead of showing the (now meaningless) values snapshotted at template creation.
    if (envelope.type === EnvelopeType.TEMPLATE) {
      envelope.documentMeta.signatureFontFamily = settings.signatureFontFamily;
      envelope.documentMeta.signatureFontSize = settings.signatureFontSize;
    }

    // Cap only — `dateFormat` stays raw so the editor can distinguish an inherited format (null)
    // from one the sender deliberately pinned, and offer "inherit" back as a choice.
    envelope.documentMeta = capLiveDocumentMeta(settings, envelope.documentMeta, envelope.status);
  }

  return {
    ...envelope,
    attachments: envelope.envelopeAttachments,
    user: {
      id: envelope.user.id,
      name: envelope.user.name || '',
      email: envelope.user.email,
    },
  };
};
