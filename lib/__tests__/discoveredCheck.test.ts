import { describe, it, expect } from "vitest";
import { stillRead, suspectReason } from "@/lib/estate/discoveredCheck";

describe("discovered equipment check", () => {
  it("keeps real tags read from real lines", () => {
    expect(stillRead("V-101", ["10-V-101 CRUDE FEED DRUM"])).toBe(true);
    expect(stillRead("P-101A", ["V101 P 101A E.204"])).toBe(true);
    expect(stillRead("E-22", ["FROM 20-E-22 TO 21-D-1105"])).toBe(true);
  });
  it("flags what the faulty reader invented", () => {
    expect(suspectReason("D-2001", ["2002-D 2001 SHT 05 REV 42"], { readingInProgress: false })).toBe("not-read-any-more");
    expect(suspectReason("SCH-40", ["6\" SCH 40 CS 150# RF"], { readingInProgress: false })).toBe("not-read-any-more");
    expect(suspectReason("HP-460", ["MOTOR 75 HP 460 V"], { readingInProgress: false })).toBe("not-read-any-more");
    expect(suspectReason("R-39", ["R39 05-12-23"], { readingInProgress: false })).toBe("not-read-any-more");
    expect(suspectReason("TO-21", ["FROM 20-E-22 TO 21-D-1105"], { readingInProgress: false })).toBe("not-read-any-more");
  });
  it("does not judge an item on no sheet while drawings are still being read", () => {
    expect(suspectReason("V-7", [], { readingInProgress: true })).toBeNull();
    expect(suspectReason("V-7", [], { readingInProgress: false })).toBe("on-no-sheet");
  });
  it("respects the codebook's own prefixes", () => {
    expect(stillRead("BA-101", ["BA 101 AIR BLOWER"], ["BA"])).toBe(true);
    expect(stillRead("BA-101", ["BA 101 AIR BLOWER"])).toBe(false);
  });
});
