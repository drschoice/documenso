import { describe, expect, it } from 'vitest';

import { convertToLocalSystemFormat } from './date-formats';

describe('convertToLocalSystemFormat', () => {
  it('re-formats a value that matches the configured format', () => {
    expect(convertToLocalSystemFormat('09/03/2026', 'dd/MM/yyyy', 'Etc/UTC')).toBe('09/03/2026');
    expect(convertToLocalSystemFormat('2026-03-09', 'yyyy-MM-dd', 'Etc/UTC')).toBe('2026-03-09');
  });

  it('falls back to the other known formats when the document format has since changed', () => {
    // Stamped as `yyyy-MM-dd` before the organisation switched to `dd/MM/yyyy`.
    expect(convertToLocalSystemFormat('2026-03-09', 'dd/MM/yyyy', 'Etc/UTC')).toBe('09/03/2026');
  });

  it('returns the stored value verbatim rather than "Invalid date" when nothing parses', () => {
    expect(convertToLocalSystemFormat('not a date at all', 'dd/MM/yyyy', 'Etc/UTC')).toBe(
      'not a date at all',
    );
  });
});
