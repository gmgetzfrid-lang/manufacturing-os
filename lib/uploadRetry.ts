// lib/uploadRetry.ts
//
// One-tap retry that keeps the file. Wrap an upload action (the transfer
// plus whatever it saves after) in tryUpload: if it fails, the corner upload
// card shows "Try again", which runs the same action with the same file, so
// nobody has to find and pick it again. A Stop is never offered as a retry.
// Callers still show their own error; onRetried lets them refresh after a
// retry from the card works.

import { UploadCancelledError } from "@/lib/storage";

export type UploadRetryEvent =
  | { kind: "failed"; id: string; name: string; error: string; retry: () => void }
  | { kind: "retrying"; id: string; name: string }
  | { kind: "done"; id: string; name: string };

type Listener = (e: UploadRetryEvent) => void;
const listeners = new Set<Listener>();
let seq = 0;

export function subscribeUploadRetries(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function emit(e: UploadRetryEvent) {
  listeners.forEach((l) => { try { l(e); } catch { /* a broken listener must not break uploads */ } });
}

export async function tryUpload<T>(
  name: string,
  run: () => Promise<T>,
  opts?: { onRetried?: (result: T) => void },
  id: string = `retry-${Date.now()}-${++seq}`,
): Promise<T> {
  try {
    const result = await run();
    emit({ kind: "done", id, name });
    return result;
  } catch (err) {
    const stopped = err instanceof UploadCancelledError || (err as Error)?.name === "AbortError";
    if (!stopped) {
      emit({
        kind: "failed", id, name,
        error: (err as Error)?.message || "It didn't go through.",
        retry: () => {
          emit({ kind: "retrying", id, name });
          void tryUpload(name, run, opts, id).then((r) => opts?.onRetried?.(r)).catch(() => { /* the card shows it again */ });
        },
      });
    }
    throw err;
  }
}
