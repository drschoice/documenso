import type { Field, FieldType } from '@prisma/client';

import { logger } from '@documenso/lib/utils/logger';

// Positions are stored as a percentage of the page (0-100). A new field within
// this margin of an existing one is treated as landing on the same spot.
const DUPLICATE_POSITION_EPSILON = 0.5;

// New copies landing at the same spot on at least this many distinct pages are
// treated as an accidental "duplicate on all pages". Two is enough: nobody
// hand-places pixel-identical fields across pages, and the source page's field
// is often already persisted (and so excluded from the new-field set).
const DUPLICATE_ALL_PAGES_THRESHOLD = 2;

/**
 * The subset of an incoming (client-supplied) field the detector needs. Both
 * the document and template set-fields payloads are structurally compatible.
 */
export type SuspectedDuplicateFieldInput = {
  id?: number | null;
  formId?: string;
  envelopeItemId: string;
  type: FieldType;
  recipientId: number;
  pageNumber: number;
  pageX: number;
  pageY: number;
};

export type SuspectedDuplicateField = {
  reason: 'overlaps-existing-field' | 'all-pages-burst';
  type: FieldType;
  recipientId: number;
  envelopeItemId: string;
  formId?: string;
  pageNumber: number;
  pageX: number;
  pageY: number;
  matchedExistingFieldId?: number;
  pageCount?: number;
};

const isSamePlacement = (existing: Field, incoming: SuspectedDuplicateFieldInput) =>
  existing.type === incoming.type &&
  existing.recipientId === incoming.recipientId &&
  existing.envelopeItemId === incoming.envelopeItemId &&
  existing.page === incoming.pageNumber &&
  Math.abs(existing.positionX.toNumber() - incoming.pageX) < DUPLICATE_POSITION_EPSILON &&
  Math.abs(existing.positionY.toNumber() - incoming.pageY) < DUPLICATE_POSITION_EPSILON;

/**
 * Best-effort detection of accidental field duplication. Only inspects
 * newly-created (id-less) incoming fields, so intentional edits to already
 * persisted fields are never flagged.
 */
export const detectSuspectedDuplicateFields = (
  existingFields: Field[],
  incomingFields: SuspectedDuplicateFieldInput[],
): SuspectedDuplicateField[] => {
  const existingIds = new Set(existingFields.map((field) => field.id));

  const newFields = incomingFields.filter(
    (field) => field.id === undefined || field.id === null || !existingIds.has(field.id),
  );

  const findings: SuspectedDuplicateField[] = [];

  // A new field landing on top of one that already exists — the signature of
  // the autosave race re-creating an id-less field.
  for (const incoming of newFields) {
    const match = existingFields.find((existing) => isSamePlacement(existing, incoming));

    if (match) {
      findings.push({
        reason: 'overlaps-existing-field',
        type: incoming.type,
        recipientId: incoming.recipientId,
        envelopeItemId: incoming.envelopeItemId,
        formId: incoming.formId,
        pageNumber: incoming.pageNumber,
        pageX: incoming.pageX,
        pageY: incoming.pageY,
        matchedExistingFieldId: match.id,
      });
    }
  }

  // A group of new fields sharing the same spot across many pages — the
  // signature of an accidental "duplicate on all pages".
  const groups = new Map<
    string,
    { representative: SuspectedDuplicateFieldInput; pages: Set<number> }
  >();

  for (const incoming of newFields) {
    const key = [
      incoming.type,
      incoming.recipientId,
      incoming.envelopeItemId,
      Math.round(incoming.pageX),
      Math.round(incoming.pageY),
    ].join(':');

    const group = groups.get(key);

    if (group) {
      group.pages.add(incoming.pageNumber);
    } else {
      groups.set(key, { representative: incoming, pages: new Set([incoming.pageNumber]) });
    }
  }

  for (const { representative, pages } of groups.values()) {
    if (pages.size >= DUPLICATE_ALL_PAGES_THRESHOLD) {
      findings.push({
        reason: 'all-pages-burst',
        type: representative.type,
        recipientId: representative.recipientId,
        envelopeItemId: representative.envelopeItemId,
        formId: representative.formId,
        pageNumber: representative.pageNumber,
        pageX: representative.pageX,
        pageY: representative.pageY,
        pageCount: pages.size,
      });
    }
  }

  return findings;
};

/**
 * Diagnostic safety net for the field-duplication bug: flag incoming field
 * sets that look like an accidental duplicate (a new field placed on top of an
 * existing one, or a burst of copies spanning many pages) so the issue can be
 * traced from the logs regardless of which client path caused it.
 */
export const logSuspectedDuplicateFields = ({
  existingFields,
  incomingFields,
  envelopeId,
  envelopeType,
  userId,
  teamId,
}: {
  existingFields: Field[];
  incomingFields: SuspectedDuplicateFieldInput[];
  envelopeId: string;
  envelopeType: 'document' | 'template';
  userId: number;
  teamId: number;
}): SuspectedDuplicateField[] => {
  const suspectedDuplicates = detectSuspectedDuplicateFields(existingFields, incomingFields);

  if (suspectedDuplicates.length > 0) {
    logger.warn(
      {
        envelopeId,
        envelopeType,
        userId,
        teamId,
        suspectedDuplicates,
      },
      '[field-duplicate] suspected duplicate field placement detected',
    );
  }

  return suspectedDuplicates;
};
