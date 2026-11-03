"use client";

// The turnover's own record, on the report: the shift's safety incidents,
// and its notes & actions (lib/shiftRecord). Inputs on screen, plain text
// on paper. The meetings' attendance is in the notes, hour by hour
// (components/projects/ShiftHourly).
//
// What a shift wrote can be changed: an incident or a note is edited in
// place, a removal is asked first and can be undone, and a cleared
// follow-up can be opened again. The report hands these parts add, clear
// and remove; edit, put back and undo clear write the shift's record from
// here (useRecordWriter) until the report passes its own (onEdit,
// onUnclear), and fall back to remove-then-add where neither can.

import React, { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { FileSpreadsheet, RotateCcw } from "lucide-react";
import {
  INCIDENT_KINDS, saveShiftRecord, editIncident, restoreIncident, editNote, restoreNote, unclearNote,
  type Incident, type IncidentKind, type ShiftNote, type ShiftRecord,
} from "@/lib/shiftRecord";
import { parseClock, timeInShift, timeOnDay, shiftAt, DEFAULT_SHIFT_TIMES, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { handoverKey } from "@/lib/shiftHandover";
import { dayKey, toDateTimeInput } from "@/lib/scheduleTz";
import { TimeChip } from "@/components/projects/DateTimePicker";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";

type RecordWriter = (shiftKey: string, change: (r: ShiftRecord) => ShiftRecord) => Promise<void>;

/** Write a shift's record from here: the project from the page it's on
 *  (/projects/[id]), the person from their sign-in. Null when either isn't
 *  known. */
function useRecordWriter(): { write: RecordWriter | null; by: string | null } {
  const params = useParams<{ id?: string | string[] }>();
  const { uid, activeOrgId, userEmail } = useRole();
  const projectId = typeof params?.id === "string" ? params.id : null;
  const by = userEmail?.split("@")[0] ?? null;
  const write = useMemo<RecordWriter | null>(() => (projectId && uid && activeOrgId
    ? async (shiftKey, change) => { await saveShiftRecord({ orgId: activeOrgId, projectId, shiftKey, userId: uid, change }); }
    : null), [projectId, uid, activeOrgId]);
  return { write, by };
}

/** The clock a stored instant reads on the shift ("14:30", for the time
 *  chip, which shows it as 2:30 PM). */
const clockOf = (at: number, tz: string) => toDateTimeInput(at, tz).slice(11, 16);

const smallBtn = "px-1.5 py-1 text-[10.5px] font-semibold rounded hover:bg-[var(--color-surface-2)]";

/** "Removed. Undo" - right after a removal, until dismissed. */
function UndoLine({ text, onUndo, onDismiss }: { text: string; onUndo: () => void; onDismiss: () => void }) {
  return (
    <div role="status" className="mt-1 flex items-center gap-2 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-200">
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <button type="button" onClick={onUndo} className="inline-flex items-center gap-1 px-2 py-1 rounded font-bold bg-amber-600 text-white hover:bg-amber-700"><RotateCcw className="w-3 h-3" /> Undo</button>
      <button type="button" onClick={onDismiss} className="px-1.5 py-1 font-semibold hover:underline">Dismiss</button>
    </div>
  );
}

/** A time typed 24-hour on the shift ("14:30", "1430"): the instant, or
 *  why it isn't one. */
export function clockOnShift(w: ShiftWindow, clock: string, tz: string, now = Date.now()): { at: number } | { error: string } {
  if (!parseClock(clock)) return { error: "Type the time as 24-hour, like 14:30." };
  const at = timeInShift(w, clock, tz);
  if (at == null) return { error: `${clock.trim()} isn't on this shift.` };
  if (at > now + 60_000) return { error: "That time hasn't come yet." };
  return { at };
}

/** When work happened: on the shift picked — or, a time that isn't on it,
 *  on the shift that time is on that day ("Sat day" + 22:00 → Sat night).
 *  Never later than now. A shift's own record (incidents, notes) keeps to
 *  its shift (clockOnShift). */
export function clockForWork(w: ShiftWindow, clock: string, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES, now = Date.now()): { at: number; shift: ShiftWindow; moved: boolean } | { error: string } {
  if (!parseClock(clock)) return { error: "Type the time as 24-hour, like 14:30." };
  const at = timeInShift(w, clock, tz) ?? timeOnDay(w.dayKey, clock, tz);
  if (at == null) return { error: "Type the time as 24-hour, like 14:30." };
  if (at > now + 60_000) return { error: "That time hasn't come yet." };
  const shift = shiftAt(at, tz, times);
  return { at, shift, moved: shift.start !== w.start };
}

/** "Sat night, Oct 24" — the shift a time landed on. */
export function shiftWord(w: ShiftWindow, tz: string): string {
  const d = new Date(w.start);
  const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: tz }), md = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
  return `${wd} ${w.kind}, ${md}`;
}

/** Another day than the chips offer — for filling in older work. */
export function DayPick({ value, onChange, tz, disabled, className = "" }: { value: string | null; onChange: (d: string | null) => void; tz: string; disabled?: boolean; className?: string }) {
  // Not after today.
  const [max] = useState(() => dayKey(Date.now(), tz));
  return (
    <input type="date" value={value ?? ""} max={max} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} aria-label="The day it happened"
      className={`h-8 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[12.5px] text-[var(--color-text)] ${className}`} />
  );
}

/** "1430" → "14:30" as it's typed. */
export const typeClock = (v: string) => {
  const d = v.replace(/[^0-9]/g, "").slice(0, 4);
  return d.length > 2 ? `${d.slice(0, d.length - 2)}:${d.slice(-2)}` : d;
};

const nowClock = (tz: string) => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });

const inputCls = "h-7 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent-ring)]";

/** "Safety incidents this shift: None / Report one" — in place of the old
 *  tick-box, with each one reported listed under it. */
export function IncidentsLine({ incidents, edit, print, shift, tz, T, onNone, onAdd, onRemove, onEdit }: {
  incidents?: { none?: { at: number; by?: string | null } | null; items?: Incident[] };
  edit: boolean; print: boolean; shift: ShiftWindow; tz: string; T: (ms: number) => string;
  onNone: (none: boolean) => void; onAdd: (x: { at: number; kind: IncidentKind; text: string }) => void; onRemove: (id: string) => void;
  /** Change one in place. Unset: written from here (or remove-then-add). */
  onEdit?: (id: string, x: { at: number; kind: IncidentKind; text: string }) => void;
}) {
  const items = incidents?.items ?? [];
  const none = !!incidents?.none && items.length === 0;
  const [open, setOpen] = useState(false);
  const [clock, setClock] = useState("");
  const [kind, setKind] = useState<IncidentKind>("Near miss");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  // The incident being edited (the form above fills with it), and the one
  // just removed (Undo).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Incident | null>(null);
  const { write, by } = useRecordWriter();
  const key = handoverKey(shift);
  const reset = () => { setClock(""); setText(""); setMsg(null); setOpen(false); setEditingId(null); setKind("Near miss"); };
  const add = () => {
    const r = clockOnShift(shift, clock, tz);
    if ("error" in r) { setMsg(r.error); return; }
    if (!text.trim()) { setMsg("Say what happened."); return; }
    const x = { at: r.at, kind, text: text.trim() };
    if (editingId) {
      const id = editingId;
      if (onEdit) onEdit(id, x);
      else if (write) void write(key, (rec) => editIncident(rec, id, x, by)).catch((e) => setMsg((e as Error).message));
      else { onRemove(id); onAdd(x); }
    } else onAdd(x);
    reset();
  };
  const startEdit = (x: Incident) => {
    setEditingId(x.id); setClock(clockOf(x.at, tz)); setKind(x.kind); setText(x.text); setMsg(null); setOpen(true); setRemoved(null);
  };
  const remove = async (x: Incident) => {
    if (!(await appConfirm({ title: "Remove this incident?", message: `${x.kind}: "${x.text}" comes off the shift's record. You can undo right after.`, confirmLabel: "Remove", tone: "danger" }))) return;
    onRemove(x.id);
    setRemoved(x);
    if (editingId === x.id) reset();
  };
  const undoRemove = () => {
    const x = removed;
    setRemoved(null);
    if (!x) return;
    // Back exactly as it was when this page can write the record; else re-added.
    if (write) void write(key, (rec) => restoreIncident(rec, x)).catch((e) => setMsg((e as Error).message));
    else onAdd({ at: x.at, kind: x.kind, text: x.text });
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
            <button type="button" aria-pressed={open && !editingId} onClick={() => { if (editingId) reset(); else setOpen((v) => !v); }} className={btn(false)}>Report one</button>
          </span>
        )}
      </div>
      {items.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {[...items].sort((a, b) => a.at - b.at).map((x) => (
            <li key={x.id} className={`flex items-baseline gap-1.5 ${editingId === x.id ? "rounded bg-[var(--color-accent-soft)]/50" : ""}`}>
              <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">{T(x.at)}</span>
              <b className="shrink-0 whitespace-nowrap text-rose-700 dark:text-rose-400">{x.kind}</b>
              <span className="min-w-0 break-words">{x.text}</span>
              {edit && !print && (
                <span className="ml-auto flex gap-1 shrink-0">
                  <button type="button" onClick={() => startEdit(x)} className={`${smallBtn} text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}>Edit</button>
                  <button type="button" onClick={() => void remove(x)} className={`${smallBtn} text-[var(--color-text-muted)] hover:text-rose-700`}>Remove</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {removed && edit && !print && (
        <UndoLine text={`Removed: ${removed.kind}, ${removed.text}`} onUndo={undoRemove} onDismiss={() => setRemoved(null)} />
      )}
      {open && edit && !print && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <TimeChip value={clock} onChange={(v) => { setClock(v); setMsg(null); }} tz={tz} label="Time it happened" />
          <button type="button" onClick={() => setClock(nowClock(tz))} className="h-7 px-2 rounded-md border border-[var(--color-border-strong)] text-[11px] font-semibold">Now</button>
          <select value={kind} onChange={(e) => setKind(e.target.value as IncidentKind)} aria-label="Kind" className={`${inputCls} pr-6`}>
            {INCIDENT_KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
          <input value={text} onChange={(e) => { setText(e.target.value); setMsg(null); }} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder="What happened, who, what was done" aria-label="What happened" className={`${inputCls} flex-1 min-w-[180px]`} />
          <button type="button" onClick={add} className="h-7 px-2.5 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-bold">{editingId ? "Save" : "Add"}</button>
          {editingId && <button type="button" onClick={reset} className="h-7 px-2 text-[11px] font-semibold text-[var(--color-text-muted)]">Cancel</button>}
          {msg && <span className="basis-full text-rose-700 dark:text-rose-400 font-semibold">{msg}</span>}
        </div>
      )}
      {!open && msg && <div className="mt-1 text-rose-700 dark:text-rose-400 font-semibold">{msg}</div>}
    </div>
  );
}

/** Notes & actions in Close: anything that happened, with its time, and
 *  follow-ups — those stay on every report until cleared. */
export function ShiftNotesBox({ notes, edit, print, shift, tz, T, D, onAdd, onClear, onRemove, onEdit, onUnclear }: {
  notes: Array<ShiftNote & { from?: string; shiftKey: string }>;
  edit: boolean; print: boolean; shift: ShiftWindow; tz: string; T: (ms: number) => string; D: (ms: number) => string;
  onAdd: (x: { at: number; text: string; followUp: boolean }) => void;
  onClear: (n: ShiftNote & { shiftKey: string }) => void;
  onRemove: (n: ShiftNote & { shiftKey: string }) => void;
  /** Change one of this shift's notes in place. Unset: written from here
   *  (or remove-then-add). */
  onEdit?: (n: ShiftNote & { shiftKey: string }, x: { at: number; text: string; followUp: boolean }) => void;
  /** Open a cleared follow-up again. Unset: written from here. */
  onUnclear?: (n: ShiftNote & { shiftKey: string }) => void;
}) {
  const [clock, setClock] = useState("");
  const [text, setText] = useState("");
  const [follow, setFollow] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // The note being edited (the line below fills with it), the one just
  // removed, and the follow-up just cleared (each can be undone).
  const [editing, setEditing] = useState<(ShiftNote & { shiftKey: string }) | null>(null);
  const [removed, setRemoved] = useState<(ShiftNote & { shiftKey: string }) | null>(null);
  const [cleared, setCleared] = useState<(ShiftNote & { shiftKey: string; from?: string }) | null>(null);
  const { write, by } = useRecordWriter();
  const reset = () => { setClock(""); setText(""); setFollow(false); setMsg(null); setEditing(null); };
  const fail = (e: unknown) => setMsg((e as Error).message);
  const add = () => {
    const r = clockOnShift(shift, clock, tz);
    if ("error" in r) { setMsg(r.error); return; }
    if (!text.trim()) { setMsg("Type the note."); return; }
    const x = { at: r.at, text: text.trim(), followUp: follow };
    if (editing) {
      const n = editing;
      if (onEdit) onEdit(n, x);
      else if (write) void write(n.shiftKey, (rec) => editNote(rec, n.id, x, by)).catch(fail);
      else { onRemove(n); onAdd(x); }
    } else onAdd(x);
    reset();
  };
  const startEdit = (n: ShiftNote & { shiftKey: string }) => {
    setEditing(n); setClock(clockOf(n.at, tz)); setText(n.text); setFollow(!!n.followUp); setMsg(null); setRemoved(null);
  };
  const remove = async (n: ShiftNote & { shiftKey: string }) => {
    if (!(await appConfirm({ title: "Remove this note?", message: `"${n.text}" comes off the shift's record. You can undo right after.`, confirmLabel: "Remove", tone: "danger" }))) return;
    onRemove(n);
    setRemoved(n);
    if (editing?.id === n.id) reset();
  };
  const undoRemove = () => {
    const n = removed;
    setRemoved(null);
    if (!n) return;
    const { shiftKey, ...note } = n;
    if (write) void write(shiftKey, (rec) => restoreNote(rec, note)).catch(fail);
    else onAdd({ at: n.at, text: n.text, followUp: !!n.followUp });
  };
  const clear = (n: ShiftNote & { shiftKey: string; from?: string }) => { onClear(n); setCleared(n); };
  // A follow-up cleared by mistake: back on every report.
  const canUnclear = (n: ShiftNote & { from?: string }) => !!onUnclear || !!write || !n.from;
  const unclear = (n: ShiftNote & { shiftKey: string; from?: string }) => {
    setCleared(null);
    if (onUnclear) onUnclear(n);
    else if (write) void write(n.shiftKey, (rec) => unclearNote(rec, n.id)).catch(fail);
    // This shift's own note, and nothing else to write with: put it back open.
    else if (!n.from) { onRemove(n); onAdd({ at: n.at, text: n.text, followUp: true }); }
  };
  const sorted = [...notes].sort((a, b) => a.at - b.at);
  return (
    <div className="space-y-1">
      {sorted.length === 0 && (print || !edit) && Array.from({ length: print ? 4 : 3 }).map((_, i) => <div key={i} className="h-5 border-b border-dotted border-[var(--color-border-strong)]" />)}
      {sorted.length > 0 && (
        <ul className={`space-y-0.5 ${print ? "text-[8pt]" : "text-[12px]"}`}>
          {sorted.map((n) => (
            <li key={`${n.shiftKey}:${n.id}`} className={`flex items-baseline gap-1.5 ${editing?.id === n.id ? "rounded bg-[var(--color-accent-soft)]/50" : ""}`}>
              <span className="font-mono text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">{n.from ? `${D(n.at)} ${T(n.at)}` : T(n.at)}</span>
              <span className="min-w-0 break-words">
                {n.text}
                {n.followUp && !n.cleared && <span className="ml-1.5 text-[10.5px] font-bold text-amber-800 dark:text-amber-300">{n.from ? `follow-up, open since ${n.from}` : "follow-up"}</span>}
                {n.followUp && n.cleared && <span className="ml-1.5 text-[10.5px] font-bold text-emerald-700 dark:text-emerald-400">follow-up, cleared{n.cleared.by ? ` by ${n.cleared.by}` : ""}</span>}
              </span>
              {edit && !print && (
                <span className="ml-auto flex gap-1 shrink-0">
                  {n.followUp && !n.cleared && <button type="button" onClick={() => clear(n)} className={`${smallBtn} text-emerald-700 dark:text-emerald-400`}>Clear</button>}
                  {n.followUp && n.cleared && canUnclear(n) && <button type="button" onClick={() => unclear(n)} className={`${smallBtn} text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}>Undo clear</button>}
                  {!n.from && <button type="button" onClick={() => startEdit(n)} className={`${smallBtn} text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}>Edit</button>}
                  {!n.from && <button type="button" onClick={() => void remove(n)} className={`${smallBtn} text-[var(--color-text-muted)] hover:text-rose-700`}>Remove</button>}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {removed && edit && !print && (
        <UndoLine text={`Removed: ${removed.text}`} onUndo={undoRemove} onDismiss={() => setRemoved(null)} />
      )}
      {/* An earlier shift's follow-up leaves this list when it's cleared: say so, with Undo. */}
      {cleared && cleared.from && canUnclear(cleared) && edit && !print && (
        <UndoLine text={`Cleared: ${cleared.text}`} onUndo={() => unclear(cleared)} onDismiss={() => setCleared(null)} />
      )}
      {edit && !print && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <TimeChip value={clock} onChange={(v) => { setClock(v); setMsg(null); }} tz={tz} />
          <button type="button" onClick={() => setClock(nowClock(tz))} className="h-7 px-2 rounded-md border border-[var(--color-border-strong)] text-[11px] font-semibold">Now</button>
          <input value={text} onChange={(e) => { setText(e.target.value); setMsg(null); }} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder="What happened, or what needs doing" aria-label="Note" className={`${inputCls} flex-1 min-w-[160px]`} />
          <label className="inline-flex items-center gap-1 text-[11px]"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow-up</label>
          <button type="button" onClick={add} className="h-7 px-2.5 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-bold">{editing ? "Save" : "Add"}</button>
          {editing && <button type="button" onClick={reset} className="h-7 px-2 text-[11px] font-semibold text-[var(--color-text-muted)]">Cancel</button>}
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
        title="Every work order and step with the time each thing was done - its own file for the project, not part of the update"
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
