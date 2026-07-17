import { describe, expect, it } from 'vitest';

import type { TNumberFieldMeta } from '../types/field-meta';
import { validateNumberField } from './validate-number';

describe('validateNumberField comb layout', () => {
  const combMeta: TNumberFieldMeta = {
    type: 'number',
    layout: 'cells',
    cells: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
  };

  it('accepts a value that fits the cells', () => {
    expect(validateNumberField('1234', combMeta, true)).toEqual([]);
  });

  it('rejects a value longer than the cell count', () => {
    const errors = validateNumberField('12345', combMeta, true);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('exceeds the number of cells (4)');
  });

  it('counts number format separators towards the cell count', () => {
    const meta: TNumberFieldMeta = {
      ...combMeta,
      numberFormat: '123,456,789.00',
    };

    // '1,234.00' is 8 characters but there are only 4 cells.
    const errors = validateNumberField('1,234.00', meta, true);

    expect(errors.some((error) => error.includes('exceeds the number of cells (4)'))).toBe(true);
  });

  it('ignores the cell count when the layout is not comb', () => {
    const meta: TNumberFieldMeta = {
      type: 'number',
      layout: 'box',
      cells: [{ id: 1 }, { id: 2 }],
    };

    expect(validateNumberField('12345', meta, true)).toEqual([]);
  });
});
