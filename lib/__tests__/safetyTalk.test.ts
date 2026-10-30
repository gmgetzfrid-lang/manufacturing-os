// The safety topics as they're given at the meeting: three side by side —
// the job as a whole, then the next shift's two riskiest kinds of work —
// each a title, a line on why now, three short things to say out loud.

import { describe, it, expect } from "vitest";
import { rankHazards, type HazardJobInput } from "@/lib/safetyMoment";
import { SAFETY_LESSONS } from "@/lib/safetyLessons";
import { safetyBrief, talkSources, projectFacts, unitOf, splitLead, riskLines, riskHistory, CREWS_POINTS, CREW_LINES, CORE, PHASES, TA_THEMES, PLANT_THEMES, QUIET_THEMES, type ProjectBase } from "@/lib/safetyTalk";
import { shiftAt, DEFAULT_SHIFT_TIMES } from "@/lib/shiftReport";
import type { Milestone } from "@/types/schema";
import { toEmailHtml, toPlainText, type ExportDoc } from "@/lib/reportExport";

const H = 3600_000;
const S = Date.parse("2026-10-27T11:00:00Z");
const T = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const job = (id: string, name: string, parentId: string, parentName: string, from: number, to: number, who: string): HazardJobInput =>
  ({ id, name, parentId, parentName, hours: to - from, when: "", start: S + from * H, end: S + to * H, who });
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

const jobs = [
  job("hb", "Hydroblast Shell and Bundle", "e20", "E-20 - Overhead Trim Cooler", 2, 6, "Ancon"),
  job("in", "Inspect for Cleanliness", "e20", "E-20 - Overhead Trim Cooler", 4, 5, "Schultz"),
  job("pb", "Pull Bundle", "e17", "E-17 - Exchanger", 0, 4, "Schultz"),
];
const DAY = { start: S, end: S + 12 * H, kind: "day" as const };
const tz = "America/Chicago";
const ta: ProjectBase = { names: ["October 2026 Transmix-1 Turnaround", "Transmix-1 - Shutdown"], start: Date.parse("2026-10-26T05:00:00Z"), finish: Date.parse("2026-10-30T23:00:00Z"), tz };
const names = jobs.map((j) => j.name);
const brief = (shift: { start: number; end: number; kind: "day" | "night" } = DAY, list = jobs, project: ProjectBase = ta) =>
  safetyBrief(rankHazards(list, { shift, T }), shift, { project: projectFacts(project, shift, list.map((j) => j.name)) });

describe("three topics", () => {
  it("the job as a whole first, then the shift's two riskiest kinds of work", () => {
    const ts = brief();
    expect(ts).toHaveLength(3);
    expect(ts.map((t) => t.kind)).toEqual(["general", "risk", "risk"]);
    expect(ts[0].kicker).toBe("Turnaround · Transmix-1");
    expect(ts[0].why).toBe("Day 2 of 5 - live units and other crews all around the work today.");
    expect(ts[1]).toMatchObject({ title: "Hydroblasting", kicker: "Top risk today · 1", why: "Ancon blasting E-20 today - next to Schultz." });
    expect(ts[2].kicker).toBe("Top risk today · 2");
  });
  it("a crew doing the work is never listed as 'next to' itself", () => {
    const ts = brief(DAY, [
      job("a", "Break Flange for Blind", "p1", "P-1 - Pump", 0, 3, "Maintenance (KE)"),
      job("b", "Break Flange for Blind", "p2", "P-2 - Pump", 0, 3, "Schultz"),
      job("c", "Remove Spool", "p2", "P-2 - Pump", 1, 2, "Maintenance (KE)"),
    ]);
    const lb = ts.find((t) => t.hazard === "line_break")!;
    expect(lb.why).not.toMatch(/next to .*(Schultz|Maintenance)/);
  });
  it("a night shift says tonight", () => {
    const night = { start: S + 12 * H, end: S + 24 * H, kind: "night" as const };
    const late = jobs.map((j) => ({ ...j, start: j.start! + 12 * H, end: j.end! + 12 * H }));
    const ts = brief(night, late);
    expect(ts[1].why).toBe("Ancon blasting E-20 tonight - next to Schultz.");
    expect(ts[1].kicker).toBe("Top risk tonight · 1");
  });
  it("three short lines each, never the schedule's steps, no repeats", () => {
    for (const t of brief()) {
      expect(t.points).toHaveLength(3);
      for (const p of t.points) {
        expect(words(p.say)).toBeLessThanOrEqual(30);
        for (const j of jobs) expect(p.say).not.toContain(j.name);
      }
      expect(new Set(t.points.map((p) => p.say)).size).toBe(3);
    }
  });
  it("a risk: the core control first, a lesson from a real incident, then the crews sharing the equipment", () => {
    const r = brief()[1];
    expect(r.points[0]).toEqual(CORE.hydroblast.always);
    expect(SAFETY_LESSONS.some((l) => l.say === r.points[1].say && l.kind === "hydroblast")).toBe(true);
    expect(CREWS_POINTS).toContainEqual(r.points[2]);
  });
  it("vessel entry always leads with the hole watch and the air monitored the whole time", () => {
    const ts = brief(DAY, [job("v", "Open Internal Manways", "v7", "V-7 - Fractionator", 0, 6, "Schultz")]);
    const v = ts.find((t) => t.hazard === "confined_space")!;
    expect(v.points[0].say).toMatch(/^Hole watch at the manway the whole entry, in constant contact with every entrant\. Air monitored the whole time/);
  });
  it("every core control is short, starts with the thing to do, and says evacuate - not 'get out'", () => {
    for (const c of Object.values(CORE)) for (const p of [c.always, ...c.more]) {
      expect(words(p.say)).toBeLessThanOrEqual(30);
      expect(p.say).not.toMatch(/get out|leave first|stop and go/i);
    }
    for (const t of brief()) for (const p of t.points) expect(p.say).not.toMatch(/get out|leave first|stop and go/i);
  });
  it("follows the shift: the job's topic changes theme from one shift to the next", () => {
    const titles = [0, 1, 2, 3].map((k) => brief({ start: S + k * 12 * H, end: S + (k + 1) * 12 * H, kind: k % 2 ? "night" : "day" })[0].title);
    expect(new Set(titles).size).toBeGreaterThanOrEqual(3);
    // …and the same all shift, on every screen.
    expect(brief()).toEqual(brief());
  });
  it("a quiet shift: a toolbox topic of its own fills the row - never one of the job's themes", () => {
    const ts = brief(DAY, [job("pb", "Pull Bundle", "e17", "E-17 - Exchanger", 0, 4, "Schultz")]);
    expect(ts.map((t) => t.kind)).toEqual(["general", "risk", "general"]);
    expect(QUIET_THEMES.map((q) => q.title)).toContain(ts[2].title);
    expect(ts[2].why).toBe("Quiet day on the schedule - a good one to talk through.");
    // No risky work at all: the job's topic and the toolbox topic.
    expect(brief(DAY, [job("i", "Inspect for Cleanliness", "e20", "E-20 - Overhead Trim Cooler", 0, 2, "QA")]).map((t) => t.kind)).toEqual(["general", "general"]);
  });
  it("start-up work on the shift: the job's topic is the start-up", () => {
    const ts = brief(DAY, [...jobs, job("f", "Introduce Feed", "su", "Transmix-1 - Start-Up", 6, 10, "Operations (KE)")]);
    expect(ts.some((t) => t.title === "Start-up: hydrocarbons coming back" || t.title === "Start-up")).toBe(true);
  });
  it("a shutdown-required job isn't the unit shutting down", () => {
    expect(projectFacts(ta, DAY, ["Shutdown-Required Inspection on Burner Auto S/O"]).phase).toBeUndefined();
    expect(projectFacts(ta, DAY, ["Shutdown Unit and De-inventory"]).phase).toBe("shutdown");
  });
  it("late in the job, the job's topic says so - a different way each day", () => {
    const late: ProjectBase = { ...ta, start: Date.parse("2026-10-19T05:00:00Z"), finish: Date.parse("2026-11-20T05:00:00Z") };
    const said = [0, 1, 2, 3, 4].map((d) => {
      const sh = { start: S + d * 24 * H, end: S + d * 24 * H + 12 * H, kind: "day" as const };
      return brief(sh, jobs.map((j) => ({ ...j, start: j.start! + d * 24 * H, end: j.end! + d * 24 * H })), late)[0].points[2].say;
    });
    const tired = said.filter((x) => /tired|fatigue|Twelve-hour/i.test(x));
    expect(tired).toHaveLength(4);
    expect(new Set(tired).size).toBe(4);
    expect(tired.some((x) => /^Day \d+ of long shifts: tired people miss things\. At Texas City/.test(x))).toBe(true);
  });
  it("not a turnaround: the plant around the work", () => {
    const ts = brief(DAY, jobs, { ...ta, names: ["Pump replacement"] });
    expect(ts[0].kicker).toBe("The job · Pump replacement");
    expect(ts[0].why).toMatch(/operators running the plant around the work today\.$/);
  });
  it("a lesson about particular equipment only where the steps have it: no PSV lesson on a flange break", () => {
    const said = (name: string) => {
      const out = new Set<string>();
      for (let k = 0; k < 40; k++) {
        const sh = { start: S + k * 12 * H, end: S + (k + 1) * 12 * H, kind: "day" as const };
        const j = { ...job("lb", name, "p1", "P-101 - Charge Pump", 0, 4, "Schultz"), start: sh.start, end: sh.start + 4 * H };
        for (const p of brief(sh, [j])[1].points) out.add(p.say);
      }
      return [...out];
    };
    expect(said("Break Suction Flange for Blind").some((x) => /PSV/.test(x))).toBe(false);
    expect(said("Remove PSV-101 and Break Inlet Flange").some((x) => /^Pilot PSVs/.test(x))).toBe(true);
  });
  it("each point reads as the thing to do, then why", () => {
    expect(splitLead("Test the dump every time you start. A taped pedal keeps the gun live.")).toEqual(["Test the dump every time you start.", "A taped pedal keeps the gun live."]);
    expect(splitLead("Ask before you cross")).toEqual(["Ask before you cross", ""]);
  });
  it("every lesson has a short spoken line", () => {
    for (const l of SAFETY_LESSONS) {
      expect(l.say.trim().length).toBeGreaterThan(0);
      expect(words(l.say)).toBeLessThanOrEqual(30);
    }
  });
  it("lists each source site once", () => {
    for (const t of brief()) {
      const labels = talkSources(t).map((s) => s.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
  it("goes out in the email as three topics: heading, why, bullets, sources", () => {
    const ts = brief();
    const doc: ExportDoc = { kind: "Shift turnover", project: "Unit", when: "", asOf: "", sections: [
      { title: "Safety topics", blocks: ts.map((t, i) => ({ k: "bullets" as const, title: `${i + 1}. ${t.title}`, lead: `${t.kicker} - ${t.why}`, items: t.points.map((p) => p.say), sources: talkSources(t) })) },
    ] };
    const text = toPlainText(doc);
    expect(text).toContain("2. HYDROBLASTING");
    expect(text).toContain(`• ${ts[1].points[0].say}`);
    expect(toEmailHtml(doc)).toContain("Ancon blasting E-20 today");
  });
});

describe("the job around the work", () => {
  it("reads a turnaround from the project or the schedule's groups - TA in capitals only", () => {
    expect(projectFacts(ta, DAY, names).turnaround).toBe(true);
    expect(projectFacts({ ...ta, names: ["Unit 2", "Shutdown"] }, DAY, names).turnaround).toBe(true);
    expect(projectFacts({ ...ta, names: ["Unit 2 TA 2026"] }, DAY, names).turnaround).toBe(true);
    expect(projectFacts({ ...ta, names: ["Data ta check", "Pump replacement"] }, DAY, names).turnaround).toBe(false);
  });
  it("the day of the job the shift falls on, of how many", () => {
    expect(projectFacts(ta, DAY, names)).toMatchObject({ day: 2, days: 5 });
  });
  it("the unit, from the project's name", () => {
    expect(unitOf("October 2026 Transmix-1 Turnaround")).toBe("Transmix-1");
    expect(unitOf("Unit 2 TA 2026")).toBe("Unit 2");
    expect(unitOf("2026 Turnaround")).toBeNull();
  });
});

describe("no repeats", () => {
  // Work of many kinds, a different few each shift (a fixed pseudo-random draw).
  const POOL: Array<[string, string, string, string]> = [
    ["Hydroblast Shell and Bundle", "e20", "E-20 - Overhead Trim Cooler", "Ancon"],
    ["Break Flange for Blind", "p1", "P-1 - Charge Pump", "Schultz"],
    ["Pull Bundle", "e17", "E-17 - Exchanger", "Schultz"],
    ["Open Internal Manways and Enter", "v7", "V-7 - Fractionator", "Ancon"],
    ["Weld Repair Nozzle", "v7", "V-7 - Fractionator", "Maintenance (KE)"],
    ["Set Crane and Lift Relief Valve", "psv", "PSV-021 - Relief Valve", "Schultz"],
    ["Hydrotest Exchanger", "e12", "E-12 - Reboiler", "Ancon"],
    ["Erect Scaffold to Top Platform", "v7", "V-7 - Fractionator", "Scaffold Co"],
    ["Nitrogen Purge and Inert Entry", "r1", "R-1 - Reactor", "Catalyst Co"],
    ["Machine Flange Face", "e12", "E-12 - Reboiler", "Maintenance (KE)"],
    ["Radiograph Welds", "v7", "V-7 - Fractionator", "RT Co"],
    ["Chemical Clean Bundle", "e17", "E-17 - Exchanger", "Chem Co"],
  ];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const shiftJobs = (sh: { start: number }, k: number) => {
    const pick = new Set<number>();
    // Now and then a quiet shift: one job.
    const n = k % 5 === 4 ? 1 : 4;
    while (pick.size < n) pick.add(Math.floor(rnd() * POOL.length));
    return [...pick].map((i) => {
      const [name, pid, pname, who] = POOL[i];
      const from = Math.floor(rnd() * 6);
      return { ...job(`${k}-${i}`, name, pid, pname, 0, 0, who), start: sh.start + from * H, end: sh.start + (from + 4) * H, hours: 4 };
    });
  };
  const exempt = new Set([...Object.values(CORE).map((c) => c.always.say), ...Object.values(PHASES).map((p) => p.always.say)]);
  const behind: ProjectBase = { ...ta, start: Date.parse("2026-10-15T05:00:00Z"), finish: Date.parse("2026-11-30T05:00:00Z"), behind: true };
  const run = (shifts: Array<{ start: number; end: number; kind: "day" | "night" }>) => shifts.map((sh, k) => {
    const js = shiftJobs(sh, k);
    // Every few shifts, shutdown work on it: the shutdown topic leads.
    if (k % 3 === 0) js.push({ ...job(`${k}-sd`, "Shutdown Unit and De-inventory", "u", "Transmix-1 - Shutdown", 0, 0, "Operations (KE)"), start: sh.start, end: sh.start + 6 * H, hours: 6 });
    return brief(sh, js, behind);
  });
  const shifts = (n: number, every: number, kind: (k: number) => "day" | "night") =>
    Array.from({ length: n }, (_, k) => { const st = S + k * every * H + (kind(k) === "night" ? 12 * H : 0) - (every === 12 && k % 2 ? 12 * H : 0); return { start: st, end: st + 12 * H, kind: kind(k) }; });

  it("no line twice in one night", () => {
    for (const b of run(shifts(40, 12, (k) => (k % 2 ? "night" : "day")))) {
      const all = b.flatMap((t) => t.points.map((p) => p.say));
      expect(new Set(all).size).toBe(all.length);
    }
  });
  for (const [label, list] of [
    ["round the clock", shifts(30, 12, (k) => (k % 2 ? "night" : "day"))],
    ["day shifts only", shifts(20, 24, () => "day")],
    ["night shifts only", shifts(20, 24, () => "night")],
  ] as const) {
    it(`whatever the work, no line comes back within four shifts - ${label}`, () => {
      const briefs = run([...list]);
      const lines = briefs.map((b) => new Set(b.flatMap((t) => t.points.map((p) => p.say)).filter((x) => !exempt.has(x))));
      for (let i = 0; i < lines.length; i++) for (let j = i + 1; j <= i + 4 && j < lines.length; j++)
        for (const x of lines[i]) expect(lines[j].has(x), `"${x}" on shift ${i} and ${j}`).toBe(false);
      // …and every card still has its three lines.
      for (const b of briefs) for (const t of b) expect(t.points).toHaveLength(3);
    });
  }
  it("every kind of work has a line for every shift of the cycle", () => {
    for (const k of Object.keys(CORE) as Array<keyof typeof CORE>) {
      const { gems, controls } = riskLines(k, SAFETY_LESSONS);
      for (let r = 0; r < 5; r++) {
        expect(gems.some((l) => l.r === r && !l.if), `${k} lesson ${r}`).toBe(true);
        expect(controls.some((l) => l.r === r && !l.if), `${k} control ${r}`).toBe(true);
      }
    }
    for (let r = 0; r < 5; r++) {
      expect(CREW_LINES.some((l) => l.r === r)).toBe(true);
      for (const ph of Object.values(PHASES)) expect(ph.lines.filter((l) => l.r === r)).toHaveLength(2);
    }
    expect(TA_THEMES).toHaveLength(5);
    expect(PLANT_THEMES).toHaveLength(5);
    expect(QUIET_THEMES).toHaveLength(5);
  });
  it("every line is said in one place only", () => {
    const all = [
      ...Object.keys(CORE).flatMap((k) => { const l = riskLines(k as keyof typeof CORE, SAFETY_LESSONS); return [CORE[k as keyof typeof CORE].always.say, ...l.gems.map((x) => x.say), ...l.controls.map((x) => x.say)]; }),
      ...CREW_LINES.map((x) => x.say), ...TA_THEMES.flatMap((t) => t.points.map((p) => p.say)), ...QUIET_THEMES.flatMap((t) => t.points.map((p) => p.say)),
      ...Object.values(PHASES).flatMap((p) => [p.always.say, ...p.lines.map((x) => x.say)]),
    ];
    expect(all.length - new Set(all).size).toBe(0);
  });
});

describe("a kind of work that's led two shifts running", () => {
  const ranked = () => rankHazards([...jobs, job("lb", "Break Flange for Blind", "p1", "P-1 - Pump", 0, 3, "Maintenance (KE)")], { shift: DAY, T, max: 4 });
  const twice = [["hydroblast", "line_break"], ["hydroblast", "bundle_pull"]] as Array<Array<"hydroblast" | "line_break" | "bundle_pull">>;
  it("steps aside for the next one", () => {
    const hs = ranked();
    expect(hs.map((h) => h.kind)).toEqual(["hydroblast", "line_break", "bundle_pull"]);
    // All close: none a full severity step ahead of another.
    hs[0] = { ...hs[0], score: hs[1].score + 5 };
    hs[2] = { ...hs[2], score: hs[1].score - 3 };
    const ts = safetyBrief(hs, DAY, { recentRisks: twice });
    expect(ts.filter((t) => t.kind === "risk").map((t) => t.hazard)).toEqual(["line_break", "bundle_pull"]);
    expect(ts[1].kicker).toBe("Top risk today · 1");
  });
  it("stays when it's still clearly the top risk - and says how long it's run", () => {
    const hs = ranked();
    hs[0] = { ...hs[0], score: hs[1].score + 15 };
    const ts = safetyBrief(hs, DAY, { recentRisks: twice });
    expect(ts[1]).toMatchObject({ hazard: "hydroblast", kicker: "Top risk today · 1 · 3rd shift running" });
  });
  it("once only: back the shift after it stepped aside", () => {
    const ts = safetyBrief(ranked(), DAY, { recentRisks: [["line_break", "bundle_pull"], ["hydroblast", "line_break"]] });
    expect(ts[1]).toMatchObject({ hazard: "hydroblast", kicker: "Top risk today · 1" });
  });
});

describe("the risk cards of the shifts before, from the schedule", () => {
  const tzLA = "America/Los_Angeles";
  const at = (d: number, hm: string) => new Date(`2026-10-${d}T${hm}:00-07:00`).toISOString();
  const ms = (o: Partial<Milestone> & { id: string; name: string }): Milestone =>
    ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", ...o } as Milestone);
  const sched: Milestone[] = [
    ms({ id: "e20", name: "E-20 - Overhead Trim Cooler" }), ms({ id: "p1", name: "P-1 - Charge Pump" }), ms({ id: "e17", name: "E-17 - Exchanger" }),
    ...[26, 27, 28, 29].flatMap((d) => [
      ms({ id: `hb${d}`, parentId: "e20", name: "Hydroblast Shell and Bundle", responsibleParty: "Ancon", plannedStartAt: at(d, "07:00"), plannedAt: at(d, "15:00") }),
      ms({ id: `lb${d}`, parentId: "p1", name: "Break Flange for Blind", responsibleParty: "Schultz", plannedStartAt: at(d, "08:00"), plannedAt: at(d, "10:00") }),
      ms({ id: `pb${d}`, parentId: "e17", name: "Pull Bundle", responsibleParty: "Schultz", plannedStartAt: at(d, "09:00"), plannedAt: at(d, "13:00") }),
    ]),
  ];
  const dayOf = (d: number) => shiftAt(Date.parse(at(d, "10:00")), tzLA, DEFAULT_SHIFT_TIMES);
  it("each shift's cards as they were shown - the same whichever shift you look from", () => {
    const h29 = riskHistory(sched, dayOf(29), tzLA, DEFAULT_SHIFT_TIMES);
    const h30 = riskHistory(sched, dayOf(30), tzLA, DEFAULT_SHIFT_TIMES);
    // Nights had no work, no brief: the last three briefs are the 28th, 27th, 26th.
    expect(h29).toHaveLength(3);
    expect(h30.slice(1)).toEqual(h29);
    expect(h29[1]).toContain("hydroblast");
    expect(h29[2]).toContain("hydroblast");
  });
  it("the third day running: line breaks step aside; hydroblasting, a full step ahead, stays", () => {
    const h29 = riskHistory(sched, dayOf(29), tzLA, DEFAULT_SHIFT_TIMES);
    expect(h29).toEqual([["hydroblast", "bundle_pull"], ["hydroblast", "line_break"], ["hydroblast", "line_break"]]);
    // With nothing else on the schedule there's nothing to give way to: it stays.
    const alone = riskHistory(sched.filter((m) => !/^(lb|pb)\d/.test(m.id!)), dayOf(29), tzLA, DEFAULT_SHIFT_TIMES);
    expect(alone).toEqual([["hydroblast"], ["hydroblast"], ["hydroblast"]]);
  });
});
