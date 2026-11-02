// The projects list by kind of project, and amounts as people type them.

import { describe, it, expect } from "vitest";
import { listedTypeOf, typePlural, typeOrder, PROJECT_TYPES, DEFAULT_PROJECT_TYPE } from "@/lib/projectType";
import { parseMoney } from "@/lib/costRevisions";

describe("projects grouped by kind", () => {
  it("the kind set in Setup, else from the name, else a capital-sized job", () => {
    expect(listedTypeOf({ name: "October 2026 Transmix-1 Turnaround" }).word).toBe("Turnaround");
    expect(listedTypeOf({ name: "Tank 12 floor", projectTypeSaved: { word: "Capital project", short: "Project" } }).word).toBe("Capital project");
    expect(listedTypeOf({ name: "New flare line", jobKind: "capital" }).word).toBe("Capital project");
    expect(listedTypeOf({ name: "New flare line", jobKind: "standard" })).toBe(DEFAULT_PROJECT_TYPE);
  });
  it("headings read like folders", () => {
    expect(typePlural(PROJECT_TYPES[0])).toBe("Turnarounds");
    expect(typePlural(PROJECT_TYPES[3])).toBe("Capital projects");
    expect(typePlural(PROJECT_TYPES[4])).toBe("Maintenance");
    expect(typePlural({ word: "LRU", short: "LRU" })).toBe("LRU");
    expect(typePlural(DEFAULT_PROJECT_TYPE)).toBe("Other projects");
  });
  it("the usual kinds first, the project's own words next, plain projects last", () => {
    expect(typeOrder(PROJECT_TYPES[0])).toBeLessThan(typeOrder({ word: "Tie-in", short: "Tie-in" }));
    expect(typeOrder({ word: "Tie-in", short: "Tie-in" })).toBeLessThan(typeOrder(DEFAULT_PROJECT_TYPE));
  });
});

describe("amounts as typed", () => {
  it("commas, a dollar sign, spaces, decimals and credits", () => {
    expect(parseMoney("1,250,000")).toBe(1250000);
    expect(parseMoney("$85,000.50")).toBe(85000.5);
    expect(parseMoney(" -2500 ")).toBe(-2500);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("about 5k")).toBeNull();
  });
});
