import { describe, it, expect } from "vitest";
import { mergeShiftTimes } from "@/lib/shiftTimesStore";

describe("saving shift times keeps everything else saved beside them", () => {
  const existing = {
    dayStart: "06:00", nightStart: "18:00", breaks: [{ shift: "day", start: "09:00", minutes: 15, label: "Break" }], nightJobs: ["a"],
    letterhead: { name: "lh" }, phases: [{ id: "ph1" }], closeout: { pssr: "done" }, manpower: { bids: {} },
    nextPlan: { ph1: [{ kind: "nights", id: "x" }] }, staffingPlans: { Schultz: { file: "plan.xlsx" } }, somethingNew: 1,
  };
  it("keeps the suggested schedule's changes and the staffing plans", () => {
    const out = mergeShiftTimes(existing, { dayStart: "05:30", nightStart: "17:30" });
    expect(out.nextPlan).toEqual(existing.nextPlan);
    expect(out.staffingPlans).toEqual(existing.staffingPlans);
    expect(out.letterhead).toEqual(existing.letterhead);
    expect(out.phases).toEqual(existing.phases);
    expect(out.closeout).toEqual(existing.closeout);
    expect(out.manpower).toEqual(existing.manpower);
    expect(out.somethingNew).toBe(1);
  });
  it("replaces the times, and a time setting left out is removed", () => {
    const out = mergeShiftTimes(existing, { dayStart: "05:30", nightStart: "17:30" });
    expect(out.dayStart).toBe("05:30");
    expect(out.breaks).toBeUndefined();
    expect(out.nightJobs).toBeUndefined();
  });
  it("works with nothing saved yet", () => {
    expect(mergeShiftTimes(null, { dayStart: "06:00", nightStart: "18:00" })).toEqual({ dayStart: "06:00", nightStart: "18:00" });
  });
});
