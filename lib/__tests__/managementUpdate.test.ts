// The update for management: short, nothing empty, one line per main task.

import { describe, it, expect } from "vitest";
import { buildShiftReport, shiftWindow, paceOf, expectedFraction } from "@/lib/shiftReport";
import { buildProgressIndex } from "@/lib/scheduleProgress";
import { effectiveSpans, startOf, finishOf } from "@/lib/scheduleTime";
import { turnoverUpdate, withoutEmpty } from "@/lib/managementUpdate";
import { toPlainText, toEmailHtml } from "@/lib/reportExport";
import type { Milestone } from "@/types/schema";

const CHI = "America/Chicago";
const at = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-05:00`);
const mk = (p: Partial<Milestone> & { id: string; name: string; plannedStartAt: number; plannedAt: number }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const f = {
  D: (ms: number) => new Date(ms).toISOString().slice(5, 10),
  DTs: (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " "),
  T: (ms: number) => new Date(ms).toISOString().slice(11, 16),
  win: () => "17:30–5:30",
  hrs: (h: number) => `${h} h`,
};

// E-606: three day steps over two days — two done today, one planned tomorrow.
// T-605: one day step, done. Nothing blocked; everything planned today got done.
const ms = [
  mk({ id: "ex", name: "E-606 Exchanger", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-27", "17:00"), isSummary: true }),
  mk({ id: "ex1", name: "Pull bundle", parentId: "ex", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "11:00"), durationHours: 5, status: "completed", percentComplete: 100, actualAt: new Date(at("2026-10-26", "11:00")).toISOString() }),
  mk({ id: "ex2", name: "Hydroblast", parentId: "ex", plannedStartAt: at("2026-10-26", "11:00"), plannedAt: at("2026-10-26", "17:00"), durationHours: 6, status: "completed", percentComplete: 100, actualAt: new Date(at("2026-10-26", "16:30")).toISOString() }),
  mk({ id: "ex3", name: "Retube", parentId: "ex", plannedStartAt: at("2026-10-27", "06:00"), plannedAt: at("2026-10-27", "17:00"), durationHours: 11 }),
  mk({ id: "tw", name: "T-605 Tower", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "10:00"), isSummary: true }),
  mk({ id: "tw1", name: "Open manways", parentId: "tw", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "10:00"), durationHours: 4, status: "completed", percentComplete: 100 }),
];
const shift = shiftWindow("2026-10-26", "day", CHI);
const report = buildShiftReport({ milestones: ms, tz: CHI, shift, now: shift.end });
const progress = buildProgressIndex(ms);
const spans = effectiveSpans(ms);
// What the report screen hands the update: each task's steps and where they stand.
const stepsOf = (list: Milestone[], now: number) => (id: string) => list.filter((m) => m.parentId === id).map((m) => {
  const pct = m.percentComplete ?? (m.status === "completed" ? 100 : 0);
  return { id: m.id ?? undefined, name: m.name, start: startOf(m), finish: finishOf(m), percent: pct, pace: paceOf(m, pct, now, CHI), expectedPct: Math.round(expectedFraction(m, now, CHI) * 100), status: m.status };
});
const sections = turnoverUpdate(report, f, { pctOf: (id) => progress.get(id)?.percent, finishOf: (id) => spans.get(id)?.finish, planOf: () => 50, stepsOf: stepsOf(ms, shift.end) });

describe("the update says what happened, in as few words as it takes", () => {
  it("leaves out what's empty: nothing unfinished, nothing blocked, nothing next", () => {
    // Everything planned today got done; Retube starts tomorrow — nothing
    // to hand over but what got done.
    expect(sections.map((s) => s.id)).toEqual(["stand", "done"]);
  });

  it("what got done: each step once, by its task, with no finish time claimed", () => {
    const done = sections.find((s) => s.id === "done")!.blocks.find((b) => b.k === "table")!;
    if (done.k !== "table") throw new Error();
    const lines = done.rows.map((r) => r.map((c) => (typeof c === "string" ? c : c.t)).join(" | "));
    expect(lines.join("\n")).toMatch(/T-605 Tower \| Open manways \| .* \| done, on plan$/m);
    expect(lines.join("\n")).toMatch(/E-606 Exchanger \| Pull bundle \| .* \| done, on plan$/m);
    expect(lines.filter((l) => l.startsWith("E-606"))).toHaveLength(1); // the task named once, its steps under it
    // When it was marked done isn't when it finished — no time is claimed.
    expect(done.head).toEqual(["Task", "Step", "Who", "Result"]);
  });

  it("no numbers, no stretch, no 'in this order'", () => {
    const text = toPlainText({ kind: "Shift turnover", project: "P", when: "w", asOf: "a", sections });
    const html = toEmailHtml({ kind: "Shift turnover", project: "P", when: "w", asOf: "a", sections });
    for (const out of [text, html]) {
      expect(out).not.toMatch(/stretch|in this order|if you have the hands/i);
    }
    expect(text).not.toMatch(/^\d+\. /m);
  });

  it("other meetings drop their empty sections too", () => {
    const out = withoutEmpty([
      { id: "a", title: "Open work", blocks: [{ k: "empty", text: "Nothing open." }] },
      { id: "b", title: "Blocked", blocks: [{ k: "table", head: ["Task"], rows: [["X"]] }] },
    ]);
    expect(out.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("unfinished work: behind, or carrying over as planned", () => {
  // Day shift Oct 26 closing at 17:30.
  const late = mk({ id: "late", name: "Hydroblast", parentId: "ex", plannedStartAt: at("2026-10-26", "11:00"), plannedAt: at("2026-10-26", "17:00"), durationHours: 6, status: "in_progress", percentComplete: 60 });
  const slow = mk({ id: "slow", name: "Retube (2 days)", parentId: "ex", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-27", "17:00"), durationHours: 22, status: "in_progress", percentComplete: 10 });
  const fine = mk({ id: "fine", name: "Blast tower (2 days)", parentId: "tw", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-27", "17:00"), durationHours: 22, status: "in_progress", percentComplete: 55 });
  const all = [ms[0], ms[4], late, slow, fine];
  const r = buildShiftReport({ milestones: all, tz: CHI, shift, now: shift.end });
  const pace = (id: string) => [...r.review.carryOver, ...r.review.inProgress].find((x) => x.leaf.id === id)!.pace;

  it("past its finish = overdue; well short of plan = behind; at plan = on plan", () => {
    expect(pace("late")).toBe("overdue");
    expect(pace("slow")).toBe("behind");   // 10% done, ~52% planned by end of day one
    expect(pace("fine")).toBe("on plan");
  });

  it("each step says once where it stands: overdue, behind plan, or on plan", () => {
    const secs = turnoverUpdate(r, f, { pctOf: (id) => (id === "ex" ? 40 : 55), finishOf: () => undefined, stepsOf: stepsOf(all, shift.end) });
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: secs });
    expect(text).toMatch(/Hydroblast · Waits for day crew — was due 10-26 22:00 · 60%/);
    expect(text).toMatch(/Retube \(2 days\) · Waits for day crew — behind plan \(plan had \d+%\), continues next day shift · 10%/);
    expect(text).toMatch(/Blast tower \(2 days\) · Waits for day crew — on plan, continues next day shift · 55%/);
    // Once in the done/next tables (the Why table above names steps on purpose, with their hours).
    const lists = text.slice(text.search(/^(DONE|NEXT) — /m));
    for (const name of ["Hydroblast", "Retube \\(2 days\\)", "Blast tower \\(2 days\\)"]) expect(lists.match(new RegExp(`${name} ·`, "g"))?.length).toBe(1);
    expect(text).not.toMatch(/PROBLEMS|ON PLAN —|CREWS/);
    // Why it's behind: the steps that make up the gap, with their hours.
    expect(text).toMatch(/Behind plan — [\d.]+ h/);
    expect(text).toMatch(/E-606 Exchanger — Retube \(2 days\) · 10% done, plan had \d+% by now · −[\d.]+ h/);
  });
});

describe("a comment explains a step, quietly", () => {
  const cal = mk({ id: "cal", name: "Calibrate meter", parentId: "fm", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-28", "17:00"), durationHours: 33, status: "in_progress", percentComplete: 50 });
  const fm = mk({ id: "fm", name: "FT-101 Coriolis meter", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-28", "17:00"), isSummary: true });
  const r = buildShiftReport({ milestones: [fm, cal], tz: CHI, shift, now: shift.end });
  const secs = turnoverUpdate(r, f, {
    pctOf: () => 50, finishOf: () => at("2026-10-28", "17:00"), stepsOf: stepsOf([fm, cal], shift.end),
    noteOf: (id) => (id === "cal" ? "Sent out for calibration — back Wednesday" : undefined),
  });
  it("50% on a multi-day step reads on plan, with the comment under the step", () => {
    const html = toEmailHtml({ kind: "k", project: "p", when: "w", asOf: "a", sections: secs });
    expect(html).toMatch(/Calibrate meter<div[^>]*font-style:italic[^>]*>“Sent out for calibration — back Wednesday”/);
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: secs });
    expect(text).toMatch(/FT-101 Coriolis meter — Calibrate meter \("Sent out for calibration — back Wednesday"\) · Waits for day crew — on plan, continues next day shift · 50%/);
  });
});

describe("the update's first glance", () => {
  it("puts the numbers, two bars and a bottom line in Where we stand, and the safety focus off by default", () => {
    const stand = sections.find((s) => s.id === "stand")!;
    const ov = stand.blocks[0];
    if (ov.k !== "overview") throw new Error("no overview");
    expect(ov.stats.map((x) => x.label)).toEqual(["Complete", "Plan by now", expect.any(String), "Steps done"]);
    expect(ov.title).toBe("Bottom line");
    expect(ov.lines[0].text).toMatch(/^(Even with the plan|Behind by|Ahead by)/);
    const safety = sections.find((s) => s.id === "safety");
    if (safety) expect(safety.offByDefault).toBe(true);
    const html = toEmailHtml({ kind: "Shift turnover", project: "P", when: "w", asOf: "a", sections });
    expect(html).toContain("Bottom line");
    expect(html).not.toMatch(/display:\s*(flex|grid)/);
  });
});
