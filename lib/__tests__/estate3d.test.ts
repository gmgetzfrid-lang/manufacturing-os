import { describe, it, expect } from "vitest";
import { estateGlobe, capDirections, groupDocuments, HUB } from "@/lib/estate3d";
import type { GraphNode, GraphEdge } from "@/lib/orgGraph";

const N = (id: string, type: GraphNode["type"], label: string): GraphNode => ({ id, type, label, href: "#", degree: 0 });
const dist = (p: number[]) => Math.hypot(p[0], p[1], p[2]);

describe("the estate as a globe in 3D", () => {
  const nodes = [N("cbunit:20", "unit", "Crude"), N("cbunit:30", "unit", "Vacuum"), N("asset:v", "asset", "V-14"), N("doc:s", "document", "SHT05"), N("doc:lost", "document", "Lost"), N("lib:a", "library", "P&IDs")];
  const edges: GraphEdge[] = [
    { a: "asset:v", b: "cbunit:20", type: "unit", why: "The registry files V-14 under Crude" },
    { a: "doc:s", b: "asset:v", type: "tag", why: "V-14 is tagged on SHT05" },
    { a: "doc:lost", b: "lib:a", type: "library" },
  ];

  it("folds documents into a count until opened, and opening moves nothing else", () => {
    const shut = estateGlobe(nodes, edges);
    expect(shut.nodes.some((n) => n.id === "doc:s")).toBe(false);
    expect(shut.nodes.find((n) => n.id === "asset:v")?.label).toBe("V-14 · 1 doc");
    expect(shut.info.get("asset:v")).toMatchObject({ kind: "asset", docs: 1, openable: true, open: false });
    const opened = estateGlobe(nodes, edges, { open: new Set(["asset:v"]) });
    expect(opened.nodes.some((n) => n.id === "doc:s")).toBe(true);
    expect(opened.pos["asset:v"]).toEqual(shut.pos["asset:v"]);
    expect(opened.pos["cbunit:30"]).toEqual(shut.pos["cbunit:30"]);
    expect(dist(opened.pos["doc:s"])).toBeGreaterThan(dist(opened.pos["asset:v"]));
  });

  it("puts areas around the site, carries why each link exists", () => {
    const r = estateGlobe(nodes, edges, { open: new Set(["asset:v"]) });
    expect(r.pos[HUB]).toEqual([0, 0, 0]);
    expect(Math.abs(dist(r.pos["cbunit:20"]) - dist(r.pos["cbunit:30"]))).toBeLessThan(1);
    expect(r.edges.find((e) => e.a === "cbunit:20" && e.b === "asset:v")?.why).toBe("The registry files V-14 under Crude");
    expect(r.edges.find((e) => e.a === "asset:v" && e.b === "doc:s")?.why).toBe("V-14 is tagged on SHT05");
    // Documents placed nowhere are not lost: "Not placed yet" holds them.
    expect(r.nodes.find((n) => n.id === "__unplaced__")?.label).toMatch(/Not placed yet/);
    const spots = new Set(Object.values(r.pos).map((p) => p.map((v) => Math.round(v)).join(",")));
    expect(spots.size).toBe(Object.keys(r.pos).length);
  });

  it("hides what the lens hides", () => {
    const r = estateGlobe(nodes, edges, { hiddenTypes: ["document"] });
    expect(r.info.get("asset:v")?.docs).toBe(0);
  });

  it("splits hundreds of documents into named groups", () => {
    const docs = Array.from({ length: 380 }, (_, i) => ({ id: `d${i}`, label: `EP-${10 + (i % 9)}-${i}` }));
    const g = groupDocuments(docs);
    expect(g.length).toBeGreaterThan(1);
    expect(g.length).toBeLessThanOrEqual(14);
    expect(g[0].label).toMatch(/^EP-10 \(\d+\)$/);
    expect(g.reduce((s, x) => s + x.ids.length, 0)).toBe(380);
    // A real mix: nine numbered series plus sixty one-offs.
    const mix = [...Array.from({ length: 320 }, (_, i) => ({ id: `s${i}`, label: `EP-${10 + (i % 9)}-${i % 13}-${i % 5}` })), ...Array.from({ length: 60 }, (_, i) => ({ id: `o${i}`, label: `EP-${30 + i}` }))];
    const gm = groupDocuments(mix);
    expect(gm.length).toBeLessThanOrEqual(14);
    expect(gm.filter((x) => /^EP-1\d \(\d+\)$/.test(x.label))).toHaveLength(9);
    expect(gm.reduce((s, x) => s + x.ids.length, 0)).toBe(380);
    const flat = groupDocuments(Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, label: `Report ${i}` })));
    expect(flat.reduce((s, x) => s + x.ids.length, 0)).toBe(60);
    expect(flat.length).toBeLessThanOrEqual(14);
  });

  it("spreads directions evenly inside a cap", () => {
    const d = capDirections([0, 1, 0], 12, 0.6);
    expect(d).toHaveLength(12);
    for (const v of d) { expect(Math.abs(dist(v) - 1)).toBeLessThan(1e-9); expect(Math.acos(v[1])).toBeLessThanOrEqual(0.6 + 1e-9); }
  });
});
