import { describe, it, expect } from "vitest";
import type { MilestoneNote } from "@/types/schema";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { holdsFromLog } from "@/lib/lookBack";

// Tue Oct 27 2026, local times (PDT, -7), entered the day after.
const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h + 7, m)).toISOString();
const row = (when: string, from: string, to: string): ProgressLogRow => ({ milestone_id: "s", at: when, old_status: from, new_status: to, old_percent: 0, new_percent: 0 } as ProgressLogRow);
const said = (status: string, body: string | null, typed: string, happened?: string): MilestoneNote =>
  ({ id: typed, milestoneId: "s", kind: "status", statusAt: status, body, createdAt: typed, happenedAt: happened ?? null } as unknown as MilestoneNote);

describe("a hold is timed from when it happened, not from when its notes were typed", () => {
  // Three stand-downs on one step, all entered two days later in one sitting.
  // Each hold's note carries the time it happened; each release's note only the time it was typed.
  const log = [
    row(at(26, 19), "planned", "blocked"), row(at(27, 1), "blocked", "in_progress"),
    row(at(27, 11), "in_progress", "blocked"), row(at(27, 11, 30), "blocked", "in_progress"),
    row(at(27, 12, 30), "in_progress", "blocked"), row(at(27, 13, 15), "blocked", "in_progress"),
    row(at(28, 5, 30), "in_progress", "completed"),
  ];
  const notes = [
    said("blocked", "LEL's detected in vessel. Crew stand down for air stripping the tower.", at(28, 14, 32), at(26, 19)),
    said("in_progress", null, at(28, 14, 35)),
    said("blocked", "SRU incinerator acting up precautionary stand down.", at(28, 14, 56), at(27, 11)),
    said("in_progress", null, at(28, 14, 58)),
    said("blocked", "LEL's picked up on monitors. Tower crew stand down.", at(28, 17, 7), at(27, 12, 30)),
    said("in_progress", null, at(28, 17, 9)),
  ];
  const holds = holdsFromLog(log, notes, Date.parse(at(28, 5, 30)))!;
  const hours = (h: { from: number; to: number }) => (h.to - h.from) / 3_600_000;
  it("gives each hold its own start and end", () => {
    expect(holds.map(hours)).toEqual([6, 0.5, 0.75]);
    // Not one hold from the first stand-down to the last release (18.25 h).
    expect(Math.max(...holds.map(hours))).toBe(6);
  });
  it("puts the reason written at the time on each", () => {
    expect(holds.map((h) => h.reason.split(".")[0])).toEqual(["LEL's detected in vessel", "SRU incinerator acting up precautionary stand down", "LEL's picked up on monitors"]);
  });
  it("runs a hold that was never released to the end given, and says nothing when the record has no hold", () => {
    expect(holdsFromLog([row(at(27, 8), "in_progress", "on_hold")], [], Date.parse(at(27, 12)))!.map(hours)).toEqual([4]);
    expect(holdsFromLog([row(at(27, 8), "planned", "in_progress")], notes, 0)).toBe(null);
  });
});
