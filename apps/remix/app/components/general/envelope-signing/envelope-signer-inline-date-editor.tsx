import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useLingui } from '@lingui/react/macro';
import type { Field } from '@prisma/client';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { DateTime } from 'luxon';

import { DEFAULT_STANDARD_FONT_SIZE } from '@documenso/lib/constants/pdf';
import type { TFieldMetaSchema } from '@documenso/lib/types/field-meta';
import {
  formatDateForInput,
  formatDateInputDraft,
  getDateInputPattern,
  getDateInputPlaceholder,
  parseDateInput,
} from '@documenso/lib/universal/field-inline-signing/date-input';
import { getFieldOverlayRect } from '@documenso/lib/universal/field-inline-signing/overlay-geometry';
import type {
  TInlineCommitError,
  TInlineCommitOptions,
} from '@documenso/lib/universal/field-inline-signing/resolve-inline-commit';
import { konvaTextFontFamily } from '@documenso/lib/universal/field-renderer/field-generic-items';
import { DEFAULT_TEXT_X_PADDING } from '@documenso/lib/universal/field-renderer/render-generic-text-field';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Calendar } from '@documenso/ui/primitives/calendar';
import { Popover, PopoverAnchor, PopoverContent } from '@documenso/ui/primitives/popover';

import { MIN_INPUT_FONT_SIZE } from './envelope-signer-inline-field-editor';
import type { TInlineNavigationDirection } from './envelope-signing-inline-edit-provider';
import { useInlineEditorSession } from './use-inline-editor-session';

/** How many years either side of today the calendar's year list offers. */
const CALENDAR_YEARS_BACK = 100;
const CALENDAR_YEARS_AHEAD = 10;

/** How many months or years a list shows before it scrolls. */
const COMPACT_SELECT_VISIBLE_OPTIONS = 5;

type CompactSelectProps = {
  label: string;
  value: number;
  options: Array<{ value: number; label: string }>;
  onChange: (value: number) => void;
};

/**
 * A small month or year picker for the calendar. Its list shows a few entries at a time, scrolled
 * to the current one, rather than the browser's own select, which opens a hundred years tall.
 */
const CompactSelect = ({ label, value, options, onChange }: CompactSelectProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (isOpen) {
      listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    }
  }, [isOpen]);

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node &&
            containerRef.current?.contains(event.relatedTarget)
          )
        ) {
          setIsOpen(false);
        }
      }}
      onKeyDown={(event) => {
        // Escape closes this list, not the whole date field.
        if (event.key === 'Escape' && isOpen) {
          event.stopPropagation();
          setIsOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className="flex h-7 items-center gap-1 rounded-md border border-input bg-background px-2 text-sm text-foreground hover:bg-accent"
        onClick={() => setIsOpen((open) => !open)}
      >
        {selected?.label}
        <ChevronDownIcon className="h-3.5 w-3.5 opacity-60" />
      </button>

      {isOpen && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          className="absolute left-0 top-full z-10 mt-1 min-w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
          // Each option is 1.75rem tall; the list adds 0.5rem of padding.
          style={{ maxHeight: `calc(${COMPACT_SELECT_VISIBLE_OPTIONS} * 1.75rem + 0.5rem)` }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={cn(
                'block h-7 w-full rounded-sm px-2 text-left text-sm hover:bg-accent',
                option.value === value && 'bg-accent font-medium',
              )}
              onClick={() => {
                onChange(option.value);

                // Hand focus back before the option disappears; losing it to the page would read
                // as leaving the date field, which saves and closes it.
                triggerRef.current?.focus();
                setIsOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

type EnvelopeSignerInlineDateEditorProps = {
  field: Pick<
    Field,
    'id' | 'type' | 'inserted' | 'customText' | 'positionX' | 'positionY' | 'width' | 'height'
  > & { fieldMeta?: TFieldMetaSchema | null };
  /** The unscaled page size, which the field's percentage position is relative to. */
  pageWidth: number;
  pageHeight: number;
  scale: number;
  initialValue: string;
  label: string;
  commitOptions: TInlineCommitOptions;
  onCommit: (draft: string) => TInlineCommitError | null;
  onClose: () => void;
  onNavigate: (direction: TInlineNavigationDirection) => void;
};

/**
 * Fills a DATE field in place: the date is typed straight over the field, in the order the
 * document prints dates in (separators are put in automatically), and a calendar opens under the
 * field for anyone who would rather pick the day. Picking a day saves it.
 *
 * Nothing is filled in until the signer types or picks a date, so tabbing through the form never
 * signs today's date by accident. Saving and cancelling work as described on
 * `useInlineEditorSession`.
 */
export const EnvelopeSignerInlineDateEditor = ({
  field,
  pageWidth,
  pageHeight,
  scale,
  initialValue,
  label,
  commitOptions,
  onCommit,
  onClose,
  onNavigate,
}: EnvelopeSignerInlineDateEditorProps) => {
  const { t, i18n } = useLingui();

  const inputRef = useRef<HTMLInputElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);

  const { draft, setDraft, errorMessage, finish, handleBlur } = useInlineEditorSession({
    initialValue,
    onCommit,
    onClose,
    onNavigate,
  });

  const pattern = getDateInputPattern(commitOptions.dateFormat);
  const placeholder = getDateInputPlaceholder(pattern);

  const typedDate = parseDateInput(draft, pattern);

  // The author can suggest a date; it only decides which month the calendar opens on.
  const suggestedDate = (() => {
    const fieldMeta = field.fieldMeta;
    const suggested = fieldMeta?.type === 'date' && fieldMeta.value ? fieldMeta.value : null;
    const parsed = suggested ? DateTime.fromISO(suggested) : null;

    return parsed?.isValid ? parsed : null;
  })();

  const selectedDay = typedDate
    ? new Date(typedDate.year, typedDate.month - 1, typedDate.day)
    : undefined;

  const [calendarMonth, setCalendarMonth] = useState<Date>(
    () => selectedDay ?? suggestedDate?.toJSDate() ?? new Date(),
  );

  const rect = getFieldOverlayRect(field, pageWidth, pageHeight, scale);
  const fontSize = (field.fieldMeta?.fontSize || DEFAULT_STANDARD_FONT_SIZE) * scale;
  const shrink = fontSize < MIN_INPUT_FONT_SIZE ? fontSize / MIN_INPUT_FONT_SIZE : 1;

  const currentYear = new Date().getFullYear();

  const firstMonth = new Date(currentYear - CALENDAR_YEARS_BACK, 0, 1);
  const lastMonth = new Date(currentYear + CALENDAR_YEARS_AHEAD, 11, 1);

  const monthOptions = Array.from({ length: 12 }, (_, month) => ({
    value: month,
    label: new Date(2000, month, 1).toLocaleDateString(i18n.locale, { month: 'short' }),
  }));

  const yearOptions = Array.from(
    { length: CALENDAR_YEARS_BACK + CALENDAR_YEARS_AHEAD + 1 },
    (_, index) => {
      const year = currentYear - CALENDAR_YEARS_BACK + index;

      return { value: year, label: String(year) };
    },
  );

  const moveCalendarTo = (year: number, month: number) => {
    const target = new Date(year, month, 1);

    setCalendarMonth(target < firstMonth ? firstMonth : target > lastMonth ? lastMonth : target);
  };

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

  const handleChange = (raw: string) => {
    const next = formatDateInputDraft(raw, pattern, raw.length < draft.length);

    setDraft(next);

    // Follow a complete typed date in the calendar.
    const date = parseDateInput(next, pattern);

    if (date) {
      setCalendarMonth(new Date(date.year, date.month - 1, 1));
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish('revert', 'key');
      return;
    }

    // Tab inside the calendar moves between its controls; from the date it moves to the next field.
    if (event.key === 'Tab' && event.target === inputRef.current) {
      event.preventDefault();
      finish('save', 'key', { then: event.shiftKey ? 'previous' : 'next' });
      return;
    }

    if (event.key === 'Enter' && event.target === inputRef.current) {
      event.preventDefault();
      finish('save', 'key');
    }
  };

  /**
   * Moving between the date and the calendar is not leaving the field. Only focus going somewhere
   * else entirely saves it.
   */
  const handleFocusLeave = (event: React.FocusEvent) => {
    const next = event.relatedTarget;

    if (
      next instanceof Node &&
      (inputRef.current?.contains(next) || calendarRef.current?.contains(next))
    ) {
      return;
    }

    handleBlur();
  };

  const handlePickDay = (day: Date | undefined) => {
    if (!day) {
      return;
    }

    finish('save', 'key', {
      value: formatDateForInput(
        { year: day.getFullYear(), month: day.getMonth() + 1, day: day.getDate() },
        pattern,
      ),
    });
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
            value={draft}
            aria-label={label}
            aria-invalid={errorMessage !== null}
            placeholder={placeholder}
            inputMode="numeric"
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
            onChange={(event) => handleChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleFocusLeave}
          />
        </div>
      </PopoverAnchor>

      <PopoverContent
        ref={calendarRef}
        data-testid="signing-inline-date-calendar"
        aria-label={label}
        side="bottom"
        align="start"
        className="w-auto p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onKeyDown={handleKeyDown}
        onBlur={handleFocusLeave}
      >
        {errorMessage && (
          <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-between gap-1 px-3 pt-3">
          <Button
            type="button"
            variant="outline"
            className="h-7 w-7 p-0"
            aria-label={t`Previous month`}
            disabled={calendarMonth <= firstMonth}
            onClick={() =>
              moveCalendarTo(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1)
            }
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </Button>

          <div className="flex items-center gap-1">
            <CompactSelect
              label={t`Month`}
              value={calendarMonth.getMonth()}
              options={monthOptions}
              onChange={(month) => moveCalendarTo(calendarMonth.getFullYear(), month)}
            />

            <CompactSelect
              label={t`Year`}
              value={calendarMonth.getFullYear()}
              options={yearOptions}
              onChange={(year) => moveCalendarTo(year, calendarMonth.getMonth())}
            />
          </div>

          <Button
            type="button"
            variant="outline"
            className="h-7 w-7 p-0"
            aria-label={t`Next month`}
            disabled={calendarMonth >= lastMonth}
            onClick={() =>
              moveCalendarTo(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1)
            }
          >
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
        </div>

        <Calendar
          mode="single"
          required
          fromMonth={firstMonth}
          toMonth={lastMonth}
          month={calendarMonth}
          onMonthChange={setCalendarMonth}
          selected={selectedDay}
          onSelect={handlePickDay}
          // The month and year are chosen in the row above.
          classNames={{ caption: 'hidden' }}
        />
      </PopoverContent>
    </Popover>
  );
};
