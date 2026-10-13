import { describe, expect, it } from 'vitest';

import { getAdjacentField, sortFieldsInReadingOrder } from './reading-order';

const makeField = (
  id: number,
  positionX: number | string,
  positionY: number | string,
  options: { page?: number; envelopeItemId?: string; height?: number } = {},
) => ({
  id,
  positionX,
  positionY,
  page: options.page ?? 1,
  envelopeItemId: options.envelopeItemId ?? 'item-a',
  height: options.height ?? 4,
});

const itemOrder = (envelopeItemId: string) => (envelopeItemId === 'item-a' ? 1 : 2);

const ids = (fields: Array<{ id: number }>) => fields.map((field) => field.id);

describe('sortFieldsInReadingOrder', () => {
  it('reads top to bottom', () => {
    const fields = [makeField(1, 10, 50), makeField(2, 10, 10), makeField(3, 10, 30)];

    expect(ids(sortFieldsInReadingOrder(fields, itemOrder))).toEqual([2, 3, 1]);
  });

  it('compares positions as numbers, not text', () => {
    const fields = [makeField(1, 10, '10.5'), makeField(2, 10, '9.2')];

    expect(ids(sortFieldsInReadingOrder(fields, itemOrder))).toEqual([2, 1]);
  });

  it('reads a line left to right even when its boxes are not level', () => {
    // "Last name" sits a hair lower than "First name" to its right.
    const fields = [makeField(1, 60, 20), makeField(2, 10, 21), makeField(3, 10, 40)];

    expect(ids(sortFieldsInReadingOrder(fields, itemOrder))).toEqual([2, 1, 3]);
  });

  it('starts a new line once a box is lower than half a box', () => {
    const fields = [makeField(1, 60, 20), makeField(2, 10, 23)];

    expect(ids(sortFieldsInReadingOrder(fields, itemOrder))).toEqual([1, 2]);
  });

  it('reads pages, then documents, in order', () => {
    const fields = [
      makeField(1, 10, 10, { envelopeItemId: 'item-b' }),
      makeField(2, 10, 90, { page: 2 }),
      makeField(3, 10, 90, { page: 1 }),
    ];

    expect(ids(sortFieldsInReadingOrder(fields, itemOrder))).toEqual([3, 2, 1]);
  });
});

describe('getAdjacentField', () => {
  const ordered = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it('returns the next and previous field', () => {
    expect(getAdjacentField(ordered, 2, 'next')).toEqual({ id: 3 });
    expect(getAdjacentField(ordered, 2, 'previous')).toEqual({ id: 1 });
  });

  it('returns null at either end, and for a field not in the list', () => {
    expect(getAdjacentField(ordered, 3, 'next')).toBeNull();
    expect(getAdjacentField(ordered, 1, 'previous')).toBeNull();
    expect(getAdjacentField(ordered, 9, 'next')).toBeNull();
  });
});
