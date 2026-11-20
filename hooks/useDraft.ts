"use client";

// Autosave what you type. Kept on this device only (a draft, not a record):
// it comes back if the page reloads or you leave and return, and is cleared
// once it's sent.
import { useCallback, useEffect, useRef, useState } from "react";

const PREFIX = "draft:";

export function readDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

export function clearDraft(key: string) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* private mode */ }
}

/**
 * Restores a saved draft once (when there is one and `canRestore` says the
 * field is still empty), then saves every change a moment after typing stops.
 * `key` null turns it off (e.g. a form opened with prefilled values).
 */
export function useDraft<T>(
  key: string | null,
  value: T,
  restore: (v: T) => void,
  isEmpty: (v: T) => boolean,
): { restored: boolean; clear: () => void } {
  const [restored, setRestored] = useState(false);
  const tried = useRef<string | null>(null);
  const ready = useRef(false);
  const restoreRef = useRef(restore);
  useEffect(() => { restoreRef.current = restore; });

  useEffect(() => {
    if (!key || tried.current === key) return;
    tried.current = key;
    const saved = readDraft<T>(key);
    if (saved != null && !isEmpty(saved)) { restoreRef.current(saved); setRestored(true); }
    else setRestored(false);
    // Saving may start now: the save below waits a moment, and the restored
    // value replaces this render's empty one before that wait ends.
    ready.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!key || !ready.current) return;
    const t = setTimeout(() => {
      try {
        if (isEmpty(value)) localStorage.removeItem(PREFIX + key);
        else localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch { /* full or private mode */ }
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value]);

  const clear = useCallback(() => { if (key) clearDraft(key); setRestored(false); }, [key]);
  return { restored, clear };
}
