// Semantic state → color. ONE place that says what each operational state
// LOOKS like, so color carries meaning consistently across the app
// (held=amber, overdue=red, locked=blue, released=green) instead of being
// decorative. Pair with the --state-* tokens in globals.css.

export type SemanticState =
  | "held" | "overdue" | "locked" | "released" | "draft" | "review" | "neutral";

export interface StateStyle {
  /** Soft bg + text + border classes for a status pill. */
  pill: string;
  /** Dot/rail fill class. */
  dot: string;
  label: string;
}

const STYLES: Record<SemanticState, StateStyle> = {
  held:     { pill: "bg-amber-50 text-amber-800 border-amber-200",       dot: "bg-amber-500",   label: "Held" },
  overdue:  { pill: "bg-red-50 text-red-800 border-red-200",             dot: "bg-red-600",     label: "Overdue" },
  locked:   { pill: "bg-blue-50 text-blue-800 border-blue-200",          dot: "bg-blue-600",    label: "Locked" },
  released: { pill: "bg-emerald-50 text-emerald-800 border-emerald-200", dot: "bg-emerald-600", label: "Released" },
  draft:    { pill: "bg-slate-100 text-slate-700 border-slate-200",      dot: "bg-slate-500",   label: "Draft" },
  review:   { pill: "bg-violet-50 text-violet-800 border-violet-200",    dot: "bg-violet-600",  label: "In review" },
  neutral:  { pill: "bg-slate-50 text-slate-600 border-slate-200",       dot: "bg-slate-400",   label: "" },
};

export function stateStyle(s: SemanticState): StateStyle { return STYLES[s]; }

/** Milestone status → semantic state. */
export function milestoneState(status: string): SemanticState {
  switch (status) {
    case "completed": return "released";
    case "in_progress": return "locked";
    case "on_hold": return "held";
    case "blocked":
    case "missed": return "overdue";
    default: return "draft";
  }
}

/** Document status → semantic state. */
export function documentState(status?: string | null): SemanticState {
  switch ((status || "").toLowerCase()) {
    case "issued":
    case "as-built":
    case "released": return "released";
    case "superseded":
    case "void":
    case "archived": return "overdue";
    case "in review":
    case "internal review":
    case "issued for construction": return "review";
    default: return "draft";
  }
}
