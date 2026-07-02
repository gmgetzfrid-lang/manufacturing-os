// lib/__tests__/documentOrigin.test.ts
import { describe, it, expect } from "vitest";
import { describeOrigin } from "@/lib/documentOrigin";

describe("describeOrigin", () => {
  it("is 'Internal' by default / when internal", () => {
    expect(describeOrigin({})).toBe("Internal");
    expect(describeOrigin({ origin: "internal" })).toBe("Internal");
    expect(describeOrigin({ origin: null })).toBe("Internal");
  });
  it("labels external with source + reference", () => {
    expect(describeOrigin({ origin: "external", externalSource: "API", externalReference: "610" })).toBe("External · API 610");
    expect(describeOrigin({ origin: "external", externalSource: "Emerson" })).toBe("External · Emerson");
    expect(describeOrigin({ origin: "external" })).toBe("External");
  });
  it("ignores blank source/reference", () => {
    expect(describeOrigin({ origin: "external", externalSource: "  ", externalReference: "" })).toBe("External");
  });
});
