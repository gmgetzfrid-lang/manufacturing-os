import { describe, it, expect } from "vitest";
import { buildAssetIndex, bareTag } from "@/lib/find/assetMatch";

const reg = [
  { id: "v101", tag: "V-101", code: "1020.101", unit_code: "10" },
  { id: "p101a", tag: "P-101A", unit_code: "10" },
  { id: "p101b", tag: "P-101B", unit_code: "10" },
  { id: "x35", tag: "10-X-35", unit_code: "10" },
  { id: "e22", tag: "E-22", unit_code: "20" },
];
const idx = buildAssetIndex(reg, ["10", "20"]);

describe("asset matcher", () => {
  it("exact spelling, any punctuation", () => {
    expect(idx.best("v101")?.asset.id).toBe("v101");
    expect(idx.best("V 101")?.tier).toBe("exact");
  });
  it("unit prefix dropped by the person", () => {
    const m = idx.best("X-35");
    expect(m?.asset.id).toBe("x35");
    expect(m?.tier).toBe("prefix");
  });
  it("unit prefix added by the person", () => {
    const m = idx.best("10-V-101");
    expect(m?.asset.id).toBe("v101");
    expect(m?.via).toContain("10");
  });
  it("site code", () => {
    expect(idx.best("1020.101")?.tier).toBe("code");
  });
  it("train letter left off names both trains", () => {
    const l = idx.find("P-101");
    expect(l.map((m) => m.asset.id).sort()).toEqual(["p101a", "p101b"]);
    expect(l[0].tier).toBe("suffix");
  });
  it("one character off on a long enough tag", () => {
    expect(idx.best("P-10IA")?.asset.id).toBe("p101a");
    expect(idx.best("P-10IA")?.tier).toBe("close");
  });
  it("nothing for a different thing", () => {
    expect(idx.best("FE-9")).toBeNull();
    expect(idx.find("")).toEqual([]);
  });
  it("bareTag reads a known unit before a generic digit run", () => {
    expect(bareTag("20E22", ["20"])).toEqual({ bare: "E22", unit: "20" });
    expect(bareTag("7E22", [])).toEqual({ bare: "E22", unit: "7" });
    expect(bareTag("E22", ["20"])).toEqual({ bare: "E22", unit: null });
  });
});
