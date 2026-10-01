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

import { useCallback, useEffect, useRef, useState } from "react";
import { userFacingCaughtError } from "@/lib/userFacingError";

export interface UndoableToast {
  id: number;
  message: string;
  /** Called when the user clicks Undo. Reverses the action. When omitted the
   *  toast is purely informational (no Undo button rendered). */
  undo?: () => void | Promise<void>;
  /** Tone for the icon/accent. */
  tone?: "default" | "success" | "warning";
  /** The action's own message, kept once an Undo has failed — the failed
   *  toast prefixes it with the reason, and a translated reason can itself
   *  contain " — " (REL-3), so the prefix is never parsed back off. */
  baseMessage?: string;
}

const TIMEOUT_MS = 7000;
/** How long a toast whose Undo FAILED stays up (with Undo as a retry). */
const FAILED_UNDO_MS = 15000;
const MAX_TOASTS = 3;

export function useUndoableActions() {
  const [toasts, setToasts] = useState<UndoableToast[]>([]);
  const toastsRef = useRef<UndoableToast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const running = useRef(new Set<number>());
  const seq = useRef(0);

  const commit = useCallback((next: UndoableToast[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);
  const clearTimer = useCallback((id: number) => {
    const handle = timers.current.get(id);
    if (handle) clearTimeout(handle);
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback((id: number) => {
    commit(toastsRef.current.filter((x) => x.id !== id));
    clearTimer(id);
  }, [commit, clearTimer]);

  const arm = useCallback((id: number, ms: number) => {
    clearTimer(id);
    const handle = setTimeout(() => {
      timers.current.delete(id);
      if (running.current.has(id)) return; // an undo in flight keeps its toast
      commit(toastsRef.current.filter((x) => x.id !== id));
    }, ms);
    timers.current.set(id, handle);
  }, [clearTimer, commit]);

  const pushToast = useCallback((toast: Omit<UndoableToast, "id">) => {
    const id = ++seq.current;
    const next = [...toastsRef.current, { id, ...toast }];
    // Keep the last three; a toast dropped off the top takes its timer with
    // it, so the timers map only ever holds the toasts on screen (PT SCH-18).
    for (const dropped of next.slice(0, Math.max(0, next.length - MAX_TOASTS))) clearTimer(dropped.id);
    commit(next.slice(-MAX_TOASTS));
    arm(id, TIMEOUT_MS);
  }, [commit, clearTimer, arm]);

  // Nothing fires after the view is gone.
  useEffect(() => () => {
    for (const h of timers.current.values()) clearTimeout(h);
    timers.current.clear();
  }, []);

  /** Announce a completed, reversible action. */
  const announce = useCallback((message: string, undo: () => void | Promise<void>, tone: UndoableToast["tone"] = "default") => {
    pushToast({ message, undo, tone });
  }, [pushToast]);

  /** Informational toast with no Undo (e.g. an error). */
  const notify = useCallback((message: string, tone: UndoableToast["tone"] = "default") => {
    pushToast({ message, tone });
  }, [pushToast]);

  /** Run a toast's Undo. The toast stays up until the undo has actually
   *  worked: an undo that throws (the schedule handlers throw on a refused
   *  write — PT SCH-18) turns the SAME toast into "Couldn't undo: …" with its
   *  Undo button kept as a retry, instead of closing as if it had worked. A
   *  second click while one is running is ignored. */
  const runUndo = useCallback(async (t: UndoableToast) => {
    if (!t.undo) { dismiss(t.id); return; }
    if (running.current.has(t.id)) return;
    running.current.add(t.id);
    clearTimer(t.id);
    try {
      await t.undo();
      running.current.delete(t.id);
      dismiss(t.id);
    } catch (e) {
      running.current.delete(t.id);
      const reason = ((e as Error)?.message ? userFacingCaughtError(e, { context: "useUndoableActions" }) : "please refresh and try again").replace(/\.$/, "");
      const base = t.baseMessage ?? t.message;
      const failed: UndoableToast = { ...t, tone: "warning", baseMessage: base, message: `Couldn't undo: ${reason} — ${base}` };
      const current = toastsRef.current;
      commit(current.some((x) => x.id === t.id) ? current.map((x) => (x.id === t.id ? failed : x)) : [...current, failed].slice(-MAX_TOASTS));
      arm(t.id, FAILED_UNDO_MS);
    }
  }, [dismiss, clearTimer, commit, arm]);

  /** Test seam: how many timers are held (one per toast on screen). */
  const timerCount = useCallback(() => timers.current.size, []);

  return { toasts, announce, notify, dismiss, runUndo, timerCount };
}
