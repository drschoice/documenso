import { FieldType } from '@prisma/client';

import { numberFormatValues } from '@documenso/ui/primitives/document-flow/field-items-advanced-settings/constants';

import { validateNumberField } from '../../advanced-fields-validation/validate-number';
import { validateTextField } from '../../advanced-fields-validation/validate-text';
import type { TNumberFieldMeta, TTextFieldMeta } from '../../types/field-meta';
import { type TFieldMetaSchema, getCombFieldCells } from '../../types/field-meta';
import { zEmail } from '../../utils/zod';
import {
  formatDateForInput,
  getDateInputPattern,
  getDateInputPlaceholder,
  getSignedDateParts,
  parseDateInput,
  toSignableDate,
} from './date-input';

export type TInlineCommitField = {
  type: FieldType;
  inserted: boolean;
  customText: string;
  fieldMeta?: TFieldMetaSchema | null;
};

/**
 * Why a typed value cannot be saved. Structured rather than a message so the
 * signing page can show it in the signer's language - the shared validators
 * only return English strings.
 */
export type TInlineCommitError =
  | { code: 'TOO_LONG'; limit: number }
  | { code: 'INVALID_NUMBER' }
  | { code: 'NUMBER_FORMAT'; format: string }
  | { code: 'NUMBER_TOO_SMALL'; min: number }
  | { code: 'NUMBER_TOO_LARGE'; max: number }
  | { code: 'INVALID_EMAIL' }
  /** `format` is the pattern to type the date in, e.g. "MM/DD/YYYY". */
  | { code: 'INVALID_DATE'; format: string }
  | { code: 'INVALID_OPTION' }
  | { code: 'INVALID'; message: string };

/** What the document says about how dates are printed, needed to read and write DATE fields. */
export type TInlineCommitOptions = {
  dateFormat?: string | null;
  timeZone?: string | null;
};

export type TInlineCommitResult =
  /** Nothing to send: the value did not change. */
  | { action: 'noop' }
  /** Send this value. `null` clears a filled field. */
  | { action: 'sign'; value: string | null }
  | { action: 'invalid'; error: TInlineCommitError };

/**
 * Decide what leaving an in-place editor should do with what the signer typed.
 *
 * - Surrounding whitespace is dropped, so a value that is only whitespace is
 *   empty.
 * - Emptying a filled field clears it (`null`, never `''`: the server would
 *   store an empty TEXT value as filled).
 * - An unchanged value sends nothing. Every sign request writes an audit log
 *   entry, so tabbing through filled fields must not add one per field.
 * - Anything else is checked with the same validators the server applies, so
 *   the signer is told about a bad value before it is sent.
 */
export const resolveInlineCommit = (
  field: TInlineCommitField,
  draft: string,
  options: TInlineCommitOptions = {},
): TInlineCommitResult => {
  const value = draft.trim();

  if (value === '') {
    return field.inserted ? { action: 'sign', value: null } : { action: 'noop' };
  }

  if (field.inserted && value === getInlineInitialText(field, options)) {
    return { action: 'noop' };
  }

  // A date is typed in the document's pattern but signed as a date, not as the typed text.
  if (field.type === FieldType.DATE) {
    const pattern = getDateInputPattern(options.dateFormat);
    const date = parseDateInput(value, pattern);

    if (!date) {
      return {
        action: 'invalid',
        error: { code: 'INVALID_DATE', format: getDateInputPlaceholder(pattern) },
      };
    }

    return { action: 'sign', value: toSignableDate(date) };
  }

  const error = validateInlineValue(field, value);

  if (error) {
    return { action: 'invalid', error };
  }

  return { action: 'sign', value };
};

/**
 * What an in-place editor starts with for a field: its saved value, as the signer would type it.
 *
 * A signed date is stored formatted for printing ("March 14, 1957, 12:00 PM"), so it is read back
 * and shown in the typing pattern instead. One that cannot be read back is shown as stored, so
 * leaving it untouched does not change it.
 */
export const getInlineInitialText = (
  field: Pick<TInlineCommitField, 'type' | 'inserted' | 'customText'>,
  options: TInlineCommitOptions = {},
): string => {
  if (!field.inserted) {
    return '';
  }

  if (field.type === FieldType.DATE) {
    const date = getSignedDateParts(field.customText, options.dateFormat, options.timeZone);

    return date
      ? formatDateForInput(date, getDateInputPattern(options.dateFormat))
      : field.customText;
  }

  return field.customText;
};

/**
 * The most characters a field accepts, or undefined when it has no limit.
 *
 * A comb field holds one character per cell, so its cell count is the limit.
 */
export const getInlineCharacterLimit = (field: Pick<TInlineCommitField, 'type' | 'fieldMeta'>) => {
  const combCellCount = getCombFieldCells(field.fieldMeta)?.length ?? 0;

  if (combCellCount > 0) {
    return combCellCount;
  }

  if (field.type === FieldType.TEXT && field.fieldMeta?.type === 'text') {
    const { characterLimit } = field.fieldMeta;

    return characterLimit && characterLimit > 0 ? characterLimit : undefined;
  }

  return undefined;
};

const validateInlineValue = (
  field: TInlineCommitField,
  value: string,
): TInlineCommitError | null => {
  switch (field.type) {
    case FieldType.TEXT: {
      const meta: TTextFieldMeta =
        field.fieldMeta?.type === 'text' ? field.fieldMeta : { type: 'text' };

      const errors = validateTextField(value, meta, true);

      if (errors.length === 0) {
        return null;
      }

      const limit = getInlineCharacterLimit(field);

      if (limit !== undefined && value.length > limit) {
        return { code: 'TOO_LONG', limit };
      }

      return { code: 'INVALID', message: errors[0] };
    }

    case FieldType.NUMBER: {
      const meta: TNumberFieldMeta =
        field.fieldMeta?.type === 'number' ? field.fieldMeta : { type: 'number' };

      const errors = validateNumberField(value, meta, true);

      if (errors.length === 0) {
        return null;
      }

      return classifyNumberError(field, meta, value, errors[0]);
    }

    case FieldType.EMAIL:
      return zEmail().safeParse(value).success ? null : { code: 'INVALID_EMAIL' };

    case FieldType.NAME:
    case FieldType.INITIALS:
      // Any non-empty value is accepted, as on the server.
      return null;

    case FieldType.DROPDOWN: {
      const options = field.fieldMeta?.type === 'dropdown' ? (field.fieldMeta.values ?? []) : [];

      return options.some((option) => option.value === value) ? null : { code: 'INVALID_OPTION' };
    }

    default:
      return { code: 'INVALID', message: `Field type ${field.type} cannot be typed in place` };
  }
};

/**
 * Turn a failed number validation into the reason to show the signer. The
 * checks run in the order the validator reports them in.
 */
const classifyNumberError = (
  field: TInlineCommitField,
  meta: TNumberFieldMeta,
  value: string,
  fallbackMessage: string,
): TInlineCommitError => {
  const limit = getInlineCharacterLimit(field);

  if (limit !== undefined && value.length > limit) {
    return { code: 'TOO_LONG', limit };
  }

  if (meta.numberFormat) {
    const formatRegex = numberFormatValues.find((item) => item.value === meta.numberFormat)?.regex;

    if (!formatRegex || !formatRegex.test(value)) {
      return { code: 'NUMBER_FORMAT', format: meta.numberFormat };
    }
  }

  if (!/^[0-9,.]+$/.test(value)) {
    return { code: 'INVALID_NUMBER' };
  }

  const numberValue = parseFloat(value);

  if (typeof meta.minValue === 'number' && meta.minValue > 0 && numberValue < meta.minValue) {
    return { code: 'NUMBER_TOO_SMALL', min: meta.minValue };
  }

  if (typeof meta.maxValue === 'number' && meta.maxValue > 0 && numberValue > meta.maxValue) {
    return { code: 'NUMBER_TOO_LARGE', max: meta.maxValue };
  }

  return { code: 'INVALID', message: fallbackMessage };
};
