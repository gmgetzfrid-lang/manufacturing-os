// Root causes, not symptoms: a late step is traced through what it waited
// on to the step that lost time of its own; a link the work didn't wait on
// (it finished after the step started) isn't blamed; work on the same
// equipment under way all through a wait held it up; what was going on
// while a step waited, when nothing explains it, is given as context.

import { describe, it, expect } from "vitest";
import { buildLookBack, waitChain, causeOf, finishChain, whileWaiting } from "@/lib/lookBack";
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
  it("while it waited: the crew was on the held tower work", () => {
    const w = whileWaiting(look, look.get("install")!);
    expect(w[0]).toMatch(/^Schultz was on V-7 › manways \(on hold - “LEL's detected/);
  });
});
