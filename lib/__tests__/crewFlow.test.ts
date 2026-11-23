import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { buildAsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork } from "@/lib/asBuiltWork";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { crewFlows, overloaded } from "@/lib/crewFlow";
import { buildLookBack } from "@/lib/lookBack";
import { discoveries } from "@/lib/discovery";
import { buildReview, emptySaved, pointOf } from "@/lib/postEventReview";
import { CREWS_HEAD, crewsRows } from "@/lib/reviewFiles";

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00", breaks: [] };
// Mon Oct 26 2026, local times (PDT, -7).
const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h + 7, m)).toISOString();
const order = (id: string, name: string): Milestone => ({ id, name, status: "completed", plannedAt: at(30, 18), isSummary: true } as unknown as Milestone);
const step = (id: string, parentId: string, name: string, crew: string, plan: [string, string], act: [string, string], dependsOn: string[] = []): Milestone =>
  ({ id, parentId, name, status: "completed", percentComplete: 100, responsibleParty: crew, plannedStartAt: plan[0], plannedAt: plan[1], baselineStartAt: plan[0], baselineFinishAt: plan[1], actualStartAt: act[0], actualAt: act[1], durationHours: (Date.parse(plan[1]) - Date.parse(plan[0])) / 3_600_000, dependsOn } as unknown as Milestone);
const done = (id: string, start: string, finish: string): ProgressLogRow[] => [
  { milestone_id: id, at: start, old_status: "planned", new_status: "in_progress", old_percent: 0, new_percent: 10 },
  { milestone_id: id, at: finish, old_status: "in_progress", new_status: "completed", old_percent: 10, new_percent: 100 },
];

// Four exchangers. The plan opens them one after another so the cleaners
// have one at a time; in the event all four were pulled the first morning and
// one cleaning crew took them in turn.
const X = [1, 2, 3, 4];
const planClean: Array<[string, string]> = [[at(26, 12), at(26, 16)], [at(26, 16), at(26, 20)], [at(27, 8), at(27, 12)], [at(27, 12), at(27, 16)]];
const actClean: Array<[string, string]> = [[at(26, 12), at(26, 16)], [at(26, 16), at(26, 20)], [at(27, 7), at(27, 11)], [at(27, 11), at(27, 15)]];
const all: Milestone[] = [];
const log: ProgressLogRow[] = [];
for (const n of X) {
  const i = n - 1, o = `w${n}`;
  const pullPlan: [string, string] = [new Date(Date.parse(planClean[i][0]) - 2 * 3_600_000).toISOString(), planClean[i][0]];
  const pullAct: [string, string] = [at(26, 7 + i), at(26, 9 + i)];
  const closeAct: [string, string] = [new Date(Date.parse(actClean[i][1]) + 3_600_000).toISOString(), new Date(Date.parse(actClean[i][1]) + 4 * 3_600_000).toISOString()];
  all.push(order(o, `E-${n} - Exchanger ${n}`),
    step(`p${n}`, o, "Pull Bundle", "Mech", pullPlan, pullAct),
    step(`c${n}`, o, "Hydroblast Bundle", "Clean", planClean[i], actClean[i]),
    step(`k${n}`, o, "Install Bundle", "Mech", [planClean[i][1], new Date(Date.parse(planClean[i][1]) + 3 * 3_600_000).toISOString()], closeAct));
  log.push(...done(`p${n}`, ...pullAct), ...done(`c${n}`, ...actClean[i]), ...done(`k${n}`, ...closeAct));
}
const kids = new Map<string, Milestone[]>();
for (const m of all) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
const built = buildAsBuilt({ milestones: all, childrenByParent: kids, tz });
const work = buildAsBuiltWork({ built, milestones: all, log, notes: [], records: new Map(), companyOf: (c) => c, tz, times, now: Date.parse(at(31, 12)) });
const flows = crewFlows(built, work);
const clean = flows.find((f) => f.crew === "Clean")!;

describe("where work waited between crews", () => {
  it("counts each job handed to a crew: when it was open, when the crew started it, how long it sat", () => {
    expect(clean.jobs.map((j) => [j.order.split(" - ")[0], j.from, j.waitH])).toEqual([["E-1", "Mech", 3], ["E-2", "Mech", 6], ["E-3", "Mech", 20], ["E-4", "Mech", 23]]);
    expect(clean.waitH).toBe(52);
    // The ones that sat four hours or more, longest first, with what the crew was on meanwhile.
    expect(clean.waited.map((j) => j.order.split(" - ")[0])).toEqual(["E-4", "E-3", "E-2"]);
    expect(clean.waited[0].crewOn.map((o) => o.split(" - ")[0]).sort()).toEqual(["E-1", "E-2", "E-3"]);
  });
  it("gives the most it had open at once against the most the plan gave it", () => {
    expect([clean.peak.open, clean.plannedPeak]).toEqual([4, 1]);
    expect(clean.peak.working.length + clean.peak.waiting.length).toBe(4);
    expect([clean.burst.jobs.length, clean.burst.hours]).toEqual([4, 3]);
    // E-3 and E-4 were opened a day ahead of the plan and sat.
    expect(clean.jobs[3].openedEarlyH).toBeGreaterThan(20);
  });
  it("works out the same queue with one crew and with two, from the record's own times", () => {
    // In the order they opened, four hours each: one crew back to back, two crews side by side.
    expect(clean.queue).toEqual({ one: 18, two: 4 });
    expect(overloaded(clean)).toBe(true);
    // The crew that opened and closed them was handed each back within the hour: no queue.
    expect(overloaded(flows.find((f) => f.crew === "Mech")!)).toBe(false);
  });
  it("takes the schedule's own link inside a work order as what a job followed", () => {
    // E-1's cleaning linked to a step that finished later than the pull: it was open only from then.
    const late = step("x1", "w1", "Strip Insulation", "Mech", [at(26, 6), at(26, 8)], [at(26, 9), at(26, 11, 30)]);
    const all2 = [...all, late];
    const kids2 = new Map(kids); kids2.set("w1", [...(kids.get("w1") ?? []), late]);
    const b2 = buildAsBuilt({ milestones: all2, childrenByParent: kids2, tz });
    const w2 = buildAsBuiltWork({ built: b2, milestones: all2, log: [...log, ...done("x1", at(26, 9), at(26, 11, 30))], notes: [], records: new Map(), companyOf: (c) => c, tz, times, now: Date.parse(at(31, 12)) });
    const linked = crewFlows(b2, w2, new Map([["c1", ["x1"]]])).find((f) => f.crew === "Clean")!;
    expect(linked.jobs.find((j) => j.id === "c1")!.waitH).toBe(0.5);
  });
});

describe("the review's conclusion from it", () => {
  const look = buildLookBack({ milestones: all, notes: [], discoveries: discoveries(all), now: Date.parse(at(31, 12)), tz });
  const base = { built, work, notes: [], look, discoveries: discoveries(all), tz };
  const r = buildReview(base);
  it("the hand-offs to a crew are still counted for the report's table", () => {
    expect(crewsRows(r).find((row) => row[0] === "Clean")).toEqual(["Clean", "4", "3 of 4", "23 h (E-4), no link in the schedule", "4 (plan 1)"]);
    expect(CREWS_HEAD).toEqual(["Crew", "Jobs handed to it", "Jobs that waited 4 h or more for it", "Longest a job waited", "Most open at once"]);
  });
  it("the review reads the crew from its load: it kept to its plan, so no job waited for it past a planned start", () => {
    // Four pulled the first morning against one planned at once: all four were ready by noon.
    const L = r.loads.find((x) => x.party === "Clean")!;
    expect([L.planned.n, L.planned.from, L.peak.open]).toEqual([1, "schedule", 4]);
    // Each was cleaned at (or ahead of) its planned start: the time before that is the plan saying later, not waiting.
    expect(L.jobs.map((j) => [j.id, j.partyH, j.nobodyH, j.laterH > 0])).toEqual([["c1", 0, 0, true], ["c2", 0, 0, true], ["c3", 0, 0, true], ["c4", 0, 0, true]]);
    expect(L.waited).toEqual([]);
    // So the review says nothing of a crew short of people, and nothing is on the slides for it.
    expect(r.findings.some((x) => x.key.startsWith("contractors:load:") || x.key.startsWith("contractors:crew:"))).toBe(false);
    expect(pointOf(r, "Phase 1", tz).conclusions.some((c) => /Clean/.test(c.title))).toBe(false);
    // A person who sets the crew's number keeps its card, where the number can be changed; it says what the record shows.
    const one = buildReview({ ...base, atOnce: { Clean: 1 } });
    expect(one.loads.find((x) => x.party === "Clean")!.planned).toMatchObject({ n: 1, from: "set", sched: 1 });
    expect(one.findings.find((x) => x.key === "contractors:load:clean")!.observation.split("\n")[1]).toBe("No job waited while Clean was working 1 or more: it worked 1 at most.");
    void emptySaved;
  });
  it("a person can correct what a job followed, and its wait follows", () => {
    // E-4's cleaning was not ready until E-3's was done (a link the schedule did not have).
    const fixed = crewFlows(built, work, new Map(), { c4: "c3" }).find((x) => x.crew === "Clean")!.jobs.find((j) => j.id === "c4")!;
    expect([fixed.waitH, fixed.basis, fixed.after]).toEqual([0, "corrected", "Hydroblast Bundle"]);
    const was = clean.jobs.find((j) => j.id === "c4")!;
    expect([was.waitH, was.basis, was.after]).toEqual([23, "guessed", "Pull Bundle"]);
    // The review carries the correction from what was saved.
    const r2 = buildReview({ ...base, saved: { ...emptySaved(), readyAfter: { c4: "c3" } } });
    expect(r2.flows.find((x) => x.crew === "Clean")!.jobs.find((j) => j.id === "c4")!.waitH).toBe(0);
  });
  it("says nothing of the kind when work passed between crews without a queue", () => {
    expect(overloaded(crewFlows(built, work).find((x) => x.crew === "Mech")!)).toBe(false);
    expect(r.findings.some((x) => x.key === "contractors:crew:mech")).toBe(false);
  });
});
