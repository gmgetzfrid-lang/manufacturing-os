"use client";

// Shift notes, hour by hour, on the turnover report. The meeting that
// starts the shift (who attended from each crew, each crew's head count on
// site, the safety topic), the first hour (start of shift, permitting),
// each hour, then the meeting that starts the next shift. Each hour says
// the shift's own entries in it, one line each, its work order in bold
// (lib/shiftHourly). Any hour can be typed over; that one is then kept as
// typed. A meeting that wasn't held comes off the log (and can be put
// back). Work logged during the end meeting gets its own row after it.

import React, { useId, useRef, useState } from "react";
import { AlertTriangle, Check, Pencil, Plus, Trash2, X as XIcon } from "lucide-react";
import { AddCompany } from "@/components/projects/ShiftRecordParts";
import type { CrewCount, ShiftRecord } from "@/lib/shiftRecord";
import { newId } from "@/lib/shiftRecord";
import type { TimeLogRow } from "@/lib/timeLog";
import {
  slotClocks, hourlyRows, typedLines, typedHour, type HourlyRow, slotOf, SLOT_LABEL, breakLabel, boldRuns, type HourSlot, type HourlyNotes,
} from "@/lib/shiftHourly";
import { timeAfter, type HoldOver } from "@/lib/holdOver";
import { timeOnDay } from "@/lib/shiftReport";
import { dayKey } from "@/lib/scheduleTz";
import { TimeChip } from "@/components/projects/DateTimePicker";
import { cleanName, crewNames, renamed, setNames, totalOnSite, withName, withoutName, earlierMeetingLines, hasOwnRoster, meetingEmpty, onSiteCell, type MeetingParts } from "@/lib/shiftMeeting";

const inputCls = "rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1 text-[12.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent-ring)]";
const btn = "inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[12px] font-bold disabled:opacity-60";
const iconBtn = "shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]";

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
  /** Keeping a crew on past the end of the shift (overtime, lib/holdOver). */
  overtime?: { list: HoldOver[]; crews: string[]; shiftEnd: number; cap: number; tz: string; save: (change: (l: HoldOver[]) => HoldOver[]) => Promise<void> };
  /** The entries that finish a whole work order (lib/shiftHourly workOrderClosers): their lines in green. */
  closes?: (r: TimeLogRow) => boolean;
  /** The two meetings as the log says them (lib/shiftMeeting), which are
   *  off the log, and which show before their time. */
  meet?: { start: MeetingSaid; end: MeetingSaid; off: string[]; show: string[] };
}

/** A meeting as the log says it: its title, its lines, its table (resource,
 *  meeting attendees, on site), and the shift its crews came from when
 *  they weren't updated for this one. */
export interface MeetingSaid { title: string; lines: string[]; parts?: MeetingParts; carried?: string }

/** A meeting to fill in: the crews to list, what's entered, how to save it. */
export interface MeetingCtx {
  /** The crews on the plan for the shift it starts (they stay listed). */
  crews: string[];
  /** The record of the shift it starts (its `crews` and `meeting`). */
  record?: ShiftRecord;
  /** When that shift starts: what was typed before it is the meeting's. */
  shiftStart: number;
  /** Its crews aren't its own yet: carried from the last same shift
   *  (`record.crews` shows them); `label` says which. */
  carried?: { crews: Record<string, CrewCount>; label: string };
  /** Names entered at earlier meetings, by crew (to pick from as you type). */
  known?: Record<string, string[]>;
  /** The safety topics the report gives this meeting, to pick from. */
  topics?: string[];
  /** Change that record (read fresh). */
  save: (change: (r: ShiftRecord) => ShiftRecord) => Promise<void>;
}

export function ShiftHourlyBox({ h, edit, print, tz, meetings }: {
  h: HourlyCtx; edit: boolean; print: boolean; tz: string;
  /** The meeting that starts this shift, and the one that starts the next. */
  meetings?: { start?: MeetingCtx; end?: MeetingCtx };
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [otForm, setOtForm] = useState<"new" | "edit" | "send" | null>(null);
  const rows = hourlyRows(h.notes, h.slots, h.upTo, h.entries, tz, { ...h.meet, closes: h.closes });
  const clocks = slotClocks(rows.map((r) => r.slot), tz);
  const meetingOf = (x: HourSlot) => (x.kind === "meeting" ? meetings?.start : x.kind === "handover" ? meetings?.end : undefined);
  const said = (x: HourSlot) => (x.kind === "meeting" ? h.meet?.start : x.kind === "handover" ? h.meet?.end : undefined);
  const titleOf = (x: HourSlot) => said(x)?.title || SLOT_LABEL[x.kind];
  // Meetings taken off the log: listed under it, to put back.
  const skipped = new Set([...(h.notes?.skip ?? []), ...(h.meet?.off ?? [])]);
  const removed = h.slots.filter((x) => skipped.has(x.key));
  const run = async (f: () => Promise<void>) => {
    try { await f(); setMsg(null); } catch (e) { setMsg((e as Error).message); }
  };
  // Off: on the meeting's own record (one meeting, both shifts' logs).
  // Back: there, and any earlier mark on this shift's notes.
  const setOff = (slot: HourSlot, off: boolean) => run(async () => {
    const m = meetingOf(slot);
    if (m) await m.save((r) => ({ ...r, meeting: { ...(r.meeting ?? {}), off: off || undefined } }));
    if ((!m && off) || (!off && h.notes?.skip?.includes(slot.key))) {
      await h.update((cur) => {
        const base: HourlyNotes = cur?.v === 2 ? cur : { v: 2, lines: typedLines(cur) };
        const next = new Set(base.skip ?? []);
        if (off) next.add(slot.key); else next.delete(slot.key);
        return { ...base, v: 2, skip: [...next] };
      });
    }
  });

  // An hour as typed: what the person added is kept; the work order's
  // own lines stay live (one taken out or reworded stays out until it
  // changes on the work order). Null, or nothing of theirs: the entries.
  const setHour = (slot: HourSlot, text: string | null, auto: string[] = [], said = "") => {
    setEditing(null);
    const mine = text == null ? null : typedHour(text, auto);
    return run(() => h.update((cur) => {
      const rest = typedLines(cur).filter((l) => slotOf(l.at, h.slots).key !== slot.key);
      return { ...(cur?.v === 2 ? cur : {}), v: 2, lines: mine ? [...rest, { id: newId(), at: slot.start, text: mine.extras.join("\n"), hand: true, own: true, hide: mine.hide, src: said }] : rest };
    }));
  };
  // A typed work order line that isn't on the work order now: taken out,
  // or the hour kept as it reads.
  const dropLine = (r: HourlyRow, x: string) => setHour(r.slot, [...r.lines.filter((l) => l !== x), ...r.progress].join("\n"), r.auto, r.said);
  const keepHour = (r: HourlyRow) => setHour(r.slot, [...r.lines, ...r.progress].join("\n"), r.auto, r.said);
  // The meeting's notes, on its record (what was typed before, folded in).
  const setMeetingNote = (m: MeetingCtx, text: string) => {
    setEditing(null);
    const t = text.split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
    return run(() => m.save((r) => ({
      ...r,
      meeting: { ...(r.meeting ?? {}), note: t || undefined },
      // Typed on the shift's notes before it had its own place: moved here.
      ...(r.hourly && earlierMeetingLines(r, m.shiftStart).length ? { hourly: { ...r.hourly, v: 2 as const, lines: typedLines(r.hourly).filter((l) => l.at >= m.shiftStart) } } : {}),
    })));
  };
  const noteOf = (m: MeetingCtx) => [...earlierMeetingLines(m.record, m.shiftStart), ...(m.record?.meeting?.note ?? "").split("\n").map((x) => x.trim()).filter(Boolean)];

  if (print) {
    return (
      <table className="w-full text-[8.5pt] border-collapse">
        <tbody>
          {rows.map((r, i) => {
            const m = said(r.slot);
            return (
              <tr key={r.slot.key} className="align-top">
                <td className="w-16 pr-2 py-0.5 font-semibold whitespace-nowrap">{clocks[i]}</td>
                <td className="py-0.5">
                  {r.slot.kind === "overtime" ? <b>{r.slot.label}</b> : r.slot.kind === "break" ? <span className="text-slate-500">{breakLabel(r.slot)}</span> : m ? <>
                    <b>{m.title}</b>
                    {m.parts && !meetingEmpty(m.parts) ? <MeetingTable p={m.parts} /> : m.lines.length ? m.lines.map((x, j) => <div key={j}>{x}</div>) : <div className="text-slate-500">No attendance entered</div>}
                  </> : <>
                    {SLOT_LABEL[r.slot.kind] && <b>{SLOT_LABEL[r.slot.kind]}</b>}
                    <Items text={r.text} going={r.progress} closed={r.closed} />
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
          const m = meetingOf(r.slot);
          const isMeeting = r.slot.kind === "meeting" || r.slot.kind === "handover";
          const label = isMeeting ? titleOf(r.slot) : SLOT_LABEL[r.slot.kind];
          // A break: its own quiet row, blocked off.
          // A crew held over: the overtime starts, and when it was sent home.
          if (r.slot.kind === "overtime") {
            const head = r.slot.key === "ot";
            const ot = h.overtime;
            return (
              <li key={r.slot.key} className="flex items-start gap-2 px-3 py-1.5 text-[12.5px] leading-snug bg-[var(--color-surface-2)]">
                <span className="w-[66px] shrink-0 font-bold text-[var(--color-text)] whitespace-nowrap tabular-nums">{clocks[i]}</span>
                <span className="min-w-0 flex-1 font-bold text-[var(--color-text)]">{r.slot.label}</span>
                {head && edit && ot && otForm == null && (
                  <span className="flex items-center gap-1">
                    {ot.list.some((x) => x.until == null) && (
                      <button type="button" onClick={() => setOtForm("send")} className="shrink-0 inline-flex items-center h-6 px-2 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-bold">Sent home</button>
                    )}
                    <button type="button" onClick={() => setOtForm("edit")} aria-label="Change the overtime" className={iconBtn}><Pencil className="w-3.5 h-3.5" /></button>
                  </span>
                )}
              </li>
            );
          }
          if (r.slot.kind === "break") {
            // Its hour had nothing in it: the break stands for it, and the
            // hour can still be typed into or have work added.
            const hr = r.hour;
            return (
              <li key={r.slot.key} className="flex items-start gap-2 px-3 py-1 text-[12px] leading-snug bg-[var(--color-surface-2)]/60">
                <span className="w-[66px] shrink-0 font-bold text-[var(--color-text-muted)] whitespace-nowrap tabular-nums">{clocks[i]}</span>
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-[var(--color-text-muted)]">{breakLabel(r.slot)}</span>
                  {hr && editing === hr.key && (
                    <HourForm init="" placeholder="What happened this hour" onDone={(t) => void setHour(hr, t)} onCancel={() => setEditing(null)} />
                  )}
                </div>
                {hr && editing !== hr.key && (
                  <div className="flex items-center justify-end gap-1">
                    {h.onAddWork && (
                      <button type="button" onClick={() => h.onAddWork?.(hr.start)} aria-label={`Add discovery or added scope at ${clocks[i]}`}
                        title="Add discovery or added scope at this hour - it goes into the schedule"
                        className="shrink-0 inline-flex items-center gap-0.5 h-6 px-1.5 rounded-md border border-dashed border-[var(--color-accent)] text-[11px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
                        <Plus className="w-3 h-3" /> Add work
                      </button>
                    )}
                    {edit && (
                      <button type="button" onClick={() => setEditing(hr.key)} aria-label={`Edit ${clocks[i]}`} className={iconBtn}>
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          }
          const note = m ? noteOf(m) : [];
          return (
            <li key={r.slot.key} className={`grid grid-cols-[66px_minmax(0,1fr)_auto] max-sm:grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-0.5 px-3 py-1.5 text-[12.5px] leading-snug ${isMeeting ? "bg-[var(--color-surface-2)]/30" : ""}`}>
              <span className="font-bold text-[var(--color-text)] whitespace-nowrap tabular-nums">{clocks[i]}{isMeeting && <span className="sm:hidden font-bold"> {label}</span>}</span>
              {/* On a phone the time and its buttons share a line; what happened gets the full width under them. */}
              <div className="min-w-0 max-sm:order-last max-sm:col-span-2">
                {label && <div className={`font-bold text-[var(--color-text)] ${isMeeting ? "max-sm:hidden" : ""}`}>{label}</div>}
                {isMeeting && m && <MeetingBox m={m} edit={edit} />}
                {isMeeting && !m && (said(r.slot)?.lines ?? []).map((x, j) => <div key={j} className="break-words text-[var(--color-text)]">{x}</div>)}
                {editing === r.slot.key ? (
                  <HourForm init={isMeeting ? note.join("\n") : [...r.lines, ...r.progress].join("\n")} placeholder={isMeeting ? "Anything else from the meeting" : "What happened this hour"}
                    onDone={(t) => void (m ? setMeetingNote(m, t) : setHour(r.slot, t, r.auto, r.said))} onCancel={() => setEditing(null)} />
                ) : isMeeting ? (
                  note.length ? <div className="mt-1 space-y-0.5">{note.map((x, j) => <div key={j} className="break-words text-[var(--color-text)]">{x}</div>)}</div> : null
                ) : (
                  <Items text={r.text} going={r.progress} closed={r.closed} />
                )}
                {/* A work order line typed here no longer matches the work order
                    (a time fixed, an entry moved or changed): say so, one tap to
                    bring it up to date (what they added stays). */}
                {edit && r.typed && r.stale && editing !== r.slot.key && (
                  <div role="status" className="mt-1 space-y-1 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-2 py-1 text-[11.5px] text-amber-900 dark:text-amber-100">
                    <div className="font-semibold">Typed here, not on the work order now:</div>
                    {(r.mismatch ?? []).map((x) => (
                      <div key={x} className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 break-words italic"><Line text={x} /></span>
                        <button type="button" onClick={() => void dropLine(r, x)} className="shrink-0 font-bold text-rose-700 dark:text-rose-400 hover:underline">Remove</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => void keepHour(r)} className="font-semibold hover:underline">Keep as typed</button>
                  </div>
                )}
                {/* A typed note: a mistake, or now put in as work (its own entry
                    says it) - deleted, the hour shows its entries again. */}
                {edit && typed && editing !== r.slot.key && !isMeeting && (
                  <button type="button" onClick={() => void setHour(r.slot, null)} title="Delete what was typed here - the hour shows its entries"
                    className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 dark:text-rose-400 hover:underline">
                    <Trash2 className="w-3 h-3" /> Delete typed note
                  </button>
                )}
              </div>
              <div className="flex items-center justify-end gap-1">
              {h.onAddWork && editing !== r.slot.key && !isMeeting && (
                <button type="button" onClick={() => h.onAddWork?.(r.slot.start)} aria-label={`Add discovery or added scope at ${clocks[i]}`}
                  title="Add discovery or added scope at this hour - it goes into the schedule"
                  className="shrink-0 inline-flex items-center gap-0.5 h-6 px-1.5 rounded-md border border-dashed border-[var(--color-accent)] text-[11px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
                  <Plus className="w-3 h-3" /> Add work
                </button>
              )}
              {edit && editing !== r.slot.key && isMeeting && (
                <button type="button" onClick={() => void setOff(r.slot, true)} aria-label={`Remove the ${label.toLowerCase()} from the log`}
                  title="Wasn't held: take it off the log (it can be put back)"
                  className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              {edit && editing !== r.slot.key && (!isMeeting || m) && (
                <button type="button" onClick={() => setEditing(r.slot.key)} aria-label={isMeeting ? `Notes from the ${label.toLowerCase()}` : `Edit ${clocks[i]}`}
                  title={isMeeting ? "Anything else from the meeting" : undefined} className={iconBtn}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
              </div>
            </li>
          );
        })}
      </ul>
      {/* Keeping a crew on past the end of the shift (overtime). */}
      {edit && h.overtime && (otForm === "send"
        ? <SentHomeForm ot={h.overtime} onDone={() => setOtForm(null)} onError={setMsg} />
        : otForm === "edit" || otForm === "new"
          ? <HoldOverForm ot={h.overtime} adding={otForm === "new"} onDone={() => setOtForm(null)} onError={setMsg} />
          : !h.overtime.list.length && (
            <button type="button" onClick={() => setOtForm("new")}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-dashed border-[var(--color-accent)] text-[11.5px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
              <Plus className="w-3.5 h-3.5" /> Hold a crew over (overtime)
            </button>
          ))}
      {removed.length > 0 && (
        <div className="text-[11.5px] text-[var(--color-text-muted)]">
          Taken off the log: {removed.map((x, i) => (
            <span key={x.key}>{i > 0 ? ", " : ""}{titleOf(x) || "Hour"}{edit && <button type="button" onClick={() => void setOff(x, false)} className="ml-1 font-semibold text-[var(--color-accent)] hover:underline">Put back</button>}</span>
          ))}
        </div>
      )}
      {msg && <div role="alert" className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
    </div>
  );
}

type OtCtx = NonNullable<HourlyCtx["overtime"]>;
/** "21:30" in plant time. */
const hmOf = (ms: number, tz: string) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
const selCls = "h-7 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[12px] text-[var(--color-text)]";

/** A crew held over: which crew, how many, who or why, sent home when
 *  (or still on), and who takes over after. */
function HoldOverForm({ ot, adding, onDone, onError }: { ot: OtCtx; adding: boolean; onDone: () => void; onError: (m: string | null) => void }) {
  type Row = { id: string; crew: string; hands: string; note: string; until: string; takeover: string };
  const toRow = (x: HoldOver): Row => ({ id: x.id, crew: x.crew, hands: x.hands != null ? String(x.hands) : "", note: x.note ?? "", until: x.until != null ? hmOf(x.until, ot.tz) : "", takeover: x.takeover ?? "" });
  const blank = (): Row => ({ id: newId(), crew: ot.crews[0] ?? "", hands: "", note: "", until: "", takeover: "" });
  const [rows, setRows] = useState<Row[]>(() => [...ot.list.map(toRow), ...(adding || !ot.list.length ? [blank()] : [])]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (i: number, v: Partial<Row>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...v } : x)));
  const save = async () => {
    const out: HoldOver[] = [];
    for (const x of rows) {
      if (!x.crew.trim()) { setErr("Pick the crew held over."); return; }
      const until = x.until ? timeAfter(ot.shiftEnd, x.until, ot.tz, timeOnDay, dayKey) : null;
      if (x.until && (until == null || until > ot.cap)) { setErr("Sent home: a time before the next shift ends."); return; }
      const was = ot.list.find((y) => y.id === x.id);
      out.push({ id: x.id, crew: x.crew.trim(), hands: x.hands ? Math.max(0, Math.round(Number(x.hands))) : null, note: x.note.trim() || undefined, until, takeover: x.takeover || null, at: was?.at ?? Date.now(), by: was?.by ?? null });
    }
    setBusy(true);
    try { await ot.save(() => out); onError(null); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-2 space-y-2 text-[12px]">
      <div className="font-bold text-[var(--color-text)]">Crew held over past the end of the shift</div>
      {rows.map((x, i) => (
        <div key={x.id} className="flex flex-wrap items-center gap-1.5">
          <select value={x.crew} onChange={(e) => set(i, { crew: e.target.value })} aria-label="Crew held over" className={`${selCls} max-w-[12rem]`}>
            {!ot.crews.includes(x.crew) && x.crew && <option value={x.crew}>{x.crew}</option>}
            {ot.crews.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input value={x.hands} onChange={(e) => set(i, { hands: e.target.value.replace(/[^0-9]/g, "").slice(0, 3) })} inputMode="numeric" placeholder="Hands" aria-label="How many held over" className={`${inputCls} h-7 w-16`} />
          <input value={x.note} onChange={(e) => set(i, { note: e.target.value })} placeholder="Who or why (Exchanger hands only)" aria-label="Who or why" className={`${inputCls} h-7 flex-1 min-w-[10rem]`} />
          <span className="inline-flex items-center gap-1">
            <span className="text-[11px] text-[var(--color-text-muted)]">Sent home</span>
            <TimeChip value={x.until} onChange={(v) => set(i, { until: v })} tz={ot.tz} label="Sent home at" />
            {x.until && <button type="button" onClick={() => set(i, { until: "" })} className="text-[11px] text-[var(--color-text-muted)] hover:underline">Still on</button>}
          </span>
          <select value={x.takeover} onChange={(e) => set(i, { takeover: e.target.value })} aria-label="Takes over after" className={`${selCls} max-w-[15rem]`}>
            <option value="">No one takes over</option>
            {ot.crews.map((c) => <option key={c} value={c}>{c} takes over</option>)}
          </select>
          <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Take ${x.crew || "this crew"} off overtime`} className="p-1 rounded text-[var(--color-text-muted)] hover:text-rose-700"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, blank()])} className="text-[11px] font-semibold text-[var(--color-accent)] hover:underline">+ Another crew</button>
      {err && <div role="alert" className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void save()} className={`${btn} bg-[var(--color-accent)] text-[var(--color-accent-fg)]`}>Save</button>
        <button type="button" onClick={onDone} className="text-[11.5px] text-[var(--color-text-muted)] hover:underline">Cancel</button>
      </div>
    </div>
  );
}

/** The crew held over goes home: when, and who takes over after. */
function SentHomeForm({ ot, onDone, onError }: { ot: OtCtx; onDone: () => void; onError: (m: string | null) => void }) {
  const [at, setAt] = useState(() => hmOf(Math.min(Date.now(), ot.cap), ot.tz));
  const [takeover, setTakeover] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const t = timeAfter(ot.shiftEnd, at, ot.tz, timeOnDay, dayKey);
    if (t == null || t > ot.cap) { setErr("A time before the next shift ends."); return; }
    try {
      await ot.save((l) => l.map((x) => (x.until == null ? { ...x, until: t, takeover: takeover || x.takeover || null } : x)));
      onError(null); onDone();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-2 flex flex-wrap items-center gap-1.5 text-[12px]">
      <b className="text-[var(--color-text)]">Sent home at</b>
      <TimeChip value={at} onChange={setAt} tz={ot.tz} label="Sent home at" />
      <select value={takeover} onChange={(e) => setTakeover(e.target.value)} aria-label="Takes over after" className={`${selCls} max-w-[14rem]`}>
        <option value="">No one takes over</option>
        {ot.crews.map((c) => <option key={c} value={c}>{c} takes over</option>)}
      </select>
      <button type="button" onClick={() => void save()} className={`${btn} bg-[var(--color-accent)] text-[var(--color-accent-fg)]`}>Save</button>
      <button type="button" onClick={onDone} className="text-[11.5px] text-[var(--color-text-muted)] hover:underline">Cancel</button>
      {err && <div role="alert" className="w-full text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{err}</div>}
    </div>
  );
}

/** A meeting on paper: resource, meeting attendees, on site; the
 *  total; then the safety topic and notes. */
function MeetingTable({ p }: { p: MeetingParts }) {
  return (
    <>
      {p.rows.length > 0 && (
        <table className="w-full border-collapse my-[2pt]">
          <thead><tr className="text-[7pt] uppercase text-slate-500 text-left"><th className="font-bold pr-2">Resource</th><th className="font-bold pr-2">Meeting attendees</th><th className="font-bold text-right">On site</th></tr></thead>
          <tbody>
            {p.rows.map((x) => <tr key={x.crew} className="border-t border-slate-200"><td className="font-semibold pr-2">{x.crew}</td><td className="pr-2">{x.attendees || "-"}</td><td className={`text-right ${x.plant ? "" : "font-semibold"}`}>{onSiteCell(x)}</td></tr>)}
            {p.total != null && <tr className="border-t border-slate-300"><td className="font-bold pr-2">Total on the job</td><td /><td className="text-right font-bold">{p.total}</td></tr>}
          </tbody>
        </table>
      )}
      {p.safety && <div><b>Safety topic:</b> {p.safety}</div>}
      {p.notes.map((x, j) => <div key={j}>{x}</div>)}
    </>
  );
}

/** A line with its work order in bold. */
function Line({ text }: { text: string }) {
  return <>{boldRuns(text).map((r, i) => (r.b ? <b key={i} className="font-bold">{r.t}</b> : <React.Fragment key={i}>{r.t}</React.Fragment>))}</>;
}

/** An hour's lines, one item each: what started, finished or was held
 *  (the one that finished a whole work order in green), then (in the
 *  progress color) what moved its % that hour. */
function Items({ text, going, closed }: { text: string; going: string[]; closed: string[] }) {
  const items = text.split("\n").map((x) => x.trim()).filter(Boolean);
  // An hour with nothing in it: left blank.
  if (!items.length && !going.length) return null;
  return (
    <ul className="space-y-0.5">
      {/* A line that finished a whole work order: quiet green. */}
      {items.map((x, i) => (closed.includes(x)
        ? <li key={i} className="break-words text-emerald-700 dark:text-emerald-400 print:text-emerald-800" title="Work order complete"><Line text={x} /></li>
        : <li key={i} className="break-words text-[var(--color-text)]"><Line text={x} /></li>))}
      {going.map((x, i) => <li key={`g${i}`} className="break-words text-[var(--color-text-muted)]"><Line text={x} /></li>)}
    </ul>
  );
}

/** The meeting: each crew, who attended (a name each, added sideways) and
 *  its head count on site; the total; then the safety topic. */
function MeetingBox({ m, edit }: { m: MeetingCtx; edit: boolean }) {
  const [msg, setMsg] = useState<string | null>(null);
  const crews = m.record?.crews ?? {};
  // The crews on the plan, then any added at the meeting.
  const list = [...m.crews, ...Object.keys(crews).filter((k) => !m.crews.includes(k))];
  // Plant staff (not on the job) aren't counted.
  const total = totalOnSite(list.map((c) => ({ headcount: crews[c]?.headcount ?? null, plant: !!crews[c]?.plant })));
  const save = (change: (r: ShiftRecord) => ShiftRecord) => m.save(change).then(() => setMsg(null), (e: Error) => { setMsg(e.message); throw e; });
  // A change makes the crews this shift's own: the carried ones first, then the change.
  const own = (r: ShiftRecord): ShiftRecord => ({ ...r, crews: hasOwnRoster(r) ? r.crews ?? {} : { ...(m.carried?.crews ?? {}) }, meeting: { ...(r.meeting ?? {}), ownCrews: true } });
  const setCrew = (crew: string, f: (c: CrewCount | undefined) => CrewCount | null) => save((r) => {
    const base = own(r);
    const cs = { ...(base.crews ?? {}) };
    const v = f(cs[crew]);
    if (v) cs[crew] = v; else delete cs[crew];
    return { ...base, crews: cs };
  });
  const entered = list.some((c) => crewNames(crews[c]).length || crews[c]?.headcount != null || crews[c]?.plant);
  const grid = "grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(5.5rem,9.5rem)_minmax(0,1fr)_auto] gap-x-2";
  return (
    <div className="mt-1 space-y-1">
      {/* Carried from the last same shift until someone changes or checks it. */}
      {m.carried ? (
        <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-2 py-1 text-[11.5px] text-amber-900 dark:text-amber-100">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1"><b>Not updated for this shift.</b> Same people and head counts as {m.carried.label}{edit ? ": change anyone who's different." : "."}</span>
          {edit && (
            <button type="button" onClick={() => void save(own).catch(() => undefined)}
              className="shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold">
              <Check className="w-3.5 h-3.5" /> Looks right
            </button>
          )}
        </div>
      ) : edit && entered ? (
        <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400"><Check className="w-3.5 h-3.5" aria-hidden /> Updated for this shift</div>
      ) : null}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className={`${grid} px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]`}>
          <span className="max-sm:hidden">Resource</span><span>Meeting attendees</span><span className="w-14 text-right">On site</span>
        </div>
        {list.length === 0 && <div className="px-2 py-1 text-[12px] italic text-[var(--color-text-muted)]">No crews on the plan{edit ? " - add a company below" : ""}</div>}
        {list.map((crew) => (
          <CrewRow key={crew} grid={grid} crew={crew} value={crews[crew]} known={m.known?.[crew]} edit={edit}
            onNames={(f) => setCrew(crew, (c) => setNames(c, f))}
            onCount={(n) => void setCrew(crew, (c) => ({ ...(c ?? {}), headcount: n })).catch(() => undefined)}
            onPlant={(on) => void setCrew(crew, (c) => ({ ...(c ?? {}), plant: on || undefined, ...(on ? { headcount: null } : {}) })).catch(() => undefined)}
            onRemove={m.crews.includes(crew) ? undefined : () => void setCrew(crew, () => null).catch(() => undefined)} />
        ))}
        {(edit || (total != null && list.length > 1)) && (
          <div className={`${grid} items-center px-2 py-1 border-t border-[var(--color-border)]`}>
            <span className="min-w-0 sm:col-span-2">{edit && <AddCompany onAdd={(name) => void setCrew(cleanName(name), (c) => c ?? {}).catch(() => undefined)} />}</span>
            <span className="text-right text-[12px] tabular-nums whitespace-nowrap">{total != null && <><span className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Total on the job </span><b>{total}</b></>}</span>
          </div>
        )}
      </div>
      <SafetyTopic value={m.record?.meeting?.safety} topics={m.topics} edit={edit}
        onSave={(t) => void save((r) => ({ ...r, meeting: { ...(r.meeting ?? {}), safety: t || undefined } })).catch(() => undefined)} />
      {msg && <div role="alert" className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
    </div>
  );
}

let opSeq = 0;

/** One crew at the meeting: its name, a pill for each person there (edit,
 *  remove; + adds the next one beside them), and its head count on site. */
function CrewRow({ grid, crew, value, known, edit, onNames, onCount, onPlant, onRemove }: {
  grid: string; crew: string; value?: CrewCount; known?: string[]; edit: boolean;
  onNames: (change: (names: string[]) => string[]) => Promise<void>;
  onCount: (n: number | null) => void;
  /** Plant staff (not on the job, not counted), or counted again. */
  onPlant: (on: boolean) => void;
  /** A company added at the meeting (not on the plan): off the list. */
  onRemove?: () => void;
}) {
  // What you did shows at once; the saved record catches up a moment later.
  const [ops, setOps] = useState<Array<{ id: number; f: (n: string[]) => string[] }>>([]);
  const [adding, setAdding] = useState(false);
  const listId = useId();
  const names = ops.reduce((a, o) => o.f(a), crewNames(value));
  const change = (f: (n: string[]) => string[]) => {
    const id = ++opSeq;
    setOps((x) => [...x, { id, f }]);
    const drop = () => setOps((x) => x.filter((o) => o.id !== id));
    onNames(f).then(() => { setTimeout(drop, 4000); }, drop);
  };
  const pick = (known ?? []).filter((x) => !names.includes(x));
  return (
    <div className={`${grid} items-start px-2 py-1 border-t border-[var(--color-border)]`}>
      <div className="min-w-0 flex items-center gap-1 pt-0.5 max-sm:col-start-1 max-sm:row-start-1">
        <b className="text-[12px] text-[var(--color-text)] break-words">{crew}</b>
        {edit && onRemove && (
          <button type="button" onClick={onRemove} aria-label={`Take ${crew} off the meeting`} title="Take this company off the meeting"
            className="shrink-0 p-0.5 rounded text-[var(--color-text-faint)] hover:text-rose-700"><XIcon className="w-3 h-3" /></button>
        )}
      </div>
      <div className="min-w-0 flex flex-wrap items-center gap-1 max-sm:col-start-1 max-sm:row-start-2 max-sm:pb-0.5">
        {names.map((n) => (
          <NamePill key={n} name={n} edit={edit} listId={listId}
            onRename={(to) => change((x) => renamed(x, n, to))} onRemove={() => change((x) => withoutName(x, n))} />
        ))}
        {edit && adding && (
          <NameInput init="" listId={listId} label={`Attendee from ${crew}`} keepOpen
            onDone={(v) => { if (v) change((x) => withName(x, v)); }} onClose={() => setAdding(false)} />
        )}
        {edit && !adding && (
          <button type="button" onClick={() => setAdding(true)} aria-label={`Add an attendee from ${crew}`} title="Add an attendee"
            className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full border border-dashed border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
        {!edit && !names.length && <span className="text-[var(--color-text-faint)]">-</span>}
        {edit && <datalist id={listId}>{pick.map((x) => <option key={x} value={x} />)}</datalist>}
      </div>
      <div className="max-sm:col-start-2 max-sm:row-start-1 max-sm:row-span-2">
        <HeadCount crew={crew} value={value?.headcount ?? null} plant={!!value?.plant} edit={edit} onSave={onCount} onPlant={onPlant} />
      </div>
    </div>
  );
}

/** A person at the meeting: their name, a small edit and remove. */
function NamePill({ name, edit, listId, onRename, onRemove }: { name: string; edit: boolean; listId: string; onRename: (to: string) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <NameInput init={name} listId={listId} label={`Change ${name}`} onDone={(v) => { if (v && v !== name) onRename(v); }} onClose={() => setEditing(false)} />;
  }
  return (
    <span className={`inline-flex items-center max-w-full h-6 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[12px] text-[var(--color-text)] ${edit ? "pl-2 pr-0.5" : "px-2"}`}>
      <span className="min-w-0 truncate">{name}</span>
      {edit && (
        <>
          <button type="button" onClick={() => setEditing(true)} aria-label={`Edit ${name}`} className="ml-0.5 shrink-0 p-1 rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]">
            <Pencil className="w-3 h-3" />
          </button>
          <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} className="shrink-0 p-1 rounded-full text-[var(--color-text-muted)] hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40">
            <Trash2 className="w-3 h-3" />
          </button>
        </>
      )}
    </span>
  );
}

/** A name being typed, in the pill's place: Enter keeps it (adding: and
 *  opens the next), Escape leaves it as it was. */
function NameInput({ init, listId, label, keepOpen, onDone, onClose }: {
  init: string; listId: string; label: string; keepOpen?: boolean; onDone: (v: string) => void; onClose: () => void;
}) {
  const [v, setV] = useState(init);
  const done = useRef(false);
  const finish = (close: boolean) => {
    const n = cleanName(v);
    if (n) onDone(n);
    if (keepOpen && !close && n) { setV(""); return; }
    done.current = true;
    onClose();
  };
  return (
    <input autoFocus value={v} list={listId} aria-label={label} placeholder="Name"
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(false); }
        if (e.key === "Escape") { done.current = true; onClose(); }
      }}
      onBlur={() => { if (!done.current) finish(true); }}
      className="h-6 w-36 max-w-full rounded-full border border-[var(--color-accent-ring)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none" />
  );
}

/** A crew's head count on site: saved when you leave the box. */
function HeadCount({ crew, value, plant, edit, onSave, onPlant }: { crew: string; value: number | null; plant: boolean; edit: boolean; onSave: (n: number | null) => void; onPlant: (on: boolean) => void }) {
  const [typed, setTyped] = useState<string | null>(null);
  const sent = useRef<number | null | undefined>(undefined);
  if (!edit) return <span className={`block text-right text-[12.5px] tabular-nums whitespace-nowrap ${plant ? "text-[var(--color-text-muted)]" : "w-14 font-bold text-[var(--color-text)]"}`}>{plant ? "Plant staff" : value ?? "-"}</span>;
  // Plant staff: at the meeting, not on the job, not counted. Tap to count them.
  if (plant) {
    return (
      <button type="button" onClick={() => onPlant(false)} aria-pressed title="Plant staff: not on the job, not counted. Tap to count them."
        className="block h-7 px-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[11px] font-semibold text-[var(--color-text-muted)] whitespace-nowrap">
        Plant staff
      </button>
    );
  }
  const commit = () => {
    if (typed == null) return;
    const n = typed.trim() === "" ? null : Math.max(0, Math.round(Number(typed)));
    if (n === (sent.current !== undefined ? sent.current : value)) return;
    sent.current = n;
    onSave(n);
  };
  return (
    <span className="flex flex-col items-end gap-0.5">
      <input value={typed ?? (value != null ? String(value) : "")} inputMode="numeric" aria-label={`${crew} head count on site`}
        placeholder="#"
        onChange={(e) => setTyped(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className={`${inputCls} block w-14 h-7 text-right font-mono`} />
      <button type="button" onClick={() => onPlant(true)} title="At the meeting, not on the job (plant staff): not counted"
        className="text-[10px] text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] hover:underline whitespace-nowrap">Plant staff?</button>
    </span>
  );
}

/** The meeting's safety topic: a small row of its own under the attendance.
 *  The report's topics for the meeting are a tap away. */
function SafetyTopic({ value, topics, edit, onSave }: { value?: string; topics?: string[]; edit: boolean; onSave: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  const t = value?.trim() ?? "";
  const open = () => { setV(t); setEditing(true); };
  const commit = (x: string) => { setEditing(false); if (cleanName(x) !== t) onSave(cleanName(x)); };
  const picks = (topics ?? []).filter((x) => x !== t);
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 py-1 rounded-md border border-dashed border-[var(--color-border)] text-[12px]">
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-orange-800 dark:text-orange-300">Safety topic</span>
      {editing ? (
        <span className="flex-1 min-w-[12rem] flex items-center gap-1.5">
          <input autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-label="Safety topic" placeholder="What the meeting talked through"
            onKeyDown={(e) => { if (e.key === "Enter") commit(v); if (e.key === "Escape") setEditing(false); }}
            className={`${inputCls} flex-1 min-w-0 h-7`} />
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => commit(v)} className={`${btn} h-7 bg-[var(--color-accent)] text-[var(--color-accent-fg)]`}>Save</button>
          <button type="button" onClick={() => setEditing(false)} className="text-[11px] text-[var(--color-text-muted)] hover:underline">Cancel</button>
        </span>
      ) : t ? (
        <>
          <span className="min-w-0 break-words font-semibold text-[var(--color-text)]">{t}</span>
          {edit && (
            <span className="inline-flex items-center">
              <button type="button" onClick={open} aria-label="Edit the safety topic" className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><Pencil className="w-3 h-3" /></button>
              <button type="button" onClick={() => onSave("")} aria-label="Remove the safety topic" className="p-1 rounded text-[var(--color-text-muted)] hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40"><Trash2 className="w-3 h-3" /></button>
            </span>
          )}
        </>
      ) : edit ? (
        <button type="button" onClick={open} aria-label="Add the safety topic" className="inline-flex items-center gap-0.5 h-6 px-1.5 rounded-md border border-dashed border-[var(--color-accent)] text-[11px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
          <Plus className="w-3 h-3" /> Add
        </button>
      ) : <span className="text-[var(--color-text-faint)]">-</span>}
      {edit && !t && picks.length > 0 && (
        <span className="basis-full flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-[var(--color-text-muted)]">From the report:</span>
          {picks.map((x) => (
            <button key={x} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => commit(x)}
              className="max-w-full truncate h-6 px-2 rounded-full border border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/40 text-[11px] font-semibold text-orange-800 dark:text-orange-300 hover:border-orange-500">
              {x}
            </button>
          ))}
        </span>
      )}
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
