import { describe, it, expect } from "vitest";
import { tokens, matchKey } from "@/lib/thor/tokens";

// These cases are shared with scripts/thor_import.py (its tokens()): the
// importer builds every file's search vector with the same rules, so a
// query and a file always break up the same way. Change both together.
const SHARED: Array<[string, string[]]> = [
  ["V-3 PREFRACTIONATOR TOWER", ["v3", "v", "3", "prefractionator", "tower"]],
  ["2010.03 Scan Data Evaluation 2026-06-10.xlsx", ["2010.03", "scan", "data", "evaluation", "20260610", "2026", "06", "10", "xlsx"]],
  ["2002-D-2001 SHT04 Rev.33.pdf", ["2002d2001", "2002", "d", "2001", "sht04", "rev", "33", "pdf"]],
  ["WO311452_2010.03", ["wo311452", "2010.03"]],
  ["P&ID", ["p", "id"]],
  ["X-14A", ["x14a", "x", "14a"]],
  ["file.name.ext", ["file", "name", "ext"]],
  ["..weird--", ["weird"]],
  ["1.5.2 a.b", ["1.5.2", "a", "b"]],
  ["-", []],
];

describe("thor tokens", () => {
  it.each(SHARED)("%s", (input, want) => {
    expect(tokens(input)).toEqual(want);
  });

  it("never emits a character the search function would strip", () => {
    for (const [input] of SHARED) for (const t of tokens(input)) expect(t).toMatch(/^[a-z0-9.]+$/);
  });

  it("match keys join tag spellings", () => {
    expect(matchKey("V-3")).toBe("v3");
    expect(matchKey("v 3")).toBe("v3");
    expect(matchKey("2010.03")).toBe("2010.03");
  });
});
