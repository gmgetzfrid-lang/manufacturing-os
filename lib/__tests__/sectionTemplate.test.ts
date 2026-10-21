import { describe, it, expect } from "vitest";
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
