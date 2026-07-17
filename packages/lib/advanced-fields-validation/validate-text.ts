import type { TTextFieldMeta as TextFieldMeta } from '../types/field-meta';
import { getCombFieldCells } from '../types/field-meta';

export const validateTextField = (
  value: string,
  fieldMeta: TextFieldMeta,
  isSigningPage: boolean = false,
): string[] => {
  const errors = [];

  const { characterLimit, readOnly, required, fontSize } = fieldMeta;

  // The cell count is the effective character limit for comb fields.
  const combCellCount = getCombFieldCells(fieldMeta)?.length ?? 0;
  const effectiveLimit = combCellCount > 0 ? combCellCount : characterLimit;

  if (required && !value && isSigningPage) {
    errors.push('Value is required');
  }

  if (effectiveLimit !== undefined && effectiveLimit > 0 && value.length > effectiveLimit) {
    errors.push(`Value length (${value.length}) exceeds the character limit (${effectiveLimit})`);
  }

  if (readOnly && value.length < 1) {
    errors.push('A read-only field must have text');
  }

  if (readOnly && required) {
    errors.push('A field cannot be both read-only and required');
  }

  if (fontSize && (fontSize < 8 || fontSize > 96)) {
    errors.push('Font size must be between 8 and 96.');
  }

  return errors;
};
