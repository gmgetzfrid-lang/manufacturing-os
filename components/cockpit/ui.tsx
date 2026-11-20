"use client";

// The small pieces Home, the Inbox, Activity and the notification panels
// share, so a ruled table, a status tag and a row button look the same on
// every one of them. Color only where it means something: a late row gets
// a red edge, a status a small dot; normal rows get none.

import React from "react";
import Link from "next/link";

/** One white sheet that holds a table or a ruled list. */
export const sheet = "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden";
/** A table header row: grey band, muted 13px labels. */
export const thead = "bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left";
export const th = "font-semibold px-4 h-10 whitespace-nowrap";
/** A row that opens what it names. */
export const rowHover = "hover:bg-[var(--color-surface-2)] cursor-pointer transition-colors";
/** A secondary button in a row: white, ruled, graphite. */
export const rowBtn =
  "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-text-faint)] disabled:opacity-50 transition-colors whitespace-nowrap";
/** An icon button: visible hover fill, always with an aria-label. */
export const iconBtn =
  "inline-flex items-center justify-center w-9 h-9 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] disabled:opacity-40 transition-colors";
/** A link in running text or a cell. */
export const link = "text-[var(--color-accent-text)] hover:underline underline-offset-2";

export type StatusTone = "overdue" | "held" | "released" | "neutral" | "muted";

const PILL: Record<StatusTone, string> = {
  overdue: "is-bad",
  held: "is-warn",
  released: "is-good",
  neutral: "",
  muted: "is-muted",
};

/** A status as a soft colored pill: red late, amber waiting, green done,
 *  brand for normal work, grey for not set. */
export function StatusTag({ tone, children, className = "" }: { tone: StatusTone; children: React.ReactNode; className?: string }) {
  return <span className={`ui-pill ${PILL[tone]} ${className}`}>{children}</span>;
}

/** The 3px left edge on a late row (put it in a `relative` first cell). */
export function LateEdge({ tone = "overdue" }: { tone?: "overdue" | "held" }) {
  return <span aria-hidden className={`absolute left-0 inset-y-0 w-[3px] ${tone === "overdue" ? "bg-[var(--state-overdue)]" : "bg-[var(--state-held)]"}`} />;
}

/** "2026-08-06" (or a timestamp) → "Aug 6"; the year only when it isn't this one. */
export function humanDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = plain ? new Date(`${iso}T12:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "3:05 PM". */
export function humanTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Rewrites ISO dates inside a sentence ("was due 2026-08-06") as human ones. */
export function humanizeDates(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?\b/g, (m, day: string) => humanDate(day) || m);
}

/** A small ruled row of counts (label over figure), for a section's footer
 *  or a body's head. Each cell can open what it counts. */
export function FactRow({ cells, className = "" }: {
  cells: Array<{ label: React.ReactNode; value: React.ReactNode; href?: string; tone?: "bad" | "warn"; note?: React.ReactNode; icon?: React.ReactNode }>;
  className?: string;
}) {
  const tone = (t?: "bad" | "warn") => t === "bad" ? "text-[var(--state-overdue)]" : t === "warn" ? "text-[var(--state-held)]" : "text-[var(--color-text)]";
  return (
    <div className={`grid grid-cols-1 sm:grid-flow-col sm:auto-cols-fr divide-y sm:divide-y-0 sm:divide-x divide-[var(--color-border)] ${className}`}>
      {cells.map((c, i) => {
        const text = (
          <>
            <span className="block min-w-0 text-[13px] text-[var(--color-text-muted)] truncate">{c.label}</span>
            <span className="sm:mt-0.5 flex items-baseline gap-2 min-w-0 shrink-0 sm:shrink">
              {c.note && <span className="sm:order-2 text-[13px] text-[var(--color-text-muted)] truncate">{c.note}</span>}
              <span className={`font-display text-[20px] sm:text-[22px] leading-none font-semibold tabular-nums ${tone(c.tone)}`}>{c.value}</span>
            </span>
          </>
        );
        // With an icon: the tile at the left, the label and figure beside it.
        const body = c.icon ? (
          <>
            <span aria-hidden className={`ui-icon-tile ${c.tone === "bad" ? "!bg-[var(--state-overdue)] !text-white" : ""}`}>{c.icon}</span>
            <span className="min-w-0 flex-1 flex items-baseline justify-between gap-3 sm:block">{text}</span>
          </>
        ) : text;
        // A phone: one line each, the label left and the figure right.
        const cell = c.icon
          ? "min-w-0 px-4 py-2.5 sm:py-3 flex items-center gap-3"
          : "min-w-0 px-4 py-2.5 sm:py-3 flex items-baseline justify-between gap-3 sm:block";
        return c.href ? (
          <Link key={i} href={c.href} className={`${cell} hover:bg-[var(--color-surface-2)] transition-colors`}>{body}</Link>
        ) : (
          <div key={i} className={cell}>{body}</div>
        );
      })}
    </div>
  );
}

/** How far a project's work is: a brand bar (red when late) and the %. */
export function WorkBar({ pct, late = false, title, className = "", width = "w-24" }: {
  pct: number; late?: boolean; title?: string; className?: string; width?: string;
}) {
  const v = Math.min(100, Math.max(0, Math.round(pct)));
  return (
    <span className={`inline-flex items-center gap-2 ${className}`} title={title}>
      <span className={`relative h-2 ${width} rounded-full bg-[var(--color-accent-soft)] overflow-hidden`} role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label="Work done">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${v}%`, background: late ? "var(--state-overdue)" : "var(--color-main)" }} />
      </span>
      <span className="font-display text-[15px] font-semibold tabular-nums text-[var(--color-text)]">{v}%</span>
    </span>
  );
}
