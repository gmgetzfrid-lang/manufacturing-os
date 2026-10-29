// The screen shows a saved change where the save will put it: the actual
// start and finish worked out the same way the database update does.

import { describe, it, expect } from "vitest";
import { timesAfterStatus, timesAfterProgress } from "@/lib/optimisticTimes";
import type { Milestone } from "@/types/schema";

const NOW = "2026-10-29T15:00:00.000Z";
const mk = (p: Partial<Milestone>): Milestone => ({ orgId: "o", projectId: "p", name: "s", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

describe("actual times after a status change", () => {
  it("started at the time put in; a start already on record stays", () => {
    expect(timesAfterStatus(mk({}), "in_progress", "2026-10-27T08:00:00.000Z", NOW)).toEqual({ actualAt: null, actualStartAt: "2026-10-27T08:00:00.000Z" });
    expect(timesAfterStatus(mk({ status: "blocked", actualStartAt: "2026-10-26T08:00:00.000Z" }), "in_progress", "2026-10-27T08:00:00.000Z", NOW)).toEqual({ actualAt: null });
  });
  it("finished at the time put in; a start after it moves back to it", () => {
    expect(timesAfterStatus(mk({ status: "in_progress", actualStartAt: "2026-10-27T08:00:00.000Z" }), "completed", "2026-10-27T20:00:00.000Z", NOW)).toEqual({ actualAt: "2026-10-27T20:00:00.000Z" });
    expect(timesAfterStatus(mk({}), "completed", "2026-10-27T20:00:00.000Z", NOW)).toEqual({ actualAt: "2026-10-27T20:00:00.000Z", actualStartAt: "2026-10-27T20:00:00.000Z" });
  });
  it("never after now; done again with no time keeps its finish", () => {
    expect(timesAfterStatus(mk({}), "in_progress", "2026-10-30T08:00:00.000Z", NOW).actualStartAt).toBe(NOW);
    expect(timesAfterStatus(mk({ status: "completed", actualAt: "2026-10-27T20:00:00.000Z" }), "completed", undefined, NOW)).toEqual({});
  });
  it("on hold, blocked or back to not started: no finish", () => {
    expect(timesAfterStatus(mk({ status: "in_progress" }), "blocked", "2026-10-27T20:00:00.000Z", NOW)).toEqual({ actualAt: null });
    expect(timesAfterStatus(mk({ status: "completed" }), "planned", undefined, NOW)).toEqual({ actualAt: null });
  });
});

describe("actual times after a % change", () => {
  it("first % over 0 starts it; 100 finishes it", () => {
    expect(timesAfterProgress(mk({}), 20, "2026-10-27T08:00:00.000Z", NOW)).toEqual({ actualAt: null, actualStartAt: "2026-10-27T08:00:00.000Z" });
    expect(timesAfterProgress(mk({ status: "in_progress", actualStartAt: "2026-10-27T08:00:00.000Z" }), 100, "2026-10-27T20:00:00.000Z", NOW)).toEqual({ actualAt: "2026-10-27T20:00:00.000Z" });
    expect(timesAfterProgress(mk({}), 0, undefined, NOW)).toEqual({ actualAt: null });
  });
});
