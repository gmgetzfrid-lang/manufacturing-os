import { describe, it, expect } from "vitest";
import { expandQueryToTsquery } from "@/lib/searchSynonyms";

describe("expandQueryToTsquery", () => {
  it("expands a known abbreviation into an OR group", () => {
    const q = expandQueryToTsquery("vsl");
    expect(q).toContain("vessel");
    expect(q).toContain("|");
    expect(q).toMatch(/^\( .* \)$/);
  });

  it("AND's multiple tokens together", () => {
    const q = expandQueryToTsquery("exchanger overhead");
    expect(q).toContain("&");
    // exchanger expands; overhead is a plain token
    expect(q).toContain("overhead");
    expect(q).toContain("he");
  });

  it("leaves unknown tokens untouched", () => {
    expect(expandQueryToTsquery("E204")).toBe("e204");
  });

  it("sanitizes tsquery operators out of raw input", () => {
    // Punctuation that would break a raw tsquery is stripped.
    const q = expandQueryToTsquery("E-204 & | ! ( pump )");
    expect(q).not.toContain("!");
    expect(q).toContain("e204");
    expect(q).toContain("pmp"); // pump expands
  });

  it("returns null when nothing searchable remains", () => {
    expect(expandQueryToTsquery("   ")).toBeNull();
    expect(expandQueryToTsquery("%%% @@@")).toBeNull();
  });

  it("handles P&ID shorthand", () => {
    const q = expandQueryToTsquery("p&id");
    expect(q).toContain("pid");
  });
});
