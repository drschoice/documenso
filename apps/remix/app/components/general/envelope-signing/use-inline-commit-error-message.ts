import { useLingui } from '@lingui/react/macro';
import { match } from 'ts-pattern';

import type { TInlineCommitError } from '@documenso/lib/universal/field-inline-signing/resolve-inline-commit';

/**
 * Turns why a value typed into a field cannot be saved into a message for the signer, in their
 * language.
 */
export const useInlineCommitErrorMessage = () => {
  const { t } = useLingui();

  return (error: TInlineCommitError): string =>
    match(error)
      .with({ code: 'TOO_LONG' }, ({ limit }) => t`Use ${limit} characters or fewer.`)
      .with({ code: 'INVALID_NUMBER' }, () => t`Please enter a valid number.`)
      .with(
        { code: 'NUMBER_FORMAT' },
        ({ format }) => t`Number needs to be formatted as ${format}.`,
      )
      .with({ code: 'NUMBER_TOO_SMALL' }, ({ min }) => t`Number must be at least ${min}.`)
      .with({ code: 'NUMBER_TOO_LARGE' }, ({ max }) => t`Number must be at most ${max}.`)
      .with({ code: 'INVALID_EMAIL' }, () => t`Please enter a valid email address.`)
      .with({ code: 'INVALID_DATE' }, ({ format }) => t`Enter the date as ${format}.`)
      .with({ code: 'INVALID_OPTION' }, () => t`Please choose one of the options.`)
      .with({ code: 'INVALID' }, () => t`This value cannot be saved.`)
      .exhaustive();
};
