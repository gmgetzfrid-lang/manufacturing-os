// A fix to what an earlier shift entered goes on that shift — this shift's
// progress counts from the fixed number, not from the mistake.

import { describe, it, expect } from "vitest";
import { buildShiftReport, creditShifts, shiftWindow, type ShiftTimes } from "@/lib/shiftReport";
import { scheduleAt } from "@/lib/progressHistory";
import type { Milestone } from "@/types/schema";

const LA = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00" };
const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-07:00`)).toISOString();
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

describe("the shifts a change can count for", () => {
  it("the two before the one running now, by name, filed a minute before each ended", () => {
    const c = creditShifts(Date.parse(at("2026-10-27", "13:28")), LA, times);
    expect(c.map((x) => x.label)).toEqual(["Mon night", "Mon day"]);
    expect(new Date(c[0].at).toISOString()).toBe(at("2026-10-27", "05:59"));
    expect(new Date(c[1].at).toISOString()).toBe(at("2026-10-26", "17:59"));
  });
  it("on a night shift, after midnight: the day before it, then the night before that", () => {
    const c = creditShifts(Date.parse(at("2026-10-28", "02:00")), LA, times);
    expect(c.map((x) => x.label)).toEqual(["Tue day", "Mon night"]);
  });
});

describe("a correction filed under the shift it was about", () => {
  const e17 = mk({ id: "e17", name: "E-17" });
  // Planned Mon–Tue, 24 h of work; 60% now.
  const pull = mk({ id: "pb", name: "Pull bundle", parentId: "e17", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-27", "18:00"), durationHours: 24, status: "in_progress", percentComplete: 60 });
  const ms = [e17, pull];
  const tueDay = shiftWindow("2026-10-27", "day", LA, times);
  const monDay = shiftWindow("2026-10-26", "day", LA, times);
  const row = (when: string, from: number, to: number) => ({ milestone_id: "pb", at: when, old_status: from ? "in_progress" : "planned", old_percent: from, new_status: "in_progress", new_percent: to });
  const base = [
    { milestone_id: "e17", at: at("2026-10-20", "00:00"), old_status: null, old_percent: null, new_status: "planned", new_percent: 0 },
    row(at("2026-10-26", "17:00"), 0, 25), // Mon: "pulled half" — 25%
  ];
  const startOf = (log: typeof base, w: { start: number }) => scheduleAt(ms, log as never, w.start).milestones.find((m) => m.id === "pb")!.percentComplete;
  it("typed in Tuesday as Tuesday's: Tuesday's progress counts from the mistake (25%)", () => {
    const log = [...base, row(at("2026-10-27", "13:28"), 25, 20), row(at("2026-10-27", "15:00"), 20, 60)];
    expect(startOf(log, tueDay)).toBe(25);
  });
  it("filed under Monday: Monday ends at 20%, and Tuesday moved 20 → 60", () => {
    const log = [...base, row(at("2026-10-26", "17:59"), 25, 20), row(at("2026-10-27", "15:00"), 20, 60)];
    expect(startOf(log, tueDay)).toBe(20);
    const monEnd = scheduleAt(ms, log as never, monDay.end + 3_600_000).milestones.find((m) => m.id === "pb")!;
    expect(monEnd.percentComplete).toBe(20);
    const startPct = new Map([["pb", 20], ["e17", 0]]);
    const r = buildShiftReport({ milestones: ms, tz: LA, times, shift: tueDay, now: tueDay.end, startPct });
    expect(r.review.progressed.map((x) => [x.leaf.id, x.pctStart, x.percent])).toEqual([["pb", 20, 60]]);
  });
});
