import { describe, it, expect } from "vitest";
import { placeableTasks, splitPlacements, compareDayPlacements, compareBandPlacements, activeWindowOnDay, type DayPlacement, type BandPlacement, type PlaceableTask } from "@/lib/calendarPlacement";

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
  it("containers (the project root, a phase of phases) are bands, never chips", () => {
    const { chips, bands } = splitPlacements(ALL, kids(ALL), false);
    expect(chips.map((m) => m.id)).not.toContain("root");
    expect(chips.map((m) => m.id)).not.toContain("unit2");
    expect(bands.map((m) => m.id)).toEqual(["root", "unit2"]);
  });

  it("keeps the schedule's integrity: every dated row is a chip or a band, never both", () => {
    const k = kids(ALL);
    for (const mode of [false, true]) {
      const { chips, bands } = splitPlacements(ALL, k, mode);
      const chipIds = new Set(chips.map((m) => m.id));
      const bandIds = new Set(bands.map((m) => m.id));
      for (const m of ALL) {
        const represented = chipIds.has(m.id) || bandIds.has(m.id)
          // Tasks mode: a step under a bottom group rides its group's chip.
          || (!mode && !!m.parentId && chipIds.has(m.parentId) && (k.get(m.id) ?? []).length === 0);
        expect(represented, `${m.id} missing in ${mode ? "Sub-tasks" : "Tasks"} mode`).toBe(true);
        expect(chipIds.has(m.id) && bandIds.has(m.id)).toBe(false);
      }
    }
    // Sub-tasks mode: bottom groups become bands too, so their steps show as chips.
    expect(splitPlacements(ALL, kids(ALL), true).bands.map((m) => m.id)).toEqual(["root", "shutdown", "unit2", "u2a"]);
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

describe("compareBandPlacements", () => {
  const b = (ms: T, depth: number): BandPlacement => ({ ms, dayIndex: 0, spanDays: 1, depth, hasWorkToday: true });
  it("orders bands root-first, then by start", () => {
    const list = [b(U2A, 2), b(UNIT2, 1), b(ROOT, 0), b(SHUTDOWN, 1)];
    expect(list.sort(compareBandPlacements).map((x) => x.ms.id)).toEqual(["root", "shutdown", "unit2", "u2a"]);
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

describe("activeWindowOnDay + day ordering by today's work", () => {
  const D = Date.parse("2026-10-27T00:00:00Z"), DE = Date.parse("2026-10-28T00:00:00Z");
  it("a group chip's window on a day is the envelope of its steps that day", () => {
    const grp = t("e12", null, "2026-10-26T06:00:00Z", "2026-10-29T10:00:00Z");
    const steps = [
      t("s1", "e12", "2026-10-26T06:00:00Z", "2026-10-26T18:00:00Z"), // yesterday
      t("s2", "e12", "2026-10-27T14:00:00Z", "2026-10-27T18:00:00Z"), // today
      t("s3", "e12", "2026-10-27T16:00:00Z", "2026-10-28T09:00:00Z"), // runs into tomorrow
    ];
    const w = activeWindowOnDay(grp, steps, D, DE);
    expect(new Date(w.start).toISOString()).toBe("2026-10-27T14:00:00.000Z");
    expect(new Date(w.end).toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(w.idle).toBe(false);
  });
  it("a gap day inside a group's span is idle", () => {
    const grp = t("g", null, "2026-10-26T06:00:00Z", "2026-10-29T10:00:00Z");
    const steps = [t("a", "g", "2026-10-26T06:00:00Z", "2026-10-26T18:00:00Z"), t("b", "g", "2026-10-29T06:00:00Z", "2026-10-29T10:00:00Z")];
    expect(activeWindowOnDay(grp, steps, D, DE).idle).toBe(true);
  });
  it("a leaf carrying over is active from midnight", () => {
    const leaf = t("l", null, "2026-10-26T20:00:00Z", "2026-10-27T08:00:00Z");
    const w = activeWindowOnDay(leaf, [], D, DE);
    expect(w.start).toBe(D);
    expect(new Date(w.end).toISOString()).toBe("2026-10-27T08:00:00.000Z");
  });
  it("orders a tile by today's window, not by when the parent began", () => {
    const p = (id: string, start: string, todayStart: string, todayEnd: string, idle = false): DayPlacement =>
      ({ ms: t(id, null, start, "2026-10-29T00:00:00Z"), dayIndex: 1, spanDays: 4, todayStart: Date.parse(todayStart), todayEnd: Date.parse(todayEnd), idleToday: idle });
    const early = p("early-parent-late-today", "2026-10-25T06:00:00Z", "2026-10-27T14:00:00Z", "2026-10-27T18:00:00Z");
    const late = p("late-parent-early-today", "2026-10-26T06:00:00Z", "2026-10-27T06:00:00Z", "2026-10-27T10:00:00Z");
    const carry = p("busy-since-midnight", "2026-10-26T06:00:00Z", "2026-10-27T00:00:00Z", "2026-10-27T08:00:00Z");
    const gap = p("gap-day", "2026-10-24T06:00:00Z", "2026-10-27T00:00:00Z", "2026-10-28T00:00:00Z", true);
    expect([early, gap, late, carry].sort(compareDayPlacements).map((x) => x.ms.id))
      .toEqual(["busy-since-midnight", "late-parent-early-today", "early-parent-late-today", "gap-day"]);
  });
});
