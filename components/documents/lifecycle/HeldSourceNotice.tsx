"use client";

// HeldSourceNotice — HLD-2 (review fix 4). The Split and Merge wizards show
// it on their confirm step when a document the operation retires is under an
// active stop-work hold: a controller's REQUIRED "Proceed over the active
// hold" acknowledgement (the operation then passes `force` and carries the
// hold), or, for anyone else, the refusal — which never tells them to
// release the hold, because releasing it in order to split or merge is how
// the stop-work signal would be laundered away.

import React from "react";
import { AlertTriangle } from "lucide-react";
import type { HeldRetirementDecision } from "@/lib/revisions";

/** The identity of a set of active holds. An acknowledgement is bound to the
 *  exact set it was given over: a re-read that finds another set clears it. */
export function holdSetKey(holds: ReadonlyArray<{ id?: string | null }> | null): string {
  return (holds ?? []).map((h) => h.id ?? "").sort().join(",");
}

/** HLD-2 (review fix 4): the held-source notice the Split and Merge wizards
 *  share — a controller's required "Proceed over the active hold"
 *  acknowledgement, or the refusal for anyone else (never "release it"). */
export default function HeldSourceNotice({ decision, readError, ack, setAck }: {
  decision: HeldRetirementDecision;
  readError: string | null;
  ack: boolean;
  setAck: (v: boolean) => void;
}) {
  if (decision.kind === "refused") {
    return (
      <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {decision.message}
      </div>
    );
  }
  if (decision.kind === "acknowledge") {
    return (
      <label className="flex items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded px-2.5 py-2 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span><b>Required.</b> {decision.text} The holds you proceed over are named on the audit record.</span>
      </label>
    );
  }
  if (readError) {
    return (
      <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        Couldn&apos;t check for active holds ({readError}). The operation still checks them itself and refuses a held document.
      </div>
    );
  }
  return null;
}
