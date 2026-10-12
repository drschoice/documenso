import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How many times {@link useEnvelopeAutosave}'s flush will drain a payload that was
 * queued while the previous one was still in flight.
 */
const MAX_FLUSH_ROUNDS = 5;

export function useEnvelopeAutosave<T>(saveFn: (data: T) => Promise<void>, delay = 1000) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArgsRef = useRef<T | null>(null);
  const pendingPromiseRef = useRef<Promise<void> | null>(null);

  const [isPending, setIsPending] = useState(false);
  const [isCommiting, setIsCommiting] = useState(false);

  const triggerSave = useCallback(
    (data: T) => {
      lastArgsRef.current = data;

      // A debounce or promise means something is pending
      setIsPending(true);

      if (timeoutRef.current) clearTimeout(timeoutRef.current);

      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      timeoutRef.current = setTimeout(async () => {
        if (!lastArgsRef.current) {
          return;
        }

        const args = lastArgsRef.current;
        lastArgsRef.current = null;
        timeoutRef.current = null;

        setIsCommiting(true);
        pendingPromiseRef.current = saveFn(args);

        try {
          await pendingPromiseRef.current;
        } finally {
          // eslint-disable-next-line require-atomic-updates
          pendingPromiseRef.current = null;
          setIsCommiting(false);
          setIsPending(false);
        }
      }, delay);
    },
    [saveFn, delay],
  );

  const flush = useCallback(async () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    // A save that is already running carries the payload it started with, not
    // whatever was queued behind it while it ran. Awaiting it and returning
    // therefore drops the newest edit on the floor at the one moment a flush is
    // meant to guarantee the opposite - a step change, a persist, a beforeunload.
    // So drain: wait out the in-flight save, then commit anything still queued.
    //
    // Bounded because a save can legitimately queue one more round (the fields
    // save writes server ids back into the form), but nothing should queue
    // forever; if something does, a hung flush would be worse than a lost round.
    for (let round = 0; round < MAX_FLUSH_ROUNDS; round += 1) {
      if (pendingPromiseRef.current) {
        await pendingPromiseRef.current;
        continue;
      }

      if (!lastArgsRef.current) {
        return;
      }

      const args = lastArgsRef.current;
      lastArgsRef.current = null;

      setIsCommiting(true);
      setIsPending(true);

      pendingPromiseRef.current = saveFn(args);
      try {
        await pendingPromiseRef.current;
      } finally {
        // eslint-disable-next-line require-atomic-updates
        pendingPromiseRef.current = null;
        setIsCommiting(false);
        setIsPending(false);
      }
    }
  }, [saveFn]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (timeoutRef.current || pendingPromiseRef.current) {
        void flush();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [flush]);

  return { triggerSave, flush, isPending, isCommiting };
}
