import { describe, it, expect } from "vitest";
import { foldLeaves } from "@/lib/graphFold";

const hub = { id: "lib:eng", type: "library", label: "Engineering" };
const docs = Array.from({ length: 6 }, (_, i) => ({ id: `doc:${i}`, type: "document", label: `D${i}` }));
const asset = { id: "asset:v101", type: "asset", label: "V-101" };
const edges = [...docs.map((d) => ({ a: d.id, b: hub.id })), { a: "doc:0", b: asset.id }];

describe("folding the starburst", () => {
  it("folds documents whose only link is the hub, keeps the ones that link elsewhere", () => {
    const r = foldLeaves([hub, asset, ...docs], edges, { open: new Set() });
    expect(r.folded.get(hub.id)).toBe(5);
    expect(r.nodes.map((n) => n.id).sort()).toEqual(["asset:v101", "doc:0", "lib:eng"]);
    expect(r.nodes.find((n) => n.id === hub.id)?.label).toBe("Engineering (+5)");
    expect(r.edges).toEqual([{ a: "doc:0", b: hub.id }, { a: "doc:0", b: asset.id }]);
  });
  it("leaves an opened hub alone", () => {
    const r = foldLeaves([hub, asset, ...docs], edges, { open: new Set([hub.id]) });
    expect(r.folded.size).toBe(0);
    expect(r.nodes.length).toBe(8);
  });
  it("does not fold a hub with only a few lone documents", () => {
    const r = foldLeaves([hub, ...docs.slice(0, 3)], docs.slice(0, 3).map((d) => ({ a: d.id, b: hub.id })), { open: new Set() });
    expect(r.folded.size).toBe(0);
  });
});
