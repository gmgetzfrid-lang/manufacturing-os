import { describe, it, expect } from "vitest";
import type { Milestone, MilestoneNote } from "@/types/schema";
import { buildAsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork } from "@/lib/asBuiltWork";
import { buildLookBack } from "@/lib/lookBack";
import { discoveries, discoveryAttr, type DiscoveryRecord } from "@/lib/discovery";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { buildReview, causeOfText, emptySaved, basisOf, decisionsOf, measuresOf, lessonOf, jobWord, shiftWord, type ReviewSaved } from "@/lib/postEventReview";

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
    // Sent out: both day shifts it sat. Nights between day work don't count.
    expect(shiftsOf("tv")).toEqual([["10/27 day", "offsite"], ["10/28 day", "offsite"]]);
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
    expect([m.stuckJobs, m.stuckShifts, m.readyJobs, m.readyShifts]).toEqual([3, 4, 1, 2]);
    expect(m.byCause.map((c) => [c.cause, c.shifts])).toEqual([["offsite", 2], ["other_crew", 1], ["crew_elsewhere", 1]]);
    expect(m.noReasonShifts).toBe(1);
    expect(r.byShift.map((c) => [shiftWord(c.key), c.stuck, c.ready])).toEqual([["10/27 day", 1, 1], ["10/28 day", 2, 1], ["10/29 day", 1, 0]]);
    expect([m.shiftsWithStuck, m.leastAtOnce, m.mostAtOnce]).toEqual([3, 1, 3]);
    // Labor hours are left out without head counts, never assumed.
    expect(m.labor).toBe(null);
    expect(m.addedSteps).toBe(1);
  });
  it("names the found work on the critical path, and asks for what was never written", () => {
    const scope = r.findings.find((f) => f.key === "scope")!;
    expect(scope.rating).toBe("gap");
    // One fact a line, each a whole sentence.
    expect(scope.observation.split("\n")).toEqual(["1 activity was added from 1 finding: 18 h of work on a 52 h plan (35% more), by the schedule's estimates.", "Critical path, V-7: Unplanned clean downcomers. About 18 h."]);
    expect(r.questions.map((q) => q.kind).sort()).toEqual(["approver", "stuck"]);
    expect(r.questions.find((q) => q.kind === "stuck")!.ask).toContain("E-13 Pull Blinds / Torque Flanges had started and sat the 10/28 day shift");
  });
  it("every category has a finding with the practice and how it closes; safety reads the stand-down", () => {
    expect(r.findings.map((f) => f.category).sort()).toEqual(["contractors", "execution", "materials", "organization", "planning", "records", "safety", "scope"]);
    const mat = r.findings.find((f) => f.key === "materials")!;
    expect(mat.observation.split("\n")).toEqual(["TV-006 on the Fuel Gas Line to H-1: sat 2 shifts (10/27 day, 10/28 day) waiting on off-site repair or calibration.", "No materials register was kept for this event."]);
    expect(mat.next).toContain("Materials register");
    expect(r.findings.find((f) => f.key === "safety")!.rating).toBe("strength");
    expect(r.findings.find((f) => f.key === "planning")!.observation).toContain("held");
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
    saved.added.push({ id: "a1", category: "materials", title: "Flange not ordered", observation: "Weld neck length was not on the drawing; the warehouse question went unanswered. $700 expedite.", gap: "No owner for open material questions.", next: "Questions answered in 24 h.", at: 1, by: "me" });
    const r2 = read(saved);
    const f = r2.findings.find((x) => x.key === "added:a1")!;
    expect([f.source, f.status, f.category]).toEqual(["person", "kept", "materials"]);
    expect(lessonOf(f).body).toContain("Flange not ordered. Weld neck length");
    expect(lessonOf(f).nextTime).toBe("Questions answered in 24 h.");
    expect(decisionsOf(r2.findings).length).toBeGreaterThan(2);
    expect(measuresOf(r2.metrics).find((x) => x.measure.startsWith("Stuck shifts"))!.result).toBe("1 of 4");
  });
  it("targets are whatever a person set: none is assumed", () => {
    expect(r.measures.every((x) => x.target === "Not set" && !x.set)).toBe(true);
    const saved = emptySaved(); saved.targets.stuck = "Under 3";
    const m = read(saved).measures.find((x) => x.key === "stuck")!;
    expect([m.result, m.target, m.set]).toEqual(["4", "Under 3", true]);
    // Suggestions come off this event's own result; none is applied by itself.
    expect(m.picks).toEqual(["0", "2 (half of this event)", "4 (no worse than this event)"]);
  });
  it("reads the event organization recorded on the project", () => {
    const base = { built, work, notes, look, discoveries: discoveries(all), tz };
    // None recorded: it says so, and points at what the other categories show.
    expect(r.findings.find((f) => f.key === "organization")!.observation).toContain("No event organization is recorded");
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
    expect(text).toContain("Critical path, V-7: Existing blind flange on first deck was swapped out because it was modified and didn't meet refinery standards. About 2 h.");
    expect(text).not.toMatch(/\.\.\.|and \d+ more/);
  });
  it("names a job by its tag, without the bracketed detail", () => {
    expect(jobWord({ name: "PSV-021 - E-13 Overhead (Swap Existing with the New Model)", order: "PSVs" })).toBe("PSV-021 - E-13 Overhead");
    expect(jobWord({ name: "Install Bundle", order: "E-12 - Feed Exchanger" })).toBe("E-12 Install Bundle");
    expect(jobWord({ name: "Hydroblast piping", order: "Clean fuel gas header" })).toBe("Hydroblast piping, Clean fuel gas header");
  });
});
