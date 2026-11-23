import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { Milestone, MilestoneNote } from "@/types/schema";
import { buildAsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork } from "@/lib/asBuiltWork";
import { buildLookBack } from "@/lib/lookBack";
import { discoveries } from "@/lib/discovery";
import { inPhase, type ProjectPhase } from "@/lib/projectPhases";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { buildReview, dayAt, loadDays, pointOf, type ReviewInput } from "@/lib/postEventReview";
import { linksOf, partyLoads } from "@/lib/partyLoad";
import { deckSlides, loadJobRows, reportBlocks } from "@/lib/reviewFiles";

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00", breaks: [] };
// Mon Oct 26 2026, local times (PDT, -7). Hours past 24 run into the next day.
const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h + 7, m)).toISOString();
const H = 3_600_000;
const order = (id: string, name: string): Milestone => ({ id, name, status: "completed", isSummary: true } as unknown as Milestone);
const step = (id: string, parentId: string, name: string, party: string, plan: [string, string], act: [string, string], dependsOn: string[] = []): Milestone =>
  ({ id, parentId, name, status: "completed", percentComplete: 100, responsibleParty: party, plannedStartAt: plan[0], plannedAt: plan[1], baselineStartAt: plan[0], baselineFinishAt: plan[1], actualStartAt: act[0], actualAt: act[1], durationHours: (Date.parse(plan[1]) - Date.parse(plan[0])) / H, dependsOn } as unknown as Milestone);

function review(all: Milestone[], extra: Partial<ReviewInput> = {}, notes: MilestoneNote[] = []) {
  const kids = new Map<string, Milestone[]>();
  for (const m of all) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
  const log: ProgressLogRow[] = all.filter((m) => !m.isSummary).flatMap((m) => [
    { milestone_id: m.id!, at: m.actualStartAt!, old_status: "planned", new_status: "in_progress", old_percent: 0, new_percent: 10 },
    { milestone_id: m.id!, at: m.actualAt!, old_status: "in_progress", new_status: "completed", old_percent: 10, new_percent: 100 },
  ] as ProgressLogRow[]);
  const built = buildAsBuilt({ milestones: all, childrenByParent: kids, tz });
  const now = Date.parse(at(31, 12));
  const work = buildAsBuiltWork({ built, milestones: all, log, notes, records: new Map(), companyOf: (c) => c, tz, times, now });
  const look = buildLookBack({ milestones: all, notes, discoveries: discoveries(all), now, tz });
  const dependsOn = new Map(all.filter((m) => m.id).map((m) => [m.id!, m.dependsOn ?? []]));
  return buildReview({ built, work, notes, look, discoveries: discoveries(all), tz, dependsOn, links: linksOf(all, kids), log, ...extra });
}

// Seven exchangers, all pulled by 6 AM Monday. The plan has the cleaning
// crew on three at a time (three, then three, then one: never more than 3
// at once). It worked three at a time, but each took 8 h, not 4, so the
// rest waited for it. Each is closed up the moment it is clean, and the
// unit starts up when the last is closed.
const plan = (i: number): [string, string] => (i < 3 ? [at(26, 6), at(26, 10)] : i < 6 ? [at(26, 10), at(26, 14)] : [at(26, 14), at(26, 18)]);
const act = (i: number): [string, string] => (i < 3 ? [at(26, 6), at(26, 14)] : i < 6 ? [at(26, 14), at(26, 22)] : [at(26, 22), at(26, 30)]);
const seven: Milestone[] = [];
for (let i = 0; i < 7; i++) {
  const n = i + 1, o = `w${n}`;
  const [, cEnd] = act(i);
  const closeAt = Date.parse(cEnd);
  seven.push(order(o, `E-${n} - Exchanger ${n}`),
    step(`p${n}`, o, "Pull Bundle", "Mech", [at(26, 4), at(26, 6)], [at(26, 4), at(26, 6)]),
    step(`c${n}`, o, "Hydroblast Bundle", "Clean", plan(i), act(i), [`p${n}`]),
    step(`k${n}`, o, "Close Up", "Mech", [plan(i)[1], new Date(Date.parse(plan(i)[1]) + 2 * H).toISOString()], [cEnd, new Date(closeAt + 2 * H).toISOString()], [`c${n}`]));
}
const startUp = [order("su", "Unit - Start-Up"), step("s1", "su", "Start-up", "Ops", [at(26, 20), at(26, 22)], [at(26, 32), at(26, 34)])];
// Another party's job, ready with its planned start come, while that party had nothing going: nobody on it.
const insp = [order("w8", "E-8 - Exchanger 8"),
  step("p8", "w8", "Pull Bundle", "Mech", [at(26, 4), at(26, 6)], [at(26, 4), at(26, 6)]),
  step("i8", "w8", "Inspect Tubes", "Inspector", [at(26, 6), at(26, 8)], [at(26, 12), at(26, 14)], ["p8"])];
// A job ready long before the plan had it start, started on its plan: the plan said later, not a wait.
const paint = [order("w9", "E-9 - Exchanger 9"),
  step("p9", "w9", "Pull Bundle", "Mech", [at(26, 4), at(26, 6)], [at(26, 4), at(26, 6)]),
  step("t9", "w9", "Coat Channel", "Paint", [at(26, 18), at(26, 20)], [at(26, 18), at(26, 20)], ["p9"])];
const r = review([...seven, ...startUp, ...insp, ...paint]);
const clean = r.loads.find((L) => L.party === "Clean")!;

describe("who held work up: a party with more ready than it was planned to work", () => {
  it("counts the planned number from the schedule, and the most ready at once", () => {
    expect([clean.planned.n, clean.planned.from]).toEqual([3, "schedule"]);
    expect([clean.peak.open, clean.peak.at, clean.peak.working]).toEqual([7, Date.parse(at(26, 6)), 3]);
    expect(clean.mostWorking.n).toBe(3);
    // Open is never less than being worked, at any point.
    expect(clean.series.every((p) => p.open >= p.working)).toBe(true);
  });
  it("seven ready together, three planned at once: four waited for the crew, 20 h in all", () => {
    expect(clean.waited.map((j) => [j.id, j.partyH])).toEqual([["c7", 8], ["c4", 4], ["c5", 4], ["c6", 4]]);
    expect(clean.partyH).toBe(20);
    // The time before each one's planned start was the plan saying later, not a wait.
    expect(clean.jobs.find((j) => j.id === "c7")).toMatchObject({ laterH: 8, partyH: 8, nobodyH: 0 });
    expect(clean.jobs.find((j) => j.id === "c4")).toMatchObject({ laterH: 4, partyH: 4, nobodyH: 0 });
    expect(clean.jobs.filter((j) => ["c1", "c2", "c3"].includes(j.id)).every((j) => j.partyH === 0 && j.nobodyH === 0 && j.laterH === 0)).toBe(true);
  });
  it("follows the jobs after them: who was held up, by how much, and how much of the late finish came through", () => {
    // Each close-up started the moment its cleaning was done, and the start-up the moment the last close-up was.
    expect(clean.down.held.map((h) => [h.id, h.by, h.hours, h.depth])).toEqual([["k7", "c7", 8, 1], ["k4", "c4", 4, 1], ["k5", "c5", 4, 1], ["k6", "c6", 4, 1], ["s1", "c7", 8, 2]]);
    // The start-up waited 8 h on E-7 after E-4 to E-6 were done, and they were done 4 h after its planned start: 12 h late.
    expect(r.finish!.lateH).toBe(12);
    expect(r.finish!.delay.map((d) => d.hours)).toEqual([8, 4]);
    expect(r.finish!.delay[0].order).toBe("E-7 - Exchanger 7");
    // Without the waits E-7 is closed by midnight, so the start-up could begin 8 h sooner: 8 of the 12 h.
    expect(clean.down.finishH).toBe(8);
    expect(clean.down.parts).toEqual([{ order: "E-7 - Exchanger 7", hours: 8 }]);
  });
  it("says it in a sentence from those numbers, with the chart, the jobs and the late hours that came through", () => {
    const f = r.findings.find((x) => x.key === "contractors:load:clean")!;
    expect(f.title).toBe("Clean: 7 jobs ready at once against 3 planned");
    expect(f.observation.split("\n").slice(0, 3)).toEqual([
      `Clean was planned to work 3 jobs at once (from the schedule). On ${dayAt(Date.parse(at(26, 6)), tz)}, 7 were ready.`,
      "4 jobs waited while Clean was working 3 or more, 20 h in all, and held up 5 jobs after them (E-7 Close Up; E-4 Close Up; E-5 Close Up; and 2 more).",
      "8 h of the 12 h late finish came through here (E-7).",
    ]);
    expect(f.load).toBe(clean);
    expect(f.finishH).toBe(8);
    expect(r.findings[0].key).toBe("contractors:load:clean");
    // Where the late hours went: E-7's piece is the crew's; E-4's piece is not explained by anything in the records.
    expect(r.lateBars.map((b) => [b.label, b.hours, b.segs.map((x) => [x.key, x.hours])])).toEqual([["E-7", 8, [["contractors:load:clean", 8]]], [r.lateBars[1].label, 4, [[null, 4]]]]);
    expect(r.lateBars[1].label).toMatch(/^E-[456]$/);
    expect(f.ask).toBe("Plan Clean for the 7 jobs that were ready at once, not 3.");
    // The jobs table: what each held up right after it.
    expect(loadJobRows(clean, tz).map((row) => [row[0], row[3], row[4]])).toEqual([["E-7 Hydroblast Bundle", "8 h", "E-7 Close Up, 8 h; Start-up on Unit - Start-Up, 8 h"], ["E-4 Hydroblast Bundle", "4 h", "E-4 Close Up, 4 h"], ["E-5 Hydroblast Bundle", "4 h", "E-5 Close Up, 4 h"], ["E-6 Hydroblast Bundle", "4 h", "E-6 Close Up, 4 h"]]);
    // Day by day, the chart as a table.
    expect(loadDays(clean, tz).map((d) => [d.day, d.open, d.working, d.planned, d.waitedH])).toEqual([["2026-10-26", 7, 3, 3, 20], ["2026-10-27", 1, 1, 3, 0]]);
  });
  it("a planned number a person sets is used, and said to be theirs", () => {
    const r2 = review([...seven, ...startUp], { atOnce: { Clean: 7 } });
    const L = r2.loads.find((x) => x.party === "Clean")!;
    expect(L.planned).toMatchObject({ n: 7, from: "set", sched: 3 });
    // With room for all seven, none waited for the crew: the same hours are now nobody on them.
    expect([L.partyH, L.nobodyH]).toEqual([0, 20]);
    expect(r2.findings.some((x) => x.key === "contractors:load:clean")).toBe(false);
    expect(r2.findings.find((x) => x.key === "execution:nobody")!.observation).toContain("By party: Clean 20 h (4 jobs).");
    // Set to five: still fewer than were ready, so its card stays where the number can be changed, and says what the record shows.
    const r5 = review([...seven, ...startUp], { atOnce: { Clean: 5 } });
    const f5 = r5.findings.find((x) => x.key === "contractors:load:clean")!;
    expect(f5.title).toBe("Clean: 7 jobs ready at once against 5 planned");
    expect(f5.observation.split("\n")[1]).toBe("No job waited while Clean was working 5 or more: it worked 3 at most.");
    expect(f5.ask).toBe("Have Clean work 5 at once when its work is ready: it worked 3 at most while 7 were ready.");
  });
});

describe("ready work with nobody on it, and the plan saying later", () => {
  it("a ready job whose party had nothing going is nobody on it, not a wait for the party", () => {
    const L = r.loads.find((x) => x.party === "Inspector")!;
    expect(L.jobs.map((j) => [j.id, j.partyH, j.nobodyH, j.laterH])).toEqual([["i8", 0, 6, 0]]);
    expect(L.waited).toEqual([]);
    expect(r.findings.some((f) => f.key === "contractors:load:inspector")).toBe(false);
    const f = r.findings.find((x) => x.key === "execution:nobody")!;
    expect(f.idle!.groups.map((g) => [g.party, g.step, g.hours])).toEqual([["Inspector", "Inspect Tubes", 6]]);
    expect(f.title).toBe("Ready work sat 6 h with nobody on it");
    // The one question: nothing in the records says why.
    expect(r.questions.find((q) => q.findingKey === f.key)!.ask).toBe("Nothing written says why these sat. The longest: E-8 Inspect Tubes, 6 h while Inspector had nothing going. What kept them from starting?");
  });
  it("a job ready before its planned start and started on plan is counted as neither", () => {
    const L = r.loads.find((x) => x.party === "Paint")!;
    expect(L.jobs.map((j) => [j.id, j.partyH, j.nobodyH, j.laterH])).toEqual([["t9", 0, 0, 12]]);
    expect(r.findings.filter((f) => f.load || f.idle).some((f) => /Paint|Coat/.test(`${f.title} ${f.observation} ${JSON.stringify(f.jobs)}`))).toBe(false);
  });
  it("a wait with a reason written on the job is put down to that, not to the party", () => {
    const said: MilestoneNote[] = [{ milestoneId: "i8", kind: "note", body: "Waiting on gaskets from the warehouse", createdAt: at(26, 7), happenedAt: at(26, 7), createdBy: "u", orgId: "o" }];
    const L = review([...insp], {}, said).loads.find((x) => x.party === "Inspector")!;
    expect(L.jobs.map((j) => [j.id, j.partyH, j.nobodyH, j.reasonH, j.said])).toEqual([["i8", 0, 0, 6, "Waiting on gaskets from the warehouse"]]);
    expect(L.idle).toEqual([]);
  });
});

describe("when a job is ready", () => {
  it("a link to the same party's job on other equipment is its crew's order, not work the job needs", () => {
    // B's cleaning is linked to A's cleaning (the crew's planned order); B's own pull was done at 6.
    const ms = [order("a", "E-1 - A"), order("b", "E-2 - B"),
      step("pa", "a", "Pull", "Mech", [at(26, 4), at(26, 6)], [at(26, 4), at(26, 6)]), step("ca", "a", "Clean", "Clean", [at(26, 6), at(26, 10)], [at(26, 6), at(26, 16)], ["pa"]),
      step("pb", "b", "Pull", "Mech", [at(26, 4), at(26, 6)], [at(26, 4), at(26, 6)]), step("cb", "b", "Clean", "Clean", [at(26, 6), at(26, 10)], [at(26, 16), at(26, 20)], ["ca"])];
    const kids = new Map<string, Milestone[]>([["a", ms.slice(2, 4)], ["b", ms.slice(4, 6)]]);
    const built = buildAsBuilt({ milestones: ms, childrenByParent: kids, tz });
    const read = partyLoads({ built, partyOf: (id) => ms.find((m) => m.id === id)!.responsibleParty ?? "", links: linksOf(ms, kids) });
    const cb = read.parties.find((L) => L.party === "Clean")!.jobs.find((j) => j.id === "cb")!;
    expect([cb.ready, cb.readyBy, cb.after?.id]).toEqual([Date.parse(at(26, 6)), "before", "pb"]);
    expect(cb.nobodyH + cb.partyH).toBe(10);
  });
  it("a link to a group (all the maintenance work) means every job in it", () => {
    const grp = order("g", "Maintenance");
    const ms = [grp, order("x", "E-1 - X"), order("y", "Unit - Start-Up"),
      { ...step("x1", "x", "Close", "Mech", [at(26, 6), at(26, 8)], [at(26, 6), at(26, 18)]), parentId: "x" } as Milestone,
      step("y1", "y", "Pull Blinds", "Mech", [at(26, 8), at(26, 9)], [at(26, 18), at(26, 19)], ["x"])];
    const kids = new Map<string, Milestone[]>([["x", [ms[3]]], ["y", [ms[4]]]]);
    const links = linksOf(ms, kids);
    expect(links.get("y1")).toEqual(["x1"]);
  });
});

// The real project: Transmix-1/2 Turnaround, read from the records the harness saved.
const DIR = "/tmp/claude-0/-home-user-manufacturing-os/ca95d225-1b34-5e1f-b643-ed3907f5c177/scratchpad/live";
const camel = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
describe.skipIf(!existsSync(`${DIR}/ms.json`))("on the Transmix records", () => {
  const raw = existsSync(`${DIR}/ms.json`) ? JSON.parse(readFileSync(`${DIR}/ms.json`, "utf8")) as Array<Record<string, unknown>> : [];
  const all = raw.map((x) => ({ ...camel(x), dependsOn: x.depends_on ?? [], attributes: x.attributes ?? {} }) as unknown as Milestone);
  const notesAll = existsSync(`${DIR}/notes.json`) ? (JSON.parse(readFileSync(`${DIR}/notes.json`, "utf8")) as Array<Record<string, unknown>>).map((x) => camel(x) as unknown as MilestoneNote) : [];
  const logAll = existsSync(`${DIR}/log.json`) ? JSON.parse(readFileSync(`${DIR}/log.json`, "utf8")) as ProgressLogRow[] : [];
  const proj = existsSync(`${DIR}/proj.json`) ? (JSON.parse(readFileSync(`${DIR}/proj.json`, "utf8")) as Array<Record<string, unknown>>)[0] : {};
  const phases = ((proj.shift_times ?? {}) as { phases?: ProjectPhase[] }).phases ?? [];
  const phase = (name: string) => {
    const p = phases.find((x) => x.name === name)!;
    const mine = inPhase(all, phases, p.id);
    const kids = new Map<string, Milestone[]>();
    for (const m of mine) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
    const ids = new Set(mine.map((m) => m.id));
    const notes = notesAll.filter((n) => ids.has(n.milestoneId)), log = logAll.filter((x) => ids.has(x.milestone_id));
    const now = Date.parse("2026-11-20T00:00:00Z");
    const built = buildAsBuilt({ milestones: mine, childrenByParent: kids, phases, tz });
    const work = buildAsBuiltWork({ built, milestones: mine, log, notes, records: new Map(), companyOf: (c) => c, tz, times, now });
    const look = buildLookBack({ milestones: mine, notes, discoveries: discoveries(mine), now, tz, log });
    const cal = new Map(mine.map((m) => [m.id!, String(((m.attributes ?? {}) as Record<string, unknown>).work_calendar ?? "") || null]));
    return buildReview({ built, work, notes, look, discoveries: discoveries(mine), tz, log, dependsOn: new Map(mine.map((m) => [m.id!, m.dependsOn ?? []])), links: linksOf(mine, kids), calendarOf: (id) => cal.get(id) ?? null });
  };
  it("Phase 1: Ancon was planned for 2 at once from the schedule, 6 were ready on Tue Oct 27, and 3 waited 23.5 h", () => {
    const r1 = phase("Phase 1");
    const A = r1.loads.find((L) => L.party === "Ancon")!;
    expect([A.planned.n, A.planned.from, A.peak.open, dayAt(A.peak.at, tz), A.peak.working]).toEqual([2, "schedule", 6, "Tue, Oct 27, 3:30 PM", 2]);
    expect(A.waited.map((j) => [j.order.split(" - ")[0], j.name, j.partyH])).toEqual([
      ["V-8", "Hydroblast Vessel", 11.5], ["Clean fuel gas supply header to H-1", "Hydroblast piping", 10], ["V-7", "Hydroblast Piping", 2]]);
    expect(A.partyH).toBe(23.5);
    expect(A.down.held.map((h) => [h.name, h.hours])).toEqual([["Inspect for Cleanliness", 11.5], ["Reinstall piping", 10]]);
    // None of it reached the finish: E-12 set it, and it did not wait on these.
    expect(A.down.finishH).toBe(0);
    expect(r1.findings.find((f) => f.key === "contractors:load:ancon")!.title).toBe("Ancon: 6 jobs ready at once against 2 planned");
    // The pieces of the late finish add up to it.
    expect(Math.round(r1.lateBars.reduce((n, b) => n + b.hours, 0) * 10) / 10).toBe(r1.metrics.varianceH);
    // Every finding on the slides and in the report.
    expect(deckSlides(r1, { project: "Transmix", phase: "Phase 1", tz, preparedBy: null, date: "" }).some((s) => s.title.startsWith("Ancon:"))).toBe(true);
    const report = reportBlocks(r1, { project: "Transmix", phase: "Phase 1", tz, preparedBy: null, date: "" });
    expect(report.some((b) => b.k === "table" && b.head[4] === "Waited for Ancon")).toBe(true);
  });
  it("Phase 1: Schultz planned 5 at once, 9 ready at the most, 6 worked at the most", () => {
    const S = phase("Phase 1").loads.find((L) => L.party === "Schultz")!;
    expect([S.planned.n, S.peak.open, S.mostWorking.n]).toEqual([5, 9, 6]);
    expect(S.calendars).toEqual(["Schultz - Tower", "Schultz 1", "Schultz 2", "Schultz 3"]);
    for (const L of phase("Phase 1").loads) expect(L.series.every((p) => p.open >= p.working)).toBe(true);
  });
  it("Phase 2: Ancon worked ahead of its plan, and nothing waited for it", () => {
    const r2 = phase("Phase 2");
    const A = r2.loads.find((L) => L.party === "Ancon")!;
    expect([A.planned.n, A.waited.length, A.calendars]).toEqual([2, 0, ["Ancon 1", "Ancon 2"]]);
    expect(r2.findings.some((f) => f.key === "contractors:load:ancon")).toBe(false);
    expect(pointOf(r2, "Phase 2", tz).headline).toMatch(/^Phase 2 finished 43\.5 h late/);
  });
});
