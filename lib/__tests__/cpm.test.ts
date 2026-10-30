// The critical path from the schedule's links: what sets the finish, how
// much float everything else has, and where the work as it stands lands it.

import { describe, it, expect } from "vitest";
import { computeCpm, isLinked } from "@/lib/cpm";
import { resolveCriticalPath, effectiveCriticalMode } from "@/lib/criticalPath";
import type { Milestone } from "@/types/schema";

const UTC = "UTC";
const T0 = Date.parse("2026-10-27T06:00:00Z");
const h = (n: number) => new Date(T0 + n * 3_600_000).toISOString();
const mk = (p: Partial<Milestone> & { id: string }): Milestone =>
  ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

// A (0–10) → B (10–20) → D (20–30)        the long chain
// A        → C (10–14)  → D               C has 6 h of float
// E (0–4), alone, finishes early          26 h of float
const task = mk({ id: "t", name: "Task" });
const base = () => [
  task,
  mk({ id: "A", parentId: "t", plannedStartAt: h(0), plannedAt: h(10) }),
  mk({ id: "B", parentId: "t", plannedStartAt: h(10), plannedAt: h(20), dependsOn: ["A"] }),
  mk({ id: "C", parentId: "t", plannedStartAt: h(10), plannedAt: h(14), dependsOn: ["A"] }),
  mk({ id: "D", parentId: "t", plannedStartAt: h(20), plannedAt: h(30), dependsOn: ["B", "C"] }),
  mk({ id: "E", parentId: "t", plannedStartAt: h(0), plannedAt: h(4) }),
];

describe("critical path from the links", () => {
  it("the longest chain is critical; the rest has float", () => {
    const c = computeCpm(base(), { now: T0, tz: UTC });
    expect([...c.criticalIds].sort()).toEqual(["A", "B", "D"]);
    expect(c.steps.get("C")!.floatH).toBe(6);
    expect(c.steps.get("C")!.near).toBe(true);
    expect(c.steps.get("E")!.floatH).toBe(26);
    expect(c.steps.get("E")!.near).toBe(false);
    expect(c.slipH).toBe(0);
  });
  it("work behind moves the forecast finish, and the path with it", () => {
    // Now 12 h in: A done at 10; C not started, B only 10% — B finishes 21+9 h later.
    const ms = base().map((m) => m.id === "A" ? { ...m, status: "completed" as const, percentComplete: 100, actualStartAt: h(0), actualAt: h(10) }
      : m.id === "B" ? { ...m, status: "in_progress" as const, percentComplete: 10, actualStartAt: h(10) } : m);
    const c = computeCpm(ms, { now: T0 + 12 * 3_600_000, tz: UTC });
    // B: 9 h left from 12 → 21; D 21 → 31.
    expect(new Date(c.steps.get("B")!.ef).toISOString()).toBe(h(21));
    expect(new Date(c.forecastFinish).toISOString()).toBe(h(31));
    expect(c.slipH).toBe(1);
    expect(c.criticalIds.has("A")).toBe(false); // done work is off the path
    expect([...c.criticalIds].sort()).toEqual(["B", "D"]);
    // C can't start before now (12) → 16; it has 21 − 16 = 5 h.
    expect(c.steps.get("C")!.floatH).toBe(5);
  });
  it("a step that slips past its float becomes critical", () => {
    const ms = base().map((m) => m.id === "C" ? { ...m, plannedStartAt: h(10), plannedAt: h(22) } : m);
    const c = computeCpm(ms, { now: T0, tz: UTC });
    expect([...c.criticalIds].sort()).toEqual(["A", "C", "D"]);
    expect(c.steps.get("B")!.floatH).toBe(2);
  });
  it("start-to-start and lag", () => {
    const ms = [task,
      mk({ id: "A", parentId: "t", plannedStartAt: h(0), plannedAt: h(10) }),
      mk({ id: "B", parentId: "t", plannedStartAt: h(2), plannedAt: h(6), dependsOn: ["A"], linkTypes: { A: { type: "SS", lagHours: 2 } } }),
      mk({ id: "C", parentId: "t", plannedStartAt: h(6), plannedAt: h(16), dependsOn: ["B"] }),
    ];
    const c = computeCpm(ms, { now: T0, tz: UTC });
    // A's START drives B (start-to-start), so it's on the path too — as
    // MS Project counts it.
    expect([...c.criticalIds].sort()).toEqual(["A", "B", "C"]);
    expect(new Date(c.forecastFinish).toISOString()).toBe(h(16));
  });
  it("a link to a whole task waits on all its steps", () => {
    const ms = [...base(), mk({ id: "t2", name: "Task 2" }), mk({ id: "Z", parentId: "t2", plannedStartAt: h(30), plannedAt: h(32), dependsOn: ["t"] })];
    const c = computeCpm(ms, { now: T0, tz: UTC });
    expect(c.criticalIds.has("Z")).toBe(true);
    expect(c.criticalIds.has("D")).toBe(true);
  });
  it("a loop in the links doesn't hang it", () => {
    const ms = [task, mk({ id: "A", parentId: "t", plannedStartAt: h(0), plannedAt: h(4), dependsOn: ["B"] }), mk({ id: "B", parentId: "t", plannedStartAt: h(4), plannedAt: h(8), dependsOn: ["A"] })];
    expect(() => computeCpm(ms, { now: T0, tz: UTC })).not.toThrow();
  });
});

describe("the project's critical path - one answer", () => {
  it("is calculated from the links when the schedule is linked and nothing was chosen", () => {
    expect(isLinked(base())).toBe(true);
    expect(effectiveCriticalMode(base(), null)).toBe("links");
    const r = resolveCriticalPath(base(), null, { now: T0, tz: UTC });
    expect([...r.ids].sort()).toEqual(["A", "B", "D"]);
    expect(r.cpm?.steps.get("C")?.floatH).toBe(6);
  });
  it("marks by hand still win", () => {
    const ms = base().map((m) => m.id === "C" ? { ...m, criticalOverride: "yes" as const } : m.id === "D" ? { ...m, criticalOverride: "no" as const } : m);
    const r = resolveCriticalPath(ms, "links", { now: T0, tz: UTC });
    expect([...r.ids].sort()).toEqual(["A", "B", "C"]);
  });
  it("only what's marked, when that's the choice - the float is still known", () => {
    const r = resolveCriticalPath(base(), "none", { now: T0, tz: UTC });
    expect(r.ids.size).toBe(0);
    expect(r.cpm?.criticalIds.size).toBe(3);
  });
});

import { floatsOf } from "@/lib/criticalPath";

describe("hand marks win - the whole job Not critical, one task Critical", () => {
  // Like the Transmix-1 schedule: the turnaround marked Not critical, V-7
  // marked Critical. Whatever the setting, only V-7's work is flagged, and
  // nothing marked off the path is called near or trending to critical.
  const job = mk({ id: "job", name: "Turnaround", criticalOverride: "no" });
  const v7 = mk({ id: "v7", name: "V-7", parentId: "job", criticalOverride: "yes" });
  const e13 = mk({ id: "e13", name: "E-13", parentId: "job" });
  const ms = [job, v7, e13,
    mk({ id: "a", parentId: "v7", plannedStartAt: h(0), plannedAt: h(10) }),
    mk({ id: "b", parentId: "v7", plannedStartAt: h(10), plannedAt: h(20), dependsOn: ["a"] }),
    mk({ id: "c", parentId: "e13", plannedStartAt: h(0), plannedAt: h(14), dependsOn: [] }),
    mk({ id: "su", parentId: "job", name: "Start-up", plannedStartAt: h(20), plannedAt: h(24), dependsOn: ["b", "c"] })];
  it("only V-7, in every setting", () => {
    for (const mode of ["links", "file", "estimate", "none"] as const) {
      expect([...resolveCriticalPath(ms, mode, { now: T0, tz: UTC }).ids].sort()).toEqual(["a", "b"]);
    }
  });
  it("no near-critical or float on work marked off the path", () => {
    const r = resolveCriticalPath(ms, "none", { now: T0, tz: UTC });
    expect(r.cpm!.steps.get("c")!.floatH).toBe(6);   // the links still know it
    expect(r.near.has("c")).toBe(false);
    expect(floatsOf(r.cpm, r.off).has("c")).toBe(false);
    expect(floatsOf(r.cpm, r.off).has("a")).toBe(true);
  });
  it("with the job's mark taken off, V-7 stays Critical and E-13's float shows", () => {
    const open = ms.map((m) => (m.id === "job" ? { ...m, criticalOverride: null } : m));
    const r = resolveCriticalPath(open, "none", { now: T0, tz: UTC });
    expect([...r.ids].sort()).toEqual(["a", "b"]);
    expect(r.near.has("c")).toBe(true);
    expect(floatsOf(r.cpm, r.off).get("c")).toBe(6);
  });
});

describe("the plan's finish is the baseline's", () => {
  it("work added after the baseline moves the forecast, never the planned finish", () => {
    const baselined = base().map((m) => (m.plannedAt ? { ...m, baselineStartAt: m.plannedStartAt, baselineFinishAt: m.plannedAt } : m));
    // Found work after D, not in the baseline, planned to finish at 40.
    const found = mk({ id: "F", parentId: "t", plannedStartAt: h(30), plannedAt: h(40), dependsOn: ["D"] });
    const c = computeCpm([...baselined, found], { now: T0, tz: UTC });
    expect(c.plannedFinish).toBe(Date.parse(h(30)));
    expect(c.forecastFinish).toBe(Date.parse(h(40)));
    expect(c.slipH).toBe(10);
    // Without a baseline: the latest planned finish, as before.
    expect(computeCpm([...base(), found], { now: T0, tz: UTC }).plannedFinish).toBe(Date.parse(h(40)));
  });
});
