import { FieldType } from '@prisma/client';

import type { TVisibilityBlock, TVisibilityRule } from '../../types/field-meta';
import { topologicalSort } from './topological-sort';

export type EvaluatableField = {
  id: number;
  type: FieldType;
  customText: string;
  inserted: boolean;
  fieldMeta: unknown;
};

const getStableId = (field: EvaluatableField): string | null => {
  const meta = field.fieldMeta as { stableId?: unknown } | null;
  return meta && typeof meta.stableId === 'string' ? meta.stableId : null;
};

const getVisibility = (field: EvaluatableField): TVisibilityBlock | null => {
  const meta = field.fieldMeta as { visibility?: TVisibilityBlock } | null;
  return meta?.visibility ?? null;
};

const normalize = (s: string): string => s.trim().toLowerCase();

const parseSelectionTokens = (customText: string): string[] => {
  if (!customText) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(customText);

    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    // v1 wrote comma separated values before the JSON encoding landed.
    return customText.split(',').filter(Boolean);
  }
};

const getOptionValues = (trigger: EvaluatableField): string[] => {
  const meta = trigger.fieldMeta as { values?: Array<{ value?: unknown }> } | null;

  return (meta?.values ?? []).map((option) =>
    typeof option.value === 'string' ? option.value : '',
  );
};

/**
 * Resolve a single stored token to every reading it could plausibly have.
 *
 * Radio and checkbox `customText` is encoded differently depending on which
 * signer produced it:
 *
 * - the v2 (Konva) signer stores the 0-based INDEX into `fieldMeta.values`
 *   (`toRadioCustomText` / `toCheckboxCustomText` in `lib/utils/fields.ts`);
 * - the v1 (DOM) signer stores the option VALUE itself
 *   (`document-signing-radio-field.tsx`, `fromCheckboxValue`).
 *
 * `evaluateAllVisibility` runs on both paths, so a token is resolved to both
 * readings and a rule matches when either one does. Resolving only the v2
 * reading silently hid every conditional dependent on v1 envelopes.
 */
const resolveToken = (token: string, optionValues: string[]): string[] => {
  const candidates = [token];

  const asIndex = Number(token);

  if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < optionValues.length) {
    candidates.push(optionValues[asIndex]);
  }

  return candidates.filter((candidate) => candidate.trim() !== '');
};

/**
 * Resolve the current "value(s)" the rule sees for a trigger field.
 *
 * - For radio/checkbox: every candidate reading of the selected option(s).
 * - For everything else: the field's `customText`.
 *
 * An uninserted or blank trigger yields an empty list, which is what
 * `isEmpty` / `isNotEmpty` test against.
 */
const triggerValuesFor = (trigger: EvaluatableField): string[] => {
  if (!trigger.inserted) {
    return [];
  }

  if (trigger.type === FieldType.CHECKBOX || trigger.type === FieldType.RADIO) {
    const optionValues = getOptionValues(trigger);

    const tokens =
      trigger.type === FieldType.CHECKBOX
        ? parseSelectionTokens(trigger.customText)
        : [trigger.customText];

    return tokens.flatMap((token) => resolveToken(token, optionValues));
  }

  return trigger.customText.trim() === '' ? [] : [trigger.customText];
};

const evaluateRule = (rule: TVisibilityRule, trigger: EvaluatableField | null): boolean => {
  if (!trigger) {
    return false; // fail-closed
  }

  const values = triggerValuesFor(trigger);

  // Comparison operators keep their historic behaviour against an empty
  // trigger by comparing with a single blank value.
  const comparable = values.length > 0 ? values : [''];

  switch (rule.operator) {
    case 'isEmpty':
      return values.length === 0;
    case 'isNotEmpty':
      return values.length > 0;
    case 'equals':
      return comparable.some((value) => normalize(value) === normalize(rule.value));
    case 'notEquals':
      return !comparable.some((value) => normalize(value) === normalize(rule.value));
    case 'contains':
      return comparable.some((value) => normalize(value).includes(normalize(rule.value)));
    case 'notContains':
      return !comparable.some((value) => normalize(value).includes(normalize(rule.value)));
    default:
      return false;
  }
};

export const evaluateVisibility = (
  field: EvaluatableField,
  siblings: EvaluatableField[],
): { visible: boolean } => {
  const block = getVisibility(field);
  if (!block) return { visible: true };

  const siblingsByStableId = new Map<string, EvaluatableField>();
  for (const s of siblings) {
    const sid = getStableId(s);
    if (sid) siblingsByStableId.set(sid, s);
  }

  const checks = block.rules.map((rule) =>
    evaluateRule(rule, siblingsByStableId.get(rule.triggerFieldStableId) ?? null),
  );

  return {
    visible: block.match === 'all' ? checks.every(Boolean) : checks.some(Boolean),
  };
};

/**
 * Evaluates all fields for a single recipient. Topologically orders by
 * dependency so a chained dependent's visibility considers its trigger's state
 * (the trigger's VALUE always counts, even if the trigger is itself hidden —
 * hidden triggers with a pre-commit value will be cleared at completion; for
 * the moment, their customText is the source of truth).
 */
export const evaluateAllVisibility = (fields: EvaluatableField[]): Map<number, boolean> => {
  const result = new Map<number, boolean>();

  const byStableId = new Map<string, EvaluatableField>();
  for (const f of fields) {
    const sid = getStableId(f);
    if (sid) byStableId.set(sid, f);
  }

  const ids = fields.map((f) => String(f.id));
  const byId = new Map(fields.map((f) => [String(f.id), f] as const));

  const dependenciesOf = (idStr: string) => {
    const field = byId.get(idStr);
    if (!field) return [];
    const block = getVisibility(field);
    if (!block) return [];
    return block.rules
      .map((r) => byStableId.get(r.triggerFieldStableId))
      .filter((f): f is EvaluatableField => !!f)
      .map((f) => String(f.id));
  };

  const sorted = topologicalSort(ids, dependenciesOf);

  if (sorted.kind === 'cycle') {
    for (const f of fields) result.set(f.id, false);
    return result;
  }

  for (const idStr of sorted.order) {
    const field = byId.get(idStr);
    if (!field) continue;
    const { visible } = evaluateVisibility(field, fields);
    result.set(field.id, visible);
  }

  return result;
};
