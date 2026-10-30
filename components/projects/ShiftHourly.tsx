"use client";

// Shift notes, hour by hour — on the turnover report. The shift's meeting
// (who attended: each crew's supervisor and head count), the first hour —
// start of shift, permitting — then each hour to the end, written from the
// shift's own entries in that hour (lib/shiftHourly) whenever the report is
// open and they've changed. Any hour can be typed over; that one is then
// kept as typed.

import React, { useEffect, useRef, useState } from "react";
import { Loader2, Pencil, RotateCcw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { CrewCountEditor, AddCompany } from "@/components/projects/ShiftRecordParts";
import { crewLine } from "@/lib/managementUpdate";
import type { CrewCount } from "@/lib/shiftRecord";
import { newId } from "@/lib/shiftRecord";
import type { TimeLogRow } from "@/lib/timeLog";
import {
  hourlyClocks, hourlyPrompt, hourlyRows, hoursToWrite, linesBySlot, liveLines, parseHourly, rowsBySlot, slotOf, wordHours,
  SLOT_LABEL, type HourSlot, type HourlyLine, type HourlyNotes,
} from "@/lib/shiftHourly";

const inputCls = "rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1 text-[12.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent-ring)]";
const btn = "inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[12px] font-bold disabled:opacity-60";

export interface HourlyCtx {
  notes?: HourlyNotes;
  /** Change the notes as saved now (read fresh, so nothing typed meanwhile is lost). */
  update: (change: (cur: HourlyNotes | undefined) => HourlyNotes | null) => Promise<void>;
  /** The shift's entries (the time log for its window). */
  rows: () => Promise<TimeLogRow[]>;
  orgId: string;
  projectId: string;
  by: string | null;
  shiftTitle: string;
  window: string;
  /** The shift by the hour (lib/shiftHourly hourSlots). */
  slots: HourSlot[];
  /** Up to when the hours show: now, or the shift's end. */
  upTo: number;
  /** Being written now. */
  busy?: boolean;
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

/** Keeps the shift's hours written: on opening the report and whenever its
 *  entries change, the hours whose entries changed (and nobody typed over)
 *  are written again; hours said plainly last time are worded once more. */
export function useAutoHourly(h: HourlyCtx | undefined, on: boolean, tz: string): boolean {
  const [busy, setBusy] = useState(false);
  const notes = useRef<HourlyNotes | undefined>(undefined);
  const tried = useRef(new Set<string>());
  const running = useRef(false);
  // A change while it was writing: once more when it's done.
  const again = useRef(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { notes.current = h?.notes; }, [h?.notes]);
  const rows = h?.rows;
  const update = h?.update;
  const slots = h?.slots;
  const orgId = h?.orgId, projectId = h?.projectId, shiftTitle = h?.shiftTitle ?? "", win = h?.window ?? "", by = h?.by ?? null;
  useEffect(() => {
    if (!on || !rows || !update || !slots?.length || !orgId || !projectId) return;
    if (running.current) { again.current = true; return; }
    const meta = { orgId, projectId, shiftTitle, window: win, by };
    let alive = true;
    void (async () => {
      running.current = true;
      try {
        const entries = rowsBySlot(await rows(), slots);
        const have = linesBySlot(notes.current, slots);
        const due = hoursToWrite(slots, entries, have, tz, true);
        // Worded once per visit: an hour said plainly isn't asked again until its entries change.
        const write = due.write.filter((w) => !(tried.current.has(`${w.slot.key}:${w.src}`) && (have.get(w.slot.key)?.length ?? 0) > 0));
        const clear = due.clear;
        if (!write.length && !clear.length) return;
        for (const w of write) tried.current.add(`${w.slot.key}:${w.src}`);
        if (alive) setBusy(true);
        let answer: Array<{ time: string; text: string }> = [];
        let model: string | undefined;
        if (write.length) {
          try {
            const { data } = await supabase.auth.getSession();
            const res = await fetch("/api/projects/shift-notes", {
              method: "POST",
              headers: { "content-type": "application/json", ...(data.session?.access_token ? { authorization: `Bearer ${data.session.access_token}` } : {}) },
              body: JSON.stringify({ orgId: meta.orgId, projectId: meta.projectId, prompt: hourlyPrompt(write, { tz, shiftTitle: meta.shiftTitle, window: meta.window }) }),
            });
            const out = await res.json().catch(() => null) as { text?: string; model?: string } | null;
            if (res.ok && out?.text) { answer = parseHourly(out.text); model = out.model; }
          } catch { /* said plainly below */ }
        }
        const worded = wordHours(answer, write, tz);
        const redo = new Set([...write.map((w) => w.slot.key), ...clear]);
        await update((cur) => {
          // Onto the notes as they are now: an hour typed meanwhile stays.
          const keep = liveLines(cur).filter((l) => l.hand || !redo.has(slotOf(l.at, slots).key));
          const typed = new Set(keep.filter((l) => l.hand).map((l) => slotOf(l.at, slots).key));
          const added: HourlyLine[] = write.filter((w) => !typed.has(w.slot.key)).map((w) => {
            const x = worded.get(w.slot.key)!;
            return { id: newId(), at: w.slot.start, text: x.text, src: w.src, ...(x.plain ? { plain: true } : {}) };
          });
          return { v: 2, lines: [...keep, ...added], model: model ?? cur?.model, madeAt: Date.now(), madeBy: meta.by };
        });
      } catch { /* the hours stay as they were; tried again on the next change */ }
      finally {
        running.current = false;
        setBusy(false);
        if (again.current) { again.current = false; setTick((t) => t + 1); }
      }
    })();
    return () => { alive = false; };
  }, [on, rows, update, slots, tz, orgId, projectId, shiftTitle, win, by, tick]);
  return busy;
}

export function ShiftHourlyBox({ h, edit, print, tz, meeting }: {
  h: HourlyCtx; edit: boolean; print: boolean; tz: string; meeting?: MeetingCrews;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const rows = hourlyRows(h.notes, h.slots, h.upTo);
  const clocks = hourlyClocks(rows.map((r) => r.slot.start), tz);

  // An hour as typed: kept as typed (empty puts it back to the entries).
  const setHour = async (slot: HourSlot, text: string | null) => {
    setEditing(null);
    try {
      await h.update((cur) => {
        const rest = liveLines(cur).filter((l) => slotOf(l.at, h.slots).key !== slot.key);
        const t = text?.replace(/\s+/g, " ").trim();
        return { ...(cur?.v === 2 ? cur : {}), v: 2, lines: t ? [...rest, { id: newId(), at: slot.start, text: t, hand: true }] : rest };
      });
      setMsg(null);
    } catch (e) { setMsg((e as Error).message); }
  };

  if (print) {
    return (
      <table className="w-full text-[8.5pt] border-collapse">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.slot.key} className="align-top">
              <td className="w-16 pr-2 py-0.5 font-semibold whitespace-nowrap">{clocks[i]}</td>
              <td className="py-0.5">
                {SLOT_LABEL[r.slot.kind] && <b>{SLOT_LABEL[r.slot.kind]}{r.slot.kind === "meeting" ? " - " : r.text ? ". " : ""}</b>}
                {r.slot.kind === "meeting" ? meetingLine(meeting, r.text) || "-" : r.text || (r.slot.kind === "work" ? "-" : "")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="space-y-1.5">
      {h.busy && (
        <div className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]"><Loader2 className="w-3 h-3 animate-spin" /> Updating…</div>
      )}
      <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
        {rows.map((r, i) => {
          const typed = r.lines.some((l) => l.hand);
          const label = SLOT_LABEL[r.slot.kind];
          return (
            <li key={r.slot.key} className="flex items-start gap-2 px-3 py-1.5 text-[12.5px] leading-snug">
              <span className="w-[66px] shrink-0 font-bold text-[var(--color-text)] whitespace-nowrap tabular-nums">{clocks[i]}</span>
              <div className="min-w-0 flex-1">
                {label && <div className="font-bold text-[var(--color-text)]">{label}</div>}
                {r.slot.kind === "meeting" && (
                  <MeetingBox meeting={meeting} edit={edit} />
                )}
                {editing === r.slot.key ? (
                  <HourForm init={r.text} placeholder={r.slot.kind === "meeting" ? "Anything from the meeting" : "What happened this hour"}
                    onDone={(t) => void setHour(r.slot, t)} onCancel={() => setEditing(null)} />
                ) : r.text ? (
                  <div className="break-words text-[var(--color-text)]">{r.text}</div>
                ) : r.slot.kind === "work" ? (
                  <div className="text-[var(--color-text-faint)]">-</div>
                ) : null}
                {edit && typed && editing !== r.slot.key && r.slot.kind !== "meeting" && (
                  <button type="button" onClick={() => void setHour(r.slot, null)}
                    className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline">
                    <RotateCcw className="w-3 h-3" /> Write it from the entries again
                  </button>
                )}
              </div>
              {edit && editing !== r.slot.key && (
                <button type="button" onClick={() => setEditing(r.slot.key)} aria-label={`Edit ${clocks[i]}`}
                  className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {msg && <div role="alert" className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
    </div>
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
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label={placeholder} placeholder={placeholder} autoFocus
        className={`${inputCls} w-full resize-y`} />
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onDone(text)} className={`${btn} bg-[var(--color-accent)] text-[var(--color-accent-fg)]`}>Save</button>
        <button type="button" onClick={onCancel} className="text-[11.5px] text-[var(--color-text-muted)] hover:underline">Cancel</button>
      </div>
    </div>
  );
}
