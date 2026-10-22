"use client";

// TriageClassSelects — the workspace's own work class and code class, picked
// at triage beside the drafter (or the scope-review engineer) — drafting-flow
// DF-P18: TIER-2 dw2, TIER-4 dw1 / dw3, GAP-101.
//
// One select per CONFIGURED list (lib/reviewModel.ts reviewClassOptions); a
// list the workspace left empty shows no select, and with both empty the
// component renders nothing — an unconfigured workspace's triage dialog is
// exactly today's (DEC-90 ruling (1) for DF-P18). "No change" is the default
// and sends nothing: triage never clears a class, and a class is never
// required (99-fix-sequencing "Do not"). The route validates the value
// against the same list (400 off the list, 503 when it cannot read it).

import React from "react";
import { reviewClassLabel, type ReviewClassEntry } from "@/lib/reviewModel";

export interface TriageClassChoice { workClass: string; codeClass: string }

export default function TriageClassSelects({
  offered, workOptions, codeOptions, current, value, onChange,
}: {
  offered: { work: boolean; code: boolean };
  workOptions: readonly ReviewClassEntry[];
  codeOptions: readonly ReviewClassEntry[];
  current: { workClass?: string | null; codeClass?: string | null };
  value: TriageClassChoice;
  onChange: (next: TriageClassChoice) => void;
}) {
  if (!offered.work && !offered.code) return null;
  const now = (v: string | null | undefined, opts: readonly ReviewClassEntry[]) => reviewClassLabel(v ?? null, opts) ?? "none";
  return (
    <div data-testid="triage-class-selects" className="space-y-3">
      {offered.work && (
        <label className="block">
          <span className="block text-xs font-bold text-[var(--color-text-muted)] mb-1">Work class <span className="font-normal">(now: {now(current.workClass, workOptions)})</span></span>
          <select data-testid="triage-work-class" value={value.workClass} onChange={(e) => onChange({ ...value, workClass: e.target.value })} className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm">
            <option value="">No change</option>
            {workOptions.map((o) => <option key={o.value} value={o.value}>{o.label}{o.engineering ? " — requires engineering" : ""}</option>)}
          </select>
        </label>
      )}
      {offered.code && (
        <label className="block">
          <span className="block text-xs font-bold text-[var(--color-text-muted)] mb-1">Code class <span className="font-normal">(now: {now(current.codeClass, codeOptions)})</span></span>
          <select data-testid="triage-code-class" value={value.codeClass} onChange={(e) => onChange({ ...value, codeClass: e.target.value })} className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm">
            <option value="">No change</option>
            {codeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}{o.engineering ? " — requires engineering" : ""}</option>)}
          </select>
        </label>
      )}
      <p className="text-[11px] text-[var(--color-text-faint)]">Optional. A class marked &ldquo;requires engineering&rdquo; makes an engineer&apos;s sign-off required; a class never removes it.</p>
    </div>
  );
}
