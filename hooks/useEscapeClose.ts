"use client";

// Escape closes the dialog on top, and only that one. Dialogs that use this
// hook form a stack: a dialog opened over another closes first, so Escape
// steps out one layer at a time instead of closing everything at once.
import { useEffect, useRef } from "react";

const stack: number[] = [];
let seq = 0;

/** True while any dialog using this hook is open (a side drawer under one
 *  leaves Escape to it). */
export function escapeStackBusy(): boolean {
  return stack.length > 0;
}

export function useEscapeClose(onClose: () => void, enabled = true) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  useEffect(() => {
    if (!enabled) return;
    const id = ++seq;
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (stack[stack.length - 1] !== id) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
    };
  }, [enabled]);
}
