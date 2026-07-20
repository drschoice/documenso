import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { TFieldMetaSchema, TVisibilityBlock } from '../../types/field-meta';
import {
  addDependentRule,
  getFieldStableId,
  getTriggerOptionValues,
  hasDependentRule,
  operatorForTriggerType,
  removeDependentRule,
  removeRulesForTrigger,
  removeValuesFromRules,
  renameValueInRules,
  wouldCreateVisibilityCycle,
} from './authoring';
import { evaluateAllVisibility } from './evaluate';

const textDep = (stableId: string, visibility?: TVisibilityBlock): TFieldMetaSchema =>
  ({ type: 'text', stableId, ...(visibility ? { visibility } : {}) }) as TFieldMetaSchema;

const radioTrigger = (stableId: string, values: string[]): TFieldMetaSchema =>
  ({
    type: 'radio',
    stableId,
    values: values.map((value, i) => ({ id: i + 1, checked: false, value })),
  }) as TFieldMetaSchema;

const visibilityOf = (meta: TFieldMetaSchema): TVisibilityBlock | undefined =>
  (meta as { visibility?: TVisibilityBlock }).visibility;

describe('operatorForTriggerType', () => {
  it('maps checkbox → contains and radio/dropdown → equals', () => {
    expect(operatorForTriggerType(FieldType.CHECKBOX)).toBe('contains');
    expect(operatorForTriggerType(FieldType.RADIO)).toBe('equals');
    expect(operatorForTriggerType(FieldType.DROPDOWN)).toBe('equals');
  });
});

describe('getFieldStableId / getTriggerOptionValues', () => {
  it('reads stableId and option values', () => {
    const trigger = radioTrigger('radioA', ['Yes', 'No']);
    expect(getFieldStableId(trigger)).toBe('radioA');
    expect(getTriggerOptionValues(trigger)).toEqual(['Yes', 'No']);
    expect(getFieldStableId(undefined)).toBeNull();
    expect(getTriggerOptionValues(textDep('t'))).toEqual([]);
  });
});

describe('addDependentRule', () => {
  it('adds a rule with match:any', () => {
    const next = addDependentRule(textDep('dep1'), {
      triggerStableId: 'radioA',
      value: 'Yes',
      operator: 'equals',
    });
    expect(visibilityOf(next)).toEqual({
      match: 'any',
      rules: [{ operator: 'equals', triggerFieldStableId: 'radioA', value: 'Yes' }],
    });
    expect(hasDependentRule(next, 'radioA', 'Yes')).toBe(true);
  });

  it('preserves the field type and stableId', () => {
    const next = addDependentRule(textDep('dep1'), {
      triggerStableId: 'radioA',
      value: 'Yes',
      operator: 'equals',
    });
    expect((next as { type: string }).type).toBe('text');
    expect(getFieldStableId(next)).toBe('dep1');
  });

  it('is idempotent for a duplicate (trigger,value) and returns same reference', () => {
    const base = addDependentRule(textDep('dep1'), {
      triggerStableId: 'radioA',
      value: 'Yes',
      operator: 'equals',
    });
    const again = addDependentRule(base, {
      triggerStableId: 'radioA',
      value: 'Yes',
      operator: 'equals',
    });
    expect(again).toBe(base);
  });

  it('keeps rules for other triggers and forces match:any', () => {
    const withAll = textDep('dep1', {
      match: 'all',
      rules: [{ operator: 'equals', triggerFieldStableId: 'other', value: 'X' }],
    });
    const next = addDependentRule(withAll, {
      triggerStableId: 'radioA',
      value: 'Yes',
      operator: 'equals',
    });
    expect(visibilityOf(next)?.match).toBe('any');
    expect(visibilityOf(next)?.rules).toHaveLength(2);
  });

  it('does not add past the rule cap', () => {
    const rules = Array.from({ length: 10 }, (_, i) => ({
      operator: 'equals' as const,
      triggerFieldStableId: 'radioA',
      value: `v${i}`,
    }));
    const capped = textDep('dep1', { match: 'any', rules });
    const next = addDependentRule(capped, {
      triggerStableId: 'radioA',
      value: 'v10',
      operator: 'equals',
    });
    expect(next).toBe(capped);
  });
});

describe('removeDependentRule', () => {
  it('removes a rule and clears the block when it was the last', () => {
    const one = textDep('dep1', {
      match: 'any',
      rules: [{ operator: 'equals', triggerFieldStableId: 'radioA', value: 'Yes' }],
    });
    const next = removeDependentRule(one, { triggerStableId: 'radioA', value: 'Yes' });
    expect(visibilityOf(next)).toBeUndefined();
  });

  it('keeps other rules', () => {
    const two = textDep('dep1', {
      match: 'any',
      rules: [
        { operator: 'equals', triggerFieldStableId: 'radioA', value: 'Yes' },
        { operator: 'equals', triggerFieldStableId: 'radioA', value: 'No' },
      ],
    });
    const next = removeDependentRule(two, { triggerStableId: 'radioA', value: 'Yes' });
    expect(visibilityOf(next)?.rules).toEqual([
      { operator: 'equals', triggerFieldStableId: 'radioA', value: 'No' },
    ]);
  });
});

describe('cascade helpers', () => {
  it('renameValueInRules rewrites matching values only', () => {
    const dep = textDep('dep1', {
      match: 'any',
      rules: [
        { operator: 'equals', triggerFieldStableId: 'radioA', value: 'Old' },
        { operator: 'equals', triggerFieldStableId: 'radioB', value: 'Old' },
      ],
    });
    const next = renameValueInRules(dep, 'radioA', 'Old', 'New');
    expect(visibilityOf(next)?.rules).toEqual([
      { operator: 'equals', triggerFieldStableId: 'radioA', value: 'New' },
      { operator: 'equals', triggerFieldStableId: 'radioB', value: 'Old' },
    ]);
  });

  it('removeValuesFromRules drops matching values and clears empty blocks', () => {
    const dep = textDep('dep1', {
      match: 'any',
      rules: [{ operator: 'equals', triggerFieldStableId: 'radioA', value: 'Gone' }],
    });
    const next = removeValuesFromRules(dep, 'radioA', ['Gone']);
    expect(visibilityOf(next)).toBeUndefined();
  });

  it('removeRulesForTrigger drops all rules for the trigger (incl. empty operators)', () => {
    const dep = textDep('dep1', {
      match: 'any',
      rules: [
        { operator: 'equals', triggerFieldStableId: 'radioA', value: 'Yes' },
        { operator: 'isNotEmpty', triggerFieldStableId: 'radioA' },
        { operator: 'equals', triggerFieldStableId: 'radioB', value: 'Keep' },
      ],
    });
    const next = removeRulesForTrigger(dep, 'radioA');
    expect(visibilityOf(next)?.rules).toEqual([
      { operator: 'equals', triggerFieldStableId: 'radioB', value: 'Keep' },
    ]);
  });

  it('returns the same reference when nothing changes', () => {
    const dep = textDep('dep1', {
      match: 'any',
      rules: [{ operator: 'equals', triggerFieldStableId: 'radioA', value: 'Yes' }],
    });
    expect(renameValueInRules(dep, 'radioA', 'Missing', 'X')).toBe(dep);
    expect(removeValuesFromRules(dep, 'radioA', ['Missing'])).toBe(dep);
    expect(removeRulesForTrigger(dep, 'missingTrigger')).toBe(dep);
  });
});

describe('non-text dependents (signature/name/date)', () => {
  it('adds a visibility block onto a signature dependent meta', () => {
    const sig = { type: 'signature' } as TFieldMetaSchema;
    const next = addDependentRule(sig, {
      triggerStableId: 'radioA',
      value: 'Yes',
      operator: 'equals',
    });
    expect((next as { type: string }).type).toBe('signature');
    expect(visibilityOf(next)).toEqual({
      match: 'any',
      rules: [{ operator: 'equals', triggerFieldStableId: 'radioA', value: 'Yes' }],
    });
  });
});

describe('wouldCreateVisibilityCycle', () => {
  it('flags a direct self-reference', () => {
    expect(wouldCreateVisibilityCycle(new Map(), 'a', 'a')).toBe(true);
  });

  it('flags a 2-node cycle (trigger already depends on the dependent)', () => {
    // B currently reveals when A matches (B depends on A). Now trying to make A
    // reveal when B matches would close the loop A→B→A.
    const map = new Map<string, TFieldMetaSchema>([
      ['A', radioTrigger('A', ['x'])],
      ['B', textDep('B', { match: 'any', rules: [{ operator: 'equals', triggerFieldStableId: 'A', value: 'x' }] })],
    ]);
    expect(wouldCreateVisibilityCycle(map, /* dep */ 'A', /* trigger */ 'B')).toBe(true);
  });

  it('allows an acyclic addition', () => {
    const map = new Map<string, TFieldMetaSchema>([
      ['A', radioTrigger('A', ['x'])],
      ['B', textDep('B')],
    ]);
    // Making B reveal when A matches — A does not depend on B, so no cycle.
    expect(wouldCreateVisibilityCycle(map, 'B', 'A')).toBe(false);
  });

  it('flags a longer transitive cycle', () => {
    // C depends on B, B depends on A. Making A depend on C closes A→C→B→A.
    const map = new Map<string, TFieldMetaSchema>([
      ['A', radioTrigger('A', ['x'])],
      ['B', textDep('B', { match: 'any', rules: [{ operator: 'equals', triggerFieldStableId: 'A', value: 'x' }] })],
      ['C', textDep('C', { match: 'any', rules: [{ operator: 'equals', triggerFieldStableId: 'B', value: 'x' }] })],
    ]);
    expect(wouldCreateVisibilityCycle(map, 'A', 'C')).toBe(true);
  });
});

describe('round-trip through the evaluator', () => {
  it('a produced block reveals the dependent only for the selected radio option', () => {
    const trigger = radioTrigger('radioA', ['Yes', 'No']);
    const depMeta = addDependentRule(textDep('dep1'), {
      triggerStableId: 'radioA',
      value: 'No',
      operator: 'equals',
    });

    const evalFor = (customText: string) =>
      evaluateAllVisibility([
        // radio trigger: customText is the 0-based selected option index
        { id: 1, type: FieldType.RADIO, customText, inserted: true, fieldMeta: trigger },
        { id: 2, type: FieldType.TEXT, customText: '', inserted: false, fieldMeta: depMeta },
      ]).get(2);

    expect(evalFor('1')).toBe(true); // index 1 → "No" → visible
    expect(evalFor('0')).toBe(false); // index 0 → "Yes" → hidden
  });
});
