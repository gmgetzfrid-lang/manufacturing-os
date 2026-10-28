"use client";

// The turnover's own record, on the report: each crew's supervisor at the
// meeting and head count, the shift's safety incidents, and its notes &
// actions (lib/shiftRecord). Inputs on screen, plain text on paper.

import React, { useRef, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { INCIDENT_KINDS, type CrewCount, type Incident, type IncidentKind, type ShiftNote } from "@/lib/shiftRecord";
import { crewLine } from "@/lib/managementUpdate";
import { parseClock, timeInShift, type ShiftWindow } from "@/lib/shiftReport";

/** A time typed 24-hour on the shift ("14:30", "1430"): the instant, or
 *  why it isn't one. */
export function clockOnShift(w: ShiftWindow, clock: string, tz: string, now = Date.now()): { at: number } | { error: string } {
  if (!parseClock(clock)) return { error: "Type the time as 24-hour, like 14:30." };
  const at = timeInShift(w, clock, tz);
  if (at == null) return { error: `${clock.trim()} isn't on this shift.` };
  if (at > now + 60_000) return { error: "That time hasn't come yet." };
  return { at };
}

/** "1430" → "14:30" as it's typed. */
export const typeClock = (v: string) => {
  const d = v.replace(/[^0-9]/g, "").slice(0, 4);
  return d.length > 2 ? `${d.slice(0, d.length - 2)}:${d.slice(-2)}` : d;
};

const nowClock = (tz: string) => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });

const inputCls = "h-7 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent-ring)]";

/** A crew's supervisor and head count — saved when you leave the box. The
 *  last same shift's values show greyed until typed over. */
export function CrewCountEditor({ crew, value, hint, edit, print, onSave }: {
  crew: string; value?: CrewCount; hint?: CrewCount; edit: boolean; print: boolean;
  /** Only the box that changed — so a save can't undo the other one. */
  onSave: (v: Partial<CrewCount>) => void;
}) {
  // What you typed stays in the box (the saved record comes back a moment later).
  const [sup, setSup] = useState<string | null>(null);
  const [hc, setHc] = useState<string | null>(null);
  const sent = useRef<{ s?: string; h?: number | null }>({});
  if (print || !edit) return <span className="font-mono text-[12px] text-[var(--color-text-muted)] whitespace-nowrap">{crewLine(value)}</span>;
  const supV = sup ?? value?.supervisor ?? "";
  const hcV = hc ?? (value?.headcount != null ? String(value.headcount) : "");
  const commitSup = () => {
    if (sup == null) return;
    const s = sup.trim();
    if (s === (sent.current.s ?? value?.supervisor ?? "")) return;
    sent.current.s = s;
    onSave({ supervisor: s || undefined });
  };
  const commitHc = () => {
    if (hc == null) return;
    const n = hc.trim() === "" ? null : Math.max(0, Math.round(Number(hc)));
    if (n === (sent.current.h !== undefined ? sent.current.h : value?.headcount ?? null)) return;
    sent.current.h = n;
    onSave({ headcount: n });
  };
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      <input value={supV} onChange={(e) => setSup(e.target.value)} onBlur={commitSup} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        placeholder={hint?.supervisor || "Supervisor"} aria-label={`${crew} supervisor at the meeting`} className={`${inputCls} w-32 sm:w-36`} />
      <input value={hcV} onChange={(e) => setHc(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))} onBlur={commitHc} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        inputMode="numeric" placeholder={hint?.headcount != null ? String(hint.headcount) : "#"} aria-label={`${crew} head count on site`} className={`${inputCls} w-11 text-right font-mono`} />
      <span className="text-[11px] text-[var(--color-text-muted)]">on site</span>
    </span>
  );
}

/** "Safety incidents this shift: None / Report one" — in place of the old
 *  tick-box, with each one reported listed under it. */
export function IncidentsLine({ incidents, edit, print, shift, tz, T, onNone, onAdd, onRemove }: {
  incidents?: { none?: { at: number; by?: string | null } | null; items?: Incident[] };
  edit: boolean; print: boolean; shift: ShiftWindow; tz: string; T: (ms: number) => string;
  onNone: (none: boolean) => void; onAdd: (x: { at: number; kind: IncidentKind; text: string }) => void; onRemove: (id: string) => void;
}) {
  const items = incidents?.items ?? [];
  const none = !!incidents?.none && items.length === 0;
  const [open, setOpen] = useState(false);
  const [clock, setClock] = useState("");
  const [kind, setKind] = useState<IncidentKind>("Near miss");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const add = () => {
    const r = clockOnShift(shift, clock, tz);
    if ("error" in r) { setMsg(r.error); return; }
    if (!text.trim()) { setMsg("Say what happened."); return; }
    onAdd({ at: r.at, kind, text: text.trim() });
    setClock(""); setText(""); setMsg(null); setOpen(false);
  };
  const btn = (on: boolean) => `px-2 py-0.5 text-[11px] font-semibold ${on ? "bg-emerald-700 text-white" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`;
  return (
    <div className="text-[11.5px] min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <b className="text-[var(--color-text)]">Safety incidents this shift:</b>
        {print || !edit ? (
          <span className={items.length ? "font-bold text-rose-700 dark:text-rose-400" : none ? "font-bold text-emerald-700 dark:text-emerald-400" : "text-[var(--color-text-muted)]"}>
            {items.length ? `${items.length} reported` : none ? "None" : "not recorded"}
          </span>
        ) : (
          <span className="inline-flex overflow-hidden rounded-md border border-[var(--color-border-strong)] divide-x divide-[var(--color-border-strong)]">
            <button type="button" aria-pressed={none} disabled={items.length > 0} onClick={() => onNone(!none)} className={`${btn(none)} disabled:opacity-50`}>None</button>
            <button type="button" aria-pressed={open} onClick={() => setOpen((v) => !v)} className={btn(false)}>Report one</button>
          </span>
        )}
      </div>
      {items.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {[...items].sort((a, b) => a.at - b.at).map((x) => (
            <li key={x.id} className="flex items-baseline gap-1.5">
              <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">{T(x.at)}</span>
              <b className="shrink-0 whitespace-nowrap text-rose-700 dark:text-rose-400">{x.kind}</b>
              <span className="min-w-0 break-words">{x.text}</span>
              {edit && !print && <button type="button" onClick={() => onRemove(x.id)} className="ml-auto text-[10.5px] text-[var(--color-text-muted)] hover:text-rose-700">Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {open && edit && !print && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <input value={clock} onChange={(e) => { setClock(typeClock(e.target.value)); setMsg(null); }} inputMode="numeric" placeholder="hh:mm" aria-label="Time it happened" className={`${inputCls} w-16 font-mono`} />
          <button type="button" onClick={() => setClock(nowClock(tz))} className="h-7 px-2 rounded-md border border-[var(--color-border-strong)] text-[11px] font-semibold">Now</button>
          <select value={kind} onChange={(e) => setKind(e.target.value as IncidentKind)} aria-label="Kind" className={`${inputCls} pr-6`}>
            {INCIDENT_KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
          <input value={text} onChange={(e) => { setText(e.target.value); setMsg(null); }} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder="What happened, who, what was done" aria-label="What happened" className={`${inputCls} flex-1 min-w-[180px]`} />
          <button type="button" onClick={add} className="h-7 px-2.5 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-bold">Add</button>
          {msg && <span className="basis-full text-rose-700 dark:text-rose-400 font-semibold">{msg}</span>}
        </div>
      )}
    </div>
  );
}

/** Notes & actions in Close: anything that happened, with its time, and
 *  follow-ups — those stay on every report until cleared. */
export function ShiftNotesBox({ notes, edit, print, shift, tz, T, D, onAdd, onClear, onRemove }: {
  notes: Array<ShiftNote & { from?: string; shiftKey: string }>;
  edit: boolean; print: boolean; shift: ShiftWindow; tz: string; T: (ms: number) => string; D: (ms: number) => string;
  onAdd: (x: { at: number; text: string; followUp: boolean }) => void;
  onClear: (n: ShiftNote & { shiftKey: string }) => void;
  onRemove: (n: ShiftNote & { shiftKey: string }) => void;
}) {
  const [clock, setClock] = useState("");
  const [text, setText] = useState("");
  const [follow, setFollow] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const add = () => {
    const r = clockOnShift(shift, clock, tz);
    if ("error" in r) { setMsg(r.error); return; }
    if (!text.trim()) { setMsg("Type the note."); return; }
    onAdd({ at: r.at, text: text.trim(), followUp: follow });
    setClock(""); setText(""); setFollow(false); setMsg(null);
  };
  const sorted = [...notes].sort((a, b) => a.at - b.at);
  return (
    <div className="space-y-1">
      {sorted.length === 0 && (print || !edit) && Array.from({ length: print ? 4 : 3 }).map((_, i) => <div key={i} className="h-5 border-b border-dotted border-[var(--color-border-strong)]" />)}
      {sorted.length > 0 && (
        <ul className={`space-y-0.5 ${print ? "text-[8pt]" : "text-[12px]"}`}>
          {sorted.map((n) => (
            <li key={`${n.shiftKey}:${n.id}`} className="flex items-baseline gap-1.5">
              <span className="font-mono text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">{n.from ? `${D(n.at)} ${T(n.at)}` : T(n.at)}</span>
              <span className="min-w-0 break-words">
                {n.text}
                {n.followUp && <span className="ml-1.5 text-[10.5px] font-bold text-amber-800 dark:text-amber-300">{n.from ? `follow-up, open since ${n.from}` : "follow-up"}</span>}
              </span>
              {edit && !print && (
                <span className="ml-auto flex gap-2 shrink-0">
                  {n.followUp && <button type="button" onClick={() => onClear(n)} className="text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline">Clear</button>}
                  {!n.from && <button type="button" onClick={() => onRemove(n)} className="text-[10.5px] text-[var(--color-text-muted)] hover:text-rose-700">Remove</button>}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {edit && !print && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <input value={clock} onChange={(e) => { setClock(typeClock(e.target.value)); setMsg(null); }} inputMode="numeric" placeholder="hh:mm" aria-label="Time" className={`${inputCls} w-16 font-mono`} />
          <button type="button" onClick={() => setClock(nowClock(tz))} className="h-7 px-2 rounded-md border border-[var(--color-border-strong)] text-[11px] font-semibold">Now</button>
          <input value={text} onChange={(e) => { setText(e.target.value); setMsg(null); }} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder="What happened, or what needs doing" aria-label="Note" className={`${inputCls} flex-1 min-w-[160px]`} />
          <label className="inline-flex items-center gap-1 text-[11px]"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow-up</label>
          <button type="button" onClick={add} className="h-7 px-2.5 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-bold">Add</button>
          {msg && <span className="basis-full text-[11px] text-rose-700 dark:text-rose-400 font-semibold">{msg}</span>}
        </div>
      )}
    </div>
  );
}

/** A company at the meeting that has no steps on the schedule (Operations,
 *  Safety, a vendor) — added to the crews list for this shift. */
export function AddCompany({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const add = () => { if (name.trim()) { onAdd(name.trim()); setName(""); setOpen(false); } };
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="mt-1 text-[11px] font-semibold text-[var(--color-accent)] hover:underline">+ Add a company</button>;
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setOpen(false); }}
        placeholder="Company or group" aria-label="Company or group" className={`${inputCls} flex-1 min-w-0`} />
      <button type="button" onClick={add} className="h-7 px-2.5 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-bold">Add</button>
      <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-[var(--color-text-muted)]">Cancel</button>
    </div>
  );
}

/** The time log, its own export (Excel) — this shift, or the whole job. */
export function TimeLogButton({ busy, msg, onExport, shiftLabel }: { busy: boolean; msg: string | null; onExport: (scope: "shift" | "job") => void; shiftLabel: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={busy}
        title="Every work order and step with the time each thing was done — its own file for the project, not part of the update"
        className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-60">
        <FileSpreadsheet className="w-3.5 h-3.5" /> {busy ? "Exporting…" : "Time log"}
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-[40]" onClick={() => setOpen(false)} aria-hidden />
          <span className="absolute right-0 top-full mt-1 z-[41] w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-1.5 flex flex-col text-[12px]">
            <span className="px-2 pt-1 pb-1.5 text-[11px] text-[var(--color-text-muted)]">Excel file: every step and the time each thing was done.</span>
            <button type="button" onClick={() => { setOpen(false); onExport("shift"); }} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] font-semibold">{shiftLabel}</button>
            <button type="button" onClick={() => { setOpen(false); onExport("job"); }} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] font-semibold">Whole job to date</button>
          </span>
        </>
      )}
      {msg && !open && <span role="status" className="absolute right-0 top-full mt-1 z-[39] whitespace-nowrap rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--color-text-muted)] shadow-sm">{msg}</span>}
    </span>
  );
}
