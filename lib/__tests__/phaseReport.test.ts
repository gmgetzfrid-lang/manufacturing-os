// How a phase did: its own steps only, progress day by day from the log,
// and its share of the money (lines kept for a phase, the rest by share).

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { phaseStats, phaseReportHtml, type CostLine, type CostEntry } from "@/lib/phaseReport";
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
  m("s3", { parentId: "t2", plannedStartAt: at("2026-11-08", "06:00"), plannedAt: at("2026-11-08", "16:00"), durationHours: 20, attributes: { discovery: { what: "x" } } }),
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
  it("progress day by day from the log; days to come have no done figure", () => {
    expect(s.days).toEqual([
      { day: "2026-11-01", planned: 50, actual: 50 },
      { day: "2026-11-02", planned: 100, actual: 75 },
      { day: "2026-11-03", planned: 100, actual: null },
    ]);
  });
  it("a step reset in the log and then finished (back-dated) counts done by its finish, as the shift report reads it", () => {
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
    expect(r.days.map((d) => d.actual)).toEqual([70, 100]);
  });
  it("money: the phase's share of the AFE, its own lines whole, spend by date", () => {
    expect(s.budget).toBe(1000);
    expect(s.lines).toEqual([{ name: "Mechanical", budget: 500, committed: 0, spent: 300 }, { name: "Cleaning", budget: 400, committed: 200, spent: 0 }]);
    expect([s.committed, s.spent]).toEqual([200, 300]);
  });
  it("phase 2 and the whole project", () => {
    const b = phaseStats({ milestones: ms, phases: P, phase: P[1], log, tz, now, total: 2000, lines, entries });
    expect(b).toMatchObject({ steps: 1, done: 0, added: { count: 1, hours: 20 }, budget: 1000, spent: 100 });
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
