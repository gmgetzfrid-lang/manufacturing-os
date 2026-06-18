// Customizable home dashboard — shared types.
//
// A user's dashboard is an ordered list of widget instances. Each instance has
// a stable id, a widget `type` (looked up in the catalog), a display `width`,
// and an optional per-widget `settings` bag (e.g. the Document Control widget
// stores which libraries to surface).

export type WidgetWidth = "full" | "half";

export type WidgetType =
  | "documentControl"
  | "draftingRequests"
  | "inbox"
  | "projects"
  | "activity"
  | "equipment"
  | "scratchpad"
  | "adminUsers"
  | "adminAnalytics"
  | "adminAudit";

export interface DashboardWidget {
  /** Stable per-instance id (so DnD + React keys are reliable). */
  id: string;
  type: WidgetType;
  width: WidgetWidth;
  /** Per-widget configuration. Shape depends on `type`. */
  settings?: Record<string, unknown>;
}

export interface DashboardConfig {
  version: 1;
  widgets: DashboardWidget[];
}

/** Settings shape for the Document Control widget. */
export interface DocControlSettings {
  /** Library ids to surface. Empty/undefined => show the first few. */
  libraryIds?: string[];
  /** Permits assignment to a widget's generic `settings` bag. */
  [key: string]: unknown;
}
