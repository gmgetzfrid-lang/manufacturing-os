import { describe, it, expect } from "vitest";
import { computeExecutionReport } from "@/lib/executionReport";
import type { Milestone } from "@/types/schema";

const mk = (o: Partial<Milestone>): Milestone => ({
  orgId: "o", name: "t", weight: 1, plannedAt: "2026-03-10T00:00:00Z",
  status: "planned", source: "manual", createdBy: "u", ...o,
});

// Phase P with three 1-day leaves; one done, one blocked, one planned.
const tree: Milestone[] = [
  mk({ id: "P", name: "Phase", isSummary: true, plannedStartAt: "2026-03-01T00:00:00Z", plannedAt: "2026-03-03T00:00:00Z" }),
  mk({ id: "a", name: "A", parentId: "P", plannedStartAt: "2026-03-01T00:00:00Z", plannedAt: "2026-03-01T00:00:00Z", status: "completed", durationHours: 8, responsibleKind: "contractor", responsibleParty: "Acme", actualKind: "employee", actualParty: "In-house crew" }),
  mk({ id: "b", name: "B", parentId: "P", plannedStartAt: "2026-03-02T00:00:00Z", plannedAt: "2026-03-02T00:00:00Z", status: "blocked", statusReason: "waiting on crane", durationHours: 4 }),
  mk({ id: "c", name: "C", parentId: "P", plannedStartAt: "2026-03-03T00:00:00Z", plannedAt: "2026-03-03T00:00:00Z", status: "planned", durationHours: 4 }),
];

describe("computeExecutionReport", () => {
  const now = new Date("2026-03-02T12:00:00Z");

  it("counts leaves by status (summary excluded)", () => {
    const r = computeExecutionReport(tree, { now });
    expect(r.totalLeaves).toBe(3);
    expect(r.done).toBe(1);
    expect(r.blocked).toBe(1);
    expect(r.planned).toBe(1);
    // Effort-weighted: 'a' (8h, done) of 16h total = 50% (not a flat 1/3 count).
    expect(r.pctComplete).toBe(50);
  });

  it("rolls up planned vs earned hours", () => {
    const r = computeExecutionReport(tree, { now });
    expect(r.plannedHours).toBe(16);
    expect(r.earnedHours).toBe(8);    // only 'a' is done
    expect(r.pctHours).toBe(50);
  });

  it("counts PARTIAL progress, not just fully-done tasks", () => {
    // Two 10h leaves, each 50% done → 50% complete, 10 earned hours.
    const partial: Milestone[] = [
      mk({ id: "a", name: "A", plannedAt: "2026-03-01T00:00:00Z", status: "in_progress", percentComplete: 50, durationHours: 10 }),
      mk({ id: "b", name: "B", plannedAt: "2026-03-02T00:00:00Z", status: "in_progress", percentComplete: 50, durationHours: 10 }),
    ];
    const r = computeExecutionReport(partial, { now });
    expect(r.done).toBe(0);           // neither is fully complete…
    expect(r.pctComplete).toBe(50);   // …but half the work is earned
    expect(r.earnedHours).toBe(10);
    expect(r.pctHours).toBe(50);
  });

  it("flags overdue by UTC day (PT SCH-5): due TODAY is not overdue; due yesterday is", () => {
    // now = Mar 2 noon. 'b' (due Mar 2, blocked) is due today — not overdue
    // (the old `finish < now` rule marked it overdue from 00:01 on its own
    // due date); 'c' (Mar 3) is not either.
    expect(computeExecutionReport(tree, { now }).overdue).toBe(0);
    // Mar 3 00:00 UTC: 'b' is a day late; 'c' is due today.
    expect(computeExecutionReport(tree, { now: new Date("2026-03-03T00:00:00Z") }).overdue).toBe(1);
  });

  it("computes pace vs expected", () => {
    const r = computeExecutionReport(tree, { now });
    expect(r.totalDays).toBe(3);
    expect(typeof r.paceDelta).toBe("number");
    expect(typeof r.forecastFinish === "string" || r.forecastFinish === null).toBe(true);
  });

  it("collects blockers with their reasons and group", () => {
    const r = computeExecutionReport(tree, { now });
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0]).toMatchObject({ name: "B", status: "blocked", reason: "waiting on crane", group: "Phase" });
  });

  it("reports performer split + plan deviations", () => {
    const r = computeExecutionReport(tree, { now });
    expect(r.performers.byActualKind).toMatchObject({ employee: 1 });
    expect(r.performers.deviations).toHaveLength(1);
    expect(r.performers.deviations[0]).toMatchObject({ planned: "Acme", actual: "In-house crew" });
  });

  it("produces a per-group rollup", () => {
    const r = computeExecutionReport(tree, { now });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ name: "Phase", total: 3, done: 1, blocked: 1, pctComplete: 50 });
  });

  it("handles an all-leaf (flat) schedule with no groups nesting", () => {
    const flat = [
      mk({ id: "x", name: "X", plannedAt: "2026-03-01T00:00:00Z", status: "completed" }),
      mk({ id: "y", name: "Y", plannedAt: "2026-03-02T00:00:00Z", status: "planned" }),
    ];
    const r = computeExecutionReport(flat, { now });
    expect(r.totalLeaves).toBe(2);
    expect(r.done).toBe(1);
    expect(r.groups).toHaveLength(2); // each top-level leaf is its own group
  });

  it("is empty-safe", () => {
    const r = computeExecutionReport([], { now });
    expect(r.totalLeaves).toBe(0);
    expect(r.pctComplete).toBe(0);
    expect(r.groups).toEqual([]);
    expect(r.blockers).toEqual([]);
  });

  // PC SCHED-14 / SCHED-2 dw3: the basis is chosen once and reported; the
  // Work-hours figure is null (not pctComplete in disguise) with no hours.
  it("reports its weighting basis; pctHours is null when no leaf carries hours", () => {
    expect(computeExecutionReport(tree, { now }).weightBasis).toBe("hours"); // every leaf has hours
    const mixed = [
      mk({ id: "x", name: "X", plannedAt: "2026-03-01T00:00:00Z", status: "completed", durationHours: 40 }),
      mk({ id: "y", name: "Y", plannedAt: "2026-03-02T00:00:00Z", status: "planned" }),
    ];
    const r = computeExecutionReport(mixed, { now });
    expect(r.weightBasis).toBe("weight");
    expect(r.pctComplete).toBe(50);          // 1 of 2 on the uniform basis — the blend read 98
    expect(r.leavesWithHours).toBe(1);
    const none = computeExecutionReport([mk({ id: "z", name: "Z", status: "completed" })], { now });
    expect(none.plannedHours).toBe(0);
    expect(none.pctHours).toBeNull();
  });

  // PC SCHED-12 limb b: the forecast is the completion RATE carried forward —
  // named, and withheld below 10% of tasks done (it used to print the
  // planned finish as the "forecast" when nothing was done).
  it("forecast: withheld below 10% done, otherwise at the current rate of N tasks/day", () => {
    const many = (done: number) => Array.from({ length: 20 }, (_, i) => mk({
      id: `t${i}`, name: `T${i}`, plannedStartAt: "2026-03-01T00:00:00Z", plannedAt: "2026-03-20T00:00:00Z",
      status: i < done ? "completed" : "planned",
    }));
    const at = new Date("2026-03-11T00:00:00Z"); // 10 days in
    const early = computeExecutionReport(many(1), { now: at }); // 5%
    expect(early.forecastBasis).toBe("too-early");
    expect(early.forecastFinish).toBeNull();
    expect(early.forecastRatePerDay).toBeNull();
    const going = computeExecutionReport(many(4), { now: at }); // 20%: 4 tasks / 10 days
    expect(going.forecastBasis).toBe("rate");
    expect(going.forecastRatePerDay).toBeCloseTo(0.4);
    expect(going.forecastFinish).toBe("2026-04-20T00:00:00.000Z"); // 16 left / 0.4 a day = 40 days after Mar 11
    const done = computeExecutionReport(many(20), { now: at });
    expect(done.forecastBasis).toBe("complete");
    expect(done.forecastFinish).toBe("2026-03-20T00:00:00.000Z");
  });

  describe("baseline drift", () => {
    const now = new Date("2026-03-10T00:00:00Z");
    it("is null without a baseline", () => {
      const r = computeExecutionReport(tree, { now });
      expect(r.baseline).toBeNull();
    });
    it("reports slip when current finish is past baseline", () => {
      const withBl: Milestone[] = [
        mk({ id: "a", name: "A", plannedAt: "2026-03-05T00:00:00Z", baselineFinishAt: "2026-03-02T00:00:00Z", status: "planned" }),
        mk({ id: "b", name: "B", plannedAt: "2026-03-04T00:00:00Z", baselineFinishAt: "2026-03-04T00:00:00Z", status: "planned" }),
      ];
      const r = computeExecutionReport(withBl, { now });
      expect(r.baseline).not.toBeNull();
      expect(r.baseline!.slipped).toBe(1);          // A moved 3 days late
      expect(r.baseline!.finishDriftDays).toBe(1);  // env: max cur Mar5 vs max bl Mar4 = +1
      expect(r.baseline!.worstSlips[0]).toMatchObject({ name: "A", days: 3 });
    });
    // PT SAF-7: drift against ANY captured baseline, not only the live one.
    it("measures against an older capture when one is chosen", () => {
      const withBl: Milestone[] = [
        mk({ id: "a", name: "A", plannedAt: "2026-03-05T00:00:00Z", baselineFinishAt: "2026-03-05T00:00:00Z", status: "planned" }),
      ];
      expect(computeExecutionReport(withBl, { now }).baseline!.finishDriftDays).toBe(0); // live: re-baselined, drift gone
      const older = new Map([["a", "2026-01-04T00:00:00Z"]]);
      const r = computeExecutionReport(withBl, { now, baselineFinishById: older });
      expect(r.baseline!.finishDriftDays).toBe(60);                                         // the original plan: 60 days late
      expect(r.baseline!.worstSlips[0]).toMatchObject({ name: "A", days: 60 });
    });
  });
});
