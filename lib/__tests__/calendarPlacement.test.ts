import { describe, it, expect } from "vitest";
import { placeableTasks, compareDayPlacements, type DayPlacement, type PlaceableTask } from "@/lib/calendarPlacement";

type T = PlaceableTask & { id: string; parentId: string | null };

const t = (id: string, parentId: string | null, start: string | null, finish: string, extra: Partial<T> = {}): T =>
  ({ id, parentId, name: id, plannedStartAt: start, plannedAt: finish, ...extra });

function kids(list: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of list) if (x.parentId) m.set(x.parentId, [...(m.get(x.parentId) ?? []), x]);
  return m;
}

// Turnaround-shaped tree: the root spans the whole job and holds one
// direct step plus two groups; "shutdown" is a bottom group (all leaves),
// "unit2" is a container (holds a sub-group).
const ROOT = t("root", null, "2026-10-01T06:00:00Z", "2026-10-30T18:00:00Z");
const DIRECT = t("direct", "root", "2026-10-02T07:00:00Z", "2026-10-02T09:00:00Z");
const SHUTDOWN = t("shutdown", "root", "2026-10-02T06:00:00Z", "2026-10-02T12:00:00Z");
const S1 = t("s1", "shutdown", "2026-10-02T06:00:00Z", "2026-10-02T08:00:00Z");
const S2 = t("s2", "shutdown", "2026-10-02T08:00:00Z", "2026-10-02T12:00:00Z");
const UNIT2 = t("unit2", "root", "2026-10-02T06:00:00Z", "2026-10-05T18:00:00Z");
const U2A = t("u2a", "unit2", "2026-10-02T06:00:00Z", "2026-10-03T18:00:00Z");
const L1 = t("l1", "u2a", "2026-10-02T14:00:00Z", "2026-10-02T16:00:00Z");
const L2 = t("l2", "u2a", "2026-10-03T06:00:00Z", "2026-10-03T10:00:00Z");
const ALL = [ROOT, DIRECT, SHUTDOWN, S1, S2, UNIT2, U2A, L1, L2];

describe("placeableTasks", () => {
  it("never places containers (the project root, a phase of phases)", () => {
    const ids = placeableTasks(ALL, kids(ALL), false).map((m) => m.id);
    expect(ids).not.toContain("root");
    expect(ids).not.toContain("unit2");
  });

  it("Tasks mode: bottom groups stand in for their steps; stray leaves stand alone", () => {
    const ids = placeableTasks(ALL, kids(ALL), false).map((m) => m.id);
    // u2a's children are all leaves, so it is a bottom group too.
    expect(ids).toEqual(["direct", "shutdown", "u2a"]);
  });

  it("Sub-tasks mode: every leaf exactly once, no groups", () => {
    const ids = placeableTasks(ALL, kids(ALL), true).map((m) => m.id);
    expect(ids).toEqual(["direct", "s1", "s2", "l1", "l2"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("skips rows with no planned date", () => {
    const bare = { ...DIRECT, id: "bare", parentId: null, plannedAt: null } as T;
    const ids = placeableTasks([bare, DIRECT], kids([bare]), false).map((m) => m.id);
    expect(ids).toEqual(["direct"]);
  });
});

describe("compareDayPlacements", () => {
  const p = (ms: T, dayIndex = 0, spanDays = 1): DayPlacement => ({ ms, dayIndex, spanDays });

  it("orders a day by start time of day", () => {
    const a = p(t("a", null, "2026-10-02T14:00:00Z", "2026-10-02T16:00:00Z"));
    const b = p(t("b", null, "2026-10-02T06:00:00Z", "2026-10-02T08:00:00Z"));
    const c = p(t("c", null, "2026-10-02T09:30:00Z", "2026-10-02T11:00:00Z"));
    expect([a, b, c].sort(compareDayPlacements).map((x) => x.ms.id)).toEqual(["b", "c", "a"]);
  });

  it("puts carry-overs from earlier days first, then today's starts", () => {
    const carry = p(t("carry", null, "2026-10-01T15:00:00Z", "2026-10-02T10:00:00Z"), 1, 2);
    const early = p(t("early", null, "2026-10-02T05:00:00Z", "2026-10-02T06:00:00Z"));
    expect([early, carry].sort(compareDayPlacements).map((x) => x.ms.id)).toEqual(["carry", "early"]);
  });

  it("falls back to the finish time when there is no start", () => {
    const noStart = p(t("ends-noon", null, null, "2026-10-02T12:00:00Z"));
    const eight = p(t("eight", null, "2026-10-02T08:00:00Z", "2026-10-02T09:00:00Z"));
    const sixteen = p(t("sixteen", null, "2026-10-02T16:00:00Z", "2026-10-02T17:00:00Z"));
    expect([sixteen, noStart, eight].sort(compareDayPlacements).map((x) => x.ms.id)).toEqual(["eight", "ends-noon", "sixteen"]);
  });

  it("breaks start ties by finish, then WBS, then name", () => {
    const x = p(t("x", null, "2026-10-02T08:00:00Z", "2026-10-02T12:00:00Z", { wbs: "1.2" }));
    const y = p(t("y", null, "2026-10-02T08:00:00Z", "2026-10-02T09:00:00Z", { wbs: "1.10" }));
    const z = p(t("z", null, "2026-10-02T08:00:00Z", "2026-10-02T12:00:00Z", { wbs: "1.10" }));
    expect([x, z, y].sort(compareDayPlacements).map((q) => q.ms.id)).toEqual(["y", "x", "z"]);
  });

  it("sends unparseable dates to the end instead of scrambling the sort", () => {
    const bad = p(t("bad", null, "not a date", "also bad"));
    const ok = p(t("ok", null, "2026-10-02T08:00:00Z", "2026-10-02T09:00:00Z"));
    const ok2 = p(t("ok2", null, "2026-10-02T07:00:00Z", "2026-10-02T09:00:00Z"));
    expect([bad, ok, ok2].sort(compareDayPlacements).map((x) => x.ms.id)).toEqual(["ok2", "ok", "bad"]);
  });
});
