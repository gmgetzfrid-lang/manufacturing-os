import { describe, it, expect } from "vitest";
import {
  planCategorization, planIdentityReview, codeUnitConflict, rederivationImpact, entryAssetReferences,
  planAssetImport, resolveUnitCell, assetsMatchingTagPrefix, sharedSiteCodes, type ImportRowInput,
} from "@/lib/assetCategorize";
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

// ─── Intelligence Round G (I-10) ────────────────────────────────────────────

const book2: Codebook = {
  ...EMPTY_CODEBOOK,
  units: [
    { id: "u20", kind: "unit", code: "20", label: "Crude Unit", meta: {}, sort: 0, origin: "manual" },
    { id: "u25", kind: "unit", code: "25", label: "DHT", meta: {}, sort: 1, origin: "manual" },
  ],
  equipmentTypes: [
    { id: "t30", kind: "equipment_type", code: "30", label: "Exchangers", meta: { tagPrefixes: ["E"] }, sort: 0, origin: "manual" },
    { id: "t50", kind: "equipment_type", code: "50", label: "Pumps", meta: { tagPrefixes: ["P"] }, sort: 1, origin: "manual" },
  ],
};

describe("BR-4 — a known unit and a blank code: the categorizer derives the code (fill-blank only)", () => {
  it("plans codeAssignments for filed, uncoded assets and never touches a code that exists", () => {
    const plan = planCategorization([
      asset("a1", "E-22", "t-pump", { unit_code: "20" }),
      asset("a2", "P-5", "t-pump", { unit_code: "25", code: "9999.1" }),
      asset("a3", "XV-9", "t-pump", { unit_code: "20" }),
    ], types, book2);
    expect(plan.codeAssignments).toEqual([{ assetId: "a1", tag: "E-22", code: "2030.22" }]);
  });
});

describe("AREA-11 — code and unit are two spellings of one fact", () => {
  it("codeUnitConflict: 2530.22 filed under 20 is a contradiction; agreement, blanks and undecodable codes are not", () => {
    expect(codeUnitConflict({ id: "a", tag: "E-22", unit_code: "20", code: "2530.22" } as Asset, book2)).toEqual({ codeUnit: "25", unitCode: "20" });
    expect(codeUnitConflict({ id: "a", tag: "E-22", unit_code: "25", code: "2530.22" } as Asset, book2)).toBeNull();
    expect(codeUnitConflict({ id: "a", tag: "E-22", unit_code: null, code: "2530.22" } as Asset, book2)).toBeNull();
    expect(codeUnitConflict({ id: "a", tag: "E-22", unit_code: "20", code: "free text" } as Asset, book2)).toBeNull();
  });
});

describe("CB-6 — the re-decode plan (never a silent rewrite)", () => {
  it("lists the contradiction (with both ways out) and the codes a codebook edit now derives differently", () => {
    const padded: Codebook = { ...book2, iterableRule: { mirrorsTag: true, padTo: 3 } };
    const rows = planIdentityReview([
      { id: "a1", tag: "E-22", unit_code: "20", code: "2530.22" },   // code names 25
      { id: "a2", tag: "E-23", unit_code: "20", code: "2030.23" },   // derived under padTo 0
      { id: "a3", tag: "E-24", unit_code: "20", code: "2030.024" },  // already padTo 3
      { id: "a4", tag: "E-25", unit_code: "20", code: null },        // blank: the categorizer's job
    ], padded);
    expect(rows).toEqual([
      { assetId: "a1", tag: "E-22", unitCode: "20", code: "2530.22", kind: "code_names_other_unit", codeUnit: "25", derivedCode: "2030.022" },
      { assetId: "a2", tag: "E-23", unitCode: "20", code: "2030.23", kind: "code_rederives", codeUnit: null, derivedCode: "2030.023" },
    ]);
  });
  it("CB-7 / CB-6: rederivationImpact counts the codes the current rule derived that the edited rule would not", () => {
    const assets = [
      { id: "a", tag: "E-22", unit_code: "20", code: "2030.22" },
      { id: "b", tag: "P-5", unit_code: "25", code: "2550.5" },
      { id: "c", tag: "E-9", unit_code: "20", code: "HAND-TYPED" },
    ];
    // padTo 2: E-22 keeps 2030.22 (already two digits); P-5 becomes 2550.05.
    const two = rederivationImpact(assets, book2, { ...book2, iterableRule: { mirrorsTag: true, padTo: 2 } });
    expect(two.changed).toBe(1);
    expect(two.examples).toEqual([{ tag: "P-5", from: "2550.5", to: "2550.05" }]);
    const impact = rederivationImpact(assets, book2, { ...book2, iterableRule: { mirrorsTag: true, padTo: 3 } });
    expect(impact.changed).toBe(2);
    expect(impact.examples[0]).toEqual({ tag: "E-22", from: "2030.22", to: "2030.022" });
    const off = rederivationImpact(assets, book2, { ...book2, iterableRule: { mirrorsTag: false, padTo: 0 } });
    expect(off.changed).toBe(2);
    expect(off.examples[0].to).toBeNull();
    expect(rederivationImpact(assets, book2, book2).changed).toBe(0);
  });
});

describe("CB-5 — what a codebook entry is still holding", () => {
  it("a unit counts assets filed under it or coded into it; a type counts the tags it types or codes", () => {
    const assets = [
      { id: "a", tag: "E-22", unit_code: "20", code: "2030.22" },
      { id: "b", tag: "P-5", unit_code: null, code: "2050.5" },
      { id: "c", tag: "E-9", unit_code: "25", code: null },
    ];
    expect(entryAssetReferences(book2.units[0], assets, book2)).toBe(2);
    expect(entryAssetReferences(book2.units[1], assets, book2)).toBe(1);
    expect(entryAssetReferences(book2.equipmentTypes[0], assets, book2)).toBe(2);
    expect(entryAssetReferences(book2.equipmentTypes[1], assets, book2)).toBe(1);
  });
});

describe("BR-4 / AREA-7 / BR-6 — the master-list import plan", () => {
  const existing = new Map([["e22", { id: "x-e22", unit_code: null, code: null }]]);
  const input: ImportRowInput[] = [
    { row: 2, tag: "E-22", description: "Crude exchanger", unit: "20" },
    { row: 3, tag: "P-101", unit: "Crude Unit" },
    { row: 4, tag: "E-30", code: "2530.30" },
    { row: 5, tag: "E-31", unit: "Utilities" },
    { row: 6, tag: "E-32", unit: "20", code: "2530.32" },
    { row: 7, tag: "e 101", unit: "25" },
    { row: 8, tag: "P-101" },
    { row: 9, tag: "" },
  ];

  it("resolveUnitCell matches a codebook unit by code or by name, and never guesses", () => {
    expect(resolveUnitCell("20", book2)).toEqual({ unitCode: "20", unknown: null });
    expect(resolveUnitCell(" crude unit ", book2)).toEqual({ unitCode: "20", unknown: null });
    expect(resolveUnitCell("Utilities", book2)).toEqual({ unitCode: null, unknown: "Utilities" });
    expect(resolveUnitCell("", book2)).toEqual({ unitCode: null, unknown: null });
  });

  it("files every row it can: unit column (code or name), unit read from the site code, code derived once the unit is known", () => {
    const plan = planAssetImport(input, { book: book2, types, existing, mode: "create_only" });
    const by = new Map(plan.rows.map((r) => [r.row, r]));
    expect(by.get(3)).toMatchObject({ action: "create", unitCode: "20", code: "2050.101" });
    expect(by.get(4)).toMatchObject({ action: "create", unitCode: "25", code: "2530.30" });
    expect(by.get(5)).toMatchObject({ action: "create", unitCode: null, code: null });
    expect(by.get(5)!.notes.join(" ")).toMatch(/Utilities" is not in the Site Codebook/);
    expect(by.get(6)).toMatchObject({ action: "create", unitCode: "20", code: "2530.32" });
    expect(by.get(6)!.notes.join(" ")).toMatch(/names unit 25, the unit column says 20/);
    expect(by.get(7)).toMatchObject({ action: "create", unitCode: "25", code: "2530.101" });
    expect(plan.filed).toBe(4);
  });

  it("BR-6: an existing tag is counted before anything is written — skipped in create-only, updated with only the supplied cells otherwise", () => {
    const skip = planAssetImport(input, { book: book2, types, existing, mode: "create_only" });
    expect(skip.existing).toBe(1);
    expect(skip.rows.find((r) => r.row === 2)).toMatchObject({ action: "skip", existingId: "x-e22" });
    const upd = planAssetImport(input, { book: book2, types, existing, mode: "create_and_update" });
    expect(upd.rows.find((r) => r.row === 2)).toMatchObject({
      action: "update", existingId: "x-e22", unitCode: "20",
      patch: { description: "Crude exchanger", unit_code: "20", code: "2030.22" },
    });
    expect(upd.updates).toBe(1);
  });

  it("an update never overwrites an existing code with a derived one (that is the identity review's job)", () => {
    const ex = new Map([["e22", { id: "x-e22", unit_code: "25", code: "2530.22" }]]);
    const plan = planAssetImport([{ row: 2, tag: "E-22", unit: "20" }], { book: book2, types, existing: ex, mode: "create_and_update" });
    expect(plan.rows[0].patch).toEqual({ unit_code: "20" });
    expect(plan.rows[0].notes.join(" ")).toMatch(/existing site code 2530.22 was kept/);
  });

  it("a duplicate tag in the file and a missing tag are refused with a reason — never a raw database error", () => {
    const plan = planAssetImport(input, { book: book2, types, existing, mode: "create_only" });
    expect(plan.rows.find((r) => r.row === 8)).toMatchObject({ action: "error", error: "Same tag as row 3 — one row per asset" });
    expect(plan.rows.find((r) => r.row === 9)).toMatchObject({ action: "error", error: "Missing tag" });
    expect(plan.errors).toBe(2);
  });

  it("AREA-7: a 3,000-row master list with a unit column lands every row in its operating area — no manual step", () => {
    const big: ImportRowInput[] = Array.from({ length: 3000 }, (_, i) => ({ row: i + 2, tag: `P-${i + 1}`, unit: i % 2 ? "20" : "DHT" }));
    const plan = planAssetImport(big, { book: book2, types, existing: new Map(), mode: "create_only" });
    expect(plan.creates).toBe(3000);
    expect(plan.filed).toBe(3000);
    expect(plan.rows.every((r) => r.code && r.code.startsWith(r.unitCode! + "50."))).toBe(true);
  });
});

describe("AREA-7 — bulk filing by tag prefix", () => {
  it("a letters-only prefix is a whole tag prefix; a longer prefix narrows", () => {
    const list = [{ id: "1", tag: "E-22" }, { id: "2", tag: "EA-1" }, { id: "3", tag: "e 101" }, { id: "4", tag: "P-1" }];
    expect(assetsMatchingTagPrefix(list, "E").map((a) => a.id)).toEqual(["1", "3"]);
    expect(assetsMatchingTagPrefix(list, "ea").map((a) => a.id)).toEqual(["2"]);
    expect(assetsMatchingTagPrefix(list, "E-1").map((a) => a.id)).toEqual(["3"]);
    expect(assetsMatchingTagPrefix(list, " ").map((a) => a.id)).toEqual([]);
  });
});

describe("CB-10 — codes already shared are listed for a person to resolve (the unique index waits on them)", () => {
  it("groups non-blank stored codes held by more than one asset", () => {
    expect(sharedSiteCodes([
      { id: "a", tag: "V-1", code: "2010.1" }, { id: "b", tag: "D-1", code: "2010.1" },
      { id: "c", tag: "E-22", code: "2030.22" }, { id: "d", tag: "X-1", code: "" }, { id: "e", tag: "X-2", code: " " },
      { id: "f", tag: "X-3", code: null },
    ])).toEqual([{ code: "2010.1", assets: [{ id: "a", tag: "V-1" }, { id: "b", tag: "D-1" }] }]);
  });
});
