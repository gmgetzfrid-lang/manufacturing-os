import { describe, it, expect } from "vitest";
import { parseFilename } from "@/lib/filenameParser";
import { legacyParseFilename } from "@/lib/filenameParserLegacy";

const p = (n: string) => { const r = parseFilename(n); return [r.documentNumber, r.title, r.rev]; };

describe("parseFilename", () => {
  it("reads 'NUMBER - Title' names whole, with no fake date or revision", () => {
    expect(p("EP 5-3-10 - Ball Valves.pdf")).toEqual(["EP 5-3-10", "Ball Valves", "0"]);
    expect(p("EP 5-3-10 - Relief Valves.pdf")).toEqual(["EP 5-3-10", "Relief Valves", "0"]);
    expect(p("EP 12-1-04 – Review of Rotating Equipment.pdf")).toEqual(["EP 12-1-04", "Review of Rotating Equipment", "0"]);
    expect(p("EP 5-3-10 - Ball Valves Rev 2.pdf")).toEqual(["EP 5-3-10", "Ball Valves", "2"]);
    expect(p("EP 5-3-10 R3 - Ball Valves.pdf")).toEqual(["EP 5-3-10", "Ball Valves", "3"]);
  });
  it("keeps the drawing patterns it always handled", () => {
    expect(p("100-PID-001_R7.pdf").slice(0, 1).concat(parseFilename("100-PID-001_R7.pdf").rev)).toEqual(["100-PID-001", "7"]);
    expect(parseFilename("200-PID-001_R02.pdf")).toMatchObject({ documentNumber: "200-PID-001", rev: "02" });
    expect(parseFilename("2002-D-2001_SHT01_R38.pdf")).toMatchObject({ documentNumber: "2002-D-2001", rev: "38", hints: { sheet: "01" } });
    expect(parseFilename("200-ISO-014_RevA.pdf")).toMatchObject({ documentNumber: "200-ISO-014", rev: "A", hints: { type: "Isometric" } });
    expect(parseFilename("Unit_100_East_PID.pdf").hints).toMatchObject({ unit: "100", type: "P&ID" });
  });
  it("words that merely start with r/rev are not revisions", () => {
    for (const n of ["Pump Relief Report.pdf", "Revised Layout.pdf", "Review Notes.pdf", "Area Roof Plan.pdf"]) {
      expect(parseFilename(n).rev).toBe("0");
    }
    expect(parseFilename("Pump Relief Report.pdf").documentNumber).toBe("Pump Relief Report");
  });
  it("cuts only unmistakable dates", () => {
    expect(parseFilename("100-PID-001 2024-03-15.pdf")).toMatchObject({ documentNumber: "100-PID-001", hints: { datestamp: "2024-03-15" } });
    expect(parseFilename("SOP 4-2-11.pdf")).toMatchObject({ documentNumber: "SOP 4-2-11" });
  });
  it("never returns an empty number or title", () => {
    const r = parseFilename("R2.pdf");
    expect(r.documentNumber).toBeTruthy();
    expect(r.title).toBeTruthy();
  });
});

describe("legacyParseFilename (what the old reader produced)", () => {
  it("reproduces the old faults, so the repair can recognise them", () => {
    expect(legacyParseFilename("EP 5-3-10 - Relief Valves.pdf")).toEqual({ documentNumber: "EP  - Valves", title: "EP 5-3-10 - Relief Valves", rev: "elief" });
    expect(legacyParseFilename("EP 5-3-10 - Ball Valves.pdf").documentNumber).toBe("EP  - Ball Valves");
  });
});

import { planNameFix } from "@/lib/documentNames";

describe("planNameFix", () => {
  const doc = (file: string, over: Partial<{ document_number: string; title: string; rev: string }> = {}) => {
    const old = legacyParseFilename(file);
    return { id: "d1", name: file, document_number: old.documentNumber, title: old.title, rev: old.rev, ...over };
  };
  it("corrects what the old reader produced", () => {
    const fix = planNameFix(doc("EP 5-3-10 - Relief Valves.pdf"));
    expect(fix?.to).toEqual({ documentNumber: "EP 5-3-10", title: "Relief Valves", rev: "0" });
  });
  it("corrects numbers an upload suffixed to dodge a clash", () => {
    const fix = planNameFix(doc("EP 5-3-10 - Ball Valves.pdf", { document_number: "EP  - Ball Valves-2" }));
    expect(fix?.to.documentNumber).toBe("EP 5-3-10");
  });
  it("never touches what a person typed", () => {
    expect(planNameFix(doc("EP 5-3-10 - Relief Valves.pdf", { document_number: "EP-5310", rev: "B", title: "Relief valves (typed)" }))).toBeNull();
    const fix = planNameFix(doc("EP 5-3-10 - Relief Valves.pdf", { title: "My title" }));
    expect(fix?.to.title).toBe("My title");
  });
  it("leaves names the old reader got right", () => {
    expect(planNameFix(doc("100-PID-001_R7.pdf"))).toBeNull();
    expect(planNameFix(doc("200-ISO-014_RevA.pdf"))).toBeNull();
  });
});

describe("drawing-set file names with an export date", () => {
  it("drops the _MM-DD-YY stamp, keeps the drawing number", () => {
    const r = parseFilename("2002-D_1001_CRUDE_UNIT_09-14-26.pdf");
    expect(r.hints.datestamp).toBe("09-14-26");
    expect(r.documentNumber).toBe("2002-D_1001_CRUDE_UNIT");
    expect(parseFilename("3502-D_1085_PLATFORMER_08-19-26.pdf").documentNumber).toBe("3502-D_1085_PLATFORMER");
  });
  it("the name repair leaves these alone (the old reader already got them right)", () => {
    const file = "2002-D_1001_CRUDE_UNIT_09-14-26.pdf";
    const old = legacyParseFilename(file);
    expect(planNameFix({ id: "d", name: file, document_number: old.documentNumber, title: old.title, rev: old.rev })).toBeNull();
  });
  it("unpadded a-b-c is still a number, not a date", () => {
    expect(parseFilename("SOP_5-3-10.pdf").documentNumber).toBe("SOP_5-3-10");
  });
});
