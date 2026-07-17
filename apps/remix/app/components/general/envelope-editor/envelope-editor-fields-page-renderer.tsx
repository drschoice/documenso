import { useEffect, useMemo, useRef, useState } from 'react';

import { msg } from '@lingui/core/macro';
import { useLingui as useLinguiReact } from '@lingui/react';
import { useLingui } from '@lingui/react/macro';
import type { FieldType } from '@prisma/client';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Transformer } from 'konva/lib/shapes/Transformer';
import {
  AlignCenterVerticalIcon,
  AlignHorizontalDistributeCenterIcon,
  CopyPlusIcon,
  Settings2Icon,
  SquareStackIcon,
  TrashIcon,
  UserCircleIcon,
} from 'lucide-react';

import type { TLocalField } from '@documenso/lib/client-only/hooks/use-editor-fields';
import { usePageRenderer } from '@documenso/lib/client-only/hooks/use-page-renderer';
import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import {
  type PageRenderData,
  useCurrentEnvelopeRender,
} from '@documenso/lib/client-only/providers/envelope-render-provider';
import { FIELD_META_DEFAULT_VALUES, getCombFieldCells } from '@documenso/lib/types/field-meta';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import {
  getFieldOptionGroupsUnion,
  upsertFreeLayoutDecorations,
} from '@documenso/lib/universal/field-renderer/field-generic-items';
import {
  COMB_CELL_GAP,
  MIN_FIELD_HEIGHT_PX,
  MIN_FIELD_WIDTH_PX,
  calculateFieldPosition,
  calculateMultiItemPosition,
  convertPixelToPercentage,
  resolveButtonSize,
  resolveCellSize,
} from '@documenso/lib/universal/field-renderer/field-renderer';
import { renderField } from '@documenso/lib/universal/field-renderer/render-field';
import { getClientSideFieldTranslations } from '@documenso/lib/utils/fields';
import { parseMessageDescriptor } from '@documenso/lib/utils/i18n';
import { canRecipientFieldsBeModified } from '@documenso/lib/utils/recipients';
import { CommandDialog } from '@documenso/ui/primitives/command';
import type { FieldFormType } from '@documenso/ui/primitives/document-flow/add-fields';
import { FieldAdvancedSettings } from '@documenso/ui/primitives/document-flow/field-item-advanced-settings';
import { FRIENDLY_FIELD_TYPE } from '@documenso/ui/primitives/document-flow/types';
import { Sheet, SheetContent, SheetTitle } from '@documenso/ui/primitives/sheet';

import { fieldButtonList } from './envelope-editor-fields-drag-drop';
import { EnvelopeRecipientSelectorCommand } from './envelope-recipient-selector';

const ADVANCED_FIELD_TYPES = new Set([
  'NUMBER',
  'RADIO',
  'CHECKBOX',
  'DROPDOWN',
  'TEXT',
  'INITIALS',
  'EMAIL',
  'DATE',
  'NAME',
]);

/**
 * Returns the field meta when the field has freely-placed parts: a free-layout
 * radio/checkbox field, or a comb ('cells' layout) text/number field.
 * Otherwise null.
 */
const getFreeLayoutMeta = (field: TLocalField | undefined) => {
  const meta = field?.fieldMeta;

  if (!meta) {
    return null;
  }

  if ((meta.type === 'radio' || meta.type === 'checkbox') && meta.layout === 'free') {
    return meta;
  }

  if ((meta.type === 'text' || meta.type === 'number') && meta.layout === 'cells') {
    return meta;
  }

  return null;
};

export const EnvelopeEditorFieldsPageRenderer = ({ pageData }: { pageData: PageRenderData }) => {
  const { t, i18n } = useLingui();
  const { envelope, editorFields, getRecipientColorKey } = useCurrentEnvelopeEditor();
  const { currentEnvelopeItem, setRenderError } = useCurrentEnvelopeRender();

  const interactiveTransformer = useRef<Transformer | null>(null);

  const [selectedKonvaFieldGroups, setSelectedKonvaFieldGroups] = useState<Konva.Group[]>([]);

  const [isFieldChanging, setIsFieldChanging] = useState(false);
  const [pendingFieldCreation, setPendingFieldCreation] = useState<Konva.Rect | null>(null);

  const { stage, pageLayer, konvaContainer, scaledViewport, unscaledViewport } = usePageRenderer(
    ({ stage, pageLayer }) => createPageCanvas(stage, pageLayer),
    pageData,
  );

  const { scale, pageNumber } = pageData;

  const localPageFields = useMemo(
    () =>
      editorFields.localFields.filter(
        (field) => field.page === pageNumber && field.envelopeItemId === currentEnvelopeItem?.id,
      ),
    [editorFields.localFields, pageNumber, currentEnvelopeItem?.id],
  );

  /**
   * Re-normalize a free-layout field after any of its parts moved:
   *
   * - The field's stored position/bounds become the union of its options.
   * - Each option's offsets are recomputed against the new origin so their
   *   absolute positions are preserved.
   */
  const syncFreeLayoutField = (fieldGroup: Konva.Group) => {
    const fieldFormId = fieldGroup.id();

    const localField = editorFields.getFieldByFormId(fieldFormId);
    const meta = getFreeLayoutMeta(localField);

    if (!localField || !meta || !pageLayer.current) {
      return;
    }

    const union = getFieldOptionGroupsUnion(fieldGroup, pageLayer.current);

    if (!union) {
      return;
    }

    const pageWidth = unscaledViewport.width;
    const pageHeight = unscaledViewport.height;

    const applyItemOffsets = <T extends { offsetX?: number; offsetY?: number }>(
      items: T[],
    ): T[] =>
      items.map((item, index) => {
        const optionGroup = fieldGroup.findOne<Konva.Group>(`#${fieldFormId}-option-${index}`);

        if (!optionGroup) {
          return item;
        }

        const anchorX = fieldGroup.x() + optionGroup.x();
        const anchorY = fieldGroup.y() + optionGroup.y();

        return {
          ...item,
          offsetX: ((anchorX - union.x) / pageWidth) * 100,
          offsetY: ((anchorY - union.y) / pageHeight) * 100,
        };
      });

    const fieldMeta =
      meta.type === 'radio' || meta.type === 'checkbox'
        ? { ...meta, values: applyItemOffsets(meta.values ?? []) }
        : { ...meta, cells: applyItemOffsets(meta.cells ?? []) };

    editorFields.updateFieldByFormId(fieldFormId, {
      positionX: (union.x / pageWidth) * 100,
      positionY: (union.y / pageHeight) * 100,
      width: (union.width / pageWidth) * 100,
      height: (union.height / pageHeight) * 100,
      fieldMeta,
    });
  };

  const handleResizeOrMove = (event: KonvaEventObject<Event>) => {
    const isDragEvent = event.type === 'dragend';

    const fieldGroup = event.target as Konva.Group;
    const fieldFormId = fieldGroup.id();

    // Ignore events bubbled up from free-layout option subgroups, they are
    // handled by their own dragend handler.
    if (!fieldGroup.hasName('field-group')) {
      return;
    }

    // Free-layout fields derive their position and bounds from the union of
    // their options rather than the group client rect, which also contains
    // decorations (dashed outline, move handle) that extend past the options.
    if (getFreeLayoutMeta(editorFields.getFieldByFormId(fieldFormId))) {
      syncFreeLayoutField(fieldGroup);

      if (isDragEvent && interactiveTransformer.current?.nodes().length === 0) {
        setSelectedFields([fieldGroup]);
      }

      pageLayer.current?.batchDraw();
      return;
    }

    // Note: This values are scaled.
    const {
      width: fieldPixelWidth,
      height: fieldPixelHeight,
      x: fieldX,
      y: fieldY,
    } = fieldGroup.getClientRect({
      skipStroke: true,
      skipShadow: true,
    });

    const pageHeight = scaledViewport.height;
    const pageWidth = scaledViewport.width;

    // Calculate x and y as a percentage of the page width and height
    const positionPercentX = (fieldX / pageWidth) * 100;
    const positionPercentY = (fieldY / pageHeight) * 100;

    // Get the bounds as a percentage of the page width and height
    const fieldPageWidth = (fieldPixelWidth / pageWidth) * 100;
    const fieldPageHeight = (fieldPixelHeight / pageHeight) * 100;

    const fieldUpdates: Partial<TLocalField> = {
      positionX: positionPercentX,
      positionY: positionPercentY,
    };

    // Do not update the width/height unless the field has actually been resized.
    // This is because our calculations will shift the width/height slightly
    // due to the way we convert between pixel and percentage.
    if (!isDragEvent) {
      fieldUpdates.width = fieldPageWidth;
      fieldUpdates.height = fieldPageHeight;
    }

    editorFields.updateFieldByFormId(fieldFormId, fieldUpdates);

    // Select the field if it is not already selected.
    if (isDragEvent && interactiveTransformer.current?.nodes().length === 0) {
      setSelectedFields([fieldGroup]);
    }

    pageLayer.current?.batchDraw();
  };

  const unsafeRenderFieldOnLayer = (field: TLocalField) => {
    if (!pageLayer.current) {
      return;
    }

    // Never rebuild a field while it or one of its free-layout options is
    // mid-drag (e.g. when dragging an unselected field selects it and re-runs
    // the render effect). Rebuilding removes the dragged node, which makes
    // Konva force-stop the drag and fire dragend on a half-detached group,
    // corrupting the position sync. The dragend handlers re-render it anyway.
    const existingFieldGroup = pageLayer.current.findOne<Konva.Group>(`#${field.formId}`);

    const isFieldGroupDragging =
      existingFieldGroup !== undefined &&
      (existingFieldGroup.isDragging() ||
        existingFieldGroup
          .find<Konva.Group>('.field-option-group')
          .some((optionGroup) => optionGroup.isDragging()));

    if (isFieldGroupDragging) {
      return;
    }

    const recipient = envelope.recipients.find((r) => r.id === field.recipientId);
    const isFieldEditable =
      recipient !== undefined && canRecipientFieldsBeModified(recipient, envelope.fields);

    const { fieldGroup } = renderField({
      scale,
      pageLayer: pageLayer.current,
      field: {
        renderId: field.formId,
        ...field,
        customText: '',
        inserted: false,
        fieldMeta: field.fieldMeta,
      },
      translations: getClientSideFieldTranslations(i18n),
      pageWidth: unscaledViewport.width,
      pageHeight: unscaledViewport.height,
      color: getRecipientColorKey(field.recipientId),
      editable: isFieldEditable,
      mode: 'edit',
    });

    if (!isFieldEditable) {
      return;
    }

    fieldGroup.off('click');
    fieldGroup.off('transformend');
    fieldGroup.off('dragend');

    // Set up field selection.
    fieldGroup.on('click', () => {
      removePendingField();
      setSelectedFields([fieldGroup]);
      pageLayer.current?.batchDraw();
    });

    fieldGroup.on('transformend', handleResizeOrMove);
    fieldGroup.on('dragend', handleResizeOrMove);

    // Free-layout radio/checkbox options and comb text/number cells are
    // individually draggable.
    fieldGroup.find<Konva.Group>('.field-option-group').forEach((optionGroup) => {
      optionGroup.on('dragmove', () => {
        upsertFreeLayoutDecorations({
          fieldGroup,
          options: {
            mode: 'edit',
            editable: isFieldEditable,
            color: getRecipientColorKey(field.recipientId),
          },
        });

        interactiveTransformer.current?.forceUpdate();
      });

      optionGroup.on('dragend', () => {
        syncFreeLayoutField(fieldGroup);
        pageLayer.current?.batchDraw();
      });
    });
  };

  const renderFieldOnLayer = (field: TLocalField) => {
    try {
      unsafeRenderFieldOnLayer(field);
    } catch (err) {
      console.error(err);
      setRenderError(true);
    }
  };

  /**
   * Initialize the Konva page canvas and all fields and interactions.
   */
  const createPageCanvas = (currentStage: Konva.Stage, currentPageLayer: Konva.Layer) => {
    // Initialize snap guides layer
    // snapGuideLayer.current = initializeSnapGuides(stage.current);

    // Add transformer for resizing and rotating.
    interactiveTransformer.current = createInteractiveTransformer(currentStage, currentPageLayer);

    // Render the fields.
    for (const field of localPageFields) {
      renderFieldOnLayer(field);
    }

    // Handle stage click to deselect.
    currentStage.on('mousedown', (e) => {
      removePendingField();

      if (e.target === stage.current) {
        setSelectedFields([]);
        currentPageLayer.batchDraw();
      }
    });

    // When an item is dragged, select it automatically.
    const onDragStartOrEnd = (e: KonvaEventObject<Event>) => {
      removePendingField();

      // Free-layout option drags select the parent field group.
      if (e.target.hasName('field-option-group')) {
        setIsFieldChanging(e.type === 'dragstart');

        const parentFieldGroup = e.target.findAncestor('.field-group');

        if (
          parentFieldGroup &&
          !(interactiveTransformer.current?.nodes() || []).includes(parentFieldGroup)
        ) {
          setSelectedFields([parentFieldGroup]);
        }

        return;
      }

      if (!e.target.hasName('field-group')) {
        return;
      }

      setIsFieldChanging(e.type === 'dragstart');

      const itemAlreadySelected = (interactiveTransformer.current?.nodes() || []).includes(
        e.target,
      );

      // Do nothing and allow the transformer to handle it.
      // Required so when multiple items are selected, this won't deselect them.
      if (itemAlreadySelected) {
        return;
      }

      setSelectedFields([e.target]);
    };

    currentStage.on('dragstart', onDragStartOrEnd);
    currentStage.on('dragend', onDragStartOrEnd);
    currentStage.on('transformstart', () => setIsFieldChanging(true));
    currentStage.on('transformend', () => setIsFieldChanging(false));

    currentPageLayer.batchDraw();
  };

  /**
   * Creates an interactive transformer for the fields.
   *
   * Allows:
   * - Resizing
   * - Moving
   * - Selecting multiple fields
   * - Selecting empty area to create fields
   */
  const createInteractiveTransformer = (
    currentStage: Konva.Stage,
    currentPageLayer: Konva.Layer,
  ) => {
    const transformer = new Konva.Transformer({
      rotateEnabled: false,
      keepRatio: false,
      shouldOverdrawWholeArea: true,
      ignoreStroke: true,
      flipEnabled: false,
      boundBoxFunc: (oldBox, newBox) => {
        // Enforce minimum size
        if (newBox.width < 30 || newBox.height < 20) {
          return oldBox;
        }

        return newBox;
      },
    });

    currentPageLayer.add(transformer);

    // Add selection rectangle.
    const selectionRectangle = new Konva.Rect({
      fill: 'rgba(24, 160, 251, 0.3)',
      visible: false,
    });
    currentPageLayer.add(selectionRectangle);

    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;

    currentStage.on('mousedown touchstart', (e) => {
      // do nothing if we mousedown on any shape
      if (e.target !== currentStage) {
        return;
      }

      const pointerPosition = currentStage.getPointerPosition();

      if (!pointerPosition) {
        return;
      }

      x1 = pointerPosition.x / scale;
      y1 = pointerPosition.y / scale;
      x2 = pointerPosition.x / scale;
      y2 = pointerPosition.y / scale;

      selectionRectangle.setAttrs({
        x: x1,
        y: y1,
        width: 0,
        height: 0,
        visible: true,
      });
    });

    currentStage.on('mousemove touchmove', () => {
      // do nothing if we didn't start selection
      if (!selectionRectangle.visible()) {
        return;
      }

      selectionRectangle.moveToTop();

      const pointerPosition = currentStage.getPointerPosition();

      if (!pointerPosition) {
        return;
      }

      x2 = pointerPosition.x / scale;
      y2 = pointerPosition.y / scale;

      selectionRectangle.setAttrs({
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      });
    });

    currentStage.on('mouseup touchend', () => {
      // do nothing if we didn't start selection
      if (!selectionRectangle.visible()) {
        return;
      }

      // Update visibility in timeout, so we can check it in click event
      setTimeout(() => {
        selectionRectangle.visible(false);
      });

      const stageFieldGroups = currentStage.find('.field-group') || [];
      const box = selectionRectangle.getClientRect();
      const selectedFieldGroups = stageFieldGroups.filter(
        (shape) => Konva.Util.haveIntersection(box, shape.getClientRect()) && shape.draggable(),
      );
      setSelectedFields(selectedFieldGroups);

      const unscaledBoxWidth = box.width / scale;
      const unscaledBoxHeight = box.height / scale;

      // Create a field if no items are selected or the size is too small.
      if (
        selectedFieldGroups.length === 0 &&
        unscaledBoxWidth > MIN_FIELD_WIDTH_PX &&
        unscaledBoxHeight > MIN_FIELD_HEIGHT_PX &&
        editorFields.selectedRecipient &&
        canRecipientFieldsBeModified(editorFields.selectedRecipient, envelope.fields)
      ) {
        const pendingFieldCreation = new Konva.Rect({
          name: 'pending-field-creation',
          x: box.x / scale,
          y: box.y / scale,
          width: unscaledBoxWidth,
          height: unscaledBoxHeight,
          fill: 'rgba(24, 160, 251, 0.3)',
        });

        currentPageLayer.add(pendingFieldCreation);
        setPendingFieldCreation(pendingFieldCreation);
      }
    });

    // Clicks should select/deselect shapes
    currentStage.on('click tap', function (e) {
      // if we are selecting with rect, do nothing
      if (
        selectionRectangle.visible() &&
        selectionRectangle.width() > 0 &&
        selectionRectangle.height() > 0
      ) {
        return;
      }

      // If empty area clicked, remove all selections
      if (e.target === stage.current) {
        setSelectedFields([]);
        return;
      }

      // Do nothing if field not clicked, or if field is not editable
      if (!e.target.hasName('field-group') || e.target.draggable() === false) {
        return;
      }

      // do we pressed shift or ctrl?
      const metaPressed = e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey;
      const isSelected = transformer.nodes().indexOf(e.target) >= 0;

      if (!metaPressed && !isSelected) {
        // if no key pressed and the node is not selected
        // select just one
        setSelectedFields([e.target]);
      } else if (metaPressed && isSelected) {
        // if we pressed keys and node was selected
        // we need to remove it from selection:
        const nodes = transformer.nodes().slice(); // use slice to have new copy of array
        // remove node from array
        nodes.splice(nodes.indexOf(e.target), 1);
        setSelectedFields(nodes);
      } else if (metaPressed && !isSelected) {
        // add the node into selection
        const nodes = transformer.nodes().concat([e.target]);
        setSelectedFields(nodes);
      }
    });

    return transformer;
  };

  /**
   * Seed per-option offsets for free-layout radio/checkbox fields.
   *
   * Covers two cases:
   * - A field was just toggled to free layout (every offset missing): seed
   *   from the current stacked layout so nothing visually jumps.
   * - New options were added while in free layout: place them below the
   *   bottom-most placed option.
   *
   * Comb text/number cells follow the same pattern, except cells seed as a
   * horizontal row and new cells append to the right of the right-most cell.
   */
  useEffect(() => {
    for (const field of localPageFields) {
      const meta = getFreeLayoutMeta(field);

      if (!meta) {
        continue;
      }

      if (meta.type === 'text' || meta.type === 'number') {
        const cells = meta.cells ?? [];

        const isMissingCellOffsets = cells.some(
          (cell) => cell.offsetX === undefined || cell.offsetY === undefined,
        );

        if (cells.length === 0 || !isMissingCellOffsets) {
          continue;
        }

        const stepPercentX =
          ((resolveCellSize(meta) + COMB_CELL_GAP) / unscaledViewport.width) * 100;

        // Track the right-most placed cell so new cells are appended after it.
        let hasPlacedCells = false;
        let nextAppendX = 0;
        let nextAppendY = 0;

        for (const cell of cells) {
          if (cell.offsetX !== undefined && cell.offsetY !== undefined) {
            const rightOfCell = cell.offsetX + stepPercentX;

            if (!hasPlacedCells || rightOfCell > nextAppendX) {
              nextAppendX = rightOfCell;
              nextAppendY = cell.offsetY;
            }

            hasPlacedCells = true;
          }
        }

        const seededCells = cells.map((cell, index) => {
          if (cell.offsetX !== undefined && cell.offsetY !== undefined) {
            return cell;
          }

          // Just toggled to comb: seed a horizontal row from the field origin
          // so the cells appear where the field currently sits.
          if (!hasPlacedCells) {
            return {
              ...cell,
              offsetX: index * stepPercentX,
              offsetY: 0,
            };
          }

          const seededCell = {
            ...cell,
            offsetX: nextAppendX,
            offsetY: nextAppendY,
          };

          nextAppendX += stepPercentX;

          return seededCell;
        });

        editorFields.updateFieldByFormId(field.formId, {
          fieldMeta: { ...meta, cells: seededCells },
        });

        continue;
      }

      const values = meta.values ?? [];

      const isMissingOffsets = values.some(
        (value) => value.offsetX === undefined || value.offsetY === undefined,
      );

      if (values.length === 0 || !isMissingOffsets) {
        continue;
      }

      const pageWidth = unscaledViewport.width;
      const pageHeight = unscaledViewport.height;

      const itemSize = resolveButtonSize(meta);
      const { fieldWidth, fieldHeight } = calculateFieldPosition(field, pageWidth, pageHeight);

      const isSeededFromBox = values.every(
        (value) => value.offsetX === undefined || value.offsetY === undefined,
      );

      // Track the bottom-most placed option so new options stack below it.
      let nextAppendX = 0;
      let nextAppendY = 0;

      for (const value of values) {
        if (value.offsetX !== undefined && value.offsetY !== undefined) {
          const below = value.offsetY + ((itemSize + 8) / pageHeight) * 100;

          if (below > nextAppendY) {
            nextAppendY = below;
            nextAppendX = value.offsetX;
          }
        }
      }

      const seededValues = values.map((value, index) => {
        if (value.offsetX !== undefined && value.offsetY !== undefined) {
          return value;
        }

        if (isSeededFromBox) {
          // Match the position the option currently occupies in the stacked
          // layout so toggling to free layout is visually a no-op.
          const { itemInputX, itemInputY } = calculateMultiItemPosition({
            fieldWidth,
            fieldHeight,
            itemCount: values.length,
            itemIndex: index,
            itemSize,
            spacingBetweenItemAndText: 8,
            fieldPadding: 8,
            direction: meta.direction || 'vertical',
            type: meta.type,
          });

          // Offsets anchor to the top-left of the button, radios are
          // positioned by their center point.
          const anchorX = meta.type === 'radio' ? itemInputX - itemSize / 2 : itemInputX;
          const anchorY = meta.type === 'radio' ? itemInputY - itemSize / 2 : itemInputY;

          return {
            ...value,
            offsetX: (anchorX / pageWidth) * 100,
            offsetY: (anchorY / pageHeight) * 100,
          };
        }

        const seededValue = {
          ...value,
          offsetX: nextAppendX,
          offsetY: nextAppendY,
        };

        nextAppendY += ((itemSize + 8) / pageHeight) * 100;

        return seededValue;
      });

      editorFields.updateFieldByFormId(field.formId, {
        fieldMeta: { ...meta, values: seededValues },
      });
    }
  }, [localPageFields]);

  /**
   * Render fields when they are added or removed from the localFields.
   */
  useEffect(() => {
    if (!pageLayer.current || !stage.current) {
      return;
    }

    // If doesn't exist in localFields, destroy it since it's been deleted.
    pageLayer.current.find('Group').forEach((group) => {
      if (
        group.name() === 'field-group' &&
        !localPageFields.some((field) => field.formId === group.id())
      ) {
        group.destroy();
      }
    });

    // If it exists, rerender.
    localPageFields.forEach((field) => {
      renderFieldOnLayer(field);
    });

    // Reconcile selection state with live field nodes after flush/sync updates.
    const liveSelectedFieldGroups = selectedKonvaFieldGroups.filter((fieldGroup) => {
      if (!fieldGroup.getStage() || !fieldGroup.getParent()) {
        return false;
      }

      return localPageFields.some((field) => field.formId === fieldGroup.id());
    });

    if (liveSelectedFieldGroups.length !== selectedKonvaFieldGroups.length) {
      setSelectedFields(liveSelectedFieldGroups);
    }

    // Rerender the transformer
    interactiveTransformer.current?.forceUpdate();

    pageLayer.current.batchDraw();
  }, [localPageFields, selectedKonvaFieldGroups]);

  const setSelectedFields = (nodes: Konva.Node[]) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const fieldGroups = nodes.filter(
      (node) =>
        node.hasName('field-group') && Boolean(node.getStage()) && Boolean(node.getParent()),
    ) as Konva.Group[];

    // Resizing has no meaning for free-layout fields (their bounds are derived
    // from their options), and the transformer overdraw area would swallow the
    // drag events of individual options.
    const containsFreeLayoutField = fieldGroups.some((group) =>
      getFreeLayoutMeta(editorFields.getFieldByFormId(group.id())),
    );

    interactiveTransformer.current?.setAttrs({
      resizeEnabled: !containsFreeLayoutField,
      shouldOverdrawWholeArea: !containsFreeLayoutField,
    });

    interactiveTransformer.current?.nodes(fieldGroups);
    setSelectedKonvaFieldGroups(fieldGroups);

    if (fieldGroups.length === 0 || fieldGroups.length > 1) {
      editorFields.setSelectedField(null);
    }

    // Handle single field selection.
    if (fieldGroups.length === 1) {
      const fieldGroup = fieldGroups[0];

      editorFields.setSelectedField(fieldGroup.id());
      fieldGroup.moveToTop();
    }
  };

  const deletedSelectedFields = () => {
    const fieldFormids = selectedKonvaFieldGroups
      .map((field) => field.id())
      .filter((field) => field !== undefined);

    editorFields.removeFieldsByFormId(fieldFormids);

    setSelectedFields([]);
  };

  /**
   * One-click alignment for the selected comb field's cells:
   *
   * - 'row': align every cell to the first cell's row.
   * - 'distribute': also space the cells evenly between the left-most and
   *   right-most cell, in index order.
   *
   * The field origin and bounds are re-normalized against the new cell union
   * in page-percentage space (mirrors syncFreeLayoutField without Konva).
   */
  const alignSelectedCombCells = (alignMode: 'row' | 'distribute') => {
    if (selectedKonvaFieldGroups.length !== 1) {
      return;
    }

    const fieldFormId = selectedKonvaFieldGroups[0].id();
    const localField = editorFields.getFieldByFormId(fieldFormId);
    const meta = localField?.fieldMeta;

    if (
      !localField ||
      !meta ||
      (meta.type !== 'text' && meta.type !== 'number') ||
      meta.layout !== 'cells'
    ) {
      return;
    }

    const cells = meta.cells ?? [];

    // Offsets are seeded by an effect right after comb is enabled, so bail on
    // the rare frame where they are still missing.
    if (
      cells.length < 2 ||
      cells.some((cell) => cell.offsetX === undefined || cell.offsetY === undefined)
    ) {
      return;
    }

    const cellSize = resolveCellSize(meta);
    const rowY = cells[0].offsetY ?? 0;

    let updatedCells = cells.map((cell) => ({ ...cell, offsetY: rowY }));

    if (alignMode === 'distribute') {
      const xs = cells.map((cell) => cell.offsetX ?? 0);
      const spanStart = Math.min(...xs);
      const spanEnd = Math.max(...xs);

      // Preserve the overall span; fall back to the default pitch when the
      // cells are stacked on top of each other.
      let step = (spanEnd - spanStart) / (cells.length - 1);

      if (step <= 0.0001) {
        step = ((cellSize + COMB_CELL_GAP) / unscaledViewport.width) * 100;
      }

      updatedCells = updatedCells.map((cell, index) => ({
        ...cell,
        offsetX: spanStart + index * step,
      }));
    }

    const minX = Math.min(...updatedCells.map((cell) => cell.offsetX ?? 0));
    const minY = Math.min(...updatedCells.map((cell) => cell.offsetY ?? 0));
    const maxX = Math.max(...updatedCells.map((cell) => cell.offsetX ?? 0));
    const maxY = Math.max(...updatedCells.map((cell) => cell.offsetY ?? 0));

    const cellWidthPercent = (cellSize / unscaledViewport.width) * 100;
    const cellHeightPercent = (cellSize / unscaledViewport.height) * 100;

    editorFields.updateFieldByFormId(fieldFormId, {
      positionX: Number(localField.positionX) + minX,
      positionY: Number(localField.positionY) + minY,
      width: maxX - minX + cellWidthPercent,
      height: maxY - minY + cellHeightPercent,
      fieldMeta: {
        ...meta,
        cells: updatedCells.map((cell) => ({
          ...cell,
          offsetX: (cell.offsetX ?? 0) - minX,
          offsetY: (cell.offsetY ?? 0) - minY,
        })),
      },
    });
  };

  const changeSelectedFieldsRecipients = (recipientId: number) => {
    const fields = selectedKonvaFieldGroups
      .map((field) => editorFields.getFieldByFormId(field.id()))
      .filter((field) => field !== undefined);

    for (const field of fields) {
      if (field.recipientId !== recipientId) {
        editorFields.updateFieldByFormId(field.formId, { recipientId, id: undefined });
      }
    }
  };

  const duplicatedSelectedFields = () => {
    const fields = selectedKonvaFieldGroups
      .map((field) => editorFields.getFieldByFormId(field.id()))
      .filter((field) => field !== undefined);

    for (const field of fields) {
      editorFields.duplicateField(field);
    }
  };

  const duplicatedSelectedFieldsOnAllPages = () => {
    const fields = selectedKonvaFieldGroups
      .map((field) => editorFields.getFieldByFormId(field.id()))
      .filter((field) => field !== undefined);

    for (const field of fields) {
      editorFields.duplicateFieldToAllPages(field);
    }

    setSelectedFields([]);
  };

  /**
   * Create a field from a pending field.
   */
  const createFieldFromPendingTemplate = (pendingFieldCreation: Konva.Rect, type: FieldType) => {
    const pixelWidth = pendingFieldCreation.width();
    const pixelHeight = pendingFieldCreation.height();
    const pixelX = pendingFieldCreation.x();
    const pixelY = pendingFieldCreation.y();

    removePendingField();

    if (!currentEnvelopeItem || !editorFields.selectedRecipient) {
      return;
    }

    const { fieldX, fieldY, fieldWidth, fieldHeight } = convertPixelToPercentage({
      width: pixelWidth,
      height: pixelHeight,
      positionX: pixelX,
      positionY: pixelY,
      pageWidth: unscaledViewport.width,
      pageHeight: unscaledViewport.height,
    });

    editorFields.addField({
      envelopeItemId: currentEnvelopeItem.id,
      page: pageNumber,
      type,
      positionX: fieldX,
      positionY: fieldY,
      width: fieldWidth,
      height: fieldHeight,
      recipientId: editorFields.selectedRecipient.id,
      fieldMeta: structuredClone(FIELD_META_DEFAULT_VALUES[type]),
    });
  };

  /**
   * Remove any pending fields or rectangle on the canvas.
   */
  const removePendingField = () => {
    setPendingFieldCreation(null);

    const pendingFieldCreation = pageLayer.current?.find('.pending-field-creation') || [];

    for (const field of pendingFieldCreation) {
      field.destroy();
    }
  };

  if (!currentEnvelopeItem) {
    return null;
  }

  return (
    <>
      {selectedKonvaFieldGroups.length > 0 &&
        interactiveTransformer.current &&
        !isFieldChanging && (
          <FieldActionButtons
            handleDuplicateSelectedFields={duplicatedSelectedFields}
            handleDuplicateSelectedFieldsOnAllPages={duplicatedSelectedFieldsOnAllPages}
            handleDeleteSelectedFields={deletedSelectedFields}
            handleChangeRecipient={changeSelectedFieldsRecipients}
            handleAlignCombCells={alignSelectedCombCells}
            selectedFieldFormId={selectedKonvaFieldGroups.map((field) => field.id())}
            style={{
              position: 'absolute',
              top:
                interactiveTransformer.current.y() +
                interactiveTransformer.current.getClientRect().height +
                5 +
                'px',
              left:
                interactiveTransformer.current.x() +
                interactiveTransformer.current.getClientRect().width / 2 +
                'px',
              transform: 'translateX(-50%)',
              gap: '8px',
              pointerEvents: 'auto',
              zIndex: 50,
            }}
          />
        )}

      {pendingFieldCreation && (
        <div
          style={{
            position: 'absolute',
            top:
              pendingFieldCreation.y() * scale +
              pendingFieldCreation.getClientRect().height +
              5 +
              'px',
            left:
              pendingFieldCreation.x() * scale +
              pendingFieldCreation.getClientRect().width / 2 +
              'px',
            transform: 'translateX(-50%)',
            zIndex: 50,
          }}
          // Don't use darkmode for this component, it should look the same for both light/dark modes.
          className="grid w-max grid-cols-5 gap-x-1 gap-y-0.5 rounded-md border border-gray-300 bg-white p-1 text-gray-500 shadow-sm"
        >
          {fieldButtonList.map((field) => (
            <button
              key={field.type}
              onClick={() => createFieldFromPendingTemplate(pendingFieldCreation, field.type)}
              className="col-span-1 w-full flex-shrink-0 rounded-sm px-2 py-1 text-xs hover:bg-gray-100 hover:text-gray-600"
            >
              {t(field.name)}
            </button>
          ))}
        </div>
      )}

      {/* The element Konva will inject it's canvas into. */}
      <div className="konva-container absolute inset-0 z-10 w-full" ref={konvaContainer}></div>
    </>
  );
};

type FieldActionButtonsProps = React.HTMLAttributes<HTMLDivElement> & {
  handleDuplicateSelectedFields: () => void;
  handleDuplicateSelectedFieldsOnAllPages: () => void;
  handleDeleteSelectedFields: () => void;
  handleChangeRecipient: (recipientId: number) => void;
  handleAlignCombCells: (alignMode: 'row' | 'distribute') => void;
  selectedFieldFormId: string[];
};

const FieldActionButtons = ({
  handleDuplicateSelectedFields,
  handleDuplicateSelectedFieldsOnAllPages,
  handleDeleteSelectedFields,
  handleChangeRecipient,
  handleAlignCombCells,
  selectedFieldFormId,
  ...props
}: FieldActionButtonsProps) => {
  const { t } = useLingui();
  const { _ } = useLinguiReact();

  const [showRecipientSelector, setShowRecipientSelector] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  const { editorFields, envelope } = useCurrentEnvelopeEditor();

  /**
   * Decide the preselected recipient in the command input.
   *
   * If all fields belong to the same recipient then use that recipient as the default.
   *
   * Otherwise show the placeholder.
   */
  const preselectedRecipient = useMemo(() => {
    if (selectedFieldFormId.length === 0) {
      return null;
    }

    const fields = editorFields.localFields.filter((field) =>
      selectedFieldFormId.includes(field.formId),
    );

    if (fields.length === 0) {
      return null;
    }

    const recipient = envelope.recipients.find(
      (recipient) => recipient.id === fields[0].recipientId,
    );

    if (!recipient) {
      return null;
    }

    const isRecipientsSame = fields.every((field) => field.recipientId === recipient.id);

    if (isRecipientsSame) {
      return recipient;
    }

    return null;
  }, [editorFields.localFields, envelope.recipients, selectedFieldFormId]);

  const singleSelectedLocalField = useMemo(() => {
    if (selectedFieldFormId.length !== 1) {
      return null;
    }

    return editorFields.localFields.find((f) => f.formId === selectedFieldFormId[0]) ?? null;
  }, [editorFields.localFields, selectedFieldFormId]);

  const isAdvancedField =
    singleSelectedLocalField !== null && ADVANCED_FIELD_TYPES.has(singleSelectedLocalField.type);

  const isCombField =
    singleSelectedLocalField !== null &&
    getCombFieldCells(singleSelectedLocalField.fieldMeta) !== null;

  const toFieldFormType = (localField: TLocalField): FieldFormType => {
    const recipient = envelope.recipients.find((r) => r.id === localField.recipientId);

    return {
      nativeId: localField.id,
      formId: localField.formId,
      pageNumber: localField.page,
      type: localField.type,
      pageX: localField.positionX,
      pageY: localField.positionY,
      pageWidth: localField.width,
      pageHeight: localField.height,
      recipientId: localField.recipientId,
      signerEmail: recipient?.email ?? '',
      fieldMeta: localField.fieldMeta,
    };
  };

  const advancedSettingsField = singleSelectedLocalField
    ? toFieldFormType(singleSelectedLocalField)
    : null;

  const advancedSettingsFields = useMemo(() => {
    if (!singleSelectedLocalField) {
      return [];
    }

    return editorFields.localFields
      .filter((f) => f.recipientId === singleSelectedLocalField.recipientId)
      .map(toFieldFormType);
  }, [editorFields.localFields, singleSelectedLocalField]);

  return (
    <div className="flex flex-col items-center" {...props}>
      <div className="group flex w-fit items-center justify-evenly gap-x-1 rounded-md border bg-gray-900 p-0.5">
        {isAdvancedField && (
          <button
            title={t`Advanced settings`}
            className="rounded-sm p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100"
            onClick={() => setShowAdvancedSettings(true)}
            onTouchEnd={() => setShowAdvancedSettings(true)}
          >
            <Settings2Icon className="h-3 w-3" />
          </button>
        )}

        {isCombField && (
          <>
            <button
              title={t`Align cells into a row`}
              className="rounded-sm p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100"
              onClick={() => handleAlignCombCells('row')}
              onTouchEnd={() => handleAlignCombCells('row')}
            >
              <AlignCenterVerticalIcon className="h-3 w-3" />
            </button>

            <button
              title={t`Distribute cells evenly`}
              className="rounded-sm p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100"
              onClick={() => handleAlignCombCells('distribute')}
              onTouchEnd={() => handleAlignCombCells('distribute')}
            >
              <AlignHorizontalDistributeCenterIcon className="h-3 w-3" />
            </button>
          </>
        )}

        <button
          title={t`Change Recipient`}
          className="rounded-sm p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100"
          onClick={() => setShowRecipientSelector(true)}
          onTouchEnd={() => setShowRecipientSelector(true)}
        >
          <UserCircleIcon className="h-3 w-3" />
        </button>

        <button
          title={t`Duplicate`}
          className="rounded-sm p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100"
          onClick={handleDuplicateSelectedFields}
          onTouchEnd={handleDuplicateSelectedFields}
        >
          <CopyPlusIcon className="h-3 w-3" />
        </button>

        <button
          title={t`Duplicate on all pages`}
          className="rounded-sm p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100"
          onClick={handleDuplicateSelectedFieldsOnAllPages}
          onTouchEnd={handleDuplicateSelectedFieldsOnAllPages}
        >
          <SquareStackIcon className="h-3 w-3" />
        </button>

        <button
          title={t`Remove`}
          className="rounded-sm p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100"
          onClick={handleDeleteSelectedFields}
          onTouchEnd={handleDeleteSelectedFields}
        >
          <TrashIcon className="h-3 w-3" />
        </button>
      </div>

      <CommandDialog
        position="start"
        open={showRecipientSelector}
        onOpenChange={setShowRecipientSelector}
      >
        <EnvelopeRecipientSelectorCommand
          placeholder={t`Select a recipient`}
          selectedRecipient={preselectedRecipient}
          onSelectedRecipientChange={(recipient) => {
            editorFields.setSelectedRecipient(recipient.id);
            handleChangeRecipient(recipient.id);
            setShowRecipientSelector(false);
          }}
          recipients={envelope.recipients}
          fields={envelope.fields}
        />
      </CommandDialog>

      {advancedSettingsField && (
        <Sheet open={showAdvancedSettings} onOpenChange={setShowAdvancedSettings}>
          <SheetContent position="right" size="lg" className="w-9/12 max-w-sm overflow-y-auto">
            <SheetTitle className="sr-only">
              {parseMessageDescriptor(
                _,
                msg`Configure ${parseMessageDescriptor(_, FRIENDLY_FIELD_TYPE[advancedSettingsField.type])} Field`,
              )}
            </SheetTitle>

            <FieldAdvancedSettings
              title={msg`Advanced settings`}
              description={msg`Configure the ${parseMessageDescriptor(
                _,
                FRIENDLY_FIELD_TYPE[advancedSettingsField.type],
              )} field`}
              field={advancedSettingsField}
              fields={advancedSettingsFields}
              isDocumentPdfLoaded={false}
              onAdvancedSettings={() => setShowAdvancedSettings(false)}
              onSave={(fieldMeta: TFieldMetaSchema) => {
                editorFields.updateFieldByFormId(advancedSettingsField.formId, { fieldMeta });
                setShowAdvancedSettings(false);
              }}
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
};
