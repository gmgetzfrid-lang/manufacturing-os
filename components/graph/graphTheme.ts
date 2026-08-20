// components/graph/graphTheme.ts — one palette, both renderers.
//
// The 2D canvas and the 3D scene must agree on what a colour MEANS, or
// flipping between them feels like two different products.

import type { GraphNodeType, GraphEdgeType } from "@/lib/orgGraph";

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

/** Highlight colours used by both renderers for the same meanings. */
export const ACCENT = {
  path: "#22d3ee",       // the connection chain between two nodes
  found: "#eab308",      // insight spotlight (orphan / hub / bridge)
  search: "#eab308",     // search match ring
};
