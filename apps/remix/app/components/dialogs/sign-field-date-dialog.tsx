import { useState } from 'react';

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
import { DateTime } from 'luxon';
import { createCallable } from 'react-call';

import type { TDateFieldMeta } from '@documenso/lib/types/field-meta';
import { Button } from '@documenso/ui/primitives/button';
import { Calendar } from '@documenso/ui/primitives/calendar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@documenso/ui/primitives/select';

export type SignFieldDateDialogProps = {
  fieldMeta?: TDateFieldMeta;
};

export const SignFieldDateDialog = createCallable<SignFieldDateDialogProps, string | null>(
  ({ call, fieldMeta }) => {
    const { _ } = useLingui();

    const MONTHS = [
      _(msg`January`),
      _(msg`February`),
      _(msg`March`),
      _(msg`April`),
      _(msg`May`),
      _(msg`June`),
      _(msg`July`),
      _(msg`August`),
      _(msg`September`),
      _(msg`October`),
      _(msg`November`),
      _(msg`December`),
    ];

    const currentYear = new Date().getFullYear();
    const YEARS = Array.from({ length: 111 }, (_, i) => currentYear - 100 + i);

    const defaultDate = fieldMeta?.value
      ? DateTime.fromISO(fieldMeta.value).toJSDate()
      : new Date();
    const [selectedDate, setSelectedDate] = useState<Date>(defaultDate);
    const [viewMonth, setViewMonth] = useState<Date>(defaultDate);

    const onConfirm = () => {
      call.end(DateTime.fromJSDate(selectedDate).toISO());
    };

    return (
      <Dialog open={true} onOpenChange={(value) => (!value ? call.end(null) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{fieldMeta?.label || <Trans>Select Date</Trans>}</DialogTitle>

            <DialogDescription>
              <Trans>Please select a date for this field.</Trans>
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center gap-3">
            <div className="flex w-full max-w-[280px] gap-2">
              <Select
                value={String(viewMonth.getMonth())}
                onValueChange={(val) => {
                  const next = new Date(viewMonth);
                  next.setMonth(Number(val));
                  setViewMonth(next);
                }}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((name, idx) => (
                    <SelectItem key={idx} value={String(idx)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={String(viewMonth.getFullYear())}
                onValueChange={(val) => {
                  const next = new Date(viewMonth);
                  next.setFullYear(Number(val));
                  setViewMonth(next);
                }}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {YEARS.map((year) => (
                    <SelectItem key={year} value={String(year)}>
                      {year}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Calendar
              mode="single"
              selected={selectedDate}
              month={viewMonth}
              onMonthChange={setViewMonth}
              onSelect={(date) => {
                if (date) {
                  setSelectedDate(date);
                }
              }}
              classNames={{
                caption_label: 'hidden',
                nav_button_previous: 'absolute left-0',
                nav_button_next: 'absolute right-0',
              }}
              initialFocus
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => call.end(null)}>
              <Trans>Cancel</Trans>
            </Button>

            <Button type="button" onClick={onConfirm}>
              <Trans>Confirm</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
);
