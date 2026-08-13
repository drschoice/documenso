import { getHighestOrganisationRoleInGroup } from '@documenso/lib/utils/organisations';
import {
  buildTeamWhereQuery,
  extractDerivedTeamSettings,
  getHighestTeamRoleInGroup,
} from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import type { TGetOrganisationSessionResponse } from './get-organisation-session.types';
import { ZGetOrganisationSessionResponseSchema } from './get-organisation-session.types';

/**
 * Get all the organisations and teams a user belongs to.
 */
export const getOrganisationSessionRoute = authenticatedProcedure
  .output(ZGetOrganisationSessionResponseSchema)
  .query(async ({ ctx }) => {
    return await getOrganisationSession({ userId: ctx.user.id });
  });

export const getOrganisationSession = async ({
  userId,
}: {
  userId: number;
}): Promise<TGetOrganisationSessionResponse> => {
  const organisations = await prisma.organisation.findMany({
    where: {
      members: {
        some: {
          userId,
        },
      },
    },
    include: {
      organisationClaim: true,
      organisationGlobalSettings: true,
      subscription: true,
      groups: {
        where: {
          organisationGroupMembers: {
            some: {
              organisationMember: {
                userId,
              },
            },
          },
        },
      },
      teams: {
        where: buildTeamWhereQuery({ teamId: undefined, userId }),
        include: {
          teamGlobalSettings: true,
          teamGroups: {
            where: {
              organisationGroup: {
                organisationGroupMembers: {
                  some: {
                    organisationMember: {
                      userId,
                    },
                  },
                },
              },
            },
            include: {
              organisationGroup: true,
            },
          },
        },
      },
    },
  });

  return organisations.map((organisation) => {
    const { organisationGlobalSettings } = organisation;

    return {
      ...organisation,
      teams: organisation.teams.map((team) => {
        const derivedSettings = extractDerivedTeamSettings(
          organisationGlobalSettings,
          team.teamGlobalSettings,
        );

        return {
          ...team,
          currentTeamRole: getHighestTeamRoleInGroup(team.teamGroups),
          preferences: {
            aiFeaturesEnabled: derivedSettings.aiFeaturesEnabled,

            // The ceiling every document and template in this team is held to. Authoring UIs use
            // these to hide options the organisation/team has revoked; the server re-derives the
            // same values rather than trusting the client.
            typedSignatureEnabled: derivedSettings.typedSignatureEnabled,
            uploadSignatureEnabled: derivedSettings.uploadSignatureEnabled,
            drawSignatureEnabled: derivedSettings.drawSignatureEnabled,
            documentDateFormat: derivedSettings.documentDateFormat,
          },
        };
      }),
      currentOrganisationRole: getHighestOrganisationRoleInGroup(organisation.groups),
    };
  });
};
