"use client";

// The two shapes every Costs sub-tab is built from.
//
// AnswerLine: the first line of a sub-tab. One sentence that answers the
// question the person opened it for, its one key number big, and the one
// main action beside it (design rules N6, TY5, A1). Everything else on the
// sub-tab is smaller and below.
//
// SpendBar: one budget's track, end to end its own whole (100% of that
// budget), filled with what is committed (gray) and what is spent (solid),
// the words on the row (docs/next-update.md 5, rules N7 to N9). Nothing
// spent says "0% spent", never an empty bar that reads as room to spare.

import React from "react";

/** Whole dollars unless there are cents ("$0", "$720,000", "$1,250.50"). */
export function money(n: number, cur = "USD"): string {
  const cents = Math.round(n * 100) % 100 !== 0;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(n); }
  catch { return `$${Math.round(n).toLocaleString("en-US")}`; }
}

/** "62%", or "under 1%" for a sliver that would round to 0. */
export function share(part: number, whole: number): string | null {
  if (!(whole > 0)) return null;
  const p = (part / whole) * 100;
  return part > 0 && p < 1 ? "under 1%" : `${Math.round(p)}%`;
}

export function AnswerLine({ value, children, action, sub, tone }: {
  /** The key number, big ("62%", "$1,180,000", "3"). */
  value?: React.ReactNode;
  /** The sentence the number belongs to. */
  children: React.ReactNode;
  /** The one main action, beside the answer. */
  action?: React.ReactNode;
  /** One quieter line under it. */
  sub?: React.ReactNode;
  /** The number is bad news (over budget). */
  tone?: "bad";
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-answer>
      <div className="min-w-0 flex-1 basis-64 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        {value != null && (
          <span className={`font-display text-title font-bold tabular-nums whitespace-nowrap ${tone === "bad" ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>{value}</span>
        )}
        <span className="min-w-0 text-reading text-[var(--color-text)]">{children}</span>
      </div>
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
      {sub && <div className="basis-full text-body text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

/** The quiet button an AnswerLine carries (outline: the page's one solid
 *  accent button belongs to the page). */
export const answerButton = "ui-press inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50 transition-colors";

function Swatch({ tone }: { tone: "spent" | "over" | "committed" }) {
  const bg = tone === "spent" ? "bg-[var(--color-main)]" : tone === "over" ? "bg-[var(--state-overdue)]" : "bg-[var(--viz-neutral)]";
  return <span aria-hidden className={`inline-block w-2.5 h-2.5 rounded-[2px] mr-1.5 align-[-1px] ${bg}`} />;
}

/** One budget's track: its own whole, committed and spent inside it, and
 *  (unless `labels` is off) the words on the row. */
export function SpendBar({ budget, committed, spent, cur, name, labels = true, thick }: {
  budget: number; committed: number; spent: number; cur: string;
  /** What the bar is, for screen readers ("Scaffolding"). */
  name: string;
  /** The words under the bar; off where a sentence above already says them. */
  labels?: boolean;
  thick?: boolean;
}) {
  const sp = share(spent, budget), cm = share(committed, budget);
  const overSpent = budget > 0 && spent > budget;
  const overCommitted = budget > 0 && committed > budget;
  const w = (n: number) => `${budget > 0 ? Math.min(100, Math.max(0, (n / budget) * 100)) : 0}%`;
  const spentWords = spent <= 0 ? "0% spent"
    : sp ? `${sp} spent, ${money(spent, cur)}${overSpent ? `, ${money(spent - budget, cur)} over` : ""}` : `${money(spent, cur)} spent`;
  const committedWords = committed <= 0 ? "Nothing committed"
    : cm ? `${cm} committed, ${money(committed, cur)}${overCommitted ? `, ${money(committed - budget, cur)} over` : ""}` : `${money(committed, cur)} committed`;
  return (
    <div className="min-w-0">
      <div role="img" aria-label={`${name}: ${budget > 0 ? `${money(budget, cur)} budget, ` : "no budget, "}${spentWords}, ${committedWords.toLowerCase()}.`}
        className={`relative ${thick ? "h-4" : "h-3"} rounded-[3px] bg-[var(--viz-track)] border border-[var(--color-border-strong)] overflow-hidden`}>
        <div className="absolute inset-y-0 left-0 bg-[var(--viz-neutral)]" style={{ width: w(committed) }} />
        <div className={`absolute inset-y-0 left-0 ${overSpent ? "bg-[var(--state-overdue)]" : "bg-[var(--color-main)]"}`} style={{ width: w(spent) }} />
      </div>
      {labels && (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-body">
          <span className={`font-medium ${overSpent ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}><Swatch tone={overSpent ? "over" : "spent"} />{spentWords}</span>
          <span className={overCommitted ? "font-medium text-[var(--state-overdue-text)]" : "text-[var(--color-text-muted)]"}><Swatch tone="committed" />{committedWords}</span>
        </div>
      )}
    </div>
  );
}
