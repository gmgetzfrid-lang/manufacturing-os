"use client";

// The turnover's draft controls (screen only — never printed):
//   TryControl — on a step carried to the other crew: "night could try",
//                which crew (the app's guesses first, with why), a note
//   ShipBar    - Draft / Locked: Lock report, Unlock

import React, { useState } from "react";
import { Lock, Unlock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import type { HandoverDecision } from "@/lib/shiftHandover";
import { appConfirm } from "@/components/providers/DialogProvider";

export function TryControl({ kind, decision, suggestions, crews, disabled, onChange, inherit }: {
  kind: "day" | "night";
  /** Pulled-forward work with no crew of its own follows this one. */
  inherit?: string;
  decision: HandoverDecision | undefined;
  suggestions: Array<{ crew: string; why: string }>;
  /** Every crew on the schedule, for anything the guesses miss. */
  crews: string[];
  disabled: boolean;
  onChange: (d: HandoverDecision) => void;
}) {
  const on = !!decision?.tryIt;
  // The note as typed here, kept in step with the saved one (a change made
  // elsewhere, or a reload, replaces a stale copy instead of being wiped by it).
  const saved = decision?.note ?? "";
  const [note, setNote] = useState(saved);
  const [seen, setSeen] = useState(saved);
  if (saved !== seen) { setSeen(saved); setNote(saved); }
  const others = crews.filter((c) => !suggestions.some((s) => s.crew === c));
  return (
    <div className="flex flex-wrap items-center gap-2 pb-1 print:hidden">
      {/* A plain checkbox: marked, the step goes on the other crew's list. */}
      <label className={`shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 text-body cursor-pointer select-none ${disabled ? "opacity-60 cursor-not-allowed" : ""} ${on ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
        title={on ? "Untick to take it off the list" : undefined}>
        <input type="checkbox" disabled={disabled} checked={on} className="w-4 h-4 accent-[var(--color-current)]"
          onChange={() => onChange({ ...decision, tryIt: !on, crew: !on ? decision?.crew ?? suggestions[0]?.crew ?? null : decision?.crew })} />
        {kind === "night" ? "Night" : "Day"} could try
      </label>
      {on && (
        <>
          <select disabled={disabled} value={decision?.crew ?? ""} onChange={(e) => onChange({ ...decision, tryIt: true, crew: e.target.value || null })}
            aria-label="Which crew" className="h-8 pointer-coarse:h-11 w-full sm:w-auto max-w-full sm:max-w-[260px] rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] px-2 text-body max-sm:text-reading text-[var(--color-text)]">
            <option value="">{inherit ? `${inherit} (crew for extra work)` : "No crew named"}</option>
            {suggestions.length > 0 && (
              <optgroup label={`On the ${kind} shift`}>
                {suggestions.map((s) => <option key={s.crew} value={s.crew}>{s.crew} - {s.why}</option>)}
              </optgroup>
            )}
            {others.length > 0 && <optgroup label="Other crews">{others.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>}
          </select>
          <input disabled={disabled} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200}
            onBlur={() => { if (saved !== note) onChange({ ...decision, tryIt: true, note }); }}
            aria-label="Note for the other crew (optional)"
            placeholder="Note (optional)" className="h-8 pointer-coarse:h-11 w-full sm:w-52 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] px-2.5 text-body max-sm:text-reading text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]" />
        </>
      )}
    </div>
  );
}

/** The report's lock: open while it's being filled in; locked once the
 *  turnover is done, so nobody changes the wrong day's report by mistake.
 *  Unlocking asks first. Locking or unlocking swaps the line at once, so
 *  the line itself is the answer to the tap. */
export function ShipBar({ shippedAt, shippedBy, tries, canShip, busy, err, onShip, onUnship, when, label, endedAt }: {
  shippedAt: string | null; shippedBy: string | null; tries: number; canShip: boolean; busy: boolean; err: string | null;
  onShip: () => void; onUnship: () => void; when: (iso: string) => string;
  /** "Fri, Oct 30 day shift": whose report it is. */
  label: string;
  /** When the shift ended, once it has: an open report then says plainly
   *  that it is waiting to be locked, and by whom. */
  endedAt?: string | null;
}) {
  // The lock lives in its own record: when it can't be read or saved, say
  // so in plain words (never the database's), with a way to try again.
  const problem = err ? (
    <ErrorNote compact className="w-full" title="Couldn't read or save this report's lock."
      next="The report below is still up to date. Reload to try again." retryLabel="Reload" onRetry={() => window.location.reload()} />
  ) : null;
  if (shippedAt) {
    return (
      <div role="status" className="px-4 sm:px-5 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-x-3 gap-y-2 text-body text-[var(--color-text)] print:hidden">
        <Lock aria-hidden className="w-4 h-4 shrink-0 text-[var(--state-released-text)]" />
        <span className="flex-1 min-w-[200px]"><b className="font-medium">Locked</b> {when(shippedAt)}{shippedBy ? ` by ${shippedBy}` : ""}{tries ? `, ${tries} step${tries === 1 ? "" : "s"} asked to try` : ""}. It can&apos;t be changed.</span>
        {canShip && (
          <Button size="sm" variant="secondary" loading={busy}
            onClick={() => { void appConfirm({ title: `Unlock the ${label} report?`, message: "It can be changed again until it's locked.", confirmLabel: "Unlock report" }).then((ok) => { if (ok) onUnship(); }); }}>
            <Unlock className="w-4 h-4" /> Unlock to edit
          </Button>
        )}
        {problem}
      </div>
    );
  }
  // Open: one quiet line and a quiet Lock button (the report's one accent
  // button is Email / Print). Once the shift is over, the line says the
  // report is waiting to be locked, with the late edge.
  if (endedAt) {
    return (
      <div className="relative px-4 sm:px-5 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-x-3 gap-y-2 text-body text-[var(--color-text)] print:hidden">
        <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px] bg-[var(--state-held)]" />
        <Unlock aria-hidden className="w-4 h-4 shrink-0 text-[var(--state-held-text)]" />
        <span className="flex-1 min-w-[200px]">
          <b className="font-medium">Lock the {label} report.</b> The shift ended {when(endedAt)} and its report is still open for changes{tries ? ` (${tries} asked to try)` : ""}.
          {canShip ? " Locking it keeps anyone from changing the wrong day's report." : " Someone who can edit the schedule locks it."}
        </span>
        {canShip && (
          <Button size="sm" variant="secondary" loading={busy} onClick={onShip}>
            <Lock className="w-4 h-4" /> Lock report
          </Button>
        )}
        {problem}
      </div>
    );
  }
  return (
    <div className="px-4 sm:px-5 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-x-3 gap-y-2 text-body text-[var(--color-text-muted)] print:hidden">
      <Unlock aria-hidden className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-[200px]">Open for changes{tries ? ` (${tries} asked to try)` : ""}. Lock it when the turnover is done.</span>
      {canShip ? (
        <Button size="sm" variant="secondary" loading={busy} onClick={onShip}>
          <Lock className="w-4 h-4" /> Lock report
        </Button>
      ) : <span className="text-body">Only someone who can edit the schedule can lock it.</span>}
      {problem}
    </div>
  );
}
