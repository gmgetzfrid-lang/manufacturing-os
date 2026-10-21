"use client";

// AttentionDot — the badge trail's one marker (notifications Round G, N11
// TRAIL — TRAIL-11 dw1/dw3, TRAIL-1, GAP-202 step 3).
//
// The vocabulary is the requests queue's (app/(protected)/requests/page.tsx:
// a red pulsing dot = something here needs your action, a blue dot = new
// activity for you) and the sidebar badge's (a red or blue count), so a user
// who learned "follow the red dot" in Drafting Requests finds the same mark on
// a library card, on the folders on the path to the document, on the document
// row and on a project card.
//
// Density (DEC-90 ruling under the user's delegation, the plan's default):
//   * a COUNT on a library card and on the folders on the path to a badged
//     document — "Library A: 3" narrows the search;
//   * a DOT (no number) on the document row and the project card — the thing
//     itself; a number on every row in a long list is wallpaper (GAP-202
//     "Do not");
//   * NOTHING on an unaffected row or card — this component renders null for
//     a null mark, so a page with nothing to mark renders exactly as before.
//
// SOURCE OF TRUTH: notification-derived — the same feed rows, section rule
// and action rule as the sidebar badge (lib/attentionRollup.ts). A mark
// clears when its notifications are read (visiting the document marks them
// read) or retired by the reconcile pass. The register-state alternative
// (lib/docControlRegister.ts) is the recorded future path for per-document
// compliance pills.
//
// UNKNOWN: when the roll-up could not place every row (a read failed), a
// container with no known count shows a neutral "?" — never nothing, which
// would read as "all clear" (GAP-202 acceptance 6). A count known while the
// roll-up is incomplete is a lower bound and says so ("3+").
//
// The pulse is `motion-safe:` only — prefers-reduced-motion keeps a still dot
// (NEDGE-5's rule for every attention animation).

import React from "react";
import type { AttentionMarkState } from "@/lib/attentionRollup";

export interface AttentionDotProps {
  mark: AttentionMarkState;
  /** "count" — a number (library card, folder); "dot" — no number (a row). */
  variant?: "count" | "dot";
  /** The count is a lower bound (the roll-up is incomplete): show "N+". */
  partial?: boolean;
  /** What the mark sits on, for the accessible name ("this folder"). */
  where?: string;
  className?: string;
}

/** The accessible sentence for a mark. Exported for the tests. */
export function attentionDotLabel(mark: AttentionMarkState, where = "here", partial = false): string | null {
  if (mark === null) return null;
  if (mark === "unknown") return `Notifications ${where} could not be counted — open the bell to see them`;
  const n = `${mark.total}${partial ? " or more" : ""}`;
  const items = `${n} notification${mark.total === 1 && !partial ? "" : "s"} ${where}`;
  return mark.action > 0
    ? `${items}, ${mark.action}${partial ? " or more" : ""} need${mark.action === 1 && !partial ? "s" : ""} your action`
    : `${items}, new for you`;
}

export default function AttentionDot({ mark, variant = "dot", partial = false, where = "here", className = "" }: AttentionDotProps) {
  const label = attentionDotLabel(mark, where, partial);
  if (mark === null || label === null) return null;
  if (mark === "unknown") {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-attention="unknown"
        className={`inline-flex items-center justify-center shrink-0 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-black bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border border-[var(--color-border)] ${className}`}
      >
        ?
      </span>
    );
  }
  if (mark.total <= 0) return null;
  const action = mark.action > 0;
  if (variant === "dot") {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-attention={action ? "action" : "unread"}
        className={`inline-block shrink-0 w-2.5 h-2.5 rounded-full ${action ? "bg-red-500 motion-safe:animate-pulse" : "bg-blue-500"} ${className}`}
      />
    );
  }
  const shown = mark.total > 99 ? "99+" : `${mark.total}${partial ? "+" : ""}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-attention={action ? "action" : "unread"}
      className={`inline-flex items-center justify-center shrink-0 min-w-[18px] h-[18px] px-1 rounded-full text-white text-[10px] font-black shadow ${action ? "bg-red-600 motion-safe:animate-pulse" : "bg-blue-500"} ${className}`}
    >
      {shown}
    </span>
  );
}
