import Konva from 'konva';
import { match } from 'ts-pattern';

import { DEFAULT_STANDARD_FONT_SIZE } from '../../constants/pdf';
import type { TCheckboxFieldMeta } from '../../types/field-meta';
import { parseCheckboxCustomText } from '../../utils/fields';
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
import {
  calculateFieldPosition,
  calculateFreeItemPosition,
  calculateMultiItemPosition,
  resolveButtonSize,
} from './field-renderer';
import type { FieldToRender, RenderFieldElementOptions } from './field-renderer';

// Do not change any of these values without consulting with the team.
const checkboxFieldPadding = 8;
const spacingBetweenCheckboxAndText = 8;
const checkboxOptionRectPadding = 4;

export const renderCheckboxFieldElement = (
  field: FieldToRender,
  options: RenderFieldElementOptions,
) => {
  const { pageWidth, pageHeight, pageLayer, mode, color, scale, editable } = options;

  const { fieldWidth, fieldHeight } = calculateFieldPosition(field, pageWidth, pageHeight);

  const checkboxMeta: TCheckboxFieldMeta | null = (field.fieldMeta as TCheckboxFieldMeta) || null;
  const checkboxValues = checkboxMeta?.values || [];
  const isFreeLayout = checkboxMeta?.layout === 'free';
  const showOptionText = checkboxMeta?.showOptionText !== false;

  const isFirstRender = !pageLayer.findOne(`#${field.renderId}`);

  // Clear previous children and listeners to re-render fresh.
  const fieldGroup = upsertFieldGroup(field, options);
  fieldGroup.removeChildren();
  fieldGroup.off('transform');

  if (isFirstRender) {
    pageLayer.add(fieldGroup);
  }

  const fieldRect = upsertFieldRect(field, options);
  fieldGroup.add(fieldRect);

  const fontSize = checkboxMeta?.fontSize || DEFAULT_STANDARD_FONT_SIZE;
  const itemSize = resolveButtonSize(checkboxMeta);

  // Free layout fields render a background rect per option instead, and
  // options are repositioned individually rather than relaid out on resize.
  if (isFreeLayout) {
    fieldRect.visible(false);
  }

  // Handle rescaling items during transforms.
  if (!isFreeLayout) {
    fieldGroup.on('transform', () => {
      const groupScaleX = fieldGroup.scaleX();
      const groupScaleY = fieldGroup.scaleY();

      const fieldRect = fieldGroup.findOne('.field-rect');

      if (!fieldRect) {
        return;
      }

      const rectWidth = fieldRect.width() * groupScaleX;
      const rectHeight = fieldRect.height() * groupScaleY;

      const squares = fieldGroup
        .find('.checkbox-square')
        .sort((a, b) => a.id().localeCompare(b.id(), undefined, { numeric: true }));
      const checkmarks = fieldGroup
        .find('.checkbox-checkmark')
        .sort((a, b) => a.id().localeCompare(b.id(), undefined, { numeric: true }));
      const text = fieldGroup
        .find('.checkbox-text')
        .sort((a, b) => a.id().localeCompare(b.id(), undefined, { numeric: true }));

      const groupedItems = squares.map((square, i) => ({
        squareElement: square,
        checkmarkElement: checkmarks[i],
        textElement: text[i],
      }));

      groupedItems.forEach((item, i) => {
        const { squareElement, checkmarkElement, textElement } = item;

        const { itemInputX, itemInputY, textX, textY, textWidth, textHeight } =
          calculateMultiItemPosition({
            fieldWidth: rectWidth,
            fieldHeight: rectHeight,
            itemCount: checkboxValues.length,
            itemIndex: i,
            itemSize,
            spacingBetweenItemAndText: spacingBetweenCheckboxAndText,
            fieldPadding: checkboxFieldPadding,
            direction: checkboxMeta?.direction || 'vertical',
            type: 'checkbox',
          });

        squareElement.setAttrs({
          x: itemInputX,
          y: itemInputY,
          scaleX: 1,
          scaleY: 1,
        });

        checkmarkElement.setAttrs({
          x: itemInputX,
          y: itemInputY,
        });

        // Text is not rendered when showOptionText is disabled.
        textElement?.setAttrs({
          x: textX,
          y: textY,
          scaleX: 1,
          scaleY: 1,
          width: textWidth,
          height: textHeight,
        });
      });

      fieldRect.setAttrs({
        width: rectWidth,
        height: rectHeight,
      });

      fieldGroup.scale({
        x: 1,
        y: 1,
      });

      pageLayer.batchDraw();
    });
  }

  const checkedValues: number[] = field.customText ? parseCheckboxCustomText(field.customText) : [];

  checkboxValues.forEach(({ value, checked, offsetX, offsetY }, index) => {
    const isCheckboxChecked = match(mode)
      .with('edit', () => checked)
      .with('sign', () => checkedValues.includes(index))
      .with('export', () => {
        // If it's read-only, check the originally checked state.
        if (checkboxMeta.readOnly) {
          return checked;
        }

        return checkedValues.includes(index);
      })
      .exhaustive();

    const checkboxScale = itemSize / 16;

    if (isFreeLayout) {
      const { anchorX, anchorY, itemInputX, itemInputY, textX, textY, textHeight } =
        calculateFreeItemPosition({
          offsetX,
          offsetY,
          itemIndex: index,
          itemSize,
          spacingBetweenItemAndText: spacingBetweenCheckboxAndText,
          fontSize,
          pageWidth,
          pageHeight,
          type: 'checkbox',
        });

      const optionGroup = new Konva.Group({
        internalCheckboxIndex: index,
        id: `${field.renderId}-option-${index}`,
        name: 'field-option-group',
        x: anchorX,
        y: anchorY,
      });

      const square = new Konva.Rect({
        internalCheckboxIndex: index,
        id: `checkbox-square-${index}`,
        name: 'checkbox-square',
        x: itemInputX,
        y: itemInputY,
        width: itemSize,
        height: itemSize,
        stroke: '#374151',
        strokeWidth: 1.5,
        cornerRadius: 2,
        fill: 'white',
      });

      const checkmark = new Konva.Line({
        internalCheckboxIndex: index,
        id: `checkbox-checkmark-${index}`,
        name: 'checkbox-checkmark',
        x: itemInputX,
        y: itemInputY,
        strokeWidth: 2,
        stroke: '#111827',
        points: [3, 8, 7, 12, 13, 4],
        scale: { x: checkboxScale, y: checkboxScale },
        visible: isCheckboxChecked,
      });

      const text = showOptionText
        ? new Konva.Text({
            internalCheckboxIndex: index,
            id: `checkbox-text-${index}`,
            name: 'checkbox-text',
            x: textX,
            y: textY,
            text: value,
            height: textHeight,
            fontSize,
            fontFamily: konvaTextFontFamily,
            fill: konvaTextFill,
            verticalAlign: 'middle',
            wrap: 'none',
          })
        : null;

      const optionRectX = -checkboxOptionRectPadding;
      const optionRectY = (text ? textY : 0) - checkboxOptionRectPadding;
      const optionRectWidth = text
        ? itemSize +
          spacingBetweenCheckboxAndText +
          (value ? text.width() : 0) +
          checkboxOptionRectPadding * 2
        : itemSize + checkboxOptionRectPadding * 2;
      const optionRectHeight = (text ? textHeight : itemSize) + checkboxOptionRectPadding * 2;

      const optionRect = createFieldOptionRect({
        attrs: { internalCheckboxIndex: index },
        id: `${field.renderId}-option-rect-${index}`,
        x: optionRectX,
        y: optionRectY,
        width: optionRectWidth,
        height: optionRectHeight,
        options,
      });

      optionGroup.add(optionRect);
      optionGroup.add(square);
      optionGroup.add(checkmark);

      if (text) {
        optionGroup.add(text);
      }

      if (mode === 'edit' && editable) {
        optionGroup.draggable(true);

        optionGroup.dragBoundFunc((pos) => {
          const minX = -optionRectX * scale;
          const maxX = (pageWidth - (optionRectX + optionRectWidth)) * scale;
          const minY = -optionRectY * scale;
          const maxY = (pageHeight - (optionRectY + optionRectHeight)) * scale;

          return {
            x: Math.max(minX, Math.min(maxX, pos.x)),
            y: Math.max(minY, Math.min(maxY, pos.y)),
          };
        });
      }

      fieldGroup.add(optionGroup);

      return;
    }

    const { itemInputX, itemInputY, textX, textY, textWidth, textHeight } =
      calculateMultiItemPosition({
        fieldWidth,
        fieldHeight,
        itemCount: checkboxValues.length,
        itemIndex: index,
        itemSize,
        spacingBetweenItemAndText: spacingBetweenCheckboxAndText,
        fieldPadding: checkboxFieldPadding,
        direction: checkboxMeta?.direction || 'vertical',
        type: 'checkbox',
      });

    const square = new Konva.Rect({
      internalCheckboxIndex: index,
      id: `checkbox-square-${index}`,
      name: 'checkbox-square',
      x: itemInputX,
      y: itemInputY,
      width: itemSize,
      height: itemSize,
      stroke: '#374151',
      strokeWidth: 1.5,
      cornerRadius: 2,
      fill: 'white',
    });

    const checkmark = new Konva.Line({
      internalCheckboxIndex: index,
      id: `checkbox-checkmark-${index}`,
      name: 'checkbox-checkmark',
      x: itemInputX,
      y: itemInputY,
      strokeWidth: 2,
      stroke: '#111827',
      points: [3, 8, 7, 12, 13, 4],
      scale: { x: checkboxScale, y: checkboxScale },
      visible: isCheckboxChecked,
    });

    fieldGroup.add(square);
    fieldGroup.add(checkmark);

    if (showOptionText) {
      const text = new Konva.Text({
        internalCheckboxIndex: index,
        id: `checkbox-text-${index}`,
        name: 'checkbox-text',
        x: textX,
        y: textY,
        text: value,
        width: textWidth,
        height: textHeight,
        fontSize,
        fontFamily: konvaTextFontFamily,
        fill: konvaTextFill,
        verticalAlign: 'middle',
      });

      fieldGroup.add(text);
    }
  });

  if (isFreeLayout) {
    upsertFreeLayoutDecorations({ fieldGroup, options });
  }

  if (color !== 'readOnly' && mode !== 'export') {
    if (isFreeLayout) {
      createFieldOptionsHoverInteraction({ fieldGroup, options });
    } else {
      createFieldHoverInteraction({ fieldGroup, fieldRect, options });
    }
  }

  return {
    fieldGroup,
    isFirstRender,
  };
};
