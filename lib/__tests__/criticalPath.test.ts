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
//
// Review fix pass: gaps and float are measured in WORKING time (Monday to
// Friday) — a weekly chain handed off Friday → Monday is one driving chain,
// not a path cut back to the last week — and a finished task with the latest
// planned date no longer empties the path.

import { describe, it, expect } from "vitest";
import { computeCriticalPath } from "@/lib/criticalPath";
import { afterLagMs, lagWorkingMs, workingGapMs, workingTimeMs, DAY_MS } from "@/lib/scheduleReflow";
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
    // Without the lag the same delivery genuinely has three weeks of float — 15
    // working days (21 calendar days) — and CPM says so.
    const noLag = computeCriticalPath(ms.map((m) => (m.id === "install" ? { ...m, attributes: {} } : m)));
    expect(noLag.ids.has("delivery")).toBe(false);
    expect(noLag.floatDays.get("delivery")).toBe(15);
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
    // Float in WORKING days: B2 is ready Sun 03-08 and could slip to Wed 03-11
    // (Mon, Tue); C, ready Fri 03-06, has Fri, Mon, Tue.
    expect(r.floatDays.get("B1")).toBe(2);
    expect(r.floatDays.get("B2")).toBe(2);
    expect(r.floatDays.get("C")).toBe(3);
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

  it("a weekly Mon–Fri chain (date-only, FS) is ONE driving chain: every Friday → Monday hand-off drives, zero float throughout", () => {
    const ms: Milestone[] = [
      mk({ id: "W1", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05") }),
      mk({ id: "W2", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-12"), dependsOn: ["W1"] }),
      mk({ id: "W3", plannedStartAt: d("2026-06-15"), plannedAt: d("2026-06-19"), dependsOn: ["W2"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["W1", "W2", "W3"]); // was ["W3"]: 2 calendar days of "float" at each weekend
    expect(r.floatDays.get("W1")).toBe(0);
    expect(r.floatDays.get("W2")).toBe(0);
    expect(r.floatDays.get("W3")).toBe(0);
  });

  it("an MS Project chain (Mon–Fri 08:00–17:00) handed off Fri 17:00 → Mon 08:00 is on the path end to end", () => {
    const ms: Milestone[] = [
      mk({ id: "order", plannedStartAt: "2026-06-01T08:00:00Z", plannedAt: "2026-06-05T17:00:00Z" }),
      mk({ id: "install", plannedStartAt: "2026-06-08T08:00:00Z", plannedAt: "2026-06-12T17:00:00Z", dependsOn: ["order"] }),
      mk({ id: "test", plannedStartAt: "2026-06-15T08:00:00Z", plannedAt: "2026-06-15T17:00:00Z", dependsOn: ["install"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["install", "order", "test"]); // was ["test"]: 63 calendar hours at each weekend
    // Float still counts the off-shift clock time (no project calendar): 15
    // working hours per Friday-evening-to-Monday-morning hand-off — which is
    // why a driving link is judged on its own gap, not on the float.
    expect(r.floatDays.get("install")).toBe(0.6);
    expect(r.floatDays.get("order")).toBe(1.3);
  });

  it("a genuine working day of float mid-week is still not driving (Wed finish → Fri start)", () => {
    const ms: Milestone[] = [
      mk({ id: "a", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-03") }), // Mon–Wed
      mk({ id: "b", plannedStartAt: d("2026-06-05"), plannedAt: d("2026-06-05"), dependsOn: ["a"] }), // Fri
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids]).toEqual(["b"]);
    expect(r.floatDays.get("a")).toBe(1); // Thursday
  });

  it("a completed task still carrying the latest planned date does not empty the path; a finished successor does not constrain", () => {
    const ms: Milestone[] = [
      mk({ id: "a", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-03") }),
      mk({ id: "b", plannedStartAt: d("2026-06-04"), plannedAt: d("2026-06-05"), dependsOn: ["a"] }),
      // Final inspection, done early — plan not updated; linked after b.
      mk({ id: "z", plannedStartAt: d("2026-06-15"), plannedAt: d("2026-06-19"), status: "completed", dependsOn: ["b"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["a", "b"]); // was []: the button and the Report section vanished
    expect(r.floatDays.get("a")).toBe(0);
    expect(r.floatDays.get("b")).toBe(0);
    expect(r.finish).toBe("2026-06-19T00:00:00.000Z"); // the envelope still shows the latest planned finish
    // The same with an ACTUAL finish recorded instead of the status.
    const actual = computeCriticalPath(ms.map((m) => (m.id === "z" ? { ...m, status: "in_progress" as const, actualAt: d("2026-06-05") } : m)));
    expect([...actual.ids].sort()).toEqual(["a", "b"]);
  });

  it("empty-safe", () => {
    const r = computeCriticalPath([]);
    expect(r.ids.size).toBe(0);
    expect(r.finish).toBeNull();
  });
});

describe("the working clock the critical path measures on (scheduleReflow)", () => {
  const t = (iso: string) => Date.parse(iso);
  it("stops over the weekend: Sat and Sun read as the Monday 00:00 after them", () => {
    expect(workingTimeMs(t("2026-06-06T00:00:00Z"))).toBe(workingTimeMs(t("2026-06-08T00:00:00Z")));
    expect(workingTimeMs(t("2026-06-07T13:30:00Z"))).toBe(workingTimeMs(t("2026-06-08T00:00:00Z")));
    expect(workingGapMs(t("2026-06-01T00:00:00Z"), t("2026-06-08T00:00:00Z"))).toBe(5 * DAY_MS);
  });
  it("Fri 17:00 → Mon 08:00 is 15 working hours; the gap is signed", () => {
    expect(workingGapMs(t("2026-06-05T17:00:00Z"), t("2026-06-08T08:00:00Z"))).toBe(15 * 3_600_000);
    expect(workingGapMs(t("2026-06-08T08:00:00Z"), t("2026-06-05T17:00:00Z"))).toBe(-15 * 3_600_000);
  });
  it("any seven calendar days hold five working days, wherever they start (before 1970 too)", () => {
    for (const iso of ["2026-06-03T09:15:00Z", "2026-06-06T00:00:00Z", "2026-06-07T23:59:00Z", "1969-12-31T12:00:00Z"]) {
      expect(workingGapMs(t(iso), t(iso) + 7 * DAY_MS)).toBe(5 * DAY_MS);
    }
  });
  it("lagWorkingMs is the working-clock length afterLagMs walks (a lag from any weekday or date-only ready instant; a lead from a date-only one)", () => {
    expect(lagWorkingMs(40)).toBe(5 * DAY_MS);
    expect(lagWorkingMs(-8)).toBe(-DAY_MS);
    expect(lagWorkingMs(12)).toBe(DAY_MS + 4 * 3_600_000);
    expect(lagWorkingMs(null)).toBe(0);
    for (const iso of ["2026-06-01T00:00:00Z", "2026-06-03T17:00:00Z", "2026-06-05T17:00:00Z", "2026-06-05T00:00:00Z", "2026-06-06T00:00:00Z"]) {
      for (const lag of [8, 16, 40, 120]) expect(workingGapMs(t(iso), afterLagMs(t(iso), lag))).toBe(lagWorkingMs(lag));
    }
    for (const iso of ["2026-06-01T00:00:00Z", "2026-06-05T00:00:00Z", "2026-06-06T00:00:00Z", "2026-06-10T00:00:00Z"]) {
      for (const lag of [-8, -16, -40, -120]) expect(workingGapMs(t(iso), afterLagMs(t(iso), lag))).toBe(lagWorkingMs(lag));
    }
  });
});
