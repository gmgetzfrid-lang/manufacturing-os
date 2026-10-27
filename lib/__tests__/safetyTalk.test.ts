// The safety topic as it's given at the meeting: one topic, a line on why
// today, a few short things to say out loud — not the schedule's steps.

import { describe, it, expect } from "vitest";
import { rankHazards, type HazardJobInput } from "@/lib/safetyMoment";
import { SAFETY_LESSONS } from "@/lib/safetyLessons";
import { safetyTalks, pickTalk, talkSources, projectFacts, CREWS_POINTS, type ProjectBase } from "@/lib/safetyTalk";
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
const talks = () => safetyTalks(rankHazards(jobs, { shift: DAY, T }), DAY);

describe("safety topic", () => {
  it("leads with the riskiest work, crews on the same equipment, and says why today in a line", () => {
    const [top] = talks();
    expect(top.key).toBe("hydroblast+crews");
    expect(top.title).toBe("Hydroblasting next to other crews");
    expect(top.today).toBe("Ancon blasting E-20 today, with Schultz working the same equipment.");
  });
  it("a night shift's topic says tonight", () => {
    const night = { start: S + 12 * H, end: S + 24 * H, kind: "night" as const };
    const late = jobs.map((j) => ({ ...j, start: j.start! + 12 * H, end: j.end! + 12 * H }));
    expect(safetyTalks(rankHazards(late, { shift: night, T }), night)[0].today).toBe("Ancon blasting E-20 tonight, with Schultz working the same equipment.");
  });
  it("gives four or five short lines to say, and never repeats the schedule's steps", () => {
    for (const t of talks()) {
      expect(t.points.length).toBeGreaterThanOrEqual(4);
      expect(t.points.length).toBeLessThanOrEqual(5);
      for (const p of t.points) {
        expect(words(p.say)).toBeLessThanOrEqual(30);
        for (const j of jobs) expect(p.say).not.toContain(j.name);
      }
      expect(new Set(t.points.map((p) => p.say)).size).toBe(t.points.length);
    }
  });
  it("two lines on the work, one on the crews sharing the equipment, the rest on the job around it", () => {
    const [top] = talks();
    expect(top.points).toHaveLength(5);
    for (const p of top.points.slice(0, 2)) expect(SAFETY_LESSONS.some((l) => l.say === p.say && l.kind === "hydroblast")).toBe(true);
    expect(CREWS_POINTS).toContainEqual(top.points[2]);
    for (const p of top.points.slice(3)) expect(SAFETY_LESSONS.some((l) => l.say === p.say)).toBe(false);
  });
  it("offers barricades and other crews as a topic of its own", () => {
    const crews = talks().find((t) => t.key === "crews")!;
    expect(crews.title).toBe("Barricades and working around other crews");
    expect(crews.points).toHaveLength(5);
  });
  it("the same topic all shift; a different set of lines another shift", () => {
    expect(talks()).toEqual(talks());
    const next = { start: S + 24 * H, end: S + 36 * H, kind: "day" as const };
    const later = safetyTalks(rankHazards(jobs, { shift: next, T }), next);
    expect(later[0].points.map((p) => p.say)).not.toEqual(talks()[0].points.map((p) => p.say));
  });
  it("the pick made at the meeting is the one given; an old pick falls back to the best", () => {
    const ts = talks();
    expect(pickTalk(ts, "crews")?.key).toBe("crews");
    expect(pickTalk(ts, "radiography")?.key).toBe(ts[0].key);
    expect(pickTalk([], null)).toBeUndefined();
  });
  it("lists each source site once", () => {
    const labels = talkSources(talks()[0]).map((s) => s.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it("a lesson about particular equipment only where the steps have it: no PSV lesson on a flange break", () => {
    const said = (name: string) => {
      const out = new Set<string>();
      for (let k = 0; k < 40; k++) {
        const sh = { start: S + k * 12 * H, end: S + (k + 1) * 12 * H, kind: "day" as const };
        const j = { ...job("lb", name, "p1", "P-101 - Charge Pump", 0, 4, "Schultz"), start: sh.start, end: sh.start + 4 * H };
        for (const p of safetyTalks(rankHazards([j], { shift: sh, T }), sh)[0].points.slice(0, 2)) out.add(p.say);
      }
      return [...out];
    };
    expect(said("Break Suction Flange for Blind").some((x) => /PSV/.test(x))).toBe(false);
    expect(said("Remove PSV-101 and Break Inlet Flange").some((x) => /^Pilot PSVs/.test(x))).toBe(true);
  });
  it("every lesson has a short spoken line", () => {
    for (const l of SAFETY_LESSONS) {
      expect(l.say.trim().length).toBeGreaterThan(0);
      expect(words(l.say)).toBeLessThanOrEqual(30);
    }
  });
  it("goes out in the email as a heading, the why-today line, bullets and the sources", () => {
    const t = talks()[0];
    const doc: ExportDoc = { kind: "Shift turnover", project: "Unit", when: "", asOf: "", sections: [
      { title: "Safety topic", blocks: [{ k: "bullets", title: t.title, lead: t.today, tone: "amber", items: t.points.map((p) => p.say), sources: talkSources(t) }] },
    ] };
    const text = toPlainText(doc);
    expect(text).toContain("HYDROBLASTING NEXT TO OTHER CREWS");
    expect(text).toContain(`• ${t.points[0].say}`);
    const html = toEmailHtml(doc);
    expect(html).toContain("Ancon blasting E-20 today");
    expect(html).toContain(`href="${talkSources(t)[0].url}"`);
  });
});

describe("the job around the work", () => {
  const tz = "America/Chicago";
  const ta: ProjectBase = { names: ["Unit 2 Turnaround", "Mechanical"], start: Date.parse("2026-10-26T05:00:00Z"), finish: Date.parse("2026-10-30T23:00:00Z"), tz };
  const hz = rankHazards(jobs, { shift: DAY, T });
  const names = jobs.map((j) => j.name);

  it("reads a turnaround from the project or the schedule's groups — TA in capitals only", () => {
    expect(projectFacts(ta, DAY, names).turnaround).toBe(true);
    expect(projectFacts({ ...ta, names: ["Unit 2", "Shutdown"] }, DAY, names).turnaround).toBe(true);
    expect(projectFacts({ ...ta, names: ["Unit 2 TA 2026"] }, DAY, names).turnaround).toBe(true);
    expect(projectFacts({ ...ta, names: ["Data ta check", "Pump replacement"] }, DAY, names).turnaround).toBe(false);
  });
  it("the day of the job the shift falls on, of how many", () => {
    expect(projectFacts(ta, DAY, names)).toMatchObject({ day: 2, days: 5 });
  });
  it("in a turnaround, the job's own topic comes second: live units, operators", () => {
    const ts = safetyTalks(hz, DAY, { project: projectFacts(ta, DAY, names) });
    expect(ts[1].key).toBe("turnaround");
    expect(ts[1].title).toBe("Turnaround: working next to live units");
    expect(ts[1].today).toBe("Day 2 of 5 of the turnaround. Live lines and running units are all around the work.");
    expect(ts[1].points).toHaveLength(5);
    expect(ts[1].points[0].say).toMatch(/^The units around us are running\. At Tosco/);
    expect(ts[1].points[1].say).toMatch(/^Operators own the unit/);
    // The riskiest work's topic carries two of the job's lines too.
    expect(ts[0].points.slice(3).some((p) => /units around us|Operators own|isn't shut down|valve that isn't yours|Out-of-service|alarms|windsock/.test(p.say))).toBe(true);
  });
  it("start-up work on the shift leads the job's lines with start-up; late in the job, fatigue", () => {
    const up = projectFacts(ta, DAY, [...names, "Commission Feed Pumps"]);
    expect(up.phase).toBe("startup");
    expect(safetyTalks(hz, DAY, { project: up })[0].points[3].say).toMatch(/^If you're not part of start-up, you're out of the unit/);
    const late = projectFacts({ ...ta, start: Date.parse("2026-10-19T05:00:00Z") }, DAY, names);
    expect(late.day).toBe(9);
    const t = safetyTalks(hz, DAY, { project: late }).find((x) => x.key === "turnaround")!;
    expect(t.points[2].say).toBe("Day 9 of long shifts: tired people miss things. At Texas City, an operator had worked 29 straight 12-hour days.");
  });
  it("past the planned finish, says so", () => {
    const over = projectFacts({ ...ta, finish: Date.parse("2026-10-26T23:00:00Z") }, DAY, names);
    expect(safetyTalks(hz, DAY, { project: over }).find((x) => x.key === "turnaround")!.today).toMatch(/^Day 2 of the turnaround, past the planned 1 day\. /);
  });
  it("not a turnaround: working around a running plant", () => {
    const ts = safetyTalks(hz, DAY, { project: projectFacts({ ...ta, names: ["Pump replacement"] }, DAY, names) });
    expect(ts[1].key).toBe("plant");
    expect(ts[1].points.length).toBeGreaterThanOrEqual(4);
  });
});
