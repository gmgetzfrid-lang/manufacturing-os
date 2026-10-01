// Tests for the drawing-intelligence pattern layer — equipment tags,
// drawing references, census, and the missing-reference audit. These
// patterns decide what the P&ID census reports, so they're pinned here.

import { describe, it, expect } from "vitest";
import {
  isDrawingLikePage, extractEquipmentTags, extractDrawingRefs, normalizeRef,
  buildEquipmentCensus, auditDrawingRefs, equipmentRegisterCsv,
  pageNeedsVision, refSeries, extractTitleBlock, parseUnitMap, unitOfRef, parseOpcBoxes,
  matchEquipmentListIntent, parsePrefixMap,
  TEXTLESS_PAGE_MAX_CHARS,
  MIN_TAGS_THIN_PAGE
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

describe("parseUnitMap", () => {
  it("reads unit pairs and the stated prefix length", () => {
    const map = parseUnitMap(
      "First two digits = unit (20 = Crude Unit, 25 = Vacuum Unit, 30 = FCC). " +
      "Next two = document type (02 = P&ID). D = sheet size.",
    );
    expect(map).not.toBeNull();
    expect(map!.prefixLen).toBe(2);
    expect(map!.names["20"]).toBe("Crude Unit");
    expect(map!.names["25"]).toBe("Vacuum Unit");
    expect(map!.names["30"]).toBe("FCC");
  });

  it("colon separators work and drawing numbers in the text don't pollute", () => {
    const map = parseUnitMap("20: Crude Unit. Numbers look like 2002-D-2001 SHT.1");
    expect(map!.names["20"]).toBe("Crude Unit");
    expect(Object.keys(map!.names)).toEqual(["20"]);
  });

  it("no pairs = no map", () => {
    expect(parseUnitMap("just some prose about drawings")).toBeNull();
    expect(parseUnitMap("")).toBeNull();
  });
});

describe("unitOfRef", () => {
  it("reads the unit prefix off the first segment", () => {
    expect(unitOfRef("2502-D-0001", 2)).toBe("25");
    expect(unitOfRef("2002-D-2001-SH3", 2)).toBe("20");
    expect(unitOfRef("PID-107", 2)).toBeNull();
  });
});

describe("parseOpcBoxes", () => {
  it("reads OPC box numbers off a transcript line", () => {
    expect(parseOpcBoxes("OPC 12: TO CRUDE OVHD V-1402 — 2002-D-2001 SH 4")).toEqual(["12"]);
    expect(parseOpcBoxes("OPC #07 FROM DESALTER")).toEqual(["7"]);
  });

  it("ignores lines without an OPC label", () => {
    expect(parseOpcBoxes("6\"-P-1024-A1A TO V-3")).toEqual([]);
  });
});

describe("extractEquipmentTags — drawing-number guard", () => {
  it("never mints equipment out of a drawing number's middle segment", () => {
    expect(extractEquipmentTags("2002-D-2001")).toEqual([]);
    expect(extractEquipmentTags("SEE 2502-D-0001 SH 2")).toEqual([]);
  });

  it("real tags still extract next to drawing numbers", () => {
    const tags = extractEquipmentTags("V-1402 CONT ON 2002-D-2001");
    expect(tags.map((t) => t.tag)).toEqual(["V-1402"]);
  });
});

describe("auditDrawingRefs — unit naming", () => {
  it("labels out-of-scope series with the decoder's unit names", () => {
    const docs = [{ id: "a", name: "x.pdf" }];
    const declared = new Map([["a", ["2002-D-2001", "2002-D-2001-SH1"]]]);
    const refs = new Map([["a", ["2502-D-0001-SH2"]]]);
    const audit = auditDrawingRefs(docs, refs, declared,
      { prefixLen: 2, names: { "20": "Crude Unit", "25": "Vacuum Unit" } });
    expect(audit.outOfScope).toHaveLength(1);
    expect(audit.outOfScope[0].unitName).toBe("Vacuum Unit");
  });
});

describe("extractDrawingRefs — furniture is never a drawing number", () => {
  it("sheet counters don't become drawings", () => {
    expect(extractDrawingRefs("SHT 11 OF 16")).toEqual([]);
    expect(extractDrawingRefs("SHEET 2 OF 12")).toEqual([]);
  });

  it("prose number pairs don't become drawings", () => {
    expect(extractDrawingRefs("SEE NOTE 603 OR 604")).toEqual([]);
    expect(extractDrawingRefs("BETWEEN 100 AND 200")).toEqual([]);
  });

  it("long-prefix equipment mentions stay equipment", () => {
    expect(extractDrawingRefs("SET AT 104 PSV 2001")).toEqual([]);
  });

  it("real refs still extract with context", () => {
    expect(extractDrawingRefs("CONT ON DWG 2002-D-2001 SHT 4")).toEqual(["2002-D-2001-SH4"]);
  });
});

describe("buildEquipmentCensus — next available number", () => {
  it("reports the highest number in use and the next after it", () => {
    const census = buildEquipmentCensus([
      { tag: "V-1" }, { tag: "V-17B" }, { tag: "V-9" }, { tag: "P-101A" },
    ]);
    const vessels = census.categories.find((c) => c.prefix === "V")!;
    expect(vessels.maxNumber).toBe(17);
    expect(vessels.nextNumber).toBe(18);
    const pumps = census.categories.find((c) => c.prefix === "P")!;
    expect(pumps.nextNumber).toBe(102);
  });
});

describe("matchEquipmentListIntent", () => {
  it("catches equipment-register questions", () => {
    expect(matchEquipmentListIntent("show me all equipment in the crude unit").match).toBe(true);
    expect(matchEquipmentListIntent("give me a table of equipment").match).toBe(true);
  });

  it("filters to a named category", () => {
    const i = matchEquipmentListIntent("list the pumps");
    expect(i.match).toBe(true);
    expect(i.prefixes).toEqual(["P"]);
    const v = matchEquipmentListIntent("how many vessels are there");
    expect(v.prefixes).toEqual(["V", "D"]);
  });

  it("stays out of ordinary questions", () => {
    expect(matchEquipmentListIntent("what is V-3 rated for").match).toBe(false);
    expect(matchEquipmentListIntent("hydrotest pressure per B31.3").match).toBe(false);
  });
});

describe("parsePrefixMap", () => {
  it("reads trailing-dash prefix pairs", () => {
    const m = parsePrefixMap("Tag prefixes: X- = Exchanger, ZZ- = Sample station. 20 = Crude Unit.");
    expect(m["X"]).toBe("Exchanger");
    expect(m["ZZ"]).toBe("Sample station");
    expect(Object.keys(m)).toHaveLength(2);
  });

  it("prose like 'D = sheet size' never renames a category", () => {
    const m = parsePrefixMap("First two digits = unit. D = sheet size.");
    expect(m).toEqual({});
  });
});

describe("buildEquipmentCensus — owner labels", () => {
  it("decoder-taught meanings beat the built-in guesses", () => {
    const census = buildEquipmentCensus(
      [{ tag: "X-22" }, { tag: "E-101" }, { tag: "ZZ-9" }],
      { X: "Exchanger", ZZ: "Sample station" },
    );
    expect(census.categories.find((c) => c.prefix === "X")!.label).toBe("Exchanger");
    expect(census.categories.find((c) => c.prefix === "E")!.label).toBe("Exchangers");
    expect(census.categories.find((c) => c.prefix === "ZZ")!.label).toBe("Sample station");
  });
});

// Regression: a real Kern Energy P&ID (AutoCAD SHX export) whose entire text
// layer is its TrueType title block. Measured from the actual PDF: 168
// characters, zero equipment tags, and ONE drawing ref — the sheet's own
// number. Before this, that single self-reference was read as "the text
// layer works", vision was skipped, and the sheet indexed as a title block
// and nothing else — across a whole drawing set, with no error to explain
// the empty census.
describe("SHX drawings whose only text is the title block", () => {
  const TITLE_BLOCK_ONLY = [
    "W:\\2000 CRUDE UNIT\\02-P&ID\\2002-D 2001_SHT09_R39_12-31-24.dwg",
    "of",
    "PIPING & INSTRUMENTATION DIAGRAM",
    "CRUDE UNIT",
    "KERN ENERGY",
    "BAKERSFIELD,CA. 93307",
    "N.T.S 2002-D 2001 9 16 39",
  ].join("\n");

  it("still reads the sheet with vision when its own number is the only tag", () => {
    expect(TITLE_BLOCK_ONLY.trim().length).toBeGreaterThan(TEXTLESS_PAGE_MAX_CHARS);
    expect(extractEquipmentTags(TITLE_BLOCK_ONLY)).toHaveLength(0);
    expect(extractDrawingRefs(TITLE_BLOCK_ONLY).length).toBe(1);
    expect(pageNeedsVision(TITLE_BLOCK_ONLY, 1)).toBe(true);
  });

  it("does not spend vision on a thin page that really did carry its tags", () => {
    expect(pageNeedsVision(TITLE_BLOCK_ONLY, MIN_TAGS_THIN_PAGE)).toBe(false);
  });
});

// ── intelligence Round G (I-07) ────────────────────────────────────────────

import {
  extractLineNumbers, drawingSignals, auditOpcBoxes, declaredSheetIdentity, rollUpEntities, parseOpcLine, drawingRefTargets,
  OPC_LINE_EXAMPLE, OPC_LINE_FORMAT, OPC_NO_DRAWING, OPC_SAME_DRAWING, OPC_RAW_STORED_MAX, TITLE_BLOCK_OPEN, TITLE_BLOCK_CLOSE,
  SPARSE_PAGE_MAX_CHARS, DENSE_DRAWING_MIN_TAGS_PER_KCHAR, DRAWING_MAX_LOWERCASE_RATIO,
} from "../drawingText";
import { truncateSafe } from "../knowledgeText";
import { VISION_SYSTEM } from "../knowledgeVision";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("DWG-2 — a pipe line number is never equipment", () => {
  it("every executed line-number case yields no tag (the finding's list)", () => {
    for (const s of ['6"-P-1024-A1A', '2"-CWS-101-B2', '10"-HC-15003-A1A-HC', 'FROM 8"-P-2201-C1', 'LINE 12"-S-4410-D1']) {
      expect(extractEquipmentTags(s), s).toEqual([]);
    }
  });

  it("every size form drawings use: fractions, whole-and-fraction, doubled quote, typographic marks, IN", () => {
    for (const s of ['3/4"-P-101-A1A', '1-1/2"-CWS-12-B2', '1 1/2"-P-7-A', "6''-P-1024-A1A", '6”-P-1024', '6″-P-1024', '6 IN-P-1024-A1A', '6IN-P-1024', '6INCH-P-1024', '.75"-IA-12', '6" P-1024-A1A']) {
      expect(extractEquipmentTags(s), s).toEqual([]);
    }
  });

  it("a LINE-labelled token is a line (the vision prompt's label)", () => {
    expect(extractEquipmentTags("LINE P-1024-A1A")).toEqual([]);
    expect(extractEquipmentTags("LINE NO. P-1024")).toEqual([]);
    expect(extractEquipmentTags("LINE # P-1024")).toEqual([]);
    expect(extractEquipmentTags('LINE 6"-P-1024-A1A')).toEqual([]);
  });

  it("a valve or instrument written with the size of its line is still a tag (fix pass)", () => {
    // The base extracted every one of these; a size with only a space (or
    // nothing) before a tag is a line number only when a spec segment follows.
    const cases: Array<[string, string[]]> = [
      ['2" PSV-2001', ["PSV-2001"]], ['4" FCV-101', ["FCV-101"]], ['6" SDV-1001', ["SDV-1001"]],
      ['3"x4" PSV-101', ["PSV-101"]], ['1-1/2" PSV-12', ["PSV-12"]], ['3/4" TW-12', ["TW-12"]],
      ['2"PSV-2001', ["PSV-2001"]], ["NPS 2 IN PSV-101", ["PSV-101"]], ['2" V-1 DRAIN', ["V-1"]],
      ['2"x3" PSV-2001 SET 150 PSIG', ["PSV-2001"]], ['2" PSV-2001-A', ["PSV-2001"]],
      // A bare LINE word is a label only with the line's spec segment after it.
      ["SUCTION LINE P-101A", ["P-101A"]],
    ];
    for (const [s, tags] of cases) {
      expect(extractEquipmentTags(s).map((t) => t.tag), s).toEqual(tags);
      expect(extractLineNumbers(s), s).toEqual([]);
    }
  });

  it("real tags still extract — alone, next to a line number, and after a dimension that is not a line size", () => {
    expect(extractEquipmentTags("V-3 P-101A PSV-2001").map((t) => t.tag)).toEqual(["V-3", "P-101A", "PSV-2001"]);
    expect(extractEquipmentTags('6"-P-1024-A1A TO V-3').map((t) => t.tag)).toEqual(["V-3"]);
    expect(extractEquipmentTags('V-1402 6" DRAIN TO P-205A').map((t) => t.tag)).toEqual(["V-1402", "P-205A"]);
    expect(extractEquipmentTags("TRAIN 2 P-101A").map((t) => t.tag)).toEqual(["P-101A"]);
  });

  it("extractLineNumbers keeps the whole number, normalised, by the SAME size grammar", () => {
    expect(extractLineNumbers('6"-P-1024-A1A TO V-3')).toEqual(['6"-P-1024-A1A']);
    expect(extractLineNumbers("FROM 10''-HC-15003-A1A-HC")).toEqual(['10"-HC-15003-A1A-HC']);
    expect(extractLineNumbers('1-1/2"-CWS-12-B2 AND 3/4"-IA-7')).toEqual(['1-1/2"-CWS-12-B2', '3/4"-IA-7']);
    expect(extractLineNumbers("6 IN-P-1024")).toEqual(['6"-P-1024']);
    expect(extractLineNumbers("V-3 P-101A")).toEqual([]);
    // Whatever extractLineNumbers calls a line, extractEquipmentTags never counts.
    const page = '6"-P-1024-A1A 2"-CWS-101-B2 10"-HC-15003-A1A-HC V-3 E-204';
    expect(extractLineNumbers(page)).toHaveLength(3);
    expect(extractEquipmentTags(page).map((t) => t.tag)).toEqual(["V-3", "E-204"]);
  });
});

describe("DWG-4 — the connector line contract between the vision prompt and the parser", () => {
  it("the prompt's own example parses: box number, and the destination drawing with its sheet", () => {
    expect(parseOpcBoxes(OPC_LINE_EXAMPLE)).toEqual(["14"]);
    expect(extractDrawingRefs(OPC_LINE_EXAMPLE)).toEqual(["2002-D-2001-SH4"]);
    expect(parseOpcLine(OPC_LINE_EXAMPLE)).toEqual({
      box: "14", destination: "2002-D-2001", sheet: "4", none: false, empty: false, sameDrawing: false,
    });
    expect(OPC_LINE_FORMAT.startsWith("OPC <box number>: DWG <destination drawing number>")).toBe(true);
  });

  it("a prompt-shaped transcript round-trips through parseOpcBoxes + auditOpcBoxes with a non-empty boxCount", () => {
    const sheetA = [
      "=== TITLE BLOCK ===", "DRAWING NO: 2002-D-2001", "SHEET: 3 OF 12", "REV: 4", "=== END TITLE BLOCK ===",
      "OPC 14: DWG 2002-D-2001 SH 4 — TO V-1402 CRUDE OVERHEAD",
      `OPC 15: DWG ${OPC_NO_DRAWING} — FROM DESALTER`,
      "OPC 16: DWG 2002-D-2001 SH 5 — TO E-201 FEED",
    ];
    const sheetB = ["OPC 14: DWG 2002-D-2001 SH 3 — FROM V-1401"];
    // SH5's own transcript names its connectors too — box 21, never 16.
    const sheetC = ["OPC 21: DWG 2002-D-2001 SH 6 — TO P-201A"];
    const rowsOf = (doc: string, page: number, lines: string[]) =>
      lines.flatMap((l) => parseOpcBoxes(l).map((box) => ({ document_id: doc, page, tag: box, raw: l })));
    const rows = [...rowsOf("a", 3, sheetA), ...rowsOf("b", 4, sheetB), ...rowsOf("c", 5, sheetC)];
    const self = new Map([
      ["a", ["2002-D-2001", "2002-D-2001-SH3"]], ["b", ["2002-D-2001", "2002-D-2001-SH4"]], ["c", ["2002-D-2001", "2002-D-2001-SH5"]],
    ]);
    const names = new Map([["a", "SH3.pdf"], ["b", "SH4.pdf"], ["c", "SH5.pdf"]]);
    const audit = auditOpcBoxes(rows, self, names);
    expect(audit.boxCount).toBe(5);
    // Box 14 comes back on SH4; box 16 names SH5, whose boxes WERE read and
    // carry no 16.
    expect(audit.unreturned).toEqual([expect.objectContaining({ box: "16", from: "SH3.pdf", to: "SH5.pdf" })]);
    // NONE in place of a drawing number and a sheet is the one
    // broken-by-definition case.
    expect(audit.noRef).toEqual([expect.objectContaining({ box: "15", sheet: "SH3.pdf" })]);
    expect(audit.unknown).toEqual([]);
    // Box 21 names SH6, which is not loaded: no pairing to judge.
    expect(audit.unpaired).toEqual([]);
  });

  it("a connector into a sheet with NO box numbers read is unpaired — never unreturned, never broken (review fix pass 2)", () => {
    // SH3 is vision-read under the contract; SH4 is a text layer (it never
    // prints a box token) or was read before connector boxes were
    // transcribed: it has no opc rows at all.
    const rows = [{ document_id: "a", page: 3, tag: "14", raw: OPC_LINE_EXAMPLE }];
    const self = new Map([["a", ["2002-D-2001", "2002-D-2001-SH3"]], ["b", ["2002-D-2001", "2002-D-2001-SH4"]]]);
    const audit = auditOpcBoxes(rows, self, new Map([["a", "SH3.pdf"], ["b", "SH4.pdf"]]));
    expect(audit.unreturned).toEqual([]);
    expect(audit.noRef).toEqual([]);
    expect(audit.unpaired).toEqual([{ box: "14", from: "SH3.pdf", to: "SH4.pdf", line: OPC_LINE_EXAMPLE }]);
  });

  // Fix pass: the destination is read BY POSITION, so a site's own numbering
  // can never turn a connector into a broken one.
  const one = (raw: string, self: Array<[string, string[]]> = []) => auditOpcBoxes(
    [{ document_id: "a", page: 1, tag: parseOpcBoxes(raw)[0] ?? "1", raw }],
    new Map(self), new Map([["a", "A.pdf"], ["b", "B.pdf"]]),
  );

  it("a destination in any numbering scheme is a destination — never 'names no drawing'", () => {
    for (const n of ["025-M-0107", "21-A-1105", "100-E-001", "025-P-1001", "4410-01-001", "123456", "D-2001", "M-101", "2002-D-2001"]) {
      const raw = `OPC 7: DWG ${n} SH 2 — TO V-1402`;
      expect(parseOpcLine(raw), n).toMatchObject({ box: "7", destination: n, sheet: "2", none: false });
      const audit = one(raw);
      expect(audit.noRef, n).toEqual([]);
      expect(audit.unknown, n).toEqual([]);
    }
  });

  it("the DWG label gives the reference layer its context: loose-shaped numbers are references too", () => {
    expect(extractDrawingRefs("OPC 7: DWG 025-M-0107 SH 2 — TO V-1402")).toEqual(["025-M-0107-SH2"]);
    // …which the base contract, with the bare number after the colon, lost.
    expect(extractDrawingRefs("OPC 7: 025-M-0107 SH 2 — TO V-1402")).toEqual([]);
  });

  /** A connector on A, with B's box numbers read (`boxesOnB`) or not. */
  const pair = (raw: string, selfA: string[], selfB: string[], boxesOnB: string[] | null) => auditOpcBoxes(
    [
      { document_id: "a", page: 1, tag: parseOpcBoxes(raw)[0] ?? "1", raw },
      ...(boxesOnB ?? []).map((box) => ({ document_id: "b", page: 1, tag: box, raw: `OPC ${box}: DWG 9999-X-0001 — TO V-1` })),
    ],
    new Map([["a", selfA], ["b", selfB]]), new Map([["a", "A.pdf"], ["b", "B.pdf"]]),
  );

  it("pairs by the positional destination, whatever its shape: the box must come back on that sheet", () => {
    const raw = "OPC 7: DWG 4410-01-001 SH 2 — TO V-1402";
    expect(extractDrawingRefs(raw)).toEqual([]);                    // the grammar cannot read it…
    const audit = pair(raw, [], ["4410-01-001", "4410-01-001-SH2"], ["3"]);
    expect(audit.unreturned).toEqual([expect.objectContaining({ box: "7", from: "A.pdf", to: "B.pdf" })]);  // …the position can
    expect(pair(raw, [], ["4410-01-001", "4410-01-001-SH2"], ["7"]).unreturned).toEqual([]);
    // B with no box numbers read cannot say: unpaired, never unreturned.
    const unread = pair(raw, [], ["4410-01-001", "4410-01-001-SH2"], null);
    expect(unread.unreturned).toEqual([]);
    expect(unread.unpaired).toEqual([expect.objectContaining({ box: "7", from: "A.pdf", to: "B.pdf" })]);
    // A sheet named by the connector is never paired with a sheet that did
    // not declare it (the bare number may be a whole set).
    const set = pair(raw, [], ["4410-01-001"], ["3"]);
    expect(set.unreturned).toEqual([]);
    expect(set.unpaired).toEqual([]);
  });

  it("a connector naming only a sheet continues within its own drawing — paired there, never broken (review fix pass 2)", () => {
    const selfA = ["2002-D-2001", "2002-D-2001-SH3"];
    const selfB = ["2002-D-2001", "2002-D-2001-SH4"];
    for (const raw of [
      `OPC 14: DWG ${OPC_SAME_DRAWING} SH 4 — TO V-1402`,  // the contract's own form
      `OPC 14: DWG ${OPC_NO_DRAWING} SH 4 — TO V-1402`,    // the first contract's wording: NONE, with a sheet
      "OPC 14: DWG SH 4 — TO V-1402",                      // an empty field, with a sheet
    ]) {
      expect(parseOpcLine(raw), raw).toMatchObject({ box: "14", destination: null, sheet: "4", none: false, empty: false, sameDrawing: true });
      // SH4's boxes were read and 14 is among them: paired, nothing to say.
      const ok = pair(raw, selfA, selfB, ["14"]);
      expect(ok.noRef, raw).toEqual([]);
      expect(ok.unreturned, raw).toEqual([]);
      expect(ok.unpaired, raw).toEqual([]);
      expect(ok.unknown, raw).toEqual([]);
      // SH4's boxes were read and 14 is not: unreturned, on the sheet named.
      expect(pair(raw, selfA, selfB, ["15"]).unreturned, raw).toEqual([expect.objectContaining({ box: "14", from: "A.pdf", to: "B.pdf" })]);
      // SH4 has no box numbers read: unpaired.
      expect(pair(raw, selfA, selfB, null).unpaired, raw).toEqual([expect.objectContaining({ box: "14", to: "B.pdf" })]);
    }
    // The source declared no drawing number: the sheet cannot be found —
    // unpaired, never broken.
    const blind = pair(`OPC 14: DWG ${OPC_SAME_DRAWING} SH 4 — TO V-1402`, [], selfB, ["15"]);
    expect(blind.noRef).toEqual([]);
    expect(blind.unreturned).toEqual([]);
    expect(blind.unpaired).toEqual([expect.objectContaining({ box: "14", from: "A.pdf", to: expect.stringMatching(/sheet 4 of its own drawing/) })]);
    // SAME with no sheet is outside the contract's meaning: unknown, never broken.
    const noSheet = one(`OPC 14: DWG ${OPC_SAME_DRAWING} — TO V-1402`);
    expect(noSheet.noRef).toEqual([]);
    expect(noSheet.unknown).toHaveLength(1);
  });

  it("broken means what the contract says: the field reads NONE, or is empty", () => {
    expect(one(`OPC 15: DWG ${OPC_NO_DRAWING} — FROM DESALTER`).noRef).toHaveLength(1);
    expect(one("OPC 15: DWG NONE SHOWN — FROM DESALTER").noRef).toHaveLength(1);
    expect(one("OPC 15: DWG — FROM DESALTER").noRef).toHaveLength(1);
    expect(one("OPC 15: DWG").noRef).toHaveLength(1);
    // …unless a drawing number stands elsewhere on the line: which sheet the
    // box means is then unclear — unknown, never broken, and never paired
    // against that number (review fix pass 3).
    const tail = pair("OPC 15: DWG NONE — CONT ON DWG 025-PID-0107", [], ["025-PID-0107"], ["9"]);
    expect(tail.noRef).toEqual([]);
    expect(tail.unknown).toHaveLength(1);
    expect(tail.unreturned).toEqual([]);
    expect(tail.unpaired).toEqual([]);
  });

  it("a drawing number in the service tail is never the destination: no false unreturned against it (review fix pass 3)", () => {
    // A (0104): box 14 continues on 0105; its service comes FROM a header
    // drawn on 0101. B (0105) carries box 14; C (0101) carries only box 3.
    const self = new Map([["a", ["025-PID-0104"]], ["b", ["025-PID-0105"]], ["c", ["025-PID-0101"]]]);
    const names = new Map([["a", "A.pdf"], ["b", "B.pdf"], ["c", "C.pdf"]]);
    for (const raw of [
      "OPC 14: DWG 025-PID-0105 — FROM 025-PID-0101 HEADER",  // the contract's shape
      "OPC 14: DWG 025-PID-0105 FROM 025-PID-0101 HEADER",    // the tail's dash left out
      "OPC 14: DWG 025-PID-0105 -- TO 025-PID-0101 HEADER",
    ]) {
      expect(parseOpcLine(raw), raw).toMatchObject({ box: "14", destination: "025-PID-0105" });
      const audit = auditOpcBoxes([
        { document_id: "a", page: 1, tag: "14", raw },
        { document_id: "b", page: 1, tag: "14", raw: "OPC 14: DWG 025-PID-0104 — TO V-1402" },
        { document_id: "c", page: 1, tag: "3", raw: "OPC 3: DWG 025-PID-0102 — TO V-3" },
      ], self, names);
      expect(audit.unreturned, raw).toEqual([]);
      expect(audit.unpaired, raw).toEqual([]);
      expect(audit.noRef, raw).toEqual([]);
      // A's verdict depends on B's box numbers — never on C's.
      expect(audit.targetsByDoc.get("a"), raw).toEqual(["b"]);
      // …and a missing box on the sheet the field DOES name is still caught.
      const missing = auditOpcBoxes([
        { document_id: "a", page: 1, tag: "14", raw },
        { document_id: "b", page: 1, tag: "7", raw: "OPC 7: DWG 025-PID-0199 — TO V-1402" },
      ], self, names);
      expect(missing.unreturned, raw).toEqual([expect.objectContaining({ box: "14", from: "A.pdf", to: "B.pdf" })]);
    }
    // A line outside the contract still reads its references whole, as before.
    expect(pair("OPC 3 CONT ON DWG 025-PID-0107", [], ["025-PID-0107"], ["9"]).targetsByDoc.get("a")).toEqual(["b"]);
  });

  it("a destination present but not shaped like a drawing number is unknown, never broken", () => {
    for (const raw of ["OPC 9: DWG SEE NOTE 3 — TO FLARE", "OPC 9: DWG ILLEGIBLE — TO FLARE", "OPC 9: DWG [illegible] SH 2"]) {
      const audit = one(raw);
      expect(audit.noRef, raw).toEqual([]);
      expect(audit.unknown, raw).toHaveLength(1);
    }
  });

  it("a line outside the contract: unknown when something on it could still be a drawing number, broken only when nothing could", () => {
    // A text layer's own "OPC" box with a loose number and no context word.
    expect(one("OPC 3 TO 025-M-0107").unknown).toHaveLength(1);
    expect(one("OPC 3 TO 025-M-0107").noRef).toEqual([]);
    // Only the box, equipment and a sheet number: nothing names a drawing.
    expect(one("OPC 3 TO V-1402 SH 2 CRUDE").noRef).toHaveLength(1);
    expect(one("OPC 3 FROM 12\"-P-14022-A1A").noRef).toHaveLength(1);
    // A readable reference outside the contract still pairs as before —
    // against a sheet whose box numbers were read; one whose were not is
    // unpaired.
    expect(pair("OPC 3 CONT ON DWG 025-PID-0107", [], ["025-PID-0107"], ["9"]).unreturned).toHaveLength(1);
    expect(one("OPC 3 CONT ON DWG 025-PID-0107", [["b", ["025-PID-0107"]]]).unpaired).toHaveLength(1);
    expect(one("OPC 3 CONT ON DWG 025-PID-0107", [["b", ["025-PID-0107"]]]).unreturned).toEqual([]);
    // A row with no stored line says nothing about its destination.
    const bare = auditOpcBoxes([{ document_id: "a", page: 1, tag: "3", raw: null }], new Map(), new Map([["a", "A.pdf"]]));
    expect(bare.noRef).toEqual([]);
    expect(bare.unknown).toHaveLength(1);
  });

  it("drawingRefTargets: the one sheet each reference resolves to — what a one-way finding is read off (review fix pass 3)", () => {
    const docs = [
      { id: "a", name: "025-PID-0106.pdf" }, { id: "b", name: "025-PID-0107.pdf" },
      { id: "s1", name: "x.pdf" }, { id: "s2", name: "y.pdf" },
    ];
    const self = new Map([["s1", ["2002-D-2001", "2002-D-2001-SH1"]], ["s2", ["2002-D-2001", "2002-D-2001-SH2"]]]);
    const refs = new Map([
      ["a", ["025-PID-0107", "025-PID-0106", "025-PID-0999", "2002-D-2001", "2002-D-2001-SH2"]],
    ]);
    // 0107 is one sheet; its own number links nothing; 0999 is not loaded;
    // the bare 2002-D-2001 names a whole set (no single sheet); SH2 is one.
    expect(drawingRefTargets(docs, refs, self).get("a")).toEqual(["b", "s2"]);
    expect(drawingRefTargets(docs, new Map([["b", ["025-PID-0107"]]]), self).has("b")).toBe(false);
  });

  it("the text layer's connectors are its references: CONT ON / pennant numbers extract as refs and pair one-way", () => {
    expect(extractDrawingRefs("CONT ON DWG 025-PID-0107")).toEqual(["025-PID-0107"]);
    expect(extractDrawingRefs("025-PID-0108 SH 2")).toEqual(["025-PID-0108-SH2"]);
    const docs = [{ id: "a", name: "025-PID-0106.pdf" }, { id: "b", name: "025-PID-0107.pdf" }];
    const audit = auditDrawingRefs(docs, new Map([["a", ["025-PID-0107"]]]));
    expect(audit.oneWay).toEqual([{ from: "025-PID-0106.pdf", to: "025-PID-0107.pdf", count: 1 }]);
  });

  // Review fix pass 4: a sheet that was not read whole (pages AI vision never
  // read, still indexing, failed) is no evidence of what it lacks. The box,
  // or the reference back, may stand on a page nobody read; filing it
  // `unreturned` recorded `broken_connectors`, never lowered at that revision.
  it("a box not on what was read of a sheet not read whole is unpaired with the reason — never unreturned (review fix pass 4)", () => {
    const self = new Map([["a", ["025-PID-0104", "025-PID-0104-SH1"]], ["b", ["025-PID-0105", "025-PID-0105-SH1"]]]);
    const names = new Map([["a", "025-PID-0104.pdf"], ["b", "025-PID-0105.pdf"]]);
    const line = "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402";
    // 0105: page 1 read (box 7), page 2 waits on AI vision — box 14 is there.
    const rows = [{ document_id: "a", page: 1, tag: "14", raw: line }, { document_id: "b", page: 1, tag: "7", raw: "OPC 7: DWG 025-PID-0199 — TO V-7" }];
    const partly = auditOpcBoxes(rows, self, names, new Map([["b", "page(s) 2 never read"]]));
    expect(partly.unreturned).toEqual([]);
    expect(partly.noRef).toEqual([]);
    expect(partly.unpaired).toEqual([{ box: "14", from: "025-PID-0104.pdf", to: "025-PID-0105.pdf", line, unread: "page(s) 2 never read" }]);
    // The verdict still depends on 0105: re-judged once it is read whole.
    expect(partly.targetsByDoc.get("a")).toEqual(["b"]);
    // Read whole and still without box 14: that one is unreturned.
    expect(auditOpcBoxes(rows, self, names).unreturned).toEqual([expect.objectContaining({ box: "14", to: "025-PID-0105.pdf" })]);
    // A box that IS on what was read pairs, whole or not.
    const found = auditOpcBoxes([...rows, { document_id: "b", page: 1, tag: "14", raw: "OPC 14: DWG 025-PID-0104 — FROM V-1401" }],
      self, names, new Map([["b", "page(s) 2 never read"]]));
    expect(found.unpaired).toEqual([]);
    expect(found.unreturned).toEqual([]);
    // No box numbers read at all on a sheet not read whole: unpaired, with why.
    expect(auditOpcBoxes([rows[0]], self, names, new Map([["b", "its indexing failed"]])).unpaired)
      .toEqual([expect.objectContaining({ box: "14", unread: "its indexing failed" })]);
  });

  it("a reference back, or a sheet, not found on a sheet not read whole is unchecked — never one-way, never a gap (review fix pass 4)", () => {
    const docs = [{ id: "a", name: "025-PID-0104.pdf" }, { id: "b", name: "025-PID-0105.pdf" }];
    const self = new Map([["a", ["025-PID-0104"]], ["b", ["025-PID-0105", "025-PID-0105-SH1"]]]);
    // 0104 points at 0105 (SH1 read) and at 0105 SH2 (its page never read),
    // and at 025-PID-0199, which is not in the library at all.
    const refs = new Map([["a", ["025-PID-0105", "025-PID-0105-SH2", "025-PID-0199"]]]);
    const partly = auditDrawingRefs(docs, refs, self, null, new Map([["b", "page(s) 2 never read"]]));
    expect(partly.oneWay).toEqual([]);
    expect(partly.oneWayUnread).toEqual([{ from: "025-PID-0104.pdf", to: "025-PID-0105.pdf", count: 1, unread: "page(s) 2 never read" }]);
    expect(partly.missingInSeries.map((m) => m.ref)).toEqual(["025-PID-0199"]);
    expect(partly.missingUnread).toEqual([
      { ref: "025-PID-0105-SH2", referencedBy: ["025-PID-0104.pdf"], count: 1, maybeIn: ["025-PID-0105.pdf (page(s) 2 never read)"] },
    ]);
    // Read whole: the same references are one-way and missing, as before.
    const whole = auditDrawingRefs(docs, refs, self);
    expect(whole.oneWay).toEqual([{ from: "025-PID-0104.pdf", to: "025-PID-0105.pdf", count: 1 }]);
    expect(whole.missingInSeries.map((m) => m.ref).sort()).toEqual(["025-PID-0105-SH2", "025-PID-0199"]);
    expect(whole.oneWayUnread).toEqual([]);
    expect(whole.missingUnread).toEqual([]);
    // A document whose number was never read (no title block declared, none
    // in its filename) that is not read whole may be any sheet: no gap.
    const scan = auditDrawingRefs([...docs, { id: "s", name: "scan_003.pdf" }], refs, self, null, new Map([["s", "its indexing failed"]]));
    expect(scan.missingInSeries).toEqual([]);
    expect(scan.missingUnread.map((m) => [m.ref, m.maybeIn])).toEqual(expect.arrayContaining([
      ["025-PID-0199", ["scan_003.pdf (its indexing failed)"]],
    ]));
  });

  it("the prompt says how to write a sheet-only connector, and never to invent a box number (review fix pass 2)", () => {
    // A same-drawing continuation: SAME with its sheet — parsed as such.
    expect(VISION_SYSTEM).toContain(`'OPC 14: DWG ${OPC_SAME_DRAWING} SH 4 — TO V-1402'`);
    expect(parseOpcLine(`OPC 14: DWG ${OPC_SAME_DRAWING} SH 4 — TO V-1402`)).toMatchObject({ sameDrawing: true, sheet: "4" });
    expect(VISION_SYSTEM).toMatch(/only a sheet number \(it continues on another sheet of this same drawing\), write SAME/);
    expect(VISION_SYSTEM).toMatch(/neither a drawing number nor a sheet, write NONE/);
    // A pennant with no box number gets no OPC line — it is transcribed as
    // continuation phrasing, which the reference layer reads.
    expect(VISION_SYSTEM).toMatch(/shows NO box number, do not write an OPC line for it and never make a number up/);
    expect(VISION_SYSTEM).toContain("'CONT ON DWG <drawing number> SH <sheet>'");
    expect(parseOpcBoxes("CONT ON DWG 2002-D-2001 SH 4")).toEqual([]);
    expect(extractDrawingRefs("CONT ON DWG 2002-D-2001 SH 4")).toEqual(["2002-D-2001-SH4"]);
  });

  it("the vision prompt is built from the parser's constants (they cannot drift apart)", () => {
    const vision = readFileSync(join(__dirname, "..", "knowledgeVision.ts"), "utf8");
    expect(vision).toMatch(/import \{[\s\S]*OPC_LINE_FORMAT, OPC_LINE_EXAMPLE, OPC_NO_DRAWING, OPC_SAME_DRAWING, TITLE_BLOCK_OPEN, TITLE_BLOCK_CLOSE,[\s\S]*\} from "@\/lib\/drawingText"/);
    expect(vision).toContain("${OPC_LINE_FORMAT}");
    expect(vision).toContain("${OPC_SAME_DRAWING}");
    expect(vision).toContain("${TITLE_BLOCK_OPEN}");
    expect(vision).not.toMatch(/instrument bubble \(V-3, P-101A, PSV-2001, "\s*\+?\s*"6\\"-P-1024-A1A\)/);
  });
});

describe("PR-11 — a connector never becomes the sheet's identity", () => {
  it("labelled continuation phrasing is a connector, not a title block", () => {
    expect(extractTitleBlock("CONT ON DWG NO. 040-B-2002 SH 1").drawingNumber).toBeNull();
    expect(extractTitleBlock("CONTINUED ON DRAWING NO 021-PID-0107").drawingNumber).toBeNull();
    expect(extractTitleBlock("SEE DWG NO. 12-A-3003").drawingNumber).toBeNull();
    expect(extractTitleBlock("FROM DWG # 040-B-2001").drawingNumber).toBeNull();
    expect(extractTitleBlock("REF DWG NO. 025-PID-0001").drawingNumber).toBeNull();
  });

  it("a text layer with the connector FIRST still declares its own border number", () => {
    const tb = extractTitleBlock("CONT ON DWG NO. 040-B-2002 SH 1\nTO V-3\nDRAWING NO: 025-PID-0104  SHEET 2 OF 4  REV C");
    expect(tb).toEqual({ drawingNumber: "025-PID-0104", sheetNumber: "2", rev: "C" });
  });

  it("a fenced transcript is read ONLY inside the fence — whatever precedes it", () => {
    const transcript = [
      "OPC 14: 040-B-2002 SH 1 — TO V-1402",
      "CONT ON DWG NO. 040-B-2002 SHEET 1",
      TITLE_BLOCK_OPEN, "DRAWING NO: 025-PID-0104", "SHEET: 3 OF 4", "REV: D", TITLE_BLOCK_CLOSE,
      "NOTES: 1. SEE DWG NO. 999-X-1.",
    ].join("\n");
    expect(extractTitleBlock(transcript)).toEqual({ drawingNumber: "025-PID-0104", sheetNumber: "3", rev: "D" });
  });

  it("an unclosed fence still bounds the read to the border's fields", () => {
    const t = `${TITLE_BLOCK_OPEN}\nDRAWING NO: 025-PID-0104\nSHEET: 1 OF 1\nREV: 2\nTITLE: X\nLINE 6"-P-1\nNOTE 4\nDWG NO. 777-Z-0001`;
    expect(extractTitleBlock(t).drawingNumber).toBe("025-PID-0104");
  });
});

describe("DWG-7 / BR-12 — a dense text-layer P&ID is a drawing; prose is not", () => {
  // A TrueType P&ID: every tag, line number, note and revision row in the
  // text layer, several thousand characters (the case no fixture had).
  const densePid = [
    "DRAWING NO: 025-PID-0104  SHEET 1 OF 3  REV 2",
    ...Array.from({ length: 50 }, (_, i) =>
      `V-${101 + i} SUCTION DRUM  6"-P-${1000 + i}-A1A  TO E-${201 + i} VIA FV-${301 + i}`),
    "NOTES: 1. ALL DIMENSIONS IN MM. 2. ALL LINES INSULATED UNLESS NOTED. 3. SEE DWG 025-PID-0105 FOR CONTINUATION.",
  ].join("\n");

  it("the fixture is past the sparse ceiling, and is read as a drawing by its signals", () => {
    expect(densePid.length).toBeGreaterThan(SPARSE_PAGE_MAX_CHARS);
    const s = drawingSignals(densePid);
    expect(s.tagsPerKchar).toBeGreaterThanOrEqual(DENSE_DRAWING_MIN_TAGS_PER_KCHAR);
    expect(s.lowercaseRatio).toBeLessThanOrEqual(DRAWING_MAX_LOWERCASE_RATIO);
    expect(isDrawingLikePage(densePid)).toBe(true);
    // …and yields equipment tags and a title-block identity — never line numbers.
    const tags = extractEquipmentTags(densePid).map((t) => t.tag);
    expect(tags).toContain("V-101");
    expect(tags).toContain("FV-301");
    expect(tags.some((t) => t.startsWith("P-10"))).toBe(false);
    expect(extractTitleBlock(densePid).drawingNumber).toBe("025-PID-0104");
  });

  it("dense prose stays prose — even prose that names equipment", () => {
    const procedure = Array.from({ length: 40 }, (_, i) =>
      `Before starting pump P-${100 + i}A, the operator shall confirm that the suction valve is open and the casing is vented.`).join(" ");
    expect(procedure.length).toBeGreaterThan(SPARSE_PAGE_MAX_CHARS);
    expect(isDrawingLikePage(procedure)).toBe(false);
    expect(drawingSignals(procedure).lowercaseRatio).toBeGreaterThan(DRAWING_MAX_LOWERCASE_RATIO);
  });

  it("dense capitals with no tags (a legal notice) are not a tag list — unless the sheet's border declares it a drawing", () => {
    const notes = "ALL WORK SHALL CONFORM TO THE LATEST EDITION OF THE APPLICABLE CODES AND STANDARDS. ".repeat(40);
    expect(isDrawingLikePage(notes)).toBe(false);
    // A general-notes SHEET: same capitals, plus its own title block.
    expect(isDrawingLikePage(`${notes}\nDRAWING NO: 025-GN-0001  SHEET 1 OF 1  REV 0`)).toBe(true);
    // Prose citing a drawing number in mixed case is still prose.
    const spec = "Refer to drawing no. 123-A-4567 for the general arrangement of the unit. ".repeat(40);
    expect(isDrawingLikePage(spec)).toBe(false);
  });

  it("sparse pages keep the fast path exactly as before", () => {
    expect(isDrawingLikePage("V-101  P-205A  TO 025-PID-002")).toBe(true);
    expect(isDrawingLikePage("a short prose line.")).toBe(true);
  });
});

describe("DWG-8 — a cut evidence line is unknown, never broken", () => {
  const long = "OPC 14: TO CRUDE COLUMN OVERHEAD ACCUMULATOR V-1402, THEN 12\"-P-14022-A1A AND THE OVERHEAD RECEIVER BYPASS, " +
    "SERVICE: SOUR WATER RETURN, CONTINUED ON DRAWING 2002-D-2001 SHEET 4 OF 12";
  it("a >160-character connector line, cut the way ingest cuts it, does not report noRef", () => {
    expect(long.length).toBeGreaterThan(OPC_RAW_STORED_MAX);
    const raw = truncateSafe(long, OPC_RAW_STORED_MAX);           // ingest's own cut
    expect(extractDrawingRefs(raw)).toEqual([]);                   // the drawing number is gone…
    const audit = auditOpcBoxes([{ document_id: "a", page: 2, tag: "14", raw }], new Map(), new Map([["a", "A.pdf"]]));
    expect(audit.noRef).toEqual([]);                               // …so it is NOT broken
    expect(audit.unknown).toEqual([expect.objectContaining({ box: "14", sheet: "A.pdf", page: 2, line: raw })]);
  });

  it("a complete short line with no drawing number is still broken by definition", () => {
    for (const raw of ["OPC 7: DWG NONE — FROM DESALTER", "OPC 7: NONE — FROM DESALTER"]) {
      const audit = auditOpcBoxes([{ document_id: "a", page: 1, tag: "7", raw }], new Map(), new Map([["a", "A.pdf"]]));
      expect(audit.noRef, raw).toHaveLength(1);
      expect(audit.unknown, raw).toEqual([]);
    }
  });

  it("a contract line keeps its destination at the head, so the storage cut can never take it", () => {
    const longContract = `OPC 14: DWG 2002-D-2001 SH 4 — TO ${"CRUDE COLUMN OVERHEAD ACCUMULATOR ".repeat(6)}`;
    const raw = truncateSafe(longContract, OPC_RAW_STORED_MAX);
    const audit = auditOpcBoxes([{ document_id: "a", page: 2, tag: "14", raw }], new Map(), new Map([["a", "A.pdf"]]));
    expect(audit.noRef).toEqual([]);
    expect(audit.unknown).toEqual([]);
  });

  it("the stored cut is the one ingest makes (OPC_RAW_STORED_MAX pinned to lib/knowledgeIngest.ts)", () => {
    const ingest = readFileSync(join(__dirname, "..", "knowledgeIngest.ts"), "utf8");
    expect(ingest).toMatch(new RegExp(`kind: "opc", tag: box, raw: truncateSafe\\(line, ${OPC_RAW_STORED_MAX}\\)`));
  });
});

describe("DWG-10 — one deterministic sheet identity for the lens and the record", () => {
  it("shortest declared number without -SHn, independent of row order", () => {
    const tags = ["025-PID-0101-SH3", "025-PID-0101", "025-PID-0101-SH2"];
    for (const order of [tags, [...tags].reverse(), [tags[2], tags[0], tags[1]]]) {
      expect(declaredSheetIdentity(order)).toEqual({ base: "025-PID-0101", sheetsDeclared: 2 });
    }
  });
  it("ties break in code-unit order; only sheet forms → their shared number; nothing → null", () => {
    expect(declaredSheetIdentity(["B-100", "A-100"]).base).toBe("A-100");
    expect(declaredSheetIdentity(["A-100", "B-100"]).base).toBe("A-100");
    expect(declaredSheetIdentity(["21-D-1105-SH3"])).toEqual({ base: "21-D-1105", sheetsDeclared: 1 });
    expect(declaredSheetIdentity([])).toEqual({ base: null, sheetsDeclared: 0 });
  });
});

describe("DWG-11 — the roll-up the census is computed from", () => {
  const rows = [
    { document_id: "d2", page: 3, kind: "equipment", tag: "V-1" },
    { document_id: "d1", page: 2, kind: "equipment", tag: "V-1" },
    { document_id: "d1", page: 1, kind: "equipment", tag: "V-1" },
    { document_id: "d1", page: 1, kind: "equipment", tag: "V-1" },
    { document_id: "d1", page: 1, kind: "ref", tag: "025-PID-0102" },
  ];
  it("one row per sheet, kind and tag: occurrences, first page, distinct pages — ordered", () => {
    expect(rollUpEntities(rows)).toEqual([
      { document_id: "d1", kind: "equipment", tag: "V-1", occurrences: 3, first_page: 1, pages: [1, 2] },
      { document_id: "d1", kind: "ref", tag: "025-PID-0102", occurrences: 1, first_page: 1, pages: [1] },
      { document_id: "d2", kind: "equipment", tag: "V-1", occurrences: 1, first_page: 3, pages: [3] },
    ]);
  });
  it("a census from counted rows equals the census from every occurrence", () => {
    const eq = rows.filter((r) => r.kind === "equipment");
    const counted = rollUpEntities(eq).map((r) => ({ tag: r.tag, count: r.occurrences }));
    expect(buildEquipmentCensus(counted)).toEqual(buildEquipmentCensus(eq));
  });
  it("the CSV register from counted rows names the first page per sheet, whatever the row order", () => {
    const csv = equipmentRegisterCsv([
      { tag: "V-1", documentName: "PID-1", page: 4, count: 2 },
      { tag: "V-1", documentName: "PID-1", page: 2, count: 1 },
    ]);
    expect(csv.split("\r\n")[1]).toBe("V-1,Vessels / Drums,3,PID-1,2");
  });
});
