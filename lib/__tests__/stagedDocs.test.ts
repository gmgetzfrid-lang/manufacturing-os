import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearStaged, compactMarkups, FULL_FOR_LIST, FULL_FOR_MARKUPS, hasMarkups, MARKUP_BUDGET_CHARS, markedUpIds, markupSize, moveStaged,
  readStaged, setDocMarkups, setStagedStorageForTests, stageDocs, STAGED_CHANGE_EVENT, StagedStorageFullError, stagedKey,
  subscribeStaged, toggleStaged, toStagedDoc, unstageDoc, type StagedDoc,
} from "@/lib/stagedDocs";

// A localStorage stand-in that can be told to run out of room.
class MemStorage {
  map = new Map<string, string>();
  limit = Infinity;
  writes = 0;
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) {
    this.writes++;
    let used = 0;
    for (const [kk, vv] of this.map) if (kk !== k) used += kk.length + vv.length;
    if (used + k.length + v.length > this.limit) {
      const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e;
    }
    this.map.set(k, v);
  }
  removeItem(k: string) { this.map.delete(k); }
}

const ORG = "org-1", ORG2 = "org-2", U = "user-1", U2 = "user-2";
const doc = (n: number, lib = "lib-a"): StagedDoc => ({ id: `d${n}`, documentNumber: `5602-D 10${n}`, title: `Sheet ${n}`, rev: "1", libraryId: lib, libraryName: lib === "lib-a" ? "P&IDs" : "Procedures" });
const line = (n = 1) => ({ version: "6", objects: Array.from({ length: n }, (_, i) => ({ type: "Path", left: 10.123456 + i, top: 20.987654, scaleX: 0.416666667, scaleY: 1, path: [["M", 1.23456, 2.34567], ["L", 3.45678, 4.56789]] })) });
const ids = (o = ORG, u = U) => readStaged(o, u).docs.map((d) => d.id);

let mem: MemStorage;
beforeEach(() => { mem = new MemStorage(); setStagedStorageForTests(mem); });
afterEach(() => { setStagedStorageForTests(undefined); });

describe("staged order and dedupe", () => {
  it("keeps the order things were staged in", () => {
    stageDocs(ORG, U, [doc(1)]);
    stageDocs(ORG, U, [doc(3), doc(2)]);
    expect(ids()).toEqual(["d1", "d3", "d2"]);
  });

  it("stages a document once, keeping its first place and refreshing its details", () => {
    stageDocs(ORG, U, [doc(1), doc(2)]);
    stageDocs(ORG, U, [{ ...doc(1), rev: "2" }, doc(1), doc(3)]);
    expect(ids()).toEqual(["d1", "d2", "d3"]);
    expect(readStaged(ORG, U).docs[0].rev).toBe("2");
  });

  it("stages across libraries", () => {
    stageDocs(ORG, U, [doc(1, "lib-a"), doc(2, "lib-b")]);
    expect(new Set(readStaged(ORG, U).docs.map((d) => d.libraryId))).toEqual(new Set(["lib-a", "lib-b"]));
  });

  it("ignores a document without an id or library", () => {
    stageDocs(ORG, U, [{ ...doc(1), id: "" }, { ...doc(2), libraryId: "" }]);
    expect(ids()).toEqual([]);
  });

  it("toggles on and off", () => {
    expect(toggleStaged(ORG, U, doc(1))).toBe(true);
    expect(ids()).toEqual(["d1"]);
    expect(toggleStaged(ORG, U, doc(1))).toBe(false);
    expect(ids()).toEqual([]);
  });

  it("reads back what was kept (a fresh page load)", () => {
    stageDocs(ORG, U, [doc(1), doc(2)]);
    setStagedStorageForTests(mem); // drops the in-memory copy
    expect(ids()).toEqual(["d1", "d2"]);
    expect(readStaged(ORG, U).docs[1]).toEqual(doc(2));
  });

  it("survives a damaged value", () => {
    mem.map.set(stagedKey(ORG, U), "{not json");
    setStagedStorageForTests(mem);
    expect(ids()).toEqual([]);
    stageDocs(ORG, U, [doc(1)]);
    expect(ids()).toEqual(["d1"]);
  });
});

describe("move and remove", () => {
  beforeEach(() => { stageDocs(ORG, U, [doc(1), doc(2), doc(3)]); });

  it("moves up and down one place", () => {
    moveStaged(ORG, U, "d3", -1);
    expect(ids()).toEqual(["d1", "d3", "d2"]);
    moveStaged(ORG, U, "d1", 1);
    expect(ids()).toEqual(["d3", "d1", "d2"]);
  });

  it("does nothing past either end", () => {
    moveStaged(ORG, U, "d1", -1);
    moveStaged(ORG, U, "d3", 1);
    moveStaged(ORG, U, "nope", 1);
    expect(ids()).toEqual(["d1", "d2", "d3"]);
  });

  it("removes one, and clears all", () => {
    unstageDoc(ORG, U, "d2");
    expect(ids()).toEqual(["d1", "d3"]);
    clearStaged(ORG, U);
    expect(ids()).toEqual([]);
    expect(mem.map.size).toBe(0);
  });
});

describe("markups", () => {
  beforeEach(() => { stageDocs(ORG, U, [doc(1), doc(2), doc(3)]); });

  it("keeps a document's markups and says which are marked up", () => {
    setDocMarkups(ORG, U, "d2", { 1: line(2) });
    const s = readStaged(ORG, U);
    expect(hasMarkups(s.markups.d2)).toBe(true);
    expect(markedUpIds(s)).toEqual(["d2"]);
    setStagedStorageForTests(mem);
    expect(markedUpIds(readStaged(ORG, U))).toEqual(["d2"]);
  });

  it("keeps markups through a move", () => {
    setDocMarkups(ORG, U, "d3", { 2: line() });
    moveStaged(ORG, U, "d3", -1);
    expect(markedUpIds(readStaged(ORG, U))).toEqual(["d3"]);
  });

  it("an empty page is not a markup", () => {
    setDocMarkups(ORG, U, "d1", { 1: { objects: [] } });
    expect(markedUpIds(readStaged(ORG, U))).toEqual([]);
  });

  it("clears one document's markups", () => {
    setDocMarkups(ORG, U, "d1", { 1: line() });
    setDocMarkups(ORG, U, "d2", { 1: line() });
    setDocMarkups(ORG, U, "d1", null);
    expect(markedUpIds(readStaged(ORG, U))).toEqual(["d2"]);
  });

  it("removing a document drops its markups; clearing drops them all", () => {
    setDocMarkups(ORG, U, "d1", { 1: line() });
    setDocMarkups(ORG, U, "d2", { 1: line() });
    unstageDoc(ORG, U, "d1");
    stageDocs(ORG, U, [doc(1)]);
    expect(markedUpIds(readStaged(ORG, U))).toEqual(["d2"]);
    clearStaged(ORG, U);
    stageDocs(ORG, U, [doc(2)]);
    expect(markedUpIds(readStaged(ORG, U))).toEqual([]);
  });

  it("keeps no markups for a document that is not staged", () => {
    setDocMarkups(ORG, U, "d9", { 1: line() });
    expect(readStaged(ORG, U).markups.d9).toBeUndefined();
  });

  it("rounds numbers so freehand lines take less room", () => {
    const c = compactMarkups({ 1: line() }) as Record<number, { objects: Array<Record<string, unknown>> }>;
    expect(c[1].objects[0].left).toBe(10.123);
    expect(c[1].objects[0].scaleX).toBe(0.417);
    expect((c[1].objects[0].path as unknown[][])[0]).toEqual(["M", 1.235, 2.346]);
    expect(markupSize({ 1: line(50) })).toBeLessThan(JSON.stringify({ 1: line(50) }).length);
  });
});

describe("a full device", () => {
  beforeEach(() => { stageDocs(ORG, U, [doc(1), doc(2)]); });

  it("says so in plain words and keeps what was kept before", () => {
    setDocMarkups(ORG, U, "d1", { 1: line() });
    mem.limit = [...mem.map].reduce((n, [k, v]) => n + k.length + v.length, 0) + 50;
    let err: unknown;
    try { setDocMarkups(ORG, U, "d2", { 1: line(40) }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StagedStorageFullError);
    expect((err as Error).message).toBe(FULL_FOR_MARKUPS);
    setStagedStorageForTests(mem);
    expect(markedUpIds(readStaged(ORG, U))).toEqual(["d1"]);
    expect(ids()).toEqual(["d1", "d2"]);
  });

  it("refuses markups over the budget before trying", () => {
    const huge = { 1: { objects: [{ type: "Path", path: "x".repeat(MARKUP_BUDGET_CHARS + 10) }] } };
    const before = mem.writes;
    expect(() => setDocMarkups(ORG, U, "d1", huge)).toThrow(StagedStorageFullError);
    expect(mem.writes).toBe(before);
  });

  it("a staged list that does not fit says so", () => {
    mem.limit = 10;
    expect(() => stageDocs(ORG, U, [doc(3)])).toThrow(FULL_FOR_LIST);
    expect(ids()).toEqual(["d1", "d2"]);
  });

  it("no storage at all still works for this visit", () => {
    setStagedStorageForTests(null);
    stageDocs(ORG, U, [doc(1)]);
    expect(ids()).toEqual(["d1"]);
  });
});

describe("people and workspaces kept apart", () => {
  it("two workspaces and two people each have their own", () => {
    stageDocs(ORG, U, [doc(1)]);
    stageDocs(ORG2, U, [doc(2)]);
    stageDocs(ORG, U2, [doc(3)]);
    setDocMarkups(ORG, U, "d1", { 1: line() });
    expect(ids(ORG, U)).toEqual(["d1"]);
    expect(ids(ORG2, U)).toEqual(["d2"]);
    expect(ids(ORG, U2)).toEqual(["d3"]);
    expect(markedUpIds(readStaged(ORG2, U))).toEqual([]);
    clearStaged(ORG, U);
    expect(ids(ORG2, U)).toEqual(["d2"]);
    expect(ids(ORG, U2)).toEqual(["d3"]);
  });
});

describe("tabs in step", () => {
  const g = globalThis as unknown as { window?: EventTarget };
  let had: EventTarget | undefined;
  beforeEach(() => { had = g.window; g.window = new EventTarget(); });
  afterEach(() => { g.window = had; });

  it("this tab's change and another tab's change both reach a subscriber", () => {
    const key = stagedKey(ORG, U);
    let calls = 0;
    const off = subscribeStaged(key, () => { calls++; });
    stageDocs(ORG, U, [doc(1)]);
    expect(calls).toBe(1);
    // Another tab wrote the list: the storage event drops the copy in memory.
    mem.map.set(key, JSON.stringify({ v: 1, docs: [doc(1), doc(2)] }));
    g.window!.dispatchEvent(Object.assign(new Event("storage"), { key }));
    expect(calls).toBe(2);
    expect(ids()).toEqual(["d1", "d2"]);
    // Someone else's key is not ours.
    g.window!.dispatchEvent(Object.assign(new Event(STAGED_CHANGE_EVENT), { detail: { key: stagedKey(ORG2, U) } }));
    expect(calls).toBe(2);
    off();
    stageDocs(ORG, U, [doc(3)]);
    expect(calls).toBe(2);
  });
});

describe("toStagedDoc", () => {
  it("takes what the list needs from a document record", () => {
    expect(toStagedDoc({ id: "x", documentNumber: "P-1", title: "", rev: "B", libraryId: "L", name: "p1.pdf", status: "Issued" }, "P&IDs"))
      .toEqual({ id: "x", documentNumber: "P-1", title: null, rev: "B", libraryId: "L", libraryName: "P&IDs", name: "p1.pdf", status: "Issued" });
  });
});
