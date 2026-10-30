"use client";

// The turnover's draft controls (screen only — never printed):
//   TryControl — on a step carried to the other crew: "night could try",
//                which crew (the app's guesses first, with why), a note
//   ShipBar    — Draft / Shipped, Ship, Edit & re-ship

import React, { useState } from "react";
import { Loader2, Lock, Send, Unlock } from "lucide-react";
import type { HandoverDecision } from "@/lib/shiftHandover";

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
    <div className="flex flex-wrap items-center gap-1.5 pb-1 print:hidden">
      <button type="button" disabled={disabled} aria-pressed={on} title={on ? "Click to take it off the list" : undefined}
        onClick={() => onChange({ ...decision, tryIt: !on, crew: !on ? decision?.crew ?? suggestions[0]?.crew ?? null : decision?.crew })}
        className={`shrink-0 whitespace-nowrap inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-bold transition-colors disabled:opacity-60 ${on
          ? "border-indigo-500 bg-indigo-600 text-white"
          : "border-indigo-300 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40"}`}>
        {on ? "✓ " : "+ "}{kind === "night" ? "Night" : "Day"} could try
      </button>
      {on && (
        <>
          <select disabled={disabled} value={decision?.crew ?? ""} onChange={(e) => onChange({ ...decision, tryIt: true, crew: e.target.value || null })}
            aria-label="Which crew" className="h-6 w-full sm:w-auto max-w-full sm:max-w-[240px] rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-[11px] text-[var(--color-text)]">
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
            placeholder="Note (optional)" className="h-6 w-full sm:w-44 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[11px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]" />
        </>
      )}
    </div>
  );
}

export function ShipBar({ shippedAt, shippedBy, tries, canShip, busy, err, onShip, onUnship, when }: {
  shippedAt: string | null; shippedBy: string | null; tries: number; canShip: boolean; busy: boolean; err: string | null;
  onShip: () => void; onUnship: () => void; when: (iso: string) => string;
}) {
  if (shippedAt) {
    return (
      <div className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-[12px] text-emerald-900 dark:text-emerald-100 print:hidden">
        <Lock className="w-4 h-4 shrink-0" />
        <span className="flex-1 min-w-[200px]"><b>Shipped</b> {when(shippedAt)}{shippedBy ? ` by ${shippedBy}` : ""}{tries ? ` · ${tries} step${tries === 1 ? "" : "s"} asked to try` : ""}. Locked - this is what was handed over.</span>
        {canShip && (
          <button onClick={onUnship} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-emerald-400 dark:border-emerald-700 px-2 py-1 text-[11px] font-bold hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unlock className="w-3.5 h-3.5" />} Edit &amp; re-ship
          </button>
        )}
        {err && <span className="w-full text-rose-700 dark:text-rose-300">{err}</span>}
      </div>
    );
  }
  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-100 print:hidden">
      <span className="rounded bg-amber-500 text-white text-[10px] font-black tracking-wider px-1.5 py-0.5">DRAFT</span>
      <span className="flex-1 min-w-[200px]">Mark only the exceptions{tries ? ` (${tries} asked to try)` : ""}. Ship confirms everything else as the report reads.</span>
      {canShip ? (
        <button onClick={onShip} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] px-3 py-1.5 text-[12px] font-bold shadow-sm disabled:opacity-50">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Ship turnover
        </button>
      ) : <span className="text-[11px]">Only someone who can edit the schedule can ship it.</span>}
      {err && <span className="w-full text-rose-700 dark:text-rose-300">{err}</span>}
    </div>
  );
}
