"use client";

// FirstRunHint — dismissible banner shown once per user per key.
// Uses localStorage to remember the dismissal. Designed to live at
// the top of new/unfamiliar surfaces (Split wizard, Holds page, etc)
// so first-time users get a one-line orientation without modal
// interruption. Once dismissed, never returns — per the directive's
// "don't interrupt experienced users" rule.

import React, { useState, useSyncExternalStore } from "react";
import { Info, X } from "lucide-react";

interface FirstRunHintProps {
  /** Stable storage key. Pick something descriptive like
   *  "lifecycle.split.intro" — namespacing prevents collisions. */
  storageKey: string;
  children: React.ReactNode;
  /** Optional tone. Default is neutral blue. */
  tone?: "info" | "warning";
}

const STORAGE_PREFIX = "first_run_hint:";

const subscribeNever = () => () => {};

export default function FirstRunHint({ storageKey, children, tone = "info" }: FirstRunHintProps) {
  // Hydration-safe localStorage read (same pattern as CiteCoachMark). The
  // old lazy useState initializer returned hidden=true on the server but
  // read the real value on the client — so an undismissed banner existed in
  // the client's first render and not in the server HTML, and React threw
  // hydration error #418 on every page that mounts a hint. With
  // useSyncExternalStore the hydration pass uses the server snapshot
  // (hidden) on both sides, then React re-renders with the client value.
  const stored = useSyncExternalStore(
    subscribeNever,
    () => {
      try { return window.localStorage.getItem(STORAGE_PREFIX + storageKey) === "1"; }
      catch { return true; }
    },
    () => true,
  );
  const [dismissed, setDismissed] = useState(false);

  const dismiss = () => {
    try { window.localStorage.setItem(STORAGE_PREFIX + storageKey, "1"); }
    catch { /* noop */ }
    setDismissed(true);
  };

  if (stored || dismissed) return null;

  const toneClass = tone === "warning"
    ? "bg-amber-50 border-amber-200 text-amber-900"
    : "bg-blue-50 border-blue-200 text-blue-900";

  return (
    <div className={`flex items-start gap-2 border rounded-lg px-3 py-2 text-xs ${toneClass}`}>
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />
      <div className="flex-1">{children}</div>
      <button
        onClick={dismiss}
        title="Dismiss — won't show again"
        className="p-0.5 rounded hover:bg-black/5 opacity-70 hover:opacity-100"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
