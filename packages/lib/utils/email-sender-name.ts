import type { EmailSenderNameMode } from '@prisma/client';

import { renderCustomEmailTemplate } from './render-custom-email-template';

type ResolveEmailSenderNameOptions = {
  settings: {
    emailSenderNameMode: EmailSenderNameMode;
    emailSenderNameCustom: string;
  };
  organisationName: string;
  teamName: string;
};

/**
 * The name envelope emails speak as — "<name> invited you to sign ...".
 *
 * Historically this was always the team name, which reads oddly for organisations whose teams are
 * internal divisions ("General") while the brand recipients recognise is the organisation
 * ("Doctor's Choice"). The mode is configured per organisation, and per team where a team wants to
 * differ.
 *
 * `CUSTOM` supports `{organisation.name}` and `{team.name}` through the same placeholder renderer the
 * subject and message fields use. A blank custom string falls back to the team name rather than
 * sending an email that names nobody.
 */
export const resolveEmailSenderName = ({
  settings,
  organisationName,
  teamName,
}: ResolveEmailSenderNameOptions): string => {
  // Compared against string literals rather than the Prisma enum object so this stays importable
  // from client components — a value import of `@prisma/client` does not survive into the browser
  // bundle. The `EmailSenderNameMode` type still keeps the cases exhaustive.
  switch (settings.emailSenderNameMode) {
    case 'ORGANISATION':
      return organisationName || teamName;

    case 'TEAM':
      return teamName;

    case 'CUSTOM': {
      const custom = settings.emailSenderNameCustom?.trim();

      if (!custom) {
        return teamName;
      }

      return renderCustomEmailTemplate(custom, {
        'organisation.name': organisationName,
        'team.name': teamName,
      });
    }

    default:
      return teamName;
  }
};
