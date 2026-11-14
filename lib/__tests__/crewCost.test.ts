import { describe, it, expect } from "vitest";
import { bandTarget, fillRange, parseStaffingGrid, planFromGrid, setShiftHeads, type StaffingPlan } from "@/lib/staffingPlan";
import { headCost, holdCost, matchCraft, parseRateGrid, rateOf, type RateSheet } from "@/lib/rateSheet";
import { crewShifts, crewSummary } from "@/lib/crewCost";
import { contractorList, cleanCrewSettings, partyFor } from "@/lib/crewSettings";
import type { ShiftCount } from "@/lib/manpower";
import type { CostParty } from "@/lib/costs";

// Shaped like the 2026 TA season sheet: a Phases row naming each run of
// dates, the dates, Day/Night under each, crafts with their codes.
const d = (s: string) => new Date(`${s}T00:00:00`);
function seasonGrid(): unknown[][] {
  const days = ["2026-10-21", "2026-10-26", "2026-10-27", "2026-11-02", "2026-11-09"];
  const phases: unknown[] = ["Phases:", null], dates: unknown[] = ["Craft Name", null], dn: unknown[] = [null, null];
  const band: Record<string, string> = { "2026-10-21": "Pre TAR", "2026-10-26": "Transmix-1", "2026-11-02": "LRU", "2026-11-09": "Transmix-2" };
  for (const day of days) { phases.push(band[day] ?? null, null); dates.push(d(day), null); dn.push("Day", "Night"); }
  const row = (name: string, code: string, cells: number[]) => [name, code, ...cells];
  return [
    [null, "Kern Energy"], phases, dates, dn,
    //                                     10/21    10/26    10/27    11/02    11/09
    row("BoilerMaker Journeyman", "BM", [0, 0, 11, 4, 11, 4, 11, 12, 11, 4]),
    row("Pipefitter Journeyman", "PF", [0, 0, 3, 0, 3, 0, 3, 0, 3, 0]),
    row("BoilerMaker Foreman", "FM", [2, 0, 1, 1, 1, 1, 1, 2, 1, 1]),
    row("Project Manager", "SPV", [1, 0, 1, 0, 1, 0, 1, 0, 1, 0]),
    row("Project Manager", "SPV", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    [null, "Total"],
  ];
}

describe("a staffing plan read by craft, split by the events it names", () => {
  const g = parseStaffingGrid(seasonGrid())!;
  it("keeps each shift's heads by craft and names each run of dates", () => {
    expect(g.byCraft["2026-10-26:day"]).toEqual({ "BoilerMaker Journeyman": 11, "Pipefitter Journeyman": 3, "BoilerMaker Foreman": 1, "Project Manager": 1 });
    expect(g.shifts["2026-10-26:day"]).toEqual({ direct: 14, indirect: 2 });
    expect(g.bands.map((b) => [b.name, b.from, b.to])).toEqual([["Pre TAR", "2026-10-21", "2026-10-21"], ["Transmix-1", "2026-10-26", "2026-10-27"], ["LRU", "2026-11-02", "2026-11-02"], ["Transmix-2", "2026-11-09", "2026-11-09"]]);
    // A date cell is read as its own day wherever the browser is.
    expect(g.from).toBe("2026-10-21");
  });
  it("puts each run on the phase its dates fall in; another event's dates are not this project's", () => {
    const phases = [{ id: "ph1", start: "2026-10-24", end: "2026-10-31" }, { id: "ph2", start: "2026-11-07", end: "2026-11-15" }];
    expect(g.bands.map((b) => bandTarget(b, phases))).toEqual([null, "ph1", null, "ph2"]);
  });
  it("keeps only the runs picked, and a craft can be moved to supervision", () => {
    const plan = planFromGrid(g, (b) => b.name === "Transmix-1", { file: "season.xlsx", at: "now", by: "eng" }, { "Pipefitter Journeyman": false });
    expect(Object.keys(plan.shifts).sort()).toEqual(["2026-10-26:day", "2026-10-26:night", "2026-10-27:day", "2026-10-27:night"]);
    expect(plan.shifts["2026-10-26:day"]).toEqual({ direct: 11, indirect: 5 });
    expect(plan.crafts?.map((c) => c.name)).toEqual(["BoilerMaker Journeyman", "Pipefitter Journeyman", "BoilerMaker Foreman", "Project Manager"]);
  });
  it("a plan typed in: one craft over a run of days in one go, then one shift changed", () => {
    const empty: StaffingPlan = { file: "", at: "now", by: null, shifts: {} };
    let p = fillRange(empty, { name: "BoilerMaker Journeyman", code: "BM", direct: true }, "2026-10-26", "2026-10-28", 11, 4);
    expect(Object.keys(p.shifts)).toHaveLength(6);
    expect(p.shifts["2026-10-27:night"]).toEqual({ direct: 4, indirect: 0 });
    p = setShiftHeads(p, "BoilerMaker Journeyman", "2026-10-28:night", 0);
    expect(p.shifts["2026-10-28:night"]).toBeUndefined();
  });
});

const sheet: RateSheet = { crafts: { "BoilerMaker Journeyman": { st: 100 }, "Pipefitter Journeyman": { st: 96, ot: 150 }, "BoilerMaker Foreman": { st: 110 }, "Project Manager": { st: 125 } }, perDiem: 125 };

describe("a rate sheet prices a shift as the contract pays it", () => {
  it("overtime and double time are 1.5 and 2 times straight time until typed", () => {
    expect([rateOf(sheet, "BoilerMaker Journeyman", "ot"), rateOf(sheet, "BoilerMaker Journeyman", "dt"), rateOf(sheet, "Pipefitter Journeyman", "ot")]).toEqual([150, 200, 150]);
    expect(rateOf(sheet, "Welder", "st")).toBeNull();
  });
  it("a 12 h shift: 8 h straight time, 4 h overtime, and the per diem; past 12 h is double time", () => {
    expect(headCost(sheet, "BoilerMaker Journeyman", 12)).toBe(8 * 100 + 4 * 150 + 125);
    expect(headCost(sheet, "BoilerMaker Journeyman", 14)).toBe(8 * 100 + 4 * 150 + 2 * 200 + 125);
    expect(headCost({ ...sheet, stHours: 10, dtAfter: 12 }, "BoilerMaker Journeyman", 12)).toBe(10 * 100 + 2 * 150 + 125);
  });
  it("holding a crew over: the extra hours at double time, priced at the crafts on the tools", () => {
    const mix = { "BoilerMaker Journeyman": 11, "Pipefitter Journeyman": 3, "BoilerMaker Foreman": 1 };
    const crafts = [{ name: "BoilerMaker Journeyman", code: "BM", direct: true }, { name: "Pipefitter Journeyman", code: "PF", direct: true }, { name: "BoilerMaker Foreman", code: "FM", direct: false }];
    const avgDt = (11 * 200 + 3 * 192) / 14;
    expect(holdCost(sheet, mix, crafts, 12, 15, 2)).toBeCloseTo(15 * 2 * avgDt, 6);
  });
  it("reads a rate sheet spreadsheet and matches its crafts to the plan's", () => {
    const rows = [["Schultz rate sheet 2026"], ["Craft", "Straight Time", "Overtime", "Double Time", "Per Diem"], ["Boilermaker - Journeyman", "$98.00", 147, 196, 125], ["Boilermaker General Foreman", 114, 171, 228, 125], ["Notes"]];
    const r = parseRateGrid(rows)!;
    expect(r.map((x) => [x.craft, x.st, x.ot, x.dt])).toEqual([["Boilermaker - Journeyman", 98, 147, 196], ["Boilermaker General Foreman", 114, 171, 228]]);
    const plan = ["BoilerMaker Journeyman", "BoilerMaker Gen.Foreman", "Pipefitter Journeyman"];
    expect(r.map((x) => matchCraft(x.craft, plan))).toEqual(["BoilerMaker Journeyman", "BoilerMaker Gen.Foreman"]);
  });
});

describe("every day: plan against the head count, priced", () => {
  const g = parseStaffingGrid(seasonGrid())!;
  const plan = planFromGrid(g, (b) => b.name === "Transmix-1", { file: "season.xlsx", at: "now", by: null });
  const H = 3_600_000, t0 = Date.parse("2026-10-26T13:00:00Z");
  const shift = (key: string, i: number, total: number | null, carried = false): ShiftCount => ({
    key, kind: key.endsWith("night") ? "night" : "day", start: t0 + i * 12 * H, end: t0 + (i + 1) * 12 * H, hours: 12, carried, counted: total != null,
    companies: total == null ? [] : [{ company: "Schultz", direct: null, indirect: null, total, split: false, crews: ["Schultz"] }],
  });
  const counts = [shift("2026-10-26:day", 0, 16), shift("2026-10-26:night", 1, 4), shift("2026-10-27:day", 2, 18), shift("2026-10-27:night", 3, null)];
  const holds = new Map([["2026-10-27:day", [{ id: "h", crew: "Schultz", hands: 10, until: t0 + 3 * 12 * H + 2 * H, at: 0 }]]]);
  const rows = crewShifts({ company: "Schultz", plan, sheet, counts, holds, companyOf: (c) => c.split(" ")[0], now: t0 + 3 * 12 * H + 6 * H });
  it("each shift: the plan's heads, the count, what the counted heads cost at the plan's mix", () => {
    expect(rows.map((r) => [r.key, r.plan?.heads, r.counted])).toEqual([["2026-10-26:day", 16, 16], ["2026-10-26:night", 5, 4], ["2026-10-27:day", 16, 18], ["2026-10-27:night", 5, null]]);
    const day = 11 * headCost(sheet, "BoilerMaker Journeyman", 12)! + 3 * headCost(sheet, "Pipefitter Journeyman", 12)! + headCost(sheet, "BoilerMaker Foreman", 12)! + headCost(sheet, "Project Manager", 12)!;
    expect(rows[0].planCost).toBeCloseTo(day, 6);
    expect(rows[0].paid).toBeCloseTo(day, 6);
    expect(rows[1].paid).toBeCloseTo(rows[1].planCost! * 4 / 5, 6);
    // Held over 2 h: double time on top of the counted heads.
    expect(rows[2].hold).toMatchObject({ hands: 10, hours: 2, open: false });
    expect(rows[2].paid).toBeCloseTo(day * 18 / 16 + rows[2].hold!.cost!, 6);
  });
  it("the summary: short shifts, a started shift not counted, overtime, and the forecast", () => {
    const s = crewSummary(rows, { plan, sheet });
    expect([s.counted, s.short, s.over, s.uncounted]).toEqual([3, 1, 1, 1]);
    expect(s.overtime).toBe(Math.round(rows[2].hold!.cost!));
    expect(s.forecast).toBe(Math.round(rows[0].paid! + rows[1].paid! + rows[2].paid! + rows[3].planCost!));
    expect(s.unpriced).toEqual([]);
  });
  it("with no rate sheet it still counts heads, and prices nothing", () => {
    const r = crewShifts({ company: "Schultz", plan, sheet: null, counts, holds, companyOf: (c) => c, now: t0 + 40 * H });
    expect(r[0].counted).toBe(16);
    expect(crewSummary(r, { plan, sheet: null }).forecast).toBeNull();
  });
});

describe("the contractor list: one name for a contractor everywhere", () => {
  const party = (name: string, id = name): CostParty => ({ id, projectId: "p", name, kind: "contractor", trade: null, defaultRate: null, contractValue: null, contactName: null, contactEmail: null, status: "active" });
  const s = cleanCrewSettings({ manpower: {}, rateSheets: { Ancon: { crafts: { Laborer: { st: 60 } } } } });
  it("crews on the schedule by company, plant staff left out, and the Costs tab's companies matched by name", () => {
    const list = contractorList(["Schultz", "Schultz - Tower", "Maintenance (KE)", "Ancon", "Advanced Combustion", "Bragg (Pump Project)"], [party("Caltrol, Adv. Combustion", "c1"), party("Scaffold Co", "s1")], s);
    expect(list.map((c) => [c.company, c.crews.length, c.party?.id ?? null])).toEqual([
      ["Schultz", 2, null], ["Advanced Combustion", 1, "c1"], ["Ancon", 1, null], ["Bragg (Pump Project)", 1, null], ["Scaffold Co", 0, "s1"],
    ]);
  });
  it("a picked company wins over a guess", () => {
    expect(partyFor("Schultz", [party("Schultz Industrial", "a"), party("Other", "b")], { partyId: "b" })?.id).toBe("b");
    expect(partyFor("Schultz", [party("Schultz Industrial", "a")])?.id).toBe("a");
  });
});
