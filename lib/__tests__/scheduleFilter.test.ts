import { describe, it, expect } from "vitest";
import { filterMilestones, EMPTY_FILTER, isFilterActive, type ScheduleFilter } from "@/lib/scheduleFilter";
import type { Milestone } from "@/types/schema";

const mk = (o: Partial<Milestone>): Milestone => ({
  orgId: "o", name: "t", weight: 1, plannedAt: "2026-03-10T00:00:00Z",
  status: "planned", source: "manual", createdBy: "u", ...o,
});

// Phase P → tasks a (Unit 12, blocked, WO-44821) and b (Unit 7, done).
const tree: Milestone[] = [
  mk({ id: "P", name: "Phase 1", isSummary: true, plannedAt: "2026-03-05T00:00:00Z" }),
  mk({ id: "a", name: "Pull feed", parentId: "P", location: "Unit 12", workOrderRef: "WO-44821", status: "blocked", plannedAt: "2026-03-02T00:00:00Z" }),
  mk({ id: "b", name: "Swap valve", parentId: "P", location: "Unit 7", status: "completed", plannedAt: "2026-03-04T00:00:00Z" }),
];

const f = (o: Partial<ScheduleFilter>): ScheduleFilter => ({ ...EMPTY_FILTER, ...o });

describe("filterMilestones", () => {
  const now = Date.parse("2026-03-10T00:00:00Z");

  it("returns everything when inactive", () => {
    expect(filterMilestones(tree, EMPTY_FILTER).size).toBe(3);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it("free-text matches name/location/WO and keeps the parent in context", () => {
    const r = filterMilestones(tree, f({ query: "WO-44821" }), { now });
    expect(r.has("a")).toBe(true);
    expect(r.has("P")).toBe(true);   // ancestor kept
    expect(r.has("b")).toBe(false);
  });

  it("matching a phase shows its descendants", () => {
    const r = filterMilestones(tree, f({ query: "phase 1" }), { now });
    expect(r.has("P")).toBe(true);
    expect(r.has("a")).toBe(true);   // descendant pulled in
    expect(r.has("b")).toBe(true);
  });

  it("space-separated terms are AND", () => {
    expect(filterMilestones(tree, f({ query: "pull feed" }), { now }).has("a")).toBe(true);
    expect(filterMilestones(tree, f({ query: "pull valve" }), { now }).has("a")).toBe(false);
  });

  it("status filter", () => {
    const r = filterMilestones(tree, f({ statuses: ["completed"] }), { now });
    expect(r.has("b")).toBe(true);
    expect(r.has("a")).toBe(false);
  });

  it("blockedOnly catches on-hold and blocked", () => {
    const r = filterMilestones(tree, f({ blockedOnly: true }), { now });
    expect(r.has("a")).toBe(true);
    expect(r.has("b")).toBe(false);
  });

  it("overdueOnly: incomplete & past finish", () => {
    const r = filterMilestones(tree, f({ overdueOnly: true }), { now });
    expect(r.has("a")).toBe(true);   // blocked, Mar 2 < now
    expect(r.has("b")).toBe(false);  // completed
  });

  it("group filter restricts to a top-level group", () => {
    const r = filterMilestones(tree, f({ groupIds: ["P"] }), { now });
    expect(r.has("a")).toBe(true);
    expect(r.has("b")).toBe(true);
    const none = filterMilestones(tree, f({ groupIds: ["nope"] }), { now });
    expect(none.size).toBe(0);
  });

  it("shift filter restricts to the chosen shift(s)", () => {
    const shifted: Milestone[] = [
      mk({ id: "day", name: "Day task", shift: "day", plannedAt: "2026-03-02T00:00:00Z" }),
      mk({ id: "night", name: "Night task", shift: "night", plannedAt: "2026-03-02T00:00:00Z" }),
    ];
    const r = filterMilestones(shifted, f({ shifts: ["night"] }), { now });
    expect(r.has("night")).toBe(true);
    expect(r.has("day")).toBe(false);
  });
});
