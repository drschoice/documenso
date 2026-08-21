import { describe, expect, it } from 'vitest';

import { renderCustomEmailTemplate } from './render-custom-email-template';

const tokens = {
  'signer.name': 'Ada Lovelace',
  'signer.email': 'ada@example.com',
  'document.name': 'Open Source Pledge.pdf',
};

describe('renderCustomEmailTemplate', () => {
  it('substitutes a single token', () => {
    expect(renderCustomEmailTemplate('Hello {signer.name}', tokens)).toBe('Hello Ada Lovelace');
  });

  it('substitutes multiple whitespace-separated tokens', () => {
    expect(renderCustomEmailTemplate('{signer.name} <{signer.email}>', tokens)).toBe(
      'Ada Lovelace <ada@example.com>',
    );
  });

  it('substitutes adjacent tokens with no whitespace between them', () => {
    // A greedy `\S+` key pattern matched `document.name}-{signer.name` as one key here, failed the
    // lookup, and emitted it with the braces stripped.
    expect(renderCustomEmailTemplate('{document.name}-{signer.name}', tokens)).toBe(
      'Open Source Pledge.pdf-Ada Lovelace',
    );
  });

  it('substitutes tokens separated only by punctuation', () => {
    expect(renderCustomEmailTemplate('{signer.name},{signer.email}', tokens)).toBe(
      'Ada Lovelace,ada@example.com',
    );
  });

  it('emits the bare key for an unknown token', () => {
    expect(renderCustomEmailTemplate('Hi {signer.nmae}', tokens)).toBe('Hi signer.nmae');
  });

  it('leaves text without tokens untouched', () => {
    expect(renderCustomEmailTemplate('No placeholders here.', tokens)).toBe(
      'No placeholders here.',
    );
  });

  it('leaves braces spanning whitespace untouched', () => {
    expect(renderCustomEmailTemplate('{ not a token }', tokens)).toBe('{ not a token }');
  });

  it('substitutes the same token more than once', () => {
    expect(renderCustomEmailTemplate('{signer.name} and {signer.name}', tokens)).toBe(
      'Ada Lovelace and Ada Lovelace',
    );
  });
});
