import { zodResolver } from '@hookform/resolvers/zod';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
import { createCallable } from 'react-call';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { TNumberFieldMeta } from '@documenso/lib/types/field-meta';
import { getCombFieldCells } from '@documenso/lib/types/field-meta';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { numberFormatValues } from '@documenso/ui/primitives/document-flow/field-items-advanced-settings/constants';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';

export type SignFieldNumberDialogProps = {
  fieldMeta: TNumberFieldMeta;
};

export const SignFieldNumberDialog = createCallable<SignFieldNumberDialogProps, string | null>(
  ({ call, fieldMeta }) => {
    const { t } = useLingui();

    // The cell count is the effective character limit for comb fields,
    // including any format separators.
    const combCellCount = getCombFieldCells(fieldMeta)?.length ?? 0;

    const validateCellLimit = (value: string, ctx: z.RefinementCtx) => {
      if (combCellCount > 0 && value.length > combCellCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          type: 'string',
          maximum: combCellCount,
          inclusive: true,
          message: t`Number cannot exceed ${combCellCount} characters`,
        });
      }
    };

    // Needs to be inside dialog for translation purposes.
    const createNumberFieldSchema = (fieldMeta: TNumberFieldMeta) => {
      const { numberFormat, minValue, maxValue } = fieldMeta;

      if (numberFormat) {
        const foundRegex = numberFormatValues.find((item) => item.value === numberFormat)?.regex;

        if (foundRegex) {
          return z
            .string()
            .refine(
              (value) => {
                return foundRegex.test(value.toString());
              },
              {
                message: t`Number needs to be formatted as ${numberFormat}`,
              },
            )
            .superRefine(validateCellLimit);
        }
      }

      // Not gong to work with min/max numbers + number format
      // Since currently doesn't work in V1 going to ignore for now.
      return z.string().superRefine((value, ctx) => {
        validateCellLimit(value, ctx);

        const isValidNumber = /^[0-9,.]+$/.test(value.toString());

        if (!isValidNumber) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: t`Please enter a valid number`,
          });

          return;
        }

        if (typeof minValue === 'number' && parseFloat(value) < minValue) {
          ctx.addIssue({
            code: z.ZodIssueCode.too_small,
            minimum: minValue,
            inclusive: true,
            type: 'number',
          });

          return;
        }

        if (typeof maxValue === 'number' && parseFloat(value) > maxValue) {
          ctx.addIssue({
            code: z.ZodIssueCode.too_big,
            maximum: maxValue,
            inclusive: true,
            type: 'number',
          });

          return;
        }
      });
    };

    const ZSignFieldNumberFormSchema = z.object({
      number: createNumberFieldSchema(fieldMeta),
    });

    const form = useForm<z.infer<typeof ZSignFieldNumberFormSchema>>({
      resolver: zodResolver(ZSignFieldNumberFormSchema),
      defaultValues: {
        number: undefined,
      },
    });

    return (
      <Dialog open={true} onOpenChange={(value) => (!value ? call.end(null) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{fieldMeta.label || <Trans>Enter Number</Trans>}</DialogTitle>

            <DialogDescription className="mt-4">
              <Trans>Please enter a number</Trans>
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit((data) => call.end(data.number))}>
              <fieldset
                className="flex h-full flex-col space-y-4"
                disabled={form.formState.isSubmitting}
              >
                <FormField
                  control={form.control}
                  name="number"
                  render={({ field, fieldState }) => (
                    <FormItem>
                      <FormControl>
                        <Input
                          placeholder={fieldMeta.placeholder ?? t`Enter your number here`}
                          maxLength={combCellCount > 0 ? combCellCount : undefined}
                          className={cn('w-full rounded-md', {
                            'border-2 border-red-300 text-left ring-2 ring-red-200 ring-offset-2 ring-offset-red-200 focus-visible:border-red-400 focus-visible:ring-4 focus-visible:ring-red-200 focus-visible:ring-offset-2 focus-visible:ring-offset-red-200':
                              fieldState.error,
                          })}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <DialogFooter>
                  <Button type="button" variant="secondary" onClick={() => call.end(null)}>
                    <Trans>Cancel</Trans>
                  </Button>

                  <Button type="submit">
                    <Trans>Enter</Trans>
                  </Button>
                </DialogFooter>
              </fieldset>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    );
  },
);
