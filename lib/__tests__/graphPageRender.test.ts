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
//
// Fix pass (review of the first build):
//   GPV-11  the URL is written within the History API's budget — typing never
//           writes it, a burst is coalesced, a throwing replaceState is not
//           thrown into the page (Safari throws past 100 calls per 30 s)
//   DEC-88 item 3  a URL's filter is never saved by an unrelated change
//   GPV-5   after a scope change the URL's node is honoured on the NEW map
//   GM-1    a faded Insights row shows its node before selecting it
//   GM-7    a read that failed partway says what it drew
//
// Fix pass 3 (final review's minors):
//   GPV-11  a write deferred by the budget never lands on another page's URL
//           (the browser left /graph before the page unmounted)
//   GM-7    the proposals chip shows only when ghosts are drawn (the base's
//           rule) — never with Proposals off — and so do the read's notes
//   GM-11   the peek's two "in this view" numbers say what each counts
//   GM-1    a bridge the view hides is faded; a click shows it, then lights it
//   GPV-13  the keyboard's walk is memoised on what changes it
//
// Fix pass 4 (re-review of fix pass 3):
//   GM-1    on the REAL 2D renderer, a hidden bridge's reveal flies the camera
//           to the pair's midpoint, not to the end that was already drawn
//   GPV-11  the route-change and Back / Forward cancels drop a pending write
//           even when the browser is back on /graph before it comes due
//   GM-7    a capped read whose count failed says "at least" the cap
//
// I-24 (GPV-4 done-when 1, DEC-88 item 1 as rewritten under DEC-90):
//   GPV-4   the lens bar and the phone select read the four labels apart
//           from the node types (Whole map · Process layout · Governing
//           paper · Records & filing), beside a Filters drawer that still
//           says "Equipment"; every existing ?lens=<key> link and a v1 blob
//           light the same lens as before; the Connect help names the flow
//           lens by its label

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GraphNode, GraphEdge, OrgGraph } from "@/lib/orgGraph";

const nav = vi.hoisted(() => ({ params: new URLSearchParams(""), push: vi.fn(), pathname: "/graph" }));
const role = vi.hoisted(() => ({ roles: ["Admin"] as string[] }));
const g = vi.hoisted(() => ({
  graph: null as unknown as OrgGraph,
  scopedGraph: null as OrgGraph | null,
  build: [] as unknown[][],
  renders: [] as Array<Record<string, unknown>>,
  proposals: { pairs: [] as unknown[], total: 0 as number | null, capped: false, error: null as string | null },
  flows: [] as unknown[],
  fetches: [] as Array<{ url: string; body: unknown }>,
  askBody: null as unknown,
  // Render the REAL 2D renderer under the recording stand-in (fix pass 4).
  real2D: false,
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
vi.mock("@/components/graph/OrgGraph2D", async (orig) => {
  const actual = await orig<typeof import("@/components/graph/OrgGraph2D")>();
  return {
    ...actual,
    default: (props: Record<string, unknown>) => {
      g.renders.push(props);
      return g.real2D
        ? React.createElement(actual.default, props as unknown as React.ComponentProps<typeof actual.default>)
        : React.createElement("div", { "data-testid": "map2d" });
    },
  };
});
vi.mock("@/components/graph/OrgGraph3D", () => ({
  default: (props: Record<string, unknown>) => { g.renders.push(props); return React.createElement("div", { "data-testid": "map3d" }); },
}));
vi.mock("@/lib/orgGraph", async (orig) => ({
  ...(await orig<typeof import("@/lib/orgGraph")>()),
  buildOrgGraph: vi.fn(async (...args: unknown[]) => {
    g.build.push(args);
    return structuredClone(args[1] && g.scopedGraph ? g.scopedGraph : g.graph);
  }),
}));
// The page's own graphView helpers, wrapped (never replaced) so a test can
// see how often the walk is computed and reach the URL writer's write.
const gv = vi.hoisted(() => ({ write: null as null | ((v: { qs: string; href: string }) => string) }));
vi.mock("@/lib/graphView", async (orig) => {
  const m = await orig<typeof import("@/lib/graphView")>();
  return {
    ...m,
    keyboardOrder: vi.fn(m.keyboardOrder),
    keyboardBaseOrder: vi.fn(m.keyboardBaseOrder),
    rateLimitedWriter: vi.fn((write: (v: { qs: string; href: string }) => "done" | "noop" | "failed", opts?: Parameters<typeof m.rateLimitedWriter>[1]) => {
      gv.write = write;
      return m.rateLimitedWriter(write, opts);
    }),
  };
});
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
import { settingsKey, lensByKey } from "@/lib/graphSettings";
import { URL_WRITE_BURST, keyboardOrder, keyboardBaseOrder } from "@/lib/graphView";

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
  g.scopedGraph = null;
  g.build = []; g.renders = []; g.flows = []; g.fetches = [];
  g.real2D = false;
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
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
    // The same lens is lit, under its label (I-24: label-only rename).
    const lit = host.querySelector('[role="group"][aria-label="Lenses"] button[aria-pressed="true"]');
    expect(lit?.textContent).toBe("Process layout");
  });
});

describe("GPV-4 (I-24) — lens labels apart from the node types, as rendered; every ?lens= link lights the same lens", () => {
  const LABELS = ["Whole map", "Process layout", "Governing paper", "Records & filing"];
  const lensButtons = () => [...host.querySelectorAll('[role="group"][aria-label="Lenses"] button')];
  const lensSelect = () => host.querySelector('select[aria-label="Lens"]') as HTMLSelectElement;

  it("the lens bar and the phone select read the four labels; the Filters drawer still says Equipment, and the two share no word", async () => {
    await render(page());
    expect(lensButtons().map((b) => b.textContent)).toEqual(LABELS);
    expect([...lensSelect().options].map((o) => o.textContent)).toEqual(LABELS);
    await click(btn("Settings"));
    const caption = host.querySelector('[data-testid="filter-count-caption"]')!;
    const typeRows = [...caption.parentElement!.querySelectorAll("label > span.flex-1")].map((el) => el.textContent ?? "");
    expect(typeRows).toContain("Equipment");
    expect(typeRows).toContain("Documents");
    const words = (s: string) => (s.toLowerCase().match(/[a-z]+/g) ?? []).map((w) => w.replace(/(ies|s)$/, (m) => (m === "ies" ? "y" : "")));
    const typeWords = new Set(typeRows.flatMap(words));
    for (const l of LABELS) expect(words(l).filter((w) => typeWords.has(w)), l).toEqual([]);
  });

  it.each([
    ["all", "Whole map"],
    ["plant", "Process layout"],
    ["equipment-docs", "Governing paper"],
    ["documents", "Records & filing"],
  ])("?lens=%s (an existing link) applies that lens's filter and lights %s", async (key, label) => {
    nav.params = new URLSearchParams(`lens=${key}`);
    await render(page());
    expect(last().settings.hiddenTypes).toEqual([...lensByKey(key)!.hidden]);
    const lit = lensButtons().filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(lit.map((b) => b.textContent)).toEqual([label]);
    expect(lensSelect().value).toBe(key);
    expect(window.location.search).toContain(`lens=${encodeURIComponent(key)}`);
  });

  it("tapping a lens writes its KEY to the URL, never its label", async () => {
    await render(page());
    await click(lensButtons().find((b) => b.textContent === "Records & filing"));
    expect(window.location.search).toContain("lens=documents");
    expect(decodeURIComponent(window.location.search)).not.toContain("Records");
  });

  it("the Connect help names the flow lens by its label", async () => {
    nav.params = new URLSearchParams("select=cbunit%3A20");
    await render(page());
    await click(btn("Draw a connection from this node"));
    expect(text()).toContain("drawn with an arrow on the Process layout lens.");
    expect(text()).not.toMatch(/\b(Plant|Process|Equipment|Documents?) lens\b/);
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
    // The filter is a variation of Whole map — the lens says so.
    const all = [...lensGroup.querySelectorAll("button")].find((b) => b.textContent?.includes("Whole map"));
    expect(all?.textContent).toBe("≈ Whole map");
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
    await click([...lensGroup.querySelectorAll("button")].find((b) => b.textContent === "Governing paper"));
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
    expect(host.querySelector('[data-testid="peek-degree"]')?.textContent).toBe("Document · 3 links on the map (1 library filing) · 1 link in this view");
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
    expect(host.querySelector('[data-testid="proposals-capped"]')?.textContent).toContain("1 read (the newest) of 9,000 proposed connections");
    expect(host.querySelector('[data-testid="proposals-chip"]')?.textContent).toBe("9,000 connections awaiting review · 1 drawn here");
  });

  it("the count failing at the cap says 'at least' the cap — exactly 4,000 pending is not 'more than' (fix pass 4)", async () => {
    const pairs = Array.from({ length: 4000 }, (_, i) => (i === 0
      ? { documentId: "d1", targetDocumentId: "d2", proposer: "tag", nodeA: "doc:d1", nodeB: "doc:d2" }
      : { documentId: `x${i}`, targetDocumentId: `y${i}`, proposer: "tag", nodeA: `doc:x${i}`, nodeB: `doc:y${i}` }));
    g.proposals = { pairs, total: null, capped: true, error: null };
    window.localStorage.setItem(settingsKey("o1"), JSON.stringify({ version: 2, showLibraryEdges: true }));
    await render(page());
    const note = host.querySelector('[data-testid="proposals-capped"]')?.textContent ?? "";
    expect(note).toContain("4,000 read (the newest) of at least 4,000 proposed connections.");
    expect(note).not.toContain("more than");
  });
});

describe("GM-7 — a read that failed partway (fix pass)", () => {
  it("says how many it loaded, never 'none are drawn' over the pairs it drew", async () => {
    g.proposals = { pairs: [{ documentId: "d1", targetDocumentId: "d2", proposer: "tag", nodeA: "doc:d1", nodeB: "doc:d2" }], total: 1500, capped: false, error: "connection reset" };
    window.localStorage.setItem(settingsKey("o1"), JSON.stringify({ version: 2, showLibraryEdges: true }));
    await render(page());
    const note = host.querySelector('[data-testid="proposals-error"]')?.textContent ?? "";
    expect(note).toContain("Only the first 1 proposed connection (the newest) could be loaded (connection reset)");
    expect(note).not.toContain("none are drawn");
    expect(last().edges).toContainEqual({ a: "doc:d1", b: "doc:d2", type: "proposed" });
  });
});

describe("GPV-11 — the URL is written within the History API's budget (fix pass)", () => {
  // Safari: "Attempt to use history.replaceState() more than 100 times per
  // 30 seconds" is a thrown SecurityError. jsdom has no limit, so the limit
  // is stood in: replaceState throws after `allow` calls.
  const limitHistory = (allow: number) => {
    const real = window.history.replaceState.bind(window.history);
    const state = { calls: 0 };
    vi.spyOn(window.history, "replaceState").mockImplementation((...args: Parameters<History["replaceState"]>) => {
      state.calls += 1;
      if (state.calls > allow) throw new DOMException("Attempt to use history.replaceState() more than 100 times per 30 seconds", "SecurityError");
      return real(...args);
    });
    return state;
  };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

  it("200 keystrokes never write the URL; leaving the box writes the search once", async () => {
    await render(page());
    const before = window.location.search;
    const history = limitHistory(5);
    const input = host.querySelector("input[data-graph-search]") as HTMLInputElement;
    await act(async () => { input.focus(); });
    let typed = "";
    // Each keystroke is its own discrete event (React commits and runs its
    // effects per event); 20 to an act keeps the test fast under load.
    for (let batch = 0; batch < 10; batch++) {
      await act(async () => {
        for (let k = 0; k < 20; k++) {
          const i = batch * 20 + k;
          typed = i < 120 ? `${typed}${"pipe supports "[i % 14]}` : typed.slice(0, -1);
          setter.call(input, typed);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    }
    await flush();
    expect(history.calls).toBe(0);
    expect(window.location.search).toBe(before);
    expect(host.querySelector('[data-testid="map2d"]')).toBeTruthy();
    expect(input.value).toBe(typed);
    await act(async () => { input.blur(); });
    await flush();
    expect(history.calls).toBe(1);
    expect(new URLSearchParams(window.location.search).get("q")).toBe(typed.trim());
  }, 20_000);

  it("a burst of 200 view changes is coalesced, and a replaceState that throws never reaches the page", async () => {
    nav.params = new URLSearchParams("local=asset%3Aa1&depth=1");
    await render(page());
    const history = limitHistory(3);
    for (let batch = 0; batch < 10; batch++) {
      await act(async () => {
        for (let k = 0; k < 20; k++) (btn(k % 2 === 0 ? "One hop more" : "One hop fewer") as HTMLElement).click();
      });
    }
    await flush();
    expect(history.calls).toBeLessThanOrEqual(URL_WRITE_BURST);
    expect(text()).toContain("Focused: P-101");
    expect(host.querySelector('[data-testid="map2d"]')).toBeTruthy();
  }, 20_000);
});

describe("DEC-88 item 3 — a URL's filter is never saved by an unrelated change (fix pass)", () => {
  it("nudging a force or opening Orphans saves only that; a bare /graph opens on the person's own filter", async () => {
    window.localStorage.setItem(settingsKey("o1"), JSON.stringify({ version: 2, hiddenTypes: ["plot"], localDepth: 2 }));
    nav.params = new URLSearchParams("lens=documents&local=doc%3Ad1&depth=4");
    await render(page());
    expect(last().settings.hiddenTypes).toEqual([...lensByKey("documents")!.hidden]);
    await click(btn("Settings"));
    await click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Forces")));
    const repel = [...host.querySelectorAll('input[type="range"]')].find((i) =>
      i.closest("label")?.textContent?.includes("Repel force")) as HTMLInputElement;
    await setRange(repel, "2.5");
    await click(btn(/^\s*Insights/));
    await click(btn(/Orphans/));
    const stored = JSON.parse(window.localStorage.getItem(settingsKey("o1"))!);
    expect(stored.repelForce).toBe(2.5);
    expect(stored.hideUnlinked).toBe(false);
    expect(stored.hiddenTypes).toEqual(["plot"]);
    expect(stored.localDepth).toBe(2);

    act(() => root.unmount());
    root = createRoot(host);
    nav.params = new URLSearchParams("");
    window.history.replaceState(null, "", "/graph");
    await render(page());
    expect(last().settings.hiddenTypes).toEqual(["plot"]);
  }, 20_000);

  it("changing the filter itself is the person's choice, and is saved", async () => {
    nav.params = new URLSearchParams("lens=documents");
    await render(page());
    const lensGroup = host.querySelector('[role="group"][aria-label="Lenses"]')!;
    await click([...lensGroup.querySelectorAll("button")].find((b) => b.textContent === "Governing paper"));
    const stored = JSON.parse(window.localStorage.getItem(settingsKey("o1"))!);
    expect(stored.hiddenTypes).toEqual([...lensByKey("equipment-docs")!.hidden]);
  });
});

describe("GPV-5 / GPV-2 — after a scope change the URL's node is honoured on the new map (fix pass)", () => {
  const scoped = (extra: GraphNode[] = []): OrgGraph => {
    const base = baseGraph();
    return {
      ...base,
      nodes: [...base.nodes.map((x) => (x.id === "cbunit:20" ? { ...x, degree: 7 } : x)), ...extra],
      scope: { ref: { kind: "unit", code: "20" }, label: "Crude Unit", boundary: 0, complete: true },
    };
  };

  it("a unit's peek → Scope: the peek shows the scoped map's node, not the whole org's", async () => {
    g.scopedGraph = scoped();
    nav.params = new URLSearchParams("select=cbunit%3A20");
    await render(page());
    expect(host.querySelector('[data-testid="peek-degree"]')?.textContent).toContain("3 links on the map");
    await click(btn("Scope the map to this unit"));
    expect(g.build[g.build.length - 1]).toEqual(["o1", { scope: { kind: "unit", code: "20" } }]);
    expect(host.querySelector('[data-testid="peek-degree"]')?.textContent).toContain("7 links on the map");
  });

  it("an outside link that changes the scope selects its node once the scoped map lands — never a false 'not on this map'", async () => {
    g.scopedGraph = scoped([node("cbunit:99", "unit", "Hydrotreater", { unitCode: "99", degree: 0 })]);
    await render(page());
    expect(g.build).toEqual([["o1"]]);
    nav.params = new URLSearchParams("scope=unit%3A99&focus=cbunit%3A99");
    await render(page());
    expect(g.build[g.build.length - 1]).toEqual(["o1", { scope: { kind: "unit", code: "99" } }]);
    expect(host.querySelector('[data-testid="select-miss"]')).toBeNull();
    expect(peek()?.getAttribute("aria-label")).toBe("Unit: Hydrotreater");
  });
});

describe("GM-1 — a faded Insights row (fix pass)", () => {
  it("an orphan the lens hides is shown, then selected — never a selection the map does not draw", async () => {
    nav.params = new URLSearchParams("lens=plant");
    await render(page());
    expect(last().nodes.map((x) => x.id)).not.toContain("doc:d2");
    await click(btn(/^\s*Insights/));
    const row = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("LOOSE-2"));
    expect(row?.className).toContain("opacity-50");
    await click(row);
    expect(last().settings.hiddenTypes).not.toContain("document");
    expect(last().nodes.map((x) => x.id)).toContain("doc:d2");
    expect(peek()?.getAttribute("aria-label")).toBe("Document: LOOSE-2");
  });

  it("a hub the lens hides is shown, then selected", async () => {
    nav.params = new URLSearchParams("lens=documents");
    await render(page());
    expect(last().nodes.map((x) => x.id)).not.toContain("asset:a1");
    await click(btn(/^\s*Insights/));
    await click(btn(/Hubs/));
    const row = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("P-101"));
    expect(row?.className).toContain("opacity-50");
    await click(row);
    expect(last().settings.hiddenTypes).not.toContain("asset");
    expect(last().nodes.map((x) => x.id)).toContain("asset:a1");
    expect(peek()?.getAttribute("aria-label")).toBe("Equipment: P-101");
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

// ── Fix pass 3 ─────────────────────────────────────────────────────────────

describe("GPV-11 — a deferred URL write never lands on another page (fix pass 3)", () => {
  it("the page's write refuses once the browser has left /graph, and writes while it is on it", async () => {
    await render(page());
    expect(gv.write).toBeTruthy();
    const spy = vi.spyOn(window.history, "replaceState");
    // A client-side navigation the page has not unmounted for yet.
    window.history.pushState(null, "", "/documents/L1?doc=d1");
    expect(gv.write!({ qs: "lens=plant", href: "/graph?lens=plant" })).toBe("noop");
    expect(spy).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/documents/L1?doc=d1");
    // Back on the graph, the same write lands.
    window.history.pushState(null, "", "/graph");
    expect(gv.write!({ qs: "lens=plant", href: "/graph?lens=plant" })).toBe("done");
    expect(window.location.search).toBe("?lens=plant");
  });

  // A write the budget deferred, then a navigation away before the page
  // unmounts: the timer comes due and must not rewrite that page's entry.
  const deferAWrite = async () => {
    nav.params = new URLSearchParams("local=asset%3Aa1&depth=1");
    await render(page());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Spend the budget (each click is its own commit and its own push) …
    for (let i = 0; i < URL_WRITE_BURST + 4; i++) {
      await act(async () => { (btn(i % 2 === 0 ? "One hop more" : "One hop fewer") as HTMLElement).click(); });
    }
    await flush();
    // … then one change never written before: it waits for the budget.
    await act(async () => { last().onSelect(last().nodes.find((n) => n.id === "cbunit:20")!); });
    await flush();
    expect(window.location.search).not.toContain("select=");
  };
  const comeDue = async () => {
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await flush();
  };

  it("control: with the browser still on /graph, the deferred write lands when the budget refills", async () => {
    try {
      await deferAWrite();
      await comeDue();
      expect(window.location.pathname).toBe("/graph");
      expect(window.location.search).toContain("select=cbunit%3A20");
    } finally { vi.useRealTimers(); }
  }, 20_000);

  it("a navigation away before unmount: the deferred write never rewrites the other page's URL", async () => {
    try {
      await deferAWrite();
      const spy = vi.spyOn(window.history, "replaceState");
      window.history.pushState(null, "", "/documents/L1?doc=d1");
      await comeDue();
      expect(`${window.location.pathname}${window.location.search}`).toBe("/documents/L1?doc=d1");
      expect(spy).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  }, 20_000);

  it("a route change the page renders before it unmounts: nothing is written over the new path, and nothing is pushed for it", async () => {
    try {
      await deferAWrite();
      const spy = vi.spyOn(window.history, "replaceState");
      window.history.pushState(null, "", "/documents/L1?doc=d1");
      nav.pathname = "/documents/L1";
      await render(page());
      await comeDue();
      expect(`${window.location.pathname}${window.location.search}`).toBe("/documents/L1?doc=d1");
      expect(spy).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  }, 20_000);

  // The two cases above pass on the location guard alone. These two put the
  // browser back on /graph before the write comes due, so the guard lets a
  // surviving write through: only the cancel stops it (fix pass 4).
  it("a route change away cancels the pending write: back on /graph before it comes due, nothing is written (fix pass 4)", async () => {
    try {
      await deferAWrite();
      const spy = vi.spyOn(window.history, "replaceState");
      window.history.pushState(null, "", "/documents/L1?doc=d1");
      nav.pathname = "/documents/L1";
      await render(page());
      // Back on a /graph entry before the budget refills.
      window.history.pushState(null, "", "/graph");
      await comeDue();
      expect(spy).not.toHaveBeenCalled();
      expect(`${window.location.pathname}${window.location.search}`).toBe("/graph");
    } finally { vi.useRealTimers(); }
  }, 20_000);

  it("Back / Forward on /graph (popstate) cancels the pending write: the entry the browser moved to is never overwritten (fix pass 4)", async () => {
    try {
      await deferAWrite();
      const spy = vi.spyOn(window.history, "replaceState");
      // The browser moves to another /graph entry, then fires popstate.
      window.history.pushState(null, "", "/graph?lens=plant");
      await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); });
      await comeDue();
      expect(spy).not.toHaveBeenCalled();
      expect(`${window.location.pathname}${window.location.search}`).toBe("/graph?lens=plant");
    } finally { vi.useRealTimers(); }
  }, 20_000);
});

describe("GM-7 — the proposals chip follows what is drawn (fix pass 3)", () => {
  const onePair = { documentId: "d1", targetDocumentId: "d2", proposer: "tag", nodeA: "doc:d1", nodeB: "doc:d2" };

  it("Proposals off: no chip and no proposal notes, however long the queue", async () => {
    g.proposals = { pairs: [onePair], total: 9000, capped: true, error: null };
    window.localStorage.setItem(settingsKey("o1"), JSON.stringify({ version: 2, showProposals: false }));
    await render(page());
    expect(last().edges.some((e) => e.type === "proposed")).toBe(false);
    expect(host.querySelector('[data-testid="proposals-chip"]')).toBeNull();
    expect(host.querySelector('[data-testid="proposals-capped"]')).toBeNull();
  });

  it("Proposals off: a failed read is not announced over a drawing the person turned off", async () => {
    g.proposals = { pairs: [], total: null, capped: false, error: "statement timeout" };
    window.localStorage.setItem(settingsKey("o1"), JSON.stringify({ version: 2, showProposals: false }));
    await render(page());
    expect(host.querySelector('[data-testid="proposals-error"]')).toBeNull();
  });

  it("Proposals on, but this view draws no ghost: no chip (the base's rule)", async () => {
    g.proposals = { pairs: [onePair], total: 5, capped: false, error: null };
    nav.params = new URLSearchParams("lens=plant");
    await render(page());
    expect(last().edges.some((e) => e.type === "proposed")).toBe(false);
    expect(host.querySelector('[data-testid="proposals-chip"]')).toBeNull();
  });

  it("Proposals on, a ghost drawn: the chip counts the reader's queue", async () => {
    g.proposals = { pairs: [onePair], total: 5, capped: false, error: null };
    await render(page());
    expect(host.querySelector('[data-testid="proposals-chip"]')?.textContent).toBe("5 connections awaiting review · 1 drawn here");
    // Turning Proposals off in Settings takes the chip away with the ghosts.
    await click(btn("Settings"));
    const toggle = [...host.querySelectorAll("label, button")].find((el) => el.textContent?.trim().startsWith("Proposed connections"));
    const input = toggle?.querySelector("input") ?? toggle;
    await click(input as HTMLElement);
    expect((last().settings as unknown as { showProposals: boolean }).showProposals).toBe(false);
    expect(last().edges.some((e) => e.type === "proposed")).toBe(false);
    expect(host.querySelector('[data-testid="proposals-chip"]')).toBeNull();
  });
});

describe("GM-11 — the peek's numbers say what each counts (fix pass 3)", () => {
  it("the header counts links (no proposal); the list counts nodes, naming those tied only by a proposal", async () => {
    g.proposals = { pairs: [{ documentId: "d1", targetDocumentId: "d2", proposer: "tag", nodeA: "doc:d1", nodeB: "doc:d2" }], total: 1, capped: false, error: null };
    nav.params = new URLSearchParams("focus=d1");
    await render(page());
    expect(host.querySelector('[data-testid="peek-degree"]')?.textContent).toBe("Document · 3 links on the map (1 library filing) · 1 link in this view");
    expect(host.querySelector('[data-testid="peek-connected"]')?.textContent).toBe("Connected in this view · 2 nodes (1 only by a proposed link)");
  });

  it("with no proposal, the list names no proposal part", async () => {
    nav.params = new URLSearchParams("focus=asset%3Aa1");
    await render(page());
    expect(host.querySelector('[data-testid="peek-connected"]')?.textContent).toBe("Connected in this view · 3 nodes");
  });
});

describe("GM-1 — a bridge the view hides (fix pass 3)", () => {
  // Two rings of four — documents and equipment — held together by ONE tag.
  const withBridge = (): OrgGraph => {
    const base = baseGraph();
    const docs = ["b1", "b2", "b3", "b4"].map((id) => node(`doc:${id}`, "document", `DOC-${id}`, { degree: 2 }));
    const kit = ["x1", "x2", "x3", "x4"].map((id) => node(`asset:${id}`, "asset", `E-${id}`, { degree: 2 }));
    return {
      ...base,
      nodes: [...base.nodes, ...docs, ...kit],
      edges: [
        ...base.edges,
        edge("doc:b1", "doc:b2", "related"), edge("doc:b2", "doc:b3", "related"), edge("doc:b3", "doc:b4", "related"), edge("doc:b4", "doc:b1", "related"),
        edge("asset:x1", "asset:x2", "flow"), edge("asset:x2", "asset:x3", "flow"), edge("asset:x3", "asset:x4", "flow"), edge("asset:x4", "asset:x1", "flow"),
        edge("doc:b1", "asset:x1", "tag"),
      ],
    };
  };
  const openBridges = async () => {
    await click(btn(/^\s*Insights/));
    await click(btn(/Bridges/));
  };

  it("drawn: the row is not faded and a click lights the pair up (as before)", async () => {
    g.graph = withBridge();
    await render(page());
    await openBridges();
    const rows = host.querySelectorAll('[data-testid="bridge-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].className).not.toContain("opacity-50");
    await click(rows[0]);
    expect([...last().flyTo!.ids].sort()).toEqual(["asset:x1", "doc:b1"]);
    expect(peek()).toBeNull();
  });

  it("hidden by the lens: faded and said; a click shows both ends, then lights the pair up on the map", async () => {
    g.graph = withBridge();
    nav.params = new URLSearchParams("lens=plant");
    await render(page());
    expect(last().nodes.map((n) => n.id)).not.toContain("doc:b1");
    await openBridges();
    const row = host.querySelector('[data-testid="bridge-row"]')!;
    expect(row.className).toContain("opacity-50");
    expect(text()).toContain("1 of these is hidden by the current view (faded)");
    await click(row);
    expect(last().settings.hiddenTypes).not.toContain("document");
    const drawn = last().nodes.map((n) => n.id);
    expect(drawn).toContain("doc:b1");
    expect(drawn).toContain("asset:x1");
    // Every id the spotlight names is drawn.
    expect(last().flyTo!.ids.every((id) => drawn.includes(id))).toBe(true);
    expect([...last().flyTo!.ids].sort()).toEqual(["asset:x1", "doc:b1"]);
    expect(host.querySelector('[data-testid="bridge-row"]')!.className).not.toContain("opacity-50");
  });

  it("hidden by focus: a click leaves focus so both ends are drawn", async () => {
    g.graph = withBridge();
    nav.params = new URLSearchParams("local=asset%3Aa1&depth=1");
    await render(page());
    expect(last().nodes.map((n) => n.id)).not.toContain("doc:b1");
    await openBridges();
    await click(host.querySelector('[data-testid="bridge-row"]'));
    expect(text()).not.toContain("Focused: P-101");
    expect(last().nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["doc:b1", "asset:x1"]));
  });

  // The page's renderer stand-in records props; the camera lives in the REAL
  // OrgGraph2D. Its fly is a child effect — it runs before the page's own
  // effects — so a spotlight set in the same commit as the reveal framed the
  // pair before the page fed the simulation the revealed end: the camera
  // went to the end already drawn, or nowhere when both were hidden.
  describe("on the REAL 2D renderer, the reveal frames both ends (fix pass 4)", () => {
    let frames: FrameRequestCallback[] = [];
    let translates: number[][] = [];
    beforeEach(() => {
      g.real2D = true;
      frames = []; translates = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
      vi.stubGlobal("cancelAnimationFrame", () => undefined);
      vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
      // A canvas context that accepts every call and keeps translate's
      // arguments: the frame's last translate is (-camera.x, -camera.y).
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => new Proxy({}, {
        get(_t, prop: string) {
          return (...args: unknown[]) => {
            if (prop === "translate") translates.push(args as number[]);
            if (prop === "measureText") return { width: 10 };
            if (prop === "createRadialGradient") return { addColorStop: () => undefined };
            return undefined;
          };
        },
        set() { return true; },
      }) as unknown as CanvasRenderingContext2D);
      // The two ends' saved 2D positions, far apart: the midpoint, either
      // end and the camera's start (0, 0) are four different places.
      window.localStorage.setItem("orgGraph:pos:o1", JSON.stringify({ "asset:x1": [-600, 200, 0], "doc:b1": [600, 400, 0] }));
    });
    /** Run the frame loop until the eased camera has arrived; where it is. */
    const camera = async () => {
      for (let i = 0; i < 400 && frames.length > 0; i++) {
        const f = frames.shift()!;
        await act(async () => { f(performance.now()); });
      }
      const t = translates[translates.length - 1];
      return { x: -t[0], y: -t[1] };
    };

    it("one end hidden by the lens: the camera ends at the pair's midpoint, not at the drawn end", async () => {
      g.graph = withBridge();
      nav.params = new URLSearchParams("lens=plant");
      await render(page());
      expect(host.querySelector("canvas")).toBeTruthy();
      expect(last().nodes.map((n) => n.id)).toContain("asset:x1");
      expect(last().nodes.map((n) => n.id)).not.toContain("doc:b1");
      await openBridges();
      await click(host.querySelector('[data-testid="bridge-row"]'));
      const cam = await camera();
      expect(Math.abs(cam.x - 0)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(cam.y - 300)).toBeLessThanOrEqual(0.5);
    });

    it("both ends hidden by focus: the camera still flies, to the pair's midpoint", async () => {
      g.graph = withBridge();
      nav.params = new URLSearchParams("local=asset%3Aa1&depth=1");
      await render(page());
      expect(last().nodes.map((n) => n.id)).not.toContain("asset:x1");
      expect(last().nodes.map((n) => n.id)).not.toContain("doc:b1");
      await openBridges();
      await click(host.querySelector('[data-testid="bridge-row"]'));
      const cam = await camera();
      expect(Math.abs(cam.x - 0)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(cam.y - 300)).toBeLessThanOrEqual(0.5);
    });
  });
});

describe("GPV-13 — the keyboard's walk is memoised on what changes it (fix pass 3)", () => {
  it("a keystroke that cannot change the walk recomputes nothing; a selection never redoes the full sort", async () => {
    await render(page());
    const region = host.querySelector('[role="application"]') as HTMLDivElement;
    await key(region, "ArrowDown");
    const status = host.querySelector("#graph-keyboard-status")?.textContent;
    vi.mocked(keyboardOrder).mockClear();
    vi.mocked(keyboardBaseOrder).mockClear();
    const input = host.querySelector("input[data-graph-search]") as HTMLInputElement;
    await typeInto(input, "p");                   // one character: the walk is unchanged
    expect(keyboardOrder).not.toHaveBeenCalled();
    expect(keyboardBaseOrder).not.toHaveBeenCalled();
    // The walk kept its place: the list did not change.
    expect(host.querySelector("#graph-keyboard-status")?.textContent).toBe(status);
    await typeInto(input, "");
    expect(keyboardOrder).not.toHaveBeenCalled();
    await typeInto(input, "pi");                  // two: the walk is the matches
    expect(keyboardOrder).toHaveBeenCalledTimes(1);
    await typeInto(input, "");
    vi.mocked(keyboardOrder).mockClear();
    await act(async () => { last().onSelect(last().nodes.find((n) => n.id === "doc:d2")!); });
    await flush();
    expect(keyboardOrder).toHaveBeenCalledTimes(1);
    expect(keyboardBaseOrder).not.toHaveBeenCalled();
  });

  it("the walk is the same list it always was (matches, neighbours, everything by weight)", async () => {
    nav.params = new URLSearchParams("select=asset%3Aa1");
    await render(page());
    const region = host.querySelector('[role="application"]') as HTMLDivElement;
    await key(region, "ArrowDown");
    // P-101's neighbours, most connected first: Crude Unit (3), PID-1 (3), Coker (1).
    expect(host.querySelector("#graph-keyboard-status")?.textContent).toMatch(/^Crude Unit, Unit, 3 links — 1 of 3\./);
  });
});
