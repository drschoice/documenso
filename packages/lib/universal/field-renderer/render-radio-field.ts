import Konva from 'konva';
import { match } from 'ts-pattern';

import { DEFAULT_STANDARD_FONT_SIZE } from '../../constants/pdf';
import type { TRadioFieldMeta } from '../../types/field-meta';
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
const radioFieldPadding = 8;
const spacingBetweenRadioAndText = 8;
const radioOptionRectPadding = 4;

export const renderRadioFieldElement = (
  field: FieldToRender,
  options: RenderFieldElementOptions,
) => {
  const { pageWidth, pageHeight, pageLayer, mode, color, scale, editable } = options;

  const radioMeta: TRadioFieldMeta | null = (field.fieldMeta as TRadioFieldMeta) || null;
  const radioValues = radioMeta?.values || [];
  const isFreeLayout = radioMeta?.layout === 'free';
  const showOptionText = radioMeta?.showOptionText !== false;

  const isFirstRender = !pageLayer.findOne(`#${field.renderId}`);

  // Clear previous children and listeners to re-render fresh
  const fieldGroup = upsertFieldGroup(field, options);
  fieldGroup.removeChildren();
  fieldGroup.off('transform');

  if (isFirstRender) {
    pageLayer.add(fieldGroup);
  }

  const fieldRect = upsertFieldRect(field, options);
  fieldGroup.add(fieldRect);

  const fontSize = radioMeta?.fontSize || DEFAULT_STANDARD_FONT_SIZE;
  const itemSize = resolveButtonSize(radioMeta);

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

      const circles = fieldGroup.find('.radio-circle').sort((a, b) => a.id().localeCompare(b.id()));
      const checkmarks = fieldGroup.find('.radio-dot').sort((a, b) => a.id().localeCompare(b.id()));
      const text = fieldGroup.find('.radio-text').sort((a, b) => a.id().localeCompare(b.id()));

      const groupedItems = circles.map((circle, i) => ({
        circleElement: circle,
        checkmarkElement: checkmarks[i],
        textElement: text[i],
      }));

      groupedItems.forEach((item, i) => {
        const { circleElement, checkmarkElement, textElement } = item;

        const { itemInputX, itemInputY, textX, textY, textWidth, textHeight } =
          calculateMultiItemPosition({
            fieldWidth: rectWidth,
            fieldHeight: rectHeight,
            itemCount: radioValues.length,
            itemIndex: i,
            itemSize,
            spacingBetweenItemAndText: spacingBetweenRadioAndText,
            fieldPadding: radioFieldPadding,
            type: 'radio',
            direction: radioMeta?.direction || 'vertical',
          });

        circleElement.setAttrs({
          x: itemInputX,
          y: itemInputY,
          scaleX: 1,
          scaleY: 1,
        });

        checkmarkElement.setAttrs({
          x: itemInputX,
          y: itemInputY,
          scaleX: 1,
          scaleY: 1,
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

      fieldRect.width(rectWidth);
      fieldRect.height(rectHeight);

      fieldGroup.scale({
        x: 1,
        y: 1,
      });

      pageLayer.batchDraw();
    });
  }

  const { fieldWidth, fieldHeight } = calculateFieldPosition(field, pageWidth, pageHeight);

  radioValues.forEach(({ value, checked, offsetX, offsetY }, index) => {
    const isRadioValueChecked = match(mode)
      .with('edit', () => checked)
      .with('sign', () => index.toString() === field.customText)
      .with('export', () => {
        // If it's read-only, check the originally checked state.
        if (radioMeta.readOnly) {
          return checked;
        }

        return index.toString() === field.customText;
      })
      .exhaustive();

    if (isFreeLayout) {
      const { anchorX, anchorY, itemInputX, itemInputY, textX, textY, textHeight } =
        calculateFreeItemPosition({
          offsetX,
          offsetY,
          itemIndex: index,
          itemSize,
          spacingBetweenItemAndText: spacingBetweenRadioAndText,
          fontSize,
          pageWidth,
          pageHeight,
          type: 'radio',
        });

      const optionGroup = new Konva.Group({
        internalRadioIndex: index,
        id: `${field.renderId}-option-${index}`,
        name: 'field-option-group',
        x: anchorX,
        y: anchorY,
      });

      const circle = new Konva.Circle({
        internalRadioIndex: index,
        id: `radio-circle-${index}`,
        name: 'radio-circle',
        x: itemInputX,
        y: itemInputY,
        radius: itemSize / 2,
        stroke: '#374151',
        strokeWidth: 1.5,
        fill: 'white',
      });

      const dot = new Konva.Circle({
        internalRadioIndex: index,
        id: `radio-dot-${index}`,
        name: 'radio-dot',
        x: itemInputX,
        y: itemInputY,
        radius: itemSize / 4,
        fill: '#111827',
        visible: isRadioValueChecked,
      });

      const text = showOptionText
        ? new Konva.Text({
            internalRadioIndex: index,
            id: `radio-text-${index}`,
            name: 'radio-text',
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

      const optionRectX = -radioOptionRectPadding;
      const optionRectY = (text ? textY : 0) - radioOptionRectPadding;
      const optionRectWidth = text
        ? itemSize +
          spacingBetweenRadioAndText +
          (value ? text.width() : 0) +
          radioOptionRectPadding * 2
        : itemSize + radioOptionRectPadding * 2;
      const optionRectHeight = (text ? textHeight : itemSize) + radioOptionRectPadding * 2;

      const optionRect = createFieldOptionRect({
        attrs: { internalRadioIndex: index },
        id: `${field.renderId}-option-rect-${index}`,
        x: optionRectX,
        y: optionRectY,
        width: optionRectWidth,
        height: optionRectHeight,
        options,
      });

      optionGroup.add(optionRect);
      optionGroup.add(circle);
      optionGroup.add(dot);

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
        itemCount: radioValues.length,
        itemIndex: index,
        itemSize,
        spacingBetweenItemAndText: spacingBetweenRadioAndText,
        fieldPadding: radioFieldPadding,
        type: 'radio',
        direction: radioMeta?.direction || 'vertical',
      });

    // Circle which represents the radio button.
    const circle = new Konva.Circle({
      internalRadioIndex: index,
      id: `radio-circle-${index}`,
      name: 'radio-circle',
      x: itemInputX,
      y: itemInputY,
      radius: itemSize / 2,
      stroke: '#374151',
      strokeWidth: 1.5,
      fill: 'white',
    });

    // Dot which represents the selected state.
    const dot = new Konva.Circle({
      internalRadioIndex: index,
      id: `radio-dot-${index}`,
      name: 'radio-dot',
      x: itemInputX,
      y: itemInputY,
      radius: itemSize / 4,
      fill: '#111827',
      visible: isRadioValueChecked,
    });

    fieldGroup.add(circle);
    fieldGroup.add(dot);

    if (showOptionText) {
      const text = new Konva.Text({
        internalRadioIndex: index,
        id: `radio-text-${index}`,
        name: 'radio-text',
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
