import { useLayoutEffect, useRef, useState } from 'react';

import { type Field, FieldType } from '@prisma/client';

import { DEFAULT_STANDARD_FONT_SIZE } from '@documenso/lib/constants/pdf';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import { getCombFieldCells } from '@documenso/lib/types/field-meta';
import { getCombCellOverlayRects } from '@documenso/lib/universal/field-inline-signing/overlay-geometry';
import type { TInlineCommitError } from '@documenso/lib/universal/field-inline-signing/resolve-inline-commit';
import { konvaTextFontFamily } from '@documenso/lib/universal/field-renderer/field-generic-items';
import { cn } from '@documenso/ui/lib/utils';

import { MIN_INPUT_FONT_SIZE } from './envelope-signer-inline-field-editor';
import type { TInlineNavigationDirection } from './envelope-signing-inline-edit-provider';
import { useInlineEditorSession } from './use-inline-editor-session';

type EnvelopeSignerInlineCombEditorProps = {
  field: Pick<
    Field,
    'id' | 'type' | 'inserted' | 'customText' | 'positionX' | 'positionY' | 'width' | 'height'
  > & { fieldMeta?: TFieldMetaSchema | null };
  /** The unscaled page size, which the field's percentage position is relative to. */
  pageWidth: number;
  pageHeight: number;
  scale: number;
  initialValue: string;
  /** The cell the signer clicked, so typing starts there. Defaults to the end of the value. */
  initialCaret?: number;
  label: string;
  onCommit: (draft: string) => TInlineCommitError | null;
  onClose: () => void;
  onNavigate: (direction: TInlineNavigationDirection) => void;
};

/**
 * Types a comb (character-cell) field in place: each character appears in its own cell as it is
 * typed, and the cell the next character goes into is ringed.
 *
 * The keystrokes go to a native input kept invisible over the active cell, so Backspace, Delete,
 * the arrow keys, paste and input methods all behave as they do in any text box. The cells only
 * draw its value. Clicking a cell moves the caret there without taking focus from the input.
 *
 * The page's Konva characters for the field are hidden while this is open. Saving and cancelling
 * work as described on `useInlineEditorSession`.
 */
export const EnvelopeSignerInlineCombEditor = ({
  field,
  pageWidth,
  pageHeight,
  scale,
  initialValue,
  initialCaret,
  label,
  onCommit,
  onClose,
  onNavigate,
}: EnvelopeSignerInlineCombEditorProps) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const { draft, setDraft, errorMessage, finish, handleBlur } = useInlineEditorSession({
    initialValue,
    onCommit,
    onClose,
    onNavigate,
  });

  const [caret, setCaret] = useState(() =>
    Math.min(initialCaret ?? initialValue.length, initialValue.length),
  );

  const fieldMeta = field.fieldMeta;
  const cells = getCombFieldCells(fieldMeta) ?? [];

  const cellRects = getCombCellOverlayRects(
    field,
    {
      cells,
      cellSize: fieldMeta && 'cellSize' in fieldMeta ? fieldMeta.cellSize : undefined,
      fontSize: fieldMeta?.fontSize,
    },
    pageWidth,
    pageHeight,
    scale,
  );

  const cellCount = cellRects.length;
  const characters = [...draft];

  const activeCellIndex = Math.max(0, Math.min(caret, cellCount - 1));
  const activeCellRect = cellRects[activeCellIndex];

  const fontSize = (fieldMeta?.fontSize || DEFAULT_STANDARD_FONT_SIZE) * scale;

  // The error sits under the lowest cell, aligned with the leftmost one.
  const errorLeft = Math.min(...cellRects.map((rect) => rect.left));
  const errorTop = Math.max(...cellRects.map((rect) => rect.top + rect.height));

  useLayoutEffect(() => {
    const element = inputRef.current;

    if (!element) {
      return;
    }

    // Focused during the click that opened it, so mobile browsers raise the keyboard.
    element.focus({ preventScroll: true });
    element.setSelectionRange(caret, caret);
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  const syncCaret = () => {
    const element = inputRef.current;

    if (element) {
      setCaret(element.selectionStart ?? element.value.length);
    }
  };

  const handleChange = (raw: string) => {
    let next = raw;

    if (field.type === FieldType.NUMBER) {
      next = next.replace(/[^0-9.,]/g, '');
    }

    // The server counts the value's length the way the browser does, so this matches its limit.
    next = next.slice(0, cellCount);

    setDraft(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish('revert', 'key');
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      finish('save', 'key', { then: event.shiftKey ? 'previous' : 'next' });
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      finish('save', 'key');
    }
  };

  const moveCaretToCell = (event: React.MouseEvent | React.PointerEvent, cellIndex: number) => {
    // Keep focus in the input: without this the browser moves focus off it, which saves and closes.
    event.preventDefault();

    const element = inputRef.current;

    if (!element) {
      return;
    }

    const position = Math.min(cellIndex, draft.length);

    element.focus({ preventScroll: true });
    element.setSelectionRange(position, position);
    setCaret(position);
  };

  return (
    <div
      data-testid="signing-inline-field-editor"
      data-field-id={field.id}
      className="pointer-events-none absolute inset-0 z-40"
    >
      {cellRects.map((rect, cellIndex) => (
        <div
          key={cellIndex}
          data-testid="signing-inline-comb-cell"
          data-active={cellIndex === activeCellIndex}
          className={cn(
            'pointer-events-auto absolute flex cursor-text select-none items-center justify-center rounded-sm text-black',
            cellIndex === activeCellIndex ? 'ring-2 ring-primary' : 'ring-1 ring-primary/40',
          )}
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            fontFamily: konvaTextFontFamily,
            fontSize,
            lineHeight: 1,
          }}
          onPointerDown={(event) => moveCaretToCell(event, cellIndex)}
          onMouseDown={(event) => moveCaretToCell(event, cellIndex)}
        >
          {characters[cellIndex] ?? ''}
        </div>
      ))}

      {activeCellRect && (
        <input
          ref={inputRef}
          value={draft}
          aria-label={label}
          aria-invalid={errorMessage !== null}
          maxLength={cellCount}
          spellCheck={false}
          autoComplete="off"
          inputMode={field.type === FieldType.NUMBER ? 'decimal' : 'text'}
          className="pointer-events-none absolute scroll-mb-32 border-none bg-transparent p-0 opacity-0 outline-none lg:scroll-mb-0"
          style={{
            left: activeCellRect.left,
            top: activeCellRect.top,
            width: activeCellRect.width,
            height: activeCellRect.height,
            fontSize: MIN_INPUT_FONT_SIZE,
            caretColor: 'transparent',
          }}
          onChange={(event) => handleChange(event.target.value)}
          onSelect={syncCaret}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onBlur={handleBlur}
        />
      )}

      {errorMessage && (
        <div
          role="alert"
          className="absolute mt-1 whitespace-nowrap rounded-md border border-destructive bg-background px-2 py-1 text-xs text-destructive shadow-sm"
          style={{ left: errorLeft, top: errorTop }}
        >
          {errorMessage}
        </div>
      )}
    </div>
  );
};
