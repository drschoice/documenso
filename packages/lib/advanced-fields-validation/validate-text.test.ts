import { describe, expect, it } from 'vitest';

import type { TTextFieldMeta } from '../types/field-meta';
import { validateTextField } from './validate-text';

describe('validateTextField comb layout', () => {
  const combMeta: TTextFieldMeta = {
    type: 'text',
    layout: 'cells',
    cells: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
  };

  it('accepts a value that fits the cells', () => {
    expect(validateTextField('12345', combMeta, true)).toEqual([]);
  });

  it('rejects a value longer than the cell count', () => {
    const errors = validateTextField('123456', combMeta, true);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('exceeds the character limit (5)');
  });

  it('uses the cell count over the character limit when comb is enabled', () => {
    const meta: TTextFieldMeta = { ...combMeta, characterLimit: 100 };

    expect(validateTextField('123456', meta, true)).toHaveLength(1);
    expect(validateTextField('12345', meta, true)).toEqual([]);
  });

  it('uses the character limit when the layout is not comb', () => {
    const meta: TTextFieldMeta = {
      type: 'text',
      layout: 'box',
      cells: [{ id: 1 }, { id: 2 }],
      characterLimit: 10,
    };

    expect(validateTextField('123', meta, true)).toEqual([]);
    expect(validateTextField('12345678901', meta, true)).toHaveLength(1);
  });
});
