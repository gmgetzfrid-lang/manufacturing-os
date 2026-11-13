import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { buildAsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork } from "@/lib/asBuiltWork";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { crewFlows, overloaded } from "@/lib/crewFlow";
import { buildLookBack } from "@/lib/lookBack";
import { discoveries } from "@/lib/discovery";
import { buildReview, pointOf } from "@/lib/postEventReview";

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
  const r = buildReview({ built, work, notes: [], look, discoveries: discoveries(all), tz });
  const f = r.findings.find((x) => x.key === "contractors:crew:clean")!;
  it("says the crew could not keep up, with the hours and what a second crew changes", () => {
    expect(f.title).toBe("Not enough Clean for the equipment that was open: 4 jobs at once, 52 h of waiting");
    expect(f.why).toBe("4 jobs were open for Clean at once against 1 in the plan, and equipment sat open 52 h waiting. One crew working without a break still leaves 18 h of waiting; two leave 4 h.");
    expect(f.next).toBe("Bring another Clean crew for the days equipment opens (10/26 to 10/27), or open equipment only as fast as Clean can take it. Opening ahead of plan gained nothing here.");
    expect(f.practice).toContain("sized to the most work the schedule hands it at once");
    expect(["gap", "opportunity"]).toContain(f.rating);
    // The jobs it tells are not told again as ready work nobody needed to act on.
    expect(r.findings.some((x) => x.key === "contractors" && /Nothing to change/.test(x.next))).toBe(false);
  });
  it("is a conclusion of the review, with its change, and has its questions answered", () => {
    const c = pointOf(r, "Phase 1", tz).conclusions.find((x) => x.key === f.key)!;
    expect([c.category, c.title, c.change]).toEqual(["Contractors and resourcing", f.title, f.next]);
    expect(r.qa.map((x) => x.q)).toEqual(expect.arrayContaining(["What was open and waiting for Clean?", "Would another Clean crew have changed the finish?"]));
  });
  it("says nothing of the kind when work passed between crews without a queue", () => {
    const calm = crewFlows(built, work).find((x) => x.crew === "Mech")!;
    expect(overloaded(calm)).toBe(false);
    expect(r.findings.some((x) => x.key === "contractors:crew:mech")).toBe(false);
  });
});
