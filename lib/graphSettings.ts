// lib/graphSettings.ts — everything the graph lets you tune, in one shape.
//
// Persisted per user + org in localStorage: the graph you configured is the
// graph you come back to, same as the layout itself.
//
// Colour GROUPS are the idea worth stealing wholesale from Obsidian: a list
// of (query → colour) rules, applied top-down, so you can paint your own
// meaning onto the map ("everything matching 44- is amber, corrosion is
// red") instead of living with whatever the app decided.
//
// WHAT LIVES WHERE (GPV-11 — decision in DEC-88, provisional number).
// What you are LOOKING AT is in the URL, so a link reproduces it: the lens
// (or a hand-tuned filter), the focused node and its depth, the scope, the
// search, an asked question and the node in the peek (formatGraphUrl /
// parseGraphUrl). How the map is DRAWN — forces, colours, display, 2D/3D —
// stays per-org local. A settings blob saved by any earlier build loads:
// migrateSettings defaults whatever it lacks and never throws.
//
// LENSES (GPV-10 / GPV-4 / GM-10). Each lens is named for what it SHOWS,
// never for what it hides, and its hidden list produces exactly that view.
// No lens label contains a node-type word (DEC-88 item 1, intelligence
// I-24): "Equipment" names the node type alone, so "turn on the Equipment
// lens" cannot be mistaken for the Equipment filter. A label is display
// only — the KEY is what a URL (?lens=), a stored blob and a saved view
// carry, and it never changes with a label. A scope (one unit's world) is a
// separate control, not a lens.

import type { GraphNodeType } from "@/lib/orgGraph";
import { parseScopeParam, formatScopeParam, type ScopeRef } from "@/lib/scope";

export interface ColorGroup {
  id: string;
  /** Matched against a node's label, punctuation-insensitively. A leading
   *  "type:" scopes to a node type instead ("type:asset"). */
  query: string;
  color: string;
  enabled: boolean;
}

export interface GraphSettings {
  mode: "2d" | "3d";

  // ── Filters ──
  hiddenTypes: GraphNodeType[];
  showLibraryEdges: boolean;
  hideUnlinked: boolean;
  showProposals: boolean;

  // ── Groups ──
  groups: ColorGroup[];

  // ── Display ──
  /** Zoom level past which labels appear (Obsidian's "text fade threshold"). */
  labelThreshold: number;
  nodeScale: number;
  linkThickness: number;
  linkOpacity: number;
  showArrows: boolean;
  curvedLinks: boolean;
  glow: boolean;

  // ── Forces ──
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;

  // ── Local graph ──
  localDepth: number;

  // ── View (not drawing) ──
  /** GPV-2 — the unit whose world the map is assembled for (lib/scope.ts,
   *  serialised `unit:<code>`). It lives in the URL: it is never saved, so a
   *  bare /graph is always the whole org. */
  scope: ScopeRef | null;
  /** GPV-11 — views the person named and saved (a lens or filter, a scope
   *  and a depth). Local to this browser; the URL is how a view is shared. */
  savedViews: SavedGraphView[];

  /** The shape of a saved blob (GRAPH_SETTINGS_VERSION). */
  version: number;
}

/** A named view: the filter, the scope and the focus depth it was saved with. */
export interface SavedGraphView {
  id: string;
  name: string;
  hiddenTypes: GraphNodeType[];
  showLibraryEdges: boolean;
  scope: ScopeRef | null;
  localDepth: number;
}

/** 2 — GPV-8: arrows draw direction on process flows and supersession and
 *  are ON by default. A blob saved before (no version) carries the old
 *  default `showArrows: false`, which was never a choice about flows. */
export const GRAPH_SETTINGS_VERSION = 2;

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  mode: "2d",
  hiddenTypes: [],
  showLibraryEdges: false,
  hideUnlinked: false,
  showProposals: true,
  groups: [],
  labelThreshold: 0.55,
  nodeScale: 1,
  linkThickness: 1,
  linkOpacity: 1,
  showArrows: true,
  curvedLinks: true,
  glow: true,
  centerForce: 0.6,
  repelForce: 1,
  linkForce: 1,
  linkDistance: 90,
  localDepth: 2,
  scope: null,
  savedViews: [],
  version: GRAPH_SETTINGS_VERSION,
};

/** The focus depth the control offers (GraphControls, the Focused chip). */
export const LOCAL_DEPTH_MIN = 1;
export const LOCAL_DEPTH_MAX = 5;

export const GRAPH_NODE_TYPES: readonly GraphNodeType[] = ["unit", "asset", "document", "library", "project", "plant", "plot"];
const isNodeType = (t: unknown): t is GraphNodeType =>
  typeof t === "string" && (GRAPH_NODE_TYPES as readonly string[]).includes(t);

// ── Lenses ──────────────────────────────────────────────────────────────

export type LensKey = "all" | "plant" | "equipment-docs" | "documents";

export interface GraphLens {
  /** The URL / settings contract (?lens=) — never renamed. */
  key: LensKey;
  /** Named for what the lens SHOWS, in words apart from the node types.
   *  Display only: never read back from a URL or storage. */
  label: string;
  hidden: GraphNodeType[];
  libEdges: boolean;
  /** What you will see — true of the hidden list above (GPV-10). */
  title: string;
}

/** The lens set (DEC-88 item 1). Library NODES are drawn only with
 *  library links on (the filing web), so a lens that shows libraries says so
 *  with libEdges. */
export const GRAPH_LENSES: readonly GraphLens[] = [
  {
    key: "all", label: "Whole map", hidden: [], libEdges: false,
    title: "Every document, item of equipment, unit, plant, project and plot plan, with every relationship between them. Library filing is left out (Settings → Library links puts it in).",
  },
  {
    key: "plant", label: "Process layout", hidden: ["document", "library", "project", "plot"], libEdges: false,
    title: "The plant itself — plants, units, systems and equipment, with the process flows between them (an arrow points from what feeds to what is fed). Draw flows with Connect; read them off a PFD in the unit hub.",
  },
  {
    key: "equipment-docs", label: "Governing paper", hidden: ["unit", "plant", "project", "library", "plot"], libEdges: false,
    title: "Equipment and the documents that govern it — tags, the text that names it, and the links and supersession between those documents.",
  },
  {
    key: "documents", label: "Records & filing", hidden: ["asset", "unit", "plant", "plot"], libEdges: true,
    title: "The filing web — documents, the libraries they are filed in, the projects they travel through, and which revision replaced which.",
  },
];

export function lensByKey(key: string | null | undefined): GraphLens | null {
  return GRAPH_LENSES.find((l) => l.key === key) ?? null;
}

/** Which lens a filter IS (exact) or is a variation of (near: at most two
 *  differences — a type shown or hidden, or library links), else none. A
 *  hand-tuned filter therefore still says which lens it drifted from. */
export function matchLens(
  hiddenTypes: readonly GraphNodeType[], showLibraryEdges: boolean,
): { lens: GraphLens | null; exact: boolean } {
  const hidden = new Set(hiddenTypes);
  let best: GraphLens | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const l of GRAPH_LENSES) {
    const mine = new Set(l.hidden);
    let d = l.libEdges === showLibraryEdges ? 0 : 1;
    for (const t of mine) if (!hidden.has(t)) d += 1;
    for (const t of hidden) if (!mine.has(t)) d += 1;
    if (d < bestD) { best = l; bestD = d; }
  }
  if (bestD === 0) return { lens: best, exact: true };
  if (bestD <= 2) return { lens: best, exact: false };
  return { lens: null, exact: false };
}

// ── The URL (GPV-11) ────────────────────────────────────────────────────

/** Everything a /graph URL can say. Every field is optional on the way in;
 *  anything malformed is dropped, never thrown on. */
export interface GraphUrlState {
  /** A lens preset. */
  lens: LensKey | null;
  /** A filter no preset matches: the hidden node types … */
  hide: GraphNodeType[] | null;
  /** … and whether library links are on (with `hide`, or alone). */
  libs: boolean | null;
  /** Focus mode ("Go in"): the node the map is collapsed around. */
  local: string | null;
  /** Focus depth, in hops. */
  depth: number | null;
  /** The scope (`unit:<code>`). */
  scope: ScopeRef | null;
  /** The search box. */
  q: string | null;
  /** The search was asked of the documents (Enter), not only typed. */
  ask: boolean;
  /** The node in the peek. `?focus=` — the historical name every existing
   *  link uses (the document panel, the equipment page, the operating area)
   *  — is read as this, with the same meaning it always had: select the
   *  node and fly to it. Focus MODE is `local`. */
  select: string | null;
}

/** Every key the graph writes or reads ("focus" is read only). */
export const GRAPH_URL_KEYS = ["scope", "lens", "hide", "libs", "local", "depth", "select", "q", "ask"] as const;
const READ_ONLY_KEYS = ["focus"] as const;

export const EMPTY_GRAPH_URL: GraphUrlState = {
  lens: null, hide: null, libs: null, local: null, depth: null, scope: null, q: null, ask: false, select: null,
};

const NODE_ID = /^(?:[a-z]{2,12}:)?[A-Za-z0-9._-]{1,128}$/;

/** A node id from a URL: namespaced ids ("asset:…", "cbunit:20") pass as
 *  they are; a bare id keeps its historical meaning of a document. */
export function nodeIdParam(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s || !NODE_ID.test(s)) return null;
  return s.includes(":") ? s : `doc:${s}`;
}

const intIn = (raw: string | null | undefined, min: number, max: number): number | null => {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};

export function parseGraphUrl(params: { get(key: string): string | null }): GraphUrlState {
  const lens = lensByKey(params.get("lens"))?.key ?? null;
  const hideRaw = params.get("hide");
  const hide = !lens && hideRaw !== null
    ? [...new Set(hideRaw.split(",").map((t) => t.trim()).filter(isNodeType))]
    : null;
  const libsRaw = params.get("libs");
  const libs = lens ? null : libsRaw === "1" ? true : libsRaw === "0" ? false : null;
  const q = (params.get("q") ?? "").trim().slice(0, 200);
  return {
    lens, hide, libs,
    local: nodeIdParam(params.get("local")),
    depth: intIn(params.get("depth"), LOCAL_DEPTH_MIN, LOCAL_DEPTH_MAX),
    scope: parseScopeParam(params.get("scope")),
    q: q || null,
    ask: params.get("ask") === "1" && q.length >= 3,
    select: nodeIdParam(params.get("select") ?? params.get("focus")),
  };
}

/** The query string (no "?") for a view, in a stable key order. Keys the
 *  graph does not own are carried from `keep` untouched; its own keys —
 *  and the legacy `focus` — are replaced. */
export function formatGraphUrl(state: Partial<GraphUrlState>, keep?: string): string {
  const out = new URLSearchParams(keep ?? "");
  for (const k of [...GRAPH_URL_KEYS, ...READ_ONLY_KEYS]) out.delete(k);
  if (state.scope) out.set("scope", formatScopeParam(state.scope));
  if (state.lens && lensByKey(state.lens)) out.set("lens", state.lens);
  else if (state.hide) {
    out.set("hide", [...new Set(state.hide.filter(isNodeType))].join(","));
    if (state.libs !== null && state.libs !== undefined) out.set("libs", state.libs ? "1" : "0");
  } else if (state.libs !== null && state.libs !== undefined) out.set("libs", state.libs ? "1" : "0");
  const local = nodeIdParam(state.local);
  if (local) {
    out.set("local", local);
    if (state.depth) out.set("depth", String(state.depth));
  }
  const select = nodeIdParam(state.select);
  if (select) out.set("select", select);
  const q = (state.q ?? "").trim().slice(0, 200);
  if (q) {
    out.set("q", q);
    if (state.ask && q.length >= 3) out.set("ask", "1");
  }
  return out.toString();
}

/** The view part of a settings object, as the URL carries it: a preset by
 *  name, any other filter spelled out. */
export function urlFilterOf(s: Pick<GraphSettings, "hiddenTypes" | "showLibraryEdges">): Pick<GraphUrlState, "lens" | "hide" | "libs"> {
  const m = matchLens(s.hiddenTypes, s.showLibraryEdges);
  if (m.exact && m.lens) return { lens: m.lens.key, hide: null, libs: null };
  return { lens: null, hide: [...s.hiddenTypes], libs: s.showLibraryEdges };
}

/** Apply a URL's filter, depth and scope over loaded settings. Nothing here
 *  is saved — the person's stored settings stay theirs until they change
 *  something themselves. */
export function applyGraphUrl(base: GraphSettings, url: GraphUrlState): GraphSettings {
  let s: GraphSettings = { ...base, scope: url.scope };
  const lens = lensByKey(url.lens);
  if (lens) s = { ...s, hiddenTypes: [...lens.hidden], showLibraryEdges: lens.libEdges };
  else if (url.hide) s = { ...s, hiddenTypes: [...url.hide], showLibraryEdges: url.libs ?? s.showLibraryEdges };
  else if (url.libs !== null) s = { ...s, showLibraryEdges: url.libs };
  if (url.depth) s = { ...s, localDepth: url.depth };
  return s;
}

/** BackToGraphChip: the graph's own query string, carried on an open and
 *  re-read on the way back — only the graph's keys survive. */
export function sanitizeGraphQuery(raw: string | null | undefined): string {
  const s = String(raw ?? "").replace(/^\?/, "");
  if (!s || s.length > 2000) return "";
  try {
    return formatGraphUrl(parseGraphUrl(new URLSearchParams(s)));
  } catch {
    return "";
  }
}

/** Palette offered when adding a colour group — chosen to stay legible in
 *  both themes and to stay distinct from the built-in node-type colours. */
export const GROUP_PALETTE = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#6366f1", "#d946ef", "#f43f5e",
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** First matching enabled group wins, so ordering is meaningful. Returns
 *  null when nothing matches and the node keeps its type colour. */
export function groupColorFor(
  node: { label: string; type: string },
  groups: ColorGroup[],
): string | null {
  for (const g of groups) {
    if (!g.enabled) continue;
    const q = g.query.trim();
    if (!q) continue;
    if (q.toLowerCase().startsWith("type:")) {
      if (node.type === q.slice(5).trim().toLowerCase()) return g.color;
      continue;
    }
    if (norm(node.label).includes(norm(q))) return g.color;
  }
  return null;
}

export function settingsKey(orgId: string): string {
  return `orgGraph:settings:${orgId}`;
}

export function loadSettings(orgId: string): GraphSettings {
  try {
    const raw = localStorage.getItem(settingsKey(orgId));
    if (!raw) return { ...DEFAULT_GRAPH_SETTINGS };
    return migrateSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_GRAPH_SETTINGS };
  }
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const depthOf = (v: unknown, d: number) => {
  const n = Math.round(num(v, d));
  return Math.min(LOCAL_DEPTH_MAX, Math.max(LOCAL_DEPTH_MIN, n));
};
const typesOf = (v: unknown): GraphNodeType[] =>
  Array.isArray(v) ? [...new Set(v.filter(isNodeType))] : [];

function sanitizeViews(v: unknown): SavedGraphView[] {
  if (!Array.isArray(v)) return [];
  const out: SavedGraphView[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 60) : "";
    const id = typeof r.id === "string" && r.id ? r.id.slice(0, 40) : "";
    if (!name || !id) continue;
    const scope = r.scope && typeof r.scope === "object"
      ? parseScopeParam(`${String((r.scope as Record<string, unknown>).kind)}:${String((r.scope as Record<string, unknown>).code)}`)
      : null;
    out.push({
      id, name,
      hiddenTypes: typesOf(r.hiddenTypes),
      showLibraryEdges: bool(r.showLibraryEdges, false),
      scope,
      localDepth: depthOf(r.localDepth, DEFAULT_GRAPH_SETTINGS.localDepth),
    });
  }
  return out.slice(0, 50);
}

/** Whatever a stored blob holds — any earlier build's shape, a hand-edited
 *  value, or junk — becomes a whole, valid settings object. Never throws.
 *  A value of the wrong kind falls back to its default; a scope is never
 *  restored from storage (it lives in the URL). */
export function migrateSettings(stored: unknown): GraphSettings {
  const d = DEFAULT_GRAPH_SETTINGS;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { ...d };
  const s = stored as Record<string, unknown>;
  const version = typeof s.version === "number" ? s.version : 1;
  const groups = Array.isArray(s.groups)
    ? (s.groups as unknown[]).filter((g): g is ColorGroup => !!g && typeof g === "object"
        && typeof (g as ColorGroup).id === "string" && typeof (g as ColorGroup).query === "string"
        && typeof (g as ColorGroup).color === "string")
        .map((g) => ({ ...g, enabled: bool(g.enabled, true) }))
    : [];
  return {
    mode: s.mode === "3d" ? "3d" : "2d",
    hiddenTypes: typesOf(s.hiddenTypes),
    showLibraryEdges: bool(s.showLibraryEdges, d.showLibraryEdges),
    hideUnlinked: bool(s.hideUnlinked, d.hideUnlinked),
    showProposals: bool(s.showProposals, d.showProposals),
    groups,
    labelThreshold: num(s.labelThreshold, d.labelThreshold),
    nodeScale: num(s.nodeScale, d.nodeScale),
    linkThickness: num(s.linkThickness, d.linkThickness),
    linkOpacity: num(s.linkOpacity, d.linkOpacity),
    // v1 → v2 (GPV-8): the old toggle defaulted off and drew direction on
    // supersession and curated links only; arrows now mean flow and
    // supersession and start on.
    showArrows: version < 2 ? true : bool(s.showArrows, d.showArrows),
    curvedLinks: bool(s.curvedLinks, d.curvedLinks),
    glow: bool(s.glow, d.glow),
    centerForce: num(s.centerForce, d.centerForce),
    repelForce: num(s.repelForce, d.repelForce),
    linkForce: num(s.linkForce, d.linkForce),
    linkDistance: num(s.linkDistance, d.linkDistance),
    localDepth: depthOf(s.localDepth, d.localDepth),
    scope: null,
    savedViews: sanitizeViews(s.savedViews),
    version: GRAPH_SETTINGS_VERSION,
  };
}

export function saveSettings(orgId: string, s: GraphSettings): void {
  // The scope is the URL's: a stored one would scope every later bare /graph.
  try { localStorage.setItem(settingsKey(orgId), JSON.stringify({ ...s, scope: null, version: GRAPH_SETTINGS_VERSION })); }
  catch { /* private mode / quota — the graph still works, it just forgets */ }
}
