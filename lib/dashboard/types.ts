// Customizable home dashboard — shared types.
//
// A user's dashboard is an ordered list of widget instances laid out on a
// 12-column CSS grid. Each instance has a stable id, a widget `type` (looked up
// in the catalog), a 2D size (`w` columns 1..12, `h` row-units 1..N), and an
// optional per-widget `settings` bag (e.g. the Document Control widget stores
// which libraries to surface).

/** Every widget type, in one place. The layout loader keeps only these, so a
 *  type added to the catalog but not here would silently vanish on reload —
 *  which is exactly what happened to "Recently Viewed". */
export const WIDGET_TYPES = [
  "commandDeck",
  "askKnowledge",
  "documentControl",
  "draftingRequests",
  "inbox",
  "dailyBrief",
  "quickLaunch",
  "attention",
  "suggestedActions",
  "outstanding",
  "projects",
  "activity",
  "equipment",
  "adminUsers",
  "adminAnalytics",
  "adminAudit",
  "recentDocs",
] as const;

export type WidgetType = typeof WIDGET_TYPES[number];

export interface DashboardWidget {
  /** Stable per-instance id (so DnD + React keys are reliable). */
  id: string;
  type: WidgetType;
  /** Column origin on the 12-col grid (0..11). */
  x: number;
  /** Row origin in grid row-units (0..N). */
  y: number;
  /** Column span on the 12-col grid (1..12). */
  w: number;
  /** Row span in grid row-units (1..N). */
  h: number;
  /** Per-widget configuration. Shape depends on `type`. */
  settings?: Record<string, unknown>;
}

export interface DashboardConfig {
  /** Schema version. v2 promoted the Command Deck to a widget; v3 gave every
   *  widget an explicit (x, y) so the grid is freely, visually arrangeable.
   *  The sanitizer upgrades older layouts in place. */
  version: 3;
  widgets: DashboardWidget[];
}

/** Settings shape for the Document Control widget. */
export interface DocControlSettings {
  /** Library ids to surface. Empty/undefined => show the first few. */
  libraryIds?: string[];
  /** Permits assignment to a widget's generic `settings` bag. */
  [key: string]: unknown;
}

/** One configurable field in a widget's settings window. Every widget also
 *  gets a "title" field (rename this instance) for free. */
export type WidgetSettingField =
  | { key: string; type: "select"; label: string; help?: string; options: Array<{ value: string; label: string }>; default: string }
  | { key: string; type: "toggle"; label: string; help?: string; default: boolean }
  | { key: string; type: "number"; label: string; help?: string; min: number; max: number; default: number }
  /** Pick document-control libraries (multi). */
  | { key: string; type: "docLibraries"; label: string; help?: string }
  /** Pick one AI knowledge library. */
  | { key: string; type: "knowledgeLibrary"; label: string; help?: string };
