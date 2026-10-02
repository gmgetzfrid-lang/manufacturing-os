// @vitest-environment jsdom
//
// intelligence Round G (I-14) — the /graph page, as RENDERED.
//
// Regression pins first (the user's top rule): every existing link into
// /graph keeps working — `?focus=<bare document id>`, `?focus=asset:<id>`,
// the operating area's `?scope=unit:<code>&focus=cbunit:<code>` — a bare
// /graph assembles the whole org exactly as before, and settings saved by an
// earlier build load. Then each finding on the page:
//
//   GPV-5   a ?focus= link is honoured once: closing the peek and dragging a
//           force slider never reopens it or re-flies the camera
//   GPV-11  the view is written to the URL; Back to graph restores it; the
//           focus depth is in the URL and adjustable on the chip
//   GPV-2 / GAP-306  the scope is read from the URL, set from the top bar or
//           a unit's peek, and shown as a chip
//   GM-1 / GM-6  the orphan count does not move when a lens is tapped, and
//           the panel says what the counts were computed on
//   GM-7    a failed / capped proposal read is said; the chip counts the queue
//   GM-11   the peek labels its two degrees
//   GPV-7   Connect writes a unit end by its codebook code and refuses a unit
//           with none (the button is not offered; the reason is shown)
//   GPV-10  a lens tap over a hand-tuned filter can be undone
//   GPV-12  the Ask panel counts what the view can show and offers the rest
//   GPV-13  the map region is focusable and walkable; Escape closes overlays
//   HUB-11  the Intelligence strip is titled
//   IRLS-14 with no mention links the map says which case and offers the rebuild

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GraphNode, GraphEdge, OrgGraph } from "@/lib/orgGraph";

const nav = vi.hoisted(() => ({ params: new URLSearchParams(""), push: vi.fn(), pathname: "/graph" }));
const role = vi.hoisted(() => ({ roles: ["Admin"] as string[] }));
const g = vi.hoisted(() => ({
  graph: null as unknown as OrgGraph,
  build: [] as unknown[][],
  renders: [] as Array<Record<string, unknown>>,
  proposals: { pairs: [] as unknown[], total: 0 as number | null, capped: false, error: null as string | null },
  flows: [] as unknown[],
  fetches: [] as Array<{ url: string; body: unknown }>,
  askBody: null as unknown,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => nav.pathname,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({
    activeOrgId: "o1", uid: "u1", userEmail: "me@x.io", roles: role.roles,
    hasAnyRole: (rs: string[]) => rs.some((r) => role.roles.includes(r)),
  }),
}));
vi.mock("@/components/navigation/ViewTabs", () => ({
  default: ({ title }: { title?: string }) => React.createElement("div", { "data-testid": "viewtabs", "data-title": title ?? "" }),
  INTELLIGENCE_VIEWS: [],
}));
vi.mock("@/components/graph/OrgGraph2D", () => ({
  default: (props: Record<string, unknown>) => { g.renders.push(props); return React.createElement("div", { "data-testid": "map2d" }); },
}));
vi.mock("@/components/graph/OrgGraph3D", () => ({
  default: (props: Record<string, unknown>) => { g.renders.push(props); return React.createElement("div", { "data-testid": "map3d" }); },
}));
vi.mock("@/lib/orgGraph", async (orig) => ({
  ...(await orig<typeof import("@/lib/orgGraph")>()),
  buildOrgGraph: vi.fn(async (...args: unknown[]) => { g.build.push(args); return structuredClone(g.graph); }),
}));
vi.mock("@/lib/linkProposals", () => ({
  PENDING_PAIRS_CAP: 4000,
  readPendingProposalPairs: vi.fn(async () => g.proposals),
}));
vi.mock("@/lib/mentions", () => ({ mentionsForAsset: vi.fn(async () => []), mentionsForDocument: vi.fn(async () => []) }));
vi.mock("@/lib/codebook", () => ({
  loadCodebook: vi.fn(async () => ({ units: [{ code: "20", label: "Crude Unit" }, { code: "30", label: "Coker" }] })),
}));
vi.mock("@/lib/processFlows", () => ({ createManualFlow: vi.fn(async (input: unknown) => { g.flows.push(input); return "confirmed"; }) }));
vi.mock("@/lib/relatedResources", () => ({ addRelatedResource: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
    from: () => ({ insert: async () => ({ error: null }) }),
  },
}));

import GraphPage from "@/app/(protected)/graph/page";
import BackToGraphChip from "@/components/graph/BackToGraphChip";
import { settingsKey } from "@/lib/graphSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node = (id: string, type: GraphNode["type"], label: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, type, label, href: extra.href ?? `/x/${id}`, degree: extra.degree ?? 1, ...extra });
const edge = (a: string, b: string, type: GraphEdge["type"]): GraphEdge => ({ a, b, type });

function baseGraph(): OrgGraph {
  return {
    nodes: [
      node("cbunit:20", "unit", "Crude Unit", { unitCode: "20", degree: 3 }),
      node("cbunit:30", "unit", "Coker", { unitCode: "30", degree: 1 }),
      node("unit:op1", "unit", "Old Coker", { unitCode: null, sub: "U100", degree: 1 }),
      node("plant:p1", "plant", "Refinery", { degree: 1 }),
      node("asset:a1", "asset", "P-101", { degree: 3, href: "/assets/P-101" }),
      node("asset:a2", "asset", "P-102", { degree: 1 }),
      node("doc:d1", "document", "PID-1", { degree: 3, href: "/documents/L1?doc=d1" }),
      node("doc:d2", "document", "LOOSE-2", { degree: 1 }),
      node("lib:L1", "library", "P&IDs", { degree: 2 }),
    ],
    edges: [
      edge("asset:a1", "cbunit:20", "unit"),
      edge("asset:a2", "cbunit:20", "unit"),
      edge("system:none", "cbunit:20", "unit"),
      edge("unit:op1", "plant:p1", "unit"),
      edge("cbunit:30", "asset:a1", "flow"),
      edge("doc:d1", "asset:a1", "tag"),
      edge("doc:d1", "lib:L1", "library"),
      edge("doc:d2", "lib:L1", "library"),
    ],
    truncations: [],
    mentionCoverage: { installed: true, rows: 0, drawn: 0, unmapped: 0, capped: false },
    access: { documentsVisible: 2, documentsTotal: 5, outsideAccess: 3, documentsDrawn: 2, scoped: false },
    scope: null,
  };
}

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); await flush(); };
const page = () => React.createElement(GraphPage);
const last = () => g.renders[g.renders.length - 1] as {
  nodes: GraphNode[]; edges: GraphEdge[]; flyTo: { ids: string[]; nonce: number } | null;
  settings: { hiddenTypes: string[]; showArrows: boolean }; depthOf: Map<string, number> | null;
  onSelect: (n: GraphNode | null) => void; onOpen: (n: GraphNode) => void;
};
const text = () => host.textContent ?? "";
const btn = (match: RegExp | string) => [...host.querySelectorAll("button")].find((b) =>
  typeof match === "string" ? (b.textContent ?? "").includes(match) || b.getAttribute("aria-label") === match : match.test(b.textContent ?? "") || match.test(b.getAttribute("aria-label") ?? ""));
const click = async (el: Element | undefined | null) => {
  expect(el).toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
};
const peek = () => host.querySelector('[role="dialog"][aria-label^="Document:"], [role="dialog"][aria-label^="Equipment:"], [role="dialog"][aria-label^="Unit:"]');
const key = async (target: EventTarget, k: string) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  await flush();
};
const setRange = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
  await flush();
};
const typeInto = async (el: HTMLInputElement, v: string) => setRange(el, v);

beforeEach(() => {
  g.graph = baseGraph();
  g.build = []; g.renders = []; g.flows = []; g.fetches = [];
  g.proposals = { pairs: [], total: 0, capped: false, error: null };
  role.roles = ["Admin"];
  nav.params = new URLSearchParams("");
  nav.pathname = "/graph";
  nav.push.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/graph");
  g.askBody = { question: "pipe supports", mode: "evidence", hits: [{ knowledgeDocumentId: "k1", documentName: "PID-1", libraryId: "kl", page: 2, snippet: "pipe <b>supports</b>" }], nodeIds: ["doc:d1", "asset:a1"], assets: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    g.fetches.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url === "/api/graph/ask") return { ok: true, status: 200, json: async () => g.askBody };
    if (url === "/api/graph/mentions") return { ok: true, status: 200, json: async () => ({ documents: 4, mentionsWritten: 9, incomplete: false }) };
    return { ok: false, status: 404, json: async () => ({ error: "nope" }) };
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("regression pins — every existing way into /graph", () => {
  it("a bare /graph assembles the whole org exactly as before (one argument)", async () => {
    await render(page());
    expect(g.build).toEqual([["o1"]]);
    expect(host.querySelector('[data-testid="map2d"]')).toBeTruthy();
    expect(last().nodes.map((n) => n.id)).toContain("doc:d1");
  });

  it("?focus=<bare document id> opens that document's peek and flies to it", async () => {
    nav.params = new URLSearchParams("focus=d1");
    await render(page());
    expect(peek()?.getAttribute("aria-label")).toBe("Document: PID-1");
    expect(last().flyTo?.ids).toEqual(["doc:d1"]);
  });

  it("?focus=asset:<id> (the equipment page's link) selects that equipment", async () => {
    nav.params = new URLSearchParams("focus=asset%3Aa1");
    await render(page());
    expect(peek()?.getAttribute("aria-label")).toBe("Equipment: P-101");
  });

  it("the operating area's ?scope=unit:<code>&focus=cbunit:<code> assembles that unit and opens it (AREA-6 / GAP-306)", async () => {
    nav.params = new URLSearchParams("scope=unit%3A20&focus=cbunit%3A20");
    g.graph = { ...baseGraph(), scope: { ref: { kind: "unit", code: "20" }, label: "Crude Unit", boundary: 0, complete: true } };
    await render(page());
    expect(g.build).toEqual([["o1", { scope: { kind: "unit", code: "20" } }]]);
    expect(peek()?.getAttribute("aria-label")).toBe("Unit: Crude Unit");
    expect(btn("Scope: Crude Unit")).toBeTruthy();
  });

  it("settings saved by an earlier build load (the v1 blob's lens), and arrows migrate on", async () => {
    window.localStorage.setItem(settingsKey("o1"), JSON.stringify({
      mode: "2d", hiddenTypes: ["document", "library", "project", "plot"], showLibraryEdges: false, showArrows: false, repelForce: 2,
    }));
    await render(page());
    expect(last().settings.hiddenTypes).toEqual(["document", "library", "project", "plot"]);
    expect(last().settings.showArrows).toBe(true);
    expect(last().nodes.map((n) => n.id)).not.toContain("doc:d1");
    expect(window.location.search).toContain("lens=plant");
  });
});

describe("GPV-5 — a ?focus= link is honoured once", () => {
  it("closing the peek and dragging a force slider never reopens it or re-flies the camera", async () => {
    nav.params = new URLSearchParams("focus=asset%3Aa1");
    await render(page());
    expect(peek()).toBeTruthy();
    await click(peek()!.querySelector('button[aria-label="Close"]'));
    expect(peek()).toBeNull();
    expect(last().flyTo).toBeNull();
    await click(btn("Settings"));
    const forces = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Forces"));
    await click(forces);
    const repel = [...host.querySelectorAll('input[type="range"]')].find((i) =>
      i.closest("label")?.textContent?.includes("Repel force")) as HTMLInputElement;
    for (const v of ["1.5", "2", "2.5"]) await setRange(repel, v);
    expect(peek()).toBeNull();
    expect(last().flyTo).toBeNull();
    // The URL no longer names the node: a refresh would not reopen it either.
    expect(window.location.search).not.toMatch(/select=|focus=/);
  });
});

describe("GPV-11 — the view is in the URL, and Back to graph restores it", () => {
  it("writes lens, select and q; the open stamps it as graphq; the chip pushes it back", async () => {
    nav.params = new URLSearchParams("focus=asset%3Aa1");
    await render(page());
    expect(window.location.search).toContain("lens=all");
    expect(window.location.search).toContain("select=asset%3Aa1");
    last().onOpen(last().nodes.find((n) => n.id === "asset:a1")!);
    const pushed = nav.push.mock.calls[0][0] as string;
    expect(pushed.startsWith("/assets/P-101?from=graph&graphq=")).toBe(true);
    const graphq = new URL(`http://x${pushed}`).searchParams.get("graphq")!;
    expect(graphq).toContain("select=asset%3Aa1");

    // The chip, on the page the open landed on: back to that view, and only
    // the graph's own keys.
    act(() => root.unmount());
    root = createRoot(host);
    nav.push.mockReset();
    nav.pathname = "/assets/P-101";
    nav.params = new URLSearchParams(`from=graph&graphq=${encodeURIComponent(`${graphq}&evil=1`)}`);
    await render(React.createElement(BackToGraphChip));
    await click(btn("Back to graph"));
    expect(nav.push).toHaveBeenCalledWith("/graph?lens=all&select=asset%3Aa1");
  });

  it("regression: a page stamped only from=graph (before graphq) returns to a bare /graph", async () => {
    nav.pathname = "/documents/L1";
    nav.params = new URLSearchParams("doc=d1&from=graph");
    await render(React.createElement(BackToGraphChip));
    await click(btn("Back to graph"));
    expect(nav.push).toHaveBeenCalledWith("/graph");
  });

  it("focus mode and its depth come from the URL, reach the renderer as distances, and the chip adjusts the depth", async () => {
    nav.params = new URLSearchParams("local=asset%3Aa1&depth=1");
    await render(page());
    expect(text()).toContain("Focused: P-101");
    expect(text()).toContain("1 hop");
    expect(last().depthOf?.get("asset:a1")).toBe(0);
    expect(last().nodes.map((n) => n.id).sort()).toEqual(["asset:a1", "cbunit:20", "cbunit:30", "doc:d1"]);
    await click(btn("One hop more"));
    expect(text()).toContain("2 hops");
    expect(window.location.search).toContain("local=asset%3Aa1");
    expect(window.location.search).toContain("depth=2");
    await click(btn("Leave focus — back to the whole map"));
    expect(window.location.search).not.toContain("local=");
  });

  it("a hand-tuned filter in the URL is applied, and a lens tap over it can be undone (GPV-10)", async () => {
    nav.params = new URLSearchParams("hide=plot%2Cplant&libs=0");
    await render(page());
    expect(last().settings.hiddenTypes).toEqual(["plot", "plant"]);
    const lensGroup = host.querySelector('[role="group"][aria-label="Lenses"]')!;
    // The filter is a variation of Everything — the lens says so.
    const all = [...lensGroup.querySelectorAll("button")].find((b) => b.textContent?.includes("Everything"));
    expect(all?.textContent).toBe("≈ Everything");
    await click(all);
    expect(last().settings.hiddenTypes).toEqual([]);
    await click(btn("Back to your filter"));
    expect(last().settings.hiddenTypes).toEqual(["plot", "plant"]);
  });
});

describe("GPV-2 / GAP-306 — the scope picker", () => {
  it("picking a unit in the top bar assembles that unit's world; the chip clears it", async () => {
    await render(page());
    const select = host.querySelector('select[aria-label="Scope the map to one unit"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Whole org", "Crude Unit (20)", "Coker (30)"]);
    await act(async () => { select.value = "unit:20"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(g.build[g.build.length - 1]).toEqual(["o1", { scope: { kind: "unit", code: "20" } }]);
    expect(window.location.search).toContain("scope=unit%3A20");
    await click(btn(/^Scope: /));
    expect(g.build[g.build.length - 1]).toEqual(["o1"]);
    expect(window.location.search).not.toContain("scope=");
  });

  it("a Site Codebook unit's peek scopes the map to it", async () => {
    nav.params = new URLSearchParams("select=cbunit%3A20");
    await render(page());
    await click(btn("Scope the map to this unit"));
    expect(g.build[g.build.length - 1]).toEqual(["o1", { scope: { kind: "unit", code: "20" } }]);
  });
});

describe("GM-1 / GM-6 / GM-11 — insights and degrees say what they count", () => {
  it("the orphan badge does not move when a lens hides the types an item is tied by", async () => {
    await render(page());
    const before = host.querySelector('[data-testid="orphan-badge"]')?.textContent;
    expect(before).toBe("1");                 // LOOSE-2: only filed in a library
    const lensGroup = host.querySelector('[role="group"][aria-label="Lenses"]')!;
    await click([...lensGroup.querySelectorAll("button")].find((b) => b.textContent === "Equipment ↔ Documents"));
    // P-102 is tied only to its unit, which this lens hides — not an orphan.
    expect(host.querySelector('[data-testid="orphan-badge"]')?.textContent).toBe(before);
    await click(btn(/^\s*Insights/));
    const basis = host.querySelector('[data-testid="insights-basis"]')?.textContent ?? "";
    expect(basis).toContain("Counted on the whole map");
    expect(basis).toContain("3 more are outside your access");
  });

  it("the peek labels the whole-map degree, the library-filing part and the in-view count", async () => {
    nav.params = new URLSearchParams("focus=d1");
    await render(page());
    expect(host.querySelector('[data-testid="peek-degree"]')?.textContent).toBe("Document · 3 links on the map (1 library filing) · 1 in this view");
  });
});

describe("GM-7 — proposals: failed, capped, counted", () => {
  it("a failed read is said on the map", async () => {
    g.proposals = { pairs: [], total: null, capped: false, error: "statement timeout" };
    await render(page());
    expect(host.querySelector('[data-testid="proposals-error"]')?.textContent).toContain("statement timeout");
  });

  it("a capped read says how many are pending and the chip counts the queue, not the drawing", async () => {
    g.proposals = { pairs: [{ documentId: "d1", targetDocumentId: "d2", proposer: "tag", nodeA: "doc:d1", nodeB: "doc:d2" }], total: 9000, capped: true, error: null };
    window.localStorage.setItem(settingsKey("o1"), JSON.stringify({ version: 2, showLibraryEdges: true }));
    await render(page());
    expect(host.querySelector('[data-testid="proposals-capped"]')?.textContent).toContain("of 9,000 proposed connections");
    expect(host.querySelector('[data-testid="proposals-chip"]')?.textContent).toBe("9,000 connections awaiting review · 1 drawn here");
  });
});

describe("GPV-7 / AREA-10 — Connect by the one unit identity", () => {
  it("a flow between two codebook units writes their codes and draws on the rebuild's node ids", async () => {
    nav.params = new URLSearchParams("select=cbunit%3A20");
    await render(page());
    await click(btn("Draw a connection from this node"));
    await act(async () => { last().onSelect(last().nodes.find((n) => n.id === "cbunit:30")!); });
    await flush();
    expect(g.flows).toEqual([{ orgId: "o1", fromKind: "unit", fromRef: "20", toKind: "unit", toRef: "30", userId: "u1", userName: "me@x.io" }]);
    expect(last().edges).toContainEqual({ a: "cbunit:20", b: "cbunit:30", type: "flow" });
  });

  it("an operational unit with no codebook identity is not offered Connect, and the peek says why", async () => {
    nav.params = new URLSearchParams("select=unit%3Aop1");
    await render(page());
    expect(btn("Draw a connection from this node")).toBeUndefined();
    expect(host.querySelector('[data-testid="connect-blocked"]')?.textContent).toMatch(/not mapped to a Site Codebook unit/);
  });

  it("picking such a unit as a flow's target is refused with the reason; nothing is written", async () => {
    nav.params = new URLSearchParams("select=cbunit%3A20");
    await render(page());
    await click(btn("Draw a connection from this node"));
    await act(async () => { last().onSelect(last().nodes.find((n) => n.id === "unit:op1")!); });
    await flush();
    expect(g.flows).toEqual([]);
    expect(host.querySelector('[data-testid="connect-error"]')?.textContent).toMatch(/not mapped to a Site Codebook unit/);
  });
});

describe("GPV-12 — the Ask panel counts what this view can show", () => {
  it("on the Documents lens: one node lit, the equipment match offered with a show button", async () => {
    nav.params = new URLSearchParams("lens=documents");
    await render(page());
    const input = host.querySelector("input[data-graph-search]") as HTMLInputElement;
    await typeInto(input, "pipe supports");
    await key(input, "Enter");
    expect(host.querySelector('[data-testid="answer-count"]')?.textContent).toBe("1 passage · 1 node lit up on this map");
    await click(btn("1 more in Equipment — show"));
    expect(last().settings.hiddenTypes).not.toContain("asset");
    expect(host.querySelector('[data-testid="answer-count"]')?.textContent).toBe("1 passage · 2 nodes lit up on this map");
    expect(window.location.search).toContain("ask=1");
  });

  it("a URL carrying an asked question asks it again, once", async () => {
    nav.params = new URLSearchParams("q=pipe+supports&ask=1");
    await render(page());
    expect(g.fetches.filter((f) => f.url === "/api/graph/ask")).toHaveLength(1);
    expect(host.querySelector('[data-testid="answer-count"]')).toBeTruthy();
  });
});

describe("GPV-13 — keyboard", () => {
  it("the map region is focusable and labelled; arrows step, Enter selects, Escape closes", async () => {
    await render(page());
    const region = host.querySelector('[role="application"]') as HTMLDivElement;
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.getAttribute("aria-label")).toMatch(/Org graph map — \d+ nodes, \d+ links/);
    await key(region, "ArrowDown");
    expect(host.querySelector("#graph-keyboard-status")?.textContent).toMatch(/1 of \d+/);
    await key(region, "Enter");
    expect(peek()).toBeTruthy();
    await key(window, "Escape");
    expect(peek()).toBeNull();
  });

  it("Escape leaves Connect, then Path, then focus — one layer per press", async () => {
    nav.params = new URLSearchParams("local=asset%3Aa1&depth=1");
    await render(page());
    await click(btn("Connection path"));
    expect(host.querySelector('[role="dialog"][aria-label="Connection path"]')).toBeTruthy();
    await key(window, "Escape");
    expect(host.querySelector('[role="dialog"][aria-label="Connection path"]')).toBeNull();
    expect(text()).toContain("Focused: P-101");
    await key(window, "Escape");
    expect(text()).not.toContain("Focused: P-101");
  });
});

describe("HUB-11 / IRLS-14", () => {
  it("the Intelligence strip is titled", async () => {
    await render(page());
    expect(host.querySelector('[data-testid="viewtabs"]')?.getAttribute("data-title")).toBe("Intelligence");
  });

  it("no mention links: the map says which case, and a controller can rebuild from it", async () => {
    await render(page());
    expect(host.querySelector('[data-testid="mention-notice"]')?.textContent).toMatch(/cannot tell which/);
    await click(btn("Rebuild the mention index"));
    expect(g.fetches.find((f) => f.url === "/api/graph/mentions")?.body).toEqual({ orgId: "o1" });
    expect(host.querySelector('[data-testid="mention-run"]')?.textContent).toMatch(/4 documents read, 9 mentions written/);
    expect(g.build.length).toBe(2);             // the map rebuilt with the new edges
  });

  it("a member the rebuild route refuses is not offered the button", async () => {
    role.roles = ["Viewer"];
    await render(page());
    expect(host.querySelector('[data-testid="mention-notice"]')).toBeTruthy();
    expect(btn("Rebuild the mention index")).toBeUndefined();
  });

  it("a failed rebuild is said, with the route's reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "mention index write: permission denied" }) })));
    await render(page());
    await click(btn("Rebuild the mention index"));
    expect(host.querySelector('[data-testid="mention-run"]')?.textContent).toContain("could not be rebuilt: mention index write: permission denied");
  });
});
