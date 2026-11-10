import { describe, it, expect } from "vitest";
import type { PlanAct, PlanChange } from "@/lib/nextPlan";
import { schedule, applyChanges, advance, dayNumber } from "@/lib/nextPlan";
import { parseStaffingGrid, isDirectCraft, planSummary } from "@/lib/staffingPlan";

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00" };
const t = (d: number, h: number) => Date.UTC(2026, 9, d, h + 7);
const act = (x: Partial<PlanAct> & { id: string }): PlanAct => ({ name: x.id, order: "wo", crew: "Schultz", hours: 4, planHours: 4, cal: "both", preds: [], floor: null, kind: "same", basis: "", waitedForCrew: null, ...x });
const run = (acts: PlanAct[], changes: PlanChange[] = [], pace = { Schultz: { mh: 4, from: "plan" } }) => {
  const a = applyChanges(acts, changes, tz, times, t(26, 6));
  return schedule({ acts: a.acts, pre: a.pre, tz, times, pace, toolHours: { day: 10, night: 11 }, headsSet: a.headsSet, day1: t(26, 6) });
};
const c = (x: Record<string, unknown>): PlanChange => ({ id: String(x.kind) + Math.random(), said: "", at: 0, ...x } as PlanChange);

describe("calendars", () => {
  it("a day crew's 16 hours run into the next morning", () => {
    expect(advance(t(26, 10), 16, "day", tz, times)).toBe(t(27, 14));
    expect(advance(t(26, 10), 16, "both", tz, times)).toBe(t(27, 2));
  });
});

describe("the suggested schedule", () => {
  const base = [act({ id: "a", floor: t(26, 6), hours: 12 }), act({ id: "b", preds: ["a"], hours: 6, cal: "day" }), act({ id: "c", preds: ["b"], hours: 2 })];
  it("follows links, calendars and earliest starts; says what sets the finish", () => {
    const p = run(base);
    const b = p.acts.find((x) => x.id === "b")!;
    expect(b.start).toBe(t(27, 6)); // a done 6 PM; a day crew starts next morning
    expect(p.finish).toBe(t(27, 14));
    expect(p.driving).toEqual(["c", "b", "a"]);
    expect(dayNumber(p, p.finish, tz)).toBe(2);
  });
  it("nights too pulls in a day-crew activity", () => {
    const p = run(base, [c({ kind: "nights", target: { ids: ["b"] }, on: true })]);
    expect(p.finish).toBe(t(27, 2));
    expect(p.acts.find((x) => x.id === "b")!.changedBy?.length).toBe(1);
  });
  it("hours, hold, as soon as possible, drop", () => {
    expect(run(base, [c({ kind: "hours", actId: "c", hours: 5 })]).finish).toBe(t(27, 17));
    expect(run(base, [c({ kind: "hold", target: { ids: ["a"] }, day: 2 })]).acts.find((x) => x.id === "a")!.start).toBe(t(27, 6));
    const late = [act({ id: "x", floor: t(27, 6) })];
    expect(run(late, [c({ kind: "asap", target: { ids: ["x"] } })]).acts[0].start).toBe(t(26, 6));
    const dropped = run(base, [c({ kind: "drop", target: { ids: ["b"] } })]);
    expect(dropped.acts.find((x) => x.id === "c")!.preds).toEqual(["a"]);
  });
  it("a wait made a step splits the activity around it; a before-the-shutdown item has no bar", () => {
    const p = run(base, [c({ kind: "split", actId: "a", fraction: 0.25, name: "Ancon: clear the line", crew: "Ancon", hours: 12 }), c({ kind: "add", name: "Order 24 seal rings", crew: "", hours: 0, pre: true })]);
    expect(p.acts.map((x) => x.name)).toEqual(expect.arrayContaining(["a (1 of 2)", "Ancon: clear the line", "a (2 of 2)"]));
    expect(p.acts.find((x) => x.name === "a (2 of 2)")!.hours).toBe(9);
    expect(p.pre.map((x) => x.name)).toEqual(["Order 24 seal rings"]);
    expect(p.finish).toBe(t(27, 14)); // 3 h, the 12 h wait, 9 h, then b next morning, then c
  });
  it("hands set: the crew carries only so much at once; the rest waits, most urgent first", () => {
    const two = [act({ id: "p", floor: t(26, 6), hours: 10, cal: "day" }), act({ id: "q", floor: t(26, 6), hours: 10, cal: "day" })];
    const free = run(two);
    expect(free.heads.Schultz[0]).toBe(8); // 20 h x 4 / 10
    const short = run(two, [c({ kind: "heads", crew: "Schultz", shift: 0, n: 4 }), c({ kind: "first", target: { ids: ["q"] } })]);
    expect(short.acts.find((x) => x.id === "q")!.start).toBe(t(26, 6));
    const p = short.acts.find((x) => x.id === "p")!;
    expect(p.heldForCrew).toBe(true);
    expect(p.start).toBe(t(27, 6));
    expect(short.headsSet.Schultz[0]).toBe(4);
  });
});

describe("staffing plans", () => {
  const grid = [
    ["Kern Energy", "Project :", "2026 Season"],
    ["Phases:", null, "Pre TAR", null, "Transmix-1"],
    ["Craft Name", null, "2026-10-25", null, "2026-10-26", null],
    [null, null, "Day", "Night", "Day", "Night"],
    ["BoilerMaker Journeyman", "BM", 0, 0, 11, 4],
    ["Pipefitter Journeyman", "PF", null, null, 3, null],
    ["BoilerMaker Foreman", "FM", 1, null, 1, 1],
    ["Safety Manager", "SPV", null, null, 1, null],
    ["Total", null, 1, 0, 16, 5],
  ];
  it("reads hands on the tools and supervision by date and shift, and the phases over the dates", () => {
    const p = parseStaffingGrid(grid)!;
    expect(p.shifts["2026-10-26:day"]).toEqual({ direct: 14, indirect: 2 });
    expect(p.shifts["2026-10-26:night"]).toEqual({ direct: 4, indirect: 1 });
    expect(p.shifts["2026-10-25:day"]).toEqual({ direct: 0, indirect: 1 });
    expect(p.phases).toEqual([{ name: "Pre TAR", from: "2026-10-25" }, { name: "Transmix-1", from: "2026-10-26" }]);
    expect(planSummary({ file: "", at: "", by: null, shifts: p.shifts }, "2026-10-26", "2026-10-31")).toEqual({ day: { direct: 14, indirect: 2 }, night: { direct: 4, indirect: 1 } });
  });
  it("not a staffing plan: null", () => {
    expect(parseStaffingGrid([["a", "b"], [1, 2]])).toBeNull();
  });
  it("crafts: on the tools or not", () => {
    expect(isDirectCraft("Pipefitter Journeyman", "PF")).toBe(true);
    expect(isDirectCraft("Firewatch/Holewatch", "HW")).toBe(false);
    expect(isDirectCraft("Field Coordinator", "")).toBe(false);
  });
});
