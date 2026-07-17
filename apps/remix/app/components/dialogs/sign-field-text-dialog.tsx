import { useMemo } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { msg } from '@lingui/core/macro';
import { Plural, useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
import { createCallable } from 'react-call';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { TTextFieldMeta } from '@documenso/lib/types/field-meta';
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@documenso/ui/primitives/form/form';
import { Textarea } from '@documenso/ui/primitives/textarea';

export type SignFieldTextDialogProps = {
  fieldMeta?: TTextFieldMeta;
};

export const SignFieldTextDialog = createCallable<SignFieldTextDialogProps, string | null>(
  ({ call, fieldMeta }) => {
    const { t } = useLingui();

    // The cell count is the effective character limit for comb fields.
    const combCellCount = getCombFieldCells(fieldMeta)?.length ?? 0;
    const isCombField = combCellCount > 0;

    const characterLimit = isCombField ? combCellCount : (fieldMeta?.characterLimit ?? 0);

    const ZSignFieldTextFormSchema = useMemo(
      () =>
        z.object({
          text: z
            .string()
            .min(1, { message: msg`Text is required`.id })
            .superRefine((value, ctx) => {
              if (characterLimit > 0 && value.length > characterLimit) {
                ctx.addIssue({
                  code: z.ZodIssueCode.too_big,
                  type: 'string',
                  maximum: characterLimit,
                  inclusive: true,
                  message: t`Text cannot exceed ${characterLimit} characters`,
                });
              }
            }),
        }),
      [characterLimit],
    );

    type TSignFieldTextFormSchema = z.infer<typeof ZSignFieldTextFormSchema>;

    const form = useForm<TSignFieldTextFormSchema>({
      resolver: zodResolver(ZSignFieldTextFormSchema),
      defaultValues: {
        text: '',
      },
    });

    return (
      <Dialog open={true} onOpenChange={(value) => (!value ? call.end(null) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{fieldMeta?.label || <Trans>Enter Text</Trans>}</DialogTitle>

            <DialogDescription className="mt-4">
              <Trans>Please enter a value</Trans>
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit((data) => call.end(data.text))}>
              <fieldset
                className="flex h-full flex-col space-y-4"
                disabled={form.formState.isSubmitting}
              >
                <FormField
                  control={form.control}
                  name="text"
                  render={({ field, fieldState }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea
                          id="custom-text"
                          placeholder={fieldMeta?.placeholder ?? t`Enter your text here`}
                          maxLength={characterLimit > 0 ? characterLimit : undefined}
                          className={cn('w-full rounded-md', {
                            'border-2 border-red-300 text-left ring-2 ring-red-200 ring-offset-2 ring-offset-red-200 focus-visible:border-red-400 focus-visible:ring-4 focus-visible:ring-red-200 focus-visible:ring-offset-2 focus-visible:ring-offset-red-200':
                              fieldState.error,
                          })}
                          {...field}
                          onChange={(e) => {
                            // Comb cells are single-line, one character each.
                            if (isCombField) {
                              e.target.value = e.target.value.replace(/[\r\n]+/g, '');
                            }

                            field.onChange(e);
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                      {characterLimit > 0 && !fieldState.error && (
                        <div className="text-sm text-muted-foreground">
                          <Plural
                            value={characterLimit - (field.value?.length ?? 0)}
                            one="# character remaining"
                            other="# characters remaining"
                          />
                        </div>
                      )}
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
