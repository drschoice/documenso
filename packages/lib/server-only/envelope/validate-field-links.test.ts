import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { validateFieldLinks } from './validate-field-links';

const field = (
  overrides: Partial<Parameters<typeof validateFieldLinks>[0]['fields'][number]>,
) => ({
  id: 1,
  type: FieldType.TEXT,
  recipientId: 1,
  fieldMeta: null as unknown,
  ...overrides,
});

describe('validateFieldLinks', () => {
  it('passes when no fields are linked', () => {
    expect(validateFieldLinks({ fields: [field({ id: 1 }), field({ id: 2 })] }).ok).toBe(true);
  });

  it('passes for a same-recipient, same-type group', () => {
    const result = validateFieldLinks({
      fields: [
        field({ id: 1, fieldMeta: { type: 'text', linkGroupId: 'g1' } }),
        field({ id: 2, fieldMeta: { type: 'text', linkGroupId: 'g1' } }),
      ],
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a group that spans recipients', () => {
    const result = validateFieldLinks({
      fields: [
        field({ id: 1, recipientId: 1, fieldMeta: { type: 'text', linkGroupId: 'g1' } }),
        field({ id: 2, recipientId: 2, fieldMeta: { type: 'text', linkGroupId: 'g1' } }),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('FIELD_LINK_CROSS_RECIPIENT');
  });

  it('rejects a group with mixed field types', () => {
    const result = validateFieldLinks({
      fields: [
        field({ id: 1, type: FieldType.TEXT, fieldMeta: { type: 'text', linkGroupId: 'g1' } }),
        field({ id: 2, type: FieldType.NUMBER, fieldMeta: { type: 'number', linkGroupId: 'g1' } }),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('FIELD_LINK_TYPE_MISMATCH');
  });

  it('ignores a single-member group (harmless; pruned client-side)', () => {
    const result = validateFieldLinks({
      fields: [field({ id: 1, fieldMeta: { type: 'text', linkGroupId: 'solo' } })],
    });

    expect(result.ok).toBe(true);
  });
});
