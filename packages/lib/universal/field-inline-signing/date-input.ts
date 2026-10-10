import { DateTime } from 'luxon';

import { DEFAULT_DOCUMENT_DATE_FORMAT, parseSignedDateText } from '../../constants/date-formats';

/**
 * How a signer types a date into a DATE field: the order of day, month and year, and what goes
 * between them.
 *
 * Taken from the document's date format, so a document that prints dates as 31/12/2026 is typed
 * the same way. The format can include a time, or spell the month out; only the date is typed, and
 * always as numbers.
 */
export type TDateInputPattern = {
  order: 'MDY' | 'DMY' | 'YMD';
  separator: '/' | '-' | '.';
};

type TDateParts = {
  year: number;
  month: number;
  day: number;
};

const SEGMENT_LENGTHS: Record<TDateInputPattern['order'], [number, number, number]> = {
  MDY: [2, 2, 4],
  DMY: [2, 2, 4],
  YMD: [4, 2, 2],
};

const SEPARATORS: ReadonlyArray<TDateInputPattern['separator']> = ['/', '-', '.'];

/** Characters a signer might type between the parts of a date, whatever the pattern uses. */
const DATE_PART_BREAK = /[/\-.\s,]/;

export const getDateInputPattern = (dateFormat?: string | null): TDateInputPattern => {
  // Quoted text in a format (the 'T' in an ISO pattern) is printed as is, not a field.
  const format = (dateFormat || DEFAULT_DOCUMENT_DATE_FORMAT).replace(/'[^']*'/g, '');

  // A spelled-out month ("March 14, 1957") reads month first.
  if (/MMM|EEE/.test(format)) {
    return { order: 'MDY', separator: '/' };
  }

  const positions = (['y', 'M', 'd'] as const).map((token) => ({
    token,
    index: format.indexOf(token),
  }));

  if (positions.some(({ index }) => index === -1)) {
    return { order: 'MDY', separator: '/' };
  }

  const tokenOrder = [...positions]
    .sort((a, b) => a.index - b.index)
    .map(({ token }) => token)
    .join('');

  const order: TDateInputPattern['order'] =
    tokenOrder === 'yMd' ? 'YMD' : tokenOrder === 'dMy' ? 'DMY' : 'MDY';

  const first = positions.reduce((earliest, position) =>
    position.index < earliest.index ? position : earliest,
  );

  let afterFirst = first.index;

  while (format[afterFirst] === first.token) {
    afterFirst += 1;
  }

  const separatorCandidate = format[afterFirst];

  const separator = SEPARATORS.find((candidate) => candidate === separatorCandidate) ?? '/';

  return { order, separator };
};

/** What the field shows before anything is typed, e.g. "MM/DD/YYYY". */
export const getDateInputPlaceholder = (pattern: TDateInputPattern) => {
  const names = { MDY: ['MM', 'DD', 'YYYY'], DMY: ['DD', 'MM', 'YYYY'], YMD: ['YYYY', 'MM', 'DD'] };

  return names[pattern.order].join(pattern.separator);
};

/**
 * Split typed text into the pattern's three parts. Digits fill each part up to its length and then
 * move on to the next. A separator ends the current part early, which is how a one-digit day or
 * month is typed ("3/14/1957"). Anything else is ignored.
 */
const splitDateInput = (text: string, pattern: TDateInputPattern) => {
  const lengths = SEGMENT_LENGTHS[pattern.order];
  const segments = ['', '', ''];

  let index = 0;

  for (const character of text) {
    if (/\d/.test(character)) {
      if (segments[index].length === lengths[index]) {
        if (index === 2) {
          break;
        }

        index += 1;
      }

      segments[index] += character;
    } else if (DATE_PART_BREAK.test(character) && segments[index].length > 0 && index < 2) {
      index += 1;
    }
  }

  return { segments, index, lengths };
};

/**
 * Tidy a date as the signer types it: separators are put in for them, and anything that cannot be
 * part of the date is dropped.
 *
 * `isDeleting` is set when the signer removed characters. A separator is then not added after a
 * complete part, or Backspace could never get past it.
 */
export const formatDateInputDraft = (
  text: string,
  pattern: TDateInputPattern,
  isDeleting = false,
): string => {
  const { segments, index, lengths } = splitDateInput(text, pattern);

  let result = segments[0];

  for (let segmentIndex = 1; segmentIndex <= index; segmentIndex += 1) {
    result += pattern.separator + segments[segmentIndex];
  }

  if (!isDeleting && index < 2 && segments[index].length === lengths[index]) {
    result += pattern.separator;
  }

  return result;
};

/** Read a typed date, or null when it is not a whole, real date with a four-digit year. */
export const parseDateInput = (text: string, pattern: TDateInputPattern): TDateParts | null => {
  const { segments } = splitDateInput(text, pattern);

  const [first, second, third] = segments;

  const [yearText, monthText, dayText] =
    pattern.order === 'YMD'
      ? [first, second, third]
      : pattern.order === 'DMY'
        ? [third, second, first]
        : [third, first, second];

  if (yearText.length !== 4 || !monthText || !dayText) {
    return null;
  }

  const parts = { year: Number(yearText), month: Number(monthText), day: Number(dayText) };

  if (!DateTime.utc(parts.year, parts.month, parts.day).isValid) {
    return null;
  }

  return parts;
};

export const formatDateForInput = (date: TDateParts, pattern: TDateInputPattern) => {
  const year = String(date.year).padStart(4, '0');
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');

  const ordered =
    pattern.order === 'YMD'
      ? [year, month, day]
      : pattern.order === 'DMY'
        ? [day, month, year]
        : [month, day, year];

  return ordered.join(pattern.separator);
};

/**
 * The value to sign a DATE field with. Noon UTC, as the date picker sends, so the server's move
 * into the document's time zone never rolls it onto the day before or after.
 */
export const toSignableDate = (date: TDateParts): string =>
  DateTime.utc(date.year, date.month, date.day, 12, 0, 0).toISO() ?? '';

/** The date a DATE field was signed with, or null when its text cannot be read back. */
export const getSignedDateParts = (
  customText: string,
  dateFormat?: string | null,
  timeZone?: string | null,
): TDateParts | null => {
  if (!customText) {
    return null;
  }

  const parsed = parseSignedDateText(customText, dateFormat, timeZone);

  return parsed.isValid ? { year: parsed.year, month: parsed.month, day: parsed.day } : null;
};
