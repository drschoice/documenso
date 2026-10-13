import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { TFieldMetaSchema } from '../../types/field-meta';
import { getFieldsWrittenBySign } from './optimistic-insertion';

const makeField = (
  id: number,
  type: FieldType,
  meta: Record<string, unknown> = {},
  recipientId = 1,
) => ({
  id,
  type,
  recipientId,
  fieldMeta: { type: type === FieldType.NUMBER ? 'number' : 'text', ...meta } as TFieldMetaSchema,
});

const ids = (fields: Array<{ id: number }>) => fields.map((f) => f.id);

describe('getFieldsWrittenBySign', () => {
  it('writes only the signed field when it is not linked', () => {
    const fields = [makeField(1, FieldType.TEXT), makeField(2, FieldType.TEXT)];

    expect(ids(getFieldsWrittenBySign(fields, fields[0]))).toEqual([1]);
  });

  it('writes every editable member of the link group, signed field first', () => {
    const fields = [
      makeField(1, FieldType.TEXT, { linkGroupId: 'g' }),
      makeField(2, FieldType.TEXT, { linkGroupId: 'g' }),
      makeField(3, FieldType.TEXT, { linkGroupId: 'other' }),
      makeField(4, FieldType.TEXT, { linkGroupId: 'g' }),
    ];

    expect(ids(getFieldsWrittenBySign(fields, fields[1]))).toEqual([2, 1, 4]);
  });

  it('leaves read-only members alone', () => {
    const fields = [
      makeField(1, FieldType.NUMBER, { linkGroupId: 'g' }),
      makeField(2, FieldType.NUMBER, { linkGroupId: 'g', readOnly: true, value: '5' }),
    ];

    expect(ids(getFieldsWrittenBySign(fields, fields[0]))).toEqual([1]);
  });

  it("ignores another recipient's fields in the same group", () => {
    const fields = [
      makeField(1, FieldType.TEXT, { linkGroupId: 'g' }, 1),
      makeField(2, FieldType.TEXT, { linkGroupId: 'g' }, 2),
    ];

    expect(ids(getFieldsWrittenBySign(fields, fields[0]))).toEqual([1]);
  });

  it('never fans out from a type that cannot be linked', () => {
    const fields = [
      { id: 1, type: FieldType.NAME, recipientId: 1, fieldMeta: { linkGroupId: 'g' } },
      makeField(2, FieldType.TEXT, { linkGroupId: 'g' }),
    ] as Array<ReturnType<typeof makeField>>;

    expect(ids(getFieldsWrittenBySign(fields, fields[0]))).toEqual([1]);
  });
});
