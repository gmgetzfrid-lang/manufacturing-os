import { describe, it, expect } from "vitest";
import type { Milestone, MilestoneNote } from "@/types/schema";
import { buildAsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork } from "@/lib/asBuiltWork";
import { buildLookBack } from "@/lib/lookBack";
import { discoveries, discoveryAttr, type DiscoveryRecord } from "@/lib/discovery";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { deckSlides, reportBlocks } from "@/lib/reviewFiles";
import { GUIDES, bookOf, scoreOf } from "@/lib/reviewBook";
import { buildReview, causeOfText, emptySaved, basisOf, measuresOf, lessonOf, jobWord, pointOf, shiftWord, type ReviewSaved } from "@/lib/postEventReview";

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00", breaks: [] };
// Mon Oct 26 2026, local times (PDT, -7).
const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h + 7, m)).toISOString();
// Everything is on the baseline but the work found during the job.
const ms = (x: Partial<Milestone> & { id: string; name: string }): Milestone => ({ status: "completed", plannedAt: at(26, 18), percentComplete: 100, durationHours: 8, ...(x.attributes ? {} : { baselineStartAt: x.plannedStartAt, baselineFinishAt: x.plannedAt }), ...x } as Milestone);
const order = (id: string, name: string): Milestone => ({ id, name, status: "completed", plannedAt: at(30, 18), isSummary: true } as unknown as Milestone);
const row = (id: string, t: string, from: number | null, to: number | null, st: ProgressLogRow["new_status"], old: ProgressLogRow["old_status"] = "in_progress"): ProgressLogRow => ({ milestone_id: id, at: t, old_status: old, new_status: st, old_percent: from, new_percent: to });
const note = (id: string, typed: string, body: string, happened?: string, kind: MilestoneNote["kind"] = "note"): MilestoneNote => ({ milestoneId: id, kind, body, createdAt: typed, happenedAt: happened ?? null, createdBy: "u", orgId: "o" });

// A valve sent out (sat two day shifts), a relief valve that waited on a
// plugged line and then on E/I, a job that sat with nothing written, a
// ready job the crew didn't get to, and work found on the tower.
const valves = order("wv", "Control Valves");
const tv = ms({ id: "tv", parentId: "wv", name: "TV-006 on the Fuel Gas Line to H-1 (Service Valve)", plannedStartAt: at(26, 8), plannedAt: at(26, 16), actualStartAt: at(26, 8), actualAt: at(29, 15), responsibleParty: "Maintenance (KE)" });
const psvs = order("wp", "PSVs");
const psv = ms({ id: "psv", parentId: "wp", name: "PSV-021 - E-13 Overhead (Swap Existing with the New Model)", plannedStartAt: at(26, 10), plannedAt: at(26, 18), actualStartAt: at(26, 10), actualAt: at(30, 13), responsibleParty: "Maintenance (KE)" });
const e13 = order("we", "E-13 - Air Condenser");
const blinds = ms({ id: "bl", parentId: "we", name: "Pull Blinds / Torque Flanges", plannedStartAt: at(27, 7), plannedAt: at(27, 15), actualStartAt: at(27, 7), actualAt: at(29, 10), responsibleParty: "Schultz" });
const other = ms({ id: "ot", parentId: "we", name: "Install bundle", plannedStartAt: at(28, 7), plannedAt: at(28, 15), actualStartAt: at(28, 7), actualAt: at(28, 15), responsibleParty: "Schultz" });
const gas = order("wg", "Clean fuel gas header");
const pull = ms({ id: "pu", parentId: "wg", name: "Remove piping", plannedStartAt: at(26, 6), plannedAt: at(26, 8), actualStartAt: at(26, 14), actualAt: at(26, 16), responsibleParty: "Maintenance (KE)", durationHours: 2 });
const blast = ms({ id: "hb", parentId: "wg", name: "Hydroblast piping", plannedStartAt: at(26, 8), plannedAt: at(26, 10), actualStartAt: at(29, 7), actualAt: at(29, 9), responsibleParty: "Ancon", durationHours: 2, dependsOn: ["pu"] });
const anconBusy = ms({ id: "ab", parentId: "we", name: "Hydroblast bundle", plannedStartAt: at(27, 7), plannedAt: at(28, 15), actualStartAt: at(27, 7), actualAt: at(28, 15), responsibleParty: "Ancon" });
const tower = order("wt", "V-7 - Fractionator");
const rec: DiscoveryRecord = { id: "d1", what: "Unplanned clean downcomers", foundAt: Date.parse(at(27, 9)), addedAt: Date.parse(at(27, 10)), seq: 1, of: 1, impact: { hours: 18, taskFinish: [0, 0], finish: [0, 0], critical: true, pushed: [] } };
const down = ms({ id: "dc", parentId: "wt", name: "Vacuum and hand clean each downcomer", plannedStartAt: at(28, 6), plannedAt: at(28, 18), actualStartAt: at(28, 6), actualAt: at(28, 17), responsibleParty: "Schultz", durationHours: 18, attributes: { discovery: discoveryAttr(rec) } });
const entry = ms({ id: "en", parentId: "wt", name: "Open manways", plannedStartAt: at(26, 7), plannedAt: at(26, 12), actualStartAt: at(26, 7), actualAt: at(26, 17), responsibleParty: "Schultz" });
const all = [valves, tv, psvs, psv, e13, blinds, other, gas, pull, blast, anconBusy, tower, down, entry];
const kids = new Map<string, Milestone[]>();
for (const m of all) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
const log: ProgressLogRow[] = [
  row("tv", at(26, 8), 0, 50, "in_progress", "planned"), row("tv", at(29, 15), 50, 100, "completed"),
  row("psv", at(26, 10), 0, 20, "in_progress", "planned"), row("psv", at(27, 11), 20, 30, "in_progress"), row("psv", at(28, 10), 30, 40, "in_progress"), row("psv", at(30, 13), 40, 100, "completed"),
  row("bl", at(27, 7), 0, 30, "in_progress", "planned"), row("bl", at(29, 10), 30, 100, "completed"),
  row("ot", at(28, 15), 0, 100, "completed", "planned"),
  row("pu", at(26, 16), 0, 100, "completed", "planned"),
  row("ab", at(27, 9), 0, 50, "in_progress", "planned"), row("ab", at(28, 15), 50, 100, "completed"),
  row("hb", at(29, 9), 0, 100, "completed", "planned"),
  row("dc", at(28, 17), 0, 100, "completed", "planned"),
  row("en", at(26, 7), 0, 10, "in_progress", "planned"), row("en", at(26, 17), 10, 100, "completed"),
];
const notes: MilestoneNote[] = [
  note("tv", at(28, 14), "Caltrol picked up expected back in 72 hrs.", at(26, 13)),
  // A day's updates typed in one sitting: the hold has no time of its own.
  note("psv", at(28, 14, 5), "PSV pulled ready for swap. Discovered plugging in line.", at(27, 11)),
  { ...note("psv", at(28, 14, 6), "Placed on hold to have Ancon clean plugging in line before PSV swap", undefined, "status"), statusAt: "on_hold" },
  note("psv", at(28, 14, 7), "Ancon cleared plugging", at(28, 8)),
  note("psv", at(28, 14, 9), "New PSV installed ready for E/I to run tubing for pilot", at(28, 10)),
  { ...note("en", at(26, 8), "LEL detected in vessel. Crew stand down for air stripping the tower.", undefined, "status"), statusAt: "on_hold" },
  { ...note("en", at(26, 14), "", undefined, "status"), statusAt: "in_progress" },
];
const built = buildAsBuilt({ milestones: all, childrenByParent: kids, tz });
const work = buildAsBuiltWork({ built, milestones: all, log, notes, records: new Map(), companyOf: (c) => c, tz, times, now: Date.parse(at(31, 12)) });
const look = buildLookBack({ milestones: all, notes, discoveries: discoveries(all), now: Date.parse(at(31, 12)), tz });
const read = (saved?: ReviewSaved) => buildReview({ built, work, notes, look, discoveries: discoveries(all), tz, saved });
const r = read();
const shiftsOf = (id: string) => r.stuck.find((j) => j.id === id)?.shifts.map((s) => [shiftWord(s.key), s.cause]);

describe("what a comment says a job waited on", () => {
  it("reads the reason, and none from a progress line", () => {
    expect(causeOfText("Caltrol picked up expected back in 72 hrs.")).toBe("offsite");
    expect(causeOfText("New PSV installed ready for E/I to run tubing for pilot")).toBe("other_crew");
    expect(causeOfText("Left out for Ancon to clean line")).toBe("cleaning");
    expect(causeOfText("Tube side holding suspecting leaks on shell side.")).toBe("test");
    expect(causeOfText("Discovered 20 of the required 24 seal ring replacements were ordered")).toBe("material");
    expect(causeOfText("LEL's detected in vessel. Crew stand down for air stripping the tower.")).toBe("permit");
    expect(causeOfText("Bundles all in")).toBe(null);
    expect(causeOfText("Progress → 40%")).toBe(null);
  });
});

describe("the review, from the records", () => {
  it("lists each stuck job by its day shifts, with the reason for each shift", () => {
    // Sent out for service: a planned step, not stuck work. It is listed
    // apart, by the day shifts it was away, and was back inside the 72 h quoted.
    expect(shiftsOf("tv")).toBeUndefined();
    expect(r.service.map((j) => [j.id, j.shifts.map(shiftWord), j.stillOut])).toEqual([["tv", ["10/27 day", "10/28 day"], null]]);
    // The plug was cleared on the 28th; by the 29th it waited on E/I. The
    // hold typed with the day's updates is read at the time they were about.
    expect(shiftsOf("psv")).toEqual([["10/29 day", "other_crew"]]);
    // Nothing written: where its crew was instead.
    const b = r.stuck.find((j) => j.id === "bl")!;
    expect(b.shifts.map((s) => s.cause)).toEqual(["crew_elsewhere"]);
    expect(b.shifts[0].crewOn).toEqual(["V-7 - Fractionator"]);
  });
  it("lists ready work that did not start, and what its crew was on", () => {
    const j = r.ready.find((x) => x.id === "hb")!;
    expect(j.shifts.map(shiftWord)).toEqual(["10/27 day", "10/28 day"]);
    expect(j.busyOn).toEqual(["E-13 - Air Condenser"]);
  });
  it("counts in plain numbers: jobs, shifts, and how many at a time", () => {
    const m = r.metrics;
    expect([m.stuckJobs, m.stuckShifts, m.readyJobs, m.readyShifts]).toEqual([2, 2, 1, 2]);
    expect(m.byCause.map((c) => [c.cause, c.shifts])).toEqual([["other_crew", 1], ["crew_elsewhere", 1]]);
    expect(m.noReasonShifts).toBe(1);
    expect(r.byShift.map((c) => [shiftWord(c.key), c.stuck, c.ready])).toEqual([["10/27 day", 0, 1], ["10/28 day", 1, 1], ["10/29 day", 1, 0]]);
    expect([m.shiftsWithStuck, m.leastAtOnce, m.mostAtOnce]).toEqual([3, 1, 2]);
    // Labor hours are left out without head counts, never assumed.
    expect(m.labor).toBe(null);
    expect(m.addedSteps).toBe(1);
  });
  it("says what set the finish: the last work done, the step and crew, and what was written on it", () => {
    const f = r.finish!;
    expect([f.lateH, f.last[0].order, f.last[1].order, f.aheadH, f.cause]).toEqual([46, "PSVs", "Control Valves", 22, "cleaning"]);
    expect(f.steps.map((x) => [x.name, x.crew, x.plannedH, x.tookH])).toEqual([["PSV-021 - E-13 Overhead (Swap Existing with the New Model)", "Maintenance (KE)", 8, 99]]);
    expect(f.because).toMatchObject({ crew: "Maintenance (KE)", said: "PSV pulled ready for swap. Discovered plugging in line." });
    const pt = pointOf(r, "Phase 1", tz);
    // The headline says how much of the delay was the work that set the finish; the line under it, where every hour went.
    expect(pt.headline).toBe("Phase 1 finished 46 h late. 22 h of it was PSVs.");
    expect(r.finish!.delay.reduce((n, d) => n + d.hours, 0)).toBe(46);
    expect(pt.delay).toMatch(/^Where the 46 h went: PSVs 22 h, /);
    expect(pt.lines[0]).toBe("PSVs was done 22 h after Control Valves, the work before it.");
    expect(pt.lines.join(" ")).toContain('(Maintenance (KE)): "PSV pulled ready for swap. Discovered plugging in line."');
    // Service that came back as planned is said so, never as a delay.
    expect(pt.quiet).toContain("TV-006 on the Fuel Gas Line to H-1: out for service, back as planned");
    // The finish is told once, by its finding: no question repeats it.
    expect(r.qa.some((x) => /past the baseline finish|stayed open longest/.test(x.q))).toBe(false);
  });
  it("only the reason on record is named as setting the finish; the rest say what they cost", () => {
    const by = (k: string) => r.findings.find((f) => f.key === k)!;
    // The plugged line is what the last work's comments give: named, and first.
    const plug = by("planning:cleaning");
    expect([r.findings[0].key, plug.rating, plug.moved]).toEqual(["planning:cleaning", "gap", 3]);
    expect(plug.title).toBe("PSVs set the finish: a line had to be cleaned first");
    expect(plug.effect).toBe("Set the finish. Cost 22 of the 46 h. PSVs was done 22 h after Control Valves, the work before it.");
    // No advice is written for it: nobody can plan where a line will be plugged. A person says what, if anything, to change.
    expect([plug.next, plug.ask]).toEqual(["", ""]);
    // A hand-off on the same work is told as that, not as a crew short of people.
    const hand = by("contractors:handoff");
    expect([hand.rating, hand.moved, hand.title]).toEqual(["opportunity", 2, "PSV-021 - E-13 Overhead waited a shift on another crew"]);
    expect(hand.effect).toBe("Cost 22 of the 46 h. PSVs was done 22 h after Control Valves, the work before it.");
    expect(hand.next).not.toMatch(/add a crew|more people/i);
    // A job that sat with no reason written is told by name, with what its work order cost.
    expect([by("execution").title, by("execution").moved, by("execution").effect]).toEqual(["E-13 Pull Blinds / Torque Flanges sat a shift with no reason written", 2, "Cost 1 of the 46 h. E-13 was done 1 h after Clean fuel gas header, the work before it."]);
    // Discovery on V-7's critical path: said in its own hours, with what V-7 cost, never claimed as the whole of it.
    expect([by("scope").moved, by("scope").effect]).toEqual([1, "18 h of it was on the critical path of V-7. V-7 cost 2 of the 46 h late."]);
    // Nothing is said about an organization the project has not recorded.
    expect([by("organization").rating, by("materials").rating]).toEqual(["none", "none"]);
  });
  it("one finding is one work order and one cause: nothing from another job is folded in", () => {
    const by = (k: string) => r.findings.find((f) => f.key === k)!;
    // Gas-freeing on V-7 says nothing of the plugged line on the PSVs, and the other way round.
    const gas = by("planning");
    // V-7 finished after the baseline finish: it holds its own share of the delay, said in hours.
    expect([gas.title, gas.effect]).toEqual(["V-7 was held 6 h for gas-freeing that was not in the plan", "Cost 2 of the 46 h. V-7 was done 2 h after the baseline finish."]);
    expect(`${gas.observation} ${gas.gap} ${gas.next}`).not.toMatch(/PSV|plug|clean the line/i);
    expect(`${by("planning:cleaning").observation} ${by("planning:cleaning").next}`).not.toMatch(/V-7|gas/i);
    // Ready work and a hand-off between crews are two findings.
    expect([by("contractors").title, by("contractors").effect]).toEqual(["Ready work waited for a crew", "Did not move the finish."]);
    expect(by("contractors").observation).not.toMatch(/PSV-021/);
    // What a finding says to do names only the work it is about.
    for (const f of r.findings) {
      const about = `${f.title} ${f.observation}`;
      for (const tag of f.next.match(/\b[A-Z]{1,3}-\d+[A-Z]?\b/g) ?? []) expect(about, `${f.key}: ${tag}`).toContain(tag);
    }
  });
  it("found work: the records say what was found; a person says whether it could have been known", () => {
    const scope = r.findings.find((f) => f.key === "scope")!;
    // Entered as discovery: found when the equipment was opened. Hours are the schedule's, the same hours every total adds up.
    expect(scope.observation.split("\n")).toEqual(["Found when the equipment was opened or inspected: 1 item, 18 h (35% of the 52 h plan); 18 h of it on the critical path.", "V-7: Unplanned clean downcomers, 18 h, on the critical path."]);
    // The only change it draws is to carry time for discovery, at the share it was here. Whether it could have been known is the person's question.
    expect([scope.next, scope.ask]).toEqual(["Carry time in the plan for discovery: 18 h this event, 35% of the planned hours.", "Carry time in the plan for discovery."]);
    expect(r.questions.map((q) => q.kind).sort()).toEqual(["approver", "known", "stuck"]);
    expect(r.questions.find((q) => q.kind === "known")!.ask).toBe('"Unplanned clean downcomers" (V-7, 18 h): could this have been known before the event? If yes, what do we do next time?');
    expect(r.questions.find((q) => q.kind === "stuck")!.ask).toContain("E-13 Pull Blinds / Torque Flanges had started and sat the 10/28 day shift");
    // Said to be knowable from the drawings: a finding of its own, in the person's words.
    const yes = emptySaved(); yes.answers["known:d1"] = { known: "drawing", note: "Review the vessel drawings for welded internals and plan the hand cleaning. Ask operations what to expect." };
    const k = read(yes).findings.find((f) => f.key === "scope:known:d1")!;
    expect([k.title, k.ask]).toEqual(["Unplanned clean downcomers (V-7) could have been found before the event from the drawings", "Review the vessel drawings for welded internals and plan the hand cleaning."]);
    expect(k.because).toBe("Unplanned clean downcomers (V-7): 18 h found during the event. It could have been found before from the drawings.");
    expect(read(yes).questions.some((q) => q.kind === "known")).toBe(false);
    // Said to be findable only by opening it: time to carry, nothing to have checked.
    const no = emptySaved(); no.answers["known:d1"] = { known: "no" };
    const s2 = read(no).findings.find((f) => f.key === "scope")!;
    expect([s2.ask, s2.next]).toEqual(["Carry time in the plan for discovery.", "Carry time in the plan for discovery: 18 h this event, 35% of the planned hours. Found only by opening the equipment: Unplanned clean downcomers."]);
    expect(read(no).findings.some((f) => f.key.startsWith("scope:known:"))).toBe(false);
  });
  it("work entered as added scope is known work missing from the plan: a planning finding, not discovery", () => {
    const addedRec: DiscoveryRecord = { ...rec, kind: "added" };
    const all3 = all.map((m) => (m.id === "dc" ? { ...m, attributes: { discovery: discoveryAttr(addedRec) } } as Milestone : m));
    const r3 = buildReview({ built, work, notes, look, discoveries: discoveries(all3), tz });
    const p = r3.findings.find((f) => f.key === "planning:added")!;
    expect(p.title).toBe("18 h of known work was added during the event, 18 h of it on the critical path");
    expect([p.ask, p.gap]).toEqual(["Put known work on the plan before scope freeze.", "Known work was not on the work list when the plan was made."]);
    expect(p.because).toBe("Added during the event: clean downcomers on V-7, 18 h on the critical path.");
    // Nothing of it is counted as discovery.
    expect(r3.findings.some((f) => f.key === "scope")).toBe(false);
    expect(r3.found[0].kind).toBe("added");
  });
  it("every category has a finding; safety reads the stand-down", () => {
    expect([...new Set(r.findings.map((f) => f.category))].sort()).toEqual(["contractors", "execution", "materials", "organization", "planning", "records", "safety", "scope"]);
    expect(r.findings.find((f) => f.key === "materials")!.observation).toBe("No job is recorded as waiting on materials.");
    expect(r.findings.find((f) => f.key === "safety")!.rating).toBe("strength");
    expect(r.findings.find((f) => f.key === "planning")!.observation).toContain("held");
  });
  it("equipment still out past the time quoted is a finding; it is never counted as stuck", () => {
    const late = [...notes, note("tv", at(29, 14, 30), "Still waiting for control valve to return. Expected 10/30/26 10:00AM", at(29, 14))];
    const w2 = buildAsBuiltWork({ built, milestones: all, log, notes: late, records: new Map(), companyOf: (c) => c, tz, times, now: Date.parse(at(31, 12)) });
    const r2 = buildReview({ built, work: w2, notes: late, look, discoveries: discoveries(all), tz });
    expect(r2.service[0].stillOut?.said).toContain("Still waiting");
    expect(r2.stuck.some((j) => j.id === "tv")).toBe(false);
    // Its own finding, apart from materials: it is another work order.
    const mat = r2.findings.find((f) => f.key === "materials:service")!;
    expect([mat.rating, mat.title]).toEqual(["opportunity", "TV-006 on the Fuel Gas Line to H-1: still out for service past the time quoted"]);
    expect(r2.findings.find((f) => f.key === "materials")!.observation).not.toMatch(/service/);
    expect(mat.observation).toContain("went out for service as planned");
    expect(mat.next).toBe("When equipment goes out for service, get the return date in writing and check on it the day before it is due.");
  });
});

describe("what a person said, laid over the draft", () => {
  it("an answer gives the shift its reason and closes the question", () => {
    const saved = emptySaved();
    const key = r.questions.find((q) => q.kind === "stuck")!.key;
    saved.answers[key] = { cause: "material", note: "Waiting on studs" };
    const r2 = read(saved);
    expect(r2.stuck.find((j) => j.id === "bl")!.shifts[0]).toMatchObject({ cause: "material", said: "Waiting on studs", answered: true });
    expect(r2.questions.some((q) => q.key === key)).toBe(false);
    expect(r2.metrics.noReasonShifts).toBe(0);
    expect(r2.answeredCount).toBe(1);
  });
  it("kept and changed findings are never overwritten; the records moving after is flagged", () => {
    const saved = emptySaved();
    const exec = r.findings.find((f) => f.key === "execution")!;
    saved.items.execution = { status: "kept", edits: { next: "Delay code on every hold." }, info: ["Flange length was never on the drawing."], basis: basisOf(exec) };
    saved.items.records = { status: "discarded" };
    let r2 = read(saved);
    const e2 = r2.findings.find((f) => f.key === "execution")!;
    expect([e2.status, e2.next, e2.edited, e2.stale]).toEqual(["kept", "Delay code on every hold.", true, false]);
    expect(e2.info).toEqual(["Flange length was never on the drawing."]);
    expect(r2.findings.find((f) => f.key === "records")!.status).toBe("discarded");
    // An answer changes what the records say: the kept finding keeps its
    // words and says the draft has moved.
    saved.answers[r.questions.find((q) => q.kind === "stuck")!.key] = { cause: "material" };
    r2 = read(saved);
    expect(r2.findings.find((f) => f.key === "execution")!.stale).toBe(true);
  });
  it("a finding a person adds stands with the rest, and feeds the lessons register", () => {
    const saved = emptySaved();
saved.added.push({ id: "a1", category: "materials", title: "Flange not ordered", observation: "Weld neck length was not on the drawing; the warehouse question went unanswered.", effect: "$700 to expedite", gap: "No owner for open material questions.", next: "Questions answered in 24 h.", at: 1, by: "me" });
    const r2 = read(saved);
    const f = r2.findings.find((x) => x.key === "added:a1")!;
    expect([f.source, f.status, f.category]).toEqual(["person", "kept", "materials"]);
    // What it cost is the person's own words; the records claim nothing for it.
    expect([f.effect, f.moved]).toEqual(["$700 to expedite", null]);
    expect(lessonOf(f).body).toContain("Flange not ordered. Weld neck length");
    expect(lessonOf(f).nextTime).toBe("Questions answered in 24 h.");
    expect(measuresOf(r2.metrics).find((x) => x.measure.startsWith("Stuck shifts"))!.result).toBe("1 of 2");
  });
  it("targets are whatever a person set: none is assumed", () => {
    expect(r.measures.every((x) => x.target === "Not set" && !x.set)).toBe(true);
    const saved = emptySaved(); saved.targets.stuck = "Under 3";
    const m = read(saved).measures.find((x) => x.key === "stuck")!;
    expect([m.result, m.target, m.set]).toEqual(["2", "Under 3", true]);
    // Suggestions come off this event's own result; none is applied by itself.
    expect(m.picks).toEqual(["0", "1 (half of this event)", "2 (no worse than this event)"]);
  });
  it("reads the event organization recorded on the project", () => {
    const base = { built, work, notes, look, discoveries: discoveries(all), tz };
    // None recorded: it says so and claims nothing about who owned what.
    expect(r.findings.find((f) => f.key === "organization")!.title).toBe("No event organization is recorded on the project");
    expect(r.organization).toBe(null);
    const roles = [{ role: "Turnaround manager", person: "Sam", does: "", required: true }, { role: "Logistics coordinator", person: "", does: "", required: true }];
    const part = buildReview({ ...base, organization: { recorded: true, required: 2, filled: 1, missing: ["Logistics coordinator"], roles } }).findings.find((f) => f.key === "organization")!;
    expect([part.rating, part.title]).toEqual(["opportunity", "Required roles without a named person"]);
    expect(part.observation.split("\n").slice(0, 2)).toEqual(["1 of 2 required roles are named on the project.", "Not named: Logistics coordinator."]);
    const full = buildReview({ ...base, organization: { recorded: true, required: 2, filled: 2, missing: [], roles: roles.map((x) => ({ ...x, person: x.person || "Lee" })) } }).findings.find((f) => f.key === "organization")!;
    expect([full.rating, full.title]).toEqual(["strength", "Every required role has a named person"]);
    expect(full.evidence).toEqual(["Turnaround manager: Sam", "Logistics coordinator: Lee"]);
  });
  it("never cuts a sentence short", () => {
    const long = "Existing blind flange on first deck was swapped out because it was modified and didn't meet refinery standards.";
    const rec2: DiscoveryRecord = { ...rec, id: "d2", what: long, impact: { ...rec.impact, hours: 2 } };
    const flange = ms({ id: "bf", parentId: "wt", name: "Unbolt flange on first deck and inspect and swap", plannedStartAt: at(29, 7), plannedAt: at(29, 9), actualStartAt: at(29, 7), actualAt: at(29, 9), responsibleParty: "Schultz", durationHours: 2, attributes: { discovery: discoveryAttr(rec2) } });
    const all2 = [...all, flange];
    const kids2 = new Map(kids); kids2.set("wt", [...(kids.get("wt") ?? []), flange]);
    const b2 = buildAsBuilt({ milestones: all2, childrenByParent: kids2, tz });
    const w2 = buildAsBuiltWork({ built: b2, milestones: all2, log: [...log, row("bf", at(29, 9), 0, 100, "completed", "planned")], notes, records: new Map(), companyOf: (c) => c, tz, times, now: Date.parse(at(31, 12)) });
    const r2 = buildReview({ built: b2, work: w2, notes, look, discoveries: discoveries(all2), tz });
    const text = r2.findings.map((f) => `${f.observation}\n${f.evidence.join("\n")}`).join("\n") + r2.questions.map((q) => q.ask).join("\n");
    expect(text).toContain("V-7: Existing blind flange on first deck was swapped out because it was modified and didn't meet refinery standards, 2 h, on the critical path.");
    expect(text).not.toMatch(/\.\.\.|and \d+ more/);
  });
  it("names a job by its tag, without the bracketed detail", () => {
    expect(jobWord({ name: "PSV-021 - E-13 Overhead (Swap Existing with the New Model)", order: "PSVs" })).toBe("PSV-021 - E-13 Overhead");
    expect(jobWord({ name: "Install Bundle", order: "E-12 - Feed Exchanger" })).toBe("E-12 Install Bundle");
    expect(jobWord({ name: "Hydroblast piping", order: "Clean fuel gas header" })).toBe("Hydroblast piping, Clean fuel gas header");
    // A bracket typed without its pair doesn't hang off the name.
    expect(jobWord({ name: "PSV-021 - E-13 Fractanator Overhead Air Condenser)", order: "PSVs" })).toBe("PSV-021 - E-13 Fractanator Overhead Air Condenser");
  });
});

describe("the files open on the point of the meeting", () => {
  const o = { project: "Transmix Turnaround", phase: "Phase 1", tz, preparedBy: null, date: "November 13, 2026" };
  // A person accepted every finding the app drafted.
  const accepted = emptySaved();
  for (const f of r.findings) if (f.rating === "gap" || f.rating === "opportunity") accepted.items[f.key] = { status: "kept" };
  const rk = read(accepted);
  it("what the records show cost the late finish is on the slide without a click; the rest waits for a person", () => {
    const deck = deckSlides(r, o);
    expect(deck.map((x) => x.kicker.split(" · ")[0])).toEqual(["Post-event review", "1", "2", "3"]);
    const bk = bookOf(r, "Phase 1", tz);
    // On by default: causes (materials, planning, scope, a crew) that cost hours of the late finish.
    const on = r.findings.filter((f) => f.auto).map((f) => f.key);
    expect(on.length).toBeGreaterThan(0);
    expect(r.findings.filter((f) => f.auto).every((f) => (f.moved ?? 0) >= 2 && ["materials", "planning", "scope", "contractors"].includes(f.category))).toBe(true);
    expect(bk.actions.map((a) => a.key).sort()).toEqual([...on].sort());
    // Records, execution and the rest wait for a person.
    expect(r.findings.find((f) => f.key === "execution")!.status).toBe("draft");
    expect(pointOf(r, "Phase 1", tz).pending.length).toBeGreaterThan(2);
    // Taken off by a person, it stays off.
    const off = emptySaved(); off.items[on[0]] = { status: "draft" };
    expect(bookOf(read(off), "Phase 1", tz).actions.map((a) => a.key)).not.toContain(on[0]);
  });
  it("the deck runs in the review's order: the score, the seven areas, the action plan. Nothing else", () => {
    const deck = deckSlides(rk, o);
    expect(deck.map((x) => x.kicker)).toEqual(["Post-event review", "1 · The score: plan against actual", "2 · What went well, what did not, and why", "3 · What we do about it"]);
    const [, score, areas, plan] = deck.map((x) => x.body);
    // The score: each target with its plan, its actual and a verdict; the tally on top.
    expect(score.k === "table" && score.head).toEqual(["Measure", "Target", "Actual", "Result"]);
    expect(score.k === "table" && score.lead).toMatch(/^Where the 46 h went: PSVs 22 h/);
    expect(score.k === "table" && score.rows.map((row) => row[0])).toEqual(["Duration", "Planned work", "Added work", "Man-hours", "Cost", "Safety", "Quality"]);
    expect(score.k === "table" && score.tags![0]).toEqual({ text: "Missed", tone: "bad" });
    expect(score.k === "table" && score.rows[0][3]).toBe("46 h late");
    expect(score.k === "table" && score.tally!.map((t) => t.label)).toContain("not measured");
    // The seven areas, by name and in order, each with what went well, what did not, the root cause and the action.
    expect(areas.k === "table" && areas.head).toEqual(["Area", "What went well", "What did not", "Root cause", "Action"]);
    expect(areas.k === "table" && areas.rows.map((row) => row[0])).toEqual(["Safety", "Organization", "Planning", "Contractors", "Costs", "Logistics", "Execution"]);
    // The action plan answers the six questions.
    expect(plan.k === "table" && plan.head).toEqual(["What we will do", "How it will be done", "Benefit", "Who", "By", "Cost"]);
    expect(plan.k === "table" && plan.rows[0].slice(3)).toEqual(["Not set", "Not set", "Not set"]);
    const first = bookOf(rk, "Phase 1", tz).actions[0];
    expect([first.n, first.what, first.benefit]).toEqual([1, "Name each day's hand-offs between crews at the shift meeting.", "PSV-021 - E-13 Overhead waited a shift on another crew."]);
    expect(plan.k === "table" && plan.rows.every((row) => row[0].length <= 125 && row[2].length <= 175)).toBe(true);
    const titles = deck.map((x) => `${x.kicker} ${x.title}`).join(" | ");
    expect(titles).not.toMatch(/backup|definition|closure plan|roadmap|proposed organization|decisions|did not move/i);
    // The records stay in the report. Service is a planned step there, not stuck work.
    const waited = reportBlocks(rk, o).find((x) => x.k === "table" && x.head[2] === "What happened");
    expect(waited?.k === "table" && waited.rows.find((row) => row[0].startsWith("TV-006"))![2]).toBe("Out for service (planned)");
  });
  it("a line the records can't fill says so and carries how to set it up", () => {
    const sc = scoreOf(rk, tz);
    // Quality is read from the work: a test written as failed and done again. None here, and no target yet.
    const q = sc.rows.find((x) => x.key === "quality")!;
    expect([q.plan, q.actual, q.verdict, q.guide]).toEqual(["Target not set", "No failed test written on the work", "untargeted", "quality"]);
    expect(q.means).toMatch(/failed pressure tests/);
    expect(q.picks).toContain("0 failed pressure tests");
    // A target set with one tap is judged against what the records show.
    const two = [{ id: "t1", step: "Tube Side Hydro", order: "E-12 - Exchanger", said: "Leaks on shell side preventing tube side." }, { id: "t2", step: "Shell Side Hydro", order: "E-12 - Exchanger", said: "Starting filling for re-test" }];
    const qq = scoreOf({ ...rk, failedTests: two }, tz, { entries: { quality: { plan: "0 failed pressure tests" } } }).rows.find((x) => x.key === "quality")!;
    expect([qq.actual, qq.verdict, qq.result]).toEqual(["2 failed tests, done again: E-12 Tube Side Hydro, E-12 Shell Side Hydro", "missed", "Over target"]);
    // Safety: the shift reports' incident line, and stand-downs written on the work.
    const sf = scoreOf(rk, tz, { entries: { safety: { plan: "0 recordables" } } }).rows.find((x) => x.key === "safety")!;
    expect([sf.plan, sf.verdict]).toEqual(["0 recordables", "unmeasured"]);
    expect(sf.picks).toEqual(["0 recordables", "0 recordables, 0 first aids"]);
    expect(GUIDES.quality.steps.length).toBeGreaterThan(4);
    expect(GUIDES.quality.steps.join(" ")).toMatch(/pressure tests/);
    // Head counts are said in shifts, the way a person counts them.
    const mh = sc.rows.find((x) => x.key === "manhours")!;
    expect(mh.actual).toMatch(/^Head count on \d+ of \d+ shifts?$/);
    expect(mh.guide).toBe("manhours");
    expect(GUIDES.manhours.steps.join(" ")).toMatch(/rate sheet/);
    // What a person enters is what shows, with their verdict.
    const entered = scoreOf(rk, tz, { entries: { quality: { plan: "0 failed pressure tests", actual: "1 failed pressure test", verdict: "missed" } } }).rows.find((x) => x.key === "quality")!;
    expect([entered.plan, entered.actual, entered.verdict, entered.guide]).toEqual(["0 failed pressure tests", "1 failed pressure test", "missed", undefined]);
    // Money and man-hours are judged only when they were recorded.
    const paid = scoreOf(rk, tz, { costs: { budget: 500000, spent: 520000, committed: 0 } }).rows.find((x) => x.key === "cost")!;
    expect([paid.verdict, paid.result]).toEqual(["missed", "$20,000 over"]);
    expect(scoreOf(rk, tz, { costs: { budget: 500000, spent: 0, committed: 53000 } }).rows.find((x) => x.key === "cost")!.verdict).toBe("unmeasured");
    const text = JSON.stringify([deckSlides(rk, o), reportBlocks(rk, o), rk.measures]);
    expect(text).not.toMatch(/crew-shift/i);
  });
  it("who, by what date and cost are a person's to set, and show once set; a closed action says so", () => {
    const sv = emptySaved();
    for (const f of r.findings) if (f.rating === "gap" || f.rating === "opportunity") sv.items[f.key] = { status: "kept" };
    const k = bookOf(rk, "Phase 1", tz).actions[0].key;
    sv.items[k] = { status: "kept", edits: { owner: "Area coordinator", due: "Before scope freeze", cost: "$0" }, done: true };
    const a = bookOf(read(sv), "Phase 1", tz).actions.find((x) => x.key === k)!;
    expect([a.who, a.by, a.cost, a.done]).toEqual(["Area coordinator", "Before scope freeze", "$0", true]);
  });
  it("the report: the headline, the score, the seven areas, the action plan, then each finding with its record", () => {
    const blocks = reportBlocks(rk, o);
    expect(blocks.filter((x) => x.k === "h1").slice(0, 5).map((x) => (x.k === "table" ? "" : x.text))).toEqual(["1. Phase 1 finished 46 h late. 22 h of it was PSVs.", "2. The score: plan against actual", "3. What went well, what did not, and why", "4. The action plan", "5. Each finding, with the record behind it"]);
    const plan = blocks.find((x) => x.k === "table" && x.head[1] === "What we will do");
    expect(plan?.k === "table" && plan.rows[0].slice(0, 2)).toEqual(["1", "Name each day's hand-offs between crews at the shift meeting."]);
    expect(blocks.some((x) => x.k === "p" && x.lead === "How it is done well (Planning): ")).toBe(true);
    expect(blocks.some((x) => x.k === "p" && x.lead === "Root cause: ")).toBe(true);
    // How to set up what was not measured is laid out step by step at the back.
    expect(blocks.some((x) => x.k === "h2" && x.text === "A quality plan")).toBe(true);
    // The work that set the finish has one finding; nothing lists its steps again.
    expect(blocks.some((x) => x.k === "h1" && /stayed open longest/.test(x.text))).toBe(false);
    expect(blocks.some((x) => x.k !== "table" && /12 months|closure plan/i.test(x.text))).toBe(false);
  });
  it("a person's own finding goes on the slide by its own one-line title and cost", () => {
    const saved = emptySaved();
    saved.added.push({ id: "a1", category: "materials", title: "Flange not ordered: the length was not on the drawing", observation: "The warehouse asked and got no answer.", effect: "$700 to expedite", next: "Every material fully specified before scope freeze. Open questions answered in 24 hours.", at: 1, by: "me" });
    const c = pointOf(read(saved), "Phase 1", tz).conclusions.find((x) => x.key === "added:a1")!;
    expect([c.ask, c.because]).toEqual(["Every material fully specified before scope freeze.", "Flange not ordered: the length was not on the drawing ($700 to expedite)."]);
  });
});

describe("hours a step was open are never called hours of work", () => {
  it("says open from start to finish, with the shifts progress was logged on (the as-built record)", () => {
    const o = { project: "Transmix Turnaround", phase: "Phase 1", tz, preparedBy: null, date: "November 13, 2026" };
    const accepted = emptySaved();
    for (const f of r.findings) accepted.items[f.key] = { status: "kept" };
    const rk = read(accepted);
    const text = [
      ...rk.findings.map((f) => `${f.title} ${f.observation} ${f.why} ${f.because} ${f.effect}`), ...rk.qa.map((x) => `${x.q} ${x.a}`),
      ...deckSlides(rk, o).map((x) => JSON.stringify(x)), ...reportBlocks(rk, o).map((x) => JSON.stringify(x)),
    ].join("\n");
    expect(text).not.toMatch(/\btook \d|\btook about \d|ran long|"Took"/);
    expect(rk.finish!.steps[0]).toMatchObject({ tookH: 99, shifts: 4 });
    expect(text).toContain("open 99 h from start to finish, with progress logged on 4 shifts; planned as 8 h of work");
  });
});
