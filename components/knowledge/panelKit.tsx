"use client";

// The pieces the knowledge panels share (library health, meaning index,
// drawing intelligence), so each reads the same: a row of labeled cells
// for the numbers, one bar for progress, and a note with a colored left
// rule for anything that happened or needs a person.

import React from "react";

export type PanelTone = "good" | "warn" | "bad" | "none";

const TONE_TEXT: Record<PanelTone, string> = {
  good: "text-[var(--state-released)]",
  warn: "text-[var(--state-held)]",
  bad: "text-[var(--state-overdue)]",
  none: "text-[var(--color-heading)]",
};
const TONE_RULE: Record<PanelTone, string> = {
  good: "bg-[var(--state-released)]",
  warn: "bg-[var(--state-held)]",
  bad: "bg-[var(--state-overdue)]",
  none: "bg-[var(--color-border-strong)]",
};

export interface Cell {
  label: React.ReactNode;
  value: React.ReactNode;
  /** One short muted line under the number. */
  hint?: React.ReactNode;
  tone?: PanelTone;
  /** A percentage: draws a thin progress bar under the number. */
  bar?: number;
}

/** A row of ruled cells: a muted label, a big condensed number, an
 *  optional hint. Two across on a phone, one row on a desk. */
export function Cells({ cells, size = "lg" }: { cells: Cell[]; size?: "lg" | "sm" }) {
  const big = size === "lg" ? "text-[26px] sm:text-[28px]" : "text-[20px]";
  return (
    <dl className={`grid grid-cols-2 ${cells.length >= 4 ? "md:grid-cols-4" : cells.length === 3 ? "md:grid-cols-3" : ""} [&>div]:border-[var(--color-border)] max-md:[&>div:nth-child(2n)]:border-l md:[&>div+div]:border-l max-md:[&>div:nth-child(n+3)]:border-t`}>
      {cells.map((c, i) => (
        <div key={i} className="min-w-0 px-4 sm:px-5 py-3.5">
          <dt className="text-[13px] text-[var(--color-text-muted)] truncate">{c.label}</dt>
          <dd className={`font-display ${big} leading-tight mt-0.5 font-semibold tabular-nums ${TONE_TEXT[c.tone ?? "none"]}`}>{c.value}</dd>
          {c.bar !== undefined && <Bar className="mt-1.5" segments={[{ key: "done", value: c.bar, color: "var(--color-main)" }]} total={100} thin />}
          {c.hint && <dd className="mt-0.5 text-[13px] leading-snug text-[var(--color-text-muted)]">{c.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** One bar on a soft brand track: progress, or a whole split into parts. */
export function Bar({ segments, total, thin = false, className = "", label }: {
  segments: Array<{ key: string; value: number; color: string; title?: string }>;
  total: number;
  thin?: boolean;
  className?: string;
  /** Read out to screen readers ("80% built"). */
  label?: string;
}) {
  const sum = Math.max(total, 1);
  return (
    <div role={label ? "img" : undefined} aria-label={label}
      className={`${thin ? "h-1.5" : "h-2.5"} rounded-full overflow-hidden flex bg-[var(--color-accent-soft)] ${className}`}>
      {segments.filter((s) => s.value > 0).map((s) => (
        <span key={s.key} title={s.title} className="h-full transition-[width] duration-500" style={{ width: `${Math.min(100, (s.value / sum) * 100)}%`, background: s.color }} />
      ))}
    </div>
  );
}

/** Something that happened or needs a person: a 3px rule in the state
 *  color, a bold first line, then at most a line or two. */
export function Note({ tone = "none", title, children, action, className = "" }: {
  tone?: PanelTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** A button on the right (wraps under on a phone). */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div role={tone === "bad" ? "alert" : undefined} className={`relative pl-4 flex flex-wrap items-start gap-x-4 gap-y-2 ${className}`}>
      <span aria-hidden className={`absolute left-0 inset-y-0 w-[3px] rounded-full ${TONE_RULE[tone]}`} />
      <div className="min-w-0 flex-1 basis-[280px] text-[14px] leading-snug text-[var(--color-text-muted)]">
        {title && <div className={`font-semibold ${tone === "none" ? "text-[var(--color-text)]" : TONE_TEXT[tone]}`}>{title}</div>}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
