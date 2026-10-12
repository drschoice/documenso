import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import { VALID_DATE_FORMAT_VALUES } from '../../constants/date-formats';
import {
  type TDateInputPattern,
  formatDateForInput,
  formatDateInputDraft,
  getDateInputPattern,
  getDateInputPlaceholder,
  getSignedDateParts,
  parseDateInput,
  toSignableDate,
} from './date-input';

const MDY: TDateInputPattern = { order: 'MDY', separator: '/' };
const DMY_DOTS: TDateInputPattern = { order: 'DMY', separator: '.' };
const YMD: TDateInputPattern = { order: 'YMD', separator: '-' };

/** Type a string one character at a time, the way the editor sees it. */
const typeInto = (pattern: TDateInputPattern, keys: string) => {
  let value = '';

  for (const key of keys) {
    value = formatDateInputDraft(value + key, pattern);
  }

  return value;
};

describe('getDateInputPattern', () => {
  it.each([
    ['yyyy-MM-dd hh:mm a', 'YMD', '-'],
    ['yyyy-MM-dd', 'YMD', '-'],
    ['yy-MM-dd HH:mm', 'YMD', '-'],
    ['dd/MM/yyyy', 'DMY', '/'],
    ['dd/MM/yyyy hh:mm a', 'DMY', '/'],
    ['dd.MM.yyyy HH:mm', 'DMY', '.'],
    ['MM/dd/yyyy', 'MDY', '/'],
    ['MM/dd/yyyy hh:mm a', 'MDY', '/'],
    ['MMMM dd, yyyy', 'MDY', '/'],
    ['EEEE, MMMM dd, yyyy hh:mm a', 'MDY', '/'],
    ["yyyy-MM-dd'T'HH:mm:ss.SSSXXX", 'YMD', '-'],
  ])('reads %s as %s with "%s"', (format, order, separator) => {
    expect(getDateInputPattern(format)).toEqual({ order, separator });
  });

  it('gives every supported format a pattern', () => {
    for (const format of VALID_DATE_FORMAT_VALUES) {
      expect(['MDY', 'DMY', 'YMD']).toContain(getDateInputPattern(format).order);
    }
  });

  it('falls back to the default format', () => {
    expect(getDateInputPattern(null)).toEqual({ order: 'YMD', separator: '-' });
  });
});

describe('getDateInputPlaceholder', () => {
  it('spells the pattern out', () => {
    expect(getDateInputPlaceholder(MDY)).toBe('MM/DD/YYYY');
    expect(getDateInputPlaceholder(DMY_DOTS)).toBe('DD.MM.YYYY');
    expect(getDateInputPlaceholder(YMD)).toBe('YYYY-MM-DD');
  });
});

describe('formatDateInputDraft', () => {
  it('puts the separators in as digits are typed', () => {
    expect(typeInto(MDY, '03141957')).toBe('03/14/1957');
    expect(typeInto(YMD, '19570314')).toBe('1957-03-14');
    expect(typeInto(DMY_DOTS, '14031957')).toBe('14.03.1957');
  });

  it('adds a separator as soon as a part is complete', () => {
    expect(typeInto(MDY, '03')).toBe('03/');
    expect(typeInto(MDY, '0314')).toBe('03/14/');
  });

  it('lets a separator end a one-digit part early', () => {
    expect(typeInto(MDY, '3/14/1957')).toBe('3/14/1957');
    expect(typeInto(MDY, '3-')).toBe('3/');
  });

  it('drops anything that is not a digit or a separator', () => {
    expect(typeInto(MDY, '0a3b')).toBe('03/');
  });

  it('stops at a full date', () => {
    expect(typeInto(MDY, '031419579999')).toBe('03/14/1957');
  });

  it('tidies pasted text', () => {
    expect(formatDateInputDraft('03141957', MDY)).toBe('03/14/1957');
  });

  it('lets Backspace remove a separator it added', () => {
    expect(formatDateInputDraft('03', MDY, true)).toBe('03');
    expect(formatDateInputDraft('03/14', MDY, true)).toBe('03/14');
  });
});

describe('parseDateInput', () => {
  it('reads a whole date in each order', () => {
    expect(parseDateInput('03/14/1957', MDY)).toEqual({ year: 1957, month: 3, day: 14 });
    expect(parseDateInput('14.03.1957', DMY_DOTS)).toEqual({ year: 1957, month: 3, day: 14 });
    expect(parseDateInput('1957-03-14', YMD)).toEqual({ year: 1957, month: 3, day: 14 });
  });

  it('accepts one-digit days and months', () => {
    expect(parseDateInput('3/4/1957', MDY)).toEqual({ year: 1957, month: 3, day: 4 });
  });

  it('rejects dates that do not exist or are not finished', () => {
    expect(parseDateInput('02/30/2026', MDY)).toBeNull();
    expect(parseDateInput('13/01/2026', MDY)).toBeNull();
    expect(parseDateInput('03/14/57', MDY)).toBeNull();
    expect(parseDateInput('03/14/', MDY)).toBeNull();
  });
});

describe('formatDateForInput', () => {
  it('pads to the pattern', () => {
    expect(formatDateForInput({ year: 1957, month: 3, day: 4 }, MDY)).toBe('03/04/1957');
    expect(formatDateForInput({ year: 1957, month: 3, day: 4 }, YMD)).toBe('1957-03-04');
  });
});

describe('toSignableDate', () => {
  it('signs at noon UTC, as the date picker does', () => {
    expect(toSignableDate({ year: 1957, month: 3, day: 14 })).toBe('1957-03-14T12:00:00.000Z');
  });
});

describe('getSignedDateParts', () => {
  it('reads back what the server stamped', () => {
    // The server formats the signed date in the document's zone with its format.
    const stamped = DateTime.fromISO('1957-03-14T12:00:00.000Z')
      .setZone('America/New_York')
      .toFormat('MMMM dd, yyyy hh:mm a');

    expect(getSignedDateParts(stamped, 'MMMM dd, yyyy hh:mm a', 'America/New_York')).toEqual({
      year: 1957,
      month: 3,
      day: 14,
    });
  });

  it('falls back to the other formats, and gives up on text that is not a date', () => {
    expect(getSignedDateParts('14/03/1957', 'yyyy-MM-dd', 'Etc/UTC')).toEqual({
      year: 1957,
      month: 3,
      day: 14,
    });

    expect(getSignedDateParts('soon', 'yyyy-MM-dd', 'Etc/UTC')).toBeNull();
    expect(getSignedDateParts('', 'yyyy-MM-dd', 'Etc/UTC')).toBeNull();
  });
});
