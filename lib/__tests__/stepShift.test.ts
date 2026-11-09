import { describe, it, expect } from "vitest";
import { timesOnShift } from "@/lib/stepShift";
import { DEFAULT_SHIFT_TIMES } from "@/lib/shiftReport";

const tz = "America/Los_Angeles";
const times = { ...DEFAULT_SHIFT_TIMES, dayStart: "06:00", nightStart: "18:00" };
const at = (s: string) => Date.parse(s);
const iso = (t: number) => new Date(t).toISOString();

describe("timesOnShift", () => {
  it("a day step goes to that day's night, its length kept", () => {
    const r = timesOnShift({ plannedStartAt: "2026-11-10T18:00:00Z", plannedAt: "2026-11-10T21:00:00Z" }, "night", tz, times, at("2026-11-09T16:00:00Z"));
    // 10 AM - 1 PM Pacific -> 6 PM - 9 PM Pacific the same day
    expect([iso(r!.start), iso(r!.finish)]).toEqual(["2026-11-11T02:00:00.000Z", "2026-11-11T05:00:00.000Z"]);
  });
  it("a night step goes to the next morning's day shift", () => {
    const r = timesOnShift({ plannedStartAt: "2026-11-11T04:00:00Z", plannedAt: "2026-11-11T06:00:00Z" }, "day", tz, times, at("2026-11-09T16:00:00Z"));
    expect(iso(r!.start)).toBe("2026-11-11T14:00:00.000Z");
    expect(r!.finish - r!.start).toBe(2 * 3_600_000);
  });
  it("already on that shift: unchanged", () => {
    const r = timesOnShift({ plannedStartAt: "2026-11-11T04:00:00Z", plannedAt: "2026-11-11T06:00:00Z" }, "night", tz, times, at("2026-11-09T16:00:00Z"));
    expect(iso(r!.start)).toBe("2026-11-11T04:00:00.000Z");
  });
  it("a night that's over is skipped for the next one", () => {
    // Step planned Nov 8 day; now is Nov 9 morning: Nov 8's night is over.
    const r = timesOnShift({ plannedStartAt: "2026-11-08T18:00:00Z", plannedAt: "2026-11-08T19:00:00Z" }, "night", tz, times, at("2026-11-09T16:00:00Z"));
    expect(iso(r!.start)).toBe("2026-11-10T02:00:00.000Z");
  });
  it("no planned times: nothing", () => {
    expect(timesOnShift({ plannedStartAt: null, plannedAt: null as unknown as string }, "night", tz, times, 0)).toBeNull();
  });
});
