"use client";

// useScheduleNow — ONE "now" for every schedule figure on a screen (PT SCH-5).
//
// Overdue is decided by UTC day (lib/milestoneLiveness isOverdueMilestone).
// When each surface took its own "now" — the summary strip's `today` fixed
// when the board mounted, the pulse's Date.now() on every data change — a
// session open across a UTC midnight (17:00 PDT, 09:00 JST) showed "N overdue"
// in the pulse and N − k in the strip right below it after the next refresh.
// The screen now holds one instant, handed to every surface that counts
// overdue, and advances it at each UTC midnight, so the figures can only ever
// change together.

import { useEffect, useState } from "react";

const DAY_MS = 86_400_000;

/** Milliseconds from `nowMs` to just past the next UTC midnight. */
export function msUntilNextUtcDay(nowMs: number): number {
  return DAY_MS - (((nowMs % DAY_MS) + DAY_MS) % DAY_MS) + 1_000;
}

/** The screen's "now" (epoch ms): read once on mount, then again just after
 *  every UTC midnight. */
export function useScheduleNow(): number {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setTimeout(() => setNowMs(Date.now()), msUntilNextUtcDay(nowMs));
    return () => clearTimeout(timer);
  }, [nowMs]);
  return nowMs;
}
