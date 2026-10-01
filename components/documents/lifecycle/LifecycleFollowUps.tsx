"use client";

// LifecycleFollowUps — REV-15 (P13). A split or merge that COMPLETED but whose
// follow-up steps did not all complete (a new sheet's review clock or
// read-&-understood roster did not — fully — start; `complianceClockWarnings`
// on SplitDocumentResult / MergeDocumentsResult — or a new document's unit
// decode did not run, `unitCodeNote`, GAP-314) says so before the wizard
// closes, instead of closing as if everything landed. The operation stands
// (it is never rolled back for this), so the notice says not to run it again;
// each CLOCK item is also on the document's history (the
// COMPLIANCE_CLOCKS_NOT_STARTED row startClocksForIssuedDocuments writes after
// the creation event), and Document Control can set it from the document.
// The unit decode is worded on its own (P13 third review fix): it is NOT on
// the document's history, and no one sets documents.unit_code by hand (only
// the Site Codebook's decode writes it) — the next unit-identity run on
// Operational scope places it.

import React from "react";
import { AlertTriangle, Check } from "lucide-react";

export default function LifecycleFollowUps({ operation, items, unitCodeNote = null, onDone }: {
  operation: "split" | "merge";
  /** The compliance-clock follow-ups (complianceClockWarnings). */
  items: string[];
  /** GAP-314: why the new document's unit decode did not complete (unitCodeNote). */
  unitCodeNote?: string | null;
  onDone: () => void;
}) {
  const n = items.length + (unitCodeNote ? 1 : 0);
  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start justify-center p-4 overflow-y-auto">
      <div role="alertdialog" aria-label={`The ${operation} completed with follow-up steps outstanding`} className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl overflow-hidden my-8">
        <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-600" />
          <div className="text-sm font-black text-[var(--color-text)]">
            The {operation} is done — {n} follow-up step{n === 1 ? "" : "s"} did not complete
          </div>
        </div>
        <div className="p-5 space-y-3 text-xs text-[var(--color-text)]">
          <p>
            The {operation} stands and is not rolled back — do not run it again.
            {items.length > 0 && <> What did not complete below is recorded on each document&apos;s history; Document Control can set it from the document.</>}
          </p>
          {items.length > 0 && (
            <ul data-testid="lifecycle-follow-ups" className="ml-5 list-disc space-y-1 max-h-64 overflow-y-auto">
              {items.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          )}
          {unitCodeNote && (
            <p data-testid="lifecycle-unit-code-note">
              <b>Unit code:</b> {unitCodeNote} This is not recorded on the document&apos;s history, and the unit code is
              not set by hand — only the Site Codebook&apos;s decode writes it.
            </p>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex justify-end">
          <button
            type="button"
            onClick={onDone}
            className="inline-flex items-center gap-1.5 text-sm font-bold bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded"
          >
            <Check className="w-3.5 h-3.5" /> Done
          </button>
        </div>
      </div>
    </div>
  );
}
