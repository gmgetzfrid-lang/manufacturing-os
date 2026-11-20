"use client";

// ShiftMark — which crew does a step: ☀ day, ☾ night, 24h round the clock.
// The same reading the shift report counts it against (workShiftOf), so
// what the calendar and timeline show is what the report does.

import React from "react";
import { Sun, Moon } from "lucide-react";
import type { WorkShift } from "@/lib/shiftReport";

export default function ShiftMark({ work, label }: { work: WorkShift; label?: boolean }) {
  const title = work === "both" ? "Worked round the clock" : work === "night" ? "Night-shift work" : "Day-shift work";
  if (work === "both") {
    return <span title={title} className="shrink-0 inline-flex items-center rounded px-1 text-[11px] font-black leading-[14px] bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)]">24h</span>;
  }
  const night = work === "night";
  return (
    <span title={title} className={`shrink-0 inline-flex items-center gap-0.5 rounded px-1 text-[11px] font-bold leading-[14px] bg-[var(--color-surface-2)] ${night ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
      {night ? <Moon className="w-2.5 h-2.5" /> : <Sun className="w-2.5 h-2.5" />}{label ? (night ? "Night" : "Day") : null}
    </span>
  );
}
