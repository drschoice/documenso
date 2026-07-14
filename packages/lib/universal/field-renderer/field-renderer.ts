import type { FieldType, Signature } from '@prisma/client';
import { type Field } from '@prisma/client';
import type Konva from 'konva';

import type { TRecipientColor } from '@documenso/ui/lib/recipient-colors';

import { DEFAULT_STANDARD_FONT_SIZE } from '../../constants/pdf';
import type { TFieldMetaSchema } from '../../types/field-meta';

export const MIN_FIELD_HEIGHT_PX = 12;
export const MIN_FIELD_WIDTH_PX = 36;

export type FieldToRender = Pick<
  Field,
  'envelopeItemId' | 'recipientId' | 'type' | 'page' | 'customText' | 'inserted' | 'recipientId'
> & {
  renderId: string; // A unique ID for the field in the render.
  width: number;
  height: number;
  positionX: number;
  positionY: number;
  fieldMeta?: TFieldMetaSchema | null;
  signature?: Pick<Signature, 'signatureImageAsBase64' | 'typedSignature'> | null;
};

export type RenderFieldElementOptions = {
  pageLayer: Konva.Layer;
  pageWidth: number;
  pageHeight: number;
  mode: 'edit' | 'sign' | 'export';
  editable?: boolean;
  scale: number;
  color?: TRecipientColor;
  translations: Record<FieldType, string> | null;
};

/**
 * Converts a fields percentage based values to pixel based values.
 */
export const calculateFieldPosition = (
  field: Pick<FieldToRender, 'width' | 'height' | 'positionX' | 'positionY'>,
  pageWidth: number,
  pageHeight: number,
) => {
  const fieldWidth = pageWidth * (Number(field.width) / 100);
  const fieldHeight = pageHeight * (Number(field.height) / 100);

  const fieldX = pageWidth * (Number(field.positionX) / 100);
  const fieldY = pageHeight * (Number(field.positionY) / 100);

  return { fieldX, fieldY, fieldWidth, fieldHeight };
};

type ConvertPixelToPercentageOptions = {
  positionX: number;
  positionY: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
};

export const convertPixelToPercentage = (options: ConvertPixelToPercentageOptions) => {
  const { positionX, positionY, width, height, pageWidth, pageHeight } = options;

  const fieldX = (positionX / pageWidth) * 100;
  const fieldY = (positionY / pageHeight) * 100;

  const fieldWidth = (width / pageWidth) * 100;
  const fieldHeight = (height / pageHeight) * 100;

  return { fieldX, fieldY, fieldWidth, fieldHeight };
};

/**
 * Resolve the size of a radio button/checkbox square in pixels.
 *
 * Uses the explicit button size when set, otherwise falls back to the font
 * size which was the original behaviour.
 */
export const resolveButtonSize = (
  meta?: { buttonSize?: number; fontSize?: number } | null,
): number => {
  return meta?.buttonSize ?? meta?.fontSize ?? DEFAULT_STANDARD_FONT_SIZE;
};

type CalculateFreeItemPositionOptions = {
  /**
   * Offsets relative to the field's top-left corner, in page-percentage units.
   *
   * Undefined offsets (e.g. options created via the API) fall back to a
   * deterministic vertical stack from the field origin.
   */
  offsetX: number | undefined;
  offsetY: number | undefined;

  /**
   * The position of the item in the list, used for the fallback stack.
   *
   * Starts from 0
   */
  itemIndex: number;

  /**
   * The size of the item input, example checkbox box, radio button, etc.
   */
  itemSize: number;

  /**
   * The spacing between the item and text.
   */
  spacingBetweenItemAndText: number;

  /**
   * The font size of the item label.
   */
  fontSize: number;

  /**
   * The page width and height in pixels, used to convert percentage offsets.
   */
  pageWidth: number;
  pageHeight: number;

  type: 'checkbox' | 'radio';
};

/**
 * Calculate the position of a free-layout field item.
 *
 * `anchorX`/`anchorY` position the option group relative to the field group,
 * while the remaining coordinates are relative to the option group itself.
 */
export const calculateFreeItemPosition = (options: CalculateFreeItemPositionOptions) => {
  const {
    offsetX,
    offsetY,
    itemIndex,
    itemSize,
    spacingBetweenItemAndText,
    fontSize,
    pageWidth,
    pageHeight,
    type,
  } = options;

  const hasOffsets = offsetX !== undefined && offsetY !== undefined;

  const anchorX = hasOffsets ? pageWidth * (offsetX / 100) : 0;
  const anchorY = hasOffsets
    ? pageHeight * (offsetY / 100)
    : itemIndex * (itemSize + spacingBetweenItemAndText);

  let itemInputX = 0;
  let itemInputY = 0;

  // Radio circles are positioned by their center point.
  if (type === 'radio') {
    itemInputX = itemSize / 2;
    itemInputY = itemSize / 2;
  }

  const textHeight = Math.max(itemSize, fontSize);

  const textX = itemSize + spacingBetweenItemAndText;
  const textY = itemSize / 2 - textHeight / 2;

  return {
    anchorX,
    anchorY,
    itemInputX,
    itemInputY,
    textX,
    textY,
    // No width means Konva will auto-size the text to its content.
    textWidth: undefined,
    textHeight,
  };
};

type CalculateMultiItemPositionOptions = {
  /**
   * The field width in pixels.
   */
  fieldWidth: number;

  /**
   * The field height in pixels.
   */
  fieldHeight: number;

  /**
   * Total amount of items that will be rendered.
   */
  itemCount: number;

  /**
   * The position of the item in the list.
   *
   * Starts from 0
   */
  itemIndex: number;

  /**
   * The size of the item input, example checkbox box, radio button, etc.
   */
  itemSize: number;

  /**
   * The spacing between the item and text.
   */
  spacingBetweenItemAndText: number;

  /**
   * The inner padding of the field.
   */
  fieldPadding: number;

  /**
   * The direction of the items.
   */
  direction: 'horizontal' | 'vertical';

  type: 'checkbox' | 'radio';
};

/**
 * Calculate the position of a field item such as Checkbox, Radio.
 */
export const calculateMultiItemPosition = (options: CalculateMultiItemPositionOptions) => {
  const {
    fieldWidth,
    fieldHeight,
    itemCount,
    itemIndex,
    itemSize,
    spacingBetweenItemAndText,
    fieldPadding,
    direction,
    type,
  } = options;

  const innerFieldHeight = fieldHeight - fieldPadding * 2;
  const innerFieldWidth = fieldWidth - fieldPadding; // This is purposefully not using fullPadding to allow flush text.
  const innerFieldX = fieldPadding;
  const innerFieldY = fieldPadding;

  if (direction === 'horizontal') {
    const itemHeight = innerFieldHeight;
    const itemWidth = innerFieldWidth / itemCount;

    const y = innerFieldY;
    const x = itemIndex * itemWidth + innerFieldX;

    let itemInputY = y + itemHeight / 2 - itemSize / 2;
    let itemInputX = x;

    // We need a little different logic to center the radio circle icon.
    if (type === 'radio') {
      itemInputX = x + itemSize / 2;
      itemInputY = y + itemHeight / 2;
    }

    const textX = x + itemSize + spacingBetweenItemAndText;
    const textY = y;

    // Multiplied by 2 for extra padding on the right hand side of the text and the next item.
    const textWidth = itemWidth - itemSize - spacingBetweenItemAndText * 2;
    const textHeight = itemHeight;

    return {
      itemInputX,
      itemInputY,
      textX,
      textY,
      textWidth,
      textHeight,
    };
  }

  const itemHeight = innerFieldHeight / itemCount;

  const y = itemIndex * itemHeight + innerFieldY;

  let itemInputY = y + itemHeight / 2 - itemSize / 2;
  let itemInputX = innerFieldX;

  // We need a little different logic to center the radio circle icon.
  if (type === 'radio') {
    itemInputX = innerFieldX + itemSize / 2;
    itemInputY = y + itemHeight / 2;
  }

  const textX = innerFieldX + itemSize + spacingBetweenItemAndText;
  const textY = y;
  const textWidth = innerFieldWidth - itemSize - spacingBetweenItemAndText;
  const textHeight = itemHeight;

  return {
    itemInputX,
    itemInputY,
    textX,
    textY,
    textWidth,
    textHeight,
  };
};
