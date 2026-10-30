"use client";

// Never a silent spinner. Past a few seconds a waiting screen says what's
// happening and that nothing is wrong with the account; past half a minute
// it offers a way out. A slow sign-in or start-up almost always means the
// server is under heavy load (a big upload or indexing job) — the person
// should hear that, not stare at a spinner.

import React, { useEffect, useState } from "react";

/** Seconds since `active` became true; 0 while inactive. */
export function useElapsed(active: boolean): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const t = window.setInterval(() => setSecs(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => { window.clearInterval(t); setSecs(0); };
  }, [active]);
  return active ? secs : 0;
}

export function SlowNotice({ secs, onStartOver, dark = false, what = "The server" }: {
  secs: number; onStartOver?: () => void; dark?: boolean; what?: string;
}) {
  if (secs < 8) return null;
  return (
    <div role="status" className={`mt-3 rounded-xl px-3 py-2 text-xs text-left ${dark
      ? "bg-slate-900 text-slate-300 border border-slate-800"
      : "bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-900"}`}>
      <b>Taking longer than usual ({secs}s).</b> {what} is slow to answer - usually because it&rsquo;s under heavy
      load (a big upload or indexing job). Your account and data are fine; it&rsquo;s still trying.
      {secs >= 25 && onStartOver && (
        <button type="button" onClick={onStartOver} className={`block mt-1.5 font-bold underline ${dark ? "text-orange-400" : ""}`}>
          Start over
        </button>
      )}
    </div>
  );
}

/** Reload the app from the start. */
export function startOver(path = "/"): void {
  try { window.location.replace(path); } catch { window.location.href = path; }
}
