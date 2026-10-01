"use client";

// StatusMark — a compliance status a person can read without seeing hue
// (A11Y-2 / GAP-410). Each state has its own GLYPH (check / clock / dash /
// slash …) inside a ringed mark, a visually-hidden text label a screen
// reader announces with the row ("Status: Needs evidence."), and the same
// words in a visible legend. The colour is a third carrier, never the only
// one — viz.tsx's house rule, "identity never colour-alone".
//
// One table per surface, so the legend and the row marks can never disagree.

import React from "react";
import { Check, Clock, Minus, Slash, AlertTriangle, X, CircleDot, type LucideIcon } from "lucide-react";

export interface StatusMarkSpec {
  /** The word a person reads — in the legend, the sr-only label and the title. */
  label: string;
  /** What the state means, for the legend. */
  meaning: string;
  Glyph: LucideIcon;
  /** Ring + glyph colour; tokens read in both themes. */
  tone: string;
}

const EMERALD = "border-emerald-500/60 text-emerald-700 dark:text-emerald-300";
const AMBER = "border-amber-500/60 text-amber-800 dark:text-amber-300";
const ROSE = "border-rose-500/60 text-rose-700 dark:text-rose-300";
const NEUTRAL = "border-[var(--color-border-strong)] text-[var(--color-text-muted)]";

/** A PSSR / MI / QA-QC checklist item. */
export const CHECKLIST_STATUS_MARKS: Record<"satisfied" | "needs_evidence" | "open" | "na", StatusMarkSpec> = {
  satisfied: { label: "Satisfied", meaning: "evidence attached", Glyph: Check, tone: EMERALD },
  needs_evidence: { label: "Needs evidence", meaning: "the system holds no proof yet", Glyph: Clock, tone: AMBER },
  open: { label: "Open", meaning: "not yet assessed against evidence", Glyph: Minus, tone: NEUTRAL },
  na: { label: "Not applicable", meaning: "does not apply to this job (N/A)", Glyph: Slash, tone: NEUTRAL },
};

/** A punch-list item: open, overdue, done, void. Done and void differ by
 *  glyph and word, not by hue (A11Y-2: "done versus void is distinguishable
 *  by nothing but hue"). */
export const PUNCH_STATUS_MARKS: Record<"open" | "overdue" | "done" | "void", StatusMarkSpec> = {
  open: { label: "Open", meaning: "still to close", Glyph: CircleDot, tone: AMBER },
  overdue: { label: "Overdue", meaning: "open past its due date", Glyph: AlertTriangle, tone: ROSE },
  done: { label: "Done", meaning: "closed — the work was done", Glyph: Check, tone: EMERALD },
  void: { label: "Void", meaning: "closed — not a real snag", Glyph: Slash, tone: NEUTRAL },
};

/** A quality-manual rubric area in an evaluation proposal. */
export const RUBRIC_MARKS: Record<"covered" | "gap", StatusMarkSpec> = {
  covered: { label: "Covered", meaning: "the manual addresses this area", Glyph: Check, tone: EMERALD },
  gap: { label: "Gap", meaning: "the manual does not address this area", Glyph: X, tone: ROSE },
};

export function StatusMark({ spec, className = "" }: { spec: StatusMarkSpec; className?: string }) {
  const { Glyph } = spec;
  return (
    <span className={`inline-flex items-center shrink-0 ${className}`} title={`${spec.label} — ${spec.meaning}`}>
      <span aria-hidden="true" className={`inline-flex items-center justify-center w-4 h-4 rounded-full border ${spec.tone}`}>
        <Glyph className="w-2.5 h-2.5" strokeWidth={3} />
      </span>
      <span className="sr-only">Status: {spec.label}.</span>
    </span>
  );
}

/** The visible key for a set of marks — every state, its glyph and its word. */
export function StatusLegend({ marks, title = "Status key", className = "" }: {
  marks: Record<string, StatusMarkSpec>; title?: string; className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--color-text-muted)] ${className}`}>
      <span className="font-black uppercase tracking-wider">{title}:</span>
      {Object.entries(marks).map(([key, spec]) => {
        const { Glyph } = spec;
        return (
          <span key={key} className="inline-flex items-center gap-1">
            <span aria-hidden="true" className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border ${spec.tone}`}>
              <Glyph className="w-2 h-2" strokeWidth={3} />
            </span>
            <span><b className="text-[var(--color-text)]">{spec.label}</b> — {spec.meaning}</span>
          </span>
        );
      })}
    </div>
  );
}
