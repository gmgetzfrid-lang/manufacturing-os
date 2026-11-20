// Where you were in a library lives in the address (folder, filter, search)
// and, for the rest, in the tab: written params come back as they went in.

import { describe, it, expect, beforeEach } from "vitest";
import { withParams, readPlace, writePlace } from "@/lib/docsPlace";

describe("the address", () => {
  it("sets and removes params, keeping the rest in order", () => {
    expect(withParams("?folderId=f1&doc=d1", { filter: "2001" })).toBe("?folderId=f1&doc=d1&filter=2001");
    expect(withParams("?folderId=f1&filter=2001", { filter: "" })).toBe("?folderId=f1");
    expect(withParams("folderId=f1", { filter: null, find: "E-22" })).toBe("?folderId=f1&find=E-22");
    expect(withParams("?filter=a", { filter: null })).toBe("");
  });
  it("an unchanged address compares equal", () => {
    expect(withParams("?folderId=f1&filter=x", { filter: "x" })).toBe("?folderId=f1&filter=x");
  });
});

describe("the place in a folder", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
    };
  });
  it("keeps scroll, row and sort per folder", () => {
    writePlace("L", "f1", { top: 420, row: "d7" });
    writePlace("L", "f1", { sort: { key: "title", dir: "asc" } });
    writePlace("L", null, { top: 10 });
    expect(readPlace("L", "f1")).toMatchObject({ top: 420, row: "d7", sort: { key: "title", dir: "asc" } });
    expect(readPlace("L", null)).toMatchObject({ top: 10 });
    expect(readPlace("L", "f2")).toBeNull();
  });
});
