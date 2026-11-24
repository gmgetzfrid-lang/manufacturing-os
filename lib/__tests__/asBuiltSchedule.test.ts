// The as-built schedule: each work order and step against the original
// plan, with what wasn't recorded said so.

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { buildAsBuilt, asBuiltDocument, varianceWords, laneSteps, stepBar, phaseBlocks, mostLateFirst, lateWords, answerOf } from "@/lib/asBuiltSchedule";
import { PHASE_ATTR, type ProjectPhase } from "@/lib/projectPhases";

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
  it("the printed report: the work orders first, then each with every step, on the same days", () => {
    const a = buildAsBuilt({ milestones: ms, childrenByParent: kids, tz });
    const html = asBuiltDocument(a, { project: "Transmix", scope: "Phase 1", tz, now: Date.parse(at("2026-10-29", "12:00")) });
    expect(html.indexOf("Work orders, most late first")).toBeLessThan(html.indexOf("Work orders and steps"));
    for (const col of ["Planned finish", "Actual finish", "Late by", "Shifts waited", "Took", "Status"]) expect(html).toContain(col);
    expect(html).toContain("Plan h and exact times are in the Excel file.");
    // Without the record of the shifts worked, the page says so, never a made-up 0.
    expect(html).toContain("Shifts waited weren't read for this copy.");
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

describe("each phase on its own plan, most late first", () => {
  const P: ProjectPhase[] = [
    { id: "p1", name: "Phase 1", start: "2026-10-28", end: "2026-10-31", share: 50 },
    { id: "p2", name: "Phase 2", start: "2026-11-05", end: "2026-11-08", share: 50 },
  ];
  const done = (id: string, parentId: string, d0: string, p0: string, p1: string, a1: string, hours: number) =>
    m(id, { parentId, durationHours: hours, plannedStartAt: at(d0, p0), plannedAt: at(d0, p1), status: "completed", percentComplete: 100, actualStartAt: at(d0, p0), actualAt: a1 });
  const two: Milestone[] = [
    m("E-14", { workOrderRef: "301504" }), done("blinds", "E-14", "2026-10-29", "08:00", "10:00", at("2026-10-29", "09:00"), 2),
    m("E-12", { workOrderRef: "301502" }), done("hydro", "E-12", "2026-10-28", "08:00", "10:00", at("2026-10-28", "20:00"), 2),
    m("E-17", { workOrderRef: "301507", attributes: { [PHASE_ATTR]: "p2" } }), done("pull", "E-17", "2026-11-05", "08:00", "12:00", at("2026-11-06", "14:00"), 4),
  ];
  const k = new Map<string, Milestone[]>([["E-14", [two[1]]], ["E-12", [two[3]]], ["E-17", [two[5]]]]);
  const a = buildAsBuilt({ milestones: two, childrenByParent: k, phases: P, tz });
  const now = Date.parse(at("2026-11-10", "09:00"));
  const blocks = phaseBlocks(a, now);
  it("a block per phase, each with its own planned finish and finish", () => {
    expect(blocks.map((b) => [b.name, b.orders.map((o) => o.wo).sort(), b.planFinish, b.finish])).toEqual([
      ["Phase 1", ["301502", "301504"], Date.parse(at("2026-10-29", "10:00")), Date.parse(at("2026-10-29", "09:00"))],
      ["Phase 2", ["301507"], Date.parse(at("2026-11-05", "12:00")), Date.parse(at("2026-11-06", "14:00"))],
    ]);
    // Phase 1 finished early on its own plan, though one of its work orders ran late.
    expect(blocks.map((b) => answerOf(b, now).text)).toEqual(["Finished 1 h early", "Finished 26 h (1.1 days) late"]);
  });
  it("most late first, each against its own planned finish", () => {
    const [e12, e14] = mostLateFirst(blocks[0].orders, now);
    expect([e12.wo, e14.wo]).toEqual(["301502", "301504"]);
    expect(lateWords(e12, now)).toEqual({ text: "10 h", late: true });
    expect(lateWords(e14, now)).toEqual({ text: "on time (1 h early)", late: false });
    expect(lateWords({ planFinish: now - 30 * 3_600_000, finish: null }, now)).toEqual({ text: "30 h (1.3 days) so far", late: true });
    expect(lateWords({ planFinish: now + 3_600_000, finish: null }, now)).toEqual({ text: "not due yet", late: false });
  });
  it("the page: the answer, each phase, most late first, and the shifts each waited", () => {
    const e12 = a.orders.find((o) => o.wo === "301502")!;
    const html = asBuiltDocument(a, { project: "Transmix", scope: "All phases", tz, now, work: { shifts: [], steps: new Map(), orders: new Map([[e12.key, { cells: [], worked: 2, waited: 3 }]]) } });
    expect(html).toContain("Phase 1: <span");
    expect(html).toContain("finished 26 h (1.1 days) late");
    const first = html.slice(html.indexOf("Work orders, most late first"), html.indexOf("Work orders and steps"));
    expect(first.indexOf("WO 301502")).toBeLessThan(first.indexOf("WO 301504"));
    expect(first.indexOf("Phase 1</b>")).toBeLessThan(first.indexOf("Phase 2</b>"));
    expect(first).toMatch(/WO 301502[\s\S]*?>10 h<\/td>[\s\S]*?>3<\/td>/);
    expect(html).toContain("Whole job vs plan");
    expect(html).not.toMatch(/[—–]/);
  });
});
