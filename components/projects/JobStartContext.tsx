"use client";

// JobStartContext — when the job starts (its first planned day), for the
// pickers that ask when work happened: nothing can have happened on the
// job before it started.

import { createContext, useContext } from "react";

export const JobStartContext = createContext<number | undefined>(undefined);

/** The job's first planned start (ms), when the schedule has one. */
export const useJobStart = () => useContext(JobStartContext);

/** The earliest planned or baseline start on the schedule. */
export function jobStartOf(items: Array<{ plannedStartAt?: string | number | Date | null; baselineStartAt?: string | number | Date | null }>): number | undefined {
  let min = Infinity;
  for (const m of items) for (const v of [m.plannedStartAt, m.baselineStartAt]) { const t = v == null || v === "" ? NaN : new Date(v).getTime(); if (t < min) min = t; }
  return Number.isFinite(min) ? min : undefined;
}
