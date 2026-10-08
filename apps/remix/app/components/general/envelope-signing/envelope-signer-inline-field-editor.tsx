import { useLayoutEffect, useRef } from 'react';

import { Trans } from '@lingui/react/macro';
import { type Field, FieldType } from '@prisma/client';

import { DEFAULT_STANDARD_FONT_SIZE } from '@documenso/lib/constants/pdf';
import {
  FIELD_DEFAULT_GENERIC_ALIGN,
  FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN,
  FIELD_DEFAULT_LETTER_SPACING,
  FIELD_DEFAULT_LINE_HEIGHT,
} from '@documenso/lib/types/field-meta';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import { getFieldOverlayRect } from '@documenso/lib/universal/field-inline-signing/overlay-geometry';
import {
  type TInlineCommitError,
  getInlineCharacterLimit,
} from '@documenso/lib/universal/field-inline-signing/resolve-inline-commit';
import { konvaTextFontFamily } from '@documenso/lib/universal/field-renderer/field-generic-items';
import { DEFAULT_TEXT_X_PADDING } from '@documenso/lib/universal/field-renderer/render-generic-text-field';
import { cn } from '@documenso/ui/lib/utils';

import type { TInlineNavigationDirection } from './envelope-signing-inline-edit-provider';
import { useInlineEditorSession } from './use-inline-editor-session';

/**
 * Browsers on iOS zoom the page in when an input with text smaller than this is focused. Smaller
 * text is drawn at this size and scaled down instead, which looks the same and does not zoom.
 */
export const MIN_INPUT_FONT_SIZE = 16;

type EnvelopeSignerInlineFieldEditorProps = {
  field: Pick<
    Field,
    'id' | 'type' | 'inserted' | 'customText' | 'positionX' | 'positionY' | 'width' | 'height'
  > & { fieldMeta?: TFieldMetaSchema | null };
  /** The unscaled page size, which the field's percentage position is relative to. */
  pageWidth: number;
  pageHeight: number;
  scale: number;
  initialValue: string;
  placeholder: string;
  onCommit: (draft: string) => TInlineCommitError | null;
  onClose: () => void;
  onNavigate: (direction: TInlineNavigationDirection) => void;
};

/**
 * A text box drawn exactly over a field on the v2 signing page, so the signer types straight onto
 * the document instead of into a dialog.
 *
 * The page's Konva text for the field is hidden while this is open, and this matches its font,
 * size, alignment and padding, so what the signer types sits where the saved value will be drawn.
 * Saving and cancelling work as described on `useInlineEditorSession`.
 */
export const EnvelopeSignerInlineFieldEditor = ({
  field,
  pageWidth,
  pageHeight,
  scale,
  initialValue,
  placeholder,
  onCommit,
  onClose,
  onNavigate,
}: EnvelopeSignerInlineFieldEditorProps) => {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { draft, setDraft, error, errorMessage, finish, handleBlur } = useInlineEditorSession({
    initialValue,
    onCommit,
    onClose,
    onNavigate,
  });

  const fieldMeta = field.fieldMeta;
  const isMultiline = field.type === FieldType.TEXT;
  const characterLimit = getInlineCharacterLimit(field);

  const isTextOrNumberMeta = fieldMeta?.type === 'text' || fieldMeta?.type === 'number';

  const textAlign =
    (fieldMeta && 'textAlign' in fieldMeta ? fieldMeta.textAlign : undefined) ||
    FIELD_DEFAULT_GENERIC_ALIGN;

  const verticalAlign =
    (isTextOrNumberMeta ? fieldMeta.verticalAlign : undefined) ||
    FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN;

  const lineHeight =
    (isTextOrNumberMeta ? fieldMeta.lineHeight : undefined) || FIELD_DEFAULT_LINE_HEIGHT;

  const letterSpacing =
    (isTextOrNumberMeta ? fieldMeta.letterSpacing : undefined) || FIELD_DEFAULT_LETTER_SPACING;

  const rect = getFieldOverlayRect(field, pageWidth, pageHeight, scale);

  const fontSize = (fieldMeta?.fontSize || DEFAULT_STANDARD_FONT_SIZE) * scale;

  // Lay the text box out at `1 / shrink` its size and scale it back down, so its font is never
  // below the size that makes iOS zoom.
  const shrink = fontSize < MIN_INPUT_FONT_SIZE ? fontSize / MIN_INPUT_FONT_SIZE : 1;

  useLayoutEffect(() => {
    const element = inputRef.current;

    if (!element) {
      return;
    }

    // Focused during the click that opened it, so mobile browsers raise the keyboard.
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  // Konva centres the text vertically by default. A textarea always starts at the top, so pad it
  // down by however much room the text leaves.
  useLayoutEffect(() => {
    const element = inputRef.current;

    if (!element) {
      return;
    }

    const boxHeight = rect.height / shrink;

    element.style.paddingTop = '0px';
    element.style.height = '0px';

    const contentHeight = element.scrollHeight;

    element.style.height = `${boxHeight}px`;

    const freeSpace = Math.max(0, boxHeight - contentHeight);

    const paddingTop =
      verticalAlign === 'top' ? 0 : verticalAlign === 'bottom' ? freeSpace : freeSpace / 2;

    element.style.paddingTop = `${paddingTop}px`;
  }, [draft, rect.height, shrink, verticalAlign]);

  const handleChange = (raw: string) => {
    let next = raw;

    if (!isMultiline) {
      next = next.replace(/[\r\n]+/g, '');
    }

    if (field.type === FieldType.NUMBER) {
      next = next.replace(/[^0-9.,]/g, '');
    }

    if (characterLimit !== undefined && next.length > characterLimit) {
      next = next.slice(0, characterLimit);
    }

    setDraft(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

    // Shift+Enter starts a new line in a text field. Enter on its own saves.
    if (event.key === 'Enter' && !(isMultiline && event.shiftKey)) {
      event.preventDefault();
      finish('save', 'key');
    }
  };

  const remainingCharacters =
    characterLimit !== undefined ? Math.max(0, characterLimit - draft.length) : null;

  return (
    <div
      data-testid="signing-inline-field-editor"
      data-field-id={field.id}
      className="pointer-events-none absolute z-40 rounded-sm ring-2 ring-primary"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
    >
      <textarea
        ref={inputRef}
        value={draft}
        aria-label={placeholder}
        aria-invalid={error !== null}
        placeholder={placeholder}
        maxLength={characterLimit}
        rows={1}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize={field.type === FieldType.EMAIL ? 'none' : undefined}
        inputMode={
          field.type === FieldType.NUMBER
            ? 'decimal'
            : field.type === FieldType.EMAIL
              ? 'email'
              : 'text'
        }
        className="pointer-events-auto absolute left-0 top-0 resize-none scroll-mb-32 overflow-hidden border-none bg-transparent text-black outline-none placeholder:text-neutral-500 lg:scroll-mb-0"
        style={{
          width: rect.width / shrink,
          height: rect.height / shrink,
          transform: shrink === 1 ? undefined : `scale(${shrink})`,
          transformOrigin: '0 0',
          margin: 0,
          // The top padding is set by the layout effect above, to centre the text vertically.
          paddingBottom: 0,
          paddingLeft: (DEFAULT_TEXT_X_PADDING * scale) / shrink,
          paddingRight: (DEFAULT_TEXT_X_PADDING * scale) / shrink,
          fontFamily: konvaTextFontFamily,
          fontSize: fontSize / shrink,
          lineHeight,
          letterSpacing: (letterSpacing * scale) / shrink,
          textAlign,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />

      {(error || remainingCharacters !== null) && (
        <div
          className={cn(
            'absolute left-0 top-full mt-1 whitespace-nowrap rounded-md border bg-background px-2 py-1 text-xs shadow-sm',
            error ? 'border-destructive text-destructive' : 'text-muted-foreground',
          )}
          role={error ? 'alert' : undefined}
        >
          {errorMessage ?? <Trans>{remainingCharacters} characters remaining</Trans>}
        </div>
      )}
    </div>
  );
};
