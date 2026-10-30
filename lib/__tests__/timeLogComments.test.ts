// A comment goes with the entry it was saved with: not the first entry
// typed near it. From the Oct 29 day shift, as entered.

import { describe, it, expect } from "vitest";
import { buildTimeLog, stepLabels } from "@/lib/timeLog";
import type { Milestone, MilestoneNote } from "@/types/schema";
import type { ShiftTimes } from "@/lib/shiftReport";

const tz = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00" };
const mk = (p: Partial<Milestone> & { id: string }): Milestone => ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "planned", source: "msproject", createdBy: "u", ...p } as Milestone);
const log = (id: string, at: string, entered: string | null, o: [string, number], n: [string, number]) =>
  ({ id: `${id}${at}`, milestone_id: id, at, entered_at: entered, old_status: o[0], old_percent: o[1], new_status: n[0], new_percent: n[1] }) as never;
const note = (id: string, kind: "note" | "status", created: string, happened: string | null, body: string | null): MilestoneNote =>
  ({ id: `${id}${created}`, milestoneId: id, kind, body, createdAt: created, happenedAt: happened, createdByName: "Gerry" }) as MilestoneNote;

const MS = [
  mk({ id: "e17", name: "E-17 - Exchanger" }), mk({ id: "b", parentId: "e17", name: "Install Bundle", responsibleParty: "Schultz" }),
  mk({ id: "v7", name: "V-7 - Piping" }),
  mk({ id: "p1", parentId: "v7", name: "Welded pipe replacements", responsibleParty: "Maintenance", plannedStartAt: "2026-10-29T14:00:00Z" }),
  mk({ id: "p2", parentId: "v7", name: "Welded pipe replacements", responsibleParty: "Maintenance", plannedStartAt: "2026-10-30T14:00:00Z" }),
];
const LOG = [
  // E-17, typed in at 4:05 to 4:08 PM: started 7:00, 50% at 10:00, 65% at 4:00 PM.
  log("b", "2026-10-29T14:00:00Z", "2026-10-29T23:05:59Z", ["planned", 0], ["in_progress", 0]),
  log("b", "2026-10-29T17:00:00Z", "2026-10-29T23:07:47Z", ["in_progress", 0], ["in_progress", 50]),
  log("b", "2026-10-29T23:00:00Z", "2026-10-29T23:08:51Z", ["in_progress", 50], ["in_progress", 65]),
  // Welded pipe: one entry at 4:37 PM, started 7:00 and 25% now.
  log("p1", "2026-10-29T14:00:00Z", "2026-10-29T23:36:37Z", ["planned", 0], ["in_progress", 0]),
  log("p1", "2026-10-29T23:37:34Z", null, ["in_progress", 0], ["in_progress", 25]),
];
const NOTES = [
  note("b", "note", "2026-10-29T23:07:47.9Z", "2026-10-29T17:00:00Z", "Bundles installed"),
  note("b", "note", "2026-10-29T23:08:52.5Z", "2026-10-29T23:00:00Z", "100% of components installed"),
  note("p1", "note", "2026-10-29T23:37:35.2Z", "2026-10-29T23:36:00Z", "Got measurements, material at 5pm"),
];

describe("each comment with the entry it was saved with", () => {
  const rows = buildTimeLog({ milestones: MS, log: LOG, notes: NOTES, tz, times });
  const said = (id: string) => rows.filter((r) => r.id === id).map((r) => [r.what, r.pct, r.comment]);
  it("by the time it's about, not the first entry typed near it", () => {
    expect(said("b")).toEqual([
      ["Started", "0%", ""],
      ["Progress", "0% → 50%", "Bundles installed"],
      ["Progress", "50% → 65%", "100% of components installed"],
    ]);
  });
  it("one entry that made a start and a %: the comment is the %'s, said now, not at the start", () => {
    expect(said("p1")).toEqual([["Started", "0%", ""], ["Progress", "0% → 25%", "Got measurements, material at 5pm"]]);
  });
  it("two steps of one name under one task are told apart, in plan order", () => {
    expect(rows.find((r) => r.id === "p1")?.step).toBe("Welded pipe replacements (1 of 2)");
    expect(stepLabels(MS).get("p2")).toBe("Welded pipe replacements (2 of 2)");
    expect(stepLabels(MS).get("b")).toBe("Install Bundle");
  });
});
