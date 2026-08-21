import { Prisma } from '@prisma/client';
import { OrganisationType } from '@prisma/client';

import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/organisations';
import { TEAM_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/teams';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { buildOrganisationWhereQuery } from '@documenso/lib/utils/organisations';
import { buildTeamWhereQuery } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import {
  ZUpdateTeamSettingsRequestSchema,
  ZUpdateTeamSettingsResponseSchema,
} from './update-team-settings.types';

export const updateTeamSettingsRoute = authenticatedProcedure
  .input(ZUpdateTeamSettingsRequestSchema)
  .output(ZUpdateTeamSettingsResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { user } = ctx;
    const { teamId, data } = input;

    ctx.logger.info({
      input: {
        teamId,
      },
    });

    const {
      // Document related settings.
      documentVisibility,
      documentLanguage,
      documentTimezone,
      documentDateFormat,
      includeSenderDetails,
      includeSigningCertificate,
      includeAuditLog,
      typedSignatureEnabled,
      uploadSignatureEnabled,
      drawSignatureEnabled,
      signatureFontFamily,
      signatureFontSize,
      delegateDocumentOwnership,
      envelopeExpirationPeriod,

      // Branding related settings.
      brandingEnabled,
      brandingLogo,
      brandingUrl,
      brandingCompanyDetails,

      // Email related settings.
      emailId,
      emailReplyTo,
      // emailReplyToName,
      emailDocumentSettings,
      emailSenderNameMode,
      emailSenderNameCustom,

      // Default recipients settings.
      defaultRecipients,
      // AI features settings.
      aiFeaturesEnabled,
    } = data;

    if (Object.values(data).length === 0) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: 'No settings to update',
      });
    }

    // Signatures will only be inherited if all are NULL.
    if (
      typedSignatureEnabled === false &&
      uploadSignatureEnabled === false &&
      drawSignatureEnabled === false
    ) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: 'At least one signature type must be enabled',
      });
    }

    const team = await prisma.team.findFirst({
      where: buildTeamWhereQuery({
        teamId,
        userId: user.id,
        roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_TEAM'],
      }),
    });

    if (!team) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You do not have permission to update this team.',
      });
    }

    // The organisation's signature types are a cap, not a default — a team may narrow them further
    // but can never re-enable one the organisation has turned off. Null means "inherit", which is
    // always within the cap.
    if (typedSignatureEnabled || uploadSignatureEnabled || drawSignatureEnabled) {
      const organisationSettings = await prisma.organisationGlobalSettings.findFirstOrThrow({
        where: {
          organisation: {
            id: team.organisationId,
          },
        },
        select: {
          typedSignatureEnabled: true,
          uploadSignatureEnabled: true,
          drawSignatureEnabled: true,
        },
      });

      if (
        (typedSignatureEnabled && !organisationSettings.typedSignatureEnabled) ||
        (uploadSignatureEnabled && !organisationSettings.uploadSignatureEnabled) ||
        (drawSignatureEnabled && !organisationSettings.drawSignatureEnabled)
      ) {
        throw new AppError(AppErrorCode.INVALID_BODY, {
          message: 'Cannot enable a signature type which is disabled for the organisation',
        });
      }
    }

    // Validate that the email ID belongs to the organisation.
    if (emailId) {
      const email = await prisma.organisationEmail.findFirst({
        where: {
          id: emailId,
          organisationId: team.organisationId,
        },
      });

      if (!email) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: 'Email not found',
        });
      }
    }

    const organisation = await prisma.organisation.findFirst({
      where: buildOrganisationWhereQuery({
        organisationId: team.organisationId,
        userId: user.id,
        roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_ORGANISATION'],
      }),
      select: {
        type: true,
        organisationGlobalSettings: {
          select: {
            includeSenderDetails: true,
          },
        },
      },
    });

    const isPersonalOrganisation = organisation?.type === OrganisationType.PERSONAL;
    const currentIncludeSenderDetails =
      organisation?.organisationGlobalSettings.includeSenderDetails;

    const isChangingIncludeSenderDetails =
      includeSenderDetails !== undefined && includeSenderDetails !== currentIncludeSenderDetails;

    if (isPersonalOrganisation && isChangingIncludeSenderDetails) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: 'Personal teams cannot update the sender details',
      });
    }

    await prisma.team.update({
      where: {
        id: teamId,
      },
      data: {
        teamGlobalSettings: {
          update: {
            // Document related settings.
            documentVisibility,
            documentLanguage,
            documentTimezone,
            documentDateFormat,
            includeSenderDetails,
            includeSigningCertificate,
            includeAuditLog,
            typedSignatureEnabled,
            uploadSignatureEnabled,
            drawSignatureEnabled,
            signatureFontFamily,
            signatureFontSize,
            delegateDocumentOwnership,
            envelopeExpirationPeriod:
              envelopeExpirationPeriod === null ? Prisma.DbNull : envelopeExpirationPeriod,

            // Branding related settings.
            brandingEnabled,
            brandingLogo,
            brandingUrl,
            brandingCompanyDetails,

            // Email related settings.
            emailId,
            emailReplyTo,
            // emailReplyToName,
            emailDocumentSettings:
              emailDocumentSettings === null ? Prisma.DbNull : emailDocumentSettings,
            defaultRecipients: defaultRecipients === null ? Prisma.DbNull : defaultRecipients,
            emailSenderNameMode,
            emailSenderNameCustom,

            // AI features settings.
            aiFeaturesEnabled,
          },
        },
      },
    });
  });
