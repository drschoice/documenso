import type { TFieldCellValue } from '../../types/field-meta';
import {
  calculateCombCellPosition,
  calculateFieldPosition,
  resolveCellSize,
} from '../field-renderer/field-renderer';

type PositionedField = {
  positionX: number | string | { toString(): string };
  positionY: number | string | { toString(): string };
  width: number | string | { toString(): string };
  height: number | string | { toString(): string };
};

export type TOverlayRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Where a field sits on its rendered page, in CSS pixels relative to the
 * page's top-left corner.
 *
 * The signing page draws fields onto a Konva stage that is scaled by the same
 * factor, so a DOM element placed at this rect lies exactly over the field.
 * Worked out from the field's stored percentages rather than measured from the
 * Konva node, so an editor can be placed before the stage has drawn the field.
 *
 * Positions reach the browser as strings (Prisma decimals), so they are
 * converted with `Number()` here rather than trusted to be numbers.
 */
export const getFieldOverlayRect = (
  field: PositionedField,
  pageWidth: number,
  pageHeight: number,
  scale: number,
): TOverlayRect => {
  const { fieldX, fieldY, fieldWidth, fieldHeight } = calculateFieldPosition(
    {
      positionX: Number(field.positionX),
      positionY: Number(field.positionY),
      width: Number(field.width),
      height: Number(field.height),
    },
    pageWidth,
    pageHeight,
  );

  return {
    left: fieldX * scale,
    top: fieldY * scale,
    width: fieldWidth * scale,
    height: fieldHeight * scale,
  };
};

/**
 * Where each character cell of a comb field sits on its rendered page, in CSS pixels relative to
 * the page's top-left corner, in cell order.
 *
 * Mirrors how the Konva renderer lays the cells out: each cell is a square of the field's cell size,
 * offset from the field's top-left corner.
 */
export const getCombCellOverlayRects = (
  field: PositionedField,
  meta: { cells: TFieldCellValue[]; cellSize?: number; fontSize?: number },
  pageWidth: number,
  pageHeight: number,
  scale: number,
): TOverlayRect[] => {
  const { left: fieldLeft, top: fieldTop } = getFieldOverlayRect(field, pageWidth, pageHeight, 1);

  const cellSize = resolveCellSize(meta);

  return meta.cells.map(({ offsetX, offsetY }, cellIndex) => {
    const { anchorX, anchorY } = calculateCombCellPosition({
      offsetX,
      offsetY,
      cellIndex,
      cellSize,
      pageWidth,
      pageHeight,
    });

    return {
      left: (fieldLeft + anchorX) * scale,
      top: (fieldTop + anchorY) * scale,
      width: cellSize * scale,
      height: cellSize * scale,
    };
  });
};
