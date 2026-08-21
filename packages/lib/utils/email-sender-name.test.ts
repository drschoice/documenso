import { EmailSenderNameMode } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { resolveEmailSenderName } from './email-sender-name';

const names = { organisationName: "Doctor's Choice", teamName: 'General' };

describe('resolveEmailSenderName', () => {
  it('uses the organisation name in ORGANISATION mode', () => {
    expect(
      resolveEmailSenderName({
        settings: { emailSenderNameMode: EmailSenderNameMode.ORGANISATION, emailSenderNameCustom: '' },
        ...names,
      }),
    ).toBe("Doctor's Choice");
  });

  it('uses the team name in TEAM mode', () => {
    expect(
      resolveEmailSenderName({
        settings: { emailSenderNameMode: EmailSenderNameMode.TEAM, emailSenderNameCustom: '' },
        ...names,
      }),
    ).toBe('General');
  });

  it('uses the custom string in CUSTOM mode', () => {
    expect(
      resolveEmailSenderName({
        settings: {
          emailSenderNameMode: EmailSenderNameMode.CUSTOM,
          emailSenderNameCustom: 'Doctor’s Choice Admissions',
        },
        ...names,
      }),
    ).toBe('Doctor’s Choice Admissions');
  });

  it('substitutes organisation and team tokens in CUSTOM mode', () => {
    expect(
      resolveEmailSenderName({
        settings: {
          emailSenderNameMode: EmailSenderNameMode.CUSTOM,
          emailSenderNameCustom: '{organisation.name} ({team.name})',
        },
        ...names,
      }),
    ).toBe("Doctor's Choice (General)");
  });

  it('substitutes brace-adjacent tokens in CUSTOM mode', () => {
    // Guards the `renderCustomEmailTemplate` regex fix: a greedy key pattern matched both tokens as
    // one bogus key here and emitted it with the braces stripped.
    expect(
      resolveEmailSenderName({
        settings: {
          emailSenderNameMode: EmailSenderNameMode.CUSTOM,
          emailSenderNameCustom: '{organisation.name}-{team.name}',
        },
        ...names,
      }),
    ).toBe("Doctor's Choice-General");
  });

  it('falls back to the team name when the custom string is blank or whitespace', () => {
    for (const emailSenderNameCustom of ['', '   ']) {
      expect(
        resolveEmailSenderName({
          settings: { emailSenderNameMode: EmailSenderNameMode.CUSTOM, emailSenderNameCustom },
          ...names,
        }),
      ).toBe('General');
    }
  });

  it('falls back to the team name when the organisation has no name', () => {
    expect(
      resolveEmailSenderName({
        settings: { emailSenderNameMode: EmailSenderNameMode.ORGANISATION, emailSenderNameCustom: '' },
        organisationName: '',
        teamName: 'General',
      }),
    ).toBe('General');
  });
});
