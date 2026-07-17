import { describe, expect, it } from 'vitest';

import {
  ZCheckboxFieldMeta,
  ZDateFieldMeta,
  ZDropdownFieldMeta,
  ZEmailFieldMeta,
  ZInitialsFieldMeta,
  ZNameFieldMeta,
  ZNumberFieldMeta,
  ZRadioFieldMeta,
  ZSignatureFieldMeta,
  ZTextFieldMeta,
  ZVisibilityBlock,
  getCombFieldCells,
} from './field-meta';

describe('field-meta visibility extension', () => {
  const validBlock = {
    match: 'all' as const,
    rules: [
      { operator: 'equals' as const, triggerFieldStableId: 'abc', value: 'Married' },
    ],
  };

  it('accepts stableId and visibility on text fields', () => {
    const parsed = ZTextFieldMeta.parse({
      type: 'text',
      stableId: 'xyz',
      visibility: validBlock,
    });
    expect(parsed.visibility).toEqual(validBlock);
    expect(parsed.stableId).toBe('xyz');
  });

  it.each([
    ['number', ZNumberFieldMeta],
    ['radio', ZRadioFieldMeta],
    ['checkbox', ZCheckboxFieldMeta],
    ['dropdown', ZDropdownFieldMeta],
  ])('accepts visibility on %s fields', (type, schema) => {
    expect(() =>
      schema.parse({ type, stableId: 'id1', visibility: validBlock }),
    ).not.toThrow();
  });

  it.each([
    ['signature', ZSignatureFieldMeta],
    ['date', ZDateFieldMeta],
    ['initials', ZInitialsFieldMeta],
    ['name', ZNameFieldMeta],
    ['email', ZEmailFieldMeta],
  ])('rejects visibility on %s fields', (type, schema) => {
    expect(() => schema.parse({ type, visibility: validBlock })).toThrow();
  });

  it('requires value when operator is equals', () => {
    expect(() =>
      ZVisibilityBlock.parse({
        match: 'all',
        rules: [{ operator: 'equals', triggerFieldStableId: 'abc' }],
      }),
    ).toThrow();
  });

  it.each([['isEmpty'], ['isNotEmpty']])(
    'rejects value when operator is %s',
    (operator) => {
      expect(() =>
        ZVisibilityBlock.parse({
          match: 'all',
          rules: [{ operator, triggerFieldStableId: 'abc', value: 'x' }],
        }),
      ).toThrow();
    },
  );

  it('requires at least one rule', () => {
    expect(() => ZVisibilityBlock.parse({ match: 'all', rules: [] })).toThrow();
  });

  it('rejects more than 10 rules', () => {
    const rules = Array.from({ length: 11 }, (_, i) => ({
      operator: 'equals' as const,
      triggerFieldStableId: `t${i}`,
      value: 'v',
    }));
    expect(() => ZVisibilityBlock.parse({ match: 'all', rules })).toThrow();
  });

  it('accepts match any', () => {
    expect(() =>
      ZVisibilityBlock.parse({
        match: 'any',
        rules: [{ operator: 'equals', triggerFieldStableId: 'abc', value: 'x' }],
      }),
    ).not.toThrow();
  });

  it('rejects empty triggerFieldStableId', () => {
    expect(() =>
      ZVisibilityBlock.parse({
        match: 'all',
        rules: [{ operator: 'equals', triggerFieldStableId: '', value: 'x' }],
      }),
    ).toThrow();
  });
});

describe('field-meta comb extension', () => {
  const validCells = [{ id: 1 }, { id: 2, offsetX: 1.5, offsetY: 2 }];

  it.each([
    ['text', ZTextFieldMeta],
    ['number', ZNumberFieldMeta],
  ])('accepts comb layout, cells and cellSize on %s fields', (type, schema) => {
    const parsed = schema.parse({
      type,
      layout: 'cells',
      cells: validCells,
      cellSize: 18,
    });

    expect(parsed.layout).toBe('cells');
    expect(parsed.cells).toEqual(validCells);
    expect(parsed.cellSize).toBe(18);
  });

  it('rejects more than 100 cells', () => {
    const cells = Array.from({ length: 101 }, (_, i) => ({ id: i + 1 }));

    expect(() => ZTextFieldMeta.parse({ type: 'text', layout: 'cells', cells })).toThrow();
  });

  it.each([[3], [97]])('rejects cellSize out of bounds (%s)', (cellSize) => {
    expect(() => ZTextFieldMeta.parse({ type: 'text', cellSize })).toThrow();
  });

  it.each([[-101], [101]])('rejects cell offsets out of bounds (%s)', (offset) => {
    expect(() =>
      ZTextFieldMeta.parse({
        type: 'text',
        cells: [{ id: 1, offsetX: offset, offsetY: 0 }],
      }),
    ).toThrow();
  });

  it('returns the cells for comb text/number metas', () => {
    expect(getCombFieldCells({ type: 'text', layout: 'cells', cells: validCells })).toEqual(
      validCells,
    );
    expect(getCombFieldCells({ type: 'number', layout: 'cells', cells: validCells })).toEqual(
      validCells,
    );
  });

  it('returns null when the field is not in comb layout', () => {
    expect(getCombFieldCells({ type: 'text', cells: validCells })).toBeNull();
    expect(getCombFieldCells({ type: 'text', layout: 'box', cells: validCells })).toBeNull();
    expect(getCombFieldCells({ type: 'text', layout: 'cells', cells: [] })).toBeNull();
    expect(getCombFieldCells({ type: 'text', layout: 'cells' })).toBeNull();
    expect(getCombFieldCells({ type: 'radio', layout: 'free', direction: 'vertical' })).toBeNull();
    expect(getCombFieldCells(undefined)).toBeNull();
    expect(getCombFieldCells(null)).toBeNull();
  });
});
