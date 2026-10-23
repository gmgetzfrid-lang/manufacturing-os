import { describe, it, expect } from "vitest";
import { buildShiftReport, shiftWindow, shiftAt, nextShift, previousShift, shiftLabel, defaultReviewShift, nextShiftWithWork, workShiftOf, plannedFraction, worksIn } from "@/lib/shiftReport";
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

  it("plans the next shift: its own work; day work left over waits for the day crew", () => {
    expect(report.next).toMatchObject({ kind: "night", dayKey: "2026-10-26" });
    // Night is next: only "Inspect" (20:00 → 10:00, worked through) is night work.
    expect(report.goals.all.map((r) => r.leaf.id)).toEqual(["d"]);
    expect(report.goals.planned.map((r) => r.leaf.id)).toEqual(["d"]);
    // The day steps left unfinished are listed for the day shift — not the night's must-do.
    // The blocked "old" step isn't workable: it's under Blocked, not on anyone's list.
    expect(report.goals.otherShift.map((r) => r.leaf.id)).toEqual(["c", "b"]);
    expect(report.blocked.map((r) => r.leaf.id)).toEqual(["old"]);
    expect(report.goals.otherShift.every((r) => r.carryOver && r.work === "day")).toBe(true);
    expect(report.goals.carryOver).toEqual([]);
  });

  it("at the next day shift, the day carry-overs are its must-do, critical first", () => {
    const night = shiftWindow("2026-10-26", "night", CHI);
    const r = buildShiftReport({ milestones: all, criticalIds: new Set(["c"]), tz: CHI, shift: night, now: night.end });
    expect(r.next.kind).toBe("day");
    expect(r.goals.carryOver.map((x) => x.leaf.id)).toEqual(["c", "b"]);
    expect(r.goals.critical.map((x) => x.leaf.id)).toEqual(["c"]);
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
  // Stretch candidates for a night crew: the FOLLOWING night's work.
  const s1 = mk({ id: "s1", name: "Tomorrow night A", plannedStartAt: at("2026-10-27", "18:00"), plannedAt: at("2026-10-28", "00:00"), durationHours: 6, dependsOn: ["n1"] });
  const s2 = mk({ id: "s2", name: "Tomorrow night B", plannedStartAt: at("2026-10-28", "00:00"), plannedAt: at("2026-10-28", "05:00"), durationHours: 5, dependsOn: ["x"] });
  const dayWork = mk({ id: "dw", name: "Tomorrow day work", plannedStartAt: at("2026-10-27", "06:00"), plannedAt: at("2026-10-27", "12:00"), durationHours: 6 });
  const x = mk({ id: "x", name: "Unfinished predecessor", plannedStartAt: at("2026-10-28", "06:00"), plannedAt: at("2026-10-28", "10:00"), durationHours: 4 });
  // A big step planned earlier and far from done keeps the job "behind".
  const big = mk({ id: "big", name: "Big early step", plannedStartAt: at("2026-10-25", "06:00"), plannedAt: at("2026-10-26", "06:00"), durationHours: 24, percentComplete: 0 });
  const r = buildShiftReport({ milestones: [n1, n2, s1, s2, x, big, dayWork], tz: CHI, shift, now: shift.end });
  it("must-do carries the next shift's work plus overdue work, with hours left", () => {
    expect(r.goals.all.map((g) => g.leaf.id)).toEqual(["big", "n1", "n2"]);
    expect(r.goals.mustDoHours).toBe(24 + 4 + 2);
  });
  it("stretch lists later work whose predecessors are done or on the must-do list", () => {
    // s2 waits on x; tomorrow's DAY work is not something a night crew pulls forward.
    expect(r.goals.stretch.map((g) => g.leaf.id)).toEqual(["s1"]);
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

describe("a chain that hasn't started: everything late says so", () => {
  // Modelled on a real turnover: five steps in sequence under one parent,
  // no recorded links, no durations, nothing started by the end of day shift.
  const p = mk({ id: "sd", name: "Shutdown", plannedStartAt: at("2026-10-24", "14:00"), plannedAt: at("2026-10-26", "10:00"), isSummary: true });
  const step = (id: string, name: string, s: [string, string], f: [string, string]) =>
    mk({ id, name, parentId: "sd", plannedStartAt: at(...s), plannedAt: at(...f), weight: 1 });
  const feed = step("feed", "Pull Feed", ["2026-10-24", "14:00"], ["2026-10-24", "18:00"]);
  const cool = step("cool", "Cool Down", ["2026-10-24", "18:00"], ["2026-10-25", "00:00"]);
  const prep = step("prep", "Prep for Chem Clean", ["2026-10-25", "00:00"], ["2026-10-25", "06:00"]);
  const chem = step("chem", "Chem Cleaning", ["2026-10-25", "06:00"], ["2026-10-25", "18:00"]);
  const rinse = step("rinse", "Rinse and Drain", ["2026-10-25", "18:00"], ["2026-10-26", "02:00"]);
  const shift = shiftWindow("2026-10-25", "day", CHI);
  const r = buildShiftReport({ milestones: [p, feed, cool, prep, chem, rinse], tz: CHI, shift, now: shift.end });
  const row = (id: string) => [...r.goals.all, ...r.review.notStarted, ...r.review.carryOver].find((x) => x.leaf.id === id)!;

  it("every step past its finish is overdue — not only the one due inside the shift", () => {
    expect(["feed", "cool", "prep"].map((id) => row(id).overdue)).toEqual([true, true, true]);
  });
  it("a step past its start with nothing done is a late start, not yet overdue", () => {
    expect(row("chem").overdue).toBe(false);
    expect(row("chem").lateStart).toBe(true);
  });
  it("each step names what it is waiting on", () => {
    expect(row("chem").waitingOn.map((w) => w.id)).toEqual(["prep"]);
    expect(row("rinse").waitingOn.map((w) => w.id)).toEqual(["chem"]);
  });
  it("hours come from the planned window when the schedule has no durations", () => {
    expect(row("chem").hours).toBe(12);
    expect(row("rinse").hoursLeft).toBe(8);
  });
});

describe("the plan runs on the crew's clock — day work doesn't fall behind overnight", () => {
  // Exchanger: day-crew work Mon 06:00 → Wed 17:00, 33 h (three 11-hour days).
  const exch = mk({ id: "ex", name: "E-606 retube", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-28", "17:00"), durationHours: 33 });
  // Tower: night-crew work Mon 18:00 → Tue 05:00.
  const tower = mk({ id: "tw", name: "T-605 tray work", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-27", "05:00"), durationHours: 11 });
  // A reactor job planned round the clock: 48 h over 48 h.
  const reactor = mk({ id: "rx", name: "R-1 catalyst", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-28", "06:00"), durationHours: 48 });

  it("tells day, night and round-the-clock work apart from the times", () => {
    expect(workShiftOf(exch, CHI)).toBe("day");
    expect(workShiftOf(tower, CHI)).toBe("night");
    expect(workShiftOf(reactor, CHI)).toBe("both");
    // A step starting right at the 05:30 shift change is day work (the old import called it night).
    expect(workShiftOf(mk({ id: "e", name: "Early", plannedStartAt: at("2026-10-26", "05:30"), plannedAt: at("2026-10-26", "09:00"), shift: "night" }), CHI)).toBe("day");
    // A person can say a job runs round the clock.
    expect(workShiftOf({ ...exch, shift: "both" as Milestone["shift"] }, CHI)).toBe("both");
  });

  it("the exchanger earns no planned progress during the night", () => {
    const endOfDay = at("2026-10-26", "17:30"), endOfNight = at("2026-10-27", "05:30");
    const a = plannedFraction(exch, endOfDay, CHI), b = plannedFraction(exch, endOfNight, CHI);
    expect(b).toBeCloseTo(a, 5);              // nothing accrues overnight
    expect(a).toBeGreaterThan(0.3);
    expect(a).toBeLessThan(0.37);             // ~11.5 of ~34.5 worked hours
  });

  it("closing the night shift, a job on plan reads ON TRACK, not behind", () => {
    const night = shiftWindow("2026-10-26", "night", CHI);
    // Day crew did exactly a third of the exchanger; night crew finished the tower.
    const r = buildShiftReport({
      milestones: [{ ...exch, percentComplete: 34, status: "in_progress" }, { ...tower, percentComplete: 100, status: "completed" }],
      tz: CHI, shift: night, now: night.end,
    });
    expect(r.overall.standing).toBe("on track");
  });

  it("the night shift's list is the tower, not the exchanger", () => {
    const night = shiftWindow("2026-10-26", "night", CHI);
    expect(worksIn(exch, night, CHI)).toBe(false);
    expect(worksIn(tower, night, CHI)).toBe(true);
    const day = shiftWindow("2026-10-26", "day", CHI);
    const r = buildShiftReport({ milestones: [exch, tower], tz: CHI, shift: day, now: day.end });
    expect(r.next.kind).toBe("night");
    expect(r.goals.all.map((x) => x.leaf.id)).toEqual(["tw"]);
  });
});

describe("one answer to 'are we on time' everywhere", () => {
  it("the schedule's pace banner shows the shift report's plan by now", async () => {
    const { computeExecutionReport } = await import("@/lib/executionReport");
    const exch = mk({ id: "ex", name: "Exchanger", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-28", "17:00"), durationHours: 33, percentComplete: 34, status: "in_progress" });
    const tower = mk({ id: "tw", name: "Tower", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-27", "05:00"), durationHours: 11, percentComplete: 100, status: "completed" });
    const night = shiftWindow("2026-10-26", "night", CHI);
    const shiftRep = buildShiftReport({ milestones: [exch, tower], tz: CHI, shift: night, now: night.end });
    const pace = computeExecutionReport([exch, tower], { now: new Date(night.end), tz: CHI });
    expect(pace.expectedPct).toBe(shiftRep.overall.plannedPct);
    expect(Math.abs(pace.paceDelta)).toBeLessThan(3); // on track, not "behind pace"
  });
});
