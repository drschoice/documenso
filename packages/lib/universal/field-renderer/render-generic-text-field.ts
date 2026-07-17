import Konva from 'konva';

import { DEFAULT_STANDARD_FONT_SIZE } from '../../constants/pdf';
import type {
  GenericTextFieldTypeMetas,
  TFieldCellValue,
  TNumberFieldMeta,
  TTextFieldMeta,
} from '../../types/field-meta';
import {
  FIELD_DEFAULT_GENERIC_ALIGN,
  FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN,
  FIELD_DEFAULT_LETTER_SPACING,
  FIELD_DEFAULT_LINE_HEIGHT,
  getCombFieldCells,
} from '../../types/field-meta';
import {
  createFieldHoverInteraction,
  createFieldOptionRect,
  createFieldOptionsHoverInteraction,
  konvaTextFill,
  konvaTextFontFamily,
  upsertFieldGroup,
  upsertFieldRect,
  upsertFreeLayoutDecorations,
} from './field-generic-items';
import type { FieldToRender, RenderFieldElementOptions } from './field-renderer';
import {
  COMB_CELL_GAP,
  calculateCombCellPosition,
  calculateFieldPosition,
  resolveCellSize,
} from './field-renderer';

const DEFAULT_TEXT_X_PADDING = 6;

// Distance (in scaled pixels) within which a dragged comb cell snaps to its
// sibling cells.
const COMB_SNAP_THRESHOLD = 8;

const COMB_SNAP_GUIDE_NAME = 'comb-snap-guide';

/**
 * Draw alignment guide lines through the sibling cells the dragged cell is
 * currently aligned with (same row and/or same column).
 *
 * Positions are in field-group-local coordinates so no scale math is needed.
 */
const upsertCombSnapGuides = ({
  fieldGroup,
  cellGroup,
  cellSize,
}: {
  fieldGroup: Konva.Group;
  cellGroup: Konva.Group;
  cellSize: number;
}) => {
  removeCombSnapGuides(fieldGroup);

  const siblings = fieldGroup
    .find<Konva.Group>('.field-option-group')
    .filter((group) => group !== cellGroup);

  const cellX = cellGroup.x();
  const cellY = cellGroup.y();

  const rowAligned = siblings.filter((sibling) => Math.abs(sibling.y() - cellY) < 0.5);
  const columnAligned = siblings.filter((sibling) => Math.abs(sibling.x() - cellX) < 0.5);

  const guidePadding = 8;

  const createGuide = (points: number[]) =>
    new Konva.Line({
      name: COMB_SNAP_GUIDE_NAME,
      points,
      stroke: '#3b82f6',
      strokeWidth: 1,
      dash: [4, 4],
      strokeScaleEnabled: false,
      listening: false,
    });

  if (rowAligned.length > 0) {
    const xs = [cellX, ...rowAligned.map((sibling) => sibling.x())];
    const guideY = cellY + cellSize / 2;

    fieldGroup.add(
      createGuide([
        Math.min(...xs) - guidePadding,
        guideY,
        Math.max(...xs) + cellSize + guidePadding,
        guideY,
      ]),
    );
  }

  if (columnAligned.length > 0) {
    const ys = [cellY, ...columnAligned.map((sibling) => sibling.y())];
    const guideX = cellX + cellSize / 2;

    fieldGroup.add(
      createGuide([
        guideX,
        Math.min(...ys) - guidePadding,
        guideX,
        Math.max(...ys) + cellSize + guidePadding,
      ]),
    );
  }
};

const removeCombSnapGuides = (fieldGroup: Konva.Group) => {
  fieldGroup.find(`.${COMB_SNAP_GUIDE_NAME}`).forEach((guide) => guide.destroy());
};

const upsertFieldText = (field: FieldToRender, options: RenderFieldElementOptions): Konva.Text => {
  const { pageWidth, pageHeight, mode = 'edit', pageLayer, translations } = options;

  const { fieldWidth, fieldHeight } = calculateFieldPosition(field, pageWidth, pageHeight);

  const fieldMeta = field.fieldMeta as GenericTextFieldTypeMetas | undefined;

  const fieldTypeName = translations?.[field.type] || field.type;

  const fieldText: Konva.Text =
    pageLayer.findOne(`#${field.renderId}-text`) ||
    new Konva.Text({
      id: `${field.renderId}-text`,
      name: 'field-text',
    });

  // Calculate text positioning based on alignment
  const textX = 0;
  const textY = 0;
  const textFontSize = fieldMeta?.fontSize || DEFAULT_STANDARD_FONT_SIZE;

  // By default, render the field name or label using the field's text alignment.
  let textToRender: string = fieldMeta?.label || fieldTypeName;
  let textAlign: 'left' | 'center' | 'right' = fieldMeta?.textAlign || FIELD_DEFAULT_GENERIC_ALIGN;
  let textVerticalAlign: 'top' | 'middle' | 'bottom' = FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN;
  let textLineHeight = FIELD_DEFAULT_LINE_HEIGHT;
  let textLetterSpacing = FIELD_DEFAULT_LETTER_SPACING;

  // Render default values for text/number if provided for editing mode.
  if (mode === 'edit' && (fieldMeta?.type === 'text' || fieldMeta?.type === 'number')) {
    const value = fieldMeta?.type === 'text' ? fieldMeta.text : fieldMeta.value;

    if (value) {
      textToRender = value;

      textVerticalAlign = fieldMeta.verticalAlign || FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN;
      textAlign = fieldMeta.textAlign || FIELD_DEFAULT_GENERIC_ALIGN;
      textLetterSpacing = fieldMeta.letterSpacing || FIELD_DEFAULT_LETTER_SPACING;
      textLineHeight = fieldMeta.lineHeight || FIELD_DEFAULT_LINE_HEIGHT;
    }
  }

  // Default to blank for export mode since we want to ensure we don't show
  // any placeholder text or labels unless actually it's inserted.
  if (mode === 'export') {
    textToRender = '';
  }

  // Fallback render readonly fields if prefilled value exists.
  if (field?.fieldMeta?.readOnly && (fieldMeta?.type === 'text' || fieldMeta?.type === 'number')) {
    const value = fieldMeta?.type === 'text' ? fieldMeta.text : fieldMeta.value;

    if (value) {
      textToRender = value;

      textVerticalAlign = fieldMeta.verticalAlign || FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN;
      textAlign = fieldMeta.textAlign || FIELD_DEFAULT_GENERIC_ALIGN;
      textLetterSpacing = fieldMeta.letterSpacing || FIELD_DEFAULT_LETTER_SPACING;
      textLineHeight = fieldMeta.lineHeight || FIELD_DEFAULT_LINE_HEIGHT;
    }
  }

  // Override everything with value if it's inserted.
  if (field.inserted) {
    textToRender = field.customText;

    textAlign = fieldMeta?.textAlign || FIELD_DEFAULT_GENERIC_ALIGN;

    if (fieldMeta?.type === 'text' || fieldMeta?.type === 'number') {
      textVerticalAlign = fieldMeta.verticalAlign || FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN;
      textLetterSpacing = fieldMeta.letterSpacing || FIELD_DEFAULT_LETTER_SPACING;
      textLineHeight = fieldMeta.lineHeight || FIELD_DEFAULT_LINE_HEIGHT;
    }
  }

  // Note: Do not use native text padding since it's uniform.
  // We only want to have padding on the left and right hand sides.
  fieldText.setAttrs({
    x: textX + DEFAULT_TEXT_X_PADDING,
    y: textY,
    verticalAlign: textVerticalAlign,
    wrap: 'word',
    text: textToRender,
    fontSize: textFontSize,
    align: textAlign,
    lineHeight: textLineHeight,
    letterSpacing: textLetterSpacing,
    fontFamily: konvaTextFontFamily,
    fill: konvaTextFill,
    width: fieldWidth - DEFAULT_TEXT_X_PADDING * 2,
    height: fieldHeight,
  } satisfies Partial<Konva.TextConfig>);

  return fieldText;
};

/**
 * Render a comb ('cells' layout) text/number field as one freely-placeable
 * square cell per character.
 *
 * Cells are `field-option-group` groups so all the generic free-layout
 * machinery (union bounds, decorations, drag wiring, offset sync) applies.
 */
const renderCombCells = ({
  field,
  options,
  meta,
  cells,
  fieldGroup,
  fieldRect,
}: {
  field: FieldToRender;
  options: RenderFieldElementOptions;
  meta: TTextFieldMeta | TNumberFieldMeta;
  cells: TFieldCellValue[];
  fieldGroup: Konva.Group;
  fieldRect: Konva.Rect;
}) => {
  const { pageWidth, pageHeight, mode, color, scale, editable } = options;

  // Comb fields render a background rect per cell instead, and cells are
  // repositioned individually rather than relaid out on resize.
  fieldRect.visible(false);

  const cellSize = resolveCellSize(meta);
  const fontSize = meta.fontSize || DEFAULT_STANDARD_FONT_SIZE;

  // Resolve the characters to fill the cells with, one character per cell.
  let combText = '';

  if (mode === 'edit') {
    combText = (meta.type === 'text' ? meta.text : meta.value) || '';
  }

  // Read-only fields fall back to their prefilled value in every mode.
  if (meta.readOnly) {
    combText = (meta.type === 'text' ? meta.text : meta.value) || '';
  }

  // Override everything with value if it's inserted.
  if (field.inserted) {
    combText = field.customText;
  }

  // Spread to keep surrogate pairs intact, and never render more characters
  // than there are cells (e.g. a template value longer than a reduced count).
  const combChars = [...combText].slice(0, cells.length);

  cells.forEach(({ offsetX, offsetY }, index) => {
    const { anchorX, anchorY } = calculateCombCellPosition({
      offsetX,
      offsetY,
      cellIndex: index,
      cellSize,
      pageWidth,
      pageHeight,
    });

    const cellGroup = new Konva.Group({
      internalCellIndex: index,
      id: `${field.renderId}-option-${index}`,
      name: 'field-option-group',
      x: anchorX,
      y: anchorY,
    });

    const cellRect = createFieldOptionRect({
      attrs: { internalCellIndex: index },
      id: `${field.renderId}-option-rect-${index}`,
      x: 0,
      y: 0,
      width: cellSize,
      height: cellSize,
      options,
    });

    const cellText = new Konva.Text({
      internalCellIndex: index,
      id: `${field.renderId}-cell-text-${index}`,
      name: 'field-cell-text',
      x: 0,
      y: 0,
      width: cellSize,
      height: cellSize,
      text: combChars[index] ?? '',
      fontSize,
      fontFamily: konvaTextFontFamily,
      fill: konvaTextFill,
      align: 'center',
      verticalAlign: 'middle',
      listening: false,
    });

    cellGroup.add(cellRect);
    cellGroup.add(cellText);

    if (mode === 'edit' && editable) {
      cellGroup.draggable(true);

      cellGroup.dragBoundFunc((pos) => {
        // Magnetically snap the dragged cell to its sibling cells: same row,
        // same column, or the slot directly next to a sibling.
        const siblings = fieldGroup
          .find<Konva.Group>('.field-option-group')
          .filter((group) => group !== cellGroup);

        const slotSize = (cellSize + COMB_CELL_GAP) * scale;

        let snappedX: number | null = null;
        let snappedY: number | null = null;

        for (const sibling of siblings) {
          const siblingPosition = sibling.absolutePosition();

          if (snappedY === null && Math.abs(pos.y - siblingPosition.y) <= COMB_SNAP_THRESHOLD) {
            snappedY = siblingPosition.y;
          }

          for (const candidateX of [
            siblingPosition.x,
            siblingPosition.x - slotSize,
            siblingPosition.x + slotSize,
          ]) {
            if (snappedX === null && Math.abs(pos.x - candidateX) <= COMB_SNAP_THRESHOLD) {
              snappedX = candidateX;
            }
          }
        }

        const maxX = (pageWidth - cellSize) * scale;
        const maxY = (pageHeight - cellSize) * scale;

        return {
          x: Math.max(0, Math.min(maxX, snappedX ?? pos.x)),
          y: Math.max(0, Math.min(maxY, snappedY ?? pos.y)),
        };
      });

      cellGroup.on('dragmove.combSnap', () => {
        upsertCombSnapGuides({ fieldGroup, cellGroup, cellSize });
      });

      cellGroup.on('dragend.combSnap', () => {
        removeCombSnapGuides(fieldGroup);
      });
    }

    fieldGroup.add(cellGroup);
  });

  upsertFreeLayoutDecorations({ fieldGroup, options });

  if (color !== 'readOnly' && mode !== 'export') {
    createFieldOptionsHoverInteraction({ fieldGroup, options });
  }
};

export const renderGenericTextFieldElement = (
  field: FieldToRender,
  options: RenderFieldElementOptions,
) => {
  const { mode = 'edit', pageLayer, color } = options;

  const isFirstRender = !pageLayer.findOne(`#${field.renderId}`);

  // Clear previous children and listeners to re-render fresh.
  const fieldGroup = upsertFieldGroup(field, options);
  fieldGroup.removeChildren();
  fieldGroup.off('transform');

  // Assign elements to group and any listeners that should only be run on initialization.
  if (isFirstRender) {
    pageLayer.add(fieldGroup);
  }

  // Render the field background and text.
  const fieldRect = upsertFieldRect(field, options);
  fieldGroup.add(fieldRect);

  // Comb ('cells' layout) text/number fields render per-character cells
  // instead of a single text box, and are never resized via the transformer.
  const fieldMeta = field.fieldMeta;

  if (fieldMeta && (fieldMeta.type === 'text' || fieldMeta.type === 'number')) {
    const combCells = getCombFieldCells(fieldMeta);

    if (combCells) {
      renderCombCells({ field, options, meta: fieldMeta, cells: combCells, fieldGroup, fieldRect });

      return {
        fieldGroup,
        isFirstRender,
      };
    }
  }

  const fieldText = upsertFieldText(field, options);
  fieldGroup.add(fieldText);

  // This is to keep the text inside the field at the same size
  // when the field is resized. Without this the text would be stretched.
  fieldGroup.on('transform', () => {
    const groupScaleX = fieldGroup.scaleX();
    const groupScaleY = fieldGroup.scaleY();

    // Adjust text scale so it doesn't change while group is resized.
    fieldText.scaleX(1 / groupScaleX);
    fieldText.scaleY(1 / groupScaleY);

    const rectWidth = fieldRect.width() * groupScaleX;
    const rectHeight = fieldRect.height() * groupScaleY;

    // Update text dimensions
    fieldText.width(rectWidth - DEFAULT_TEXT_X_PADDING * 2);
    fieldText.height(rectHeight);

    // Force Konva to recalculate text layout
    fieldText.height();

    fieldGroup.getLayer()?.batchDraw();
  });

  // Reset the text after transform has ended.
  fieldGroup.on('transformend', () => {
    fieldText.scaleX(1);
    fieldText.scaleY(1);

    const rectWidth = fieldRect.width();
    const rectHeight = fieldRect.height();

    // Update text dimensions
    fieldText.width(rectWidth - DEFAULT_TEXT_X_PADDING * 2);
    fieldText.height(rectHeight);

    // Force Konva to recalculate text layout
    fieldText.height();

    fieldGroup.getLayer()?.batchDraw();
  });

  // Handle export mode.
  if (mode === 'export') {
    // Hide the rectangle.
    fieldRect.opacity(0);
  }

  if (color !== 'readOnly' && mode !== 'export') {
    createFieldHoverInteraction({ fieldGroup, fieldRect, options });
  }

  return {
    fieldGroup,
    isFirstRender,
  };
};
