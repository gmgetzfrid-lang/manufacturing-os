// lib/__tests__/criticalPath.test.ts
//
// PT SCH-15 / PC SCHED-10: the critical path is derived from the dependency
// links (a backward pass over the scheduled network, total float per leaf),
// not from date contiguity. The auditor's three measured failures of the
// retired heuristic are pinned here as their CPM answers: (a) a long-lead
// driver more than 14 days back is on the path when its link (with its lag)
// makes it the driver; (b) two parallel chains are not merged — the chain
// with float is off the path, and a date-contiguous task with no link is not
// pulled in; (c) a task at 90% contributes 10% of its hours to "remaining".

import { describe, it, expect } from "vitest";
import { computeCriticalPath } from "@/lib/criticalPath";
import type { Milestone } from "@/types/schema";

const mk = (o: Partial<Milestone>): Milestone => ({
  orgId: "o", name: "t", weight: 1, plannedAt: "2026-03-10T00:00:00Z",
  status: "planned", source: "manual", createdBy: "u", ...o,
});
const d = (s: string) => `${s}T00:00:00Z`;

describe("computeCriticalPath — CPM over the finish-to-start links", () => {
  it("a linked chain to the finish is the path; a finished task is not driving", () => {
    const ms: Milestone[] = [
      mk({ id: "a", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-01"), status: "completed" }),
      mk({ id: "b", plannedStartAt: d("2026-03-02"), plannedAt: d("2026-03-04"), status: "in_progress", dependsOn: ["a"] }),
      mk({ id: "c", plannedStartAt: d("2026-03-05"), plannedAt: d("2026-03-08"), status: "planned", dependsOn: ["b"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["b", "c"]);
    expect(r.ids.has("a")).toBe(false);            // done — not driving
    expect(r.finish).toBe("2026-03-08T00:00:00.000Z");
    expect(r.floatDays.get("b")).toBe(0);
    expect(r.linked).toBe(true);
  });

  it("(a) long-lead driver: a delivery three weeks before install is critical when its link's lag makes it the driver", () => {
    // Delivery done Tue 2026-02-10; a P6 lag of 3 working weeks (lag_hr_cnt 120 = 15 × 8 h);
    // install starts Wed 2026-03-04 — exactly when those 15 working days run out.
    const ms: Milestone[] = [
      mk({ id: "delivery", externalRef: "p6:1", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-02-10") }),
      mk({ id: "install", externalRef: "p6:2", plannedStartAt: d("2026-03-04"), plannedAt: d("2026-03-13"), dependsOn: ["delivery"], attributes: { source_links: "FS p6:1 +120h" } }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.ids.has("install")).toBe(true);
    expect(r.ids.has("delivery")).toBe(true);   // the heuristic dropped it (gap > 14 days)
    expect(r.floatDays.get("delivery")).toBe(0);
    // Without the lag the same delivery genuinely has 21 days of float — CPM says so.
    const noLag = computeCriticalPath(ms.map((m) => (m.id === "install" ? { ...m, attributes: {} } : m)));
    expect(noLag.ids.has("delivery")).toBe(false);
    expect(noLag.floatDays.get("delivery")).toBe(21);
    // The lag is WORKING time (PC SCHED-13): read as 120 elapsed hours (5 calendar days)
    // an install on Mon 02-16 would satisfy it and the delivery would show 16 days of float
    // in the plan above; as 15 working days it has not run out by 02-16 — negative float.
    const early = computeCriticalPath(ms.map((m) => (m.id === "install" ? { ...m, plannedStartAt: d("2026-02-16"), plannedAt: d("2026-02-25") } : m)));
    expect(early.floatDays.get("delivery")).toBeLessThan(0);
    expect(early.ids.has("delivery")).toBe(true);
  });

  it("(b) parallel chains are not merged: the chain with float is off the path; an unlinked date-contiguous task is not pulled in", () => {
    const ms: Milestone[] = [
      mk({ id: "A1", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-05") }),
      mk({ id: "A2", plannedStartAt: d("2026-03-06"), plannedAt: d("2026-03-10"), dependsOn: ["A1"] }),
      mk({ id: "B1", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-02") }),
      mk({ id: "B2", plannedStartAt: d("2026-03-03"), plannedAt: d("2026-03-07"), dependsOn: ["B1"] }),
      mk({ id: "C", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-05") }), // ends the day before A2 starts, no link
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["A1", "A2"]);
    expect(r.floatDays.get("B1")).toBe(3);
    expect(r.floatDays.get("B2")).toBe(3);
    expect(r.floatDays.get("C")).toBe(5);
    expect(r.unlinked).toBe(1);
  });

  it("(c) remaining hours count only the work left: a 100h task at 90% contributes 10h", () => {
    const ms: Milestone[] = [
      mk({ id: "x", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-10"), status: "in_progress", percentComplete: 90, durationHours: 100 }),
    ];
    expect(computeCriticalPath(ms).remainingHours).toBe(10);
  });

  it("an overnight hand-off (17:00 → next 08:00) stays on the path; a link to a phase applies to its leaves", () => {
    const ms: Milestone[] = [
      mk({ id: "weld", plannedStartAt: "2026-06-01T08:00:00Z", plannedAt: "2026-06-01T17:00:00Z" }),
      mk({ id: "P", isSummary: true, plannedStartAt: "2026-06-02T08:00:00Z", plannedAt: "2026-06-03T17:00:00Z", dependsOn: ["weld"] }),
      mk({ id: "nde", parentId: "P", plannedStartAt: "2026-06-02T08:00:00Z", plannedAt: "2026-06-02T17:00:00Z" }),
      mk({ id: "hydro", parentId: "P", plannedStartAt: "2026-06-03T08:00:00Z", plannedAt: "2026-06-03T17:00:00Z", dependsOn: ["nde"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["hydro", "nde", "weld"]);
    expect(r.ids.has("P")).toBe(false); // a summary is an envelope, never itself on the path
  });

  it("without links only the tasks ending at the finish drive it (and the count of unlinked tasks says so)", () => {
    const ms: Milestone[] = [
      mk({ id: "long", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-10") }),
      mk({ id: "short", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-02") }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids]).toEqual(["long"]);
    expect(r.linked).toBe(false);
    expect(r.unlinked).toBe(2);
  });

  it("a loop in the links is reported and left out, never followed", () => {
    const ms: Milestone[] = [
      mk({ id: "a", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-02"), dependsOn: ["b"] }),
      mk({ id: "b", plannedStartAt: d("2026-03-03"), plannedAt: d("2026-03-04"), dependsOn: ["a"] }),
      mk({ id: "z", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-10") }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.cycle?.sort()).toEqual(["a", "b"]);
    expect([...r.ids]).toEqual(["z"]);
  });

  it("empty-safe", () => {
    const r = computeCriticalPath([]);
    expect(r.ids.size).toBe(0);
    expect(r.finish).toBeNull();
  });
});
