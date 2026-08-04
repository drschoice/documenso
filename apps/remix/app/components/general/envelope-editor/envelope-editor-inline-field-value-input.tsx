import { useEffect, useRef, useState } from 'react';

import type Konva from 'konva';

import type { TLocalField } from '@documenso/lib/client-only/hooks/use-editor-fields';
import { DEFAULT_STANDARD_FONT_SIZE } from '@documenso/lib/constants/pdf';
import { konvaTextFontFamily } from '@documenso/lib/universal/field-renderer/field-generic-items';

// Matches DEFAULT_TEXT_X_PADDING in render-generic-text-field.ts so the DOM
// text lines up with the Konva text it sits on top of.
const TEXT_X_PADDING = 6;

export const INLINE_EDITABLE_FIELD_TYPES = new Set<TLocalField['type']>(['TEXT', 'NUMBER']);

type EnvelopeEditorInlineFieldValueInputProps = {
  field: TLocalField;
  fieldGroup: Konva.Group;
  scale: number;
  /** Current value seeded from the field meta. Used as the initial value only. */
  value: string;
  /**
   * Bumped by the parent on every (re)selection of this field. A click on the
   * canvas blurs this pointer-events:none overlay; keying the focus effect on
   * this restores focus + caret so re-clicking a selected field keeps it typable.
   */
  focusSignal: number;
  onChangeValue: (value: string) => void;
};

/**
 * Inline, auto-focused text input overlaid exactly on top of a selected
 * TEXT/NUMBER/EMAIL/NAME field in the draft editor — the "select the field and
 * type" flow.
 *
 * The input uses `pointer-events: none` and is focused programmatically so that
 * keystrokes/caret/selection/IME all work while every mouse interaction
 * (dragging the field, the transformer resize handles, click-to-deselect)
 * still falls straight through to the Konva canvas underneath.
 *
 * The overlay owns the value while editing (local state) and pushes each change
 * up via `onChangeValue`; the caller writes it into the field meta and the
 * Konva text (hidden behind this overlay) re-renders from it.
 */
export const EnvelopeEditorInlineFieldValueInput = ({
  field,
  fieldGroup,
  scale,
  value,
  focusSignal,
  onChangeValue,
}: EnvelopeEditorInlineFieldValueInputProps) => {
  const inputRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState(value);

  const isMultiline = field.type === 'TEXT';

  // Focus (caret at end) as soon as the field becomes editable, and again each
  // time the field is (re)selected (`focusSignal` bumps) — a canvas click blurs
  // this pointer-events:none overlay, so re-clicking must restore focus.
  useEffect(() => {
    const element = inputRef.current;

    if (!element || document.activeElement === element) {
      return;
    }

    element.focus({ preventScroll: true });

    const caret = element.value.length;
    element.setSelectionRange?.(caret, caret);
  }, [focusSignal]);

  // Live client rect in scaled (screen) pixels, relative to the same per-page
  // wrapper the Konva container and FieldActionButtons live in. Measure the
  // field's own rect rather than the whole group, so corner decorations that
  // sit outside the field bounds (e.g. the copy-and-link badge) don't inflate
  // or offset the overlay.
  const rectNode = fieldGroup.findOne<Konva.Rect>('.field-rect') ?? fieldGroup;
  const rect = rectNode.getClientRect({ skipStroke: true, skipShadow: true });

  const fieldMeta = field.fieldMeta;
  const fontSize = (fieldMeta?.fontSize || DEFAULT_STANDARD_FONT_SIZE) * scale;
  const textAlign =
    fieldMeta && 'textAlign' in fieldMeta ? fieldMeta.textAlign || 'left' : 'left';
  const characterLimit =
    fieldMeta?.type === 'text' && fieldMeta.characterLimit ? fieldMeta.characterLimit : undefined;

  const handleChange = (raw: string) => {
    let next = raw;

    if (field.type === 'NUMBER') {
      // Keep typing forgiving: allow digits, separators, sign and spaces.
      next = next.replace(/[^0-9.,+\-\s]/g, '');
    }

    if (characterLimit !== undefined && characterLimit > 0 && next.length > characterLimit) {
      next = next.slice(0, characterLimit);
    }

    setLocalValue(next);
    onChangeValue(next);
  };

  const commonStyle: React.CSSProperties = {
    position: 'absolute',
    top: `${rect.y}px`,
    left: `${rect.x}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: 0,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'black',
    fontFamily: konvaTextFontFamily,
    fontSize: `${fontSize}px`,
    lineHeight: 1,
    textAlign,
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: `${TEXT_X_PADDING * scale}px`,
    paddingRight: `${TEXT_X_PADDING * scale}px`,
    resize: 'none',
    overflow: 'hidden',
    // Keyboard input still works while all mouse events pass through to Konva.
    pointerEvents: 'none',
    zIndex: 40,
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      inputRef.current?.blur();
      return;
    }

    // Single-line fields commit on Enter; TEXT keeps the newline (textarea).
    if (event.key === 'Enter' && !isMultiline) {
      event.preventDefault();
      inputRef.current?.blur();
    }
  };

  if (isMultiline) {
    return (
      <textarea
        ref={inputRef}
        value={localValue}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        style={commonStyle}
      />
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode={field.type === 'NUMBER' ? 'decimal' : 'text'}
      value={localValue}
      onChange={(event) => handleChange(event.target.value)}
      onKeyDown={handleKeyDown}
      spellCheck={false}
      style={{ ...commonStyle, whiteSpace: 'nowrap' }}
    />
  );
};
