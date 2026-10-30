// The plant clock read from the zone's offset (fast) is the same clock the
// zone's formatter gives, minute by minute, across clock changes.

import { describe, it, expect } from "vitest";
import { wallClock, wallClockToMs, dayKey } from "@/lib/scheduleTz";

const viaFormatter = (ms: number, tz: string) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { year: o.year, month: o.month, day: o.day, hour: o.hour % 24, minute: o.minute, second: o.second };
};

describe("the plant clock, fast", () => {
  for (const tz of ["America/Los_Angeles", "America/Chicago", "Australia/Adelaide", "Asia/Kolkata", "Australia/Lord_Howe", "UTC"]) {
    it(`matches the formatter every 7 minutes for two years: ${tz}`, () => {
      const from = Date.UTC(2026, 0, 1), to = Date.UTC(2028, 0, 1);
      let bad = 0;
      for (let t = from; t < to; t += 7 * 60_000 + 13_000) {
        const a = wallClock(t, tz), b = viaFormatter(t, tz);
        if (a.year !== b.year || a.month !== b.month || a.day !== b.day || a.hour !== b.hour || a.minute !== b.minute || a.second !== b.second) bad++;
      }
      expect(bad).toBe(0);
    }, 60_000);
  }
  it("round trips the wall time, and the day", () => {
    const tz = "America/Los_Angeles";
    const t = Date.UTC(2026, 9, 26, 8, 30);
    expect(wallClockToMs(wallClock(t, tz), tz)).toBe(t);
    expect(dayKey(t, tz)).toBe("2026-10-26");
  });
});
