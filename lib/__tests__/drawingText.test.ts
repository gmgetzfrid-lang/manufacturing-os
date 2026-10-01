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

  // Review fix pass 5: the display cut (six) is not the record's list.
  it("a missing sheet names every referencing sheet for the record — six for display", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `025-PID-010${i + 1}.pdf` }));
    const refs = new Map(many.map((d) => [d.id, ["025-PID-0199"]]));
    const audit = auditDrawingRefs(many, refs);
    expect(audit.missingInSeries).toHaveLength(1);
    expect(audit.missingInSeries[0].referencedBy).toHaveLength(6);
    expect(audit.missingInSeries[0].referencedByAll).toEqual(many.map((d) => d.name));
    expect(audit.missingInSeries[0].count).toBe(8);
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

/** The pages each declared number stands on (the roll-up's `pages` for
 *  kind 'self'): every one on `pageOf(doc)` — page 1 unless said. Box
 *  pairing reads the sheet by its page (review fix pass 5). */
const onPage = (self: ReadonlyMap<string, readonly string[]>, pageOf: (doc: string) => number = () => 1) =>
  new Map([...self].map(([doc, tags]) => [doc, new Map(tags.map((t) => [t, [pageOf(doc)]]))]));

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
    const audit = auditOpcBoxes(rows, self, names, undefined, onPage(self, (d) => ({ a: 3, b: 4, c: 5 } as Record<string, number>)[d]));
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
    const audit = auditOpcBoxes(rows, self, new Map([["a", "SH3.pdf"], ["b", "SH4.pdf"]]), undefined, onPage(self));
    expect(audit.unreturned).toEqual([]);
    expect(audit.noRef).toEqual([]);
    expect(audit.unpaired).toEqual([{ box: "14", from: "SH3.pdf", to: "SH4.pdf", toId: "b", line: OPC_LINE_EXAMPLE }]);
  });

  // Fix pass: the destination is read BY POSITION, so a site's own numbering
  // can never turn a connector into a broken one.
  const one = (raw: string, self: Array<[string, string[]]> = []) => auditOpcBoxes(
    [{ document_id: "a", page: 1, tag: parseOpcBoxes(raw)[0] ?? "1", raw }],
    new Map(self), new Map([["a", "A.pdf"], ["b", "B.pdf"]]), undefined, onPage(new Map(self)),
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
    undefined, onPage(new Map([["a", selfA], ["b", selfB]])),
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
    // A sheet named by the connector is never checked against a document
    // that did not declare it: which of its pages is sheet 2 is not known.
    // Unpaired — never unreturned, and never dropped (review fix pass 7:
    // dropped, the source passed, settled).
    const set = pair(raw, [], ["4410-01-001"], ["3"]);
    expect(set.unreturned).toEqual([]);
    expect(set.unpaired).toEqual([expect.objectContaining({
      box: "7", to: "B.pdf", why: "no page of it declares sheet 2, so which of its pages is the sheet named is not known",
    })]);
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
      ], self, names, undefined, onPage(self));
      expect(audit.unreturned, raw).toEqual([]);
      expect(audit.unpaired, raw).toEqual([]);
      expect(audit.noRef, raw).toEqual([]);
      // A's verdict depends on B's box numbers — never on C's.
      expect(audit.targetsByDoc.get("a"), raw).toEqual(["b"]);
      // …and a missing box on the sheet the field DOES name is still caught.
      const missing = auditOpcBoxes([
        { document_id: "a", page: 1, tag: "14", raw },
        { document_id: "b", page: 1, tag: "7", raw: "OPC 7: DWG 025-PID-0199 — TO V-1402" },
      ], self, names, undefined, onPage(self));
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
    const pages = onPage(self);
    const partly = auditOpcBoxes(rows, self, names, new Map([["b", "page(s) 2 never read"]]), pages);
    expect(partly.unreturned).toEqual([]);
    expect(partly.noRef).toEqual([]);
    expect(partly.unpaired).toEqual([{ box: "14", from: "025-PID-0104.pdf", to: "025-PID-0105.pdf", toId: "b", line, unread: "page(s) 2 never read" }]);
    // The verdict still depends on 0105: re-judged once it is read whole.
    expect(partly.targetsByDoc.get("a")).toEqual(["b"]);
    // Read whole and still without box 14: that one is unreturned.
    expect(auditOpcBoxes(rows, self, names, undefined, pages).unreturned).toEqual([expect.objectContaining({ box: "14", to: "025-PID-0105.pdf" })]);
    // A box that IS on what was read pairs, whole or not.
    const found = auditOpcBoxes([...rows, { document_id: "b", page: 1, tag: "14", raw: "OPC 14: DWG 025-PID-0104 — FROM V-1401" }],
      self, names, new Map([["b", "page(s) 2 never read"]]), pages);
    expect(found.unpaired).toEqual([]);
    expect(found.unreturned).toEqual([]);
    // No box numbers read at all on a sheet not read whole: unpaired, with why.
    expect(auditOpcBoxes([rows[0]], self, names, new Map([["b", "its indexing failed"]]), pages).unpaired)
      .toEqual([expect.objectContaining({ box: "14", unread: "its indexing failed" })]);
  });

  // Review fix pass 5: box numbers are read page by page — AI vision reads
  // only the pages that need it, a text layer prints a pennant, never a box
  // token. Pooled per document, a combined PDF with one vision-read page
  // looked box-complete on every page, and a correctly drafted connector into
  // its text-layer page was filed `unreturned` — recorded broken_connectors.
  it("a box pairs on the SHEET its connector names: a combined PDF's text-layer page is never box-complete because another page was vision-read (review fix pass 5)", () => {
    const line = "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402";
    const self = new Map([
      ["a", ["025-PID-0104", "025-PID-0104-SH1"]],
      // b: page 1 declares 0105 from a TrueType text layer (no box rows);
      // page 2 (0106) is SHX, read by AI vision, with box 3.
      ["b", ["025-PID-0105", "025-PID-0105-SH1", "025-PID-0106", "025-PID-0106-SH1"]],
    ]);
    const pages = new Map([
      ["a", new Map([["025-PID-0104", [1]], ["025-PID-0104-SH1", [1]]])],
      ["b", new Map([["025-PID-0105", [1]], ["025-PID-0105-SH1", [1]], ["025-PID-0106", [2]], ["025-PID-0106-SH1", [2]]])],
    ]);
    const names = new Map([["a", "025-PID-0104.pdf"], ["b", "combined.pdf"]]);
    const src = { document_id: "a", page: 1, tag: "14", raw: line };
    const box = (page: number, tag: string) => ({ document_id: "b", page, tag, raw: `OPC ${tag}: DWG 025-PID-0199 — TO V-${tag}` });

    // The reviewer's probe: page 1's box numbers were never read.
    const probe = auditOpcBoxes([src, box(2, "3")], self, names, undefined, pages);
    expect(probe.unreturned).toEqual([]);
    expect(probe.noRef).toEqual([]);
    expect(probe.unpaired).toEqual([{
      box: "14", from: "025-PID-0104.pdf", to: "combined.pdf", toId: "b", line,
      why: "page 1 of it is the sheet named, and no box numbers were read there",
    }]);
    expect(probe.targetsByDoc.get("a")).toEqual(["b"]);
    // Page 1 read with its boxes, 14 among them: paired.
    expect(auditOpcBoxes([src, box(1, "14"), box(2, "3")], self, names, undefined, pages).unpaired).toEqual([]);
    // Page 1's boxes read without 14 — and 14 stands on page 2, ANOTHER
    // sheet (0106): it does not come back on the sheet named.
    const other = auditOpcBoxes([src, box(1, "7"), box(2, "14")], self, names, undefined, pages);
    expect(other.unreturned).toEqual([expect.objectContaining({ box: "14", to: "combined.pdf" })]);
    expect(other.unpaired).toEqual([]);
    // 14 on a page that declares no number at all: that page may be the
    // sheet named — unpaired, never unreturned.
    const blind = auditOpcBoxes([src, box(1, "7"), box(3, "14")], self, names, undefined, pages);
    expect(blind.unreturned).toEqual([]);
    expect(blind.unpaired).toEqual([expect.objectContaining({
      box: "14", why: "box 14 stands on page 3 of it, whose drawing number was not read, and that page may be the sheet named",
    })]);
    // A bare number declared on several pages (one multi-sheet drawing in one
    // PDF): every page that is it must have had its boxes read.
    const set = new Map([["a", ["025-PID-0104"]], ["b", ["2002-D-2001"]]]);
    const setPages = new Map([["a", new Map([["025-PID-0104", [1]]])], ["b", new Map([["2002-D-2001", [1, 2]]])]]);
    const toSet = { document_id: "a", page: 1, tag: "14", raw: "OPC 14: DWG 2002-D-2001 — TO V-1402" };
    expect(auditOpcBoxes([toSet, box(1, "7")], set, names, undefined, setPages).unpaired)
      .toEqual([expect.objectContaining({ box: "14", why: "page 2 of it is the sheet named, and no box numbers were read there" })]);
    expect(auditOpcBoxes([toSet, box(1, "7"), box(2, "9")], set, names, undefined, setPages).unreturned)
      .toEqual([expect.objectContaining({ box: "14" })]);
    expect(auditOpcBoxes([toSet, box(1, "7"), box(2, "14")], set, names, undefined, setPages).unreturned).toEqual([]);
    // Without the pages, which page is the sheet is not known: never unreturned.
    const unknown = auditOpcBoxes([src, box(1, "7")], self, names);
    expect(unknown.unreturned).toEqual([]);
    expect(unknown.unpaired).toEqual([expect.objectContaining({ box: "14", why: "which of its pages is the sheet named is not known" })]);
  });

  // Review fix pass 6, the reviewer's probe F: 0105 is a two-page PDF of one
  // drawing. Page 1 was read by AI vision (title block, box 7); page 2 was
  // indexed text-only (a keyless or over-cap driver): no title block, no box
  // numbers. A connector that names the drawing, not a sheet, may continue
  // on page 2.
  it("a connector naming no sheet is never unreturned while a page of its destination declares no number and had no box numbers read", () => {
    const self = new Map([["a", ["025-PID-0104"]], ["b", ["025-PID-0105", "025-PID-0105-SH1"]]]);
    const pages = new Map([
      ["a", new Map([["025-PID-0104", [1]]])],
      ["b", new Map([["025-PID-0105", [1]], ["025-PID-0105-SH1", [1]]])],
    ]);
    const names = new Map([["a", "025-PID-0104.pdf"], ["b", "025-PID-0105.pdf"]]);
    const bare = { document_id: "a", page: 1, tag: "14", raw: "OPC 14: DWG 025-PID-0105 — TO V-1402" };
    const box7 = { document_id: "b", page: 1, tag: "7", raw: "OPC 7: DWG 025-PID-0199 — TO V-7" };
    const two = new Map([["a", 1], ["b", 2]]);
    const probe = auditOpcBoxes([bare, box7], self, names, undefined, pages, { pageCounts: two });
    expect(probe.unreturned).toEqual([]);
    expect(probe.unpaired).toEqual([{
      box: "14", from: "025-PID-0104.pdf", to: "025-PID-0105.pdf", toId: "b", line: bare.raw,
      why: "page 2 of it declares no drawing number and no box numbers were read there — it may be the sheet named",
    }]);
    // Page 2's boxes read (vision read it, its title block unread) without 14:
    // it is not there — unreturned, where every page of the drawing was read.
    const read2 = { document_id: "b", page: 2, tag: "9", raw: "OPC 9: DWG 025-PID-0199 — TO V-9" };
    expect(auditOpcBoxes([bare, box7, read2], self, names, undefined, pages, { pageCounts: two }).unreturned)
      .toEqual([expect.objectContaining({ box: "14" })]);
    // A one-page document: nothing else it could be on.
    expect(auditOpcBoxes([bare, box7], self, names, undefined, pages, { pageCounts: new Map([["b", 1]]) }).unreturned)
      .toEqual([expect.objectContaining({ box: "14" })]);
    // A connector that names SHEET 1, declared on page 1: page 2 is not it.
    const sh1 = { ...bare, raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" };
    expect(auditOpcBoxes([sh1, box7], self, names, undefined, pages, { pageCounts: two }).unreturned)
      .toEqual([expect.objectContaining({ box: "14" })]);
  });

  // Review fix pass 6, the reviewer's probes C and D: a rebuild resets 0105
  // (its rows cleared, queued). No document declares 025-PID-0105 any more,
  // so the connector resolved to nothing and was dropped — the sheet passed,
  // settled, over a recorded broken_connectors.
  it("a connector whose destination no document declares, while a document still being read may hold it, is unpaired and names it", () => {
    const self = new Map([["a", ["025-PID-0104", "025-PID-0104-SH1"]]]);
    const names = new Map([["a", "025-PID-0104.pdf"], ["b", "025-PID-0105.pdf"], ["c", "040-TK-0001.pdf"]]);
    const pages = new Map([["a", new Map([["025-PID-0104", [1]], ["025-PID-0104-SH1", [1]]])]]);
    const line = "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402";
    const rows = [{ document_id: "a", page: 1, tag: "14", raw: line }];
    const reset = auditOpcBoxes(rows, self, names, new Map([["b", "not finished indexing"]]), pages, { inProgress: new Set(["b"]) });
    expect(reset.unreturned).toEqual([]);
    expect(reset.unpaired).toEqual([{
      box: "14", from: "025-PID-0104.pdf", to: "025-PID-0105-SH1", line, maybeInIds: ["b"],
      why: "no sheet in the set declares it yet, and it may be in 025-PID-0105.pdf (not finished indexing), not read whole yet",
    }]);
    // Any document still being read may hold a destination in the set's
    // scope — whatever its filename says.
    expect(auditOpcBoxes(rows, self, names, new Map([["c", "not finished indexing"]]), pages, { inProgress: new Set(["c"]) }).unpaired)
      .toEqual([expect.objectContaining({ box: "14", maybeInIds: ["c"] })]);
    // Nothing still being read: the destination is outside the library — no
    // box finding (the reference audit says missing or out of scope).
    expect(auditOpcBoxes(rows, self, names, undefined, pages).unpaired).toEqual([]);
    // A destination outside the set's scope (another unit) waits only on a
    // document whose number is not read yet, which may be anything.
    const elsewhere = [{ document_id: "a", page: 1, tag: "15", raw: "OPC 15: DWG 077-PID-0001 — TO V-1" }];
    expect(auditOpcBoxes(elsewhere, self, names, new Map([["b", "not finished indexing"]]), pages, { inProgress: new Set(["b"]) }).unpaired).toEqual([]);
    const scanNames = new Map([...names, ["s", "scan_002.pdf"]]);
    expect(auditOpcBoxes(elsewhere, self, scanNames, new Map([["s", "not finished indexing"]]), pages, { inProgress: new Set(["s"]) }).unpaired)
      .toEqual([expect.objectContaining({ box: "15", maybeInIds: ["s"] })]);
  });

  it("a reference back, or a sheet, not found on a sheet not read whole is unchecked — never one-way, never a gap (review fix pass 4)", () => {
    const docs = [{ id: "a", name: "025-PID-0104.pdf" }, { id: "b", name: "025-PID-0105.pdf" }];
    const self = new Map([["a", ["025-PID-0104"]], ["b", ["025-PID-0105", "025-PID-0105-SH1"]]]);
    // 0104 points at 0105 (SH1 read) and at 0105 SH2 (its page never read),
    // at 025-PID-0199, which is not in the library at all, and at 040-TK-0009
    // (a series 0105 declares nothing of; 040-TK is held through t1/t2).
    const withTk = [...docs, { id: "t1", name: "040-TK-0001.pdf" }, { id: "t2", name: "040-TK-0002.pdf" }];
    const refs = new Map([["a", ["025-PID-0105", "025-PID-0105-SH2", "025-PID-0199", "040-TK-0009"]]]);
    const unread = new Map([["b", "page(s) 2 never read"]]);
    // 0105 still being READ (parked on AI vision): what it has declared so far
    // says nothing about its unread page — a combined PDF of several series,
    // or a file named for something else, may stand there. Every sheet the set
    // is missing may be on it: no gap until it is read (review fix pass 6 —
    // fix pass 5 filed 040-TK-0009 a settled gap here, never lowered once the
    // page turned out to hold it).
    const reading = auditDrawingRefs(withTk, refs, self, null, unread, new Set(["b"]));
    expect(reading.oneWay).toEqual([]);
    expect(reading.oneWayUnread).toEqual([{ from: "025-PID-0104.pdf", to: "025-PID-0105.pdf", toId: "b", count: 1, unread: "page(s) 2 never read" }]);
    expect(reading.missingInSeries).toEqual([]);
    expect(reading.missingUnread.find((m) => m.ref === "025-PID-0105-SH2")).toEqual({
      ref: "025-PID-0105-SH2", referencedBy: ["025-PID-0104.pdf"], referencedByAll: ["025-PID-0104.pdf"], count: 1,
      maybeIn: ["025-PID-0105.pdf (page(s) 2 never read)"], maybeInIds: ["b"],
    });
    expect(reading.missingUnread.map((m) => [m.ref, m.maybeInIds]).sort()).toEqual([
      ["025-PID-0105-SH2", ["b"]], ["025-PID-0199", ["b"]], ["040-TK-0009", ["b"]],
    ]);
    // 0105 an accepted partial index — settled: it changes only when a person
    // acts. One drawing's file holds only that drawing's sheets: 0105 SH2 is
    // unchecked; 0199 and 040-TK-0009 are gaps (review fix pass 6 — fix pass
    // 5 let any one-drawing file stand for its whole series, so one accepted
    // partial index silenced every gap in 025-PID for good).
    const settled = auditDrawingRefs(withTk, refs, self, null, unread);
    expect(settled.oneWayUnread).toEqual(reading.oneWayUnread);
    expect(settled.missingInSeries.map((m) => m.ref).sort()).toEqual(["025-PID-0199", "040-TK-0009"]);
    expect(settled.missingUnread.map((m) => m.ref)).toEqual(["025-PID-0105-SH2"]);
    // A settled combined PDF — two or more different drawings declared — may
    // hold any drawing of a series it declares: 0199 unchecked; 040-TK a gap.
    const combinedSelf = new Map([["a", ["025-PID-0104"]], ["b", ["025-PID-0105", "025-PID-0105-SH1", "025-PID-0106"]]]);
    const combined = auditDrawingRefs(withTk, refs, combinedSelf, null, unread);
    expect(combined.missingInSeries.map((m) => m.ref)).toEqual(["040-TK-0009"]);
    expect(combined.missingUnread.map((m) => m.ref).sort()).toEqual(["025-PID-0105-SH2", "025-PID-0199"]);
    // Read whole: the same references are one-way and missing, as before.
    const whole = auditDrawingRefs(withTk, refs, self);
    expect(whole.oneWay).toEqual([{ from: "025-PID-0104.pdf", to: "025-PID-0105.pdf", count: 1 }]);
    expect(whole.missingInSeries.map((m) => m.ref).sort()).toEqual(["025-PID-0105-SH2", "025-PID-0199", "040-TK-0009"]);
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

  // Review fix pass 6, the reviewer's probe A: a combined PDF holding two
  // series is reset by a rebuild and has re-read only its 026-PID page. The
  // 025-PID sheet it holds on its next page is not declared by anyone yet.
  it("a document still being read may hold a sheet of a series it has not declared yet — or under a filename that names something else", () => {
    const docs = [
      { id: "a", name: "025-PID-0104.pdf" }, { id: "b", name: "025-PID-0106.pdf" }, { id: "x", name: "Unit PIDs.pdf" },
    ];
    const self = new Map([["a", ["025-PID-0104"]], ["b", ["025-PID-0106"]], ["x", ["026-PID-0201"]]]);
    const refs = new Map([["a", ["025-PID-0105"]]]);
    const mid = auditDrawingRefs(docs, refs, self, null, new Map([["x", "not finished indexing"]]), new Set(["x"]));
    expect(mid.missingInSeries).toEqual([]);
    expect(mid.missingUnread).toEqual([expect.objectContaining({ ref: "025-PID-0105", maybeInIds: ["x"] })]);
    // A rebuild-reset document named for an unrelated number holds it too.
    const named = auditDrawingRefs([...docs.slice(0, 2), { id: "x", name: "040-TK-0001.pdf" }], refs,
      new Map([["a", ["025-PID-0104"]], ["b", ["025-PID-0106"]]]), null, new Map([["x", "not finished indexing"]]), new Set(["x"]));
    expect(named.missingUnread.map((m) => m.maybeInIds)).toEqual([["x"]]);
    // A library being indexed has many such documents: every one may hold it
    // (all their ids kept, for the record to wait on), named to six.
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, name: `upload_${i}.pdf` }));
    const busy = auditDrawingRefs([...docs, ...many], refs, self, null,
      new Map(many.map((d) => [d.id, "not finished indexing"])), new Set(many.map((d) => d.id)));
    expect(busy.missingUnread[0].maybeInIds).toEqual(many.map((d) => d.id));
    expect(busy.missingUnread[0].maybeIn).toHaveLength(7);
    expect(busy.missingUnread[0].maybeIn[6]).toBe("2 more document(s) not read whole");
    // Without the in-progress set (the same document settled), it holds only
    // what it declares: a gap.
    expect(auditDrawingRefs(docs, refs, self, null, new Map([["x", "page(s) 2 never read"]])).missingInSeries.map((m) => m.ref))
      .toEqual(["025-PID-0105"]);
  });

  // Review fix pass 7, the reviewer's probe "parked": a numbered single-
  // drawing PDF parked on AI vision (the monthly cap: until next month)
  // held ANY missing sheet under fix pass 6, so a real 040-TK gap waited on
  // it for as long as it stayed parked.
  it("a parked document whose number is declared holds by the settled rule — only one in flight may hold any sheet (review fix pass 7)", () => {
    const docs = [
      { id: "t1", name: "040-TK-0001.pdf" }, { id: "t2", name: "040-TK-0002.pdf" }, { id: "p", name: "025-PID-0107.pdf" },
    ];
    const self = new Map([["t1", ["040-TK-0001"]], ["t2", ["040-TK-0002"]], ["p", ["025-PID-0107", "025-PID-0107-SH1"]]]);
    const refs = new Map([["t1", ["040-TK-0009", "025-PID-0107-SH2"]]]);
    const parked = new Map([["p", "page(s) 2 never read"]]);
    // Not in flight (the route leaves it out: its title block was read and
    // its unread page is known): 040-TK-0009 is a gap; its own drawing's
    // sheet is unchecked, and waits on it.
    const settled = auditDrawingRefs(docs, refs, self, null, parked, new Set());
    expect(settled.missingInSeries.map((m) => m.ref)).toEqual(["040-TK-0009"]);
    expect(settled.missingUnread.map((m) => [m.ref, m.maybeInIds])).toEqual([["025-PID-0107-SH2", ["p"]]]);
    // In flight (reset by a rebuild, nothing declared): it may hold any.
    const reset = auditDrawingRefs(docs, refs, new Map([...self].filter(([k]) => k !== "p")), null,
      new Map([["p", "not finished indexing"]]), new Set(["p"]));
    expect(reset.missingInSeries).toEqual([]);
    expect(reset.missingUnread.map((m) => m.ref).sort()).toEqual(["040-TK-0009"]);
  });

  // Review fix pass 7, the reviewer's probe "failed": a rebuild reset 0105
  // and its re-index then FAILED. No document declares 025-PID-0105, and the
  // failed document is not in flight, so fix pass 6 found no holder: the
  // connector was dropped and the source filed a settled passed.
  it("a connector into a destination whose title block a failed re-index cleared is unpaired and names that document (review fix pass 7)", () => {
    const self = new Map([["a", ["025-PID-0104", "025-PID-0104-SH1"]]]);
    const pages = new Map([["a", new Map([["025-PID-0104", [1]], ["025-PID-0104-SH1", [1]]])]]);
    const line = "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402";
    const rows = [{ document_id: "a", page: 1, tag: "14", raw: line }];
    const failed = new Map([["b", "its indexing failed"]]);
    const names = new Map([["a", "025-PID-0104.pdf"], ["b", "025-PID-0105.pdf"]]);
    const probe = auditOpcBoxes(rows, self, names, failed, pages, { inProgress: new Set(), forNow: new Set(["b"]) });
    expect(probe.unreturned).toEqual([]);
    expect(probe.unpaired).toEqual([{
      box: "14", from: "025-PID-0104.pdf", to: "025-PID-0105-SH1", line, maybeInIds: ["b"],
      why: "no sheet in the set declares it yet, and it may be in 025-PID-0105.pdf (its indexing failed), not read whole yet",
    }]);
    // Named for another drawing: a failed one-drawing file does not hold it.
    const other = new Map([["a", "025-PID-0104.pdf"], ["b", "025-PID-0199.pdf"]]);
    expect(auditOpcBoxes(rows, self, other, failed, pages, { inProgress: new Set(), forNow: new Set(["b"]) }).unpaired).toEqual([]);
    // Its number never read (no title block, none in its filename): any
    // destination in the set's scope — never one in another unit.
    const scan = new Map([["a", "025-PID-0104.pdf"], ["b", "scan_004.pdf"]]);
    expect(auditOpcBoxes(rows, self, scan, failed, pages, { inProgress: new Set(), forNow: new Set(["b"]) }).unpaired)
      .toEqual([expect.objectContaining({ box: "14", maybeInIds: ["b"] })]);
    const elsewhere = [{ document_id: "a", page: 1, tag: "15", raw: "OPC 15: DWG 077-PID-0001 — TO V-1" }];
    expect(auditOpcBoxes(elsewhere, self, scan, failed, pages, { inProgress: new Set(), forNow: new Set(["b"]) }).unpaired).toEqual([]);
    // Several may hold it: the one named for it comes first, the rest counted.
    const crowd = new Map([...names, ...Array.from({ length: 5 }, (_, i) => [`u${i}`, `upload_${i}.pdf`] as [string, string])]);
    const reading = new Set(["b", "u0", "u1", "u2", "u3", "u4"]);
    const busy = auditOpcBoxes(rows, self, crowd, new Map([...reading].map((id) => [id, "not finished indexing"])), pages,
      { inProgress: reading });
    expect(busy.unpaired[0].maybeInIds).toEqual(["b", "u0", "u1", "u2", "u3", "u4"]);
    expect(busy.unpaired[0].why).toBe(
      "no sheet in the set declares it yet, and it may be in 025-PID-0105.pdf (not finished indexing); upload_0.pdf (not finished indexing); " +
      "upload_1.pdf (not finished indexing); upload_2.pdf (not finished indexing) or 2 more document(s), not read whole yet");
  });

  // Review fix pass 7, the reviewer's minor: a connector naming SH n of a
  // loaded drawing whose sheet n no title block declares was dropped (the
  // probe-F fix covered only a connector naming no sheet).
  it("a connector naming a sheet no title block declares, of a drawing one document declares, is unpaired — never dropped (review fix pass 7)", () => {
    const self = new Map([["a", ["025-PID-0104"]], ["b", ["025-PID-0105"]]]);
    const pages = new Map([["a", new Map([["025-PID-0104", [1]]])], ["b", new Map([["025-PID-0105", [1]]])]]);
    const names = new Map([["a", "025-PID-0104.pdf"], ["b", "025-PID-0105.pdf"]]);
    const line = "OPC 14: DWG 025-PID-0105 SH 2 — TO V-1402";
    const rows = [
      { document_id: "a", page: 1, tag: "14", raw: line },
      { document_id: "b", page: 1, tag: "7", raw: "OPC 7: DWG 025-PID-0199 — TO V-7" },
    ];
    // The reviewer's case: page 2 of 0105 indexed text-only.
    const probe = auditOpcBoxes(rows, self, names, undefined, pages, { pageCounts: new Map([["a", 1], ["b", 2]]) });
    expect(probe.unreturned).toEqual([]);
    expect(probe.unpaired).toEqual([{
      box: "14", from: "025-PID-0104.pdf", to: "025-PID-0105.pdf", toId: "b", line,
      why: "no page of it declares sheet 2, so which of its pages is the sheet named is not known",
    }]);
    expect(probe.targetsByDoc.get("a")).toEqual(["b"]);
    // Not read whole: unpaired with why, and the record waits on it.
    const parked = auditOpcBoxes(rows, self, names, new Map([["b", "page(s) 2 never read"]]), pages, { pageCounts: new Map([["b", 2]]) });
    expect(parked.unpaired).toEqual([expect.objectContaining({ box: "14", toId: "b", unread: "page(s) 2 never read" })]);
    // Every page of 0105 declares a sheet of it, and none is sheet 2: sheet 2
    // is not in that document — no box finding there (the reference audit
    // says missing).
    const perSheet = new Map([["a", ["025-PID-0104"]], ["b", ["025-PID-0105", "025-PID-0105-SH1"]]]);
    const perSheetPages = new Map([["a", new Map([["025-PID-0104", [1]]])], ["b", new Map([["025-PID-0105", [1]], ["025-PID-0105-SH1", [1]]])]]);
    expect(auditOpcBoxes(rows, perSheet, names, undefined, perSheetPages, { pageCounts: new Map([["b", 1]]) }).unpaired).toEqual([]);
    // Two documents declare the drawing: which holds sheet 2 is not guessed.
    const twoOwners = new Map([...self, ["c", ["025-PID-0105"]]]);
    expect(auditOpcBoxes(rows, twoOwners, new Map([...names, ["c", "025-PID-0105 copy.pdf"]]), undefined,
      new Map([...pages, ["c", new Map([["025-PID-0105", [1]]])]]), { pageCounts: new Map([["b", 2], ["c", 2]]) }).unpaired).toEqual([]);
  });

  // Review fix pass 7, the reviewer's perf probe: fix pass 6 re-checked the
  // set's scope for every document in flight, for every connector — 11.5 s
  // for 600 sheets mid-rebuild, 28 s for 1,000 (the route's limit is 60 s).
  it("pairing a large library mid-rebuild stays fast (review fix pass 7)", () => {
    const N = 600;
    const self = new Map<string, string[]>();
    const pages = new Map<string, Map<string, number[]>>();
    const names = new Map<string, string>();
    const rows: Array<{ document_id: string; page: number; tag: string; raw: string }> = [];
    const reading = new Set<string>();
    const incomplete = new Map<string, string>();
    const num = (i: number) => `025-PID-${String(1000 + i).padStart(4, "0")}`;
    for (let i = 0; i < N; i++) {
      const id = `d${i}`;
      names.set(id, `${num(i)}.pdf`);
      if (i < N / 2) {
        self.set(id, [num(i), `${num(i)}-SH1`]);
        pages.set(id, new Map([[num(i), [1]], [`${num(i)}-SH1`, [1]]]));
        for (let k = 0; k < 10; k++) {
          rows.push({ document_id: id, page: 1, tag: String(k + 1), raw: `OPC ${k + 1}: DWG ${num((i + 300 + k) % N)} SH 1 — TO V-${i}` });
        }
      } else { reading.add(id); incomplete.set(id, "not finished indexing"); }
    }
    const run = () => auditOpcBoxes(rows, self, names, incomplete, pages, {
      pageCounts: new Map([...names.keys()].map((k) => [k, 1])), inProgress: reading,
    });
    // The faster of two runs: a parallel suite's load is not the code's cost.
    let ms = Number.POSITIVE_INFINITY;
    let audit = run();
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      audit = run();
      ms = Math.min(ms, performance.now() - t0);
    }
    expect(audit.unreturned).toEqual([]);
    expect(audit.unpaired.length).toBeGreaterThan(2900);
    // The document named for the destination is named first.
    const first = audit.unpaired.find((u) => u.to === `${num(300)}-SH1`)!;
    expect(first.maybeInIds![0]).toBe("d300");
    expect(ms).toBeLessThan(1000);
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
