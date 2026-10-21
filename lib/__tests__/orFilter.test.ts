import { describe, it, expect } from "vitest";
import { orIlike } from "@/lib/orFilter";

describe("orIlike", () => {
  it("quotes the value so commas and parentheses aren't read as syntax", () => {
    expect(orIlike(["a", "b"], "EP 5-3-10 (A), x")).toBe('a.ilike."%EP 5-3-10 (A), x%",b.ilike."%EP 5-3-10 (A), x%"');
  });
  it("escapes quotes and backslashes inside the value", () => {
    expect(orIlike(["a"], 'say "hi" \\')).toBe('a.ilike."%say \\"hi\\" \\\\%"');
  });
});
