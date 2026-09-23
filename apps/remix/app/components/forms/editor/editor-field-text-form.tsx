import {
  DEFAULT_FIELD_FONT_SIZE,
  FIELD_DEFAULT_GENERIC_ALIGN,
  FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN,
  FIELD_DEFAULT_LETTER_SPACING,
  FIELD_DEFAULT_LINE_HEIGHT,
  FIELD_MAX_CELL_COUNT,
  FIELD_MIN_CELL_COUNT,
  type TTextFieldMeta as TextFieldMeta,
  ZTextFieldMeta,
} from '@documenso/lib/types/field-meta';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import {
  EditorGenericCellCountField,
  EditorGenericCellSizeField,
  EditorGenericCombModeField,
  EditorGenericFontSizeField,
  EditorGenericLetterSpacingField,
  EditorGenericLineHeightField,
  EditorGenericReadOnlyField,
  EditorGenericRequiredField,
  EditorGenericTextAlignField,
  EditorGenericVerticalAlignField,
} from './editor-field-generic-field-forms';

const ZTextFieldFormSchema = ZTextFieldMeta.pick({
  label: true,
  placeholder: true,
  text: true,
  characterLimit: true,
  fontSize: true,
  textAlign: true,
  lineHeight: true,
  letterSpacing: true,
  verticalAlign: true,
  required: true,
  readOnly: true,
  layout: true,
  cells: true,
  cellSize: true,
})
  .refine(
    (data) => {
      // A read-only field must have text
      return !data.readOnly || (data.text && data.text.length > 0);
    },
    {
      message: 'A read-only field must have text',
      path: ['text'],
    },
  )
  .refine(
    (data) => {
      // The text cannot exceed the cell count in comb layout
      return (
        data.layout !== 'cells' || !data.text || [...data.text].length <= (data.cells ?? []).length
      );
    },
    {
      message: 'Text cannot exceed the number of cells',
      path: ['text'],
    },
  );

type TTextFieldFormSchema = z.infer<typeof ZTextFieldFormSchema>;

type EditorFieldTextFormProps = {
  value: TextFieldMeta | undefined;
  onValueChange: (value: TextFieldMeta) => void;
  isEnvelopeV2?: boolean;
};

export const EditorFieldTextForm = ({
  value = {
    type: 'text',
  },
  onValueChange,
  isEnvelopeV2,
}: EditorFieldTextFormProps) => {
  const { t } = useLingui();

  const form = useForm<TTextFieldFormSchema>({
    resolver: zodResolver(ZTextFieldFormSchema),
    mode: 'onChange',
    defaultValues: {
      label: value.label || '',
      placeholder: value.placeholder || '',
      text: value.text || '',
      characterLimit: value.characterLimit || 0,
      fontSize: value.fontSize || DEFAULT_FIELD_FONT_SIZE,
      textAlign: value.textAlign ?? FIELD_DEFAULT_GENERIC_ALIGN,
      lineHeight: value.lineHeight ?? FIELD_DEFAULT_LINE_HEIGHT,
      letterSpacing: value.letterSpacing ?? FIELD_DEFAULT_LETTER_SPACING,
      verticalAlign: value.verticalAlign ?? FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN,
      required: value.required || false,
      readOnly: value.readOnly || false,
      layout: value.layout ?? 'box',
      // Offsets are owned by the canvas, so only the cell ids round-trip
      // through the form. They are restored by id on merge.
      cells: (value.cells ?? []).map(({ id }) => ({ id })),
      cellSize: value.cellSize,
    },
  });

  const { control } = form;

  const formValues = useWatch({
    control,
  });

  /**
   * Set when the effect below copies an incoming meta into this form, and cleared by the
   * push-up effect at the bottom when it skips the resulting change.
   *
   * Without it the two effects sit permanently one step out of phase. They run in the same
   * commit, so on the render where the overlay delivers a new value the resync calls
   * `setValue` while the push-up effect still holds the *previous* `formValues` - and
   * pushes that stale value straight back into the meta. The overlay corrects it, which
   * re-runs the resync, which re-runs the push... Each pass re-arms the editor's 2s
   * autosave debounce, so it never elapses and the field is never saved at all.
   */
  const isResyncingRef = useRef(false);

  /**
   * The inline "select the field and type" overlay writes the value, `readOnly`
   * and `required` straight into the field meta without going through this form.
   * React Hook Form seeds itself from `value` once, at mount, so its copy then
   * goes stale - and the effect below pushes the *whole* form state up on the
   * next interaction with any control here, which silently threw the typed value
   * away. Re-seed the three fields the overlay owns whenever the incoming meta
   * disagrees. The equality guards make this idempotent, so it settles rather
   * than ping-ponging with that effect.
   */
  useEffect(() => {
    const nextText = value.text || '';
    const nextReadOnly = value.readOnly || false;
    const nextRequired = value.required || false;

    if (form.getValues('text') !== nextText) {
      form.setValue('text', nextText);
      isResyncingRef.current = true;
    }

    if (form.getValues('readOnly') !== nextReadOnly) {
      form.setValue('readOnly', nextReadOnly);
      isResyncingRef.current = true;
    }

    if (form.getValues('required') !== nextRequired) {
      form.setValue('required', nextRequired);
      isResyncingRef.current = true;
    }
  }, [value.text, value.readOnly, value.required]);

  const isCombLayout = formValues.layout === 'cells';

  // Seed the cells the first time comb layout is enabled.
  useEffect(() => {
    if (formValues.layout === 'cells' && (formValues.cells ?? []).length === 0) {
      const cellCount = Math.max(
        FIELD_MIN_CELL_COUNT,
        Math.min(FIELD_MAX_CELL_COUNT, formValues.characterLimit || 5),
      );

      form.setValue(
        'cells',
        Array.from({ length: cellCount }, (_, index) => ({ id: index + 1 })),
      );
    }
  }, [formValues.layout]);

  // Dupecode/Inefficient: Done because native isValid won't work for our usecase.
  useEffect(() => {
    // A resync just wrote the incoming meta into this form. Pushing now would send back
    // the snapshot from before it landed; the next render carries the settled values.
    if (isResyncingRef.current) {
      isResyncingRef.current = false;
      return;
    }

    const validatedFormValues = ZTextFieldFormSchema.safeParse(formValues);

    if (formValues.readOnly && !formValues.text) {
      void form.trigger('text');
    }

    if (validatedFormValues.success) {
      onValueChange({
        type: 'text',
        ...validatedFormValues.data,
      });
    }
  }, [formValues]);

  return (
    <Form {...form}>
      <form>
        <fieldset className="flex flex-col gap-2">
          <EditorGenericFontSizeField className="w-full" formControl={form.control} />

          {isEnvelopeV2 && (
            <div className="mt-1">
              <EditorGenericCombModeField formControl={form.control} />
            </div>
          )}

          {isEnvelopeV2 && isCombLayout && (
            <div className="flex w-full flex-row gap-x-4">
              <EditorGenericCellCountField
                className="w-full"
                formControl={form.control}
                onCellCountChange={(count) => {
                  const textValue = form.getValues('text') || '';

                  if ([...textValue].length > count) {
                    form.setValue('text', [...textValue].slice(0, count).join(''));
                  }
                }}
              />

              <EditorGenericCellSizeField className="w-full" formControl={form.control} />
            </div>
          )}

          {!isCombLayout && (
            <div className="flex w-full flex-row gap-x-4">
              <EditorGenericTextAlignField className="w-full" formControl={form.control} />

              <EditorGenericVerticalAlignField className="w-full" formControl={form.control} />
            </div>
          )}

          <FormField
            control={form.control}
            name="label"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Label</Trans>
                </FormLabel>
                <FormControl>
                  <Input data-testid="field-form-label" placeholder={t`Field label`} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="placeholder"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Placeholder</Trans>
                </FormLabel>
                <FormControl>
                  <Input data-testid="field-form-placeholder" placeholder={t`Field placeholder`} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="text"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Add text</Trans>
                </FormLabel>
                <FormControl>
                  <Textarea
                    data-testid="field-form-text"
                    className="h-auto"
                    placeholder={t`Add text to the field`}
                    {...field}
                    onChange={(e) => {
                      const values = form.getValues();

                      // The cell count is the effective limit in comb layout.
                      const characterLimit =
                        values.layout === 'cells'
                          ? (values.cells ?? []).length
                          : values.characterLimit || 0;

                      let textValue = e.target.value;

                      if (characterLimit > 0 && textValue.length > characterLimit) {
                        textValue = textValue.slice(0, characterLimit);
                      }

                      e.target.value = textValue;
                      field.onChange(e);
                    }}
                    rows={1}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* The cell count is the effective limit in comb layout. */}
          {!isCombLayout && (
            <FormField
              control={form.control}
              name="characterLimit"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    <Trans>Character Limit</Trans>
                  </FormLabel>
                  <FormControl>
                    <Input
                      data-testid="field-form-characterLimit"
                      className="bg-background"
                      placeholder={t`Character limit`}
                      {...field}
                      value={field.value || ''}
                      onChange={(e) => {
                        const values = form.getValues();
                        const characterLimit = parseInt(e.target.value, 10) || 0;

                        field.onChange(characterLimit || '');

                        const textValue = values.text || '';

                        if (characterLimit > 0 && textValue.length > characterLimit) {
                          form.setValue('text', textValue.slice(0, characterLimit));
                        }
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {!isCombLayout && (
            <div className="flex w-full flex-row gap-x-4">
              <EditorGenericLineHeightField className="w-full" formControl={form.control} />

              <EditorGenericLetterSpacingField className="w-full" formControl={form.control} />
            </div>
          )}

          <div className="mt-1">
            <EditorGenericRequiredField formControl={form.control} />
          </div>

          <EditorGenericReadOnlyField formControl={form.control} />
        </fieldset>
      </form>
    </Form>
  );
};
