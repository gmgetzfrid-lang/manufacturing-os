// The close-out's look back: what set the job back and why, the chain of
// events into the finish, what went well, where to do better — against
// the baseline, times as entered.

import { describe, it, expect } from "vitest";
import { buildLookBack } from "@/lib/lookBack";
import type { Milestone, MilestoneNote } from "@/types/schema";

const UTC = "UTC";
const T0 = Date.parse("2026-10-26T06:00:00Z");
const h = (n: number) => new Date(T0 + n * 3_600_000).toISOString();
const mk = (p: Partial<Milestone> & { id: string }): Milestone =>
  ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
// Planned [b0, b1], done [a0, a1].
const step = (id: string, parentId: string, b0: number, b1: number, a0: number, a1: number, more: Partial<Milestone> = {}) =>
  mk({ id, parentId, plannedStartAt: h(b0), plannedAt: h(b1), baselineStartAt: h(b0), baselineFinishAt: h(b1), actualStartAt: h(a0), actualAt: h(a1), status: "completed", percentComplete: 100, ...more });
const note = (milestoneId: string, kind: MilestoneNote["kind"], at: number, body: string, statusAt?: string): MilestoneNote =>
  ({ orgId: "o", milestoneId, kind, body, createdAt: h(at), createdBy: "u", ...(statusAt ? { statusAt } : {}) } as MilestoneNote);

// V-7: open on plan → clean (held 4 h for the permit, then ran 2 h long) →
// close (started as soon as it could; the slip passed on).
// E-17 and E-16: each hydroblast ran long; E-17's pull finished early.
const ms = [
  mk({ id: "v7", name: "V-7 Tower", workOrderRef: "301235" }), mk({ id: "e17", name: "E-17 Exchanger" }), mk({ id: "e16", name: "E-16 Cooler" }),
  step("open", "v7", 0, 10, 0, 10, { name: "Open manways", responsibleParty: "Schultz" }),
  step("clean", "v7", 10, 20, 14, 26, { name: "Clean tower", responsibleParty: "Schultz", dependsOn: ["open"] }),
  step("close", "v7", 20, 30, 26, 36, { name: "Close manways", responsibleParty: "Schultz", dependsOn: ["clean"] }),
  step("pull17", "e17", 0, 8, 0, 6, { name: "Pull bundle", responsibleParty: "Ancon" }),
  step("hb17", "e17", 8, 12, 6, 14, { name: "Hydroblast tubes", responsibleParty: "Ancon", dependsOn: ["pull17"] }),
  step("hb16", "e16", 0, 4, 0, 9, { name: "Hydroblast tubes", responsibleParty: "Ancon" }),
];
const notes = [
  note("clean", "status", 10, "Hot work permit", "on_hold"),
  note("clean", "status", 14, "Progress → 10%", "in_progress"),
  note("clean", "behind", 20, "Permit came late from operations"),
];
const lb = buildLookBack({ milestones: ms, notes, now: T0 + 48 * 3_600_000, tz: UTC });
const s = (id: string) => lb.steps.find((x) => x.id === id)!;

describe("the look back", () => {
  it("each step against the baseline: late start split into what it inherited and what it lost itself", () => {
    expect(s("clean")).toMatchObject({ startH: 4, overrunH: 2, finishH: 6, inheritedH: 0, holdH: 4, lost: { hold: 4, longer: 2 }, lostH: 6, wo: "301235", task: "V-7 Tower" });
    expect(s("clean").holds).toEqual([{ reason: "Hot work permit", hours: 4 }]);
    expect(s("clean").why).toEqual(["Permit came late from operations"]);
    // Close started the moment it could: its slip was passed on, not its own.
    expect(s("close")).toMatchObject({ startH: 6, inheritedH: 6, finishH: 6, lostH: 0 });
  });
  it("what set it back, worst first - and the hours by cause", () => {
    expect(lb.setbacks.map((x) => x.id)).toEqual(["clean", "hb16", "hb17"]);
    expect(lb.byCause).toEqual([{ cause: "longer", hours: 9, steps: 3 }, { cause: "hold", hours: 4, steps: 1 }]);
    // E-17's hydroblast started 2 h early and ran 4 h long: it lost 2 h, not 4.
    expect(s("hb17").lost).toEqual({ longer: 2 });
  });
  it("the chain of events into the finish: where the slip started and what each step added", () => {
    expect(lb.finish.slipH).toBe(6);
    expect(lb.chain.map((l) => [l.step.id, l.slipH, l.addedH])).toEqual([["clean", 6, 6], ["close", 6, 0]]);
  });
  it("what went well", () => {
    expect(lb.ahead.map((x) => [x.id, x.finishH])).toEqual([["pull17", -2]]);
    expect(lb.quicker.map((x) => x.id)).toEqual(["pull17"]);
    expect(lb.keep).toContain("1 step finished ahead of plan (2 h early).");
  });
  it("where to do better, in plain words", () => {
    expect(lb.improve).toEqual([
      "“Hydroblast tubes” ran long on 2 of 2 (+4.5 h on average) - plan more time for it next turnaround.",
      "On hold once for “Hot work permit” - 4 h in all.",
      "The finish slipped 6 h; it traces back to V-7 Tower, which lost 6 h on the chain into the finish.",
    ]);
  });
  it("crews: done, on plan, hours lost on their own", () => {
    expect(lb.crews).toEqual([{ crew: "Schultz", done: 3, onPlan: 1, lostH: 6 }, { crew: "Ancon", done: 3, onPlan: 1, lostH: 7 }]);
  });
});
