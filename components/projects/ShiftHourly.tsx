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
import { Pencil, Plus, Trash2, X as XIcon } from "lucide-react";
import { AddCompany } from "@/components/projects/ShiftRecordParts";
import type { CrewCount, ShiftRecord } from "@/lib/shiftRecord";
import { newId } from "@/lib/shiftRecord";
import type { TimeLogRow } from "@/lib/timeLog";
import {
  slotClocks, hourlyRows, typedLines, slotOf, SLOT_LABEL, breakLabel, boldRuns, type HourSlot, type HourlyNotes,
} from "@/lib/shiftHourly";
import { cleanName, crewNames, renamed, setNames, totalOnSite, withName, withoutName, earlierMeetingLines } from "@/lib/shiftMeeting";

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
  /** The two meetings as the log says them (lib/shiftMeeting), which are
   *  off the log, and which show before their time. */
  meet?: { start: { title: string; lines: string[] }; end: { title: string; lines: string[] }; off: string[]; show: string[] };
}

/** A meeting to fill in: the crews to list, what's entered, how to save it. */
export interface MeetingCtx {
  /** The crews on the plan for the shift it starts (they stay listed). */
  crews: string[];
  /** The record of the shift it starts (its `crews` and `meeting`). */
  record?: ShiftRecord;
  /** When that shift starts: what was typed before it is the meeting's. */
  shiftStart: number;
  /** The last same shift's attendance: its names to add in one tap. */
  hint?: Record<string, CrewCount>;
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
  const rows = hourlyRows(h.notes, h.slots, h.upTo, h.entries, tz, h.meet);
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

  // An hour as typed: kept as typed (empty puts it back to the entries).
  const setHour = (slot: HourSlot, text: string | null) => {
    setEditing(null);
    return run(() => h.update((cur) => {
      const rest = typedLines(cur).filter((l) => slotOf(l.at, h.slots).key !== slot.key);
      const t = text?.split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
      return { ...(cur?.v === 2 ? cur : {}), v: 2, lines: t ? [...rest, { id: newId(), at: slot.start, text: t, hand: true }] : rest };
    }));
  };
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
                  {r.slot.kind === "break" ? <span className="text-slate-500">{breakLabel(r.slot)}</span> : m ? <>
                    <b>{m.title}</b>
                    {m.lines.length ? m.lines.map((x, j) => <div key={j}>{x}</div>) : <div className="text-slate-500">No attendance entered</div>}
                  </> : <>
                    {SLOT_LABEL[r.slot.kind] && <b>{SLOT_LABEL[r.slot.kind]}</b>}
                    <Items text={r.text} going={r.progress} empty={r.slot.kind === "work"} />
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
          if (r.slot.kind === "break") {
            return (
              <li key={r.slot.key} className="flex items-start gap-2 px-3 py-1 text-[12px] leading-snug bg-[var(--color-surface-2)]/60">
                <span className="w-[66px] shrink-0 font-bold text-[var(--color-text-muted)] whitespace-nowrap tabular-nums">{clocks[i]}</span>
                <span className="font-semibold text-[var(--color-text-muted)]">{breakLabel(r.slot)}</span>
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
                  <HourForm init={isMeeting ? note.join("\n") : r.text} placeholder={isMeeting ? "Anything else from the meeting" : "What happened this hour"}
                    onDone={(t) => void (m ? setMeetingNote(m, t) : setHour(r.slot, t))} onCancel={() => setEditing(null)} />
                ) : isMeeting ? (
                  note.length ? <div className="mt-1 space-y-0.5">{note.map((x, j) => <div key={j} className="break-words text-[var(--color-text)]">{x}</div>)}</div> : null
                ) : (
                  <Items text={r.text} going={r.progress} empty={r.slot.kind === "work"} />
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

/** The meeting: each crew, who attended (a name each, added sideways) and
 *  its head count on site; the total; then the safety topic. */
function MeetingBox({ m, edit }: { m: MeetingCtx; edit: boolean }) {
  const [msg, setMsg] = useState<string | null>(null);
  const crews = m.record?.crews ?? {};
  // The crews on the plan, then any added at the meeting.
  const list = [...m.crews, ...Object.keys(crews).filter((k) => !m.crews.includes(k))];
  const total = totalOnSite(list.map((c) => ({ headcount: crews[c]?.headcount ?? null })));
  const save = (change: (r: ShiftRecord) => ShiftRecord) => m.save(change).then(() => setMsg(null), (e: Error) => { setMsg(e.message); throw e; });
  const setCrew = (crew: string, f: (c: CrewCount | undefined) => CrewCount | null) => save((r) => {
    const cs = { ...(r.crews ?? {}) };
    const v = f(cs[crew]);
    if (v) cs[crew] = v; else delete cs[crew];
    return { ...r, crews: cs };
  });
  const grid = "grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(5.5rem,9.5rem)_minmax(0,1fr)_auto] gap-x-2";
  return (
    <div className="mt-1 space-y-1">
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className={`${grid} px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]`}>
          <span className="max-sm:hidden">Crew</span><span>Attendance</span><span className="w-14 text-right">On site</span>
        </div>
        {list.length === 0 && <div className="px-2 py-1 text-[12px] italic text-[var(--color-text-muted)]">No crews on the plan{edit ? " - add a company below" : ""}</div>}
        {list.map((crew) => (
          <CrewRow key={crew} grid={grid} crew={crew} value={crews[crew]} hint={m.hint?.[crew]} known={m.known?.[crew]} edit={edit}
            onNames={(f) => setCrew(crew, (c) => setNames(c, f))}
            onCount={(n) => void setCrew(crew, (c) => ({ ...(c ?? {}), headcount: n })).catch(() => undefined)}
            onRemove={m.crews.includes(crew) ? undefined : () => void setCrew(crew, () => null).catch(() => undefined)} />
        ))}
        {(edit || (total != null && list.length > 1)) && (
          <div className={`${grid} items-center px-2 py-1 border-t border-[var(--color-border)]`}>
            <span className="min-w-0 sm:col-span-2">{edit && <AddCompany onAdd={(name) => void setCrew(cleanName(name), (c) => c ?? {}).catch(() => undefined)} />}</span>
            <span className="w-14 text-right text-[12px] tabular-nums whitespace-nowrap">{total != null && <><span className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Total </span><b>{total}</b></>}</span>
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
function CrewRow({ grid, crew, value, hint, known, edit, onNames, onCount, onRemove }: {
  grid: string; crew: string; value?: CrewCount; hint?: CrewCount; known?: string[]; edit: boolean;
  onNames: (change: (names: string[]) => string[]) => Promise<void>;
  onCount: (n: number | null) => void;
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
  const last = crewNames(hint).filter((x) => !names.some((n) => n.toLowerCase() === x.toLowerCase()));
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
          <NameInput init="" listId={listId} label={`Name at the meeting from ${crew}`} keepOpen
            onDone={(v) => { if (v) change((x) => withName(x, v)); }} onClose={() => setAdding(false)} />
        )}
        {edit && !adding && (
          <button type="button" onClick={() => setAdding(true)} aria-label={`Add a name from ${crew}`} title="Add a name"
            className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full border border-dashed border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
        {edit && !names.length && !adding && last.length > 0 && (
          <button type="button" onClick={() => change((x) => last.reduce(withName, x))} title="Same people as the last time this shift met"
            className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-accent)] hover:underline">
            Last time: {last.join(", ")}
          </button>
        )}
        {!edit && !names.length && <span className="text-[var(--color-text-faint)]">-</span>}
        {edit && <datalist id={listId}>{pick.map((x) => <option key={x} value={x} />)}</datalist>}
      </div>
      <div className="max-sm:col-start-2 max-sm:row-start-1 max-sm:row-span-2">
        <HeadCount crew={crew} value={value?.headcount ?? null} hint={hint?.headcount ?? null} edit={edit} onSave={onCount} />
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

/** A crew's head count on site: saved when you leave the box. The last
 *  same shift's count shows greyed until typed over. */
function HeadCount({ crew, value, hint, edit, onSave }: { crew: string; value: number | null; hint: number | null; edit: boolean; onSave: (n: number | null) => void }) {
  const [typed, setTyped] = useState<string | null>(null);
  const sent = useRef<number | null | undefined>(undefined);
  if (!edit) return <span className="block w-14 text-right text-[12.5px] font-bold tabular-nums text-[var(--color-text)]">{value ?? "-"}</span>;
  const commit = () => {
    if (typed == null) return;
    const n = typed.trim() === "" ? null : Math.max(0, Math.round(Number(typed)));
    if (n === (sent.current !== undefined ? sent.current : value)) return;
    sent.current = n;
    onSave(n);
  };
  return (
    <input value={typed ?? (value != null ? String(value) : "")} inputMode="numeric" aria-label={`${crew} head count on site`}
      placeholder={hint != null ? String(hint) : "#"}
      onChange={(e) => setTyped(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className={`${inputCls} block w-14 h-7 text-right font-mono`} />
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
