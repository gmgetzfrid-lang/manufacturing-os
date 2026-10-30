// A catalog is whatever a person marked: entries are read from its text,
// by its shape — nothing here knows what the catalog is about.

import { describe, it, expect } from "vitest";
import { setRecords, codeFromName, sectionRecords } from "@/lib/catalogBooks";
import { catalogsNamedIn } from "@/lib/specSelect";

describe("a library marked as a catalog - one entry per document", () => {
  const sheet = (tag: string, body: string, size: string) =>
    `Valve Data Sheet Rev: 2 Date: 2024-01-01 Tag: ${tag} Body Material: ${body} Size: ${size} Service: Cooling water Approved By: J. Smith`;
  const docs = [
    { id: "a", name: "VDS-101 Gate valve.pdf", text: sheet("V-101", "WCB", "2 in") },
    { id: "b", name: "VDS-102 Ball valve.pdf", text: sheet("V-102", "CF8M", "4 in") },
    { id: "c", name: "VDS-103.pdf", text: sheet("V-103", "WCB", "6 in") },
  ];

  it("codes come from the file names; fields from what the sheets print", () => {
    const { entries, fields } = setRecords(docs, "Valve data sheets");
    expect(entries.map((e) => e.code)).toEqual(["VDS-101", "VDS-102", "VDS-103"]);
    expect(entries[1].record.attrs?.["Body Material"]).toBe("CF8M");
    expect(entries[0].record.service).toBe("Cooling water");
    expect(entries[0].record.catalog).toBe("Valve data sheets");
    expect(fields).toContain("Size");
  });

  it("document-control labels are not entry fields", () => {
    const { fields } = setRecords(docs);
    expect(fields).not.toContain("Rev");
    expect(fields).not.toContain("Date");
    expect(fields).not.toContain("Approved By");
  });

  it("a name with no designation is its own code", () => {
    expect(codeFromName("Cooling water sheet.pdf")).toBe("COOLING WATER SHEET");
    expect(codeFromName("1S4 Sour water.pdf")).toBe("1S4");
  });
});

describe("a document marked as a catalog - one entry per section", () => {
  it("keeps the catalog's name on every entry", () => {
    const byPage = new Map([[1, ["Coating System CS-1 Use: Buried steel Primer: Epoxy"]], [2, ["more"]], [3, ["Coating System CS-2 Use: Atmospheric Primer: Zinc"]]]);
    const recs = sectionRecords([{ key: "CS-1", first: 1, last: 2 }, { key: "CS-2", first: 3, last: 3 }], byPage, "Coating systems");
    expect(recs.map((r) => r.record.catalog)).toEqual(["Coating systems", "Coating systems"]);
    expect(recs[1].record.attrs?.Primer).toBe("Zinc");
  });
});

describe("a question names a catalog by what the team calls it", () => {
  it("matches singular and plural, whole words", () => {
    expect(catalogsNamedIn("what piping spec should I use for 150 class sour gas", ["Piping specs", "Valve data sheets"])).toEqual(["Piping specs"]);
    expect(catalogsNamedIn("which valve data sheet covers V-101", ["Piping specs", "Valve data sheets"])).toEqual(["Valve data sheets"]);
    expect(catalogsNamedIn("what spec for sour gas", ["Piping specs"])).toEqual([]);
  });
});
