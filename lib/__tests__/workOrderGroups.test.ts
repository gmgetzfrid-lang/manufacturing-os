// Work orders: one per WO number, with every step under it.

import { describe, it, expect } from "vitest";
import { workOrderGroupsOf } from "@/lib/workOrderGroups";
import type { Milestone } from "@/types/schema";

const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone => ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const kidsOf = (ms: Milestone[]) => {
  const m = new Map<string, Milestone[]>();
  for (const x of ms) if (x.parentId) m.set(x.parentId, [...(m.get(x.parentId) ?? []), x]);
  return m;
};

describe("one work order per WO number", () => {
  it("the WO copied down onto steps: still one work order, named for its equipment", () => {
    const ms = [
      mk({ id: "v1", name: "V-01 - Tower", workOrderRef: "304528" }),
      mk({ id: "s1", parentId: "v1", name: "Open", workOrderRef: "304528" }),
      mk({ id: "s2", parentId: "v1", name: "Clean", workOrderRef: "304528" }),
      mk({ id: "s3", parentId: "v1", name: "Inspect" }),
    ];
    const g = [...workOrderGroupsOf(ms, kidsOf(ms)).values()];
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ wo: "304528" });
    expect(g[0].owner.id).toBe("v1");
    expect(g[0].steps.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
  });
  it("steps with no WO under a task whose sub-tasks all carry one number join that work order", () => {
    const ms = [
      mk({ id: "pd", name: "Pulsation Dampeners" }),
      mk({ id: "pd1", parentId: "pd", name: "PD-1", workOrderRef: "310337" }),
      mk({ id: "pd1a", parentId: "pd1", name: "Reinstall PD-1" }),
      mk({ id: "pd2", parentId: "pd", name: "PD-2", workOrderRef: "310337" }),
      mk({ id: "pd2a", parentId: "pd2", name: "Reinstall PD-2" }),
      mk({ id: "weld", parentId: "pd", name: "Weld supports" }),
    ];
    const g = [...workOrderGroupsOf(ms, kidsOf(ms)).values()];
    expect(g).toHaveLength(1);
    expect(g[0].wo).toBe("310337");
    expect(g[0].steps.map((s) => s.id).sort()).toEqual(["pd1a", "pd2a", "weld"]);
  });
  it("several WO numbers under the task: its no-WO steps stay apart", () => {
    const ms = [
      mk({ id: "pd", name: "Pulsation Dampeners" }),
      mk({ id: "pd1", parentId: "pd", name: "PD-1", workOrderRef: "310337" }),
      mk({ id: "pd1a", parentId: "pd1", name: "Reinstall PD-1" }),
      mk({ id: "pd2", parentId: "pd", name: "PD-2", workOrderRef: "310338" }),
      mk({ id: "pd2a", parentId: "pd2", name: "Reinstall PD-2" }),
      mk({ id: "weld", parentId: "pd", name: "Weld supports" }),
    ];
    const g = [...workOrderGroupsOf(ms, kidsOf(ms)).values()];
    expect(g.map((x) => x.wo).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["310337", "310338", null]);
  });
  it("one number on two pieces of equipment: one work order, the other named too", () => {
    const ms = [
      mk({ id: "a", name: "P-1 - Pump", workOrderRef: "300001" }),
      mk({ id: "a1", parentId: "a", name: "Pull pump" }),
      mk({ id: "b", name: "P-2 - Pump", workOrderRef: "300001" }),
      mk({ id: "b1", parentId: "b", name: "Pull pump" }),
    ];
    const g = [...workOrderGroupsOf(ms, kidsOf(ms)).values()];
    expect(g).toHaveLength(1);
    expect(g[0].steps).toHaveLength(2);
    expect(g[0].also?.map((x) => x.id)).toEqual(["b"]);
  });
});

import { splitPlacements } from "@/lib/calendarPlacement";
import { buildShiftReport, shiftWindow, rowTask } from "@/lib/shiftReport";
import { woOf, taskWorkOrder } from "@/lib/workOrderCrew";

// The LRU schedule's shape: a folder of PSVs (each its own WO), a folder
// of single-step work orders, E-02 with its WO on the task and two other
// WOs set under it, and an added step with a WO of its own.
const at = (h: number) => new Date(Date.parse("2026-11-02T06:00:00-08:00") + h * 3_600_000).toISOString();
const step = (p: Partial<Milestone> & { id: string; name: string }) => mk({ plannedStartAt: at(1), plannedAt: at(3), ...p });
const lru = [
  mk({ id: "psvs", name: "PSVs", plannedStartAt: at(0), plannedAt: at(10) }),
  step({ id: "psv209", parentId: "psvs", name: "PSV-209 - E-27 Propane Condenser Pressure Relief", workOrderRef: "310735" }),
  step({ id: "psv210", parentId: "psvs", name: "PSV-210 - V-12B Discharge Bottle Pressure Relief", workOrderRef: "310728" }),
  mk({ id: "e02", name: "E-02 - De-Butanizer Condenser", workOrderRef: "310456", plannedStartAt: at(0), plannedAt: at(10) }),
  step({ id: "e02a", parentId: "e02", name: "Pull Bundle", workOrderRef: "310456" }),
  step({ id: "e02b", parentId: "e02", name: "Hydroblast" }),
  step({ id: "e02x", parentId: "e02", name: "Replace the Shell Bottom 90 Elbow", workOrderRef: "310458" }),
  step({ id: "e02d", parentId: "e02", name: "Weld repair", workOrderRef: "399999", attributes: { discovery: JSON.stringify({ id: "d", what: "crack", kind: "discovery" }) } }),
  mk({ id: "pd", name: "LRU Compressor Pulsation Dampeners", plannedStartAt: at(0), plannedAt: at(10) }),
  step({ id: "pd1", parentId: "pd", name: "Re-Install V-12A", workOrderRef: "304528" }),
  step({ id: "pd2", parentId: "pd", name: "Re-Install V-12B", workOrderRef: "304528" }),
  step({ id: "pd3", parentId: "pd", name: "Set Blinds; Verify LOTO" }),
  step({ id: "pd4", parentId: "pd", name: "Pull V-12A - 2nd Stage Suction Bottle", workOrderRef: "310661" }),
  // E-12: its WO typed on each step, not on the task - one work order.
  mk({ id: "e12", name: "E-12 Exchanger", plannedStartAt: at(0), plannedAt: at(10) }),
  step({ id: "e12a", parentId: "e12", name: "Open", workOrderRef: "301502" }),
  step({ id: "e12b", parentId: "e12", name: "Close", workOrderRef: "301502" }),
];
const kidsLru = kidsOf(lru);

describe("calendar: one card per work order", () => {
  const byId = new Map(lru.map((m) => [m.id!, m]));
  const woUp = (g: Milestone) => { for (let x: Milestone | undefined = g; x; x = x.parentId ? byId.get(x.parentId) : undefined) { const w = taskWorkOrder(x, (id) => kidsLru.get(id) ?? []); if (w) return w; } return ""; };
  const own = (s: Milestone, g: Milestone) => !!woOf(s) && !s.attributes?.discovery && woOf(s) !== woUp(g);
  const { chips, apart } = splitPlacements(lru, kidsLru, false, own);
  const ids = chips.map((c) => c.id);
  it("a folder of work orders is no card; each PSV is its own", () => {
    expect(ids).not.toContain("psvs");
    expect(ids).toEqual(expect.arrayContaining(["psv209", "psv210"]));
  });
  it("E-02 is one card for its own steps (the added one too); the WO set under it is its own card", () => {
    expect(ids).toContain("e02");
    expect(ids).toContain("e02x");
    expect(apart.has("e02a") || apart.has("e02b") || apart.has("e02d")).toBe(false);
    expect(ids).not.toContain("e02a");
  });
  it("a folder holding no-WO steps keeps its card for those; its WO steps stand alone", () => {
    expect(ids).toEqual(expect.arrayContaining(["pd", "pd1", "pd2", "pd4"]));
    expect(apart.has("pd3")).toBe(false);
  });
  it("a task with one WO typed on all its steps is one card", () => {
    expect(ids).toContain("e12");
    expect(ids).not.toContain("e12a");
  });
  it("without the rule (old callers): the bottom groups as before", () => {
    expect(splitPlacements(lru, kidsLru, false).chips.map((c) => c.id)).toEqual(["psvs", "e02", "pd", "e12"]);
  });
});

describe("report: each step listed under its work order", () => {
  const r = buildShiftReport({ milestones: lru, tz: "America/Los_Angeles", times: { dayStart: "06:00", nightStart: "18:00" }, shift: shiftWindow("2026-11-01", "night", "America/Los_Angeles", { dayStart: "06:00", nightStart: "18:00" }), now: Date.parse(at(-0.5)) });
  const rows = [...r.goals.all, ...r.goals.otherShift, ...r.goals.movedOff, ...r.goals.paused];
  const unit = (id: string) => rowTask(rows.find((x) => x.leaf.id === id)!);
  it("a PSV in the PSVs folder stands alone; the folder is never a heading", () => {
    expect(unit("psv209")).toBeNull();
    expect(rows.some((x) => rowTask(x)?.name === "PSVs")).toBe(false);
  });
  it("E-02's steps (and its added work) under E-02; the WO set under it alone", () => {
    expect(unit("e02a")?.name).toBe("E-02 - De-Butanizer Condenser");
    expect(unit("e02b")?.name).toBe("E-02 - De-Butanizer Condenser");
    expect(unit("e02d")?.name).toBe("E-02 - De-Butanizer Condenser");
    expect(unit("e02x")).toBeNull();
  });
  it("steps of their own on one WO number share it; no-WO steps stay with their task", () => {
    expect(unit("pd1")).toEqual({ id: "wo:304528", name: "WO 304528" });
    expect(unit("pd2")).toEqual({ id: "wo:304528", name: "WO 304528" });
    expect(unit("pd3")?.name).toBe("LRU Compressor Pulsation Dampeners");
    expect(unit("pd4")).toBeNull();
  });
  it("E-12, its WO on each step: listed under E-12", () => {
    expect(unit("e12a")?.name).toBe("E-12 Exchanger");
  });
});

describe("work orders list: a task with its WO typed on each step", () => {
  it("is one card, named for the task", () => {
    const g = [...workOrderGroupsOf(lru, kidsLru).values()];
    const e12 = g.find((x) => x.wo === "301502");
    expect(e12?.owner.id).toBe("e12");
    expect(e12?.also).toBeUndefined();
    expect(e12?.steps.map((s) => s.id).sort()).toEqual(["e12a", "e12b"]);
    // Each PSV still its own card; E-02's nested WO its own.
    expect(g.find((x) => x.wo === "310735")?.owner.id).toBe("psv209");
    expect(g.find((x) => x.wo === "310458")?.owner.id).toBe("e02x");
  });
});

describe("a folder of work orders isn't a sequence", () => {
  it("PSV-210 doesn't wait on PSV-209; E-02's steps still run in order", () => {
    const seq = lru.map((m) => (m.id === "psv210" || m.id === "e02b" ? { ...m, plannedStartAt: at(4), plannedAt: at(6) } : m));
    const t = { dayStart: "06:00", nightStart: "18:00" };
    const r = buildShiftReport({ milestones: seq, tz: "America/Los_Angeles", times: t, shift: shiftWindow("2026-11-01", "night", "America/Los_Angeles", t), now: Date.parse(at(-0.5)) });
    const rows = [...r.goals.all, ...r.goals.otherShift, ...r.goals.movedOff, ...r.goals.paused];
    expect(rows.find((x) => x.leaf.id === "psv210")?.waitingOn).toEqual([]);
    expect(rows.find((x) => x.leaf.id === "e02b")?.waitingOn.length).toBeGreaterThan(0);
  });
});

describe("a folder holding one work order", () => {
  it("is still a folder: the work order is the heading, not 'Work Orders'", () => {
    const ms = [
      mk({ id: "wos", name: "Work Orders" }),
      mk({ id: "fg", name: "Clean fuel gas header", parentId: "wos", workOrderRef: "311388" }),
      mk({ id: "fg1", name: "Hydroblast piping", parentId: "fg", plannedStartAt: at(1), plannedAt: at(3) }),
    ];
    const k = kidsOf(ms);
    expect(taskWorkOrder(ms[0], (id) => k.get(id) ?? [])).toBe("");
    const t = { dayStart: "06:00", nightStart: "18:00" };
    const r = buildShiftReport({ milestones: ms, tz: "America/Los_Angeles", times: t, shift: shiftWindow("2026-11-01", "night", "America/Los_Angeles", t), now: Date.parse(at(-0.5)) });
    const row = [...r.goals.all, ...r.goals.otherShift, ...r.goals.movedOff, ...r.goals.paused].find((x) => x.leaf.id === "fg1")!;
    expect(rowTask(row)?.name).toBe("Clean fuel gas header");
  });
});
