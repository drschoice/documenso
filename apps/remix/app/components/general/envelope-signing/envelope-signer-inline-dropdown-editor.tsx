import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Trans, useLingui } from '@lingui/react/macro';
import type { Field } from '@prisma/client';

import { DEFAULT_STANDARD_FONT_SIZE } from '@documenso/lib/constants/pdf';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import { getFieldOverlayRect } from '@documenso/lib/universal/field-inline-signing/overlay-geometry';
import type { TInlineCommitError } from '@documenso/lib/universal/field-inline-signing/resolve-inline-commit';
import { konvaTextFontFamily } from '@documenso/lib/universal/field-renderer/field-generic-items';
import { DEFAULT_TEXT_X_PADDING } from '@documenso/lib/universal/field-renderer/render-generic-text-field';
import { cn } from '@documenso/ui/lib/utils';
import { Popover, PopoverAnchor, PopoverContent } from '@documenso/ui/primitives/popover';

import { MIN_INPUT_FONT_SIZE } from './envelope-signer-inline-field-editor';
import type { TInlineNavigationDirection } from './envelope-signing-inline-edit-provider';
import { useInlineEditorSession } from './use-inline-editor-session';

/** Stands in for "no option" in the list, so clearing a choice is picked like any other. */
const CLEAR_OPTION = Symbol('clear');

type DropdownChoice = string | typeof CLEAR_OPTION;

type EnvelopeSignerInlineDropdownEditorProps = {
  field: Pick<
    Field,
    'id' | 'type' | 'inserted' | 'customText' | 'positionX' | 'positionY' | 'width' | 'height'
  > & { fieldMeta?: TFieldMetaSchema | null };
  /** The unscaled page size, which the field's percentage position is relative to. */
  pageWidth: number;
  pageHeight: number;
  scale: number;
  label: string;
  onCommit: (value: string) => TInlineCommitError | null;
  onClose: () => void;
  onNavigate: (direction: TInlineNavigationDirection) => void;
};

/**
 * Fills a DROPDOWN field in place: its options open in a list under the field, and typing over
 * the field narrows them down. Picking an option saves it; the arrow keys and Enter pick from the
 * keyboard. A filled field also offers to clear the choice.
 *
 * Typing only filters, so leaving the field without picking keeps the saved choice. Tab picks the
 * highlighted option once the signer has moved through the list or typed, and otherwise just moves
 * on.
 */
export const EnvelopeSignerInlineDropdownEditor = ({
  field,
  pageWidth,
  pageHeight,
  scale,
  label,
  onCommit,
  onClose,
  onNavigate,
}: EnvelopeSignerInlineDropdownEditorProps) => {
  const { t } = useLingui();

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const {
    draft: filter,
    setDraft: setFilter,
    errorMessage,
    finish,
  } = useInlineEditorSession({
    initialValue: '',
    onCommit,
    onClose,
    onNavigate,
    saveOnUnmount: false,
  });

  const fieldMeta = field.fieldMeta?.type === 'dropdown' ? field.fieldMeta : null;
  const options = (fieldMeta?.values ?? []).map((option) => option.value);

  const currentValue = field.inserted ? field.customText : null;

  const filteredOptions = options.filter((option) =>
    option.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );

  const choices: DropdownChoice[] =
    currentValue !== null && filter.trim() === ''
      ? [...filteredOptions, CLEAR_OPTION]
      : filteredOptions;

  const [highlightedIndex, setHighlightedIndex] = useState(() => {
    const preferred = currentValue ?? fieldMeta?.defaultValue;
    const index = preferred ? options.indexOf(preferred) : -1;

    return Math.max(index, 0);
  });

  // Typing or moving through the list means the signer is choosing, so Tab picks for them.
  const [hasChosen, setHasChosen] = useState(false);

  const highlightedChoice = choices[Math.min(highlightedIndex, choices.length - 1)];

  const rect = getFieldOverlayRect(field, pageWidth, pageHeight, scale);
  const fontSize = (fieldMeta?.fontSize || DEFAULT_STANDARD_FONT_SIZE) * scale;
  const shrink = fontSize < MIN_INPUT_FONT_SIZE ? fontSize / MIN_INPUT_FONT_SIZE : 1;

  useLayoutEffect(() => {
    const element = inputRef.current;

    if (!element) {
      return;
    }

    // Focused during the click that opened it, so mobile browsers raise the keyboard.
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, filter]);

  const pick = (choice: DropdownChoice | undefined, then?: TInlineNavigationDirection) => {
    if (choice === undefined) {
      finish('revert', 'key', { then });
      return;
    }

    finish('save', 'key', { value: choice === CLEAR_OPTION ? '' : choice, then });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        finish('revert', 'key');
        return;

      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();

        if (choices.length === 0) {
          return;
        }

        const step = event.key === 'ArrowDown' ? 1 : -1;

        setHighlightedIndex((index) => (index + step + choices.length) % choices.length);
        setHasChosen(true);
        return;
      }

      case 'Enter':
        event.preventDefault();
        pick(highlightedChoice);
        return;

      case 'Tab': {
        event.preventDefault();

        const then = event.shiftKey ? 'previous' : 'next';

        pick(hasChosen ? highlightedChoice : undefined, then);
        return;
      }
    }
  };

  const handleBlur = () => {
    // Switching to another window or tab blurs the field too; keep it open for the signer's return.
    if (!document.hasFocus()) {
      return;
    }

    // Typing only filters the list, so leaving without picking keeps the saved choice.
    finish('revert', 'blur');
  };

  return (
    <Popover open={true}>
      <PopoverAnchor asChild>
        <div
          data-testid="signing-inline-field-editor"
          data-field-id={field.id}
          className="pointer-events-none absolute z-40 rounded-sm ring-2 ring-primary"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
          <input
            ref={inputRef}
            value={filter}
            role="combobox"
            aria-label={label}
            aria-expanded={true}
            aria-controls={`signing-inline-dropdown-${field.id}`}
            aria-invalid={errorMessage !== null}
            placeholder={currentValue ?? (fieldMeta?.label || t`Select an option`)}
            autoComplete="off"
            spellCheck={false}
            className="pointer-events-auto absolute left-0 top-0 scroll-mb-32 border-none bg-transparent text-black outline-none placeholder:text-neutral-500 lg:scroll-mb-0"
            style={{
              width: rect.width / shrink,
              height: rect.height / shrink,
              transform: shrink === 1 ? undefined : `scale(${shrink})`,
              transformOrigin: '0 0',
              margin: 0,
              paddingTop: 0,
              paddingBottom: 0,
              paddingLeft: (DEFAULT_TEXT_X_PADDING * scale) / shrink,
              paddingRight: (DEFAULT_TEXT_X_PADDING * scale) / shrink,
              fontFamily: konvaTextFontFamily,
              fontSize: fontSize / shrink,
            }}
            onChange={(event) => {
              setFilter(event.target.value);
              setHighlightedIndex(0);
              setHasChosen(true);
            }}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
          />
        </div>
      </PopoverAnchor>

      <PopoverContent
        // The field and its list are a combobox; the list is not a dialog of its own.
        role="presentation"
        side="bottom"
        align="start"
        className="w-auto p-1"
        style={{ minWidth: Math.max(rect.width, 160) }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {errorMessage && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {errorMessage}
          </p>
        )}

        <div
          ref={listRef}
          id={`signing-inline-dropdown-${field.id}`}
          role="listbox"
          data-testid="signing-inline-dropdown-options"
          className="max-h-60 overflow-y-auto"
        >
          {choices.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              <Trans>No results found.</Trans>
            </p>
          )}

          {choices.map((choice, index) => {
            const isClear = choice === CLEAR_OPTION;
            const isHighlighted = choice === highlightedChoice;

            return (
              <div
                key={isClear ? '__clear' : choice}
                role="option"
                aria-selected={!isClear && choice === currentValue}
                data-highlighted={isHighlighted}
                className={cn(
                  'cursor-pointer rounded-sm px-2 py-1.5 text-sm',
                  isHighlighted && 'bg-accent text-accent-foreground',
                  isClear && 'mt-1 border-t text-muted-foreground',
                  !isClear && choice === currentValue && 'font-medium',
                )}
                // Keep focus in the field, which would otherwise blur and close the list.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => pick(choice)}
              >
                {isClear ? <Trans>Clear selection</Trans> : choice}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
};
