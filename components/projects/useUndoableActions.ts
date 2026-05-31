"use client";

// useUndoableActions — the safety net that lets a brand-new user touch
// anything without fear. Every significant schedule action (move,
// status change) reports itself here; we show a brief toast confirming
// what happened with an Undo button that reverses it.
//
// Why this is its own hook: feedback + reversal is the difference
// between "works if you're trained" and "a novice can explore freely."
// FANG tools all have this (Gmail's "Undo send", etc.); the schedule
// had neither feedback nor undo.

import { useCallback, useRef, useState } from "react";

export interface UndoableToast {
  id: number;
  message: string;
  /** Called when the user clicks Undo. Reverses the action. */
  undo: () => void | Promise<void>;
  /** Tone for the icon/accent. */
  tone?: "default" | "success" | "warning";
}

const TIMEOUT_MS = 7000;

export function useUndoableActions() {
  const [toasts, setToasts] = useState<UndoableToast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const handle = timers.current.get(id);
    if (handle) { clearTimeout(handle); timers.current.delete(id); }
  }, []);

  /** Announce a completed, reversible action. Returns nothing — the
   *  toast manages its own lifetime. */
  const announce = useCallback((message: string, undo: () => void | Promise<void>, tone: UndoableToast["tone"] = "default") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, message, undo, tone }]); // keep last 3
    const handle = setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
      timers.current.delete(id);
    }, TIMEOUT_MS);
    timers.current.set(id, handle);
  }, []);

  const runUndo = useCallback(async (t: UndoableToast) => {
    dismiss(t.id);
    await t.undo();
  }, [dismiss]);

  return { toasts, announce, dismiss, runUndo };
}
