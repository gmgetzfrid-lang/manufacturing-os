"use client";

// useScheduleNow — ONE "now" for every schedule figure on a screen (PT SCH-5).
//
// Overdue is decided by UTC day (lib/milestoneLiveness isOverdueMilestone).
// When each surface took its own "now" — the summary strip's `today` fixed
// when the board mounted, the pulse's Date.now() on every data change — a
// session open across a UTC midnight (17:00 PDT, 09:00 JST) showed "N overdue"
// in the pulse and N − k in the strip right below it after the next refresh.
// The screen now holds one instant, handed to every surface that counts
// overdue, so the figures can only ever change together.
//
// The instant moves to a new UTC day just after each UTC midnight (a timer),
// and — because browsers do not run timers while the device sleeps and freeze
// background tabs — whenever the page is shown or focused again, and whenever
// a data refresh (`refreshKey`) lands on a later UTC day. Within one UTC day
// it stays put, so every figure on the screen is counted at the same instant.

import { useCallback, useEffect, useState } from "react";

const DAY_MS = 86_400_000;
const utcDay = (ms: number) => Math.floor(ms / DAY_MS);

/** Milliseconds from `nowMs` to just past the next UTC midnight. */
export function msUntilNextUtcDay(nowMs: number): number {
  return DAY_MS - (((nowMs % DAY_MS) + DAY_MS) % DAY_MS) + 1_000;
}

/** The screen's "now" (epoch ms): read on mount, then again just after every
 *  UTC midnight, when the page is shown or focused, and when `refreshKey`
 *  (the screen's data) changes — taking a new instant only on a new UTC day. */
export function useScheduleNow(refreshKey?: unknown): number {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  // Re-read the clock; a later UTC day replaces the instant (and re-arms the
  // midnight timer below), the same day keeps it.
  const resync = useCallback(() => {
    const t = Date.now();
    setNowMs((prev) => (utcDay(t) > utcDay(prev) ? t : prev));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setNowMs(Date.now()), msUntilNextUtcDay(nowMs));
    return () => clearTimeout(timer);
  }, [nowMs]);
  // A laptop that slept past midnight, or a frozen background tab: its timer
  // has not fired, so the page re-reads the clock when it comes back.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState !== "hidden") resync(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", resync);
    window.addEventListener("pageshow", resync);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", resync);
      window.removeEventListener("pageshow", resync);
    };
  }, [resync]);
  // A data refresh (realtime, an own edit, a reload) that lands on a later
  // UTC day moves every figure to it together — re-read just after the
  // refreshed render commits (every surface on it shares the instant).
  useEffect(() => {
    let live = true;
    queueMicrotask(() => { if (live) resync(); });
    return () => { live = false; };
  }, [refreshKey, resync]);
  return nowMs;
}
