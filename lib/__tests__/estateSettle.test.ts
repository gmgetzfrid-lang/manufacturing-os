// What the machine recorded earlier is checked again on every run: a link
// it applied stands only while the rules still prove it, a question it left
// in Review only while it would still ask it. A person's link is never
// touched. These pin the cases this site had.

import { describe, it, expect } from "vitest";
import { folderUnitsFrom, settleStored, type StoredEdge } from "@/lib/estate/settle";
import { byPerson, originRank, strongestEdge } from "@/lib/estate/ids";
import type { ProposedEdge } from "@/lib/estate/resolver";

const edge = (o: Partial<StoredEdge> & { id: string; a: string; b: string }): StoredEdge => ({ type: "belongs_to_unit", origin: "resolver", status: "applied", decidedBy: null, ...o });
const prop = (a: string, b: string, tier: ProposedEdge["tier"], summary = "today's reason"): ProposedEdge => ({ a, b, type: "belongs_to_unit", origin: tier === "provable" ? "codebook" : "resolver", tier, confidence: tier === "provable" ? 1 : 0.8, summary, evidence: {} });

describe("settleStored", () => {
  it("keeps a link the rules still prove", () => {
    const plan = settleStored([edge({ id: "1", a: "folder:t", b: "cbunit:55" })], [prop("folder:t", "cbunit:55", "provable")], new Set(["folder:t"]));
    expect(plan).toEqual({ demote: [], promote: [], remove: [], gone: [] });
  });
  it("steps a link down to a question when the name alone no longer proves it", () => {
    // "9 - Storage Tanks" was applied to Storage (72) from one word.
    const plan = settleStored([edge({ id: "1", a: "folder:s9", b: "cbunit:72", origin: "codebook" })], [prop("folder:s9", "cbunit:72", "strong", "says Storage by name")], new Set(["folder:s9"]));
    expect(plan.demote).toEqual([expect.objectContaining({ id: "1", tier: "strong", summary: "says Storage by name" })]);
    expect(plan.remove).toEqual([]);
  });
  it("takes away a link nothing says any more: a file under a folder whose link went", () => {
    // 850 standards were "under a folder linked to Engineering (10)".
    const plan = settleStored([edge({ id: "1", a: "doc:d", b: "cbunit:10" })], [], new Set(["doc:d"]));
    expect(plan.remove).toEqual(["1"]);
  });
  it("takes away a question built on a guess, and applies one that is proven now", () => {
    const stored = [
      edge({ id: "q1", a: "doc:d", b: "cbunit:41", status: "pending" }),   // "names Hot Box but is filed under Engineering"
      edge({ id: "q2", a: "folder:t", b: "cbunit:55", status: "pending" }),
      edge({ id: "q3", a: "doc:e", b: "cbunit:20", status: "pending" }),   // still asked
    ];
    const plan = settleStored(stored, [prop("folder:t", "cbunit:55", "provable"), prop("doc:e", "cbunit:20", "strong")], new Set(["doc:d", "folder:t", "doc:e"]));
    expect(plan.remove).toEqual(["q1"]);
    expect(plan.promote.map((p) => p.id)).toEqual(["q2"]);
    expect(plan.demote).toEqual([]);
  });
  it("never touches a person's link, or one a person decided", () => {
    const stored = [
      edge({ id: "h1", a: "folder:x", b: "cbunit:79", origin: "human" }),
      edge({ id: "h2", a: "folder:y", b: "cbunit:20", origin: "person" }),
      edge({ id: "h3", a: "doc:z", b: "cbunit:72", origin: "resolver", decidedBy: "u1" }),
    ];
    const plan = settleStored(stored, [], new Set(["folder:x", "folder:y", "doc:z"]), new Set(["folder:x"]));
    expect(plan).toEqual({ demote: [], promote: [], remove: [], gone: [] });
  });
  it("leaves alone what the run did not look at, and other kinds of link", () => {
    const stored = [
      edge({ id: "1", a: "doc:old", b: "cbunit:10" }),
      edge({ id: "2", a: "doc:d", b: "asset:a1", type: "tagged_to", origin: "vision" }),
      edge({ id: "3", a: "doc:d", b: "cbunit:10", status: "dismissed" }),
    ];
    expect(settleStored(stored, [], new Set(["doc:d"]))).toEqual({ demote: [], promote: [], remove: [], gone: [] });
  });
  it("takes away what the machine recorded on a folder or file that no longer exists, of any kind", () => {
    const stored = [
      edge({ id: "1", a: "folder:dead", b: "cbunit:10" }),
      edge({ id: "2", a: "doc:dead", b: "asset:a1", type: "tagged_to", origin: "vision" }),
      edge({ id: "3", a: "term:STANDARD", b: "cbunit:10", type: "alias_of", status: "pending", evidence: { folder: "folder:dead" } }),
    ];
    const plan = settleStored(stored, [], new Set(), new Set(["folder:dead", "doc:dead"]));
    expect(plan.gone.sort()).toEqual(["1", "2", "3"]);
  });
  it("a nickname proposed from a folder goes when that folder no longer suggests it", () => {
    const stored = [edge({ id: "1", a: "term:STANDARD", b: "cbunit:10", type: "alias_of", status: "pending", evidence: { folder: "folder:sd" } })];
    expect(settleStored(stored, [], new Set(["folder:sd"])).remove).toEqual(["1"]);
    expect(settleStored(stored, [], new Set(["folder:other"])).remove).toEqual([]);
  });
});

describe("who drew a link", () => {
  it("a person first, then the site's numbers, then a reading, then what was worked out", () => {
    expect(["resolver", "vision", "codebook", "human", "person", "bridge"].sort((a, b) => originRank(a) - originRank(b)).slice(0, 3)).toEqual(["human", "person", "codebook"]);
    expect(byPerson("human")).toBe(true);
    expect(byPerson("person")).toBe(true);
    expect(byPerson("codebook")).toBe(false);
    expect(strongestEdge([{ origin: "codebook", b: 1 }, { origin: "human", b: 2 }, { origin: "resolver", b: 3 }])).toMatchObject({ b: 2 });
    expect(strongestEdge([])).toBeNull();
  });
  it("a folder's unit is the person's, whatever order the rows come in", () => {
    // The folder a person marked Crude Department (79) also had the guess Crude Unit (20).
    const rows = [
      { a: "folder:f", b: "cbunit:79", type: "belongs_to_unit", origin: "human" },
      { a: "folder:f", b: "cbunit:20", type: "belongs_to_unit", origin: "codebook" },
      { a: "folder:g", b: "cbunit:55", type: "belongs_to_unit", origin: "codebook" },
      { a: "doc:d", b: "cbunit:55", type: "belongs_to_unit", origin: "resolver" },
      { a: "folder:f", b: "proj:p", type: "in_project", origin: "resolver" },
    ];
    for (const list of [rows, [...rows].reverse()]) {
      const r = folderUnitsFrom(list);
      expect(r.units.get("f")).toBe("79");
      expect(r.units.get("g")).toBe("55");
      expect(r.units.has("d")).toBe(false);
      expect([...r.byPerson]).toEqual(["f"]);
    }
  });
});

describe("where a tag sits on a sheet", () => {
  it("is said only from the measured place (0 to 1 from the top left)", async () => {
    const { sheetQuarter } = await import("@/lib/find/types");
    expect(sheetQuarter(0.2, 0.1)).toBe("upper left");
    expect(sheetQuarter(0.8, 0.9)).toBe("lower right");
    // Raw PDF points (612, 340) are not a place on the page: nothing is said.
    expect(sheetQuarter(612, 340)).toBe("");
    expect(sheetQuarter(null, 0.4)).toBe("");
  });
});

describe("which same-named equipment a tag on a sheet is", () => {
  // The site's three E-22s.
  const e22 = [
    { id: "tm", tag: "E-22", unit_code: "55" },
    { id: "lru", tag: "E-22", unit_code: "56" },
    { id: "kht", tag: "E-22", unit_code: "30" },
  ];
  it("the one the sheet itself is linked to (by the ID printed beside the tag)", async () => {
    const { assetOnSheet } = await import("@/lib/find/assetMatch");
    expect(assetOnSheet(e22, new Set(["lru"]), ["55"])?.id).toBe("lru");
  });
  it("else the one in the sheet's unit", async () => {
    const { assetOnSheet } = await import("@/lib/find/assetMatch");
    expect(assetOnSheet(e22, undefined, ["30"])?.id).toBe("kht");
  });
  it("else none of them: never whichever came first", async () => {
    const { assetOnSheet } = await import("@/lib/find/assetMatch");
    expect(assetOnSheet(e22, undefined, [])).toBeNull();
    expect(assetOnSheet(e22, new Set(["other"]), ["20"])).toBeNull();
  });
  it("a name only one piece of equipment has is that one", async () => {
    const { assetOnSheet } = await import("@/lib/find/assetMatch");
    expect(assetOnSheet([e22[0]], undefined, [])?.id).toBe("tm");
    expect(assetOnSheet([], undefined, ["55"])).toBeNull();
  });
});
