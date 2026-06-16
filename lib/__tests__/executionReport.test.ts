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

  it("flags overdue: incomplete tasks past their finish", () => {
    const r = computeExecutionReport(tree, { now }); // now = Mar 2 noon
    // 'b' (Mar 2 00:00, blocked) is past due; 'c' (Mar 3) is not.
    expect(r.overdue).toBe(1);
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
  });
});
