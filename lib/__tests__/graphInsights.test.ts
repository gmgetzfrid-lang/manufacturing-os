import { describe, it, expect } from "vitest";
import { computeInsights } from "@/lib/graphInsights";
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

  it("does not report a parallel-edged pair as a bridge", () => {
    const { nodes, edges } = clusterPair();
    edges.push(edge("hubA", "hubB", "tag")); // second edge, different type
    const { bridges } = computeInsights(nodes, edges, { minBridgeSide: 4 });
    expect(bridges).toHaveLength(0);
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

  it("skips components smaller than the minimum", () => {
    const nodes = [node("doc:1"), node("doc:2")];
    const { regions } = computeInsights(nodes, [edge("doc:1", "doc:2", "related")], { minRegionSize: 8 });
    expect(regions).toHaveLength(0);
  });
});
