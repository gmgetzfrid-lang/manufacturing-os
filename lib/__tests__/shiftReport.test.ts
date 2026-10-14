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

describe("review lists reflect what actually happened, not only the plan", () => {
  const shift = shiftWindow("2026-10-26", "day", CHI);
  const early = mk({ id: "early", name: "Done early", plannedStartAt: at("2026-10-27", "06:00"), plannedAt: at("2026-10-27", "10:00"), status: "completed", percentComplete: 100, actualAt: new Date(at("2026-10-26", "15:00")).toISOString() });
  const openElsewhere = mk({ id: "open", name: "Open from yesterday", plannedStartAt: at("2026-10-25", "06:00"), plannedAt: at("2026-10-25", "10:00"), status: "in_progress", percentComplete: 40 });
  const planned = mk({ id: "p", name: "Planned today", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "12:00"), status: "in_progress", percentComplete: 10 });
  const r = buildShiftReport({ milestones: [early, openElsewhere, planned], tz: CHI, shift, now: shift.end });
  it("counts a step completed during the shift even if it was scheduled for later", () => {
    expect(r.review.done.map((x) => x.leaf.id)).toEqual(["early"]);
    expect(r.review.done[0].offSchedule).toBe(true);
    expect(r.review.scheduled.map((x) => x.leaf.id)).toEqual(["p"]);
  });
  it("lists all open work, this shift's first, then open work from other slots", () => {
    expect(r.review.inProgress.map((x) => x.leaf.id)).toEqual(["p", "open"]);
    expect(r.review.inProgress[1].offSchedule).toBe(true);
    expect(r.review.inProgress[1].carryOver).toBe(true);
  });
});

describe("must-do vs stretch", () => {
  // Day shift Oct 26 closing; night shift is next. Two steps planned for
  // the night (must-do), two for the following day shift (stretch
  // candidates), one of which waits on an unfinished predecessor.
  const shift = shiftWindow("2026-10-26", "day", CHI);
  const n1 = mk({ id: "n1", name: "Night step 1", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-26", "22:00"), durationHours: 4 });
  const n2 = mk({ id: "n2", name: "Night step 2", plannedStartAt: at("2026-10-26", "22:00"), plannedAt: at("2026-10-27", "02:00"), durationHours: 4, percentComplete: 50, status: "in_progress" });
  const s1 = mk({ id: "s1", name: "Tomorrow A", plannedStartAt: at("2026-10-27", "06:00"), plannedAt: at("2026-10-27", "12:00"), durationHours: 6, dependsOn: ["n1"] });
  const s2 = mk({ id: "s2", name: "Tomorrow B", plannedStartAt: at("2026-10-27", "12:00"), plannedAt: at("2026-10-27", "18:00"), durationHours: 6, dependsOn: ["x"] });
  const x = mk({ id: "x", name: "Unfinished predecessor", plannedStartAt: at("2026-10-28", "06:00"), plannedAt: at("2026-10-28", "10:00"), durationHours: 4 });
  // A big step planned earlier and far from done keeps the job "behind".
  const big = mk({ id: "big", name: "Big early step", plannedStartAt: at("2026-10-25", "06:00"), plannedAt: at("2026-10-26", "06:00"), durationHours: 24, percentComplete: 0 });
  const r = buildShiftReport({ milestones: [n1, n2, s1, s2, x, big], tz: CHI, shift, now: shift.end });
  it("must-do carries the next shift's work plus overdue work, with hours left", () => {
    expect(r.goals.all.map((g) => g.leaf.id)).toEqual(["big", "n1", "n2"]);
    expect(r.goals.mustDoHours).toBe(24 + 4 + 2);
  });
  it("stretch lists later work whose predecessors are done or on the must-do list", () => {
    expect(r.goals.stretch.map((g) => g.leaf.id)).toEqual(["s1"]); // s2 waits on x
  });
  it("says how far behind in hours and where stretch closes the gap", () => {
    expect(r.goals.gapHours).toBeGreaterThan(0);
    // Behind by the whole un-started "big" step (24 h of 48 h total → 50 pts ≈ 24 h);
    // a 6 h stretch item can't close that alone.
    expect(r.goals.backOnTrackAt).toBeNull();
    const small = mk({ id: "small", name: "Small early", plannedStartAt: at("2026-10-25", "06:00"), plannedAt: at("2026-10-26", "06:00"), durationHours: 4, percentComplete: 0 });
    const r2 = buildShiftReport({ milestones: [n1, n2, s1, x, small], tz: CHI, shift, now: shift.end });
    expect(r2.goals.gapHours).toBeGreaterThan(0);
    expect(r2.goals.backOnTrackAt).toBe(1);
  });
});

describe("the plan is held against the baseline once one is captured", () => {
  const shift = shiftWindow("2026-10-26", "day", CHI);
  // Planned (and baselined) for the day shift, 8 h, not started, then
  // dragged two days later. Without a baseline the slip vanishes from
  // "plan said by now"; with one it stays visible.
  const slippedNoBase = mk({ id: "s", name: "Slipped", plannedStartAt: at("2026-10-28", "08:00"), plannedAt: at("2026-10-28", "16:00"), durationHours: 8 });
  const slippedWithBase = { ...slippedNoBase, baselineStartAt: new Date(at("2026-10-26", "08:00")).toISOString(), baselineFinishAt: new Date(at("2026-10-26", "16:00")).toISOString() } as Milestone;
  const other = mk({ id: "o", name: "Other", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "16:00"), durationHours: 8, status: "completed", percentComplete: 100 });
  it("without a baseline, moving the task later makes the plan follow it", () => {
    const r = buildShiftReport({ milestones: [slippedNoBase, other], tz: CHI, shift, now: shift.end });
    expect(r.overall.planBasis).toBe("current");
    expect(r.overall.plannedPct).toBe(50); // only "other" was expected by now
    expect(r.overall.standing).toBe("on track");
  });
  it("with a baseline, the slip stays on the books", () => {
    const r = buildShiftReport({ milestones: [slippedWithBase, { ...other, baselineStartAt: other.plannedStartAt, baselineFinishAt: other.plannedAt } as Milestone], tz: CHI, shift, now: shift.end });
    expect(r.overall.planBasis).toBe("baseline");
    expect(r.overall.plannedPct).toBe(100); // both were expected done by now
    expect(r.overall.actualPct).toBe(50);
    expect(r.overall.standing).toBe("behind");
    expect(r.goals.gapHours).toBe(8);
  });
  it("reports when the yardstick was set (latest baseline stamp), none without a baseline", () => {
    const stamped = { ...slippedWithBase, baselineSetAt: "2026-10-23T12:00:00.000Z" } as Milestone;
    const later = { ...other, baselineStartAt: other.plannedStartAt, baselineFinishAt: other.plannedAt, baselineSetAt: "2026-10-24T05:30:00.000Z" } as Milestone;
    expect(buildShiftReport({ milestones: [stamped, later], tz: CHI, shift, now: shift.end }).overall.baselineSetAt).toBe("2026-10-24T05:30:00.000Z");
    expect(buildShiftReport({ milestones: [slippedNoBase, other], tz: CHI, shift, now: shift.end }).overall.baselineSetAt).toBeNull();
  });
});
