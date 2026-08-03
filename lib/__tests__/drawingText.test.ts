// Tests for the drawing-intelligence pattern layer — equipment tags,
// drawing references, census, and the missing-reference audit. These
// patterns decide what the P&ID census reports, so they're pinned here.

import { describe, it, expect } from "vitest";
import {
  isDrawingLikePage, extractEquipmentTags, extractDrawingRefs, normalizeRef,
  buildEquipmentCensus, auditDrawingRefs, equipmentRegisterCsv,
  pageNeedsVision, refSeries, extractTitleBlock,
} from "../drawingText";

describe("isDrawingLikePage", () => {
  it("sparse pages are drawings, dense pages are prose, empty is neither", () => {
    expect(isDrawingLikePage("V-101  P-205A  TO 025-PID-002")).toBe(true);
    expect(isDrawingLikePage("standard prose ".repeat(300))).toBe(false);
    expect(isDrawingLikePage("   ")).toBe(false);
  });
});

describe("extractEquipmentTags", () => {
  it("finds dashed tags with optional letter suffixes", () => {
    const tags = extractEquipmentTags("V-3 feeds P-101A and PSV-2001 protects E-204");
    expect(tags.map((t) => t.tag)).toEqual(["V-3", "P-101A", "PSV-2001", "E-204"]);
    expect(tags[2].prefix).toBe("PSV");
  });

  it("ignores drawing furniture that matches the shape", () => {
    const tags = extractEquipmentTags("DWG-1234 REV-2 SH-1 NO-5 API-653");
    expect(tags).toEqual([]);
  });

  it("requires the dash — prose abbreviations don't count", () => {
    expect(extractEquipmentTags("the V3 nozzle and P101 casing")).toEqual([]);
  });

  it("normalizes case and en-dashes", () => {
    expect(extractEquipmentTags("v–17b")[0]?.tag).toBe("V-17B");
  });
});

describe("extractDrawingRefs", () => {
  it("finds classic drawing-number shapes", () => {
    const refs = extractDrawingRefs("SEE 025-PID-0107 AND PID-22 CONT ON DWG 2245");
    expect(refs).toContain("025-PID-0107");
    expect(refs).toContain("PID-22");
    expect(refs).toContain("DWG-2245");
  });

  it("does not swallow equipment tags via the loose numeric pattern", () => {
    // 10-V-101 is an area-prefixed EQUIPMENT tag, not a drawing number.
    expect(extractDrawingRefs("10-V-101")).toEqual([]);
    // ...but 21-PID-1105 is a drawing number.
    expect(extractDrawingRefs("21-PID-1105")).toEqual(["21-PID-1105"]);
  });

  it("dedupes and normalizes", () => {
    const refs = extractDrawingRefs("PID 107 and PID-107");
    expect(refs).toEqual(["PID-107"]);
  });
});

describe("normalizeRef", () => {
  it("uppercases and collapses separators", () => {
    expect(normalizeRef("dwg  2245")).toBe("DWG-2245");
    expect(normalizeRef("025–PID–0107")).toBe("025-PID-0107");
  });
});

describe("buildEquipmentCensus", () => {
  it("groups distinct tags by prefix with totals", () => {
    const census = buildEquipmentCensus([
      { tag: "V-1" }, { tag: "V-1" }, { tag: "V-2" },
      { tag: "P-101A" }, { tag: "ZZ-9" },
    ]);
    expect(census.totalDistinct).toBe(4);
    expect(census.totalOccurrences).toBe(5);
    const vessels = census.categories.find((c) => c.prefix === "V");
    expect(vessels?.distinctTags).toBe(2);
    expect(vessels?.known).toBe(true);
    expect(census.unknownPrefixes).toEqual(["ZZ"]);
  });
});

describe("auditDrawingRefs", () => {
  const docs = [
    { id: "a", name: "025-PID-0101 — Crude overhead" },
    { id: "b", name: "025-PID-0102 — Desalter" },
  ];

  it("resolves in-library refs and flags same-series sheets that weren't loaded", () => {
    const refs = new Map<string, string[]>([
      ["a", ["025-PID-0102", "025-PID-0999", "025-PID-0101"]],  // self-ref ignored
      ["b", ["025-PID-0999", "025-PID-0101"]],
    ]);
    const audit = auditDrawingRefs(docs, refs);
    expect(audit.resolved).toBe(2);
    expect(audit.missingInSeries).toHaveLength(1);
    expect(audit.missingInSeries[0].ref).toBe("025-PID-0999");
    expect(audit.missingInSeries[0].count).toBe(2);
    expect(audit.outOfScope).toEqual([]);
  });

  // The whole point. A crude unit's P&IDs reference the FCC, the tank farm,
  // and the flare header. None of those are broken connectors — they're
  // drawings nobody handed us.
  it("never calls another unit's drawings missing — they're out of scope", () => {
    const refs = new Map<string, string[]>([
      ["a", ["040-PID-0201", "040-PID-0202", "070-PID-0010"]],
    ]);
    const audit = auditDrawingRefs(docs, refs);
    expect(audit.missingInSeries).toEqual([]);
    expect(audit.outOfScope.map((o) => o.series)).toEqual(["040-PID", "070-PID"]);
    expect(audit.outOfScope[0].refs).toEqual(["040-PID-0201", "040-PID-0202"]);
    expect(audit.seriesInScope).toEqual(["025-PID"]);
  });

  it("matches loose and zero-padded forms of the same sheet", () => {
    const refs = new Map<string, string[]>([["a", ["PID-102", "025-PID-102"]]]);
    const audit = auditDrawingRefs(docs, refs);
    expect(audit.resolved).toBe(2);
    expect(audit.missingInSeries).toEqual([]);
    expect(audit.outOfScope).toEqual([]);
  });

  it("reports a connector that never comes back as one-way, not broken", () => {
    const oneWayRefs = new Map<string, string[]>([["a", ["025-PID-0102"]]]);
    const oneWay = auditDrawingRefs(docs, oneWayRefs);
    expect(oneWay.oneWay).toHaveLength(1);
    expect(oneWay.oneWay[0].from).toContain("0101");
    expect(oneWay.oneWay[0].to).toContain("0102");

    const bothRefs = new Map<string, string[]>([
      ["a", ["025-PID-0102"]], ["b", ["025-PID-0101"]],
    ]);
    expect(auditDrawingRefs(docs, bothRefs).oneWay).toEqual([]);
  });
});

describe("refSeries", () => {
  it("strips the sheet number so sheets of one set group together", () => {
    expect(refSeries("025-PID-0107")).toBe("025-PID");
    expect(refSeries("PID-107")).toBe("PID");
    expect(refSeries("21-D-1105")).toBe("21-D");
  });

  it("sheet-addressed refs group under their base drawing number", () => {
    expect(refSeries("025-A-1001-SH3")).toBe("025-A-1001");
  });
});

describe("extractDrawingRefs — sheet addresses", () => {
  it("captures the sheet number as part of the address", () => {
    expect(extractDrawingRefs("CONT ON DWG 025-A-1001 SH 3")).toEqual(["025-A-1001-SH3"]);
    expect(extractDrawingRefs("SEE 21-D-1105 SHT. 12")).toEqual(["21-D-1105-SH12"]);
  });

  it("keeps the bare number when no sheet is given", () => {
    expect(extractDrawingRefs("SEE 025-A-1001")).toEqual(["025-A-1001"]);
  });

  it("prefers the sheet-addressed form over its own bare base", () => {
    const refs = extractDrawingRefs("TO 025-PID-0107 SH 2 AND ALSO PID-0107");
    expect(refs).toContain("025-PID-0107-SH2");
    expect(refs).not.toContain("025-PID-0107");
  });
});

describe("extractTitleBlock", () => {
  it("reads a vision-transcript style title block", () => {
    const tb = extractTitleBlock(
      "TITLE: CRUDE OVERHEAD SYSTEM\nDRAWING NO: 025-PID-0101\nSHEET: 2 OF 12\nREV: 3",
    );
    expect(tb).toEqual({ drawingNumber: "025-PID-0101", sheetNumber: "2", rev: "3" });
  });

  it("reads a text-layer style border strip", () => {
    const tb = extractTitleBlock("SCALE NTS  DWG. NO. 21-D-1105  SHEET 1 OF 1  REV A");
    expect(tb.drawingNumber).toBe("21-D-1105");
    expect(tb.sheetNumber).toBe("1");
    expect(tb.rev).toBe("A");
  });

  it("requires the NO label — an OPC's 'CONT ON DWG X' is never an identity", () => {
    const tb = extractTitleBlock("CONT ON DWG 040-B-2002 SH 1");
    expect(tb.drawingNumber).toBeNull();
  });

  it("skips label-echo and header-row noise", () => {
    expect(extractTitleBlock("DRAWING NUMBER SHEET NUMBER REV NUMBER").drawingNumber).toBeNull();
    expect(extractTitleBlock("REV DATE DESCRIPTION BY").rev).toBeNull();
  });

  it("normalizes the sheet number", () => {
    expect(extractTitleBlock("DWG NO 025-PID-0101 SHEET 03 OF 12").sheetNumber).toBe("3");
  });
});

describe("auditDrawingRefs — declared identities", () => {
  // Files named by whoever exported them; identity comes from the border.
  const docs = [
    { id: "a", name: "scan_0001.pdf" },
    { id: "b", name: "scan_0002.pdf" },
  ];
  const declared = new Map<string, string[]>([
    ["a", ["025-PID-0101", "025-PID-0101-SH1"]],
    ["b", ["025-PID-0102", "025-PID-0102-SH1"]],
  ]);

  it("resolves refs against title-block identities, not filenames", () => {
    const refs = new Map<string, string[]>([["a", ["025-PID-0102"]]]);
    const audit = auditDrawingRefs(docs, refs, declared);
    expect(audit.resolved).toBe(1);
    expect(audit.missingInSeries).toEqual([]);
    expect(audit.seriesInScope).toEqual(["025-PID"]);
  });

  it("resolves a sheet-addressed ref to the doc declaring that sheet", () => {
    const refs = new Map<string, string[]>([["a", ["025-PID-0102-SH1"]]]);
    expect(auditDrawingRefs(docs, refs, declared).resolved).toBe(1);
  });

  it("a base number shared by loaded sheets counts resolved, never missing", () => {
    const three = [...docs, { id: "c", name: "scan_0003.pdf" }];
    const multi = new Map<string, string[]>([
      ["a", ["025-A-1001", "025-A-1001-SH1"]],
      ["b", ["025-A-1001", "025-A-1001-SH2"]],
      ["c", ["025-B-2002"]],
    ]);
    // c references the two-sheet set by its base number alone — the set IS
    // loaded, so that's resolved, even though no single sheet is named.
    const refs = new Map<string, string[]>([["c", ["025-A-1001"]]]);
    const audit = auditDrawingRefs(three, refs, multi);
    expect(audit.resolved).toBe(1);
    expect(audit.missingInSeries).toEqual([]);
  });

  it("an unloaded sheet of a loaded drawing is a gap, not out of scope", () => {
    const multi = new Map<string, string[]>([
      ["a", ["025-A-1001", "025-A-1001-SH1"]],
      ["b", ["025-A-1001", "025-A-1001-SH2"]],
    ]);
    const refs = new Map<string, string[]>([["a", ["025-A-1001-SH5"]]]);
    const audit = auditDrawingRefs(docs, refs, multi);
    expect(audit.missingInSeries.map((m) => m.ref)).toEqual(["025-A-1001-SH5"]);
    expect(audit.outOfScope).toEqual([]);
  });

  it("out-of-scope series come from REAL referenced numbers", () => {
    const refs = new Map<string, string[]>([["a", ["040-PID-0201-SH2"]]]);
    const audit = auditDrawingRefs(docs, refs, declared);
    expect(audit.outOfScope).toHaveLength(1);
    expect(audit.outOfScope[0].series).toBe("040-PID-0201");
    expect(audit.outOfScope[0].refs).toEqual(["040-PID-0201-SH2"]);
  });
});

describe("equipmentRegisterCsv", () => {
  it("builds one row per distinct tag with category and sheets", () => {
    const csv = equipmentRegisterCsv([
      { tag: "V-1", documentName: "PID-1", page: 1 },
      { tag: "V-1", documentName: "PID-2", page: 3 },
      { tag: "P-9", documentName: "PID-1", page: 1 },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Tag,Category,Occurrences,Sheets,First page");
    expect(lines[1]).toBe("P-9,Pumps,1,PID-1,1");
    expect(lines[2]).toBe("V-1,Vessels / Drums,2,PID-1; PID-2,1");
  });

  it("escapes commas in sheet names", () => {
    const csv = equipmentRegisterCsv([{ tag: "V-1", documentName: "Crude, Unit 1", page: 2 }]);
    expect(csv).toContain('"Crude, Unit 1"');
  });
});

describe("pageNeedsVision", () => {
  it("flags a page with no text layer at all (scan / full-SHX drawing)", () => {
    expect(pageNeedsVision("", 0)).toBe(true);
    expect(pageNeedsVision("   \n  ", 0)).toBe(true);
  });

  it("flags the AutoCAD case: TrueType title block, SHX body, zero tags", () => {
    // A few hundred characters of title-block labels — sails past a naive
    // "is the page empty" check while every equipment tag stays invisible.
    const titleBlockOnly = [
      "CRUDE UNIT", "PIPING AND INSTRUMENTATION DIAGRAM",
      "DWG 025-PID-0107", "REV 3", "SHEET 4 OF 12",
      "DRAWN BY JS", "CHECKED BY RM", "APPROVED PE",
      "SCALE NTS", "DATE 2026-02-11", "CONTRACT 44821",
    ].join("\n");
    expect(titleBlockOnly.length).toBeGreaterThan(60);   // not "empty"
    expect(pageNeedsVision(titleBlockOnly, 0)).toBe(true);
  });

  it("leaves readable drawings alone once tags actually extract", () => {
    const withTags = "CRUDE UNIT\nV-101\nP-205A\nTO 025-PID-0108\n".repeat(3);
    expect(pageNeedsVision(withTags, 5)).toBe(false);
  });

  it("never burns vision on prose pages (standards keep costing nothing)", () => {
    const prose =
      "The minimum design metal temperature shall be established per UCS-66. " +
      "Where impact testing is required, the procedure of UG-84 applies. " +
      "Exemptions are permitted under the conditions of UCS-68(c).";
    expect(pageNeedsVision(prose, 0)).toBe(false);
  });

  it("ignores long pages even without tags — that's prose, not a drawing", () => {
    const long = "label ".repeat(400);
    expect(pageNeedsVision(long, 0)).toBe(false);
  });
});
