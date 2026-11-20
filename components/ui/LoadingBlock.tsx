"use client";

// Never a blank area while something loads: the rough shape of what's
// coming, and a line saying what it is.
import React from "react";

export default function LoadingBlock({ what, rows = 4, className = "" }: { what?: string; rows?: number; className?: string }) {
  const widths = [78, 62, 70, 54, 66, 58, 74, 50];
  return (
    <div aria-busy="true" aria-live="polite" className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2.5 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-3.5 rounded bg-[var(--color-surface-2)] animate-pulse" style={{ width: `${widths[i % widths.length]}%` }} />
      ))}
      <p className="text-[12px] text-[var(--color-text-muted)]">{what ? `Loading ${what}…` : "Loading…"}</p>
    </div>
  );
}
