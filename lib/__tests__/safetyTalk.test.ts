// The safety topic as it's given at the meeting: one topic, a line on why
// today, a few short things to say out loud — not the schedule's steps.

import { describe, it, expect } from "vitest";
import { rankHazards, type HazardJobInput } from "@/lib/safetyMoment";
import { SAFETY_LESSONS } from "@/lib/safetyLessons";
import { safetyTalks, pickTalk, talkSources, CREWS_POINTS } from "@/lib/safetyTalk";
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
  it("crews overlapping: the barricade and other-crew rules come first, then the job's own lessons", () => {
    const [top] = talks();
    expect(CREWS_POINTS).toContainEqual(top.points[0]);
    expect(SAFETY_LESSONS.some((l) => l.say === top.points[2].say && l.kind === "hydroblast")).toBe(true);
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
    expect(labels).toContain("osha.gov");
    expect(new Set(labels).size).toBe(labels.length);
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
    expect(html).toContain('href="https://www.osha.gov/');
  });
});
