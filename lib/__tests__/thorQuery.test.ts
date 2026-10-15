import { describe, it, expect } from "vitest";
import { parseThorQuery, withoutChip, unitWords, unitName } from "@/lib/thor/query";
import { buildArgs, EMPTY_FILTERS } from "@/lib/thor/client";

const UNITS = [
  { code: "2000", folder: "2000 - CRUDE UNIT" },
  { code: "3500", folder: "3500 - PLATFORMER" },
  { code: "6000", folder: "6000 - WATER" },
  { code: "6600", folder: "6600 - WASTE WATER" },
  { code: "4800", folder: "4800 - SRU No 2" },
  { code: "4600", folder: "4600 - S.W. STRIPPER" },
];
const NOW = new Date("2026-10-15T12:00:00Z");

describe("parseThorQuery", () => {
  it("the newest prefrac drawings — kinds rank as words", () => {
    const q = parseThorQuery("The newest prefrac drawings", UNITS, NOW);
    expect(q.sort).toBe("newest");
    expect(q.terms).toEqual(["prefrac", "drawing"]);
    expect(q.kinds).toEqual([]);
    expect(q.tags).toEqual([]);
  });

  it("only <kind> requires it", () => {
    expect(parseThorQuery("only drawings of the prefrac", UNITS, NOW)).toMatchObject({ kinds: ["drawings"], terms: ["prefrac"] });
    expect(parseThorQuery("just the inspections for v-3", UNITS, NOW)).toMatchObject({ kinds: ["inspections"], tags: ["v3"] });
    expect(parseThorQuery("P&IDs for the platformer", UNITS, NOW).kinds).toEqual(["pid"]);
  });

  it("all the files on v-3 in the crude unit, latest to newest", () => {
    const q = parseThorQuery("i want ordered from latest to newest all the files on v-3 in the crude unit", UNITS, NOW);
    expect(q.tags).toEqual(["v3"]);
    expect(q.units).toEqual(["2000"]);
    expect(q.sort).toBe("newest");
    expect(q.terms).toEqual([]);
  });

  it("oldest to newest sorts oldest first", () => {
    expect(parseThorQuery("V-3 crude oldest to newest", UNITS, NOW).sort).toBe("oldest");
    expect(parseThorQuery("V-3 crude oldest first", UNITS, NOW).sort).toBe("oldest");
  });

  it("dates and sizes become filters, bare years stay words", () => {
    const q = parseThorQuery("inspection pdfs after 2020 before 2024-06 over 5 MB", UNITS, NOW);
    expect(q.terms).toEqual(["inspection"]);
    expect(q.types).toEqual(["pdf"]);
    expect(q.after).toBe("2021-01-01");
    expect(q.before).toBe("2024-06-01");
    expect(q.minSize).toBe(5 * 1024 * 1024);
    expect(parseThorQuery("2018 turnaround", UNITS, NOW).terms).toEqual(["2018", "turnaround"]);
    expect(parseThorQuery("between 2015 and 2018", UNITS, NOW)).toMatchObject({ after: "2015-01-01", before: "2019-01-01" });
    expect(parseThorQuery("last year", UNITS, NOW)).toMatchObject({ after: "2025-01-01", before: "2026-01-01" });
  });

  it("prefers the unit naming more words (waste water over water)", () => {
    expect(parseThorQuery("waste water pumps", UNITS, NOW).units).toEqual(["6600"]);
    expect(parseThorQuery("water pumps", UNITS, NOW).units).toEqual(["6000"]);
    expect(parseThorQuery("unit 3500 reactor", UNITS, NOW).units).toEqual(["3500"]);
  });

  it("keeps equipment numbers and drawing numbers as words", () => {
    const q = parseThorQuery("2010.03 2002-D-2001", UNITS, NOW);
    expect(q.terms).toEqual(["2010.03", "2002", "d", "2001"]);
    expect(q.tags).toEqual([]);
  });

  it("does not read revisions or sheets as tags", () => {
    expect(parseThorQuery("rev3 sht04", UNITS, NOW).tags).toEqual([]);
  });

  it("what comes after 'looking for' is what is wanted", () => {
    const q = parseThorQuery("prefrac drawings to the crude tower im looking for tray drawings", UNITS, NOW);
    expect(q.units).toEqual(["2000"]);
    expect(q.terms).toEqual(["prefrac", "drawing", "tower", "tray"]);
    expect(q.primary.sort()).toEqual(["drawing", "tray"]);
  });

  it("keeps the words that describe the document", () => {
    expect(parseThorQuery("prefrac tower inspection report", UNITS, NOW).terms).toEqual(["prefrac", "tower", "inspection", "report"]);
  });

  it("strips plurals so prefix matching covers both", () => {
    expect(parseThorQuery("vessels nozzles", UNITS, NOW).terms).toEqual(["vessel", "nozzle"]);
  });

  it("removing a chip removes exactly that", () => {
    const q = parseThorQuery("newest v-3 crude drawings", UNITS, NOW);
    const r = withoutChip(q, "unit:2000");
    expect(r.units).toEqual([]);
    expect(r.tags).toEqual(["v3"]);
    expect(withoutChip(q, "sort").sort).toBeUndefined();
  });
});

describe("units", () => {
  it("names", () => {
    expect(unitWords("2000 - CRUDE UNIT")).toEqual(["crude"]);
    expect(unitName("2000 - CRUDE UNIT")).toBe("Crude Unit");
    expect(unitName("3000 - KHT")).toBe("KHT");
  });
});

describe("buildArgs", () => {
  it("merges query and hand-set filters; kinds are either-or", () => {
    const q = parseThorQuery("newest prefrac only drawings", UNITS, NOW);
    const a = buildArgs("org", q, { ...EMPTY_FILTERS, types: ["pdf"], units: ["2000"] }, { limit: 50, offset: 0 });
    expect(a.p_terms).toEqual(["prefrac"]);
    expect(a.p_kind_exts).toEqual(["dwg", "dxf", "dgn"]);
    expect(a.p_kind_roles).toEqual(["drawings", "p_and_id"]);
    expect(a.p_exts).toEqual(["pdf"]);
    expect(a.p_units).toEqual(["2000"]);
    expect(a.p_sort).toBe("newest");
  });

  it("hand-set sort wins; no words means newest first", () => {
    const q = parseThorQuery("newest prefrac", UNITS, NOW);
    expect(buildArgs("org", q, { ...EMPTY_FILTERS, sort: "largest" }, { limit: 1, offset: 0 }).p_sort).toBe("largest");
    expect(buildArgs("org", null, { ...EMPTY_FILTERS, folder: "2000 - CRUDE UNIT" }, { limit: 1, offset: 0 }).p_sort).toBe("newest");
  });
});
