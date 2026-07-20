import { FieldType } from '@prisma/client';

import type { TFieldMetaSchema, TVisibilityBlock, TVisibilityRule } from '../../types/field-meta';

/**
 * Trigger-centric conditional-visibility authoring helpers.
 *
 * The storage model is dependent-centric: each DEPENDENT field carries a
 * `fieldMeta.visibility` block whose rules reference a TRIGGER field by the
 * trigger's `fieldMeta.stableId`. These pure helpers let the trigger-centric
 * editor UI ("when this radio's option X is selected, show these fields") read
 * and write those per-dependent blocks without touching Konva or React, so the
 * same logic backs the sidebar section, the canvas pick-mode toggle, and the
 * cascade cleanups (option rename/delete, trigger delete).
 *
 * Rules always store the option's `value` STRING (consistent with the
 * evaluator, which resolves a radio's selected index / checkbox indices back to
 * option values). See ./evaluate.ts.
 */

export type DependentOperator = 'equals' | 'contains';

/**
 * Field types that can be a DEPENDENT (conditionally shown/hidden) — i.e. whose
 * meta schema can carry a `visibility` block. Excludes FREE_SIGNATURE, whose
 * meta is always `undefined`.
 */
export const VISIBILITY_ELIGIBLE_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  FieldType.TEXT,
  FieldType.NUMBER,
  FieldType.RADIO,
  FieldType.CHECKBOX,
  FieldType.DROPDOWN,
  FieldType.SIGNATURE,
  FieldType.INITIALS,
  FieldType.NAME,
  FieldType.EMAIL,
  FieldType.DATE,
]);

/** Option-based field types that can act as a trigger in the trigger-centric UI. */
export const VISIBILITY_TRIGGER_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  FieldType.RADIO,
  FieldType.CHECKBOX,
  FieldType.DROPDOWN,
]);

/** Max rules a single dependent's visibility block may hold (matches ZVisibilityBlock). */
export const MAX_VISIBILITY_RULES = 10;

/**
 * The operator a dependent rule uses for a given trigger type.
 * - checkbox is multi-select → membership test (`contains`)
 * - radio / dropdown are single-value → `equals`
 */
export const operatorForTriggerType = (type: FieldType): DependentOperator =>
  type === FieldType.CHECKBOX ? 'contains' : 'equals';

const asRecord = (meta: TFieldMetaSchema): Record<string, unknown> =>
  ({ ...(meta as Record<string, unknown> | undefined) }) as Record<string, unknown>;

const getVisibility = (meta: TFieldMetaSchema): TVisibilityBlock | undefined => {
  const m = meta as { visibility?: TVisibilityBlock } | undefined;
  return m?.visibility;
};

const isValueRule = (rule: TVisibilityRule): rule is Extract<TVisibilityRule, { value: string }> =>
  'value' in rule;

/** Returns the field's own `stableId`, or null when absent / meta unset. */
export const getFieldStableId = (meta: TFieldMetaSchema): string | null => {
  const m = meta as { stableId?: unknown } | undefined;
  return m && typeof m.stableId === 'string' ? m.stableId : null;
};

/** The selectable option values of a trigger field (radio/checkbox/dropdown), in order. */
export const getTriggerOptionValues = (meta: TFieldMetaSchema): string[] => {
  if (!meta) {
    return [];
  }

  if (meta.type === 'radio' || meta.type === 'checkbox' || meta.type === 'dropdown') {
    return (meta.values ?? []).map((v) => v.value);
  }

  return [];
};

/** Whether the dependent already reveals for the (trigger, value) pair. */
export const hasDependentRule = (
  meta: TFieldMetaSchema,
  triggerStableId: string,
  value: string,
): boolean => {
  const block = getVisibility(meta);

  if (!block) {
    return false;
  }

  return block.rules.some(
    (r) => r.triggerFieldStableId === triggerStableId && isValueRule(r) && r.value === value,
  );
};

/**
 * Write `rules` back onto the meta with the given match mode. When `rules` is
 * empty the `visibility` key is removed entirely (the block requires ≥1 rule),
 * so the dependent renders unconditionally and its editor stripes disappear.
 */
const rebuildVisibility = (
  meta: TFieldMetaSchema,
  rules: TVisibilityRule[],
  match: TVisibilityBlock['match'],
): TFieldMetaSchema => {
  const record = asRecord(meta);

  if (rules.length === 0) {
    delete record.visibility;
  } else {
    record.visibility = { match, rules } satisfies TVisibilityBlock;
  }

  return record as TFieldMetaSchema;
};

/**
 * Ensure the dependent reveals for (trigger, value). New/updated blocks are
 * forced to `match: 'any'` — each PandaDoc-style condition independently
 * reveals. Returns the meta UNCHANGED (same reference) when the rule already
 * exists, when there is no typed meta to attach to, or when the block is at the
 * rule cap (so callers can detect the no-op).
 */
export const addDependentRule = (
  meta: TFieldMetaSchema,
  {
    triggerStableId,
    value,
    operator,
  }: { triggerStableId: string; value: string; operator: DependentOperator },
): TFieldMetaSchema => {
  if (!meta) {
    return meta;
  }

  if (hasDependentRule(meta, triggerStableId, value)) {
    return meta;
  }

  const block = getVisibility(meta);
  const existing = block?.rules ?? [];

  if (existing.length >= MAX_VISIBILITY_RULES) {
    return meta;
  }

  const rules: TVisibilityRule[] = [
    ...existing,
    { operator, triggerFieldStableId: triggerStableId, value },
  ];

  return rebuildVisibility(meta, rules, 'any');
};

/** Remove the single (trigger, value) rule; clears the block when it was the last. */
export const removeDependentRule = (
  meta: TFieldMetaSchema,
  { triggerStableId, value }: { triggerStableId: string; value: string },
): TFieldMetaSchema => {
  const block = getVisibility(meta);

  if (!meta || !block) {
    return meta;
  }

  const rules = block.rules.filter(
    (r) => !(r.triggerFieldStableId === triggerStableId && isValueRule(r) && r.value === value),
  );

  if (rules.length === block.rules.length) {
    return meta;
  }

  return rebuildVisibility(meta, rules, block.match);
};

/**
 * Cascade for an option RENAME on a trigger: rewrite every dependent rule that
 * referenced `oldValue` for this trigger to `newValue`. Prevents the stale
 * `value` from failing `FIELD_VISIBILITY_VALUE_INVALID` on the next save.
 */
export const renameValueInRules = (
  meta: TFieldMetaSchema,
  triggerStableId: string,
  oldValue: string,
  newValue: string,
): TFieldMetaSchema => {
  const block = getVisibility(meta);

  if (!meta || !block || oldValue === newValue) {
    return meta;
  }

  let changed = false;

  const rules = block.rules.map((r) => {
    if (r.triggerFieldStableId === triggerStableId && isValueRule(r) && r.value === oldValue) {
      changed = true;
      return { ...r, value: newValue };
    }

    return r;
  });

  return changed ? rebuildVisibility(meta, rules, block.match) : meta;
};

/**
 * Cascade for option DELETE(s) on a trigger: drop every dependent rule that
 * referenced one of the removed values for this trigger.
 */
export const removeValuesFromRules = (
  meta: TFieldMetaSchema,
  triggerStableId: string,
  removedValues: string[],
): TFieldMetaSchema => {
  const block = getVisibility(meta);

  if (!meta || !block || removedValues.length === 0) {
    return meta;
  }

  const removed = new Set(removedValues);

  const rules = block.rules.filter(
    (r) => !(r.triggerFieldStableId === triggerStableId && isValueRule(r) && removed.has(r.value)),
  );

  if (rules.length === block.rules.length) {
    return meta;
  }

  return rebuildVisibility(meta, rules, block.match);
};

/**
 * Would revealing the dependent (`dependentStableId`) when the trigger
 * (`triggerStableId`) matches introduce a circular dependency?
 *
 * Adding that condition makes the dependent depend on the trigger. A cycle
 * exists iff the trigger already (transitively) depends on the dependent — so
 * we walk the trigger's existing visibility chain looking for the dependent.
 * `metaByStableId` maps every stableId-bearing field to its meta.
 */
export const wouldCreateVisibilityCycle = (
  metaByStableId: Map<string, TFieldMetaSchema>,
  dependentStableId: string,
  triggerStableId: string,
): boolean => {
  if (dependentStableId === triggerStableId) {
    return true;
  }

  const visited = new Set<string>();
  const stack = [triggerStableId];

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === undefined || visited.has(current)) {
      continue;
    }

    if (current === dependentStableId) {
      return true;
    }

    visited.add(current);

    const block = getVisibility(metaByStableId.get(current));

    if (block) {
      for (const rule of block.rules) {
        stack.push(rule.triggerFieldStableId);
      }
    }
  }

  return false;
};

/**
 * Cascade for TRIGGER deletion: drop every dependent rule referencing the
 * deleted trigger (value rules AND isEmpty/isNotEmpty rules). Prevents dangling
 * references from failing `FIELD_VISIBILITY_TRIGGER_NOT_FOUND` on the next save.
 */
export const removeRulesForTrigger = (
  meta: TFieldMetaSchema,
  triggerStableId: string,
): TFieldMetaSchema => {
  const block = getVisibility(meta);

  if (!meta || !block) {
    return meta;
  }

  const rules = block.rules.filter((r) => r.triggerFieldStableId !== triggerStableId);

  if (rules.length === block.rules.length) {
    return meta;
  }

  return rebuildVisibility(meta, rules, block.match);
};
