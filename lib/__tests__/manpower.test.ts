// Manpower: each company's direct and indirect hands per shift, counted at
// the meeting; man-hours, against the bid; estimated by work order.

import { describe, it, expect } from "vitest";
import { defaultCompany, companyOf, countOf, withCounts, shiftCounts, manpowerSummary, estimateByWorkOrder, handsAt, cleanManpower, type ManpowerSettings } from "@/lib/manpower";
import type { ShiftRecord } from "@/lib/shiftRecord";
import type { ShiftWindow } from "@/lib/shiftReport";

const H = 3_600_000;
const T0 = Date.parse("2026-10-26T06:00:00-07:00");
const win = (i: number): ShiftWindow => ({ kind: i % 2 === 0 ? "day" : "night", dayKey: `2026-10-${26 + Math.floor(i / 2)}`, start: T0 + i * 12 * H, end: T0 + (i + 1) * 12 * H });
const windows = [0, 1, 2, 3].map(win);

describe("crews into companies", () => {
  it("a crew's company from its name; in-house (KE) crews are Kern Energy; set by hand wins", () => {
    expect(["Schultz - Tower", "Schultz 1", "Schultz", "Schultz 3"].map(defaultCompany)).toEqual(["Schultz", "Schultz", "Schultz", "Schultz"]);
    expect(defaultCompany("Maintenance (KE)")).toBe("Kern Energy");
    expect(defaultCompany("Eaton (VFD Project)")).toBe("Eaton (VFD Project)");
    expect(defaultCompany("Brand Scaffold")).toBe("Brand Scaffold");
    expect(companyOf("Brand Scaffold", { companyOf: { "Brand Scaffold": "Brand" } })).toBe("Brand");
  });
});

describe("a count at the meeting", () => {
  it("direct and indirect add up to the head count; an older count is a total, not split", () => {
    expect(withCounts({ names: ["Mike"] }, 30, 6)).toEqual({ names: ["Mike"], direct: 30, indirect: 6, headcount: 36 });
    expect(countOf({ direct: 30, indirect: 6, headcount: 36 })).toEqual({ direct: 30, indirect: 6, total: 36, split: true });
    expect(countOf({ headcount: 10 })).toEqual({ direct: null, indirect: null, total: 10, split: false });
    expect(countOf({ headcount: 4, plant: true }).total).toBeNull();
    expect(withCounts({ headcount: 9 }, null, null).headcount).toBeNull();
  });
});

const settings: ManpowerSettings = { bids: { Schultz: { day: { direct: 36, indirect: 6 }, night: { direct: 12, indirect: 2 }, rate: 85 } } };
const records = new Map<string, ShiftRecord>([
  // Day 1: Schultz in two crews; Ancon a total only; Operations plant staff.
  ["2026-10-26:day", { crews: { "Schultz - Tower": { direct: 20, indirect: 4, headcount: 24 }, "Schultz 1": { direct: 10, indirect: 2, headcount: 12 }, Ancon: { headcount: 6 }, "Operations (KE)": { plant: true, names: ["Jesse"] } },
    incidents: { items: [{ id: "i1", at: T0 + 2 * H, kind: "First aid", text: "cut" }] } } as ShiftRecord],
  ["2026-10-26:night", { crews: { "Schultz - Tower": { direct: 12, indirect: 2, headcount: 14 } } } as ShiftRecord],
  // Day 2: nothing entered - day 1's roster carries.
  // Night 2: counted.
  ["2026-10-27:night", { crews: { "Schultz - Tower": { direct: 8, indirect: 2, headcount: 10 } }, incidents: { items: [{ id: "i2", at: T0 + 40 * H, kind: "Recordable", text: "x" }] } } as ShiftRecord],
]);

describe("shift by shift", () => {
  const counts = shiftCounts(records, windows, settings);
  it("each company's count; plant staff left out; a shift with nothing entered carries the last same shift's, said so", () => {
    expect(counts.map((c) => [c.key, c.carried, c.companies.map((x) => `${x.company}:${x.direct ?? "-"}/${x.indirect ?? "-"}/${x.total}`)])).toEqual([
      ["2026-10-26:day", false, ["Schultz:30/6/36", "Ancon:-/-/6"]],
      ["2026-10-26:night", false, ["Schultz:12/2/14"]],
      ["2026-10-27:day", true, ["Schultz:30/6/36", "Ancon:-/-/6"]],
      ["2026-10-27:night", false, ["Schultz:8/2/10"]],
    ]);
  });
  it("man-hours, peak, against the bid, cost and exposure", () => {
    const s = manpowerSummary(counts, records, settings);
    const sc = s.companies.find((x) => x.company === "Schultz")!;
    // (36 + 14 + 36 + 10) x 12 h
    expect(sc.totalMH).toBe(1152);
    expect([sc.directMH, sc.indirectMH, sc.peak, sc.shifts, sc.carried]).toEqual([960, 192, 36, 4, 1]);
    expect(sc.indirectShare).toBe(0.17);
    // Bid: 42 + 14 + 42 + 14 = 112 x 12. Short of the bid direct: day 1 (30 of 36)
    // and night 2 (8 of 12); day 2's count was carried, not checked, so not called short.
    expect(sc.bidMH).toBe(1344);
    expect(sc.onBidMH).toBe(1152);
    expect(sc.shortShifts).toBe(2);
    expect(sc.cost).toBe(1152 * 85);
    const an = s.companies.find((x) => x.company === "Ancon")!;
    expect([an.unsplitMH, an.directMH, an.indirectShare, an.cost]).toEqual([144, 0, null, null]);
    expect([s.counted, s.carried, s.totalMH, s.peak]).toEqual([4, 1, 1296, { n: 42, key: "2026-10-26:day" }]);
    expect(s.incidents).toEqual({ recordable: 1, firstAid: 1, nearMiss: 0 });
    expect(s.recordableRate).toBe(Math.round((200_000 / 1296) * 100) / 100);
  });
  it("estimated man-hours by work order: a company's direct hours shared over its work going, by hours going", () => {
    const spans = [
      { wo: "E-12", label: "E-12", crew: "Schultz - Tower", start: T0, end: T0 + 9 * H },
      { wo: "V-7", label: "V-7", crew: "Schultz 1", start: T0 + 6 * H, end: T0 + 9 * H },
      { wo: "HB", label: "Hydroblast", crew: "Ancon", start: T0, end: T0 + 12 * H },
    ];
    const e = estimateByWorkOrder(counts.slice(0, 2), spans, settings);
    // Day 1: Schultz 30 direct x 12 = 360 over E-12 9 h and V-7 3 h; night 1: nothing of Schultz going.
    expect(e.orders.map((o) => [o.wo, o.directMH])).toEqual([["E-12", 270], ["V-7", 90]]);
    expect(e.untiedMH).toBe(144);
  });
  it("a company's hands at a time, against its bid", () => {
    expect(handsAt(counts, "Schultz", T0 + 40 * H, settings)).toEqual({ direct: 8, total: 10, bidDirect: 12, bidTotal: 14, carried: false });
    expect(handsAt(counts, "Schultz", T0 + 30 * H, settings)?.carried).toBe(true);
    expect(handsAt(counts, "Nobody", T0 + 1 * H, settings)).toBeNull();
    // A company with no bid for that shift: nothing to hold it to.
    expect(handsAt(counts, "Ancon", T0 + 1 * H, settings)).toEqual({ direct: null, total: 6, bidDirect: null, bidTotal: null, carried: false });
  });
});

describe("settings", () => {
  it("kept clean: numbers in range, empty bids dropped", () => {
    expect(cleanManpower({ companyOf: { a: " Schultz ", b: 3 }, bids: { X: { day: { direct: 10.123 }, rate: -5 }, Y: {} } }))
      .toEqual({ companyOf: { a: "Schultz" }, bids: { X: { day: { direct: 10.12, indirect: null }, night: undefined, rate: null } } });
  });
});
