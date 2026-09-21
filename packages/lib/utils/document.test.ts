import { DocumentStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  capSignatureSettings,
  extractDerivedDocumentMeta,
  resolveDateFormat,
  resolveIncludeSigningCertificate,
  resolveLiveDocumentMeta,
} from './document';

const settings = {
  typedSignatureEnabled: true,
  uploadSignatureEnabled: true,
  drawSignatureEnabled: true,
  documentDateFormat: 'dd/MM/yyyy',
};

const meta = {
  typedSignatureEnabled: true,
  uploadSignatureEnabled: true,
  drawSignatureEnabled: true,
  dateFormat: null as string | null,
};

describe('capSignatureSettings', () => {
  it('lets a downstream value narrow the allowance', () => {
    expect(capSignatureSettings(settings, { ...meta, drawSignatureEnabled: false })).toEqual({
      typedSignatureEnabled: true,
      uploadSignatureEnabled: true,
      drawSignatureEnabled: false,
    });
  });

  it('never lets a downstream value widen past the cap', () => {
    const cap = { ...settings, drawSignatureEnabled: false, uploadSignatureEnabled: false };

    expect(capSignatureSettings(cap, meta)).toEqual({
      typedSignatureEnabled: true,
      uploadSignatureEnabled: false,
      drawSignatureEnabled: false,
    });
  });

  it('treats a missing or null downstream value as "no opinion"', () => {
    expect(capSignatureSettings(settings, null)).toEqual({
      typedSignatureEnabled: true,
      uploadSignatureEnabled: true,
      drawSignatureEnabled: true,
    });

    expect(
      capSignatureSettings(
        { ...settings, typedSignatureEnabled: false },
        { typedSignatureEnabled: null, uploadSignatureEnabled: null, drawSignatureEnabled: null },
      ),
    ).toEqual({
      typedSignatureEnabled: false,
      uploadSignatureEnabled: true,
      drawSignatureEnabled: true,
    });
  });
});

describe('resolveDateFormat', () => {
  it('falls back to the organisation format when the document inherits', () => {
    expect(resolveDateFormat(settings, { dateFormat: null })).toBe('dd/MM/yyyy');
  });

  it('keeps a format the document pinned', () => {
    expect(resolveDateFormat(settings, { dateFormat: 'yyyy-MM-dd' })).toBe('yyyy-MM-dd');
  });
});

describe('resolveIncludeSigningCertificate', () => {
  const certSettings = { includeSigningCertificate: true };

  it('falls back to the organisation/team setting when the envelope inherits', () => {
    expect(resolveIncludeSigningCertificate(certSettings, { includeSigningCertificate: null })).toBe(
      true,
    );

    expect(
      resolveIncludeSigningCertificate(
        { includeSigningCertificate: false },
        { includeSigningCertificate: null },
      ),
    ).toBe(false);
  });

  it('lets the envelope turn the certificate off against an enabled team', () => {
    expect(
      resolveIncludeSigningCertificate(certSettings, { includeSigningCertificate: false }),
    ).toBe(false);
  });

  it('lets the envelope turn the certificate on against a disabled team', () => {
    expect(
      resolveIncludeSigningCertificate(
        { includeSigningCertificate: false },
        { includeSigningCertificate: true },
      ),
    ).toBe(true);
  });

  it('treats a missing meta as inherit', () => {
    expect(resolveIncludeSigningCertificate(certSettings, null)).toBe(true);
    expect(resolveIncludeSigningCertificate(certSettings, undefined)).toBe(true);
  });
});

describe('resolveLiveDocumentMeta', () => {
  it('re-caps signature types and fills in an inherited date format', () => {
    const cap = { ...settings, drawSignatureEnabled: false };

    expect(resolveLiveDocumentMeta(cap, meta, DocumentStatus.PENDING)).toEqual({
      typedSignatureEnabled: true,
      uploadSignatureEnabled: true,
      drawSignatureEnabled: false,
      dateFormat: 'dd/MM/yyyy',
    });
  });

  it('leaves completed and rejected envelopes exactly as they were signed', () => {
    const cap = { ...settings, drawSignatureEnabled: false };

    for (const status of [DocumentStatus.COMPLETED, DocumentStatus.REJECTED]) {
      expect(resolveLiveDocumentMeta(cap, meta, status)).toBe(meta);
    }
  });

  it('preserves any other keys on the meta', () => {
    const withExtras = { ...meta, timezone: 'Australia/Melbourne', subject: 'Hello' };

    expect(resolveLiveDocumentMeta(settings, withExtras, DocumentStatus.DRAFT)).toMatchObject({
      timezone: 'Australia/Melbourne',
      subject: 'Hello',
    });
  });
});

describe('extractDerivedDocumentMeta', () => {
  /**
   * `192642f28` / `50117eb23` made the typed-signature font configurable and
   * bumped the default size from 18 to 24. The chain is organisation -> team ->
   * envelope, resolved once when the document is created, and nothing covered it.
   */
  const orgSettings = {
    documentLanguage: 'en',
    documentTimezone: 'Etc/UTC',
    documentDateFormat: 'yyyy-MM-dd',
    typedSignatureEnabled: true,
    uploadSignatureEnabled: true,
    drawSignatureEnabled: true,
    signatureFontFamily: 'Caveat',
    signatureFontSize: 24,
    emailId: null,
    emailReplyTo: null,
    emailDocumentSettings: null,
    envelopeExpirationPeriod: null,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  } as unknown as Parameters<typeof extractDerivedDocumentMeta>[0];

  it('inherits the signature font from the organisation/team settings', () => {
    expect(extractDerivedDocumentMeta(orgSettings, undefined)).toMatchObject({
      signatureFontFamily: 'Caveat',
      signatureFontSize: 24,
    });
  });

  it('lets the envelope override the inherited font', () => {
    expect(
      extractDerivedDocumentMeta(orgSettings, {
        signatureFontFamily: 'Dancing Script',
        signatureFontSize: 30,
      }),
    ).toMatchObject({
      signatureFontFamily: 'Dancing Script',
      signatureFontSize: 30,
    });
  });

  it('inherits when the override carries no font at all', () => {
    // An override object that simply says nothing about the font is the real
    // shape of "inherit" here. Null is not: unlike the team settings, where the
    // columns are nullable and null genuinely means inherit, `DocumentMeta`
    // declares both font columns non-nullable with defaults, so a null can
    // never reach this function from the database.
    expect(extractDerivedDocumentMeta(orgSettings, { subject: 'Please sign' })).toMatchObject({
      signatureFontFamily: 'Caveat',
      signatureFontSize: 24,
    });
  });

  it('keeps a font size the envelope pinned even when it matches the old default', () => {
    // 18 was the default before `192642f28`. `??` rather than `||` is what makes
    // an explicitly chosen 18 survive instead of snapping back to the setting.
    expect(
      extractDerivedDocumentMeta(orgSettings, { signatureFontSize: 18 }),
    ).toMatchObject({ signatureFontSize: 18 });
  });

  it('starts a document with no next-field navigation filter', () => {
    // An empty filter means "every required field blocks completion", which is
    // the behaviour `04dbd580c` only departs from when a filter is configured.
    expect(extractDerivedDocumentMeta(orgSettings, undefined)).toMatchObject({
      nextFieldNavigationTypes: [],
      nextFieldNavigationLabels: [],
    });
  });
});
