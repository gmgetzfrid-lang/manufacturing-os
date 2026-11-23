"use client";

// Loading, the quiet way: the rough shape of what's coming, in place of
// the list being loaded, while the rest of the screen stays usable. No
// spinner over a whole panel. The bars breathe gently (still under
// reduced motion). Screen readers hear "Loading <what>".

import React from "react";

/** One placeholder bar. Give it a width and height (or use a preset). */
export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={`ui-skeleton h-3.5 ${className}`} style={style} />;
}

const WIDTHS = [72, 58, 66, 48, 62, 54, 70, 46];

/** Rows shaped like the list or table that is loading: a leading cell, a
 *  wide one, and `cols` short ones, with hairlines between rows. */
export function SkeletonRows({
  rows = 4,
  cols = 2,
  what,
  sheet = true,
  className = "",
}: {
  rows?: number;
  /** Short columns after the main one (dates, counts, a status). */
  cols?: number;
  /** What is loading, for screen readers ("documents"). */
  what?: string;
  /** Draw the white sheet around the rows (off when the caller has one). */
  sheet?: boolean;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite"
      className={`${sheet ? "rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]" : ""} divide-y divide-[var(--color-border)] ${className}`}>
      <span className="sr-only">{what ? `Loading ${what}` : "Loading"}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 h-12">
          <Skeleton className="w-4 h-4 rounded-full shrink-0" />
          <Skeleton className="min-w-0" style={{ width: `${WIDTHS[i % WIDTHS.length]}%` }} />
          <span className="flex-1" />
          {Array.from({ length: cols }, (_, j) => (
            <Skeleton key={j} className="max-sm:hidden shrink-0" style={{ width: j === 0 ? 72 : 48 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A block of text lines loading (a card's body, a detail pane). */
export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={`space-y-2.5 ${className}`}>
      <span className="sr-only">Loading</span>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} style={{ width: `${i === lines - 1 ? 45 : WIDTHS[i % WIDTHS.length] + 20}%` }} />
      ))}
    </div>
  );
}

export default Skeleton;
