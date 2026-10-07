// intelligence Round G (I-14) — the graph's lenses, its URL contract and
// the settings every earlier build saved.
//
//   * GPV-10 / GPV-4 / GM-10: each lens is named for what it SHOWS and its
//     hidden list produces exactly that; a hand-tuned filter still says which
//     lens it drifted from.
//   * GPV-4 (I-24, DEC-88 item 1 as rewritten under DEC-90): no lens LABEL
//     contains a node-type word — the words are read from the Filters
//     drawer's own labels (components/graph/GraphControls.tsx TYPE_LABELS),
//     so a lens and a node type never share a name. The rename is label-only:
//     the keys a URL (?lens=), a stored settings blob and a saved view carry
//     are unchanged, and every place outside the lens bar that names a lens
//     names it by its label.
//   * GPV-11: lens / filter, focus and depth, scope, search, an asked
//     question and the peeked node round-trip through the URL; `?focus=` —
//     every existing link's spelling — keeps its meaning (select the node);
//     only the graph's own keys survive the Back-to-graph round trip.
//   * Regression (the top rule): a settings blob saved by any earlier build
//     loads — defaults for what it lacks, never a throw; the scope is never
//     restored from storage; GPV-8's arrows default migrates a v1 blob.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GRAPH_LENSES, GRAPH_NODE_TYPES, DEFAULT_GRAPH_SETTINGS, GRAPH_SETTINGS_VERSION,
  matchLens, lensByKey, parseGraphUrl, formatGraphUrl, urlFilterOf, applyGraphUrl,
  sanitizeGraphQuery, nodeIdParam, migrateSettings, loadSettings, saveSettings, settingsKey,
} from "@/lib/graphSettings";
import { UNIT_VARIANT_LABELS } from "@/components/graph/graphTheme";
import { FEATURE_ATLAS } from "@/lib/featureAtlas";
import type { GraphNodeType } from "@/lib/orgGraph";

const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

/** The node-type labels exactly as the Filters drawer renders them — read
 *  from the component's source, so a label added or renamed there is
 *  checked here without a second list to keep in step. */
function filterTypeLabels(): Record<string, string> {
  const body = src("components/graph/GraphControls.tsx")
    .match(/const TYPE_LABELS: Record<GraphNodeType, string> = \{([\s\S]*?)\};/)?.[1];
  if (!body) throw new Error("TYPE_LABELS not found in components/graph/GraphControls.tsx");
  return Object.fromEntries([...body.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

const singular = (w: string) => (w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("s") ? w.slice(0, -1) : w);
const wordsOf = (s: string) => (s.toLowerCase().match(/[a-z]+/g) ?? []);

/** Every node-type word, plural and singular: each word of each Filters
 *  label ("Plot plans" gives plot and plan), each type key (asset), and the
 *  unit class's System kind (systems are folded into units, DEC-67, and the
 *  Filters list names them). */
function nodeTypeWords(): Set<string> {
  const out = new Set<string>();
  const add = (w: string) => { out.add(w); out.add(singular(w)); };
  for (const label of Object.values(filterTypeLabels())) wordsOf(label).forEach(add);
  for (const t of GRAPH_NODE_TYPES) wordsOf(t).forEach(add);
  wordsOf(UNIT_VARIANT_LABELS.system).forEach(add);
  return out;
}

/** The node-type words a label uses, in order (both forms compared). */
const typeWordsIn = (label: string, typeWords = nodeTypeWords()) =>
  wordsOf(label).filter((w) => typeWords.has(w) || typeWords.has(singular(w)));

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
  it("is DEC-88's lens set, in order: the labels renamed (I-24), the keys unchanged", () => {
    expect(GRAPH_LENSES.map((l) => l.label)).toEqual([
      "Whole map", "Process layout", "Governing paper", "Records & filing",
    ]);
    // The keys are the URL / settings / saved-view contract — never renamed.
    expect(GRAPH_LENSES.map((l) => l.key)).toEqual(["all", "plant", "equipment-docs", "documents"]);
  });

  it("each lens's hidden list produces exactly the node types its title names", () => {
    const by = (k: string) => lensByKey(k)!;
    expect(shown(by("all").hidden, by("all").libEdges)).toEqual(["asset", "document", "plant", "plot", "project", "unit"]);
    // Process layout (key plant): plants, units (with systems) and equipment
    // — the old "Process" lens said "units and equipment only" and left
    // plants in silently.
    expect(shown(by("plant").hidden, by("plant").libEdges)).toEqual(["asset", "plant", "unit"]);
    expect(by("plant").title).toMatch(/plants, units, systems and equipment/);
    // Governing paper (key equipment-docs): plot plans are hidden now (the
    // old lens left them in).
    expect(shown(by("equipment-docs").hidden, by("equipment-docs").libEdges)).toEqual(["asset", "document"]);
    expect(shown(by("documents").hidden, by("documents").libEdges)).toEqual(["document", "library", "project"]);
    expect(by("documents").title).toMatch(/libraries/);
    expect(by("documents").title).toMatch(/projects/);
    expect(by("all").title).toMatch(/Library filing is left out/);
  });

  it("no lens label contains a node-type word (the Filters drawer's own labels), and none is named for what it hides", () => {
    const labels = filterTypeLabels();
    // The source read is whole: one label per node type, the drawer's words.
    expect(Object.keys(labels).sort()).toEqual([...GRAPH_NODE_TYPES].sort());
    expect(labels.asset).toBe("Equipment");          // the node type keeps "Equipment"
    const typeWords = nodeTypeWords();
    for (const l of GRAPH_LENSES) {
      expect(typeWordsIn(l.label, typeWords), `lens "${l.label}" (${l.key})`).toEqual([]);
      expect(l.label).not.toMatch(/\b(no|without|except|hide|hidden)\b/i);
    }
  });

  it("the check is real: the labels I-14 shipped each fail it (GPV-4's reproduction)", () => {
    // Done-when 1 was not met by these — three of four reuse node-type words.
    expect(typeWordsIn("Plant (units & equipment)")).toEqual(["plant", "units", "equipment"]);
    expect(typeWordsIn("Equipment ↔ Documents")).toEqual(["equipment", "documents"]);
    expect(typeWordsIn("Documents & libraries")).toEqual(["documents", "libraries"]);
    // Singular, plural and the type key are all caught.
    expect(typeWordsIn("Plot plan")).toEqual(["plot", "plan"]);
    expect(typeWordsIn("Asset view")).toEqual(["asset"]);
    expect(typeWordsIn("Systems")).toEqual(["systems"]);
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

  it("the defaults: arrows on, the Whole map lens (key all), no scope", () => {
    expect(DEFAULT_GRAPH_SETTINGS.showArrows).toBe(true);
    expect(matchLens(DEFAULT_GRAPH_SETTINGS.hiddenTypes, DEFAULT_GRAPH_SETTINGS.showLibraryEdges)).toMatchObject({ exact: true, lens: { key: "all" } });
    expect(DEFAULT_GRAPH_SETTINGS.scope).toBeNull();
  });
});

describe("GPV-4 (I-24) — the rename is label-only: every link, stored blob and saved view loads the same lens", () => {
  // Each lens key with the hidden list it produced before the rename — the
  // pin is literal, so a key that changed its meaning would fail here.
  const BEFORE: Array<[string, GraphNodeType[], boolean]> = [
    ["all", [], false],
    ["plant", ["document", "library", "project", "plot"], false],
    ["equipment-docs", ["unit", "plant", "project", "library", "plot"], false],
    ["documents", ["asset", "unit", "plant", "plot"], true],
  ];

  it("every existing ?lens= URL parses to the same key, applies the same filter and writes the same URL", () => {
    for (const [key, hidden, libEdges] of BEFORE) {
      const url = parseGraphUrl(new URLSearchParams(`lens=${key}`));
      expect(url.lens, key).toBe(key);
      const s = applyGraphUrl(DEFAULT_GRAPH_SETTINGS, url);
      expect(s.hiddenTypes, key).toEqual(hidden);
      expect(s.showLibraryEdges, key).toBe(libEdges);
      expect(matchLens(s.hiddenTypes, s.showLibraryEdges)).toMatchObject({ exact: true, lens: { key } });
      expect(urlFilterOf(s)).toEqual({ lens: key, hide: null, libs: null });
      expect(formatGraphUrl(urlFilterOf(s))).toBe(`lens=${encodeURIComponent(key)}`);
      // The same link with the page's other keys still means the same lens.
      expect(parseGraphUrl(new URLSearchParams(`lens=${key}&select=asset%3Aa1&depth=2`)).lens).toBe(key);
    }
  });

  it("a label is display only: it is never read as a key, old or new", () => {
    for (const label of ["Whole map", "Process layout", "Governing paper", "Records & filing",
      "Everything", "Plant (units & equipment)", "Equipment ↔ Documents", "Documents & libraries"]) {
      expect(lensByKey(label), label).toBeNull();
      expect(parseGraphUrl(new URLSearchParams({ lens: label })).lens, label).toBeNull();
    }
  });

  it("a v1 blob (no version) holding each lens's filter loads as that lens, under its new label", () => {
    const labels: Record<string, string> = {
      all: "Whole map", plant: "Process layout", "equipment-docs": "Governing paper", documents: "Records & filing",
    };
    for (const [key, hidden, libEdges] of BEFORE) {
      store.set(settingsKey(`v1-${key}`), JSON.stringify({ mode: "2d", hiddenTypes: hidden, showLibraryEdges: libEdges, showArrows: false }));
      const s = loadSettings(`v1-${key}`);
      expect(s.hiddenTypes, key).toEqual(hidden);
      expect(s.showLibraryEdges, key).toBe(libEdges);
      const m = matchLens(s.hiddenTypes, s.showLibraryEdges);
      expect(m.exact, key).toBe(true);
      expect(m.lens?.key, key).toBe(key);
      expect(m.lens?.label, key).toBe(labels[key]);
    }
  });

  it("a v2 blob with saved views keeps each view's filter, and it is still the lens it was", () => {
    store.set(settingsKey("v2"), JSON.stringify({
      version: 2, hiddenTypes: ["asset", "unit", "plant", "plot"], showLibraryEdges: true,
      savedViews: [
        { id: "v1", name: "Plant lens — crude", hiddenTypes: ["document", "library", "project", "plot"], showLibraryEdges: false, scope: { kind: "unit", code: "20" }, localDepth: 2 },
        { id: "v2", name: "Equipment ↔ Documents", hiddenTypes: ["unit", "plant", "project", "library", "plot"], showLibraryEdges: false, localDepth: 1 },
      ],
    }));
    const s = loadSettings("v2");
    expect(matchLens(s.hiddenTypes, s.showLibraryEdges)).toMatchObject({ exact: true, lens: { key: "documents", label: "Records & filing" } });
    // A view's name is the person's own words — kept as they typed it.
    expect(s.savedViews.map((v) => v.name)).toEqual(["Plant lens — crude", "Equipment ↔ Documents"]);
    expect(matchLens(s.savedViews[0].hiddenTypes, s.savedViews[0].showLibraryEdges).lens?.key).toBe("plant");
    expect(matchLens(s.savedViews[1].hiddenTypes, s.savedViews[1].showLibraryEdges).lens?.key).toBe("equipment-docs");
    expect(s.savedViews[0].scope).toEqual({ kind: "unit", code: "20" });
  });

  it("a saved blob never holds a lens label (labels are display only)", () => {
    for (const [key, hidden, libEdges] of BEFORE) {
      saveSettings(`save-${key}`, { ...DEFAULT_GRAPH_SETTINGS, hiddenTypes: hidden, showLibraryEdges: libEdges });
      const raw = store.get(settingsKey(`save-${key}`))!;
      for (const l of GRAPH_LENSES) expect(raw, key).not.toContain(l.label);
      expect(JSON.parse(raw).hiddenTypes).toEqual(hidden);
    }
  });
});

describe("GPV-4 (I-24) — every place outside the lens bar that names a lens names it by its label", () => {
  const label = (k: string) => lensByKey(k)!.label;

  it("the graph page's Connect help names the flow lens by its label, never a node-type word", () => {
    const page = src("app/(protected)/graph/page.tsx");
    expect(page).toContain(`drawn with an arrow on the ${label("plant")} lens.`);
    expect(page).not.toMatch(/\b(Plant|Process|Equipment|Documents?) lens\b/);
  });

  it("the setup navigator's 'Map the process' step names the same lens", () => {
    const setup = src("app/(protected)/setup/page.tsx");
    expect(setup).toContain(`draw them on the ${label("plant")} lens`);
    expect(setup).not.toMatch(/\b(Plant|Process|Equipment|Documents?) lens\b/);
  });

  it("the feature atlas (⌘K and the assistant's app map) lists the four lenses by their labels", () => {
    const graph = FEATURE_ATLAS.find((e) => e.href === "/graph")!;
    for (const l of GRAPH_LENSES) expect(graph.blurb, l.key).toContain(l.label);
    for (const old of ["Everything", "Equipment ↔ Docs", "Process (flow map)", "Documents."]) {
      expect(graph.blurb).not.toContain(old);
    }
  });

  it("the lens bar's header example is a label the bar can show", () => {
    expect(src("components/graph/GraphLensBar.tsx")).toContain(`("≈ ${label("plant")} — adjusted")`);
  });
});
