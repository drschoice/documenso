import { describe, expect, it } from 'vitest';

import { getCombCellOverlayRects, getFieldOverlayRect } from './overlay-geometry';

describe('getFieldOverlayRect', () => {
  it('converts page percentages into scaled pixels', () => {
    expect(
      getFieldOverlayRect({ positionX: 10, positionY: 20, width: 50, height: 5 }, 600, 800, 1.5),
    ).toEqual({ left: 90, top: 240, width: 450, height: 60 });
  });

  it('accepts positions that arrive as strings', () => {
    expect(
      getFieldOverlayRect(
        { positionX: '10.5', positionY: '9.25', width: '20', height: '4' },
        1000,
        1000,
        1,
      ),
    ).toEqual({ left: 105, top: 92.5, width: 200, height: 40 });
  });
});

describe('getCombCellOverlayRects', () => {
  const field = { positionX: 10, positionY: 20, width: 30, height: 5 };

  it('lays cells out in a row when they have no offsets', () => {
    const rects = getCombCellOverlayRects(
      field,
      { cells: [{ id: 1 }, { id: 2 }, { id: 3 }], cellSize: 20 },
      1000,
      1000,
      1,
    );

    // 2px gap between cells, starting at the field's corner.
    expect(rects.map((rect) => rect.left)).toEqual([100, 122, 144]);
    expect(rects.every((rect) => rect.top === 200 && rect.width === 20)).toBe(true);
  });

  it('places cells at their own offsets, scaled', () => {
    const [cell] = getCombCellOverlayRects(
      field,
      { cells: [{ id: 1, offsetX: 5, offsetY: 1 }], cellSize: 20 },
      1000,
      1000,
      2,
    );

    expect(cell).toEqual({ left: 300, top: 420, width: 40, height: 40 });
  });

  it('derives the cell size from the font size when none is set', () => {
    const [cell] = getCombCellOverlayRects(field, { cells: [{ id: 1 }], fontSize: 10 }, 1000, 1000, 1);

    expect(cell.width).toBe(15);
  });
});
