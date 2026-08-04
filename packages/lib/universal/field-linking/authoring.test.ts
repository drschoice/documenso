import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { TFieldMetaSchema } from '../../types/field-meta';
import {
  addToLinkGroup,
  getLinkGroupId,
  getLinkGroupMembers,
  getOrphanLinkGroupIds,
  isLinkEligibleType,
  pruneOrphanLinkGroups,
  removeFromLinkGroup,
} from './authoring';

const textMeta = (over: Record<string, unknown> = {}): TFieldMetaSchema =>
  ({ type: 'text', ...over }) as TFieldMetaSchema;

const numberMeta = (over: Record<string, unknown> = {}): TFieldMetaSchema =>
  ({ type: 'number', ...over }) as TFieldMetaSchema;

const field = (formId: string, fieldMeta: TFieldMetaSchema) => ({ formId, fieldMeta });

describe('isLinkEligibleType', () => {
  it('allows TEXT and NUMBER only', () => {
    expect(isLinkEligibleType(FieldType.TEXT)).toBe(true);
    expect(isLinkEligibleType(FieldType.NUMBER)).toBe(true);
    expect(isLinkEligibleType(FieldType.SIGNATURE)).toBe(false);
    expect(isLinkEligibleType(FieldType.RADIO)).toBe(false);
  });
});

describe('getLinkGroupId', () => {
  it('returns the id when present and non-empty, else null', () => {
    expect(getLinkGroupId(textMeta({ linkGroupId: 'g1' }))).toBe('g1');
    expect(getLinkGroupId(textMeta({ linkGroupId: '' }))).toBeNull();
    expect(getLinkGroupId(textMeta())).toBeNull();
    expect(getLinkGroupId(undefined)).toBeNull();
  });
});

describe('getLinkGroupMembers', () => {
  it('returns only fields sharing the group id, in order', () => {
    const fields = [
      field('a', textMeta({ linkGroupId: 'g1' })),
      field('b', textMeta({ linkGroupId: 'g2' })),
      field('c', textMeta({ linkGroupId: 'g1' })),
      field('d', textMeta()),
    ];

    expect(getLinkGroupMembers(fields, 'g1').map((f) => f.formId)).toEqual(['a', 'c']);
    expect(getLinkGroupMembers(fields, 'missing')).toEqual([]);
  });
});

describe('addToLinkGroup', () => {
  it('assigns the group id to both source and member', () => {
    const { sourceMeta, memberMeta } = addToLinkGroup(textMeta(), textMeta(), 'g1');

    expect(getLinkGroupId(sourceMeta)).toBe('g1');
    expect(getLinkGroupId(memberMeta)).toBe('g1');
  });

  it('copies text character-limit constraints onto the new member', () => {
    const { memberMeta } = addToLinkGroup(
      textMeta({ characterLimit: 9 }),
      textMeta({ characterLimit: 3 }),
      'g1',
    );

    expect((memberMeta as { characterLimit?: number }).characterLimit).toBe(9);
  });

  it('copies number min/max/format constraints onto the new member', () => {
    const { memberMeta } = addToLinkGroup(
      numberMeta({ minValue: 1, maxValue: 100, numberFormat: '0,0' }),
      numberMeta({ minValue: 5, maxValue: 6 }),
      'g1',
    );

    expect(memberMeta).toMatchObject({ minValue: 1, maxValue: 100, numberFormat: '0,0' });
  });

  it('does not mutate the inputs', () => {
    const source = textMeta({ characterLimit: 4 });
    const member = textMeta();

    addToLinkGroup(source, member, 'g1');

    expect(getLinkGroupId(source)).toBeNull();
    expect(getLinkGroupId(member)).toBeNull();
  });
});

describe('removeFromLinkGroup', () => {
  it('clears the group id', () => {
    expect(getLinkGroupId(removeFromLinkGroup(textMeta({ linkGroupId: 'g1' })))).toBeNull();
  });

  it('returns the same reference when there was no group', () => {
    const meta = textMeta();
    expect(removeFromLinkGroup(meta)).toBe(meta);
  });
});

describe('getOrphanLinkGroupIds / pruneOrphanLinkGroups', () => {
  it('flags groups with fewer than two members', () => {
    const fields = [
      field('a', textMeta({ linkGroupId: 'g1' })),
      field('b', textMeta({ linkGroupId: 'g1' })),
      field('c', textMeta({ linkGroupId: 'lonely' })),
    ];

    expect([...getOrphanLinkGroupIds(fields)]).toEqual(['lonely']);
  });

  it('clears linkGroupId on a lone survivor and leaves valid groups intact', () => {
    const fields = [
      field('a', textMeta({ linkGroupId: 'g1' })),
      field('b', textMeta({ linkGroupId: 'g1' })),
      field('c', textMeta({ linkGroupId: 'lonely' })),
    ];

    const pruned = pruneOrphanLinkGroups(fields);

    expect(getLinkGroupId(pruned.find((f) => f.formId === 'c')!.fieldMeta)).toBeNull();
    expect(getLinkGroupId(pruned.find((f) => f.formId === 'a')!.fieldMeta)).toBe('g1');
    expect(getLinkGroupId(pruned.find((f) => f.formId === 'b')!.fieldMeta)).toBe('g1');
  });

  it('returns the same array reference when there is nothing to prune', () => {
    const fields = [
      field('a', textMeta({ linkGroupId: 'g1' })),
      field('b', textMeta({ linkGroupId: 'g1' })),
    ];

    expect(pruneOrphanLinkGroups(fields)).toBe(fields);
  });
});
