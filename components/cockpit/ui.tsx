"use client";

// The small pieces Home, the Inbox, Activity and the notification panels
// share, so a ruled table, a status tag and a row button look the same on
// every one of them. Color only where it means something: a late row gets
// a red edge, a status a small dot; normal rows get none.

import React from "react";
import Link from "next/link";
import { btnRow, btnIcon } from "@/components/admin/kit";

/** One white sheet that holds a table or a ruled list. */
export const sheet = "rounded-panel border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden";
/** A table header row: grey band, muted 13px labels. */
export const thead = "bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)] text-left";
export const th = "font-medium px-4 h-10 whitespace-nowrap";
/** A row that opens what it names. */
export const rowHover = "hover:bg-[var(--color-surface-2)] cursor-pointer transition-colors";
/** A secondary button in a row: white, ruled, graphite. */
export const rowBtn = btnRow;
/** An icon button: visible hover fill, always with an aria-label. */
export const iconBtn = btnIcon;
/** A link in running text or a cell. */
export const link = "text-[var(--color-accent-text)] hover:underline underline-offset-2";

/** A section's heading on the page: text, a plain muted count after it
 *  ("Libraries 4"), and its tools on the right. No icon in front. */
export function SectionHead({ title, count, tone, id, children, className = "" }: {
  title: React.ReactNode;
  /** Plain muted figures after the title; nothing when 0 or unset. */
  count?: number;
  /** A late or waiting count reads in its state color. */
  tone?: "bad" | "warn";
  id?: string;
  /** Tools on the right (a link, an icon button). */
  children?: React.ReactNode;
  className?: string;
}) {
  const countCls = tone === "bad" ? "font-medium text-[var(--state-overdue-text)]"
    : tone === "warn" ? "font-medium text-[var(--state-held-text)]"
      : "font-normal text-[var(--color-text-muted)]";
  return (
    <div className={`flex flex-wrap items-end gap-x-3 gap-y-2 mb-3 min-h-8 ${className}`}>
      <h2 id={id} className="font-display text-section font-semibold text-[var(--color-text)]">
        {title}
        {count !== undefined && count > 0 && (
          <span className={`ml-2 font-sans text-body tabular-nums ${countCls}`}>{count.toLocaleString()}</span>
        )}
      </h2>
      <div className="flex-1" />
      {children}
    </div>
  );
}

export type StatusTone = "overdue" | "held" | "released" | "neutral" | "muted";

const PILL: Record<StatusTone, string> = {
  overdue: "is-bad",
  held: "is-warn",
  released: "is-good",
  neutral: "",
  muted: "is-muted",
};

/** A status as a dot and a word: red late, amber waiting (the word in
 *  color too), green done, brand for normal work, grey for not set. */
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

/** How long ago, in words: "Just now", "12 min ago", "3 h ago",
 *  "Yesterday", "4 days ago", then the date ("Aug 6"). */
export function agoWords(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86_400);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return humanDate(iso);
}

/** Rewrites ISO dates inside a sentence ("was due 2026-08-06") as human ones. */
export function humanizeDates(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?\b/g, (m, day: string) => humanDate(day) || m);
}

/** A small ruled row of counts (label over figure), for a section's footer
 *  or a body's head. Each cell can open what it counts. */
export function FactRow({ cells, className = "" }: {
  cells: Array<{ label: React.ReactNode; value: React.ReactNode; href?: string; tone?: "bad" | "warn"; note?: React.ReactNode }>;
  className?: string;
}) {
  // A zero reads muted; a late or waiting figure in its state color.
  const tone = (c: { value: React.ReactNode; tone?: "bad" | "warn" }) =>
    c.value === 0 || c.value === "0" ? "text-[var(--color-text-faint)]"
      : c.tone === "bad" ? "text-[var(--state-overdue-text)]" : c.tone === "warn" ? "text-[var(--state-held-text)]" : "text-[var(--color-text)]";
  return (
    <div className={`grid grid-cols-1 sm:grid-flow-col sm:auto-cols-fr divide-y sm:divide-y-0 sm:divide-x divide-[var(--color-border)] ${className}`}>
      {cells.map((c, i) => {
        const body = (
          <>
            <span className="block min-w-0 text-body text-[var(--color-text-muted)] truncate">{c.label}</span>
            <span className="sm:mt-0.5 flex items-baseline gap-2 min-w-0 shrink-0 sm:shrink">
              {c.note && <span className="sm:order-2 text-body text-[var(--color-text-muted)] truncate">{c.note}</span>}
              <span className={`font-display text-section font-semibold tabular-nums ${tone(c)}`}>{c.value}</span>
            </span>
          </>
        );
        // A phone: one line each, the label left and the figure right.
        const cell = "min-w-0 px-4 py-2.5 sm:py-3 flex items-baseline justify-between gap-3 sm:block";
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
      <span className="font-display text-reading font-semibold tabular-nums text-[var(--color-text)]">{v}%</span>
    </span>
  );
}
