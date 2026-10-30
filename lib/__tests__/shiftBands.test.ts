// A step's shift by date: day 5:30–17:30, night 17:30 → 5:30 the next
// morning — night work after midnight is the night before's.

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { stepBandDays } from "@/lib/shiftBands";

const tz = "America/Los_Angeles"; // PDT, UTC−7, in late October 2026
const at = (d: string, hm: string) => new Date(`2026-10-${d}T${hm}:00-07:00`).toISOString();
const step = (from: string, to: string, extra: Partial<Milestone> = {}): Milestone =>
  ({ id: "s", orgId: "o", projectId: "p", name: "Step", weight: 1, status: "planned", source: "manual", createdBy: "u", plannedStartAt: from, plannedAt: to, ...extra } as Milestone);
const bands = (m: Milestone) => { const b = stepBandDays(m, tz); return { day: [...b.day], night: [...b.night] }; };

describe("which shift a step is worked on", () => {
  it("day hours: that date's day shift", () => {
    expect(bands(step(at("26", "08:00"), at("26", "12:00")))).toEqual({ day: ["2026-10-26"], night: [] });
  });
  it("evening into the small hours: that evening's night shift, once", () => {
    expect(bands(step(at("26", "18:00"), at("27", "03:00")))).toEqual({ day: [], night: ["2026-10-26"] });
  });
  it("after midnight: the night before's shift", () => {
    expect(bands(step(at("27", "01:00"), at("27", "04:00")))).toEqual({ day: [], night: ["2026-10-26"] });
  });
  it("night hours with no night crew on it: the day crew's next day shift, once - as the shift report has it", () => {
    expect(bands(step(at("26", "18:00"), at("26", "22:00"), { staffedShift: "day" }))).toEqual({ day: ["2026-10-27"], night: [] });
    // Mon 22:00 → Tue 04:00, an inspector with no night crew: Tuesday's day shift only.
    expect(bands(step(at("26", "22:00"), at("27", "04:00"), { staffedShift: "day" }))).toEqual({ day: ["2026-10-27"], night: [] });
  });
  it("round the clock: every shift it touches, not the few minutes past a change", () => {
    expect(bands(step(at("26", "06:00"), at("28", "05:40"), { shift: "both" as Milestone["shift"] }))).toEqual({
      day: ["2026-10-26", "2026-10-27"], night: ["2026-10-26", "2026-10-27"],
    });
  });
  it("a step running ten minutes into the night is still day work", () => {
    expect(bands(step(at("26", "13:00"), at("26", "17:40")))).toEqual({ day: ["2026-10-26"], night: [] });
  });
  it("date-only work: its crew's shift on each date", () => {
    expect(bands(step(at("26", "00:00"), at("27", "00:00")))).toEqual({ day: ["2026-10-26", "2026-10-27"], night: [] });
  });
});
