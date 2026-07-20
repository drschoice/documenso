import Konva from 'konva';

import {
  DEFAULT_RECT_BACKGROUND,
  getRecipientColorStyles,
} from '@documenso/ui/lib/recipient-colors';

import type { FieldToRender, RenderFieldElementOptions } from './field-renderer';
import { calculateFieldPosition } from './field-renderer';

export const konvaTextFontFamily =
  '"Noto Sans", "Noto Sans Japanese", "Noto Sans Chinese", "Noto Sans Korean", sans-serif';
export const konvaTextFill = 'black';

export const upsertFieldGroup = (
  field: FieldToRender,
  options: RenderFieldElementOptions,
): Konva.Group => {
  const { pageWidth, pageHeight, pageLayer, editable, scale } = options;

  const { fieldX, fieldY, fieldWidth, fieldHeight } = calculateFieldPosition(
    field,
    pageWidth,
    pageHeight,
  );

  const fieldGroup: Konva.Group =
    pageLayer.findOne(`#${field.renderId}`) ||
    new Konva.Group({
      id: field.renderId,
      name: 'field-group',
    });

  const maxXPosition = (pageWidth - fieldWidth) * scale;
  const maxYPosition = (pageHeight - fieldHeight) * scale;

  fieldGroup.setAttrs({
    scaleX: 1,
    scaleY: 1,
    x: fieldX,
    y: fieldY,
    draggable: editable,
    dragBoundFunc: (pos) => {
      const newX = Math.max(0, Math.min(maxXPosition, pos.x));
      const newY = Math.max(0, Math.min(maxYPosition, pos.y));

      return { x: newX, y: newY };
    },
  } satisfies Partial<Konva.GroupConfig>);

  return fieldGroup;
};

export const upsertFieldRect = (
  field: FieldToRender,
  options: RenderFieldElementOptions,
): Konva.Rect => {
  const { pageWidth, pageHeight, mode, pageLayer, color } = options;

  const { fieldWidth, fieldHeight } = calculateFieldPosition(field, pageWidth, pageHeight);

  const fieldRect: Konva.Rect =
    pageLayer.findOne(`#${field.renderId}-rect`) ||
    new Konva.Rect({
      id: `${field.renderId}-rect`,
      name: 'field-rect',
    });

  fieldRect.setAttrs({
    width: fieldWidth,
    height: fieldHeight,
    fill: color ? getRecipientColorStyles(color).fieldBackground : DEFAULT_RECT_BACKGROUND,
    stroke: color ? getRecipientColorStyles(color).fieldBorder : '#e5e7eb',
    strokeWidth: 2,
    cornerRadius: 2,
    strokeScaleEnabled: false,
    visible: mode !== 'export',
  } satisfies Partial<Konva.RectConfig>);

  return fieldRect;
};

/**
 * Background rect rendered behind each option of a free-layout radio/checkbox
 * field. Carries the same internal index attrs as the option shapes so it acts
 * as a click/drag target.
 */
export const createFieldOptionRect = ({
  attrs,
  id,
  x,
  y,
  width,
  height,
  options,
}: {
  attrs: Record<string, number>;
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  options: RenderFieldElementOptions;
}): Konva.Rect => {
  const { mode, color } = options;

  return new Konva.Rect({
    ...attrs,
    id,
    name: 'field-option-rect',
    x,
    y,
    width,
    height,
    fill: color ? getRecipientColorStyles(color).fieldBackground : DEFAULT_RECT_BACKGROUND,
    stroke: color ? getRecipientColorStyles(color).fieldBorder : '#e5e7eb',
    strokeWidth: 1.5,
    cornerRadius: 2,
    strokeScaleEnabled: false,
    visible: mode !== 'export',
  });
};

/**
 * Hover effect for free-layout fields, highlighting every option rect so the
 * whole logical field lights up together.
 */
export const createFieldOptionsHoverInteraction = ({
  options,
  fieldGroup,
}: {
  options: RenderFieldElementOptions;
  fieldGroup: Konva.Group;
}) => {
  const { mode } = options;

  if (mode === 'export' || !options.color) {
    return;
  }

  const { baseRingHover: hoverColor, fieldBackground: restingColor } = getRecipientColorStyles(
    options.color,
  );

  const tweenOptionRects = (fill: string) => {
    fieldGroup.find('.field-option-rect').forEach((rect) => {
      new Konva.Tween({
        node: rect,
        duration: 0.3,
        fill,
      }).play();
    });
  };

  fieldGroup.off('mouseover.optionHover mouseout.optionHover');
  fieldGroup.on('mouseover.optionHover', () => tweenOptionRects(hoverColor));
  fieldGroup.on('mouseout.optionHover', () => tweenOptionRects(restingColor));
};

/**
 * The bounding box of all option groups of a free-layout field, relative to
 * the provided container.
 *
 * Purposefully excludes decorations (outline, move handle) so it can be used
 * to derive the field's stored position and bounds.
 */
export const getFieldOptionGroupsUnion = (
  fieldGroup: Konva.Group,
  relativeTo: Konva.Container = fieldGroup,
) => {
  const optionGroups = fieldGroup.find<Konva.Group>('.field-option-group');

  if (optionGroups.length === 0) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const optionGroup of optionGroups) {
    const rect = optionGroup.getClientRect({
      relativeTo,
      skipShadow: true,
      skipStroke: true,
    });

    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

const FREE_LAYOUT_HANDLE_SIZE = 16;

/**
 * Editor-only decorations for free-layout fields:
 *
 * - A dashed outline around the union of all options showing they belong to
 *   one logical field.
 * - A move handle chip at the union's top-left corner. It is a non-draggable
 *   child of the field group, so dragging it bubbles up and moves the whole
 *   group at once.
 *
 * Safe to call repeatedly, both after a re-render and during option drags.
 */
export const upsertFreeLayoutDecorations = ({
  fieldGroup,
  options,
}: {
  fieldGroup: Konva.Group;
  options: Pick<RenderFieldElementOptions, 'mode' | 'editable' | 'color'>;
}) => {
  const { mode, editable, color } = options;

  if (mode !== 'edit' || !editable) {
    return;
  }

  const union = getFieldOptionGroupsUnion(fieldGroup);

  if (!union) {
    return;
  }

  const stroke = color ? getRecipientColorStyles(color).baseRing : '#e5e7eb';

  let outline = fieldGroup.findOne<Konva.Rect>('.field-free-outline');

  if (!outline) {
    outline = new Konva.Rect({
      name: 'field-free-outline',
      listening: false,
      dash: [4, 4],
      strokeWidth: 1,
      strokeScaleEnabled: false,
    });

    fieldGroup.add(outline);
  }

  outline.setAttrs({
    x: union.x - 2,
    y: union.y - 2,
    width: union.width + 4,
    height: union.height + 4,
    stroke,
  });

  let moveHandle = fieldGroup.findOne<Konva.Group>('.field-free-move-handle');

  if (!moveHandle) {
    moveHandle = new Konva.Group({
      name: 'field-free-move-handle',
    });

    moveHandle.add(
      new Konva.Rect({
        width: FREE_LAYOUT_HANDLE_SIZE,
        height: FREE_LAYOUT_HANDLE_SIZE,
        fill: stroke,
        cornerRadius: 3,
      }),
    );

    // Drag handle dot pattern.
    for (const [dotX, dotY] of [
      [6, 4],
      [10, 4],
      [6, 8],
      [10, 8],
      [6, 12],
      [10, 12],
    ]) {
      moveHandle.add(
        new Konva.Circle({
          x: dotX,
          y: dotY,
          radius: 1.2,
          fill: 'white',
          listening: false,
        }),
      );
    }

    moveHandle.on('mouseenter', () => {
      const container = moveHandle?.getStage()?.container();

      if (container) {
        container.style.cursor = 'move';
      }
    });

    moveHandle.on('mouseleave', () => {
      const container = moveHandle?.getStage()?.container();

      if (container) {
        container.style.cursor = '';
      }
    });

    fieldGroup.add(moveHandle);
  }

  moveHandle.position({
    x: union.x - 2 - FREE_LAYOUT_HANDLE_SIZE / 2,
    y: union.y - 2 - FREE_LAYOUT_HANDLE_SIZE / 2,
  });
};

/**
 * A memoized 8×8 diagonal-stripe tile used as a Konva `fillPatternImage`.
 * Created lazily so this module stays importable in non-DOM (server render)
 * contexts — the striping helpers below are only ever called from the editor.
 */
const stripeTileCache = new Map<string, HTMLCanvasElement>();

const getStripeTile = (stroke: string): HTMLCanvasElement | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  const cached = stripeTileCache.get(stroke);

  if (cached) {
    return cached;
  }

  const size = 8;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return null;
  }

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, size);
  ctx.lineTo(size, 0);
  ctx.stroke();

  stripeTileCache.set(stroke, canvas);

  return canvas;
};

const VISIBILITY_STRIPES_NAME = 'field-visibility-stripes';

/**
 * Editor-only overlay marking a field that is under a conditional-visibility
 * rule with semi-transparent diagonal stripes. `active` renders a stronger blue
 * highlight for the dependents of the condition currently being authored;
 * otherwise a muted grey. `listening: false` keeps clicks flowing through to
 * the field for selection / pick-mode toggling.
 */
export const upsertVisibilityStripes = ({
  fieldGroup,
  footprint,
  active,
}: {
  fieldGroup: Konva.Group;
  footprint: { x: number; y: number; width: number; height: number };
  active: boolean;
}) => {
  const tile = getStripeTile(active ? '#2563eb' : '#64748b');

  if (!tile) {
    return;
  }

  let stripes = fieldGroup.findOne<Konva.Rect>(`.${VISIBILITY_STRIPES_NAME}`);

  if (!stripes) {
    stripes = new Konva.Rect({
      name: VISIBILITY_STRIPES_NAME,
      listening: false,
      cornerRadius: 2,
    });

    fieldGroup.add(stripes);
  }

  stripes.setAttrs({
    x: footprint.x,
    y: footprint.y,
    width: footprint.width,
    height: footprint.height,
    // Konva types `fillPatternImage` as HTMLImageElement, but a canvas is a
    // valid CanvasImageSource for the underlying createPattern call.
    fillPatternImage: tile as unknown as HTMLImageElement,
    fillPatternRepeat: 'repeat',
    opacity: active ? 0.5 : 0.28,
  } satisfies Partial<Konva.RectConfig>);

  stripes.moveToTop();
};

export const removeVisibilityStripes = (fieldGroup: Konva.Group) => {
  fieldGroup.findOne<Konva.Rect>(`.${VISIBILITY_STRIPES_NAME}`)?.destroy();
};

export const createSpinner = ({
  fieldWidth,
  fieldHeight,
}: {
  fieldWidth: number;
  fieldHeight: number;
}) => {
  const loadingGroup = new Konva.Group({
    name: 'loading-spinner-group',
  });

  const rect = new Konva.Rect({
    x: 4,
    y: 4,
    width: fieldWidth - 8,
    height: fieldHeight - 8,
    fill: 'white',
    opacity: 0.8,
  });

  const maxSpinnerSize = 10;
  const smallerDimension = Math.min(fieldWidth, fieldHeight);
  const spinnerSize = Math.min(smallerDimension, maxSpinnerSize);

  const spinner = new Konva.Arc({
    x: fieldWidth / 2,
    y: fieldHeight / 2,
    innerRadius: spinnerSize,
    outerRadius: spinnerSize / 2,
    angle: 270,
    rotation: 0,
    fill: 'rgba(122, 195, 85, 1)',
    lineCap: 'round',
  });

  loadingGroup.add(rect);
  loadingGroup.add(spinner);

  rect.moveToTop();
  spinner.moveToTop();

  const anim = new Konva.Animation((frame) => {
    spinner.rotate(180 * (frame.timeDiff / 500));
  });

  anim.start();

  return loadingGroup;
};

type CreateFieldHoverInteractionOptions = {
  options: RenderFieldElementOptions;
  fieldGroup: Konva.Group;
  fieldRect: Konva.Rect;
};

/**
 * Adds smooth transition-like behavior for hover effects to the field group and rectangle.
 */
export const createFieldHoverInteraction = ({
  options,
  fieldGroup,
  fieldRect,
}: CreateFieldHoverInteractionOptions) => {
  const { mode } = options;

  if (mode === 'export' || !options.color) {
    return;
  }

  const { baseRingHover: hoverColor, fieldBackground: restingColor } = getRecipientColorStyles(
    options.color,
  );

  fieldGroup.on('mouseover', () => {
    const layer = fieldRect.getLayer();
    if (!layer) {
      return;
    }

    new Konva.Tween({
      node: fieldRect,
      duration: 0.3,
      fill: hoverColor,
    }).play();
  });

  fieldGroup.on('mouseout', () => {
    const layer = fieldRect.getLayer();
    if (!layer) {
      return;
    }

    new Konva.Tween({
      node: fieldRect,
      duration: 0.3,
      fill: restingColor,
    }).play();
  });

  fieldGroup.on('transformstart', () => {
    const layer = fieldRect.getLayer();
    if (!layer) {
      return;
    }

    new Konva.Tween({
      node: fieldRect,
      duration: 0.3,
      fill: hoverColor,
    }).play();
  });

  fieldGroup.on('transformend', () => {
    const layer = fieldRect.getLayer();
    if (!layer) {
      return;
    }

    new Konva.Tween({
      node: fieldRect,
      duration: 0.3,
      fill: restingColor,
    }).play();
  });
};
