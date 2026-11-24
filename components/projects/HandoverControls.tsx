"use client";

// The turnover's draft controls (screen only — never printed):
//   TryControl — on a step carried to the other crew: "night could try",
//                which crew (the app's guesses first, with why), a note
//   ShipBar    - Open / Locked, in one phrase: Lock report, Unlock

import React, { useState } from "react";
import { Lock, Unlock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import type { HandoverDecision } from "@/lib/shiftHandover";
import { appConfirm } from "@/components/providers/DialogProvider";
import HelpTooltip from "@/components/ui/HelpTooltip";

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
 *  Unlocking asks first. One short phrase and one quiet button, on the
 *  line under the toolbar (beside the shifts it covers), never a banner
 *  of its own; why it matters sits behind the "?". Locking or unlocking
 *  swaps the phrase at once, so the line itself is the answer to the tap. */
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
  const asked = tries ? `${tries} step${tries === 1 ? "" : "s"} asked to try` : null;
  const row = "flex flex-wrap items-center gap-x-2 gap-y-1 text-body print:hidden";
  if (shippedAt) {
    return (
      <div role="status" className={`${row} text-[var(--color-text)]`}>
        <Lock aria-hidden className="w-4 h-4 shrink-0 text-[var(--state-released-text)]" />
        <span><b className="font-medium">Locked</b> {when(shippedAt)}{shippedBy ? ` by ${shippedBy}` : ""}{asked ? `, ${asked}` : ""}</span>
        <HelpTooltip>It can&apos;t be changed. Unlock it on purpose to change it; it can be changed again until it&apos;s locked.</HelpTooltip>
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
  // Open, the shift over: a held dot and the word, the late edge with it.
  if (endedAt) {
    return (
      <div className={`${row} text-[var(--color-text)]`}>
        <span aria-hidden className="w-2 h-2 shrink-0 rounded-full bg-[var(--state-held)]" />
        <span><b className="font-medium text-[var(--state-held-text)]">Not locked</b> · shift ended {when(endedAt)}{asked ? ` · ${asked}` : ""}</span>
        <HelpTooltip>The {label} report is still open for changes. {canShip ? "Locking it keeps anyone from changing the wrong day's report." : "Someone who can edit the schedule locks it."}</HelpTooltip>
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
    <div className={`${row} text-[var(--color-text-muted)]`}>
      <Unlock aria-hidden className="w-4 h-4 shrink-0" />
      <span>Open for changes{asked ? ` · ${asked}` : ""}</span>
      <HelpTooltip>Lock it when the turnover is done. {canShip ? "A locked report can't be changed by mistake." : "Only someone who can edit the schedule can lock it."}</HelpTooltip>
      {canShip && (
        <Button size="sm" variant="secondary" loading={busy} onClick={onShip}>
          <Lock className="w-4 h-4" /> Lock report
        </Button>
      )}
      {problem}
    </div>
  );
}
