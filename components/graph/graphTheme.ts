// components/graph/graphTheme.ts — one palette, both renderers.
//
// The 2D canvas and the 3D scene must agree on what a colour MEANS, or
// flipping between them feels like two different products.

import { DIRECTED_EDGE_TYPES, type GraphNode, type GraphNodeType, type GraphEdge, type GraphEdgeType } from "@/lib/orgGraph";

export const NODE_COLORS: Record<GraphNodeType, string> = {
  document: "#3b82f6",
  asset:    "#10b981",
  unit:     "#8b5cf6",
  library:  "#f59e0b",
  project:  "#f43f5e",
  plant:    "#64748b",
  plot:     "#d946ef",
};

/** Edge colours as "r,g,b" so the 2D renderer can compose rgba() strings and
 *  the 3D renderer can split them into float channels. */
export const EDGE_RGB: Record<GraphEdgeType, string> = {
  tag:          "148,163,184", // slate — shared equipment
  unit:         "139,92,246",  // violet — belongs to a unit
  library:      "245,158,11",  // amber — filed in a library
  project:      "244,63,94",   // rose — travelled through a project
  related:      "124,58,237",  // deep violet — a human drew this
  supersession: "100,116,139", // slate — revision lineage
  proposed:     "234,179,8",   // gold — found, not yet confirmed
  mention:      "16,185,129",  // emerald — the text says so, with the sentence
  flow:         "6,182,212",   // cyan — process flow: one thing FEEDS another
  plot:         "217,70,239", // fuchsia — pinned on a plot plan
};

export const EDGE_LABELS: Record<GraphEdgeType, string> = {
  tag: "Shared equipment",
  unit: "Unit membership",
  library: "Library",
  project: "Project",
  related: "Linked by a person",
  supersession: "Supersession",
  proposed: "Proposed",
  mention: "Mentioned in the text",
  flow: "Feeds (process flow)",
  plot: "Marked on plot plan",
};

/** Highlight colours used by both renderers for the same meanings. The path
 *  accent is lime, apart from every edge colour: it was cyan, a near twin of
 *  the flow colour, so a traced path and a process flow read alike (GPV-8). */
export const ACCENT = {
  path: "#84cc16",       // the connection chain between two nodes
  found: "#eab308",      // insight spotlight (orphan / hub / bridge)
  search: "#eab308",     // search match ring
};
/** ACCENT.path as "r,g,b" for the renderers' rgba / float channels. */
export const PATH_RGB = "132,204,22";

/** GPV-8 — the edge types an arrowhead is drawn on: the ones whose meaning
 *  IS a direction (a flow feeds; a supersession replaces), the same set the
 *  assembly keeps ordered (lib/orgGraph.ts DIRECTED_EDGE_TYPES). A curated
 *  link is an unordered pair, so an arrow on it would be invented. */
export const ARROW_EDGE_TYPES: ReadonlySet<GraphEdgeType> = DIRECTED_EDGE_TYPES;

/** GPV-14 — a unit → library edge says which statement it is. Filing (a
 *  document in its library) keeps the library amber; a library PINNED to a
 *  unit is a darker, stronger amber; the AI knowledge library BOUND to a unit
 *  is indigo. */
export const LIBRARY_VIA_RGB = { pinned: "180,83,9", knowledge: "99,102,241" } as const;
export const LIBRARY_VIA_LABELS = {
  pinned: "Library pinned to the unit",
  knowledge: "Knowledge library bound to the unit",
} as const;

export function edgeRgbFor(e: Pick<GraphEdge, "type" | "via">): string {
  if (e.type === "library" && e.via) return LIBRARY_VIA_RGB[e.via] ?? EDGE_RGB.library;
  return EDGE_RGB[e.type] ?? "148,163,184";
}

export function edgeLabelFor(e: Pick<GraphEdge, "type" | "via">): string {
  if (e.type === "library" && e.via) return LIBRARY_VIA_LABELS[e.via] ?? EDGE_LABELS.library;
  return EDGE_LABELS[e.type] ?? "Connected";
}

/** GPV-4 — the unit class holds three things the assembly keeps apart by id
 *  (DEC-67): a Site Codebook unit (`cbunit:`; a mapped operational unit IS
 *  this node), an operational unit no codebook unit is mapped to (`unit:`),
 *  and a system (`system:`). They share the "Units" filter and are told
 *  apart by colour (and, in 2D, by shape). */
export type UnitVariant = "codebook" | "operational" | "system";
export function unitVariant(n: Pick<GraphNode, "id" | "type">): UnitVariant | null {
  if (n.type !== "unit") return null;
  if (n.id.startsWith("unit:")) return "operational";
  if (n.id.startsWith("system:")) return "system";
  return "codebook";
}
export const UNIT_VARIANT_COLORS: Record<UnitVariant, string> = {
  codebook: NODE_COLORS.unit,  // violet — unchanged
  operational: "#c084fc",      // lighter purple, drawn as a ring in 2D
  system: "#6d28d9",           // deep violet, drawn as a square in 2D
};
export const UNIT_VARIANT_LABELS: Record<UnitVariant, string> = {
  codebook: "Site Codebook unit",
  operational: "Operational unit, not mapped to the codebook",
  system: "System",
};

/** A node's type colour (before any colour group), unit variants apart. */
export function nodeColorFor(n: Pick<GraphNode, "id" | "type">): string {
  const v = unitVariant(n);
  return v ? UNIT_VARIANT_COLORS[v] : NODE_COLORS[n.type];
}

/** The map's key, in the order the legend lists it (GPV-8 / GPV-14). */
export const EDGE_LEGEND: Array<{ key: string; label: string; rgb: string; arrow: boolean; dashed?: boolean }> = [
  { key: "flow", label: EDGE_LABELS.flow, rgb: EDGE_RGB.flow, arrow: true },
  { key: "supersession", label: EDGE_LABELS.supersession, rgb: EDGE_RGB.supersession, arrow: true },
  { key: "tag", label: EDGE_LABELS.tag, rgb: EDGE_RGB.tag, arrow: false },
  { key: "mention", label: EDGE_LABELS.mention, rgb: EDGE_RGB.mention, arrow: false },
  { key: "related", label: EDGE_LABELS.related, rgb: EDGE_RGB.related, arrow: false },
  { key: "unit", label: EDGE_LABELS.unit, rgb: EDGE_RGB.unit, arrow: false },
  { key: "project", label: EDGE_LABELS.project, rgb: EDGE_RGB.project, arrow: false },
  { key: "plot", label: EDGE_LABELS.plot, rgb: EDGE_RGB.plot, arrow: false },
  { key: "library", label: "Filed in a library", rgb: EDGE_RGB.library, arrow: false },
  { key: "library-pinned", label: LIBRARY_VIA_LABELS.pinned, rgb: LIBRARY_VIA_RGB.pinned, arrow: false },
  { key: "library-knowledge", label: LIBRARY_VIA_LABELS.knowledge, rgb: LIBRARY_VIA_RGB.knowledge, arrow: false },
  { key: "proposed", label: "Proposed — awaiting review", rgb: EDGE_RGB.proposed, arrow: false, dashed: true },
  { key: "path", label: "Connection path you traced", rgb: PATH_RGB, arrow: true },
];
