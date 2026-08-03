import { FieldType } from '@prisma/client';

import type { TFieldMetaSchema } from '../../types/field-meta';

/**
 * Copy & link fields — pure authoring/lifecycle helpers.
 *
 * A link group is just a set of fields that share the same non-empty
 * `fieldMeta.linkGroupId`. There is no source/dependent distinction (symmetric):
 * filling in any member fans the value out to the rest. Because membership is a
 * flat key rather than a reference graph, there are no cycles and no ordering to
 * reason about — this module is deliberately simpler than ../field-visibility.
 *
 * These helpers are free of React/Konva so the same logic backs the sidebar
 * section, the canvas pick-mode toggle, the duplicate/delete cascades, and the
 * server-side save validation.
 */

/**
 * Field types whose meta can carry a `linkGroupId`. A link group is single-type;
 * extending eligibility later is just adding the type here and spreading
 * `ZLinkFieldMetaExtensions` into its meta schema.
 */
export const LINK_ELIGIBLE_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  FieldType.TEXT,
  FieldType.NUMBER,
]);

export const isLinkEligibleType = (type: FieldType): boolean =>
  LINK_ELIGIBLE_FIELD_TYPES.has(type);

const asRecord = (meta: TFieldMetaSchema): Record<string, unknown> =>
  ({ ...(meta as Record<string, unknown> | undefined) }) as Record<string, unknown>;

/** Returns the field's own non-empty `linkGroupId`, or null when absent / meta unset. */
export const getLinkGroupId = (meta: TFieldMetaSchema): string | null => {
  const m = meta as { linkGroupId?: unknown } | undefined;
  return m && typeof m.linkGroupId === 'string' && m.linkGroupId !== '' ? m.linkGroupId : null;
};

/** All fields that belong to the given link group, preserving input order. */
export const getLinkGroupMembers = <T extends { fieldMeta?: TFieldMetaSchema | null }>(
  fields: T[],
  groupId: string,
): T[] => {
  if (!groupId) {
    return [];
  }

  return fields.filter((f) => getLinkGroupId(f.fieldMeta ?? undefined) === groupId);
};

/**
 * The constraint keys that must stay consistent across a link group so a value
 * fanned out from one member always validates against every other member. Both
 * members are guaranteed same-type by the eligibility/pick-mode checks.
 */
const copyLinkedConstraints = (
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): void => {
  if (from.type === 'text') {
    to.characterLimit = from.characterLimit;
  }

  if (from.type === 'number') {
    to.minValue = from.minValue;
    to.maxValue = from.maxValue;
    to.numberFormat = from.numberFormat;
  }
};

/**
 * Add `memberMeta` to `sourceMeta`'s link group under the resolved `groupId`,
 * copying the shared constraints from the source so a fanned-out value is always
 * valid for the new member. Returns fresh metas for BOTH fields (the source may
 * be picking up a brand-new group id). Callers resolve `groupId` as
 * `getLinkGroupId(sourceMeta) ?? <fresh id>`.
 */
export const addToLinkGroup = (
  sourceMeta: TFieldMetaSchema,
  memberMeta: TFieldMetaSchema,
  groupId: string,
): { sourceMeta: TFieldMetaSchema; memberMeta: TFieldMetaSchema } => {
  const source = asRecord(sourceMeta);
  const member = asRecord(memberMeta);

  source.linkGroupId = groupId;
  member.linkGroupId = groupId;
  copyLinkedConstraints(source, member);

  return {
    sourceMeta: source as TFieldMetaSchema,
    memberMeta: member as TFieldMetaSchema,
  };
};

/** Remove a field from its link group by clearing its `linkGroupId`. */
export const removeFromLinkGroup = (meta: TFieldMetaSchema): TFieldMetaSchema => {
  if (getLinkGroupId(meta) === null) {
    return meta;
  }

  const record = asRecord(meta);
  delete record.linkGroupId;

  return record as TFieldMetaSchema;
};

/** Link group ids that have fewer than two members among `fields` (meaningless groups). */
export const getOrphanLinkGroupIds = <T extends { fieldMeta?: TFieldMetaSchema | null }>(
  fields: T[],
): Set<string> => {
  const counts = new Map<string, number>();

  for (const field of fields) {
    const groupId = getLinkGroupId(field.fieldMeta ?? undefined);

    if (groupId) {
      counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
    }
  }

  const orphans = new Set<string>();

  for (const [groupId, count] of counts) {
    if (count < 2) {
      orphans.add(groupId);
    }
  }

  return orphans;
};

/**
 * Clear `linkGroupId` on any field whose group has dropped below two members.
 * Returns a new array with the affected fields shallow-copied; unaffected fields
 * keep their identity. Run at the delete choke point after removing fields.
 */
export const pruneOrphanLinkGroups = <T extends { fieldMeta?: TFieldMetaSchema | null }>(
  fields: T[],
): T[] => {
  const orphans = getOrphanLinkGroupIds(fields);

  if (orphans.size === 0) {
    return fields;
  }

  return fields.map((field) => {
    const groupId = getLinkGroupId(field.fieldMeta ?? undefined);

    if (groupId && orphans.has(groupId)) {
      return { ...field, fieldMeta: removeFromLinkGroup(field.fieldMeta ?? undefined) };
    }

    return field;
  });
};
