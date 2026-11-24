"use client";

// Never a silent spinner. Past a few seconds a waiting screen says what's
// happening and that nothing is wrong with the account; past half a minute
// it offers a way out. A slow sign-in or start-up almost always means the
// server is under heavy load (a big upload or indexing job). The person
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
    <div role="status" className={`mt-3 border-l-2 pl-3 py-0.5 text-body text-left ${dark
      ? "border-[var(--state-held)] text-[var(--color-ink-text)]"
      : "border-[var(--state-held)] text-[var(--color-text-muted)]"}`}>
      <span className={`font-medium ${dark ? "" : "text-[var(--state-held-text)]"}`}>Taking longer than usual ({secs} s).</span>{" "}
      {what} is slow to answer, often because it&rsquo;s busy with a big upload or indexing job. It&rsquo;s still trying.
      {secs >= 25 && onStartOver && (
        <button type="button" onClick={onStartOver} className="block mt-1.5 min-h-8 pointer-coarse:min-h-11 font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">
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
