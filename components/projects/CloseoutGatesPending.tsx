"use client";

// CloseoutGatesPending — what the "Mark project complete" dialog shows while
// its closeout gates are not in hand (projects-and-cost QUAL-8).
//
// The dialog gathers the project snapshot when it opens and lists the
// closeout gates from it. Before this, a gather that failed was swallowed:
// the gate panel was simply not drawn and Confirm stayed live, so the
// operator saw no gates rather than failing ones — and the completion was
// recorded with no gate state (SAF-14). Now the dialog says which it is:
// the gates are still being checked, or they could not be loaded (with the
// reason and a Retry). Confirm waits for the gates either way — the gates
// themselves stay warnings, not walls (CLOSEOUT_GATE_POLICY): once they are
// on screen the owner may complete over open items, on the record.

import React from "react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { DECISION_TARGET } from "@/components/projects/decisionTarget";

/** The one sentence beside a Confirm that waits for the gates. */
export const CLOSEOUT_GATES_WAIT = "Confirm waits until the closeout gates are on screen — they are recorded with the completion.";

export default function CloseoutGatesPending({ error, onRetry }: {
  /** The gather's failure, already worded for a user; null while loading. */
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="px-6 pt-4">
        <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">Closeout gates</div>
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/[0.08] px-3 py-2 text-xs font-bold text-rose-700 dark:text-rose-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            The closeout gates could not be loaded — {error.replace(/\.$/, "")}. {CLOSEOUT_GATES_WAIT}
          </div>
          <button type="button" onClick={onRetry}
            className={`${DECISION_TARGET} shrink-0 inline-flex items-center gap-1 px-2 rounded-md border border-rose-500/40 hover:bg-rose-500/10`}>
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> Retry
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="px-6 pt-4">
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">Closeout gates</div>
      <div role="status" className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Checking the closeout gates…
      </div>
    </div>
  );
}
