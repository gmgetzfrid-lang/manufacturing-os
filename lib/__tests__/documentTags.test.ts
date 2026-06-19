// lib/__tests__/documentTags.test.ts
//
// The book viewer's tag ribbon + tag search must work for ANY user-defined
// column, not just the built-in `type:"tags"`. These cover the extraction and
// the flat search index that power both.

import { describe, it, expect } from "vitest";
import {
  collectTagGroups,
  valuesForColumn,
  buildTagSearchIndex,
  indexMatches,
  rankTags,
} from "@/lib/documentTags";

describe("valuesForColumn", () => {
  it("splits arrays and multi/tags strings, keeps other scalars whole", () => {
    expect(valuesForColumn(["P-101", "P-102"], "tags")).toEqual(["P-101", "P-102"]);
    expect(valuesForColumn("A, B, C", "multi")).toEqual(["A", "B", "C"]);
    expect(valuesForColumn("Pump House, North", "text")).toEqual(["Pump House, North"]); // not split
    expect(valuesForColumn(true, "boolean")).toEqual(["Yes"]);
    expect(valuesForColumn(42, "number")).toEqual(["42"]);
    expect(valuesForColumn("", "text")).toEqual([]);
    expect(valuesForColumn(null)).toEqual([]);
  });
});

describe("collectTagGroups (column-agnostic)", () => {
  it("shows real tag columns (multi / asset-named) but excludes plain attributes", () => {
    const metadata = {
      equipment: ["E-200", "E-201"], // built-in tags
      assets: "V-9",                 // a select the user named "Assets" (name match)
      discipline: "Process",         // a plain select attribute — NOT a tag
      inspector: "jdoe",             // a user attribute — NOT a tag
      pages: 12,                     // numeric — never a chip
    };
    const columns = [
      { key: "equipment", label: "Equipment", type: "tags" },
      { key: "assets", label: "Assets", type: "select" },
      { key: "discipline", label: "Discipline", type: "select" },
      { key: "inspector", label: "Inspector", type: "user" },
      { key: "pages", label: "Pages", type: "number" },
    ];
    const byKey = Object.fromEntries(collectTagGroups(metadata, columns).map((g) => [g.key, g]));
    expect(byKey.equipment.tags).toEqual(["E-200", "E-201"]);
    expect(byKey.assets.tags).toEqual(["V-9"]);
    expect(byKey.discipline).toBeUndefined();
    expect(byKey.inspector).toBeUndefined();
    expect(byKey.pages).toBeUndefined();
  });

  it("returns NO groups when a sheet's tag columns are empty (no spurious pill)", () => {
    const columns = [
      { key: "equipment", label: "Equipment", type: "tags" },
      { key: "discipline", label: "Discipline", type: "select" },
    ];
    expect(collectTagGroups({ discipline: "Process" }, columns)).toEqual([]);
  });

  it("treats isPill / pillGroupLabel columns as tags regardless of type", () => {
    const byKey = Object.fromEntries(collectTagGroups(
      { line: "L-12", area: "Unit 5" },
      [
        { key: "line", label: "Line", type: "text", isPill: true },
        { key: "area", label: "Area", type: "text", pillGroupLabel: "Area" },
      ],
    ).map((g) => [g.key, g]));
    expect(byKey.line.tags).toEqual(["L-12"]);
    expect(byKey.area.tags).toEqual(["Unit 5"]);
  });

  it("honours pillGroupLabel and falls back to the array heuristic", () => {
    const withLabel = collectTagGroups({ tags: ["X"] }, [{ key: "tags", label: "Tags", type: "tags", pillGroupLabel: "Equipment" }]);
    expect(withLabel[0].label).toBe("Equipment");

    const heuristic = collectTagGroups({ gear: ["G-1", "G-2"] }, undefined);
    expect(heuristic[0].tags).toEqual(["G-1", "G-2"]);
  });
});

describe("buildTagSearchIndex / indexMatches", () => {
  it("indexes every column value (incl. numbers/booleans) + extras", () => {
    const metadata = { equipment: ["P-101"], inspector: "jdoe", pages: 7, built: true };
    const columns = [
      { key: "equipment", label: "Equipment", type: "tags" },
      { key: "inspector", label: "Inspector", type: "user" },
      { key: "pages", label: "Pages", type: "number" },
    ];
    const idx = buildTagSearchIndex(metadata, columns, ["DRW-500", "Pump Plan"]);
    expect(indexMatches(idx, "p-101")).toBe(true); // tag value
    expect(indexMatches(idx, "JDOE")).toBe(true); // case-insensitive user value
    expect(indexMatches(idx, "drw-500")).toBe(true); // extra (doc number)
    expect(indexMatches(idx, "pump")).toBe(true); // extra (title)
    expect(indexMatches(idx, "nope")).toBe(false);
    expect(indexMatches(idx, "")).toBe(false); // empty query never matches
  });

  it("does not match across value boundaries", () => {
    const idx = buildTagSearchIndex({ a: "P-101", b: "PUMP" }, [
      { key: "a", label: "A", type: "text" },
      { key: "b", label: "B", type: "text" },
    ]);
    expect(indexMatches(idx, "101pump")).toBe(false);
  });
});

describe("rankTags (typo-tolerant autocomplete)", () => {
  const tags = ["P-34", "P-340", "L-34", "E-200", "PUMP-1"];

  it("ignores case and separators (P-34 == p34 == 'P 34')", () => {
    expect(rankTags("p34", tags)[0].tag).toBe("P-34");
    expect(rankTags("P 34", tags)[0].tag).toBe("P-34");
  });

  it("orders exact > prefix > substring", () => {
    const r = rankTags("p34", tags).map((x) => x.tag);
    expect(r[0]).toBe("P-34");    // exact (normalized)
    expect(r).toContain("P-340"); // prefix
  });

  it("tolerates a single fat-finger typo", () => {
    // l34 is exact for L-34, and one edit from p34 → P-34 still surfaces.
    expect(rankTags("l34", tags).map((r) => r.tag)).toEqual(expect.arrayContaining(["L-34", "P-34"]));
    expect(rankTags("p35", tags).map((r) => r.tag)).toContain("P-34");
  });

  it("matches a bare number as a substring", () => {
    expect(rankTags("34", tags).map((r) => r.tag)).toEqual(expect.arrayContaining(["P-34", "L-34", "P-340"]));
  });

  it("returns nothing when the query is truly unrelated", () => {
    expect(rankTags("zzzzz", tags)).toEqual([]);
    expect(rankTags("", tags)).toEqual([]);
  });
});
