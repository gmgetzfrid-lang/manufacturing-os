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
    return <span title={title} className="shrink-0 inline-flex items-center rounded px-1 text-[8.5px] font-black leading-[14px] bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200">24h</span>;
  }
  const night = work === "night";
  return (
    <span title={title} className={`shrink-0 inline-flex items-center gap-0.5 rounded px-1 text-[9px] font-bold leading-[14px] ${night ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200" : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200"}`}>
      {night ? <Moon className="w-2.5 h-2.5" /> : <Sun className="w-2.5 h-2.5" />}{label ? (night ? "Night" : "Day") : null}
    </span>
  );
}
