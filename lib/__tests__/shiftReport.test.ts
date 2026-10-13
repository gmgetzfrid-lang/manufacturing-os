import { describe, it, expect } from "vitest";
import { buildShiftReport, shiftWindow, shiftAt, nextShift, previousShift, shiftLabel, defaultReviewShift, nextShiftWithWork } from "@/lib/shiftReport";
import { wallClock } from "@/lib/scheduleTz";
import type { Milestone } from "@/types/schema";

const CHI = "America/Chicago";
const at = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-05:00`); // CDT

const mk = (p: Partial<Milestone> & { id: string; name: string; plannedStartAt: string | number; plannedAt: string | number }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

describe("shift windows", () => {
  it("day 05:30–17:30, night 17:30–05:30 next day, plant time", () => {
    const d = shiftWindow("2026-10-26", "day", CHI);
    expect(wallClock(d.start, CHI)).toMatchObject({ day: 26, hour: 5, minute: 30 });
    expect(wallClock(d.end, CHI)).toMatchObject({ day: 26, hour: 17, minute: 30 });
    const n = shiftWindow("2026-10-26", "night", CHI);
    expect(wallClock(n.start, CHI)).toMatchObject({ day: 26, hour: 17, minute: 30 });
    expect(wallClock(n.end, CHI)).toMatchObject({ day: 27, hour: 5, minute: 30 });
  });

  it("finds the shift containing an instant, including the small hours", () => {
    expect(shiftAt(at("2026-10-26", "09:00"), CHI)).toMatchObject({ kind: "day", dayKey: "2026-10-26" });
    expect(shiftAt(at("2026-10-26", "20:00"), CHI)).toMatchObject({ kind: "night", dayKey: "2026-10-26" });
    expect(shiftAt(at("2026-10-27", "02:00"), CHI)).toMatchObject({ kind: "night", dayKey: "2026-10-26" });
    expect(shiftAt(at("2026-10-27", "05:30"), CHI)).toMatchObject({ kind: "day", dayKey: "2026-10-27" });
  });

  it("steps forward and back", () => {
    const d = shiftWindow("2026-10-26", "day", CHI);
    expect(nextShift(d, CHI)).toMatchObject({ kind: "night", dayKey: "2026-10-26" });
    expect(nextShift(nextShift(d, CHI), CHI)).toMatchObject({ kind: "day", dayKey: "2026-10-27" });
    expect(previousShift(d, CHI)).toMatchObject({ kind: "night", dayKey: "2026-10-25" });
    expect(shiftLabel(d, CHI)).toMatch(/^Day shift · Mon, Oct 26 · 05:30–17:30$/);
  });

  it("honours custom shift times", () => {
    const d = shiftWindow("2026-10-26", "day", CHI, { dayStart: "06:00", nightStart: "18:00" });
    expect(wallClock(d.start, CHI).hour).toBe(6);
    expect(wallClock(d.end, CHI).hour).toBe(18);
  });
});

describe("buildShiftReport", () => {
  // Day shift Oct 26. Equipment E-12 with four steps; one older open task.
  const parent = mk({ id: "e12", name: "E-12", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-27", "10:00"), isSummary: true });
  const a = mk({ id: "a", name: "Set Blinds", parentId: "e12", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "08:00"), status: "completed", percentComplete: 100, durationHours: 2 });
  const b = mk({ id: "b", name: "Pull Bundle", parentId: "e12", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "14:00"), status: "in_progress", percentComplete: 50, durationHours: 6 });
  const c = mk({ id: "c", name: "Hydroblast", parentId: "e12", plannedStartAt: at("2026-10-26", "14:00"), plannedAt: at("2026-10-26", "17:00"), status: "planned", percentComplete: 0, durationHours: 3 });
  const d = mk({ id: "d", name: "Inspect", parentId: "e12", plannedStartAt: at("2026-10-26", "20:00"), plannedAt: at("2026-10-27", "10:00"), status: "planned", percentComplete: 0, durationHours: 14 });
  const old = mk({ id: "old", name: "Shutdown step", plannedStartAt: at("2026-10-25", "06:00"), plannedAt: at("2026-10-25", "10:00"), status: "blocked", statusReason: "waiting on crane", percentComplete: 0, durationHours: 4 });
  const all = [parent, a, b, c, d, old];
  const shift = shiftWindow("2026-10-26", "day", CHI);
  const report = buildShiftReport({ milestones: all, criticalIds: new Set(["c"]), tz: CHI, shift, now: shift.end });

  it("reviews the shift: done, in progress, not started, carry-over", () => {
    expect(report.review.scheduled.map((r) => r.leaf.id)).toEqual(["a", "b", "c"]);
    expect(report.review.done.map((r) => r.leaf.id)).toEqual(["a"]);
    expect(report.review.inProgress.map((r) => r.leaf.id)).toEqual(["b"]);
    expect(report.review.notStarted.map((r) => r.leaf.id)).toEqual(["c"]);
    // Carry-over = due by shift end and not done: c (critical) first, then b, plus the stale "old".
    expect(report.review.carryOver.map((r) => r.leaf.id)).toEqual(["c", "old", "b"]);
    expect(report.review.carryOver[0].critical).toBe(true);
    expect(report.review.scheduled.find((r) => r.leaf.id === "a")!.path).toEqual(["E-12"]);
  });

  it("plans the next shift: carry-overs first (critical on top), then planned work", () => {
    expect(report.next).toMatchObject({ kind: "night", dayKey: "2026-10-26" });
    expect(report.goals.all.map((r) => r.leaf.id)).toEqual(["c", "old", "b", "d"]);
    expect(report.goals.carryOver.every((r) => r.carryOver)).toBe(true);
    expect(report.goals.planned.map((r) => r.leaf.id)).toEqual(["d"]);
    expect(report.goals.critical.map((r) => r.leaf.id)).toEqual(["c"]);
  });

  it("states the overall standing against the plan at that moment", () => {
    // At 17:30 the plan expected a, b, c and the old step complete (15h of 29h) = 52%;
    // actual (duration-weighted) is a=100% (2h) + b=50% (6h) = 5h/29h = 17%.
    expect(report.overall.plannedPct).toBe(52);
    expect(report.overall.actualPct).toBe(17);
    expect(report.overall.variancePct).toBe(-35);
    expect(report.overall.standing).toBe("behind");
    expect(report.overall.stepsDone).toBe(1);
    expect(report.overall.stepsTotal).toBe(5);
    expect(report.overall.daysTotal).toBe(3);
    expect(report.overall.daysElapsed).toBe(2);
  });

  it("lists blocked work with its reason", () => {
    expect(report.blocked.map((r) => [r.leaf.id, r.reason])).toEqual([["old", "waiting on crane"]]);
  });
});

describe("opening shift", () => {
  const a = mk({ id: "a", name: "A", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "10:00") });
  const b = mk({ id: "b", name: "B", plannedStartAt: at("2026-10-28", "20:00"), plannedAt: at("2026-10-29", "02:00") });
  it("before the job starts, opens on the first shift with work", () => {
    expect(defaultReviewShift([a, b], at("2026-10-13", "15:00"), CHI)).toMatchObject({ kind: "day", dayKey: "2026-10-26" });
  });
  it("while running, opens on the shift ending now", () => {
    expect(defaultReviewShift([a, b], at("2026-10-26", "17:45"), CHI)).toMatchObject({ kind: "day", dayKey: "2026-10-26" });
    expect(defaultReviewShift([a, b], at("2026-10-27", "05:45"), CHI)).toMatchObject({ kind: "night", dayKey: "2026-10-26" });
  });
  it("after the job ends, opens on the last shift with work", () => {
    expect(defaultReviewShift([a, b], at("2026-11-20", "12:00"), CHI)).toMatchObject({ kind: "night", dayKey: "2026-10-28" });
  });
  it("skips empty shifts to the next one with work", () => {
    const from = shiftWindow("2026-10-26", "day", CHI);
    expect(nextShiftWithWork([a, b], from, CHI)).toMatchObject({ kind: "night", dayKey: "2026-10-28" });
    expect(nextShiftWithWork([a], from, CHI)).toBeNull();
  });
});
