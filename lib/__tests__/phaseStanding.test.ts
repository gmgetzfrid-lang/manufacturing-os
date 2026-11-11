import { describe, it, expect } from "vitest";
import { lateWords, phaseOfDay, phaseStandings, standingOf, standingShort, standingWords, verdictParts } from "@/lib/phaseStanding";
import { buildShiftReport, shiftWindow, DEFAULT_SHIFT_TIMES } from "@/lib/shiftReport";
import { PHASE_ATTR, type ProjectPhase } from "@/lib/projectPhases";
import type { Milestone } from "@/types/schema";

const TZ = "America/Los_Angeles";
const mk = (o: Partial<Milestone>): Milestone => ({
  orgId: "o", name: "t", weight: 1, plannedAt: "2026-10-26T18:00:00-07:00",
  status: "planned", source: "manual", createdBy: "u", ...o,
});
const inPh = (id: string) => ({ attributes: { [PHASE_ATTR]: id } });

// Two turnarounds on one budget, two weeks apart.
const phases: ProjectPhase[] = [
  { id: "p1", name: "Phase 1", start: "2026-10-24", end: "2026-10-31", share: 50 },
  { id: "p2", name: "Phase 2", start: "2026-11-07", end: "2026-11-15", share: 50 },
];
// Phase 1: both steps done, the last one 34 h after its planned finish.
// Phase 2 (Nov 10, 2 PM): one step done a day early, one a day late and
// not started, one still to come.
const steps: Milestone[] = [
  mk({ id: "a1", name: "A1", ...inPh("p1"), plannedStartAt: "2026-10-26T06:00:00-07:00", plannedAt: "2026-10-26T18:00:00-07:00", durationHours: 12, status: "completed", percentComplete: 100, actualAt: "2026-10-26T17:00:00-07:00" }),
  mk({ id: "a2", name: "A2", ...inPh("p1"), plannedStartAt: "2026-10-31T06:00:00-07:00", plannedAt: "2026-10-31T18:00:00-07:00", durationHours: 12, status: "completed", percentComplete: 100, actualAt: "2026-11-02T02:30:00-08:00" }),
  mk({ id: "b1", name: "B1", ...inPh("p2"), plannedStartAt: "2026-11-11T06:00:00-08:00", plannedAt: "2026-11-11T18:00:00-08:00", durationHours: 12, status: "completed", percentComplete: 100, actualAt: "2026-11-10T12:00:00-08:00" }),
  mk({ id: "b2", name: "B2", ...inPh("p2"), plannedStartAt: "2026-11-09T06:00:00-08:00", plannedAt: "2026-11-09T18:00:00-08:00", durationHours: 6, status: "planned", percentComplete: 0 }),
  mk({ id: "b3", name: "B3", ...inPh("p2"), plannedStartAt: "2026-11-13T06:00:00-08:00", plannedAt: "2026-11-13T18:00:00-08:00", durationHours: 12, status: "planned", percentComplete: 0 }),
];
const now = Date.parse("2026-11-10T14:00:00-08:00");
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

describe("phaseStandings", () => {
  const rows = phaseStandings(steps, phases, { now, tz: TZ });

  it("gives each phase its own line, from its own steps only", () => {
    expect(rows.map((r) => [r.name, r.steps, r.done])).toEqual([["Phase 1", 2, 2], ["Phase 2", 3, 1]]);
  });

  it("a finished phase says when it finished and how late, with no forecast", () => {
    const p1 = rows[0];
    expect(p1.state).toBe("finished");
    expect(p1.forecastFinish).toBeNull();
    // Oct 31 6:00 PM PDT to Nov 2 2:30 AM PST: 33.5 real hours (the clocks went back).
    expect(p1.lateHours).toBe(33.5);
    const w = standingWords(p1, when);
    expect(w.head).toContain("Finished");
    expect(w.head).toContain("33.5 h late");
    expect(w.tone).toBe("rose");
  });

  it("a running phase keeps both sides of its verdict", () => {
    const p2 = rows[1];
    expect(p2.state).toBe("running");
    expect(p2.aheadHours).toBe(12);   // B1 done before its plan called for it
    expect(p2.behindHours).toBe(6);   // B2 due and not started
    expect(p2.behindSteps).toBe(1);
    expect(p2.gapHours).toBe(-6);     // the net: 6 h ahead
    expect(p2.standing).toBe("ahead");
    expect(verdictParts(p2)).toBe("12 h done early, 6 h late on 1 step");
    const w = standingWords(p2, when);
    expect(w.head).toContain("6 h ahead of plan");
    expect(w.lines).toContain("12 h done early, 6 h late on 1 step");
    expect(w.lines.some((l) => l.includes("overdue"))).toBe(true);
  });

  it("the phases blended would hide the late finish and the late step", () => {
    const all = standingOf(steps, { now, tz: TZ });
    // One number for both: not finished, ahead. Neither phase reads like that alone.
    expect(all.state).toBe("running");
    expect(rows[0].state).toBe("finished");
    expect(rows[0].lateHours).toBeGreaterThan(0);
  });

  it("one phase in a few words", () => {
    expect(standingShort(rows[0])).toBe("Phase 1: finished, 33.5 h late");
    expect(standingShort(rows[1])).toMatch(/^Phase 2: \d+% \(plan \d+%\), ahead$/);
  });

  it("a phase with nothing in it has no schedule; one still to come has not started", () => {
    const three = [...phases, { id: "p3", name: "Phase 3", start: null, end: null, share: 0 }];
    const r3 = phaseStandings(steps, three, { now, tz: TZ });
    expect(r3[2].state).toBe("no schedule");
    const early = phaseStandings(steps.map((m) => ({ ...m, status: "planned" as const, percentComplete: 0, actualAt: null })), phases, { now: Date.parse("2026-10-20T08:00:00-07:00"), tz: TZ });
    expect(early.map((r) => r.state)).toEqual(["not started", "not started"]);
  });
});

describe("verdictParts / lateWords", () => {
  it("only when both sides are there", () => {
    expect(verdictParts({ aheadHours: 10, behindHours: 0, behindSteps: 0 })).toBeNull();
    expect(verdictParts({ aheadHours: 0.2, behindHours: 9, behindSteps: 3 })).toBeNull();
    expect(verdictParts({ aheadHours: 77.6, behindHours: 34.5, behindSteps: 6 })).toBe("77.6 h done early, 34.5 h late on 6 steps");
  });
  it("late, early, on time", () => {
    expect(lateWords(33.5)).toBe("33.5 h late");
    expect(lateWords(-2)).toBe("2 h early");
    expect(lateWords(0.2)).toBe("on time");
    expect(lateWords(null)).toBeNull();
  });
});

describe("phaseOfDay", () => {
  it("the phase whose dates cover the day", () => {
    expect(phaseOfDay("2026-10-28", phases, steps, TZ)?.id).toBe("p1");
    expect(phaseOfDay("2026-11-10", phases, steps, TZ)?.id).toBe("p2");
  });
  it("past a phase's own dates, and between two: the latest to have started", () => {
    expect(phaseOfDay("2026-11-02", phases, steps, TZ)?.id).toBe("p1");
    expect(phaseOfDay("2026-11-20", phases, steps, TZ)?.id).toBe("p2");
  });
  it("before any has started: the first to come", () => {
    expect(phaseOfDay("2026-10-01", phases, steps, TZ)?.id).toBe("p1");
  });
  it("a phase with no dates set goes by its own schedule", () => {
    const undated = phases.map((p) => ({ ...p, start: null, end: null }));
    expect(phaseOfDay("2026-11-10", undated, steps, TZ)?.id).toBe("p2");
    expect(phaseOfDay("2026-10-27", undated, steps, TZ)?.id).toBe("p1");
  });
  it("no phases, or one: nothing to split", () => {
    expect(phaseOfDay("2026-11-10", [], steps, TZ)).toBeNull();
    expect(phaseOfDay("2026-11-10", [phases[0]], steps, TZ)).toBeNull();
  });
});

describe("shift report standing on a project split in phases", () => {
  const shift = shiftWindow("2026-11-10", "day", TZ, DEFAULT_SHIFT_TIMES);
  it("measures where the job stands over the shift's phase only", () => {
    const blended = buildShiftReport({ milestones: steps, tz: TZ, shift, now });
    const p2ids = new Set(["b1", "b2", "b3"]);
    const own = buildShiftReport({ milestones: steps, tz: TZ, shift, now, standingIds: p2ids });
    expect(blended.overall.stepsTotal).toBe(5);
    expect(own.overall.stepsTotal).toBe(3);
    expect(own.overall.stepsDone).toBe(1);
    // Phase 1's finished work no longer lifts Phase 2's percent.
    expect(own.overall.actualPct).toBeLessThan(blended.overall.actualPct);
    const p2 = phaseStandings(steps, phases, { now, tz: TZ, shiftTimes: DEFAULT_SHIFT_TIMES })[1];
    expect(own.overall.actualPct).toBe(p2.pct);
    expect(own.overall.plannedPct).toBe(p2.planPct);
    expect(own.overall.standing).toBe(p2.standing);
  });
  it("still lists every step worked in the shift", () => {
    const own = buildShiftReport({ milestones: steps, tz: TZ, shift, now, standingIds: new Set(["a1", "a2"]) });
    expect(own.review.done.map((r) => r.leaf.id)).toContain("b1");
  });
});
