// Tests for the drawing-intelligence pattern layer — equipment tags,
// drawing references, census, and the missing-reference audit. These
// patterns decide what the P&ID census reports, so they're pinned here.

import { describe, it, expect } from "vitest";
import {
  isDrawingLikePage, extractEquipmentTags, extractDrawingRefs, normalizeRef,
  buildEquipmentCensus, auditDrawingRefs, equipmentRegisterCsv,
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
  it("splits refs into resolved (in library) and missing (broken)", () => {
    const docs = [
      { id: "a", name: "025-PID-0101 — Crude overhead" },
      { id: "b", name: "025-PID-0102 — Desalter" },
    ];
    const refs = new Map<string, string[]>([
      ["a", ["025-PID-0102", "025-PID-0999", "025-PID-0101"]],  // self-ref ignored
      ["b", ["025-PID-0999"]],
    ]);
    const audit = auditDrawingRefs(docs, refs);
    expect(audit.resolved).toBe(1);
    expect(audit.missing).toHaveLength(1);
    expect(audit.missing[0].ref).toBe("025-PID-0999");
    expect(audit.missing[0].count).toBe(2);
    expect(audit.missing[0].referencedBy).toHaveLength(2);
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
