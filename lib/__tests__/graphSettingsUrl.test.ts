// intelligence Round G (I-14) — the graph's lenses, its URL contract and
// the settings every earlier build saved.
//
//   * GPV-10 / GPV-4 / GM-10: each lens is named for what it SHOWS and its
//     hidden list produces exactly that; no lens is named by a single
//     node-type word; a hand-tuned filter still says which lens it drifted
//     from.
//   * GPV-11: lens / filter, focus and depth, scope, search, an asked
//     question and the peeked node round-trip through the URL; `?focus=` —
//     every existing link's spelling — keeps its meaning (select the node);
//     only the graph's own keys survive the Back-to-graph round trip.
//   * Regression (the top rule): a settings blob saved by any earlier build
//     loads — defaults for what it lacks, never a throw; the scope is never
//     restored from storage; GPV-8's arrows default migrates a v1 blob.

import { describe, it, expect, beforeEach } from "vitest";
import {
  GRAPH_LENSES, GRAPH_NODE_TYPES, DEFAULT_GRAPH_SETTINGS, GRAPH_SETTINGS_VERSION,
  matchLens, lensByKey, parseGraphUrl, formatGraphUrl, urlFilterOf, applyGraphUrl,
  sanitizeGraphQuery, nodeIdParam, migrateSettings, loadSettings, saveSettings, settingsKey,
} from "@/lib/graphSettings";
import type { GraphNodeType } from "@/lib/orgGraph";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
});

const shown = (hidden: GraphNodeType[], libEdges: boolean) =>
  GRAPH_NODE_TYPES.filter((t) => !hidden.includes(t) && (t !== "library" || libEdges)).sort();

describe("GPV-10 / GPV-4 / GM-10 — lenses named for what they show", () => {
  it("is the plan's lens set, in order", () => {
    expect(GRAPH_LENSES.map((l) => l.label)).toEqual([
      "Everything", "Plant (units & equipment)", "Equipment ↔ Documents", "Documents & libraries",
    ]);
  });

  it("each lens's hidden list produces exactly the node types its title names", () => {
    const by = (k: string) => lensByKey(k)!;
    expect(shown(by("all").hidden, by("all").libEdges)).toEqual(["asset", "document", "plant", "plot", "project", "unit"]);
    // Plant: plants, units (with systems) and equipment — the old "Process"
    // lens said "units and equipment only" and left plants in silently.
    expect(shown(by("plant").hidden, by("plant").libEdges)).toEqual(["asset", "plant", "unit"]);
    expect(by("plant").title).toMatch(/plants, units, systems and equipment/);
    // Equipment ↔ Documents: plot plans are hidden now (the old lens left them in).
    expect(shown(by("equipment-docs").hidden, by("equipment-docs").libEdges)).toEqual(["asset", "document"]);
    expect(shown(by("documents").hidden, by("documents").libEdges)).toEqual(["document", "library", "project"]);
    expect(by("documents").title).toMatch(/libraries/);
    expect(by("documents").title).toMatch(/projects/);
    expect(by("all").title).toMatch(/Library filing is left out/);
  });

  it("no lens is named by a single node-type word, and none is named for what it hides", () => {
    const typeWords = ["Documents", "Equipment", "Units", "Libraries", "Projects", "Plants", "Plot plans"];
    for (const l of GRAPH_LENSES) {
      expect(typeWords).not.toContain(l.label);
      expect(l.label).not.toMatch(/\b(no|without|except|hide|hidden)\b/i);
    }
  });

  it("matchLens: exact, a near miss names the lens it drifted from, far is none", () => {
    expect(matchLens([], false)).toEqual({ lens: lensByKey("all"), exact: true });
    expect(matchLens(["document", "library", "project", "plot"], false)).toMatchObject({ exact: true, lens: { key: "plant" } });
    // The user unticks Plants on the Plant lens: still "a variation of Plant".
    expect(matchLens(["document", "library", "project", "plot", "plant"], false)).toMatchObject({ exact: false, lens: { key: "plant" } });
    // Order and duplicates do not matter.
    expect(matchLens(["plot", "document", "project", "library", "plot"], false)).toMatchObject({ exact: true, lens: { key: "plant" } });
    expect(matchLens(["asset", "document", "unit", "plant", "project"], true).lens).toBeNull();
  });
});

describe("GPV-11 — the URL reproduces the view", () => {
  it("round-trips lens, focus + depth, scope, search, ask and the peeked node", () => {
    const qs = formatGraphUrl({
      lens: "plant", local: "asset:E-2201", depth: 2, scope: { kind: "unit", code: "20" },
      q: "pipe supports", ask: true, select: "doc:abc",
    });
    const back = parseGraphUrl(new URLSearchParams(qs));
    expect(back).toEqual({
      lens: "plant", hide: null, libs: null, local: "asset:E-2201", depth: 2,
      scope: { kind: "unit", code: "20" }, q: "pipe supports", ask: true, select: "doc:abc",
    });
    expect(qs).toContain("scope=unit%3A20");
  });

  it("a filter no lens matches is spelled out (hide + libs)", () => {
    const filter = urlFilterOf({ hiddenTypes: ["plot", "plant"], showLibraryEdges: true });
    expect(filter).toEqual({ lens: null, hide: ["plot", "plant"], libs: true });
    const back = parseGraphUrl(new URLSearchParams(formatGraphUrl(filter)));
    expect(back.hide).toEqual(["plot", "plant"]);
    expect(back.libs).toBe(true);
    expect(urlFilterOf({ hiddenTypes: [], showLibraryEdges: false })).toEqual({ lens: "all", hide: null, libs: null });
  });

  it("regression: ?focus=<bare id> is a document and ?focus=<kind:id> any node — read as the selection", () => {
    expect(parseGraphUrl(new URLSearchParams("focus=1234-abcd")).select).toBe("doc:1234-abcd");
    expect(parseGraphUrl(new URLSearchParams("focus=asset%3Aabc")).select).toBe("asset:abc");
    expect(parseGraphUrl(new URLSearchParams("scope=unit%3A20&focus=cbunit%3A20"))).toMatchObject({
      select: "cbunit:20", scope: { kind: "unit", code: "20" }, local: null,
    });
    // ?select= wins over the legacy name; the page writes select, never focus.
    expect(parseGraphUrl(new URLSearchParams("select=doc%3Ax&focus=doc%3Ay")).select).toBe("doc:x");
    expect(formatGraphUrl({ select: "doc:x" }, "focus=doc%3Ay")).toBe("select=doc%3Ax");
  });

  it("drops malformed values instead of throwing", () => {
    const u = parseGraphUrl(new URLSearchParams("lens=process&depth=9&scope=unit:<script>&local=a b&q=&ask=1&hide=document,bogus"));
    expect(u).toEqual({
      lens: null, hide: ["document"], libs: null, local: null, depth: null, scope: null, q: null, ask: false, select: null,
    });
    expect(nodeIdParam("doc:../../x")).toBeNull();
  });

  it("keeps parameters it does not own", () => {
    expect(formatGraphUrl({ lens: "all" }, "utm=x&lens=documents")).toBe("utm=x&lens=all");
  });

  it("applies a URL's filter, depth and scope over loaded settings without saving them", () => {
    const base = { ...DEFAULT_GRAPH_SETTINGS, hiddenTypes: ["plot"] as GraphNodeType[], repelForce: 2.5 };
    const s = applyGraphUrl(base, parseGraphUrl(new URLSearchParams("lens=documents&depth=3&scope=unit%3A20")));
    expect(s.hiddenTypes).toEqual(lensByKey("documents")!.hidden);
    expect(s.showLibraryEdges).toBe(true);
    expect(s.localDepth).toBe(3);
    expect(s.scope).toEqual({ kind: "unit", code: "20" });
    expect(s.repelForce).toBe(2.5);              // forces stay local
    expect(store.size).toBe(0);                  // nothing written
    // A bare URL leaves the saved filter alone and clears any scope.
    const bare = applyGraphUrl({ ...base, scope: { kind: "unit", code: "9" } }, parseGraphUrl(new URLSearchParams("")));
    expect(bare.hiddenTypes).toEqual(["plot"]);
    expect(bare.scope).toBeNull();
  });

  it("Back to graph carries only the graph's own keys", () => {
    expect(sanitizeGraphQuery("lens=plant&select=asset%3Ax&from=graph&evil=1")).toBe("lens=plant&select=asset%3Ax");
    expect(sanitizeGraphQuery("?q=e-22")).toBe("q=e-22");
    expect(sanitizeGraphQuery("")).toBe("");
    expect(sanitizeGraphQuery("x".repeat(3000))).toBe("");
  });
});

describe("regression — settings saved before this change load", () => {
  it("a v1 blob (no version) loads every value it holds; arrows migrate on (GPV-8)", () => {
    store.set(settingsKey("o1"), JSON.stringify({
      mode: "3d", hiddenTypes: ["document", "library", "project", "plot"], showLibraryEdges: false,
      hideUnlinked: true, showProposals: false, groups: [{ id: "g1", query: "44-", color: "#ef4444", enabled: true }],
      labelThreshold: 0.8, nodeScale: 1.4, linkThickness: 2, linkOpacity: 0.7, showArrows: false,
      curvedLinks: false, glow: false, centerForce: 1.1, repelForce: 2, linkForce: 0.5, linkDistance: 140, localDepth: 3,
    }));
    const s = loadSettings("o1");
    expect(s).toMatchObject({
      mode: "3d", hiddenTypes: ["document", "library", "project", "plot"], hideUnlinked: true, showProposals: false,
      labelThreshold: 0.8, nodeScale: 1.4, linkThickness: 2, linkOpacity: 0.7, curvedLinks: false, glow: false,
      centerForce: 1.1, repelForce: 2, linkForce: 0.5, linkDistance: 140, localDepth: 3,
      showArrows: true, scope: null, savedViews: [], version: GRAPH_SETTINGS_VERSION,
    });
    expect(s.groups).toEqual([{ id: "g1", query: "44-", color: "#ef4444", enabled: true }]);
  });

  it("a v2 blob keeps the person's own arrows choice", () => {
    expect(migrateSettings({ version: 2, showArrows: false }).showArrows).toBe(false);
  });

  it("an empty, partial or junk blob never throws and fills defaults", () => {
    store.set(settingsKey("junk"), "{not json");
    expect(loadSettings("junk")).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(loadSettings("none")).toEqual(DEFAULT_GRAPH_SETTINGS);
    for (const raw of [null, 7, "x", [], { hiddenTypes: "asset", localDepth: 99, mode: "4d", nodeScale: "big", groups: [null, 3] }]) {
      const s = migrateSettings(raw);
      expect(s.hiddenTypes).toEqual([]);
      expect(s.mode).toBe("2d");
      expect(s.localDepth).toBeGreaterThanOrEqual(1);
      expect(s.localDepth).toBeLessThanOrEqual(5);
      expect(s.nodeScale).toBe(DEFAULT_GRAPH_SETTINGS.nodeScale);
      expect(s.groups).toEqual([]);
    }
    expect(migrateSettings({ hiddenTypes: ["asset", "nonsense", "asset"] }).hiddenTypes).toEqual(["asset"]);
  });

  it("a stored scope is never restored, and saving never stores one", () => {
    expect(migrateSettings({ version: 2, scope: { kind: "unit", code: "20" } }).scope).toBeNull();
    saveSettings("o2", { ...DEFAULT_GRAPH_SETTINGS, scope: { kind: "unit", code: "20" } });
    expect(JSON.parse(store.get(settingsKey("o2"))!).scope).toBeNull();
    expect(loadSettings("o2").scope).toBeNull();
  });

  it("saved views survive a save/load and a malformed one is dropped", () => {
    saveSettings("o3", {
      ...DEFAULT_GRAPH_SETTINGS,
      savedViews: [{ id: "v1", name: "Crude — plant", hiddenTypes: ["document"], showLibraryEdges: false, scope: { kind: "unit", code: "20" }, localDepth: 2 }],
    });
    expect(loadSettings("o3").savedViews).toEqual([
      { id: "v1", name: "Crude — plant", hiddenTypes: ["document"], showLibraryEdges: false, scope: { kind: "unit", code: "20" }, localDepth: 2 },
    ]);
    expect(migrateSettings({ savedViews: [{ id: "", name: "x" }, { id: "v", name: "" }, "junk"] }).savedViews).toEqual([]);
  });

  it("the defaults: arrows on, the Everything lens, no scope", () => {
    expect(DEFAULT_GRAPH_SETTINGS.showArrows).toBe(true);
    expect(matchLens(DEFAULT_GRAPH_SETTINGS.hiddenTypes, DEFAULT_GRAPH_SETTINGS.showLibraryEdges)).toMatchObject({ exact: true, lens: { key: "all" } });
    expect(DEFAULT_GRAPH_SETTINGS.scope).toBeNull();
  });
});
