// @vitest-environment jsdom
//
// intelligence Round G (I-14) fix pass 3 — the renderers' per-frame work.
//
// With arrows on (the default since GPV-8), both renderers built
// `new Map(ns.map(...))` over EVERY node on EVERY animation frame, only to
// look up each arrowhead's target radius. The index is now built once per
// node set (lib/graphView.ts nodeIndexer) and reused frame after frame.
//
// The 2D renderer is driven here frame by frame (a stub canvas context and a
// hand-run requestAnimationFrame); the 3D renderer needs WebGL, which jsdom
// does not have, so it is pinned structurally — its frame loop reads the
// same indexer and builds no node map of its own.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import OrgGraph2D from "@/components/graph/OrgGraph2D";
import { GraphSim } from "@/lib/graphSim";
import { DEFAULT_GRAPH_SETTINGS } from "@/lib/graphSettings";
import type { GraphEdge, GraphNode } from "@/lib/orgGraph";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let frames: Array<FrameRequestCallback> = [];
let calls: Record<string, number> = {};
let host: HTMLDivElement;
let root: Root;

/** A canvas 2D context that accepts every call and counts them. */
const stubContext = () => new Proxy({}, {
  get(_t, prop: string) {
    return (..._args: unknown[]) => {
      calls[prop] = (calls[prop] ?? 0) + 1;
      if (prop === "measureText") return { width: 10 };
      if (prop === "createRadialGradient") return { addColorStop: () => undefined };
      return undefined;
    };
  },
  set() { return true; },
});

/** A node array that counts how often `.map` is called on it. */
function counted(nodes: GraphNode[]): { nodes: GraphNode[]; maps: () => number } {
  let n = 0;
  Object.defineProperty(nodes, "map", {
    value(this: GraphNode[], ...args: Parameters<GraphNode[]["map"]>) { n += 1; return Array.prototype.map.apply(this, args as never); },
  });
  return { nodes, maps: () => n };
}

const node = (id: string, type: GraphNode["type"], degree = 1): GraphNode => ({ id, type, label: id, href: "/", degree });

function mapFixture() {
  const nodes = [node("asset:a", "asset", 2), node("asset:b", "asset", 2), node("cbunit:20", "unit", 2)];
  const edges: GraphEdge[] = [{ a: "asset:a", b: "asset:b", type: "flow" }, { a: "asset:a", b: "cbunit:20", type: "unit" }, { a: "asset:b", b: "cbunit:20", type: "unit" }];
  const sim = new GraphSim();
  sim.setGraph(nodes.map((x) => ({ id: x.id, mass: 1 })), edges.map((e) => ({ a: e.a, b: e.b, strength: 1 })),
    { restore: { "asset:a": [-20, 0, 0], "asset:b": [20, 0, 0], "cbunit:20": [0, 20, 0] } });
  return { nodes, edges, sim };
}

const props = (nodes: GraphNode[], edges: GraphEdge[], sim: GraphSim, showArrows = true) => ({
  nodes, edges, sim, settings: { ...DEFAULT_GRAPH_SETTINGS, showArrows }, query: "", selectedId: null,
  highlightIds: new Set<string>(), pathIds: new Set<string>(), regions: [], flyTo: null,
  onSelect: () => undefined, onOpen: () => undefined,
});

const runFrames = async (k: number) => {
  for (let i = 0; i < k; i++) {
    const f = frames.shift();
    expect(f).toBeTruthy();
    await act(async () => { f!(performance.now()); });
  }
};

beforeEach(() => {
  frames = []; calls = {};
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => stubContext() as unknown as CanvasRenderingContext2D);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("OrgGraph2D — the node index is built per node set, never per frame (fix pass 3)", () => {
  it("arrows on: six frames, one index — and the flow's arrowhead is still drawn", async () => {
    const { nodes, edges, sim } = mapFixture();
    const c = counted(nodes);
    await act(async () => { root.render(React.createElement(OrgGraph2D, props(c.nodes, edges, sim))); });
    await runFrames(6);
    expect(c.maps()).toBe(1);
    // The flow's arrowhead (a closed triangle, the only closePath the 2D
    // map draws) still lands, sized by the target node the index finds.
    expect(calls.closePath ?? 0).toBeGreaterThan(0);
  });

  it("a re-render with the same node array reuses the index; a new node set builds one more", async () => {
    const { nodes, edges, sim } = mapFixture();
    const c = counted(nodes);
    await act(async () => { root.render(React.createElement(OrgGraph2D, props(c.nodes, edges, sim))); });
    await runFrames(2);
    await act(async () => { root.render(React.createElement(OrgGraph2D, { ...props(c.nodes, [...edges], sim), query: "a" })); });
    await runFrames(2);
    expect(c.maps()).toBe(1);
    const next = counted([...nodes]);
    await act(async () => { root.render(React.createElement(OrgGraph2D, props(next.nodes, edges, sim))); });
    await runFrames(3);
    expect(next.maps()).toBe(1);
    expect(c.maps()).toBe(1);
  });

  it("arrows off: no index is built and no arrowhead is drawn (as before)", async () => {
    const { nodes, edges, sim } = mapFixture();
    const c = counted(nodes);
    await act(async () => { root.render(React.createElement(OrgGraph2D, props(c.nodes, edges, sim, false))); });
    await runFrames(3);
    expect(c.maps()).toBe(0);
    expect(calls.closePath ?? 0).toBe(0);
  });
});

describe("OrgGraph3D — the frame loop reads the same per-node-set index (structural pin)", () => {
  const src = (f: string) => readFileSync(join(process.cwd(), "components/graph", f), "utf8");

  it.each(["OrgGraph2D.tsx", "OrgGraph3D.tsx"])("%s builds no node map inside its frame loop", (f) => {
    const s = src(f);
    expect(s).not.toMatch(/new Map\(\s*ns\.map\(/);
    expect(s).toMatch(/const indexNodes = nodeIndexer\(\);/);
    expect(s).toMatch(/const nodeById = st\.showArrows \? indexNodes\(ns\) : null;/);
    // The indexer is created once per mount (in the effect), not per frame.
    const created = s.indexOf("const indexNodes = nodeIndexer();");
    const frameStart = f === "OrgGraph3D.tsx" ? s.indexOf("const frame = () => {") : s.indexOf("const draw = () => {");
    expect(created).toBeGreaterThan(0);
    expect(frameStart).toBeGreaterThan(created);
  });
});
