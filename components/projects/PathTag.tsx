"use client";

// PathTag — a step against the critical path, the same words everywhere a
// step is updated: on it (red), or near it with its float (amber). From
// lib/criticalPath — the one answer every view reads.

import React from "react";
import type { PathMarks } from "@/lib/criticalPath";

export default function PathTag({ id, marks, className = "" }: { id?: string | null; marks?: PathMarks; className?: string }) {
  if (!id || !marks) return null;
  if (marks.ids.has(id)) {
    return <span title="On the critical path - it sets the finish date" className={`inline-block whitespace-nowrap rounded px-1 py-px text-[9.5px] font-black uppercase tracking-wide leading-none bg-rose-700 text-white align-middle ${className}`}>Critical</span>;
  }
  if (marks.near.has(id)) {
    const f = marks.floatH.get(id);
    return (
      <span title="Within a shift of the critical path - if it slips this much, it sets the finish date"
        className={`inline-block whitespace-nowrap rounded border px-1 py-px text-[9.5px] font-bold leading-none border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 align-middle ${className}`}>
        Near critical{f != null ? ` · ${f} h float` : ""}
      </span>
    );
  }
  return null;
}
