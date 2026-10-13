"use client";

// ScheduleTzContext — hands the project's timezone to every schedule
// view (timeline, calendar, detail panel, progress, report, import
// preview) without threading a prop through each one. The value is
// always a valid IANA name; "UTC" when the project has none set.

import React, { createContext, useContext } from "react";
import { DEFAULT_SCHEDULE_TZ, normalizeTimeZone } from "@/lib/scheduleTz";

const Ctx = createContext<string>(DEFAULT_SCHEDULE_TZ);

export function ScheduleTzProvider({ timeZone, children }: { timeZone?: string | null; children: React.ReactNode }) {
  return <Ctx.Provider value={normalizeTimeZone(timeZone)}>{children}</Ctx.Provider>;
}

/** The plant's zone for the schedule being viewed. */
export function useScheduleTz(): string {
  return useContext(Ctx);
}
