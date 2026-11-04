// One search the way it's typed in the field: tags any way round, typos,
// part of a WO number.

import { describe, it, expect } from "vitest";
import { searchMatcher, searchFilter, searchMatches, editDistance } from "@/lib/fuzzySearch";

const names = [
  "WO 310359 V-01 - De-Butanizer Column Schultz",
  "WO 310357 V-03 - De-Ethanizer Column Schultz",
  "WO 310661 Pull V-12A - 2nd Stage Suction Bottle",
  "WO 310745 PSV-823 - V-01 De-Butanizer Reboiler Pressure Relief",
  "WO 310456 E-02 - De-Butanizer Condenser Ancon",
  "WO 305282 LRU-078 - Replace Piping from V-21 to V-11",
  "WO 308260 MCC #4 - LRU Switch House Cleaning",
  "WO 312478 E-22 - Compressor Interstage Cooler - Tubes",
];
const find = (q: string) => searchFilter(names, q, (x) => x).map((x) => x.split(" ")[1]);

describe("equipment tags, however they're typed", () => {
  it("v1, v-1, V 01, V-01 all find V-01 (and the PSV on it), not V-12 or V-11", () => {
    for (const q of ["v1", "v-1", "V 01", "V-01", "v01"]) expect(find(q).sort()).toEqual(["310359", "310745"]);
  });
  it("e2 is E-02, not E-22", () => expect(find("e2")).toEqual(["310456"]));
  it("v12 finds V-12A; v12a too", () => {
    expect(find("v12")).toEqual(["310661"]);
    expect(find("v-12a")).toEqual(["310661"]);
  });
  it("psv823, PSV 823; mcc4, MCC #4; lru78 and lru-078", () => {
    expect(find("psv823")).toEqual(["310745"]);
    expect(find("PSV 823")).toEqual(["310745"]);
    expect(find("mcc4")).toEqual(["308260"]);
    expect(find("lru78")).toEqual(["305282"]);
    expect(find("lru-078")).toEqual(["305282"]);
  });
});

describe("typos and part words", () => {
  it("a letter off, or two swapped, in a longer word", () => {
    expect(find("debutanizr")).toEqual(["310359", "310745", "310456"]);
    expect(find("condensor")).toEqual(["310456"]);
    expect(find("shultz").sort()).toEqual(["310357", "310359"]);
    expect(find("comrpessor")).toEqual(["312478"]);
  });
  it("the start of a word, or of a WO number", () => {
    expect(find("reboil")).toEqual(["310745"]);
    expect(find("31074")).toEqual(["310745"]);
    expect(find("3103").sort()).toEqual(["310357", "310359"]);
  });
  it("every word must be found; the best matches first", () => {
    expect(find("v1 column")).toEqual(["310359"]);
    expect(find("column v1 reboiler")).toEqual([]);
    expect(searchFilter(["Debutanizer column", "De-Butanizer Column"], "de-butanizer", (x) => x)).toHaveLength(2);
    const m = searchMatcher("column");
    expect(m("V-01 Column")).toBeGreaterThan(m("V-01 Colum"));
  });
  it("short words aren't guessed at; nothing typed keeps everything", () => {
    expect(searchMatches("cat", "car wash")).toBe(false);
    expect(find("")).toHaveLength(names.length);
  });
  it("edit distance counts a swap as one", () => {
    expect(editDistance("comrpessor", "compressor")).toBe(1);
    expect(editDistance("abc", "xyz", 1)).toBe(2);
  });
});
