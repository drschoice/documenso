import { useState } from 'react';

import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { CalendarIcon } from 'lucide-react';
import { DateTime } from 'luxon';

import type {
  TEnvelopeExpirationDurationPeriod,
  TEnvelopeExpirationPeriod,
} from '@documenso/lib/constants/envelope-expiration';
import {
  DEFAULT_ENVELOPE_EXPIRATION_PERIOD,
  DEFAULT_ENVELOPE_EXPIRATION_TIME,
} from '@documenso/lib/constants/envelope-expiration';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Calendar } from '@documenso/ui/primitives/calendar';
import { Input } from '@documenso/ui/primitives/input';
import { Popover, PopoverContent, PopoverTrigger } from '@documenso/ui/primitives/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@documenso/ui/primitives/select';

type ExpirationMode = 'duration' | 'date' | 'disabled' | 'inherit';

const getMode = (value: TEnvelopeExpirationPeriod | null | undefined): ExpirationMode => {
  if (!value) {
    return 'inherit';
  }

  if ('disabled' in value) {
    return 'disabled';
  }

  if ('expiresAt' in value) {
    return 'date';
  }

  return 'duration';
};

const getAmount = (value: TEnvelopeExpirationPeriod | null | undefined): number => {
  if (value && 'amount' in value) {
    return value.amount;
  }

  return DEFAULT_ENVELOPE_EXPIRATION_PERIOD.amount;
};

const getUnit = (
  value: TEnvelopeExpirationPeriod | null | undefined,
): TEnvelopeExpirationDurationPeriod['unit'] => {
  if (value && 'unit' in value) {
    return value.unit;
  }

  return DEFAULT_ENVELOPE_EXPIRATION_PERIOD.unit;
};

/**
 * The stored value is a zone-less wall clock, so it is parsed and re-serialised without a zone. The
 * timezone only comes into play when the deadline is resolved to an instant at send time.
 */
const getDeadline = (value: TEnvelopeExpirationPeriod | null | undefined): DateTime => {
  if (value && 'expiresAt' in value) {
    const parsed = DateTime.fromISO(value.expiresAt);

    if (parsed.isValid) {
      return parsed;
    }
  }

  const [hour, minute] = DEFAULT_ENVELOPE_EXPIRATION_TIME.split(':').map(Number);

  return DateTime.now().plus({ days: 1 }).set({ hour, minute, second: 0, millisecond: 0 });
};

const toExpiresAt = (deadline: DateTime): string => deadline.toFormat("yyyy-MM-dd'T'HH:mm");

export type ExpirationPeriodPickerProps = {
  value: TEnvelopeExpirationPeriod | null | undefined;
  onChange: (value: TEnvelopeExpirationPeriod | null) => void;
  disabled?: boolean;
  inheritLabel?: string;
  /**
   * Opt in to the fixed date/time mode. Off by default so organisation and team level defaults,
   * which apply to every future document, cannot be pinned to a date that immediately goes stale.
   */
  allowSpecificDate?: boolean;
  /**
   * The envelope timezone the deadline will be read in. Shown in the hint only.
   */
  timezone?: string | null;
};

export const ExpirationPeriodPicker = ({
  value,
  onChange,
  disabled = false,
  inheritLabel,
  allowSpecificDate = false,
  timezone,
}: ExpirationPeriodPickerProps) => {
  const { t } = useLingui();

  const [isCalendarOpen, setIsCalendarOpen] = useState(false);

  const mode = getMode(value);
  const amount = getAmount(value);
  const unit = getUnit(value);
  const deadline = getDeadline(value);

  const onModeChange = (newMode: string) => {
    if (newMode === 'inherit') {
      onChange(null);
      return;
    }

    if (newMode === 'disabled') {
      onChange({ disabled: true });
      return;
    }

    if (newMode === 'date') {
      onChange({ expiresAt: toExpiresAt(deadline) });
      return;
    }

    onChange({ unit, amount });
  };

  const onAmountChange = (newAmount: number) => {
    const clamped = Math.max(1, Math.floor(newAmount));

    onChange({ unit, amount: clamped });
  };

  const onUnitChange = (newUnit: string) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    onChange({ unit: newUnit as TEnvelopeExpirationDurationPeriod['unit'], amount });
  };

  const onDateChange = (date: Date) => {
    const picked = DateTime.fromJSDate(date);

    onChange({
      expiresAt: toExpiresAt(
        deadline.set({ year: picked.year, month: picked.month, day: picked.day }),
      ),
    });
  };

  const onTimeChange = (time: string) => {
    const [hour, minute] = time.split(':').map(Number);

    if (Number.isNaN(hour) || Number.isNaN(minute)) {
      return;
    }

    onChange({ expiresAt: toExpiresAt(deadline.set({ hour, minute })) });
  };

  return (
    <div className="flex flex-col gap-2">
      <Select value={mode} onValueChange={onModeChange} disabled={disabled}>
        <SelectTrigger className="bg-background">
          <SelectValue />
        </SelectTrigger>

        <SelectContent>
          <SelectItem value="duration">
            <Trans>Custom duration</Trans>
          </SelectItem>

          {allowSpecificDate && (
            <SelectItem value="date">
              <Trans>Specific date and time</Trans>
            </SelectItem>
          )}

          <SelectItem value="disabled">
            <Trans>Never expires</Trans>
          </SelectItem>

          {inheritLabel !== undefined && <SelectItem value="inherit">{inheritLabel}</SelectItem>}
        </SelectContent>
      </Select>

      {mode === 'duration' && (
        <div className="flex flex-row gap-2">
          <Input
            type="number"
            min={1}
            className="w-20 bg-background"
            value={amount}
            onChange={(e) => onAmountChange(Number(e.target.value))}
            disabled={disabled}
          />

          <Select value={unit} onValueChange={onUnitChange} disabled={disabled}>
            <SelectTrigger className="flex-1 bg-background">
              <SelectValue />
            </SelectTrigger>

            <SelectContent>
              <SelectItem value="day">
                <Plural value={amount} one="Day" other="Days" />
              </SelectItem>
              <SelectItem value="week">
                <Plural value={amount} one="Week" other="Weeks" />
              </SelectItem>
              <SelectItem value="month">
                <Plural value={amount} one="Month" other="Months" />
              </SelectItem>
              <SelectItem value="year">
                <Plural value={amount} one="Year" other="Years" />
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {mode === 'date' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-row gap-2">
            <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
              <PopoverTrigger asChild disabled={disabled}>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  className={cn('flex-1 justify-start bg-background text-left font-normal')}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {deadline.toLocaleString(DateTime.DATE_MED)}
                </Button>
              </PopoverTrigger>

              {/* Above the z-[1000] dialog wrapper, matching Combobox — the picker is rendered
                  inside both the editor settings and send dialogs. */}
              <PopoverContent className="z-[1001] w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={deadline.toJSDate()}
                  disabled={{ before: new Date() }}
                  onSelect={(date) => {
                    if (date) {
                      onDateChange(date);
                      setIsCalendarOpen(false);
                    }
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>

            <Input
              type="time"
              step={60}
              className="w-32 bg-background"
              value={deadline.toFormat('HH:mm')}
              onChange={(e) => onTimeChange(e.target.value)}
              disabled={disabled}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {t`Expires ${deadline.toLocaleString(DateTime.DATETIME_MED)} (${timezone || 'Etc/UTC'})`}
          </p>
        </div>
      )}
    </div>
  );
};
