"use client";

// DiscoveryTag — a step put in after the plan (lib/discovery): discovery,
// found when the equipment was opened, or added scope, known work that
// wasn't on the schedule. Marked the same calm way everywhere a step
// shows, so it reads as what it is, not as planned work that slipped.

import React from "react";
import type { Milestone } from "@/types/schema";
import { discoveryOf, kindOf, ADDED, type AddedKind } from "@/lib/discovery";
import { fmtInTz } from "@/lib/scheduleTz";

/** The tag's look: ink on the warm fill for both kinds (the word says
 *  which). Colour stays for problem, warning and done. */
export const ADDED_TONE: Record<AddedKind, string> = {
  discovery: "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]",
  added: "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]",
};

/** "Added scope, raised Wed 5:00 PM: clean the downcomers. Known work that wasn't on the schedule — not in the original plan." */
export function discoveryTip(m: Milestone, tz: string): string | null {
  const d = discoveryOf(m);
  if (!d) return null;
  const k = ADDED[kindOf(d)];
  const when = Number.isFinite(d.foundAt) ? fmtInTz(d.foundAt, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : null;
  return `${k.word}${when ? `, ${k.found} ${when}` : ""}: ${d.what}. ${k.tip[0].toUpperCase()}${k.tip.slice(1)}.`;
}

export default function DiscoveryTag({ m, tz, className = "" }: { m: Milestone; tz: string; className?: string }) {
  const d = discoveryOf(m);
  const tip = discoveryTip(m, tz);
  if (!d || !tip) return null;
  return (
    <span title={tip} className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[12px] font-semibold leading-none align-middle ${ADDED_TONE[kindOf(d)]} ${className}`}>
      {ADDED[kindOf(d)].word}
    </span>
  );
}
