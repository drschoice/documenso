import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { TFieldMetaSchema } from '../../types/field-meta';
import {
  type TInlineCommitField,
  getInlineCharacterLimit,
  getInlineInitialText,
  resolveInlineCommit,
} from './resolve-inline-commit';

const field = (
  type: FieldType,
  fieldMeta?: Record<string, unknown>,
  filled?: string,
): TInlineCommitField => ({
  type,
  inserted: filled !== undefined,
  customText: filled ?? '',
  fieldMeta: fieldMeta as TFieldMetaSchema | undefined,
});

const cells = (count: number) => Array.from({ length: count }, (_, id) => ({ id }));

describe('resolveInlineCommit', () => {
  describe('empty and unchanged values', () => {
    it('sends nothing when an empty field is left empty', () => {
      expect(resolveInlineCommit(field(FieldType.TEXT, { type: 'text' }), '')).toEqual({
        action: 'noop',
      });
    });

    it('treats whitespace-only input as empty', () => {
      expect(resolveInlineCommit(field(FieldType.TEXT, { type: 'text' }), '   \n ')).toEqual({
        action: 'noop',
      });
    });

    it('clears a filled field that was emptied, with null rather than an empty string', () => {
      expect(resolveInlineCommit(field(FieldType.TEXT, { type: 'text' }, 'Smith'), '')).toEqual({
        action: 'sign',
        value: null,
      });

      expect(resolveInlineCommit(field(FieldType.NUMBER, { type: 'number' }, '42'), ' ')).toEqual({
        action: 'sign',
        value: null,
      });
    });

    it('sends nothing when a filled field is left unchanged', () => {
      expect(resolveInlineCommit(field(FieldType.TEXT, { type: 'text' }, 'Smith'), 'Smith')).toEqual(
        { action: 'noop' },
      );
    });

    it('compares against the trimmed value', () => {
      expect(
        resolveInlineCommit(field(FieldType.TEXT, { type: 'text' }, 'Smith'), '  Smith '),
      ).toEqual({ action: 'noop' });
    });
  });

  describe('TEXT', () => {
    it('sends the trimmed value', () => {
      expect(resolveInlineCommit(field(FieldType.TEXT, { type: 'text' }), '  12 Main St ')).toEqual(
        { action: 'sign', value: '12 Main St' },
      );
    });

    it('accepts a field that has no meta', () => {
      expect(resolveInlineCommit(field(FieldType.TEXT), 'hello')).toEqual({
        action: 'sign',
        value: 'hello',
      });
    });

    it('rejects a value over the character limit', () => {
      expect(
        resolveInlineCommit(field(FieldType.TEXT, { type: 'text', characterLimit: 3 }), 'abcd'),
      ).toEqual({ action: 'invalid', error: { code: 'TOO_LONG', limit: 3 } });
    });

    it('uses the cell count as the limit of a comb field', () => {
      const meta = { type: 'text', layout: 'cells', cells: cells(2), characterLimit: 10 };

      expect(resolveInlineCommit(field(FieldType.TEXT, meta), 'abc')).toEqual({
        action: 'invalid',
        error: { code: 'TOO_LONG', limit: 2 },
      });
    });
  });

  describe('NUMBER', () => {
    it('sends a valid number', () => {
      expect(resolveInlineCommit(field(FieldType.NUMBER, { type: 'number' }), '1,250.50')).toEqual({
        action: 'sign',
        value: '1,250.50',
      });
    });

    it('rejects something that is not a number', () => {
      expect(resolveInlineCommit(field(FieldType.NUMBER, { type: 'number' }), '12a')).toEqual({
        action: 'invalid',
        error: { code: 'INVALID_NUMBER' },
      });
    });

    it('rejects a value that does not match the number format', () => {
      const meta = { type: 'number', numberFormat: '123,456,789.00' };

      expect(resolveInlineCommit(field(FieldType.NUMBER, meta), '1234,5')).toEqual({
        action: 'invalid',
        error: { code: 'NUMBER_FORMAT', format: '123,456,789.00' },
      });
    });

    it('rejects values outside the minimum and maximum', () => {
      const meta = { type: 'number', minValue: 10, maxValue: 20 };

      expect(resolveInlineCommit(field(FieldType.NUMBER, meta), '5')).toEqual({
        action: 'invalid',
        error: { code: 'NUMBER_TOO_SMALL', min: 10 },
      });

      expect(resolveInlineCommit(field(FieldType.NUMBER, meta), '25')).toEqual({
        action: 'invalid',
        error: { code: 'NUMBER_TOO_LARGE', max: 20 },
      });

      expect(resolveInlineCommit(field(FieldType.NUMBER, meta), '15')).toEqual({
        action: 'sign',
        value: '15',
      });
    });

    it('ignores a minimum of zero, as the server does', () => {
      const meta = { type: 'number', minValue: 0, maxValue: 0 };

      expect(resolveInlineCommit(field(FieldType.NUMBER, meta), '99')).toEqual({
        action: 'sign',
        value: '99',
      });
    });
  });

  describe('EMAIL, NAME and INITIALS', () => {
    it('rejects an invalid email address', () => {
      expect(resolveInlineCommit(field(FieldType.EMAIL), 'not-an-email')).toEqual({
        action: 'invalid',
        error: { code: 'INVALID_EMAIL' },
      });
    });

    it('sends a valid email address', () => {
      expect(resolveInlineCommit(field(FieldType.EMAIL), ' jane@example.com ')).toEqual({
        action: 'sign',
        value: 'jane@example.com',
      });
    });

    it('accepts any non-empty name or initials', () => {
      expect(resolveInlineCommit(field(FieldType.NAME), 'Jane Q Public')).toEqual({
        action: 'sign',
        value: 'Jane Q Public',
      });

      expect(resolveInlineCommit(field(FieldType.INITIALS), 'JQP')).toEqual({
        action: 'sign',
        value: 'JQP',
      });
    });
  });
});

describe('resolveInlineCommit for dates', () => {
  const options = { dateFormat: 'MM/dd/yyyy hh:mm a', timeZone: 'Etc/UTC' };

  it('signs a typed date as noon UTC on that day', () => {
    expect(resolveInlineCommit(field(FieldType.DATE), '03/14/1957', options)).toEqual({
      action: 'sign',
      value: '1957-03-14T12:00:00.000Z',
    });
  });

  it('rejects a date that is not finished, naming the pattern', () => {
    expect(resolveInlineCommit(field(FieldType.DATE), '03/14', options)).toEqual({
      action: 'invalid',
      error: { code: 'INVALID_DATE', format: 'MM/DD/YYYY' },
    });
  });

  it('treats the signed date, shown in the typing pattern, as unchanged', () => {
    const signed = field(FieldType.DATE, { type: 'date' }, '03/14/1957 12:00 PM');

    expect(resolveInlineCommit(signed, '03/14/1957', options)).toEqual({ action: 'noop' });
  });

  it('clears a signed date that was emptied', () => {
    const signed = field(FieldType.DATE, { type: 'date' }, '03/14/1957 12:00 PM');

    expect(resolveInlineCommit(signed, '', options)).toEqual({ action: 'sign', value: null });
  });
});

describe('resolveInlineCommit for dropdowns', () => {
  const meta = { type: 'dropdown', values: [{ value: 'Single' }, { value: 'Married' }] };

  it('signs one of the options', () => {
    expect(resolveInlineCommit(field(FieldType.DROPDOWN, meta), 'Married')).toEqual({
      action: 'sign',
      value: 'Married',
    });
  });

  it('rejects anything else', () => {
    expect(resolveInlineCommit(field(FieldType.DROPDOWN, meta), 'Divorced')).toEqual({
      action: 'invalid',
      error: { code: 'INVALID_OPTION' },
    });
  });

  it('clears a chosen option', () => {
    expect(resolveInlineCommit(field(FieldType.DROPDOWN, meta, 'Single'), '')).toEqual({
      action: 'sign',
      value: null,
    });
  });
});

describe('getInlineInitialText', () => {
  it('shows a signed date in the typing pattern', () => {
    expect(
      getInlineInitialText(field(FieldType.DATE, { type: 'date' }, 'March 14, 1957'), {
        dateFormat: 'MMMM dd, yyyy',
        timeZone: 'Etc/UTC',
      }),
    ).toBe('03/14/1957');
  });

  it('shows a date it cannot read back as stored', () => {
    expect(
      getInlineInitialText(field(FieldType.DATE, { type: 'date' }, 'garbled'), {
        dateFormat: 'yyyy-MM-dd',
      }),
    ).toBe('garbled');
  });

  it('starts empty for a field that is not filled', () => {
    expect(getInlineInitialText(field(FieldType.TEXT, { type: 'text' }))).toBe('');
  });
});

describe('getInlineCharacterLimit', () => {
  it('returns the text character limit', () => {
    expect(getInlineCharacterLimit(field(FieldType.TEXT, { type: 'text', characterLimit: 8 }))).toBe(
      8,
    );
  });

  it('treats a zero limit as no limit', () => {
    expect(
      getInlineCharacterLimit(field(FieldType.TEXT, { type: 'text', characterLimit: 0 })),
    ).toBeUndefined();
  });

  it('returns the cell count of a comb field, text or number', () => {
    expect(
      getInlineCharacterLimit(
        field(FieldType.NUMBER, { type: 'number', layout: 'cells', cells: cells(4) }),
      ),
    ).toBe(4);
  });

  it('has no limit for a number field in box layout', () => {
    expect(getInlineCharacterLimit(field(FieldType.NUMBER, { type: 'number' }))).toBeUndefined();
  });
});
