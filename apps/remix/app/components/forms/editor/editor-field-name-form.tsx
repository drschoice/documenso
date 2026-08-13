import { useEffect } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { Trans, useLingui } from '@lingui/react/macro';
import { useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import {
  DEFAULT_FIELD_FONT_SIZE,
  FIELD_DEFAULT_GENERIC_ALIGN,
  FIELD_DEFAULT_NAME_PART,
  type TNameFieldMeta as NameFieldMeta,
  ZNameFieldMeta,
} from '@documenso/lib/types/field-meta';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@documenso/ui/primitives/form/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@documenso/ui/primitives/select';

import {
  EditorGenericFontSizeField,
  EditorGenericTextAlignField,
} from './editor-field-generic-field-forms';

const ZNameFieldFormSchema = ZNameFieldMeta.pick({
  fontSize: true,
  textAlign: true,
  namePart: true,
});

type TNameFieldFormSchema = z.infer<typeof ZNameFieldFormSchema>;

type EditorFieldNameFormProps = {
  value: NameFieldMeta | undefined;
  onValueChange: (value: NameFieldMeta) => void;
};

export const EditorFieldNameForm = ({
  value = {
    type: 'name',
  },
  onValueChange,
}: EditorFieldNameFormProps) => {
  const { t } = useLingui();

  const form = useForm<TNameFieldFormSchema>({
    resolver: zodResolver(ZNameFieldFormSchema),
    mode: 'onChange',
    defaultValues: {
      fontSize: value.fontSize || DEFAULT_FIELD_FONT_SIZE,
      textAlign: value.textAlign ?? FIELD_DEFAULT_GENERIC_ALIGN,
      namePart: value.namePart ?? FIELD_DEFAULT_NAME_PART,
    },
  });

  const { control } = form;

  const formValues = useWatch({
    control,
  });

  // Dupecode/Inefficient: Done because native isValid won't work for our usecase.
  useEffect(() => {
    const validatedFormValues = ZNameFieldFormSchema.safeParse(formValues);

    if (validatedFormValues.success) {
      onValueChange({
        type: 'name',
        ...validatedFormValues.data,
      });
    }
  }, [formValues]);

  return (
    <Form {...form}>
      <form>
        <fieldset className="flex flex-col gap-2">
          <FormField
            control={form.control}
            name="namePart"
            render={({ field: { ref: _ref, ...field } }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Name part</Trans>
                </FormLabel>
                <FormControl>
                  <Select
                    value={field.value}
                    name={field.name}
                    onValueChange={field.onChange}
                    onOpenChange={() => field.onBlur()}
                  >
                    <SelectTrigger data-testid="field-form-namePart">
                      <SelectValue placeholder={t`Select name part`} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">
                        <Trans>Full name</Trans>
                      </SelectItem>
                      <SelectItem value="first">
                        <Trans>First name</Trans>
                      </SelectItem>
                      <SelectItem value="middle">
                        <Trans>Middle name</Trans>
                      </SelectItem>
                      <SelectItem value="last">
                        <Trans>Last name</Trans>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <EditorGenericFontSizeField formControl={form.control} />

          <EditorGenericTextAlignField formControl={form.control} />
        </fieldset>
      </form>
    </Form>
  );
};
