import { describe, it, expect } from "vitest";
import { planCategorization } from "@/lib/assetCategorize";
import { EMPTY_CODEBOOK, type Codebook } from "@/lib/codebook";
import type { Asset, AssetType } from "@/lib/assets";

// The bridge this module exists for: the codebook's imported taxonomy
// ("E" → Exchanger) finally categorizing the registry.

const book: Codebook = {
  ...EMPTY_CODEBOOK,
  units: [
    { id: "u1", kind: "unit", code: "20", label: "Crude Unit", meta: {}, sort: 0, origin: "import" },
  ],
  equipmentTypes: [
    { id: "1", kind: "equipment_type", code: "02", label: "Exchanger", meta: { tagPrefixes: ["E", "EA"] }, sort: 0, origin: "import" },
    { id: "2", kind: "equipment_type", code: "03", label: "Pump", meta: { tagPrefixes: ["P"] }, sort: 1, origin: "import" },
  ],
};

const asset = (id: string, tag: string, typeId: string | null = null, extra: Partial<Asset> = {}): Asset => ({
  id, org_id: "o", tag, tag_normalized: tag.toLowerCase().replace(/[^a-z0-9]/g, ""),
  type_id: typeId, description: null, unit_code: null, code: null, ...extra,
} as unknown as Asset);

const types: AssetType[] = [
  { id: "t-pump", org_id: "o", name: "Pump", icon: null, color: null, sort_order: 0 } as AssetType,
];

describe("planCategorization — codebook → registry bridge", () => {
  it("decodes tags through codebook prefixes and reuses existing categories case-insensitively", () => {
    const plan = planCategorization(
      [asset("a1", "E-22"), asset("a2", "P-101"), asset("a3", "XV-9")],
      types, book,
    );
    expect(plan.assignments).toEqual([
      { assetId: "a1", tag: "E-22", typeName: "Exchanger" },
      { assetId: "a2", tag: "P-101", typeName: "Pump" },
    ]);
    // "Pump" exists (t-pump) — only Exchanger needs creating.
    expect(plan.typesToCreate).toEqual(["Exchanger"]);
    // The codebook has no prefix for XV → reported, never guessed.
    expect(plan.unmatched).toEqual(["XV-9"]);
  });

  it("leaves already-categorized assets alone and counts them", () => {
    const plan = planCategorization([asset("a1", "E-22", "t-pump")], types, book);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.alreadyCategorized).toBe(1);
  });

  it("prefers the longest matching prefix (EA beats E)", () => {
    const plan = planCategorization([asset("a1", "EA-201")], types, book);
    expect(plan.assignments[0]?.typeName).toBe("Exchanger");
  });

  it("does nothing with an empty codebook — everything is unmatched, nothing invented", () => {
    const plan = planCategorization([asset("a1", "E-22")], types, EMPTY_CODEBOOK);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unmatched).toEqual(["E-22"]);
  });

  it("files unfiled assets into their operating area from the site code", () => {
    // 2002.22 = unit 20 + type 02 (Exchanger) + item 22 — the numbering
    // system the org imported files the plant by itself.
    const plan = planCategorization(
      [
        asset("a1", "E-22", null, { code: "2002.22" }),
        asset("a2", "P-5", null, { code: "2003.05", unit_code: "20" }), // already filed
      ],
      types, book,
    );
    expect(plan.unitAssignments).toEqual([{ assetId: "a1", tag: "E-22", unitCode: "20" }]);
  });
});
