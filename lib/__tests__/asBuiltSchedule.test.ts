// The as-built schedule: each work order and step against the original
// plan, with what wasn't recorded said so.

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { buildAsBuilt, asBuiltDocument, varianceWords, laneSteps, stepBar } from "@/lib/asBuiltSchedule";

const tz = "America/Los_Angeles";
const at = (d: string, h: string) => `${d}T${h}:00-07:00`;
const m = (id: string, x: Record<string, unknown>) => ({ id, name: id, parentId: null, status: "planned", percentComplete: 0, ...x } as unknown as Milestone);
const saved = { baselineSetAt: at("2026-10-28", "09:00") };
const ms: Milestone[] = [
  m("E-12", { workOrderRef: "301502" }),
  m("Shell hydro", { parentId: "E-12", durationHours: 2, plannedStartAt: at("2026-10-28", "08:00"), plannedAt: at("2026-10-28", "10:00"), baselineStartAt: at("2026-10-28", "08:00"), baselineFinishAt: at("2026-10-28", "10:00"), ...saved,
    status: "completed", percentComplete: 100, actualStartAt: at("2026-10-28", "12:00"), actualAt: at("2026-10-28", "13:00") }),
  m("Pull blinds", { parentId: "E-12", durationHours: 2, plannedStartAt: at("2026-10-28", "10:00"), plannedAt: at("2026-10-28", "12:00"), baselineStartAt: at("2026-10-28", "10:00"), baselineFinishAt: at("2026-10-28", "12:00"), ...saved,
    status: "completed", percentComplete: 100, actualAt: at("2026-10-29", "08:00") }),
  m("Welded pipe", { parentId: "E-12", durationHours: 23, plannedStartAt: at("2026-10-29", "06:00"), plannedAt: at("2026-10-30", "05:00"),
    attributes: { discovery: { id: "d1", seq: 1, what: "low TML", foundAt: Date.parse(at("2026-10-29", "03:00")), impact: { hours: 32 } } },
    status: "in_progress", percentComplete: 40, actualStartAt: at("2026-10-29", "07:00") }),
];
const kids = new Map<string, Milestone[]>([["E-12", ms.slice(1)]]);

describe("buildAsBuilt", () => {
  const a = buildAsBuilt({ milestones: ms, childrenByParent: kids, tz });
  it("one work order, its steps against the original plan", () => {
    expect(a.orders).toHaveLength(1);
    const o = a.orders[0];
    expect(o.wo).toBe("301502");
    expect(o.steps.map((s) => [s.name, s.inPlan, s.varianceH, s.elapsedH])).toEqual([
      ["Shell hydro", true, 3, 1],
      ["Pull blinds", true, 20, null],
      ["Welded pipe", false, null, null],
    ]);
    expect(o.status).toBe("in_progress");
    expect(o.finish).toBeNull();
  });
  it("a start not recorded is said, and its bar starts at the planned start", () => {
    const s = a.orders[0].steps[1];
    expect(s.start).toBeNull();
    expect(s.barStart).toBe(Date.parse(at("2026-10-28", "10:00")));
    expect(a.startsNotRecorded).toBe(1);
  });
  it("added work is marked, and the plan is the one saved", () => {
    expect(a.orders[0].steps[2].added).toBe("discovery");
    expect(a.basis.kind).toBe("baseline");
    expect(a.planFinish).toBe(Date.parse(at("2026-10-28", "12:00")));
    expect(a.added).toBe(1);
  });
  it("the page says it", () => {
    const html = asBuiltDocument(a, { project: "Transmix", scope: "Whole project", tz, now: Date.parse(at("2026-11-08", "09:00")) });
    expect(html).toContain("not recorded");
    expect(html).toContain("WO 301502");
    expect(html).toContain(">Discovery</div>");
    expect(html).toContain("still going");
    expect(html).not.toMatch(/[—–]/);
  });
  it("variance words", () => {
    expect(varianceWords(33.5)).toBe("+33.5 h");
    expect(varianceWords(-2)).toBe("-2 h");
    expect(varianceWords(0.2)).toBe("on plan");
    expect(varianceWords(null)).toBe("");
  });
});

describe("a work order's bar, one piece per step", () => {
  it("steps one after another share a lane; steps at the same time stack", () => {
    const r = laneSteps([{ id: "a", from: 0, to: 10 }, { id: "b", from: 10, to: 20 }, { id: "c", from: 5, to: 15 }, { id: "d", from: 16, to: 18 }]);
    expect(r.lanes).toBe(2);
    expect(Object.fromEntries(r.at.map((x) => [x.id, x.lane]))).toEqual({ a: 0, c: 1, b: 0, d: 1 });
  });
  it("each step's piece runs start to finish; one still going runs to now; one not started has none", () => {
    const a = buildAsBuilt({ milestones: ms, childrenByParent: kids, tz });
    const [hydro, blinds, weld] = a.orders[0].steps;
    const now = Date.parse(at("2026-10-29", "12:00"));
    expect(stepBar(hydro, now)).toEqual({ from: Date.parse(at("2026-10-28", "12:00")), to: Date.parse(at("2026-10-28", "13:00")) });
    // No start recorded: from its planned start (said as "not recorded" on the page).
    expect(stepBar(blinds, now)?.from).toBe(Date.parse(at("2026-10-28", "10:00")));
    expect(stepBar(weld, now)).toEqual({ from: Date.parse(at("2026-10-29", "07:00")), to: now });
    expect(stepBar({ ...weld, status: "not_started", barStart: null }, now)).toBeNull();
  });
  it("the printed report draws each work order's steps on the same days, with the plan above", () => {
    const a = buildAsBuilt({ milestones: ms, childrenByParent: kids, tz });
    const html = asBuiltDocument(a, { project: "Transmix", scope: "Phase 1", tz, now: Date.parse(at("2026-10-29", "12:00")) });
    expect(html).toContain("Work orders and steps");
    expect(html).toContain("one piece each");
    expect(html).not.toContain("Plan start");
  });
});

describe("found work given its own WO", () => {
  const found = [...ms,
    m("Unbolt flange", { parentId: "E-12", workOrderRef: "312476", durationHours: 4, plannedStartAt: at("2026-10-30", "06:00"), plannedAt: at("2026-10-30", "10:00"),
      attributes: { discovery: JSON.stringify({ id: "d2", seq: 1, of: 1, what: "blind flange swapped", foundAt: 0, impact: { hours: 4 } }) } }),
  ];
  const k2 = new Map<string, Milestone[]>([["E-12", found.slice(1)]]);
  it("is its own work order, named for where it was found", () => {
    const a = buildAsBuilt({ milestones: found, childrenByParent: k2, tz });
    expect(a.orders.map((o) => o.wo).sort()).toEqual(["301502", "312476"]);
    const own = a.orders.find((o) => o.wo === "312476")!;
    expect(own.foundOn).toBe("E-12");
    expect(own.steps.map((s) => s.name)).toEqual(["Unbolt flange"]);
    // Found work on E-12's own number stays on E-12.
    expect(a.orders.find((o) => o.wo === "301502")!.steps.map((s) => s.name)).toContain("Welded pipe");
    expect(a.orders.find((o) => o.wo === "301502")!.foundOn).toBeNull();
  });
});
