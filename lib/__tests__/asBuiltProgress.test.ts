// As built: how far a step was at any moment, from the times recorded on it.

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { builtCurve, pctAt } from "@/lib/asBuiltProgress";

const t = (s: string) => Date.parse(`${s}-07:00`);
const m = (x: Record<string, unknown>) => ({ id: "s", name: "Pull Feed", parentId: null, status: "planned", percentComplete: 0, plannedStartAt: "2026-10-24T14:00:00-07:00", plannedAt: "2026-10-24T18:00:00-07:00", ...x } as unknown as Milestone);
const now = t("2026-11-08T09:00:00");

describe("builtCurve", () => {
  it("started 10 PM, done 3 AM: 40% at midnight (2 of its 5 hours)", () => {
    const c = builtCurve(m({ status: "completed", percentComplete: 100, actualStartAt: "2026-10-24T22:00:00-07:00", actualAt: "2026-10-25T03:00:00-07:00" }), [], now);
    expect(pctAt(c, t("2026-10-24T21:00:00"))).toBe(0);
    expect(pctAt(c, t("2026-10-25T00:00:00"))).toBeCloseTo(40);
    expect(pctAt(c, t("2026-10-25T03:00:00"))).toBe(100);
  });
  it("a % entered on the way is kept; a % later corrected down counts the lower one back", () => {
    const log = [
      { milestone_id: "s", at: "2026-10-25T00:00:00-07:00", old_status: "in_progress", old_percent: 0, new_status: "in_progress", new_percent: 60 },
      { milestone_id: "s", at: "2026-10-25T01:00:00-07:00", old_status: "in_progress", old_percent: 60, new_status: "in_progress", new_percent: 30 },
    ] as never;
    const c = builtCurve(m({ status: "in_progress", percentComplete: 30, actualStartAt: "2026-10-24T22:00:00-07:00" }), log, now);
    expect(pctAt(c, t("2026-10-25T00:00:00"))).toBe(30);
    expect(pctAt(c, now)).toBe(30);
  });
  it("open with no start recorded: from when the log has it going, as recorded, never guessed forward", () => {
    const log = [{ milestone_id: "s", at: "2026-10-25T02:00:00-07:00", old_status: "planned", old_percent: 0, new_status: "in_progress", new_percent: 20 }] as never;
    const c = builtCurve(m({ status: "in_progress", percentComplete: 20 }), log, now);
    expect(pctAt(c, t("2026-10-25T01:59:00"))).toBe(0);
    expect(pctAt(c, t("2026-10-26T00:00:00"))).toBe(20);
  });
  it("done with no time it was done: can't be placed, said so", () => {
    expect(builtCurve(m({ status: "completed", percentComplete: 100 }), [], now)).toEqual({ points: [], untimed: 100 });
  });
});
