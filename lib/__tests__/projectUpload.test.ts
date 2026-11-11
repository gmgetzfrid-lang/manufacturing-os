// A file uploaded from a project screen: where it goes is picked by the
// person, and its number reads like a number.

import { describe, it, expect } from "vitest";
import { cleanPlace, isProjectUploadNumber, placeWords, projectDocNumber, projectSlug, uniqueNumber } from "@/lib/projectUpload";

const TRANSMIX = "Transmix-1/2 Turnaround 10-26 & 11-26";

describe("projectSlug", () => {
  it("keeps whole words and never ends on the tail of a date", () => {
    // Was "TRANSMIX-1-2-TURNAROUND-10-2": cut in the middle of "10-26".
    expect(projectSlug(TRANSMIX)).toBe("TRANSMIX-1-2-TURNAROUND");
  });
  it("a short name is kept whole, numbers and all", () => {
    expect(projectSlug("Unit 56 LRU")).toBe("UNIT-56-LRU");
    expect(projectSlug("Tank 72")).toBe("TANK-72");
  });
  it("a long first word is cut, not dropped", () => {
    expect(projectSlug("Hydrodesulfurizationreactorreplacement job")).toHaveLength(28);
  });
  it("nothing to go on: empty", () => {
    expect(projectSlug("  &  ")).toBe("");
  });
});

describe("projectDocNumber", () => {
  const at = new Date(2026, 10, 8, 9, 34, 29);
  it("the kind, the project, the day", () => {
    expect(projectDocNumber("PSSR", TRANSMIX, at)).toBe("PSSR-TRANSMIX-1-2-TURNAROUND-2026-11-08");
  });
  it("the phase it is for, when there is one", () => {
    expect(projectDocNumber("pssr", TRANSMIX, at, "Phase 2")).toBe("PSSR-TRANSMIX-1-2-TURNAROUND-PHASE-2-2026-11-08");
  });
});

describe("uniqueNumber", () => {
  it("free: as is", () => {
    expect(uniqueNumber("PSSR-A-2026-11-08", [])).toBe("PSSR-A-2026-11-08");
  });
  it("taken: the next free suffix, whatever the case saved", () => {
    expect(uniqueNumber("PSSR-A-2026-11-08", ["pssr-a-2026-11-08"])).toBe("PSSR-A-2026-11-08-2");
    expect(uniqueNumber("PSSR-A-2026-11-08", ["PSSR-A-2026-11-08", "PSSR-A-2026-11-08-2"])).toBe("PSSR-A-2026-11-08-3");
  });
});

describe("the place picked", () => {
  it("nothing saved, or not a place: none", () => {
    expect(cleanPlace(null)).toBeNull();
    expect(cleanPlace({})).toBeNull();
    expect(cleanPlace({ collectionId: "c1" })).toBeNull();
    expect(cleanPlace("lib")).toBeNull();
  });
  it("a library, with or without a folder", () => {
    expect(cleanPlace({ libraryId: "l1" })).toEqual({ libraryId: "l1", collectionId: null });
    expect(cleanPlace({ libraryId: "l1", collectionId: "c1", extra: 1 })).toEqual({ libraryId: "l1", collectionId: "c1" });
  });
  it("says the top of a library as that, and a folder by its path", () => {
    expect(placeWords("Procedures", [])).toBe("Procedures (top level)");
    expect(placeWords("Procedures", ["Turnarounds", "Transmix 1/2"])).toBe("Procedures › Turnarounds › Transmix 1/2");
  });
});

describe("isProjectUploadNumber", () => {
  it("the old stamped numbers and the new dated ones are both this project's uploads", () => {
    expect(isProjectUploadNumber("PSSR-TRANSMIX-1-2-TURNAROUND-10-2-20261108-093429", TRANSMIX)).toBe(true);
    expect(isProjectUploadNumber("TURNOVER-TRANSMIX-1-2-TURNAROUND-2026-11-09", TRANSMIX)).toBe(true);
  });
  it("a drawing linked to the project is not", () => {
    expect(isProjectUploadNumber("5502-D 12", TRANSMIX)).toBe(false);
    expect(isProjectUploadNumber("PSSR-OTHER-JOB-2026-11-08", TRANSMIX)).toBe(false);
  });
});
