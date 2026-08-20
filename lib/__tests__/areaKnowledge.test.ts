import { describe, it, expect } from "vitest";
import {
  folderMatchesUnit, suggestFoldersForUnit, computeAreaDrift, type AreaFolder,
} from "@/lib/areaKnowledge";

// The wizard's promise: type-first doc control (PFDs/<unit>, P&IDs/<unit>)
// finds ITS unit's folders by name or code — and never grabs a different
// unit's just because both say "unit". Drift's promise: reorganize doc
// control after linking and the area SAYS so before the sync drops things.

const crude = { code: "20", label: "Crude Unit" };

const folder = (id: string, name: string, path: string[], docCount = 1): AreaFolder => ({
  id, name, libraryId: "dl1", libraryName: "Drawings", pathNames: path, docCount,
});

describe("folderMatchesUnit", () => {
  it("matches the distinctive part of the label, in the name or the path", () => {
    expect(folderMatchesUnit(crude, folder("f1", "Crude Unit", ["PFDs", "Crude Unit"]))).toBe(true);
    expect(folderMatchesUnit(crude, folder("f2", "Crude", ["P&IDs", "Crude"]))).toBe(true);
    // Type folder whose PATH carries the unit.
    expect(folderMatchesUnit(crude, folder("f3", "Rev A", ["Plot Plans", "Crude Unit", "Rev A"]))).toBe(true);
  });

  it("never matches a different unit on the generic word 'unit'", () => {
    expect(folderMatchesUnit(crude, folder("f4", "Utilities Unit", ["P&IDs", "Utilities Unit"]))).toBe(false);
    expect(folderMatchesUnit(crude, folder("f5", "Unit Files", ["Unit Files"]))).toBe(false);
  });

  it("matches the unit CODE as a standalone number, not inside another number", () => {
    expect(folderMatchesUnit(crude, folder("f6", "Unit 20", ["PFDs", "Unit 20"]))).toBe(true);
    expect(folderMatchesUnit(crude, folder("f7", "20 - Crude", ["20 - Crude"]))).toBe(true);
    // 120 and 205 contain "20" but are different units.
    expect(folderMatchesUnit(crude, folder("f8", "Unit 120", ["Unit 120"]))).toBe(false);
    expect(folderMatchesUnit(crude, folder("f9", "Area 205", ["Area 205"]))).toBe(false);
  });

  it("a long unit label still finds its short folder — ANY distinctive token, whole-word", () => {
    const cdu = { code: "20", label: "Crude Distillation Unit" };
    expect(folderMatchesUnit(cdu, folder("f10", "Crude", ["PFDs", "Crude"]))).toBe(true);
    expect(folderMatchesUnit(cdu, folder("f11", "Distillation", ["P&IDs", "Distillation"]))).toBe(true);
    // Whole-word only: "Gas" must not match inside "Gaskets".
    const gas = { code: "30", label: "Gas Plant" };
    expect(folderMatchesUnit(gas, folder("f12", "Gaskets", ["Spares", "Gaskets"]))).toBe(false);
  });

  it("punctuated and alphanumeric codes match through normalization — and never crash", () => {
    const u20 = { code: "U-20", label: "" };
    expect(folderMatchesUnit(u20, folder("f13", "U-20 PFDs", ["U-20 PFDs"]))).toBe(true);
    const weird = { code: "20(A)", label: "" };
    // Regex metacharacters in a free-text code must not throw.
    expect(() => folderMatchesUnit(weird, folder("f14", "Unit 20(A)", ["Unit 20(A)"]))).not.toThrow();
    expect(folderMatchesUnit(weird, folder("f14", "Unit 20(A)", ["Unit 20(A)"]))).toBe(true);
  });
});

describe("suggestFoldersForUnit", () => {
  it("returns matches most-populated first", () => {
    const out = suggestFoldersForUnit(crude, [
      folder("a", "Crude Unit", ["Plot Plans", "Crude Unit"], 1),
      folder("b", "Crude Unit", ["P&IDs", "Crude Unit"], 14),
      folder("c", "Utilities Unit", ["P&IDs", "Utilities Unit"], 30),
    ]);
    expect(out.map((f) => f.id)).toEqual(["b", "a"]);
  });
});

describe("computeAreaDrift", () => {
  const baseInputs = () => ({
    unit: crude,
    sources: [{ id: "s1", sourceId: "fA", sourceName: "Drawings / PFDs / Crude Unit" }],
    existingFolderIds: new Set(["fA", "fB"]),
    coveredFolderIds: new Set(["fA"]),
    coversEverything: false as boolean | undefined,
    mirroredDocs: [] as Array<{ kdocId: string; name: string; collectionId: string | null; inDc: boolean }>,
    allFolders: [] as AreaFolder[],
  });

  it("flags a source whose folder was deleted", () => {
    const inputs = baseInputs();
    inputs.existingFolderIds = new Set(["fB"]);
    const drift = computeAreaDrift(inputs);
    expect(drift.deadSources).toEqual([{ id: "s1", sourceName: "Drawings / PFDs / Crude Unit" }]);
  });

  it("names mirrored docs MOVED outside watched folders — before the sync drops them", () => {
    const inputs = baseInputs();
    inputs.mirroredDocs = [
      { kdocId: "k1", name: "Crude PFD", collectionId: "fB", inDc: true },   // moved to unwatched folder
      { kdocId: "k2", name: "Still home", collectionId: "fA", inDc: true },  // fine
      { kdocId: "k3", name: "Deleted in DC", collectionId: null, inDc: false }, // gone entirely — sync's job
    ];
    const drift = computeAreaDrift(inputs);
    expect(drift.movedOut).toEqual([{ kdocId: "k1", name: "Crude PFD" }]);
  });

  it("suggests NEW unit-matching folders the library doesn't watch yet", () => {
    const inputs = baseInputs();
    inputs.allFolders = [
      folder("fA", "Crude Unit", ["PFDs", "Crude Unit"], 3),        // already covered
      folder("fB", "Crude Unit", ["P&IDs", "Crude Unit"], 7),       // the reorg's new folder
      folder("fC", "Utilities Unit", ["P&IDs", "Utilities Unit"], 5), // someone else's
      folder("fD", "Crude Unit", ["Manuals", "Crude Unit"], 0),     // empty — noise
    ];
    const drift = computeAreaDrift(inputs);
    expect(drift.newMatches.map((f) => f.id)).toEqual(["fB"]);
  });

  it("a whole-library source can't drift — everything is always covered", () => {
    const inputs = baseInputs();
    inputs.coversEverything = true;
    inputs.mirroredDocs = [{ kdocId: "k1", name: "Anywhere", collectionId: "fB", inDc: true }];
    inputs.allFolders = [folder("fB", "Crude Unit", ["P&IDs", "Crude Unit"], 7)];
    const drift = computeAreaDrift(inputs);
    expect(drift.movedOut).toEqual([]);
    expect(drift.newMatches).toEqual([]);
  });
});
