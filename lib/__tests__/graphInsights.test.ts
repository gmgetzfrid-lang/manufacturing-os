import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeInsights, insightsBasisNote } from "@/lib/graphInsights";
import type { GraphNode, GraphEdge, GraphNodeType } from "@/lib/orgGraph";

const node = (id: string, type: GraphNodeType = "document", label = id): GraphNode =>
  ({ id, type, label, href: "/", degree: 0 });

const edge = (a: string, b: string, type: GraphEdge["type"] = "tag"): GraphEdge => ({ a, b, type });

describe("computeInsights — orphans", () => {
  it("flags documents and assets with no meaningful edges", () => {
    const nodes = [node("doc:1"), node("doc:2"), node("asset:1", "asset"), node("lib:1", "library")];
    const edges = [edge("doc:1", "asset:1"), edge("doc:2", "lib:1", "library")];
    const { orphans } = computeInsights(nodes, edges);
    // doc:2 only has library membership — still an orphan. lib:1 is not orphanable.
    expect(orphans.map((o) => o.id)).toEqual(["doc:2"]);
  });

  it("does not flag connected nodes", () => {
    const nodes = [node("doc:1"), node("asset:1", "asset")];
    const { orphans } = computeInsights(nodes, [edge("doc:1", "asset:1")]);
    expect(orphans).toHaveLength(0);
  });
});

describe("computeInsights — hubs", () => {
  it("ranks by meaningful degree, requiring at least 3 connections", () => {
    const nodes = [
      node("asset:hx", "asset", "E-22"),
      node("doc:a"), node("doc:b"), node("doc:c"), node("doc:d"),
      node("doc:solo"), node("doc:pair"),
    ];
    const edges = [
      edge("doc:a", "asset:hx"), edge("doc:b", "asset:hx"),
      edge("doc:c", "asset:hx"), edge("doc:d", "asset:hx"),
      edge("doc:solo", "doc:pair", "related"),
    ];
    const { hubs } = computeInsights(nodes, edges);
    expect(hubs[0].node.id).toBe("asset:hx");
    expect(hubs[0].degree).toBe(4);
    // Degree-1 and degree-2 nodes don't qualify as hubs.
    expect(hubs.every((h) => h.degree >= 3)).toBe(true);
  });

  it("ignores library edges when computing hub degree", () => {
    const nodes = [node("lib:1", "library"), node("doc:a"), node("doc:b"), node("doc:c")];
    const edges = [
      edge("doc:a", "lib:1", "library"), edge("doc:b", "lib:1", "library"), edge("doc:c", "lib:1", "library"),
    ];
    const { hubs } = computeInsights(nodes, edges);
    expect(hubs).toHaveLength(0);
  });
});

describe("computeInsights — bridges", () => {
  // Two dense clusters joined by one edge: a star of 5 around hubA, a star
  // of 5 around hubB, and the single hubA—hubB link.
  const clusterPair = () => {
    const nodes: GraphNode[] = [node("hubA", "asset"), node("hubB", "asset")];
    const edges: GraphEdge[] = [edge("hubA", "hubB", "related")];
    for (let i = 0; i < 5; i++) {
      nodes.push(node(`a${i}`)); edges.push(edge(`a${i}`, "hubA"));
      nodes.push(node(`b${i}`)); edges.push(edge(`b${i}`, "hubB"));
    }
    return { nodes, edges };
  };

  it("finds the single thin line between two big clusters", () => {
    const { nodes, edges } = clusterPair();
    const { bridges } = computeInsights(nodes, edges, { minBridgeSide: 4 });
    expect(bridges).toHaveLength(1);
    const b = bridges[0];
    expect([b.a.id, b.b.id].sort()).toEqual(["hubA", "hubB"]);
    expect([b.sideA, b.sideB].sort((x, y) => x - y)).toEqual([6, 6]);
  });

  it("does not report a bridge when a second path exists", () => {
    const { nodes, edges } = clusterPair();
    edges.push(edge("a0", "b0")); // redundant path — no single point of failure
    const { bridges } = computeInsights(nodes, edges, { minBridgeSide: 4 });
    expect(bridges).toHaveLength(0);
  });

  // GM-5 (intelligence Round G, I-13): this case used to assert the
  // opposite — a pair carrying two edge TYPES was "redundant" and never a
  // bridge. Two edge types between the same two nodes are one relationship
  // between those two things: remove the pair and the clusters fall apart.
  it("a pair carrying two edge types is still one link — and still the bridge (GM-5)", () => {
    const { nodes, edges } = clusterPair();
    edges.push(edge("hubA", "hubB", "tag")); // second edge, different type
    const { bridges } = computeInsights(nodes, edges, { minBridgeSide: 4 });
    expect(bridges).toHaveLength(1);
    expect([bridges[0].a.id, bridges[0].b.id].sort()).toEqual(["hubA", "hubB"]);
  });

  it("GM-5: two clusters joined only by a drawing that is both TAGGED to a vessel and NAMES it in its text report that bridge", () => {
    // Unit 44's cluster around PID-4402; Unit 20's around E-2201. The only
    // tie between them is the PID-4402 ↔ E-2201 pair, carrying a tag edge
    // (document_assets) AND a mention edge (entity_mentions).
    const nodes: GraphNode[] = [node("doc:pid4402"), node("asset:e2201", "asset", "E-2201")];
    const edges: GraphEdge[] = [edge("doc:pid4402", "asset:e2201", "tag"), edge("doc:pid4402", "asset:e2201", "mention")];
    for (let i = 0; i < 5; i++) {
      nodes.push(node(`asset:u44-${i}`, "asset")); edges.push(edge("doc:pid4402", `asset:u44-${i}`, "tag"));
      nodes.push(node(`doc:u20-${i}`)); edges.push(edge(`doc:u20-${i}`, "asset:e2201", "tag"));
    }
    const { bridges } = computeInsights(nodes, edges, { minBridgeSide: 4 });
    expect(bridges).toHaveLength(1);
    expect([bridges[0].a.id, bridges[0].b.id].sort()).toEqual(["asset:e2201", "doc:pid4402"]);
    expect([bridges[0].sideA, bridges[0].sideB].sort((x, y) => x - y)).toEqual([6, 6]);
  });

  it("GM-5: a flow in each direction between two hubs is one link too", () => {
    const { nodes, edges } = clusterPair();
    edges.push(edge("hubA", "hubB", "flow"), edge("hubB", "hubA", "flow"));
    expect(computeInsights(nodes, edges, { minBridgeSide: 4 }).bridges).toHaveLength(1);
  });

  it("GM-5: nothing but the side-size floor can keep a thin link off the list (the empty state's 'every big neighbourhood' is then true)", () => {
    const src = readFileSync("lib/graphInsights.ts", "utf8").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/multiplicity/);
    expect(src).toMatch(/if \(low\.get\(u\)! > disc\.get\(parent\)!\) \{/);
  });

  it("suppresses leaf edges below the minimum side size", () => {
    // Every star spoke is technically a bridge; sides of 1 are noise.
    const nodes = [node("hub", "asset"), node("d1"), node("d2"), node("d3")];
    const edges = [edge("d1", "hub"), edge("d2", "hub"), edge("d3", "hub")];
    const { bridges } = computeInsights(nodes, edges, { minBridgeSide: 4 });
    expect(bridges).toHaveLength(0);
  });
});

describe("computeInsights — regions", () => {
  it("names a component after its unit anchor when one exists", () => {
    const nodes: GraphNode[] = [node("cbunit:20", "unit", "Crude Unit")];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 9; i++) {
      nodes.push(node(`asset:${i}`, "asset", `E-${i}`));
      edges.push(edge(`asset:${i}`, "cbunit:20", "unit"));
    }
    const { regions } = computeInsights(nodes, edges, { minRegionSize: 8 });
    expect(regions).toHaveLength(1);
    expect(regions[0].label).toBe("Crude Unit");
    expect(regions[0].ids).toHaveLength(10);
  });

  it("GM-9: a plot plan in a unit's component never takes the region's name", () => {
    const nodes: GraphNode[] = [node("cbunit:20", "unit", "Crude Unit"), node("plot:site", "plot", "Site Plot Plan Rev C")];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(node(`asset:${i}`, "asset", `E-${i}`));
      edges.push(edge(`asset:${i}`, "cbunit:20", "unit"), edge("plot:site", `asset:${i}`, "plot"));
    }
    const { regions } = computeInsights(nodes, edges, { minRegionSize: 8 });
    expect(regions).toHaveLength(1);
    expect(regions[0].label).toBe("Crude Unit");
  });

  it("GM-9: every node type is ranked — the rank table is a Record over GraphNodeType (a missing type is a compile error)", () => {
    const src = readFileSync("lib/graphInsights.ts", "utf8");
    expect(src).toMatch(/const REGION_ANCHOR_RANK: Record<GraphNodeType, number> = \{/);
    expect(src).not.toMatch(/REGION_ANCHOR_ORDER/);
  });

  it("skips components smaller than the minimum", () => {
    const nodes = [node("doc:1"), node("doc:2")];
    const { regions } = computeInsights(nodes, [edge("doc:1", "doc:2", "related")], { minRegionSize: 8 });
    expect(regions).toHaveLength(0);
  });
});

describe("computeInsights — basis (GM-6)", () => {
  it("is always labelled viewer-scoped, with the count the reader cannot see when it is known", () => {
    const nodes = [node("doc:1"), node("asset:1", "asset")];
    const edges = [edge("doc:1", "asset:1")];
    expect(computeInsights(nodes, edges).basis).toEqual({ viewerScoped: true, outsideAccess: null, note: "Computed on the documents you can see." });
    const hidden = computeInsights(nodes, edges, { access: { documentsVisible: 1, documentsTotal: 4, outsideAccess: 3 } }).basis;
    expect(hidden.outsideAccess).toBe(3);
    expect(hidden.note).toBe("Computed on the documents you can see — 3 more are outside your access, so another reader may get different answers.");
    expect(insightsBasisNote({ documentsVisible: 4, documentsTotal: 4, outsideAccess: 0 })).toBe("Computed on the documents on this map; none of the org's documents are hidden from you.");
  });

  it("never claims 'every document in the org': a scoped map makes no total claim, and a capped map says how many are drawn", () => {
    expect(insightsBasisNote({ documentsVisible: 40, documentsTotal: null, outsideAccess: null, documentsDrawn: 40, scoped: true }))
      .toBe("Computed on the documents in this scope that you can see — documents outside your access are not in it, so another reader may get different answers.");
    expect(insightsBasisNote({ documentsVisible: 4000, documentsTotal: 4000, outsideAccess: 0, documentsDrawn: 1500, scoped: false }))
      .toBe("Computed on the documents on this map; none of the org's documents are hidden from you, but only 1,500 of 4,000 are drawn (a cap).");
    expect(insightsBasisNote({ documentsVisible: 4000, documentsTotal: 4100, outsideAccess: 100, documentsDrawn: 1500, scoped: false }))
      .toBe("Computed on the documents you can see — 100 more are outside your access, so another reader may get different answers. Only 1,500 of the 4,000 documents you can see are on this map (a cap).");
    // a scope that knows a floor of hidden documents still makes no org-wide claim
    expect(insightsBasisNote({ documentsVisible: 39, documentsTotal: null, outsideAccess: null, documentsDrawn: 39, scoped: true })).not.toMatch(/none of the org|every document/);
    for (const a of [
      null, undefined,
      { documentsVisible: 1, documentsTotal: 1, outsideAccess: 0 },
      { documentsVisible: 1, documentsTotal: 1, outsideAccess: 0, documentsDrawn: 1, scoped: true },
      { documentsVisible: 2000, documentsTotal: 2000, outsideAccess: 0, documentsDrawn: 1500 },
      { documentsVisible: null, documentsTotal: null, outsideAccess: null, scoped: true },
    ]) {
      expect(insightsBasisNote(a)).not.toMatch(/every document in the org|you can see all of them/);
    }
  });
});
