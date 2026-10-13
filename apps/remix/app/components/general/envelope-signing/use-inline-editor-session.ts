import { useEffect, useRef, useState } from 'react';

import { useLingui } from '@lingui/react/macro';

import type { TInlineCommitError } from '@documenso/lib/universal/field-inline-signing/resolve-inline-commit';
import { useToast } from '@documenso/ui/primitives/use-toast';

import type { TInlineNavigationDirection } from './envelope-signing-inline-edit-provider';
import { useInlineCommitErrorMessage } from './use-inline-commit-error-message';

type UseInlineEditorSessionOptions = {
  initialValue: string;
  onCommit: (draft: string) => TInlineCommitError | null;
  onClose: () => void;
  /** Move to the next or previous field, after the value has been handed over for saving. */
  onNavigate: (direction: TInlineNavigationDirection) => void;
  /**
   * Whether what was typed is saved if the editor goes away while still open. Off for editors
   * whose typing only filters choices rather than being the value.
   */
  saveOnUnmount?: boolean;
};

type FinishOptions = {
  /** Save this instead of the draft, e.g. a day picked from a calendar. */
  value?: string;
  /** Move to another field once saved, as Tab and Shift+Tab do. */
  then?: TInlineNavigationDirection;
};

/**
 * What every in-place editor on the signing page does with what the signer types, whatever it
 * looks like.
 *
 * Leaving the field saves it: clicking elsewhere, Enter, or the editor going away (the page
 * scrolling out of the list, another document being opened). Escape puts the saved value back.
 * A value the server would reject keeps the editor open with the reason when the signer pressed a
 * key; when they clicked away, the field keeps its saved value and they are told why. Tab and
 * Shift+Tab save and move on, unless the value is rejected.
 */
export const useInlineEditorSession = ({
  initialValue,
  onCommit,
  onClose,
  onNavigate,
  saveOnUnmount = true,
}: UseInlineEditorSessionOptions) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const getErrorMessage = useInlineCommitErrorMessage();

  const [draft, setDraftState] = useState(initialValue);
  const [error, setError] = useState<TInlineCommitError | null>(null);

  // Set once the signer has left the field, so the blur that follows Enter, or the unmount that
  // follows closing, does not save a second time.
  const isEndedRef = useRef(false);

  const draftRef = useRef(draft);
  draftRef.current = draft;

  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // Save what was typed if the editor goes away without the signer leaving the field.
  useEffect(() => {
    return () => {
      if (saveOnUnmount && !isEndedRef.current && draftRef.current !== initialValue) {
        onCommitRef.current(draftRef.current);
      }
    };
  }, []);

  const setDraft = (next: string) => {
    setDraftState(next);
    setError(null);
  };

  const finish = (
    action: 'save' | 'revert',
    trigger: 'blur' | 'key',
    options: FinishOptions = {},
  ) => {
    if (isEndedRef.current) {
      return;
    }

    if (action === 'save') {
      const commitError = onCommit(options.value ?? draft);

      if (commitError && trigger === 'key') {
        setError(commitError);
        return;
      }

      if (commitError) {
        toast({
          title: t`Your entry was not saved`,
          description: getErrorMessage(commitError),
          variant: 'destructive',
        });
      }
    }

    isEndedRef.current = true;

    if (options.then) {
      onNavigate(options.then);
    } else {
      onClose();
    }
  };

  const handleBlur = () => {
    // Switching to another window or tab blurs the field too. The browser puts focus back when
    // the signer returns, so keep the editor open.
    if (!document.hasFocus()) {
      return;
    }

    finish('save', 'blur');
  };

  return {
    draft,
    setDraft,
    error,
    errorMessage: error ? getErrorMessage(error) : null,
    finish,
    handleBlur,
  };
};
