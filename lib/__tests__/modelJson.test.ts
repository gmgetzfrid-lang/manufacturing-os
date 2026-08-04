// lib/__tests__/modelJson.test.ts — the salvage parser guards real money:
// a truncated reply that fails to parse wastes the user's paid AI call.

import { describe, it, expect } from "vitest";
import { parseModelJson } from "@/lib/modelJson";

const FULL = { units: [{ code: "20", label: "Crude Unit" }], equipmentTypes: [{ code: "30", label: "Exchangers", tagPrefixes: ["E"] }], drawingTypes: [], notes: "ok" };

describe("parseModelJson", () => {
  it("parses clean JSON", () => {
    expect(parseModelJson(JSON.stringify(FULL))).toEqual(FULL);
  });
  it("strips markdown fences and prose prefixes", () => {
    expect(parseModelJson("```json\n" + JSON.stringify(FULL) + "\n```")).toEqual(FULL);
    expect(parseModelJson("Here is the extraction:\n" + JSON.stringify(FULL))).toEqual(FULL);
  });
  it("salvages a reply truncated mid-array — complete rows survive", () => {
    const truncated = `{"units":[{"code":"20","label":"Crude Unit"},{"code":"25","label":"DHT"},{"code":"30","lab`;
    const out = parseModelJson(truncated) as { units: Array<{ code: string }> };
    expect(out).not.toBeNull();
    expect(out.units.map((u) => u.code)).toEqual(["20", "25"]);
  });
  it("salvages truncation inside a nested string with escapes", () => {
    const truncated = `{"units":[{"code":"20","label":"Crude \\"North\\" Unit"}],"equipmentTypes":[{"code":"30","label":"Exch`;
    const out = parseModelJson(truncated) as { units: Array<{ label: string }> };
    expect(out).not.toBeNull();
    expect(out.units[0].label).toContain("North");
  });
  it("brackets inside strings never confuse the balancer", () => {
    const s = `{"notes":"see {section 4] weird","units":[{"code":"20","label":"Crude"}]}`;
    expect((parseModelJson(s) as { units: unknown[] }).units).toHaveLength(1);
  });
  it("returns null for hopeless input", () => {
    expect(parseModelJson("I could not find any codes in this document.")).toBeNull();
    expect(parseModelJson("")).toBeNull();
  });
});
