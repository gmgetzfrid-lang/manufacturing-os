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
  it("surfaces ANY stringy column, not just type:'tags'", () => {
    const metadata = {
      equipment: ["E-200", "E-201"], // tags
      assets: "V-9", // a select column the user named "Assets"
      inspector: "jdoe", // a user column
      pages: 12, // numeric — should NOT become a chip
      built: true, // boolean — not a chip
    };
    const columns = [
      { key: "equipment", label: "Equipment", type: "tags" },
      { key: "assets", label: "Assets", type: "select" },
      { key: "inspector", label: "Inspector", type: "user" },
      { key: "pages", label: "Pages", type: "number" },
      { key: "built", label: "Built", type: "boolean" },
    ];
    const groups = collectTagGroups(metadata, columns);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(byKey.equipment.tags).toEqual(["E-200", "E-201"]);
    expect(byKey.assets.tags).toEqual(["V-9"]);
    expect(byKey.inspector.tags).toEqual(["jdoe"]);
    expect(byKey.pages).toBeUndefined(); // numeric excluded from chips
    expect(byKey.built).toBeUndefined();
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
