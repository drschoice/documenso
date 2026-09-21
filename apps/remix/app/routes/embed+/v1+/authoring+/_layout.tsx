import { TeamMemberRole } from '@prisma/client';
import { APP_I18N_OPTIONS } from '@documenso/lib/constants/i18n';
import { captureServerEvent } from '@documenso/lib/server-only/analytics/capture-server-event';
import { verifyEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/verify-embedding-presign-token';
import { getOrganisationClaimByTeamId } from '@documenso/lib/server-only/organisation/get-organisation-claims';
import { getTeamSettings } from '@documenso/lib/server-only/team/get-team-settings';
import { ZBaseEmbedAuthoringSchema } from '@documenso/lib/types/embed-authoring-base-schema';
import { fireAndForget } from '@documenso/lib/universal/fire-and-forget';
import { dynamicActivate } from '@documenso/lib/utils/i18n';
import { prisma } from '@documenso/prisma';
import { TrpcProvider } from '@documenso/trpc/react';
import type { OrganisationSession } from '@documenso/trpc/server/organisation-router/get-organisation-session.types';
import { Spinner } from '@documenso/ui/primitives/spinner';
import { Trans } from '@lingui/react/macro';
import { useLayoutEffect, useState } from 'react';
import { Outlet, useLoaderData } from 'react-router';

import { TeamProvider } from '~/providers/team';
import { injectCss } from '~/utils/css-vars';

import type { Route } from './+types/_layout';

type EmbeddedAuthoringTeam = OrganisationSession['teams'][number];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);

  const token = url.searchParams.get('token');

  if (!token) {
    return {
      hasValidToken: false,
      token,
    };
  }

  const result = await verifyEmbeddingPresignToken({ token }).catch(() => null);

  let allowEmbedAuthoringWhiteLabel = false;
  let team: EmbeddedAuthoringTeam | null = null;

  if (result) {
    const [organisationClaim, teamSettings] = await Promise.all([
      getOrganisationClaimByTeamId({ teamId: result.teamId }),
      getTeamSettings({ userId: result.userId, teamId: result.teamId }),
    ]);

    allowEmbedAuthoringWhiteLabel = organisationClaim.flags.embedAuthoringWhiteLabel ?? false;

    // Derive the kind of authoring session from the child route path, e.g.
    // /embed/v1/authoring/document/create -> resource 'document', mode 'create'.
    // Completed and error pages are not new sessions and are skipped.
    const [resource, mode] = url.pathname.split('/').filter(Boolean).slice(3);

    const isAuthoringSession =
      (resource === 'document' || resource === 'template') && (mode === 'create' || mode === 'edit');

    if (isAuthoringSession) {
      fireAndForget(async () => {
        const team = await prisma.team.findFirst({
          where: {
            id: result.teamId,
          },
          select: {
            organisationId: true,
          },
        });

        captureServerEvent({
          event: 'App: Embed Session Started',
          userId: result.userId,
          organisationId: team?.organisationId,
          teamId: result.teamId,
          properties: {
            type: 'authoring',
            version: 'v1',
            resource,
            mode,
          },
        });
      });
    }
    // The authoring components below read the organisation's document
    // preferences - the date format they seed with, the signature types they
    // are allowed to offer - through `useCurrentTeam`, which throws outside a
    // provider. This route is token-authed and sits outside `_authenticated`,
    // where the real provider is mounted, so it carries its own with the same
    // shape the sibling v2 layout builds. Only `preferences` is real; nothing
    // here reads the rest.
    team = {
      id: result.teamId,
      name: '',
      url: '',
      createdAt: new Date(),
      avatarImageId: null,
      organisationId: '',
      currentTeamRole: TeamMemberRole.MEMBER,
      preferences: {
        aiFeaturesEnabled: teamSettings.aiFeaturesEnabled,
        typedSignatureEnabled: teamSettings.typedSignatureEnabled,
        uploadSignatureEnabled: teamSettings.uploadSignatureEnabled,
        drawSignatureEnabled: teamSettings.drawSignatureEnabled,
        documentDateFormat: teamSettings.documentDateFormat,
        includeSigningCertificate: teamSettings.includeSigningCertificate,
      },
    };
  }

  return {
    token,
    hasValidToken: !!result,
    allowEmbedAuthoringWhiteLabel,
    team,
  };
};

export default function AuthoringLayout() {
  const { token, hasValidToken, allowEmbedAuthoringWhiteLabel, team } =
    useLoaderData<typeof loader>();

  const [hasFinishedInit, setHasFinishedInit] = useState(false);

  useLayoutEffect(() => {
    try {
      const hash = window.location.hash.slice(1);

      const result = ZBaseEmbedAuthoringSchema.safeParse(JSON.parse(decodeURIComponent(atob(hash))));

      if (!result.success) {
        setHasFinishedInit(true);
        return;
      }

      const { css, cssVars, darkModeDisabled, language } = result.data;

      if (darkModeDisabled) {
        document.documentElement.classList.add('dark-mode-disabled');
      }

      if (allowEmbedAuthoringWhiteLabel) {
        injectCss({
          css,
          cssVars,
        });
      }

      if (language && language !== APP_I18N_OPTIONS.sourceLang) {
        void dynamicActivate(language).finally(() => {
          setHasFinishedInit(true);
        });
      } else {
        setHasFinishedInit(true);
      }
    } catch (error) {
      console.error(error);
      setHasFinishedInit(true);
    }
  }, []);

  if (!hasFinishedInit) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!hasValidToken || !team) {
    return (
      <div>
        <Trans>Invalid embedding presign token provided</Trans>
      </div>
    );
  }

  return (
    <TeamProvider team={team}>
      <TrpcProvider headers={{ authorization: `Bearer ${token}` }}>
        <Outlet />
      </TrpcProvider>
    </TeamProvider>
  );
}
