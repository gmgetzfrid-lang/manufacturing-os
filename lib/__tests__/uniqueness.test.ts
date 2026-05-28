import { describe, it, expect } from "vitest";
import { computeUniquenessKey } from "@/lib/uniqueness";

describe("computeUniquenessKey", () => {
  it("defaults to documentNumber when uniquenessKeys is not set", () => {
    expect(computeUniquenessKey({ documentNumber: "100-PID-001" }, undefined)).toBe("100-pid-001");
    expect(computeUniquenessKey({ documentNumber: "100-PID-001" }, null)).toBe("100-pid-001");
  });

  it("defaults to documentNumber when uniquenessKeys is an empty array (legacy semantics)", () => {
    // Empty array means "no keys" -> falls back to default to preserve
    // safety. Callers wanting to disable uniqueness pass null/undefined
    // for documentNumber instead.
    expect(computeUniquenessKey({ documentNumber: "X-1" }, [])).toBe("x-1");
  });

  it("composes lowercased tuple keys joined with ::", () => {
    const key = computeUniquenessKey(
      { documentNumber: "100-PID-001", customFields: { sheet: "03" } },
      ["documentNumber", "sheet"],
    );
    expect(key).toBe("100-pid-001::03");
  });

  it("returns null when every key resolves to empty", () => {
    expect(computeUniquenessKey({}, ["documentNumber"])).toBeNull();
    expect(computeUniquenessKey({ customFields: { sheet: "" } }, ["sheet"])).toBeNull();
  });

  it("reads canonical fields (title, rev, status) by name", () => {
    expect(
      computeUniquenessKey(
        { documentNumber: "X", title: "Y", rev: "B", status: "Issued" },
        ["documentNumber", "rev"],
      ),
    ).toBe("x::b");
  });

  it("trims whitespace before lowercasing", () => {
    expect(computeUniquenessKey({ documentNumber: "  100-PID-001  " }, ["documentNumber"]))
      .toBe("100-pid-001");
  });
});
