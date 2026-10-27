// The safety topics as they're given at the meeting: three side by side —
// the job as a whole, then the next shift's two riskiest kinds of work —
// each a title, a line on why now, three short things to say out loud.

import { describe, it, expect } from "vitest";
import { rankHazards, type HazardJobInput } from "@/lib/safetyMoment";
import { SAFETY_LESSONS } from "@/lib/safetyLessons";
import { safetyBrief, talkSources, projectFacts, unitOf, splitLead, CREWS_POINTS, CORE, type ProjectBase } from "@/lib/safetyTalk";
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
    expect(ts[0].why).toBe("Day 2 of 5 — live units and other crews all around the work today.");
    expect(ts[1]).toMatchObject({ title: "Hydroblasting", kicker: "Top risk today · 1", why: "Ancon blasting E-20 today — next to Schultz." });
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
    expect(ts[1].why).toBe("Ancon blasting E-20 tonight — next to Schultz.");
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
  it("every core control is short, starts with the thing to do, and says evacuate — not 'get out'", () => {
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
  it("a quiet shift: the job's other topics fill the row", () => {
    const ts = brief(DAY, [job("pb", "Pull Bundle", "e17", "E-17 - Exchanger", 0, 4, "Schultz")]);
    expect(ts.map((t) => t.kind)).toEqual(["general", "risk", "general"]);
    expect(ts[2].title).not.toBe(ts[0].title);
  });
  it("start-up work on the shift: the job's topic is the start-up", () => {
    const ts = brief(DAY, [...jobs, job("f", "Introduce Feed", "su", "Transmix-1 - Start-Up", 6, 10, "Operations (KE)")]);
    expect(ts.some((t) => t.title === "Start-up: hydrocarbons coming back" || t.title === "Start-up")).toBe(true);
  });
  it("a shutdown-required job isn't the unit shutting down", () => {
    expect(projectFacts(ta, DAY, ["Shutdown-Required Inspection on Burner Auto S/O"]).phase).toBeUndefined();
    expect(projectFacts(ta, DAY, ["Shutdown Unit and De-inventory"]).phase).toBe("shutdown");
  });
  it("late in the job, the job's topic says so", () => {
    const late: ProjectBase = { ...ta, start: Date.parse("2026-10-19T05:00:00Z") };
    expect(brief(DAY, jobs, late)[0].points[2].say).toBe("Day 9 of long shifts: tired people miss things. At Texas City, an operator had worked 29 straight 12-hour days.");
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
      { title: "Safety topics", blocks: ts.map((t, i) => ({ k: "bullets" as const, title: `${i + 1}. ${t.title}`, lead: `${t.kicker} — ${t.why}`, items: t.points.map((p) => p.say), sources: talkSources(t) })) },
    ] };
    const text = toPlainText(doc);
    expect(text).toContain("2. HYDROBLASTING");
    expect(text).toContain(`• ${ts[1].points[0].say}`);
    expect(toEmailHtml(doc)).toContain("Ancon blasting E-20 today");
  });
});

describe("the job around the work", () => {
  it("reads a turnaround from the project or the schedule's groups — TA in capitals only", () => {
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
