import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/r2", () => ({ r2: {}, R2_BUCKET: "x" }));
import { findRunningKey } from "@/lib/sectionTemplate";

const book = (header: (key: string, page: number, n: number) => string, plan: Array<[string, number]>) => {
  const pages: Array<{ page: number; text: string }> = [];
  let p = 1;
  for (const [key, count] of plan) {
    for (let i = 0; i < count; i++, p++) {
      pages.push({ page: p, text: `${header(key, p, count)}\nPIPE A106 Gr B SMLS Sch 80 ${p}\nFLANGE A105 RF WN` });
    }
  }
  return pages;
};

describe("findRunningKey — any company's spec book", () => {
  it("one company's format: code in parentheses mid-line", () => {
    const pages = book((k) => `Kern Energy - (${k}) - Piping Database Revision Number: 99.0 - August 2023`,
      [["FAAA1G", 5], ["FCAF1GL", 4], ["FSFKAG", 6]]);
    const r = findRunningKey(pages)!;
    expect(r.ranges).toEqual([
      { key: "FAAA1G", first: 1, last: 5 },
      { key: "FCAF1GL", first: 6, last: 9 },
      { key: "FSFKAG", first: 10, last: 15 },
    ]);
    expect(r.template).toContain("⟨key⟩");
  });
  it("another company's format: label, code, and a sheet counter on the same line", () => {
    const pages = book((k, p) => `LINE CLASS: ${k}   SHEET ${p} OF 40`, [["A1A", 3], ["B2C", 3], ["150-CS-01", 4]]);
    expect(findRunningKey(pages)!.ranges.map((r) => r.key)).toEqual(["A1A", "B2C", "150-CS-01"]);
  });
  it("a third: the key alone at the end of a title line", () => {
    const pages = book((k) => `PIPING MATERIAL SPECIFICATION ${k}`, [["CS150", 2], ["SS300", 2], ["CS600", 3]]);
    expect(findRunningKey(pages)!.ranges.map((r) => r.key)).toEqual(["CS150", "SS300", "CS600"]);
  });
  it("a page counter or a date is never taken for a section key", () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ page: i + 1, text: `EP 1-0-1 NUMERICAL INDEX Date: 05/2025\nPage: ${i + 1} of 12\nGeneral text` }));
    expect(findRunningKey(pages)).toBeNull();
  });
  it("pages without the header continue the section before them", () => {
    const pages = book((k) => `Kern Energy - (${k}) - Piping Database`, [["AAA1", 3], ["BBB2", 3]]);
    pages[1].text = "continued table\nPIPE A106";
    const r = findRunningKey(pages)!;
    expect(r.ranges[0]).toEqual({ key: "AAA1", first: 1, last: 3 });
  });
  it("a footer works as well as a header", () => {
    const pages = book(() => "", [["X", 1]]).slice(0, 0);
    let p = 1;
    for (const [k, n] of [["CS-150-A", 4], ["SS-300-B", 4], ["CS-600-C", 3]] as Array<[string, number]>) {
      for (let i = 0; i < n; i++, p++) {
        pages.push({ page: p, text: `Pipe\nA106 Gr B\nSch 40\nElbow\nA234 WPB\nFlange\nA105\nGasket\nBolting\nNotes\nACME Refining — Material Spec ${k} — Printed copies uncontrolled` });
      }
    }
    expect(findRunningKey(pages)!.ranges.map((r) => r.key)).toEqual(["CS-150-A", "SS-300-B", "CS-600-C"]);
  });
});

import { findParenKeys, findSections } from "@/lib/sectionTemplate";
import { classMentions } from "@/lib/pressureClass";

describe("books with no header line: the code is in the table headings", () => {
  // Modelled on a spec database export: one line per page (no line breaks),
  // a service line opening each class, "Heading (CODE)" before every table,
  // and notes like "(NACE)" and "(PWHT)" recurring across classes.
  const cls = (code: string, service: string, rating: string, pages: number) =>
    Array.from({ length: pages }, (_, i) => i === 0
      ? [`Service: ${service}`, `Pipe (${code}) Compcode Size Rating Description Notes 002 0.5 - 2 Class ${rating} PIPE: CS, ASTM A106 Grade B (NACE)`]
      : [`Gate Valve (${code}) Compcode Size Rating Description V01 0.5 - 2 800 CS, ASTM A105 (PWHT) Flanges (${code}) 1D1 0.5 ${rating} FLANGES: Class ${rating}, XXS 1D2 0.5 300 FLANGES: Class 300 note 106`]);
  const book = [
    ...cls("AAAA1", "Hydrocarbons and/or Hydrogen Rich Service, Nitrogen", "150", 3),
    ...cls("AAAC2H", "Hydrocarbon and/or Hydrogen Rich Service, Sour Service (200 BHN MAX)", "150", 4),
    ...cls("FAAA1", "Hydrocarbon, high pressure", "1500", 3),
    ...cls("BCDA1L", "Hot oil", "300", 2),
  ].map((parts, i) => ({ page: i + 1, parts }));
  const full = book.map((b) => ({ page: b.page, text: b.parts.join("\n") }));

  it("finds each class's pages from the codes in its headings — not from (NACE) or (PWHT)", () => {
    const r = findParenKeys(full)!;
    expect(r.ranges).toEqual([
      { key: "AAAA1", first: 1, last: 3 },
      { key: "AAAC2H", first: 4, last: 7 },
      { key: "FAAA1", first: 8, last: 10 },
      { key: "BCDA1L", first: 11, last: 12 },
    ]);
    expect(r.template).toMatch(/\(⟨key⟩\)/);
    expect(findSections(full)?.ranges.length).toBe(4);
  });

  it("each class's records: service line and the class most written on its pages", async () => {
    const { sectionRecords } = await import("@/lib/knowledgeCatalogServer");
    const byPage = new Map(book.map((b) => [b.page, b.parts]));
    const recs = sectionRecords(findParenKeys(full)!.ranges, byPage);
    const sour = recs.find((r) => r.code === "AAAC2H")!;
    expect(sour.page).toBe(4);
    expect(sour.record.service).toBe("Hydrocarbon and/or Hydrogen Rich Service, Sour Service (200 BHN MAX)");
    expect(sour.record.rating).toBe("Class 150");
    expect(recs.find((r) => r.code === "FAAA1")!.record.rating).toBe("Class 1500");
  });

  it("an opening page with only the service line belongs to the class that follows", () => {
    const pages = [
      { page: 1, text: "Service: Steam" }, { page: 2, text: "Pipe (S1A) x Flanges (S1A) y" }, { page: 3, text: "Fitting (S1A) z" },
      { page: 4, text: "Service: Sour Service (200 BHN MAX)" }, { page: 5, text: "Pipe (AAAC2H) x" }, { page: 6, text: "Valve (AAAC2H) y" },
      { page: 7, text: "Service: Cooling water" }, { page: 8, text: "Pipe (CW1) x" }, { page: 9, text: "Valve (CW1) y" },
    ];
    expect(findParenKeys(pages)!.ranges).toEqual([
      { key: "S1A", first: 1, last: 3 }, { key: "AAAC2H", first: 4, last: 6 }, { key: "CW1", first: 7, last: 9 },
    ]);
  });

  it("counts every class written on a page", () => {
    expect(classMentions("Class 150 RF, Class 150 WN, Class 300 blind, Class 3000 coupling")).toEqual([["150", 2], ["300", 1]]);
  });
});
