// AM and PM mixed up: a time on the other crew's shift (or far from the
// plan, on round-the-clock work) is asked about, with the other reading.

import { describe, it, expect } from "vitest";
import { ampmSlip } from "@/lib/ampm";
import type { ShiftTimes } from "@/lib/shiftReport";
import type { Milestone } from "@/types/schema";

const tz = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00" };
const at = (d: string, hm: string) => Date.parse(`2026-11-${d}T${hm}:00-08:00`);
const mk = (p: Partial<Milestone>): Milestone => ({ id: "s", orgId: "o", name: "Step", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const now = at("03", "09:00");

describe("a time that reads like AM and PM the wrong way round", () => {
  const day = mk({ plannedStartAt: new Date(at("02", "08:00")).toISOString(), plannedAt: new Date(at("02", "12:00")).toISOString(), responsibleParty: "Schultz" });
  it("12:00 AM on a day job: midnight, on the night shift; noon is offered", () => {
    const s = ampmSlip(at("02", "00:00"), day, tz, times, now, "Schultz");
    expect(s?.otherLabel).toBe("12:00 PM");
    expect(s?.other).toBe(at("02", "12:00"));
    expect(s?.says).toBe("12:00 AM is midnight, on the night shift - Schultz works days.");
  });
  it("2:00 AM on a day job: 2:00 PM offered", () => {
    expect(ampmSlip(at("02", "02:00"), day, tz, times, now)?.says).toBe("2:00 AM is on the night shift - this step's crew works days.");
  });
  it("a time on its own crew's shift: nothing asked", () => {
    expect(ampmSlip(at("02", "10:30"), day, tz, times, now)).toBeNull();
  });
  it("the other reading hasn't happened yet: nothing asked", () => {
    expect(ampmSlip(at("03", "02:00"), day, tz, times, at("03", "09:00"))).toBeNull();
  });
  it("round the clock: asked only when the other reading is a good 6 hours nearer the plan", () => {
    const tower = mk({ plannedStartAt: new Date(at("02", "10:00")).toISOString(), plannedAt: new Date(at("03", "10:00")).toISOString(), shift: "swing" as Milestone["shift"] });
    const s = ampmSlip(at("02", "00:00"), tower, tz, times, now, null, at("02", "10:00"));
    expect(s?.otherLabel).toBe("12:00 PM");
    expect(s?.says).toBe("12:00 AM is midnight, 10 h before its plan (10:00 AM).");
    expect(ampmSlip(at("02", "08:00"), tower, tz, times, now, null, at("02", "10:00"))).toBeNull();
  });
});
