import { describe, it, expect } from "vitest";
import { estateGlobe, capDirections } from "@/lib/estate3d";
import type { GraphNode, GraphEdge } from "@/lib/orgGraph";

const N = (id: string, type: GraphNode["type"], label: string): GraphNode => ({ id, type, label, href: "#", degree: 0 });
const dist = (p: number[]) => Math.hypot(p[0], p[1], p[2]);

describe("the estate as a globe in 3D", () => {
  it("puts areas around a sphere and each level further out than its parent, unplaced documents folded", () => {
    const nodes = [N("cbunit:20", "unit", "Crude"), N("cbunit:30", "unit", "Vacuum"), N("asset:v", "asset", "V-14"), N("doc:s", "document", "SHT05"), N("doc:lost", "document", "Lost")];
    const edges: GraphEdge[] = [{ a: "asset:v", b: "cbunit:20", type: "unit" }, { a: "doc:s", b: "asset:v", type: "tag" }];
    const r = estateGlobe(nodes, edges);
    expect(Math.abs(dist(r.pos["cbunit:20"]) - dist(r.pos["cbunit:30"]))).toBeLessThan(1);
    expect(dist(r.pos["asset:v"])).toBeGreaterThan(dist(r.pos["cbunit:20"]));
    expect(dist(r.pos["doc:s"])).toBeGreaterThan(dist(r.pos["asset:v"]));
    expect(r.nodes.some((n) => n.id === "doc:lost")).toBe(false);
    expect(r.nodes.find((n) => n.id === "__unplaced__")?.label).toBe("Not placed yet (1)");
    expect(r.edges).toContainEqual({ a: "asset:v", b: "doc:s", type: "tag" });
    const spots = new Set(Object.values(r.pos).map((p) => p.map((v) => Math.round(v)).join(",")));
    expect(spots.size).toBe(Object.keys(r.pos).length);
  });

  it("spreads directions evenly inside a cap", () => {
    const d = capDirections([0, 1, 0], 12, 0.6);
    expect(d).toHaveLength(12);
    for (const v of d) { expect(Math.abs(dist(v) - 1)).toBeLessThan(1e-9); expect(Math.acos(v[1])).toBeLessThanOrEqual(0.6 + 1e-9); }
  });
});
