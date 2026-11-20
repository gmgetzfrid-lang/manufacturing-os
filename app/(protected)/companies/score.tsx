"use client";

// A company's score as a colored badge by its band: green excellent,
// green-amber good, amber watch, red concern, grey unrated. The same badge
// on the registry and on the company's own page.

import React from "react";
import { scoreBand } from "@/lib/companyScore";

const FILL: Record<string, string> = {
  green: "var(--state-released)",
  lime: "color-mix(in srgb, var(--state-released) 62%, var(--state-held))",
  amber: "var(--state-held)",
  rose: "var(--state-overdue)",
  slate: "var(--color-text-muted)",
};
const PILL: Record<string, string> = { green: "is-good", lime: "is-good", amber: "is-warn", rose: "is-bad", slate: "is-muted" };

/** The score in a filled square, colored by band; `label` adds the band's word as a pill. */
export function ScoreBadge({ score, label = true, size = "md" }: { score: number | null; label?: boolean; size?: "sm" | "md" | "lg" }) {
  const band = scoreBand(score);
  const box = size === "lg" ? "min-w-12 h-12 text-[24px] rounded-lg" : size === "sm" ? "min-w-8 h-7 text-[15px] rounded-md" : "min-w-10 h-9 text-[19px] rounded-md";
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {score != null && (
        <span className={`inline-grid place-items-center px-1.5 font-display font-semibold tabular-nums text-white ${box}`} style={{ background: FILL[band.tone] }}>
          {Math.round(score)}
        </span>
      )}
      {label && <span className={`ui-pill ${PILL[band.tone]}`}>{band.label}</span>}
    </span>
  );
}

/** A dimension's score as a figure in its band's color. */
export function ScoreFigure({ score, className = "" }: { score: number; className?: string }) {
  const band = scoreBand(score);
  return <span className={`font-display font-semibold tabular-nums ${className}`} style={{ color: band.tone === "slate" ? undefined : FILL[band.tone] }}>{Math.round(score)}</span>;
}
