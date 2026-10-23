// The update for management: short, nothing empty, one line per main task.

import { describe, it, expect } from "vitest";
import { buildShiftReport, shiftWindow } from "@/lib/shiftReport";
import { buildProgressIndex } from "@/lib/scheduleProgress";
import { effectiveSpans } from "@/lib/scheduleTime";
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
const sections = turnoverUpdate(report, f, { pctOf: (id) => progress.get(id)?.percent, finishOf: (id) => spans.get(id)?.finish, planOf: () => 50 });

describe("the update says what happened, in as few words as it takes", () => {
  it("leaves out what's empty: nothing unfinished, nothing blocked, nothing next", () => {
    expect(sections.map((s) => s.id)).toEqual(["stand", "last"]);
    const last = sections.find((s) => s.id === "last")!;
    expect(last.blocks.some((b) => b.k === "label" && (b.text === "Behind" || b.text === "Carrying over as planned"))).toBe(false);
  });

  it("Completed: one row per main task — % done, last step, and when the rest is planned", () => {
    const table = sections.find((s) => s.id === "last")!.blocks.find((b) => b.k === "table")!;
    if (table.k !== "table") throw new Error();
    expect(table.head).toEqual(["Task", "% complete", "Last step done", "Planned finish"]);
    const cells = table.rows.map((r) => r.map((c) => (typeof c === "string" ? c : c.t)));
    const row = (name: string) => cells.find((r) => r[0] === name)!;
    // E-606 is part done with its last step planned tomorrow — shown as on its way, not unfinished.
    expect(row("E-606 Exchanger")[2]).toBe("Hydroblast");
    expect(row("E-606 Exchanger")[3]).toMatch(/10-27.*on plan/);
    expect(row("T-605 Tower")).toEqual(["T-605 Tower", "100%", "", "Complete"]);
    expect(table.rows).toHaveLength(2); // not a line per step
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

  it("the update lists them apart, with why", () => {
    const secs = turnoverUpdate(r, f, { pctOf: () => 50, finishOf: () => undefined });
    const last = secs.find((x) => x.id === "last")!;
    const labels = last.blocks.filter((b) => b.k === "label").map((b) => (b.k === "label" ? b.text : ""));
    expect(labels).toEqual(["Behind", "Carrying over as planned"]);
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: secs });
    expect(text).toMatch(/Hydroblast · 60% · Overdue — was due/);
    expect(text).toMatch(/Retube \(2 days\) · 10% · Behind plan — \d+% planned by now/);
    expect(text).toMatch(/Blast tower \(2 days\) · 55% · finishes/);
  });
});
