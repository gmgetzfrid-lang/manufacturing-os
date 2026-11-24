// How a phase did: its own steps only, progress day by day from the log,
// and its share of the money (lines kept for a phase, the rest by share).

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { phaseStats, phaseReportHtml, slipWords, shiftLines, runLabel, hoursDays, withDays, closeoutPrint, foldSameRows, type CostLine, type CostEntry, type ShiftRow } from "@/lib/phaseReport";
import { toEmailHtml, toPlainText, type ExportDoc } from "@/lib/reportExport";
import { PHASE_ATTR, type ProjectPhase } from "@/lib/projectPhases";

const tz = "America/Los_Angeles";
const at = (d: string, h = "12:00") => `${d}T${h}:00-08:00`;
const P: ProjectPhase[] = [
  { id: "a", name: "Transmix-1", start: "2026-11-01", end: "2026-11-03", share: 50 },
  { id: "b", name: "Transmix-2", start: "2026-11-08", end: "2026-11-10", share: 50 },
];
const m = (id: string, x: Record<string, unknown>) => ({ id, name: id, parentId: null, status: "planned", percentComplete: 0, ...x } as unknown as Milestone);
const ms: Milestone[] = [
  m("t1", {}), // phase 1 task
  m("s1", { parentId: "t1", plannedStartAt: at("2026-11-01", "06:00"), plannedAt: at("2026-11-01", "16:00"), durationHours: 10, status: "completed", percentComplete: 100, actualAt: at("2026-11-01", "15:00") }),
  m("s2", { parentId: "t1", plannedStartAt: at("2026-11-02", "06:00"), plannedAt: at("2026-11-02", "16:00"), durationHours: 10, status: "in_progress", percentComplete: 50 }),
  m("t2", { attributes: { [PHASE_ATTR]: "b" } }),
  m("s3", { parentId: "t2", plannedStartAt: at("2026-11-08", "06:00"), plannedAt: at("2026-11-08", "16:00"), durationHours: 20, attributes: { discovery: { id: "d1", seq: 1, what: "x", impact: { hours: 20 } } } }),
];
const log = [{ milestone_id: "s2", at: at("2026-11-02", "10:00"), old_status: "planned", old_percent: 0, new_status: "in_progress", new_percent: 50 }] as never;
const lines: CostLine[] = [
  { id: "L1", name: "Mechanical", budget: 1000, phase_id: null },
  { id: "L2", name: "Cleaning", budget: 400, phase_id: "a" },
];
const entries: CostEntry[] = [
  { cost_account_id: "L1", entry_type: "actual", amount: 300, entry_date: "2026-11-02", status: "posted" },
  { cost_account_id: "L1", entry_type: "actual", amount: 100, entry_date: "2026-11-09", status: "posted" },
  { cost_account_id: "L2", entry_type: "commitment", amount: 200, entry_date: "2026-11-01", status: "posted" },
  { cost_account_id: "L1", entry_type: "actual", amount: 999, entry_date: "2026-11-02", status: "void" },
];
const now = Date.parse(at("2026-11-02", "18:00"));

describe("phaseStats", () => {
  const s = phaseStats({ milestones: ms, phases: P, phase: P[0], log, tz, now, total: 2000, lines, entries });
  it("only the phase's steps", () => {
    expect(s).toMatchObject({ steps: 2, done: 1, hours: 20, actualPct: 75, plannedPct: 100 });
    expect(s.added.count).toBe(0);
  });
  it("shift by shift: the plan stops once it's done; done as built; shifts to come have no done figure", () => {
    expect(s.shifts.map((r) => [r.dayKey, r.kind, r.plan, r.done, r.planEnds, r.current])).toEqual([
      ["2026-11-01", "day", 50, 50, false, false],
      ["2026-11-01", "night", 50, 50, false, false],
      ["2026-11-02", "day", 100, 75, true, false],
      ["2026-11-02", "night", null, 75, false, true],
    ]);
    // s1 was marked done with no start: spread from its planned start, and said so.
    expect(s.startGuessed).toBe(1);
    expect(s.planBasis).toMatchObject({ kind: "schedule", hours: 20, steps: 2 });
  });
  it("the shift under way is measured against the plan by now, not by its end", () => {
    const mid = Date.parse(at("2026-11-02", "11:00"));
    const r = phaseStats({ milestones: ms, phases: P, phase: P[0], log, tz, now: mid, total: 2000, lines, entries });
    const cur = r.shifts.find((x) => x.current)!;
    // s2 planned 6 AM to 4 PM: half way by 11 AM. Plan by now 75%, not the 100% due at 6 PM; done 75%.
    expect([cur.plan, cur.done]).toEqual([75, 75]);
    expect(r.plannedPct).toBe(75);
    expect(r.slip.forGood).toBeNull();
    // Behind now, with the phase still going: said as so far, not "for good".
    const idle = ms.map((x) => (x.id === "s2" ? ({ ...x, status: "planned", percentComplete: 0 } as Milestone) : x));
    const r2 = phaseStats({ milestones: idle, phases: P, phase: P[0], log: [], tz, now: mid, total: 2000, lines, entries });
    expect(slipWords(r2, tz).join(" ")).toMatch(/Behind the plan since Mon, Nov 2 · Day: [\d.]+% done against 75% planned so far, and hasn't caught up yet\./);
    expect(slipWords(r2, tz).join(" ")).not.toMatch(/for good/);
  });
  it("a step reset in the log and then finished counts as built: its % entered, then spread to its finish", () => {
    const ms2 = [
      m("r1", { plannedStartAt: at("2026-11-01", "06:00"), plannedAt: at("2026-11-01", "16:00"), durationHours: 10, status: "completed", percentComplete: 100, actualAt: at("2026-11-01", "15:00") }),
      m("r2", { plannedStartAt: at("2026-11-01", "06:00"), plannedAt: at("2026-11-01", "16:00"), durationHours: 10, status: "completed", percentComplete: 100, actualAt: at("2026-11-02", "09:00") }),
    ];
    const log2 = [
      { milestone_id: "r1", at: at("2026-10-31", "10:00"), old_status: "planned", old_percent: 0, new_status: "completed", new_percent: 100 },
      { milestone_id: "r1", at: at("2026-11-01", "08:00"), old_status: "completed", old_percent: 100, new_status: "planned", new_percent: 0 },
      { milestone_id: "r2", at: at("2026-11-01", "12:00"), old_status: "planned", old_percent: 0, new_status: "in_progress", new_percent: 40 },
    ] as never;
    const r = phaseStats({ milestones: ms2, phases: [], phase: null, log: log2, tz, now: Date.parse(at("2026-11-05")), total: null, lines: [], entries: [] });
    expect(r.shifts.map((x) => x.done)).toEqual([77.9, 95, 100]);
    expect(r.shifts.map((x) => x.plan)).toEqual([100, null, null]);
  });
  it("the original plan as saved: re-planned dates don't move it; added work is counted on its own, from when it was found", () => {
    const found = Date.parse(at("2026-11-01", "20:00"));
    const ms3 = [
      m("b1", { plannedStartAt: at("2026-11-02", "06:00"), plannedAt: at("2026-11-02", "16:00"), baselineStartAt: at("2026-11-01", "06:00"), baselineFinishAt: at("2026-11-01", "16:00"), baselineSetAt: at("2026-10-30", "09:00"),
        durationHours: 10, status: "completed", percentComplete: 100, actualStartAt: at("2026-11-02", "06:00"), actualAt: at("2026-11-02", "15:00") }),
      m("a1", { plannedStartAt: at("2026-11-02", "06:00"), plannedAt: at("2026-11-02", "10:00"), durationHours: 4, status: "completed", percentComplete: 100, actualStartAt: at("2026-11-02", "06:00"), actualAt: at("2026-11-02", "09:00"),
        attributes: { discovery: { id: "d1", seq: 1, what: "x", foundAt: found, impact: { hours: 4 } } } }),
    ];
    const r = phaseStats({ milestones: ms3, phases: [], phase: null, log: [], tz, now: Date.parse(at("2026-11-05")), total: null, lines: [], entries: [] });
    expect(r.planBasis).toMatchObject({ kind: "baseline", hours: 10, steps: 1, finish: Date.parse(at("2026-11-01", "16:00")) });
    expect(r.outside).toEqual({ steps: 1, hours: 4 });
    expect(r.plannedFinish).toBe(Date.parse(at("2026-11-01", "16:00")));
    expect(r.shifts.map((x) => [x.plan, x.done, x.addedKnown, x.addedDone])).toEqual([[100, 0, 0, 0], [null, 0, 4, 0], [null, 100, 4, 4]]);
    expect(r.startGuessed).toBe(0);
    // Behind from the plan's finish until the work was done; what was behind, and what ran past it.
    expect(r.shifts.map((x) => x.finishes)).toEqual([false, false, true]);
    expect(r.slip.first?.dayKey).toBe("2026-11-01");
    expect(r.slip.forGood).toBe(r.slip.first);
    expect(r.slip.widest).toMatchObject({ points: 100, hours: 10 });
    expect(r.slip.behind.map((x) => [x.id, x.hoursBehind])).toEqual([["b1", 10]]);
    expect(r.slip.pastPlan.map((x) => [x.id, x.inPlan, x.hoursBehind])).toEqual([["a1", false, 4], ["b1", true, 10]]);
    const html = phaseReportHtml({ project: "T", tz, now: Date.parse(at("2026-11-05")), picked: null, all: r, each: [] });
    expect(html).toContain("Why it finished late");
    expect(html).toContain("Fell behind the plan for good Sun, Nov 1 · Day: 0% done against 100% planned");
    expect(html).toContain("Still going when the plan said done");
    expect(html).toContain("late</b>");
  });
  it("a schedule put in after its planned start, with nothing recorded before then, says so", () => {
    const late = ms.map((x) => ({ ...x, createdAt: at("2026-11-02", "13:00"), ...(x.id === "s1" ? { status: "planned", percentComplete: 0, actualAt: null } : {}) } as Milestone));
    const a = phaseStats({ milestones: late, phases: P, phase: P[0], log: [], tz, now, total: 2000, lines, entries });
    expect(a.loadedLate).toBe(Date.parse(at("2026-11-02", "13:00")));
    expect(slipWords(a, tz)[0]).toMatch(/^The schedule was put in Mon, Nov 2, 1:00 PM, after its planned start \(Sun, Nov 1, 6:00 AM\)/);
    // Recorded work before it was put in (entered after): no such note.
    expect(s.loadedLate).toBeNull();
  });
  it("the whole project in phases: no merged progress line; each phase against its own plan", () => {
    const b = phaseStats({ milestones: ms, phases: P, phase: P[1], log, tz, now, total: 2000, lines, entries });
    const all = phaseStats({ milestones: ms, phases: P, phase: null, log, tz, now, total: 2000, lines, entries });
    const html = phaseReportHtml({ project: "T", tz, now, picked: null, all, each: [s, b] });
    const whole = html.slice(html.indexOf("Whole project</div>"), html.indexOf("Transmix-1</div>"));
    expect(whole).toContain("Each phase is measured against its own plan below");
    expect(whole).not.toContain("shift by shift");
    expect(html.slice(html.indexOf("Transmix-1</div>"))).toContain("shift by shift");
  });
  it("a phase with no schedule: not 0 of 0, and the whole project isn't done", () => {
    const only1 = ms.filter((x) => !["t2", "s3"].includes(x.id!)).map((x) => (x.id === "s2" ? { ...x, status: "completed", percentComplete: 100, actualAt: at("2026-11-02", "15:00") } as Milestone : x));
    const b = phaseStats({ milestones: only1, phases: P, phase: P[1], log, tz, now, total: 2000, lines, entries });
    expect(b).toMatchObject({ noSchedule: true, steps: 0, shifts: [] });
    const a = phaseStats({ milestones: only1, phases: P, phase: P[0], log, tz, now, total: 2000, lines, entries });
    expect(a.finishedAt).toBe(Date.parse(at("2026-11-02", "15:00")));
    const all = phaseStats({ milestones: only1, phases: P, phase: null, log, tz, now, total: 2000, lines, entries });
    expect(all.missing.map((p) => p.id)).toEqual(["b"]);
    expect(all.phasesDone).toBe(1);
    expect(all.finishedAt).toBeNull();
    const html = phaseReportHtml({ project: "Transmix", tz, now, picked: null, all, each: [a, b] });
    expect(html).toContain("no schedule yet, starts Sun, Nov 8");
    // Phase 1 finished Nov 2; the whole project didn't.
    expect(html).toMatch(/Transmix-1<div[^>]*>[^<]*<\/div><\/td>[\s\S]*?done Nov 2/);
    expect(html).toMatch(/Whole project<\/td>[\s\S]*?not finished/);
  });
  it("money: the phase's share of the AFE, its own lines whole, spend by date", () => {
    expect(s.budget).toBe(1000);
    expect(s.lines).toEqual([{ name: "Mechanical", budget: 500, committed: 0, spent: 300 }, { name: "Cleaning", budget: 400, committed: 200, spent: 0 }]);
    expect([s.committed, s.spent]).toEqual([200, 300]);
  });
  it("phase 2 and the whole project", () => {
    const b = phaseStats({ milestones: ms, phases: P, phase: P[1], log, tz, now, total: 2000, lines, entries });
    expect(b).toMatchObject({ steps: 1, done: 0, added: { count: 1, steps: 1, hours: 20 }, budget: 1000, spent: 100 });
    expect(b.lines.map((l) => l.name)).toEqual(["Mechanical"]);
    const all = phaseStats({ milestones: ms, phases: P, phase: null, log, tz, now, total: 2000, lines, entries });
    expect(all).toMatchObject({ steps: 3, budget: 2000, spent: 400, committed: 200 });
  });
  it("the report says it", () => {
    const b = phaseStats({ milestones: ms, phases: P, phase: P[1], log, tz, now, total: 2000, lines, entries });
    const all = phaseStats({ milestones: ms, phases: P, phase: null, log, tz, now, total: 2000, lines, entries });
    const html = phaseReportHtml({ project: "Transmix 1 and 2", tz, now, picked: s, all, each: [s, b] });
    expect(html).toContain("Transmix-1 phase report");
    expect(html).toContain("Whole project");
    expect(html).toContain("$1,000");
    expect(html).not.toMatch(/[—]/);
  });
});

describe("the shift-by-shift chart", () => {
  const row = (dayKey: string, kind: "day" | "night", plan: number | null, done: number | null, extra: Partial<ShiftRow> = {}): ShiftRow =>
    ({ kind, dayKey, start: 0, end: 0, plan, planEnds: false, done, addedKnown: 0, addedDone: 0, current: false, finishes: false, ...extra });
  const days = Array.from({ length: 9 }, (_, i) => `2026-11-0${i + 1}`);
  const rows = [
    row("2026-10-31", "day", 90, 80),
    row("2026-10-31", "night", 100, 99.7, { planEnds: true }),
    ...days.flatMap((d) => [row(d, "day", null, 99.7), row(d, "night", null, 99.7)]),
    row("2026-11-10", "day", null, 100, { finishes: true }),
  ];
  it("shifts that all say the same are one line, never a column of identical rows", () => {
    const lines = shiftLines(rows);
    expect(lines.map((l) => (l.kind === "same" ? `same ${l.rows.length}` : l.row.dayKey))).toEqual(["2026-10-31", "2026-10-31", "same 18", "2026-11-10"]);
    const same = lines[2];
    expect(same.kind === "same" && runLabel(same.rows)).toBe("Sun, Nov 1 to Mon, Nov 9");
  });
  it("the plan's end and the finish stay rows of their own; two alike stay two", () => {
    expect(shiftLines([row("2026-11-01", "day", null, 50), row("2026-11-01", "night", null, 50)]).map((l) => l.kind)).toEqual(["shift", "shift"]);
    expect(shiftLines([row("2026-11-01", "day", 100, 50, { planEnds: true }), row("2026-11-01", "night", 100, 50), row("2026-11-02", "day", 100, 50)]).map((l) => l.kind)).toEqual(["shift", "shift", "shift"]);
    expect(runLabel([row("2026-11-01", "night", null, 1), row("2026-11-02", "day", null, 1)])).toBe("Sun, Nov 1 Night to Mon, Nov 2 Day");
  });
});

describe("hours over a day say days", () => {
  it("hoursDays and withDays", () => {
    expect(hoursDays(791.4)).toBe("791.4 h (33 days)");
    expect(hoursDays(33.5)).toBe("33.5 h (1.4 days)");
    expect(hoursDays(24)).toBe("24 h (1 day)");
    expect(hoursDays(-12)).toBe("12 h");
    expect(withDays("+791.4 h")).toBe("+791.4 h (33 days)");
    expect(withDays("made up 26 h")).toBe("made up 26 h (1.1 days)");
    expect(withDays("12 h")).toBe("12 h");
    expect(withDays("-")).toBe("-");
  });
});

describe("the close-out as printed", () => {
  const doc: ExportDoc = {
    kind: "Close-out meeting", project: "T", when: "Planned finish Sat", asOf: "Nov 24",
    sections: [
      { id: "final", title: "Final standing", sub: "Planned finish Sat · finished Mon (791.4321 h after plan)", blocks: [{ k: "stats", items: [{ label: "Complete", value: "100%", tone: "emerald" }] }] },
      { id: "open", title: "Still open", blocks: [{ k: "empty", text: "Nothing open." }] },
      { id: "cancelled", title: "Cancelled from this schedule", blocks: [{ k: "table", head: ["Job", "Moved to", "Note", "Cancelled"], rows: [
        ["E-12: Hotshot", "Redman", "Completed at Redman", "Oct 30 · Pat"],
        ["E-13: Hotshot", "Redman", "Completed at Redman", "Oct 30 · Pat"],
        ["E-14: Hotshot", "Redman", "Completed at Redman", "Oct 31 · Pat"],
        ["V-7: Inspect", "-", "Moved to the 2027 turnaround: the vessel goes back in service before then", "Nov 1 · Lee"],
      ] }] },
      { id: "lookback", title: "Look back - where the time went", blocks: [
        { k: "stats", items: [{ label: "Planned finish", value: "Sat 10/31 6:00 PM", tone: "slate" }, { label: "Finished", value: "Mon 11/2 3:30 AM", tone: "slate" }, { label: "Late by", value: "33.5 h", tone: "rose" }, { label: "Steps that lost time", value: "3", tone: "amber" }] },
        { k: "table", head: ["Cause", "Hours lost", "Steps"], rows: [["On hold / blocked", "24 h", "1"], ["Took longer than planned", "9.5 h", "2"]] },
      ] },
      { id: "setbacks", title: "What set us back", blocks: [{ k: "table", head: ["Step", "WO", "Who", "Lost", "Why"], nowrap: [3], rows: [
        [{ t: "Pull bundle", note: "E-12" }, "12", "Ancon", { t: "+26 h", tone: "rose", bold: true }, "on hold 20 h, waiting on material; ran 6 h longer than planned"],
      ] }] },
    ],
  };
  const out = closeoutPrint(doc);
  it("where the time went comes right under the opening tiles", () => {
    expect(out.sections.map((s) => s.id)).toEqual(["final", "lookback", "open", "cancelled", "setbacks"]);
    expect(out.sections[0].sub).toBe("Current plan finish Sat · finished Mon (791.4 h (33 days) after the original plan)");
    expect(out.sections[1].blocks[0]).toMatchObject({ k: "stats", items: [{ label: "Original plan finish" }, { label: "Finished" }, { label: "Late by", value: "33.5 h (1.4 days)" }, { value: "3" }] });
    expect(out.sections[1].blocks[1]).toMatchObject({ rows: [["On hold / blocked", "24 h (1 day)", "1"], ["Took longer than planned", "9.5 h", "2"]] });
  });
  it("a late by worked out from a forecast says so", () => {
    const open = closeoutPrint({ ...doc, sections: [{ id: "lookback", title: "Look back", blocks: [{ k: "stats", items: [{ label: "Forecast finish", value: "Tue", tone: "slate" }, { label: "Late by", value: "30 h", tone: "rose" }] }] }] });
    expect(open.sections[0].blocks[0]).toMatchObject({ items: [{ label: "Forecast finish" }, { label: "Forecast late by", value: "30 h (1.3 days)" }] });
  });
  it("jobs cancelled the same way are one counted row that still lists each; the note goes under its row", () => {
    const t = out.sections[3].blocks[0];
    expect(t.k === "table" && t.head).toEqual(["Cancelled", "Job", "Moved to"]);
    expect(t.k === "table" && t.rows).toEqual([
      ["Oct 30 · Pat; Oct 31 · Pat", { t: "3 jobs", bold: true, sub: [{ t: "E-12: Hotshot; E-13: Hotshot; E-14: Hotshot" }, { t: "Note: Completed at Redman", italic: true }] }, "Redman"],
      ["Nov 1 · Lee", { t: "V-7: Inspect", sub: [{ t: "Note: Moved to the 2027 turnaround: the vessel goes back in service before then", italic: true }] }, "-"],
    ]);
  });
  it("a long why is a line under its step, the hours lead the row", () => {
    const t = out.sections[4].blocks[0];
    expect(t.k === "table" && t.head).toEqual(["Lost", "Step", "WO", "Who"]);
    expect(t.k === "table" && t.nowrap).toEqual([0]);
    expect(t.k === "table" && t.rows[0][0]).toEqual({ t: "+26 h (1.1 days)", tone: "rose", bold: true });
    expect(t.k === "table" && t.rows[0][1]).toEqual({ t: "Pull bundle", note: "E-12", sub: [{ t: "Why: on hold 20 h, waiting on material; ran 6 h longer than planned", italic: false }] });
  });
  it("nothing is lost in the email or the plain text", () => {
    for (const text of [toPlainText(out), toEmailHtml(out)]) {
      for (const w of ["3 jobs", "E-13: Hotshot", "Completed at Redman", "Oct 31 · Pat", "2027 turnaround", "waiting on material", "33.5 h (1.4 days)"]) expect(text).toContain(w);
    }
  });  it("eight jobs that each say \"Completed at Redman\" are one line saying how many", () => {
    const rows = Array.from({ length: 8 }, (_, i) => [`E-22: Step ${i + 1}`, "-", "Completed at Redman", `Nov 16 · Ian`]);
    const one = closeoutPrint({ ...doc, sections: [{ id: "cancelled", title: "Cancelled", blocks: [{ k: "table", head: ["Job", "Moved to", "Note", "Cancelled"], rows }] }] });
    const t = one.sections[0].blocks[0];
    expect(t.k === "table" && t.rows).toHaveLength(1);
    expect(t.k === "table" && t.rows[0]).toEqual(["Nov 16 · Ian", { t: "8 jobs", bold: true, sub: [{ t: rows.map((r) => r[0]).join("; ") }, { t: "Note: Completed at Redman", italic: true }] }, "-"]);
    expect((toPlainText(one).match(/Completed at Redman/g) ?? []).length).toBe(1);
  });
  it("any other table: three or more rows in a row that say the same are one line; two alike stay two", () => {
    const well = closeoutPrint({ ...doc, sections: [{ id: "well", title: "What went well", blocks: [{ k: "table", head: ["Step", "Crew", "Early"], rows: [
      [{ t: "Pull plugs", note: "E-8" }, "Schultz", "8 h"], [{ t: "Set plugs", note: "E-8" }, "Schultz", "8 h"], ["Hydro", "Schultz", "8 h"], ["Hydro", "Schultz", "8 h"],
      ["Clean", "Ancon", "2 h"], ["Vacuum", "Ancon", "2 h"],
    ] }] }] });
    const t = well.sections[0].blocks[0];
    expect(t.k === "table" && t.rows).toEqual([
      [{ t: "4 steps", bold: true, sub: [{ t: "E-8: Pull plugs; E-8: Set plugs; Hydro (2 times)" }] }, "Schultz", "8 h"],
      ["Clean", "Ancon", "2 h"], ["Vacuum", "Ancon", "2 h"],
    ]);
  });
  it("a time column is joined; a row carrying more than its name is never folded", () => {
    const b = { k: "table" as const, head: ["Job", "When", "Note"], rows: [["A", "Nov 1", "Done"], ["B", "Nov 2", "Done"], ["C", "Nov 2", "Done"], [{ t: "D", sub: [{ t: "kept" }] }, "Nov 3", "Done"]] };
    expect(foldSameRows(b, { loose: [1] }).rows).toEqual([[{ t: "3 jobs", bold: true, sub: [{ t: "A; B; C" }] }, "Nov 1; Nov 2", "Done"], b.rows[3]]);
    expect(foldSameRows(b)).toBe(b);
  });
});
