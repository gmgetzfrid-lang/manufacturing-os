"use client";

// DiscoveryTag — a step that was added when the equipment was opened
// (lib/discovery): marked the same calm way everywhere a step shows, so
// added scope reads as added scope, not as planned work that slipped.

import React from "react";
import type { Milestone } from "@/types/schema";
import { discoveryOf } from "@/lib/discovery";
import { fmtInTz } from "@/lib/scheduleTz";

/** "Found Wed 5:30 AM: Unplanned clean downcomers. Added to the schedule — not in the original plan." */
export function discoveryTip(m: Milestone, tz: string): string | null {
  const d = discoveryOf(m);
  if (!d) return null;
  const when = Number.isFinite(d.foundAt) ? fmtInTz(d.foundAt, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : null;
  return `Discovery${when ? `, found ${when}` : ""}: ${d.what}. Added to the schedule — not in the original plan.`;
}

export default function DiscoveryTag({ m, tz, className = "" }: { m: Milestone; tz: string; className?: string }) {
  const tip = discoveryTip(m, tz);
  if (!tip) return null;
  return (
    <span title={tip} className={`inline-block whitespace-nowrap rounded border px-1 py-px text-[9.5px] font-bold uppercase tracking-wide leading-none border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200 align-middle ${className}`}>
      Discovery
    </span>
  );
}
