// intelligence Round G (I-14) — what the /graph page does with an assembled
// graph (lib/graphView.ts), plus the insights it shows (GM-1).
//
//   * GM-1: the insights are computed on the whole assembled map, so a lens
//     never manufactures an orphan; the slice is only a display filter.
//   * GPV-9: focus mode keeps each node's hop distance for the renderers.
//   * GPV-12: an answer's node ids split into shown / hidden by a type
//     (with the type, to unhide) / outside the focus / not on the map.
//   * GPV-7 / AREA-10: Connect writes a flow end by the node's own codebook
//     identity and refuses an operational unit with none, a system, or a
//     mixed pair; the optimistic edge uses the ids the rebuild draws.
//   * GPV-13: the keyboard's walk over the map.
//   * IRLS-14: no mention links — which case, and the next step.
//   * GPV-8 / FLOW-10 / GPV-14 / GPV-4: the tables both renderers draw by.

import { describe, it, expect } from "vitest";
import {
  sliceView, viewDegree, answerVisibility, flowEndpoint, planConnect, connectOffer, keyboardOrder, mentionNotice,
  CONNECT_PAIR_MESSAGE,
} from "@/lib/graphView";
import { computeInsights } from "@/lib/graphInsights";
import { lensByKey, DEFAULT_GRAPH_SETTINGS } from "@/lib/graphSettings";
import type { GraphEdge, GraphNode, GraphNodeType, OrgGraph } from "@/lib/orgGraph";
import { baseEdgeAlpha, ARROW_MIN_ALPHA } from "@/components/graph/OrgGraph2D";
import {
  ARROW_EDGE_TYPES, ACCENT, PATH_RGB, EDGE_RGB, EDGE_LABELS, EDGE_LEGEND, edgeRgbFor, edgeLabelFor,
  unitVariant, nodeColorFor, UNIT_VARIANT_COLORS, NODE_COLORS,
} from "@/components/graph/graphTheme";
import { DIRECTED_EDGE_TYPES } from "@/lib/orgGraph";

const n = (id: string, type: GraphNodeType, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, type, label: extra.label ?? id, href: "/", degree: extra.degree ?? 0, ...extra });
const e = (a: string, b: string, type: GraphEdge["type"] = "tag"): GraphEdge => ({ a, b, type });

const filter = (over: Partial<typeof DEFAULT_GRAPH_SETTINGS> = {}) => ({
  hiddenTypes: DEFAULT_GRAPH_SETTINGS.hiddenTypes, showLibraryEdges: DEFAULT_GRAPH_SETTINGS.showLibraryEdges,
  hideUnlinked: false, showProposals: true, localDepth: 2, ...over,
});

// A small plant: Crude Unit 20 with two pumps; a P&ID tags one; a drawing in
// a library and nothing else; a plot plan marks the second pump.
const graph: OrgGraph = {
  nodes: [
    n("cbunit:20", "unit", { label: "Crude Unit", unitCode: "20" }),
    n("unit:op-1", "unit", { label: "Coker (operational)", unitCode: null }),
    n("system:s1", "unit", { label: "Overhead system", unitCode: "20" }),
    n("asset:p1", "asset", { label: "P-101", degree: 3 }),
    n("asset:p2", "asset", { label: "P-102", degree: 2 }),
    n("doc:pid", "document", { label: "PID-1", degree: 2 }),
    n("doc:loose", "document", { label: "LOOSE-1", degree: 1 }),
    n("lib:L", "library", { label: "P&IDs" }),
    n("plot:pp", "plot", { label: "Plot plan" }),
  ],
  edges: [
    e("asset:p1", "cbunit:20", "unit"),
    e("asset:p2", "cbunit:20", "unit"),
    e("doc:pid", "asset:p1", "tag"),
    e("doc:pid", "lib:L", "library"),
    e("doc:loose", "lib:L", "library"),
    e("plot:pp", "asset:p2", "plot"),
    e("system:s1", "cbunit:20", "unit"),
    e("asset:p1", "asset:p2", "flow"),
  ],
  truncations: [],
};

describe("GM-1 — insights are the whole map's, whatever the lens shows", () => {
  it("hiding the unit and plot types does not orphan equipment whose only tie is a hidden-type edge", () => {
    // P-102 is tied only to its unit and the plot plan that marks it.
    const g = { ...graph, edges: graph.edges.filter((x) => x.type !== "flow") };
    const whole = computeInsights(g.nodes, g.edges);
    const lens = lensByKey("equipment-docs")!;
    const view = sliceView(g, filter({ hiddenTypes: lens.hidden, showLibraryEdges: lens.libEdges }), [], null);
    // The old page computed on the slice: P-102 became an orphan the moment
    // the lens hid its unit and its plot plan.
    const sliced = computeInsights(view.nodes, view.edges);
    expect(sliced.orphans.map((o) => o.id)).toContain("asset:p2");
    // The page now computes on the assembled graph: the lens changes nothing.
    expect(whole.orphans.map((o) => o.id)).toEqual(["doc:loose"]);
    expect(whole.orphans.map((o) => o.id)).not.toContain("asset:p2");
  });
});

describe("sliceView — the visible slice, and focus depth (GPV-9)", () => {
  it("applies the lens and the library-links toggle, never adding an edge", () => {
    const v = sliceView(graph, filter(), [], null);
    expect(v.nodes.map((x) => x.id)).not.toContain("lib:L");
    expect(v.edges.every((x) => graph.edges.includes(x))).toBe(true);
    expect(v.depthOf).toBeNull();
  });

  it("focus mode keeps each node's hop distance from the root", () => {
    const v = sliceView(graph, filter({ localDepth: 2 }), [], "doc:pid");
    expect(v.depthOf?.get("doc:pid")).toBe(0);
    expect(v.depthOf?.get("asset:p1")).toBe(1);
    expect(v.depthOf?.get("cbunit:20")).toBe(2);
    expect(v.nodes.map((x) => x.id).sort()).toEqual([...v.depthOf!.keys()].sort());
  });

  it("ghosts appear only between two drawn nodes", () => {
    const ghosts = [e("doc:pid", "doc:loose", "proposed"), e("doc:pid", "doc:gone", "proposed")];
    expect(sliceView(graph, filter(), ghosts, null).ghosts).toEqual([ghosts[0]]);
    expect(sliceView(graph, filter({ showProposals: false }), ghosts, null).ghosts).toEqual([]);
  });

  it("viewDegree counts the slice's links on a node", () => {
    const v = sliceView(graph, filter(), [], null);
    expect(viewDegree("doc:pid", v.edges)).toBe(1);               // the library edge is filtered
    expect(viewDegree("doc:pid", graph.edges)).toBe(2);
  });
});

describe("GPV-12 — an answer against the view", () => {
  it("counts only what the view can show and says why the rest is not drawn", () => {
    const lens = lensByKey("documents")!;
    const f = filter({ hiddenTypes: lens.hidden, showLibraryEdges: lens.libEdges });
    const view = sliceView(graph, f, [], null);
    const vis = answerVisibility(["doc:pid", "asset:p1", "asset:p2", "cbunit:20", "doc:pid", "asset:elsewhere"], view, graph, f);
    expect(vis.shown).toEqual(["doc:pid"]);
    expect(vis.hiddenByType).toEqual([{ type: "asset", count: 2 }, { type: "unit", count: 1 }]);
    expect(vis.offMap).toBe(1);
    expect(vis.outsideFocus).toBe(0);
  });

  it("a node of a shown type outside the focused neighbourhood is counted apart", () => {
    const f = filter({ localDepth: 1 });
    const view = sliceView(graph, f, [], "doc:loose");
    const vis = answerVisibility(["asset:p2"], view, graph, f);
    expect(vis).toMatchObject({ shown: [], hiddenByType: [], outsideFocus: 1, offMap: 0 });
  });
});

describe("GPV-7 / AREA-10 — what a Connect writes", () => {
  const byId = new Map(graph.nodes.map((x) => [x.id, x]));
  const N = (id: string) => byId.get(id)!;

  it("a unit end is the node's codebook code, and the optimistic edge is on the ids the rebuild draws", () => {
    const other = n("cbunit:30", "unit", { label: "Coker", unitCode: "30" });
    expect(flowEndpoint(N("cbunit:20"))).toEqual({ kind: "unit", ref: "20" });
    expect(planConnect(N("cbunit:20"), other)).toEqual({
      kind: "flow", from: { kind: "unit", ref: "20" }, to: { kind: "unit", ref: "30" }, a: "cbunit:20", b: "cbunit:30",
    });
    expect(planConnect(N("asset:p1"), N("asset:p2"))).toEqual({
      kind: "flow", from: { kind: "asset", ref: "p1" }, to: { kind: "asset", ref: "p2" }, a: "asset:p1", b: "asset:p2",
    });
  });

  it("an operational unit with no codebook identity is refused with the reason — never written as its own code", () => {
    // The old page wrote `n.sub` (units.code, "U100") as a codebook ref.
    const legacy = n("unit:op-1", "unit", { label: "Coker (operational)", sub: "U100", unitCode: null });
    const plan = planConnect(N("cbunit:20"), legacy);
    expect(plan?.kind).toBe("refused");
    expect(plan && "message" in plan ? plan.message : "").toMatch(/not mapped to a Site Codebook unit/);
    expect(plan && "message" in plan ? plan.message : "").not.toContain("U100");
    expect(planConnect(legacy, N("cbunit:20"))?.kind).toBe("refused");
  });

  it("a system is refused (a flow ends at equipment or a codebook unit)", () => {
    const plan = planConnect(N("system:s1"), N("cbunit:20"));
    expect(plan).toMatchObject({ kind: "refused" });
    expect(plan && "message" in plan ? plan.message : "").toMatch(/is a system/);
  });

  it("links and tags keep their pairs; a mixed pair is refused with the old sentence", () => {
    expect(planConnect(N("doc:pid"), N("doc:loose"))).toEqual({ kind: "related", documentId: "pid", targetDocumentId: "loose" });
    expect(planConnect(N("asset:p1"), N("doc:loose"))).toEqual({ kind: "tag", documentId: "loose", assetId: "p1", tag: "P-101" });
    expect(planConnect(N("asset:p1"), N("cbunit:20"))).toEqual({ kind: "refused", message: CONNECT_PAIR_MESSAGE });
    expect(planConnect(N("doc:pid"), N("lib:L"))).toEqual({ kind: "refused", message: CONNECT_PAIR_MESSAGE });
    expect(planConnect(N("doc:pid"), N("doc:pid"))).toBeNull();
  });

  it("Connect is offered only where the write can land, and says why not on a unit that cannot", () => {
    expect(connectOffer(N("doc:pid"))).toEqual({ offered: true });
    expect(connectOffer(N("asset:p1"))).toEqual({ offered: true });
    expect(connectOffer(N("cbunit:20"))).toEqual({ offered: true });
    expect(connectOffer(N("unit:op-1"))).toMatchObject({ offered: false, reason: expect.stringMatching(/Operational scope/) });
    expect(connectOffer(N("system:s1"))).toMatchObject({ offered: false, reason: expect.stringMatching(/system/) });
    expect(connectOffer(N("lib:L"))).toEqual({ offered: false, reason: null });
  });
});

describe("GPV-13 — the keyboard's walk", () => {
  it("steps through search matches when something is typed", () => {
    expect(keyboardOrder(graph.nodes, graph.edges, "P-10", null).map((x) => x.id)).toEqual(["asset:p1", "asset:p2"]);
  });

  it("walks the selected node's neighbours, most connected first", () => {
    expect(keyboardOrder(graph.nodes, graph.edges, "", "asset:p2").map((x) => x.id)).toEqual(["asset:p1", "cbunit:20", "plot:pp"]);
  });

  it("otherwise every node, most connected first", () => {
    const all = keyboardOrder(graph.nodes, graph.edges, "", null);
    expect(all).toHaveLength(graph.nodes.length);
    expect(all[0].id).toBe("asset:p1");
  });
});

describe("IRLS-14 — no mention links, and which case", () => {
  const cov = (over: Partial<NonNullable<OrgGraph["mentionCoverage"]>>) =>
    ({ installed: true, rows: 0, drawn: 0, unmapped: 0, capped: false, ...over });

  it("says nothing when mention links are drawn, or for a snapshot with no coverage", () => {
    expect(mentionNotice(cov({ rows: 3, drawn: 2 }), 10)).toBeNull();
    expect(mentionNotice(undefined, 10)).toBeNull();
  });

  it("not installed", () => {
    expect(mentionNotice(cov({ installed: false }), 10)).toMatchObject({ canRebuild: false, text: expect.stringMatching(/not installed/) });
  });

  it("installed, nothing this reader can see: both cases named, and the next step", () => {
    const m = mentionNotice(cov({}), 10)!;
    expect(m.canRebuild).toBe(true);
    expect(m.text).toMatch(/not been built/);
    expect(m.text).toMatch(/found none/);
    expect(m.text).toMatch(/cannot tell which/);
  });

  it("no equipment on the map: nothing to name", () => {
    expect(mentionNotice(cov({}), 0)).toMatchObject({ canRebuild: false, text: expect.stringMatching(/no registry equipment/) });
  });

  it("rows read but none drawn points at the notes", () => {
    expect(mentionNotice(cov({ rows: 4, unmapped: 4 }), 10)).toMatchObject({ canRebuild: false, text: expect.stringMatching(/4 mentions read/) });
  });
});

// GPV-8 / FLOW-10 / GPV-14 / GPV-4 — what the renderers draw by (the pure
// tables and rules both renderers read; the canvas and WebGL passes
// themselves are not run in this environment).

describe("GPV-8 / FLOW-10 — direction is drawn where it is the meaning", () => {
  it("arrows go on flows and supersession — the types the assembly keeps ordered — and never on a curated link", () => {
    expect([...ARROW_EDGE_TYPES].sort()).toEqual([...DIRECTED_EDGE_TYPES].sort());
    expect(ARROW_EDGE_TYPES.has("flow")).toBe(true);
    expect(ARROW_EDGE_TYPES.has("supersession")).toBe(true);
    expect(ARROW_EDGE_TYPES.has("related")).toBe(false);
  });

  it("a flow (and a supersession) sits above the arrow threshold without a hover", () => {
    // The old renderer drew a flow at 0.2 behind a 0.3 gate.
    expect(baseEdgeAlpha({ type: "flow" })).toBeGreaterThan(ARROW_MIN_ALPHA);
    expect(baseEdgeAlpha({ type: "supersession" })).toBeGreaterThan(ARROW_MIN_ALPHA);
    expect(baseEdgeAlpha({ type: "flow" })).toBeGreaterThan(baseEdgeAlpha({ type: "tag" }));
  });

  it("the path accent is no longer a twin of the flow colour", () => {
    expect(ACCENT.path).not.toBe("#22d3ee");
    expect(PATH_RGB).not.toBe(EDGE_RGB.flow);
    expect(Object.values(EDGE_RGB)).not.toContain(PATH_RGB);
  });

  it("the legend keys every edge type the renderers colour", () => {
    const keys = new Set(EDGE_LEGEND.map((l) => l.key));
    for (const t of Object.keys(EDGE_LABELS)) expect(keys.has(t)).toBe(true);
    expect(EDGE_LEGEND.filter((l) => l.arrow).map((l) => l.key).sort()).toEqual(["flow", "path", "supersession"]);
  });
});

describe("GPV-14 — a pinned shelf, a bound knowledge library and filing are told apart", () => {
  it("each library statement has its own colour and name", () => {
    const filing = edgeRgbFor({ type: "library" });
    const pinned = edgeRgbFor({ type: "library", via: "pinned" });
    const knowledge = edgeRgbFor({ type: "library", via: "knowledge" });
    expect(new Set([filing, pinned, knowledge]).size).toBe(3);
    expect(edgeLabelFor({ type: "library", via: "pinned" })).toBe("Library pinned to the unit");
    expect(edgeLabelFor({ type: "library", via: "knowledge" })).toBe("Knowledge library bound to the unit");
    expect(edgeLabelFor({ type: "library" })).toBe(EDGE_LABELS.library);
    // A statement is drawn stronger than filing noise.
    expect(baseEdgeAlpha({ type: "library", via: "pinned" })).toBeGreaterThan(baseEdgeAlpha({ type: "library" }));
  });
});

describe("GPV-4 — the unit class's three kinds", () => {
  it("are told apart by id, and coloured apart (the codebook unit keeps its colour)", () => {
    expect(unitVariant({ id: "cbunit:20", type: "unit" })).toBe("codebook");
    expect(unitVariant({ id: "unit:u1", type: "unit" })).toBe("operational");
    expect(unitVariant({ id: "system:s1", type: "unit" })).toBe("system");
    expect(unitVariant({ id: "asset:a", type: "asset" })).toBeNull();
    expect(nodeColorFor({ id: "cbunit:20", type: "unit" })).toBe(NODE_COLORS.unit);
    expect(new Set(Object.values(UNIT_VARIANT_COLORS)).size).toBe(3);
    expect(nodeColorFor({ id: "asset:a", type: "asset" })).toBe(NODE_COLORS.asset);
  });
});
