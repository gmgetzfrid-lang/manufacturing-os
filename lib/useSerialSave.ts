"use client";

// One save at a time, in order; only the newest answer is applied — so a
// slow earlier save can never overwrite a newer one on screen, and the
// database receives the writes in the order they were made.

import { useCallback, useRef } from "react";

export function useSerialSave() {
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const seq = useRef(0);
  return useCallback(<T,>(task: () => Promise<T>, onLatest: (v: T) => void, onError: (e: Error) => void): Promise<void> => {
    const n = ++seq.current;
    const run = chain.current.catch(() => undefined).then(task).then(
      (v) => { if (n === seq.current) onLatest(v); },
      (e: unknown) => { if (n === seq.current) onError(e instanceof Error ? e : new Error(String(e))); },
    );
    chain.current = run;
    return run;
  }, []);
}
