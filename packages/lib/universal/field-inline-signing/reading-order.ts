type Numeric = number | string | { toString(): string };

type ReadingOrderField = {
  id: number;
  envelopeItemId: string;
  page: number;
  positionX: Numeric;
  positionY: Numeric;
  height: Numeric;
};

/**
 * Sort fields the way a signer reads the document: by document, then page, then top to bottom, and
 * left to right along a line.
 *
 * Fields whose tops are within half a field's height of each other count as one line, so a row of
 * boxes drawn by hand ("Last name | First name") is read left to right even when the boxes are not
 * perfectly level.
 *
 * Positions reach the browser as strings (Prisma decimals), so they are compared as numbers here.
 * Sorting them as strings put a field at 10% above one at 9%.
 */
export const sortFieldsInReadingOrder = <T extends ReadingOrderField>(
  fields: T[],
  getEnvelopeItemOrder: (envelopeItemId: string) => number,
): T[] => {
  const byPage = [...fields].sort(
    (a, b) =>
      getEnvelopeItemOrder(a.envelopeItemId) - getEnvelopeItemOrder(b.envelopeItemId) ||
      a.page - b.page ||
      Number(a.positionY) - Number(b.positionY) ||
      Number(a.positionX) - Number(b.positionX),
  );

  const ordered: T[] = [];

  let line: T[] = [];

  const flushLine = () => {
    ordered.push(...line.sort((a, b) => Number(a.positionX) - Number(b.positionX)));
    line = [];
  };

  for (const field of byPage) {
    const lineStart = line[0];

    const isSameLine =
      lineStart !== undefined &&
      lineStart.envelopeItemId === field.envelopeItemId &&
      lineStart.page === field.page &&
      Number(field.positionY) - Number(lineStart.positionY) <
        Math.min(Number(lineStart.height), Number(field.height)) / 2;

    if (!isSameLine) {
      flushLine();
    }

    line.push(field);
  }

  flushLine();

  return ordered;
};

/** The field after (or before) the given one in an ordered list, or null at either end. */
export const getAdjacentField = <T extends { id: number }>(
  orderedFields: T[],
  fieldId: number,
  direction: 'next' | 'previous',
): T | null => {
  const index = orderedFields.findIndex((field) => field.id === fieldId);

  if (index === -1) {
    return null;
  }

  return orderedFields[direction === 'next' ? index + 1 : index - 1] ?? null;
};
