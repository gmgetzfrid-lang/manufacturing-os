import { describe, it, expect } from "vitest";
import { layeredEstate } from "@/lib/estate3d";
import type { GraphNode, GraphEdge } from "@/lib/orgGraph";

const N = (id: string, type: GraphNode["type"], label: string): GraphNode => ({ id, type, label, href: "#", degree: 0 });
describe("the estate standing up in 3D", () => {
  it("puts areas on the floor and each level above its parent, unplaced documents folded", () => {
    const nodes = [N("cbunit:20", "unit", "Crude"), N("asset:v", "asset", "V-14"), N("doc:s", "document", "SHT05"), N("doc:lost", "document", "Lost")];
    const edges: GraphEdge[] = [{ a: "asset:v", b: "cbunit:20", type: "unit" }, { a: "doc:s", b: "asset:v", type: "tag" }];
    const r = layeredEstate(nodes, edges);
    expect(r.pos["cbunit:20"][1]).toBe(0);
    expect(r.pos["asset:v"][1]).toBeGreaterThan(r.pos["cbunit:20"][1]);
    expect(r.pos["doc:s"][1]).toBeGreaterThan(r.pos["asset:v"][1]);
    expect(r.nodes.some((n) => n.id === "doc:lost")).toBe(false);
    expect(r.nodes.find((n) => n.id === "__unplaced__")?.label).toBe("Not placed yet (1)");
    expect(r.edges).toContainEqual({ a: "asset:v", b: "doc:s", type: "tag" });
    // no two nodes share a spot
    const spots = new Set(Object.values(r.pos).map((p) => p.map((v) => Math.round(v)).join(",")));
    expect(spots.size).toBe(Object.keys(r.pos).length);
  });
});
