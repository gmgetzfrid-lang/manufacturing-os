import { describe, it, expect } from "vitest";
import { rollupFolderCounts } from "@/lib/folderCounts";

describe("rollupFolderCounts", () => {
  const folders = [
    { id: "piping", parentId: null },
    { id: "stp", parentId: "piping" },
    { id: "ds", parentId: "piping" },
    { id: "valves", parentId: "stp" },
    { id: "civil", parentId: null },
  ];
  it("each folder totals itself plus everything beneath it", () => {
    const direct = new Map<string | null, number>([[null, 2], ["piping", 1], ["stp", 10], ["valves", 5], ["ds", 4], ["civil", 3]]);
    const { totals, libraryTotal } = rollupFolderCounts(folders, direct);
    expect(totals.get("valves")).toBe(5);
    expect(totals.get("stp")).toBe(15);
    expect(totals.get("piping")).toBe(20);
    expect(totals.get("civil")).toBe(3);
    expect(libraryTotal).toBe(25);
  });
  it("empty folders read 0, and a broken parent loop can't hang", () => {
    const loop = [{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }];
    const { totals } = rollupFolderCounts(loop, new Map([["a", 1]]));
    expect(totals.get("a")).toBe(1);
    expect(totals.get("b")).toBe(1);
    expect(rollupFolderCounts([{ id: "x", parentId: null }], new Map()).totals.get("x")).toBe(0);
  });
});
