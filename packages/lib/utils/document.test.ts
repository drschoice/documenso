import { DocumentStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { capSignatureSettings, resolveDateFormat, resolveLiveDocumentMeta } from './document';

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
