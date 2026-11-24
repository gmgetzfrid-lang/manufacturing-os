"use client";

// A company's score, quiet: the number in tabular figures and its band as
// a dot and a word (green excellent or good, amber watch, red concern, grey
// unrated). Color never fills a box; the number itself takes a color only
// when the band asks for attention (watch, concern). The same on the
// registry and on the company's own page.

import React from "react";
import { scoreBand } from "@/lib/companyScore";

const DOT: Record<string, string> = { green: "is-good", lime: "is-good", amber: "is-warn", rose: "is-bad", slate: "is-muted" };
/** Text color for a figure: only bands that need attention are colored. */
const FIGURE: Record<string, string> = {
  green: "text-[var(--color-text)]",
  lime: "text-[var(--color-text)]",
  amber: "text-[var(--state-held-text)]",
  rose: "text-[var(--state-overdue-text)]",
  slate: "text-[var(--color-text-muted)]",
};

/** The score and its band's word ("85 · Excellent"); `label` false drops the word. */
export function ScoreBadge({ score, label = true, size = "md" }: { score: number | null; label?: boolean; size?: "sm" | "md" | "lg" }) {
  const band = scoreBand(score);
  const num = size === "lg" ? "text-[24px]" : size === "sm" ? "text-reading" : "text-section";
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {score != null && (
        <span className={`font-display font-semibold tabular-nums ${num} ${FIGURE[band.tone]}`}>{Math.round(score)}</span>
      )}
      {label && <span className={`ui-pill ${DOT[band.tone]} ${band.tone === "amber" || band.tone === "rose" ? "" : "!font-normal !text-[var(--color-text-muted)]"}`}>{band.label}</span>}
    </span>
  );
}

/** A dimension's score as a figure; colored only when its band needs attention. */
export function ScoreFigure({ score, className = "" }: { score: number; className?: string }) {
  const band = scoreBand(score);
  return <span className={`font-display font-semibold tabular-nums ${FIGURE[band.tone]} ${className}`}>{Math.round(score)}</span>;
}
