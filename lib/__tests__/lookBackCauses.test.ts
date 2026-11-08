// Root causes, not symptoms: a late step is traced through what it waited
// on to the step that lost time of its own; a link the work didn't wait on
// (it finished after the step started) isn't blamed; work on the same
// equipment under way all through a wait held it up; what was going on
// while a step waited, when nothing explains it, is given as context.

import { describe, it, expect } from "vitest";
import { buildLookBack, waitChain, causeOf, finishChain, whileWaiting, lostWords } from "@/lib/lookBack";
import type { Milestone, MilestoneNote } from "@/types/schema";

const T0 = Date.parse("2026-10-26T06:00:00Z");
const h = (n: number) => new Date(T0 + n * 3_600_000).toISOString();
const mk = (p: Partial<Milestone> & { id: string }): Milestone =>
  ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const step = (id: string, parentId: string, b0: number, b1: number, a0: number, a1: number, more: Partial<Milestone> = {}) =>
  mk({ id, parentId, name: id, plannedStartAt: h(b0), plannedAt: h(b1), baselineStartAt: h(b0), baselineFinishAt: h(b1), actualStartAt: h(a0), actualAt: h(a1), status: "completed", percentComplete: 100, ...more });
const note = (milestoneId: string, kind: MilestoneNote["kind"], at: number, body: string, statusAt?: string): MilestoneNote =>
  ({ orgId: "o", milestoneId, kind, body, createdAt: h(at), happenedAt: h(at), createdBy: "u", ...(statusAt ? { statusAt } : {}) } as MilestoneNote);

// The tower: opening held for LEL; added downcomer cleaning; clean tower waits on it.
// E-12: the bundle install starts late while the tower crew is on the tower, runs long;
// the cover goes on while the install is still going; the tube hydro waits on the
// install and is held for leaks; the start-up waits on the tube hydro.
const ms = [
  mk({ id: "v7", name: "V-7", workOrderRef: "301235" }), mk({ id: "e12", name: "E-12", workOrderRef: "301502" }), mk({ id: "su", name: "Start-Up" }),
  step("manways", "v7", 0, 10, 0, 28, { responsibleParty: "Schultz" }),
  step("downcomers", "v7", 28, 46, 28, 46, { responsibleParty: "Schultz", dependsOn: ["manways"], attributes: { discovery: JSON.stringify({ id: "d1", seq: 1, what: "Unplanned clean downcomers", foundAt: T0, impact: { hours: 18 } }) } }),
  step("clean", "v7", 10, 22, 47, 59, { responsibleParty: "Ancon", dependsOn: ["manways", "downcomers"] }),
  step("install", "e12", 2, 8, 8, 40, { responsibleParty: "Schultz" }),
  step("cover", "e12", 10, 12, 38, 39, { responsibleParty: "Schultz", dependsOn: ["tube"] }),
  step("tube", "e12", 8, 10, 40, 60, { responsibleParty: "Schultz", dependsOn: ["install"] }),
  step("feed", "su", 12, 14, 61, 63, { responsibleParty: "Ops", dependsOn: ["tube"] }),
];
const notes = [
  note("manways", "status", 2, "LEL's detected in vessel. Crew stand down for air stripping the tower.", "on_hold"),
  note("manways", "status", 20, "Progress", "in_progress"),
  note("tube", "status", 44, "Leaks on shell side preventing tube side.", "on_hold"),
  note("tube", "status", 54, "Progress", "in_progress"),
];
const lb = buildLookBack({ milestones: ms, notes, now: T0 + 100 * 3_600_000, tz: "UTC" });
const look = new Map(lb.steps.map((s) => [s.id, s]));

describe("root causes", () => {
  it("a late step is traced to the added work it waited on", () => {
    expect(look.get("clean")!.waitedOn).toBe("downcomers");
    expect(causeOf(look, "clean")!.id).toBe("downcomers");
  });
  it("a link the work didn't wait on isn't blamed; work on the same equipment under way all through the wait is", () => {
    // The cover is linked after the tube hydro, but went on before it finished.
    expect(look.get("cover")!.waitedOn).toBe("install");
    expect(look.get("cover")!.lost["late-start"]).toBeUndefined();
  });
  it("what set the finish: the start-up back through the held tube hydro to the late, long install", () => {
    expect(finishChain(lb).map((s) => s.id)).toEqual(["install", "tube", "feed"]);
    expect(waitChain(look, "feed").map((s) => s.id)).toEqual(["tube", "install"]);
    expect(look.get("tube")!.holds[0].reason).toMatch(/Leaks on shell side/);
  });
  it("a crew stood down on a held job isn't on other work: the wait stays unexplained, with the hold said", () => {
    const i = look.get("install")!;
    expect(i.lost.crew).toBeUndefined();
    expect(whileWaiting(look, i)[0]).toMatch(/^Schultz was on V-7 › manways \(on hold - “LEL's detected/);
  });
});

describe("waiting for the crew, and work not started", () => {
  // Ancon: E-17's hydroblast runs long; V-8's waits for Ancon. Ops' step hasn't started.
  const m2 = [
    mk({ id: "e17", name: "E-17", workOrderRef: "1" }), mk({ id: "v8", name: "V-8", workOrderRef: "2" }), mk({ id: "su", name: "Start-Up", workOrderRef: "3" }),
    step("hb17", "e17", 0, 4, 0, 20, { responsibleParty: "Ancon" }),
    step("hb8", "v8", 4, 10, 20, 26, { responsibleParty: "Ancon" }),
    mk({ id: "feed", parentId: "su", name: "Pull Feed", plannedStartAt: h(2), plannedAt: h(6), baselineStartAt: h(2), baselineFinishAt: h(6), responsibleParty: "Ops", status: "planned", percentComplete: 0 }),
  ];
  const lb2 = buildLookBack({ milestones: m2, notes: [], now: T0 + 30 * 3_600_000, tz: "UTC" });
  const l2 = new Map(lb2.steps.map((x) => [x.id, x]));
  it("a step whose crew was on other work all through its wait waited for the crew, said with what it was on", () => {
    const v = l2.get("hb8")!;
    expect(v.lost.crew).toBe(16);
    expect(v.lost["late-start"]).toBeUndefined();
    expect(lostWords(v)[0]).toBe("Waited 16 h for Ancon, on other work: E-17 › hb17 (ran 16 h long)");
  });
  it("a step not started says so, never “started late”", () => {
    const f = l2.get("feed")!;
    expect(f.started).toBe(false);
    expect(lostWords(f).join(" ")).toMatch(/^Not started, .* past its planned start - nothing recorded on why$/);
  });
});

describe("waiting for the crew is said once", () => {
  it("no 'while it waited' line repeating the crew's other work", () => {
    const m3 = [
      mk({ id: "e17", name: "E-17", workOrderRef: "1" }), mk({ id: "v8", name: "V-8", workOrderRef: "2" }),
      step("hb17", "e17", 0, 4, 0, 20, { responsibleParty: "Ancon" }),
      step("hb8", "v8", 4, 10, 20, 26, { responsibleParty: "Ancon" }),
    ];
    const lb3 = buildLookBack({ milestones: m3, notes: [], now: T0 + 30 * 3_600_000, tz: "UTC" });
    const look = new Map(lb3.steps.map((x) => [x.id, x]));
    expect(whileWaiting(look, look.get("hb8")!)).toEqual([]);
  });
});

describe("a step still going", () => {
  it("its overrun is a forecast, not said as done", () => {
    const m4 = [mk({ id: "t", name: "T", workOrderRef: "1" }), mk({ id: "s", parentId: "t", name: "Chem Clean", plannedStartAt: h(0), plannedAt: h(4), baselineStartAt: h(0), baselineFinishAt: h(4), actualStartAt: h(0), responsibleParty: "Ops", status: "in_progress", percentComplete: 20 })];
    const lb4 = buildLookBack({ milestones: m4, notes: [], now: T0 + 10 * 3_600_000, tz: "UTC" });
    const w = lostWords(lb4.steps[0]).join(" ");
    expect(w).not.toMatch(/^Ran /);
    expect(lb4.steps[0].lost.longer).toBeGreaterThan(0);
    expect(w).toMatch(/Forecast to run [\d.]+ h longer than planned \(still going\)/);
  });
});
