// lib/graphSettings.ts — everything the graph lets you tune, in one shape.
//
// Persisted per user + org in localStorage: the graph you configured is the
// graph you come back to, same as the layout itself.
//
// Colour GROUPS are the idea worth stealing wholesale from Obsidian: a list
// of (query → colour) rules, applied top-down, so you can paint your own
// meaning onto the map ("everything matching 44- is amber, corrosion is
// red") instead of living with whatever the app decided.

import type { GraphNodeType } from "@/lib/orgGraph";

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
}

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
  showArrows: false,
  curvedLinks: true,
  glow: true,
  centerForce: 0.6,
  repelForce: 1,
  linkForce: 1,
  linkDistance: 90,
  localDepth: 2,
};

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
    // Merge over defaults so a settings blob saved by an older build never
    // leaves a new control undefined.
    return { ...DEFAULT_GRAPH_SETTINGS, ...(JSON.parse(raw) as Partial<GraphSettings>) };
  } catch {
    return { ...DEFAULT_GRAPH_SETTINGS };
  }
}

export function saveSettings(orgId: string, s: GraphSettings): void {
  try { localStorage.setItem(settingsKey(orgId), JSON.stringify(s)); }
  catch { /* private mode / quota — the graph still works, it just forgets */ }
}
