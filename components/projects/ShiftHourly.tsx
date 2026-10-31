"use client";

// Shift notes, hour by hour — on the turnover report. The shift's meeting
// (who attended: each crew's supervisor and head count), the first hour —
// start of shift, permitting — each hour, then the turnover meeting with
// the next shift, saying the shift's own entries in that hour, one line
// each, its work order in bold (lib/shiftHourly). Any hour can be typed
// over; that one is then kept as typed. A meeting that wasn't held comes
// off the log (and can be put back).

import React, { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { CrewCountEditor, AddCompany } from "@/components/projects/ShiftRecordParts";
import { crewLine } from "@/lib/managementUpdate";
import type { CrewCount } from "@/lib/shiftRecord";
import { newId } from "@/lib/shiftRecord";
import type { TimeLogRow } from "@/lib/timeLog";
import {
  hourlyClocks, hourlyRows, typedLines, slotOf, SLOT_LABEL, breakLabel, boldRuns, type HourSlot, type HourlyNotes,
} from "@/lib/shiftHourly";

const inputCls = "rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1 text-[12.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent-ring)]";
const btn = "inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[12px] font-bold disabled:opacity-60";

export interface HourlyCtx {
  notes?: HourlyNotes;
  /** Change the notes as saved now (read fresh, so nothing typed meanwhile is lost). */
  update: (change: (cur: HourlyNotes | undefined) => HourlyNotes | null) => Promise<void>;
  /** The shift's entries (the time log for its window); null while they're read. */
  entries: TimeLogRow[] | null;
  /** The shift by the hour (lib/shiftHourly hourSlots). */
  slots: HourSlot[];
  /** Up to when the hours show: now, or the shift's end. */
  upTo: number;
  /** Put discovery or added scope into the schedule at this hour (the hour's start). */
  onAddWork?: (at: number) => void;
}

/** The meeting's attendance: each crew on the shift, its supervisor at the
 *  meeting and head count on site. */
export interface MeetingCrews {
  rows: Array<{ crew: string; note?: string }>;
  counts: Record<string, CrewCount>;
  hint?: Record<string, CrewCount>;
  setCrew: (crew: string, v: Partial<CrewCount>) => void;
}

/** "Shift meeting — Schultz: Mike · 12 on site; Maintenance (KE): 4 on site" — the meeting in one line. */
export function meetingLine(m: MeetingCrews | undefined, extra?: string): string {
  const crews = (m?.rows ?? []).map((x) => `${x.crew}: ${crewLine(m?.counts[x.crew])}`);
  return [crews.length ? crews.join("; ") : null, extra?.trim() || null].filter(Boolean).join(". ");
}

export function ShiftHourlyBox({ h, edit, print, tz, meeting }: {
  h: HourlyCtx; edit: boolean; print: boolean; tz: string; meeting?: MeetingCrews;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const rows = hourlyRows(h.notes, h.slots, h.upTo, h.entries, tz);
  const clocks = hourlyClocks(rows.map((r) => r.slot.start), tz);
  // Meetings taken off the log: listed under it, to put back.
  const skipped = new Set(h.notes?.skip ?? []);
  const removed = h.slots.filter((x) => skipped.has(x.key));
  const setSkip = async (key: string, off: boolean) => {
    try {
      await h.update((cur) => {
        const base: HourlyNotes = cur?.v === 2 ? cur : { v: 2, lines: typedLines(cur) };
        const next = new Set(base.skip ?? []);
        if (off) next.add(key); else next.delete(key);
        return { ...base, v: 2, skip: [...next] };
      });
      setMsg(null);
    } catch (e) { setMsg((e as Error).message); }
  };

  // An hour as typed: kept as typed (empty puts it back to the entries).
  const setHour = async (slot: HourSlot, text: string | null) => {
    setEditing(null);
    try {
      await h.update((cur) => {
        const rest = typedLines(cur).filter((l) => slotOf(l.at, h.slots).key !== slot.key);
        const t = text?.split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
        return { ...(cur?.v === 2 ? cur : {}), v: 2, lines: t ? [...rest, { id: newId(), at: slot.start, text: t, hand: true }] : rest };
      });
      setMsg(null);
    } catch (e) { setMsg((e as Error).message); }
  };

  if (print) {
    return (
      <table className="w-full text-[8.5pt] border-collapse">
        <tbody>
          {rows.map((r, i) => {
            const going = r.progress;
            return (
              <tr key={r.slot.key} className="align-top">
                <td className="w-16 pr-2 py-0.5 font-semibold whitespace-nowrap">{clocks[i]}</td>
                <td className="py-0.5">
                  {r.slot.kind === "break" ? <span className="text-slate-500">{breakLabel(r.slot)}</span> : <>
                    {SLOT_LABEL[r.slot.kind] && <b>{SLOT_LABEL[r.slot.kind]}{r.slot.kind === "meeting" ? " - " : ""}</b>}
                    {r.slot.kind === "meeting" ? meetingLine(meeting, r.text) || "-" : <Items text={r.text} going={going} empty={r.slot.kind === "work"} />}
                  </>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <div className="space-y-1.5">
      <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
        {rows.map((r, i) => {
          const typed = r.typed;
          const label = SLOT_LABEL[r.slot.kind];
          // A break: its own quiet row, blocked off.
          if (r.slot.kind === "break") {
            return (
              <li key={r.slot.key} className="flex items-start gap-2 px-3 py-1 text-[12px] leading-snug bg-[var(--color-surface-2)]/60">
                <span className="w-[66px] shrink-0 font-bold text-[var(--color-text-muted)] whitespace-nowrap tabular-nums">{clocks[i]}</span>
                <span className="font-semibold text-[var(--color-text-muted)]">{breakLabel(r.slot)}</span>
              </li>
            );
          }
          return (
            <li key={r.slot.key} className="grid grid-cols-[66px_minmax(0,1fr)_auto] max-sm:grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-0.5 px-3 py-1.5 text-[12.5px] leading-snug">
              <span className="font-bold text-[var(--color-text)] whitespace-nowrap tabular-nums">{clocks[i]}</span>
              {/* On a phone the time and its buttons share a line; what happened gets the full width under them. */}
              <div className="min-w-0 max-sm:order-last max-sm:col-span-2">
                {label && <div className="font-bold text-[var(--color-text)]">{label}</div>}
                {r.slot.kind === "meeting" && (
                  <MeetingBox meeting={meeting} edit={edit} />
                )}
                {editing === r.slot.key ? (
                  <HourForm init={r.text} placeholder={r.slot.kind === "meeting" ? "Anything from the meeting" : "What happened this hour"}
                    onDone={(t) => void setHour(r.slot, t)} onCancel={() => setEditing(null)} />
                ) : r.slot.kind === "meeting" ? (
                  r.text ? <div className="break-words text-[var(--color-text)]">{r.text}</div> : null
                ) : (
                  <Items text={r.text} going={r.progress} empty={r.slot.kind === "work" || r.slot.kind === "handover"} />
                )}
                {/* A typed note: a mistake, or now put in as work (its own entry
                    says it) - deleted, the hour shows its entries again. */}
                {edit && typed && editing !== r.slot.key && r.slot.kind !== "meeting" && (
                  <button type="button" onClick={() => void setHour(r.slot, null)} title="Delete what was typed here - the hour shows its entries"
                    className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 dark:text-rose-400 hover:underline">
                    <Trash2 className="w-3 h-3" /> Delete typed note
                  </button>
                )}
              </div>
              <div className="flex items-center justify-end gap-1">
              {!print && h.onAddWork && editing !== r.slot.key && r.slot.kind !== "meeting" && (
                <button type="button" onClick={() => h.onAddWork?.(r.slot.start)} aria-label={`Add discovery or added scope at ${clocks[i]}`}
                  title="Add discovery or added scope at this hour - it goes into the schedule"
                  className="shrink-0 inline-flex items-center gap-0.5 h-6 px-1.5 rounded-md border border-dashed border-[var(--color-accent)] text-[11px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
                  <Plus className="w-3 h-3" /> Add work
                </button>
              )}
              {edit && editing !== r.slot.key && (r.slot.kind === "meeting" || r.slot.kind === "handover") && (
                <button type="button" onClick={() => void setSkip(r.slot.key, true)} aria-label={`Remove ${SLOT_LABEL[r.slot.kind]} from the log`}
                  title="Wasn't held: take it off the log (it can be put back)"
                  className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              {edit && editing !== r.slot.key && (
                <button type="button" onClick={() => setEditing(r.slot.key)} aria-label={`Edit ${clocks[i]}`}
                  className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
              </div>
            </li>
          );
        })}
      </ul>
      {removed.length > 0 && (
        <div className="text-[11.5px] text-[var(--color-text-muted)]">
          Taken off the log: {removed.map((x, i) => (
            <span key={x.key}>{i > 0 ? ", " : ""}{SLOT_LABEL[x.kind] || "Hour"}{edit && <button type="button" onClick={() => void setSkip(x.key, false)} className="ml-1 font-semibold text-[var(--color-accent)] hover:underline">Put back</button>}</span>
          ))}
        </div>
      )}
      {msg && <div role="alert" className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
    </div>
  );
}

/** A line with its work order in bold. */
function Line({ text }: { text: string }) {
  return <>{boldRuns(text).map((r, i) => (r.b ? <b key={i} className="font-bold">{r.t}</b> : <React.Fragment key={i}>{r.t}</React.Fragment>))}</>;
}

/** An hour's lines, one item each: what started, finished or was held,
 *  then (in the progress color) what moved its % that hour. */
function Items({ text, going, empty }: { text: string; going: string[]; empty: boolean }) {
  const items = text.split("\n").map((x) => x.trim()).filter(Boolean);
  if (!items.length && !going.length) return empty ? <div className="text-[var(--color-text-faint)]">-</div> : null;
  return (
    <ul className="space-y-0.5">
      {items.map((x, i) => <li key={i} className="break-words text-[var(--color-text)]"><Line text={x} /></li>)}
      {going.map((x, i) => <li key={`g${i}`} className="break-words text-[var(--color-text-muted)]"><Line text={x} /></li>)}
    </ul>
  );
}

/** Who attended: each crew's supervisor at the meeting and head count. */
function MeetingBox({ meeting, edit }: { meeting?: MeetingCrews; edit: boolean }) {
  if (!meeting) return null;
  return (
    <div className="mt-0.5 mb-1 space-y-0.5">
      {meeting.rows.length === 0 && <div className="text-[12px] italic text-[var(--color-text-muted)]">No work planned</div>}
      {meeting.rows.map((x) => (
        <div key={x.crew} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
          <span className="min-w-0"><b className="text-[var(--color-text)] break-words">{x.crew}</b>{x.note && <span className="block text-[11px] text-[var(--color-text-muted)] break-words">{x.note}</span>}</span>
          <CrewCountEditor crew={x.crew} value={meeting.counts[x.crew]} hint={meeting.hint?.[x.crew]} edit={edit} print={false} onSave={(v) => meeting.setCrew(x.crew, v)} />
        </div>
      ))}
      {edit && <AddCompany onAdd={(name) => meeting.setCrew(name, {})} />}
    </div>
  );
}

function HourForm({ init, placeholder, onDone, onCancel }: { init: string; placeholder: string; onDone: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(init);
  return (
    <div className="mt-0.5 space-y-1.5">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(8, Math.max(2, text.split("\n").length + 1))} aria-label={placeholder} placeholder={`${placeholder} - one line each`} autoFocus
        className={`${inputCls} w-full resize-y`} />
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onDone(text)} className={`${btn} bg-[var(--color-accent)] text-[var(--color-accent-fg)]`}>Save</button>
        <button type="button" onClick={onCancel} className="text-[11.5px] text-[var(--color-text-muted)] hover:underline">Cancel</button>
      </div>
    </div>
  );
}
