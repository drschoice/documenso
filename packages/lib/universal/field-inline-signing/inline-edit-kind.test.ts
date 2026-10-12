import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { TFieldMetaSchema } from '../../types/field-meta';
import { getInlineEditKind } from './inline-edit-kind';

const meta = (value: Record<string, unknown>) => value as TFieldMetaSchema;

describe('getInlineEditKind', () => {
  it('types text and number fields in place', () => {
    expect(getInlineEditKind({ type: FieldType.TEXT, fieldMeta: meta({ type: 'text' }) })).toBe(
      'text',
    );
    expect(getInlineEditKind({ type: FieldType.NUMBER, fieldMeta: null })).toBe('text');
  });

  it('types name, email and initials in place', () => {
    expect(getInlineEditKind({ type: FieldType.NAME })).toBe('text');
    expect(getInlineEditKind({ type: FieldType.EMAIL })).toBe('text');
    expect(getInlineEditKind({ type: FieldType.INITIALS })).toBe('text');
  });

  it('types comb fields into their cells', () => {
    expect(
      getInlineEditKind({
        type: FieldType.TEXT,
        fieldMeta: meta({ type: 'text', layout: 'cells', cells: [{ id: 0 }] }),
      }),
    ).toBe('comb');

    expect(
      getInlineEditKind({
        type: FieldType.NUMBER,
        fieldMeta: meta({ type: 'number', layout: 'cells', cells: [{ id: 0 }] }),
      }),
    ).toBe('comb');
  });

  it('still uses the text box when a cells layout has no cells', () => {
    expect(
      getInlineEditKind({
        type: FieldType.TEXT,
        fieldMeta: meta({ type: 'text', layout: 'cells', cells: [] }),
      }),
    ).toBe('text');
  });

  it('fills date and dropdown fields in place', () => {
    expect(getInlineEditKind({ type: FieldType.DATE })).toBe('date');
    expect(getInlineEditKind({ type: FieldType.DROPDOWN })).toBe('dropdown');
  });

  it('leaves every other field type to its click handler', () => {
    for (const type of [
      FieldType.SIGNATURE,
      FieldType.FREE_SIGNATURE,
      FieldType.CHECKBOX,
      FieldType.RADIO,
    ]) {
      expect(getInlineEditKind({ type })).toBeNull();
    }
  });
});
