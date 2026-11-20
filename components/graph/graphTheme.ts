// components/graph/graphTheme.ts: one palette, both renderers.
//
// The 2D canvas and the 3D scene must agree on what a colour MEANS, or
// flipping between them feels like two different products. Like a control
// screen: structure is graphite (kinds of thing differ by shade, not hue),
// the thing you are looking at is in the signal color, and the status
// colors appear only where something has a state (proposed and waiting,
// a finding to heed).

import type { GraphNodeType, GraphEdgeType } from "@/lib/orgGraph";

// The state colors, as the canvas needs them (it can't read var()).
const HELD = "#b45309";

/** Node fill by kind, on a light background: graphite shades. */
export const NODE_COLORS: Record<GraphNodeType, string> = {
  plant:    "#1f2733",
  unit:     "#2f3a48",
  asset:    "#3e4a5a",
  library:  "#525d6c",
  project:  "#525d6c",
  document: "#6b7685",
  plot:     "#808a98",
  finding:  HELD,
};

/** The same kinds on a dark background (the 3D scene): light greys. */
export const NODE_COLORS_ON_DARK: Record<GraphNodeType, string> = {
  plant:    "#f1f4f8",
  unit:     "#d5dbe4",
  asset:    "#bcc4cf",
  library:  "#a3acb8",
  project:  "#a3acb8",
  document: "#8d97a4",
  plot:     "#7b8592",
  finding:  "#f0b45a",
};

/** Edge colours as "r,g,b" so the 2D renderer can compose rgba() strings and
 *  the 3D renderer can split them into float channels. Neutral, by weight;
 *  only a proposed link (waiting for a person) carries a state color. */
export const EDGE_RGB: Record<GraphEdgeType, string> = {
  tag:          "120,130,145", // shared equipment
  unit:         "70,80,95",    // belongs to a unit
  library:      "150,158,170", // filed in a library
  project:      "100,110,125", // travelled through a project
  related:      "45,55,70",    // a person drew this
  supersession: "130,140,152", // revision lineage
  proposed:     "180,83,9",    // found, not yet confirmed: waiting
  mention:      "110,120,135", // the text says so, with the sentence
  flow:         "60,70,85",    // process flow: one thing FEEDS another
  plot:         "140,148,160", // pinned on a plot plan
  finding:      "180,83,9",    // what a job taught, on its equipment
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
  finding: "Finding from a past job",
};

// ── Theme colors for canvas and WebGL ──────────────────────────────────
// A canvas can't read var(--color-accent), and the signal color is the
// workspace's own (it changes with the brand and with dark mode). Read it
// off the page as #rrggbb, at most once a second.

const cache = new Map<string, { at: number; hex: string }>();

let pixel: CanvasRenderingContext2D | null = null;

/** Any CSS color the browser understands (rgb(), color(srgb …), oklch…)
 *  as #rrggbb: paint one pixel with it and read the pixel back. */
function toHex(css: string): string | null {
  pixel ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!pixel || !css) return null;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = "#000";
  pixel.fillStyle = css;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
  if (a === 0) return null;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** A CSS color variable's current value as #rrggbb (fallback before the
 *  page exists or when it can't be read). */
export function themeColor(name: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) return fallback;
  const now = Date.now();
  const hit = cache.get(name);
  if (hit && now - hit.at < 1000) return hit.hex;
  const probe = document.createElement("span");
  probe.style.color = `var(${name}, ${fallback})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const hex = toHex(getComputedStyle(probe).color) ?? fallback;
  probe.remove();
  cache.set(name, { at: now, hex });
  return hex;
}

/** "#rrggbb" → "r,g,b". */
export function rgbOf(hex: string): string {
  const h = hex.replace("#", "");
  const v = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

/** Mix two #rrggbb colors: t=0 gives a, t=1 gives b. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = rgbOf(a).split(",").map(Number), pb = rgbOf(b).split(",").map(Number);
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** Highlight colours used by both renderers for the same meanings: what
 *  you are looking at is in the signal color; a found insight (orphan,
 *  hub, bridge) is flagged in the waiting color. */
export const ACCENT = {
  /** The node you picked, and the connection chain between two nodes. */
  get focus() { return themeColor("--color-accent", "#2e6be7"); },
  get path() { return themeColor("--color-accent", "#2e6be7"); },
  /** The signal color lifted so it reads on the 3D scene's night sky. */
  get focusOnDark() { return mixHex(themeColor("--color-accent", "#2e6be7"), "#ffffff", 0.35); },
  /** Insight spotlight (orphan / hub / bridge): worth a look. */
  get found() { return themeColor("--state-held", HELD); },
  /** Search match ring. */
  get search() { return themeColor("--color-accent", "#2e6be7"); },
};
