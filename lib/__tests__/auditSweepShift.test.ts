// The second audit sweep's findings, one test each: night work that isn't
// staffed, goals, completions, date-only nights, pulled-ahead order, and
// what the email claims.

import { describe, it, expect } from "vitest";
import { buildShiftReport, shiftWindow, isOverdue, worksIn, DEFAULT_SHIFT_TIMES } from "@/lib/shiftReport";
import { applyNightStaffing } from "@/lib/nightStaffing";
import { turnoverUpdate } from "@/lib/managementUpdate";
import { toPlainText } from "@/lib/reportExport";
import type { Milestone } from "@/types/schema";

const CHI = "America/Chicago";
const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-05:00`)).toISOString();
const day = (d: string) => new Date(Date.parse(`${d}T00:00:00-05:00`)).toISOString();
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const f = { D: (x: number) => new Date(x).toISOString().slice(5, 10), DTs: (x: number) => new Date(x).toISOString().slice(5, 16), T: (x: number) => new Date(x).toISOString().slice(11, 16), win: () => "", hrs: (h: number) => `${h} h` };
const T = DEFAULT_SHIFT_TIMES;   // 05:30 / 17:30

describe("night crews: only the jobs that have one", () => {
  // The tower has a night crew; the exchanger doesn't, but the file put its
  // hydroblast overnight.
  const tower = mk({ id: "v7", name: "V-7" });
  const trays = mk({ id: "tr", name: "Pull trays", parentId: "v7", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-27", "04:00"), durationHours: 10 });
  const exch = mk({ id: "e17", name: "E-17" });
  const hydro = mk({ id: "hb", name: "Hydroblast", parentId: "e17", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-26", "22:00"), durationHours: 4, responsibleParty: "Ancon" });
  const all = applyNightStaffing([tower, trays, exch, hydro], ["v7"]);
  const day26 = shiftWindow("2026-10-26", "day", CHI);

  it("the night list has only the night job; the overnight day work waits for days", () => {
    const r = buildShiftReport({ milestones: all, tz: CHI, shift: day26, now: day26.end });
    expect(r.goals.all.map((x) => x.leaf.id)).toEqual(["tr"]);
    expect(r.goals.movedOff.map((x) => x.leaf.id)).toEqual(["hb"]);
  });
  it("it isn't overdue at 22:00 — it's the next day shift's first hours", () => {
    const hb = all.find((m) => m.id === "hb")!;
    expect(isOverdue(hb, Date.parse(at("2026-10-26", "23:00")), CHI, 0, T)).toBe(false);
    const night = shiftWindow("2026-10-26", "night", CHI);
    const r = buildShiftReport({ milestones: all, tz: CHI, shift: night, now: night.end });
    const row = r.goals.all.find((x) => x.leaf.id === "hb")!;
    expect(row).toBeTruthy();
    expect(row.reflowed).toBe(true);
    expect(new Date(row.crewStart).toISOString()).toBe(at("2026-10-27", "05:30"));
    expect(row.goalPct).toBe(100);
  });
  it("the email says it waits for the day crew, and never says 'if you can'", () => {
    const r = buildShiftReport({ milestones: all, tz: CHI, shift: day26, now: day26.end });
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: turnoverUpdate(r, f, { pctOf: () => 0, finishOf: () => undefined }) });
    expect(text).toMatch(/Hydroblast · .*no night crew/);
    expect(text).not.toMatch(/if you can/i);
  });
  it("nothing changes until night crews are named", () => {
    expect(applyNightStaffing([hydro], undefined)[0]).toBe(hydro);
    expect(applyNightStaffing([hydro], "file")[0]).toBe(hydro);
  });
});

describe("goals", () => {
  it("never below where the step already is", () => {
    const s = mk({ id: "s", name: "Blast", plannedStartAt: at("2026-10-26", "17:30"), plannedAt: at("2026-10-28", "05:30"), durationHours: 24, shift: "night", status: "in_progress", percentComplete: 80 });
    const d = shiftWindow("2026-10-26", "day", CHI);
    const r = buildShiftReport({ milestones: [s], tz: CHI, shift: d, now: d.end });
    const row = r.goals.all[0];
    expect(row.goalPct).toBeGreaterThanOrEqual(80);
  });
  it("a carry-over with more left than a shift aims for what a shift can do", () => {
    const s = mk({ id: "s", name: "Retube", plannedStartAt: at("2026-10-25", "05:30"), plannedAt: at("2026-10-26", "17:30"), durationHours: 48, shift: "swing", status: "in_progress", percentComplete: 10 });
    const d = shiftWindow("2026-10-26", "day", CHI);
    const r = buildShiftReport({ milestones: [s], tz: CHI, shift: d, now: d.end });
    expect(r.goals.all[0].carryOver).toBe(true);
    expect(r.goals.all[0].goalPct).toBe(35);   // 10% + 12 h of 48 h
  });
});

describe("completed means completed on this shift", () => {
  it("a long step done on an earlier shift isn't listed again", () => {
    const s = mk({ id: "s", name: "Hydro", plannedStartAt: at("2026-10-26", "05:30"), plannedAt: at("2026-10-28", "17:30"), shift: "swing", status: "completed", percentComplete: 100, actualAt: at("2026-10-26", "12:00") });
    const d27 = shiftWindow("2026-10-27", "day", CHI);
    expect(buildShiftReport({ milestones: [s], tz: CHI, shift: d27, now: d27.end }).review.done).toEqual([]);
    const d26 = shiftWindow("2026-10-26", "day", CHI);
    expect(buildShiftReport({ milestones: [s], tz: CHI, shift: d26, now: d26.end }).review.done.map((x) => x.leaf.id)).toEqual(["s"]);
  });
});

describe("date-only steps", () => {
  it("a night step dated the 27th is the night that starts on the 27th, not the one before", () => {
    const s = mk({ id: "s", name: "Pull trays", plannedStartAt: day("2026-10-27"), plannedAt: day("2026-10-27"), shift: "night" });
    expect(worksIn(s, shiftWindow("2026-10-26", "night", CHI), CHI)).toBe(false);
    expect(worksIn(s, shiftWindow("2026-10-27", "night", CHI), CHI)).toBe(true);
  });
  it("a day step dated today hasn't started late at the 05:30 meeting", () => {
    const s = mk({ id: "s", name: "Inspect", plannedStartAt: day("2026-10-26"), plannedAt: day("2026-10-26") });
    const n = shiftWindow("2026-10-25", "night", CHI);
    const r = buildShiftReport({ milestones: [s], tz: CHI, shift: n, now: n.end - 60_000 });
    expect(r.goals.all[0]?.lateStart).toBe(false);
  });
});

describe("can be pulled ahead — only when the step before it is done or on the list", () => {
  it("follows the equipment's step order when the file has no links", () => {
    const p = mk({ id: "p", name: "E-12" });
    const a = mk({ id: "a", name: "Open", parentId: "p", plannedStartAt: at("2026-10-27", "05:30"), plannedAt: at("2026-10-27", "09:30"), status: "blocked" });
    const b = mk({ id: "b", name: "Blast", parentId: "p", plannedStartAt: at("2026-10-27", "09:30"), plannedAt: at("2026-10-27", "13:30") });
    const d = shiftWindow("2026-10-26", "day", CHI);
    const r = buildShiftReport({ milestones: [p, a, b], tz: CHI, shift: d, now: d.end });
    expect(r.goals.stretch.map((x) => x.leaf.id)).not.toContain("b");
  });
});

describe("where we stand", () => {
  it("says when the planned finish has passed", () => {
    const s = mk({ id: "s", name: "Blind", plannedStartAt: at("2026-10-26", "05:30"), plannedAt: at("2026-10-26", "12:00"), status: "in_progress", percentComplete: 90 });
    const d = shiftWindow("2026-10-26", "day", CHI);
    const r = buildShiftReport({ milestones: [s], tz: CHI, shift: d, now: d.end });
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: turnoverUpdate(r, f, { pctOf: () => 90, finishOf: () => undefined }) });
    expect(text).toMatch(/planned finish .* — passed/);
    expect(text).not.toMatch(/holds for/);
  });
});
