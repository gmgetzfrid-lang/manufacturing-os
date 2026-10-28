"use client";

// MarkSheet — marking several steps at once (or a step from a list that
// has no form of its own) asks the same as marking one: when it happened
// (the shift and the time — which shift's report it's on) and a comment
// (the line the report reads; for a hold or a block, the reason). The
// comment goes on each step.

import React, { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { MilestoneStatus } from "@/types/schema";
import type { ShiftCredit, ShiftTimes } from "@/lib/shiftReport";
import { shiftChoices, resolveWhen, WhenFields, pickOf } from "@/components/projects/ProgressControl";

const WORD: Record<string, string> = { completed: "Done", in_progress: "Started", on_hold: "On hold", blocked: "Blocked", planned: "Not started", missed: "Missed" };

export default function MarkSheet({ names, status, tz, times, now: clockNow, ahead = 0, onSave, onClose }: {
  /** The steps being marked. */
  names: string[];
  status: MilestoneStatus;
  tz: string; times: ShiftTimes;
  now?: number;
  /** How many of them are planned for a later day. */
  ahead?: number;
  onSave: (when: ShiftCredit, note: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [now] = useState(() => clockNow ?? Date.now());
  const choices = useMemo(() => shiftChoices({ tz, times }, now), [tz, times, now]);
  const [wi, setWi] = useState(0);
  const [otherDay, setOtherDay] = useState<string | null>(null);
  const [clock, setClock] = useState(() => new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }));
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const word = WORD[status] ?? status;
  const n = names.length;

  const save = async () => {
    const when = resolveWhen(pickOf(choices, wi, otherDay, tz, times), clock, tz, times);
    if ("error" in when) { setMsg(when.error); return; }
    if (!note.trim()) { setMsg(status === "on_hold" || status === "blocked" ? "Put in the reason." : "Put in a comment — it's the line the report reads."); return; }
    setBusy(true);
    const ok = await onSave(when.credit, note.trim());
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-[185] bg-black/30" onClick={onClose}>
      <div role="dialog" aria-label={`Mark ${word}`} onClick={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-16 -translate-x-1/2 w-[440px] max-w-[96vw] max-h-[86dvh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-xl text-[12px] max-sm:left-0 max-sm:right-0 max-sm:top-auto max-sm:bottom-0 max-sm:translate-x-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
          <div className="text-[14px] font-black">Mark {n === 1 ? "" : `${n} steps `}{word}</div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-7 h-7 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <ul className="max-h-24 overflow-y-auto rounded-md border border-[var(--color-border)] px-2 py-1 space-y-0.5">
            {names.map((s, i) => <li key={i} className="break-words">{s}</li>)}
          </ul>
          {ahead > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              {ahead === n ? (n === 1 ? "It's" : "They're") : `${ahead} of these ${ahead === 1 ? "is" : "are"}`} planned for a later day. The plan keeps that day; the calendar shows {ahead === 1 ? "it" : "them"} on the day {ahead === 1 ? "it was" : "they were"} worked, marked ahead.
            </div>
          )}
          <WhenFields choices={choices} idx={wi} setIdx={(i) => { setWi(i); setMsg(null); }} clock={clock} setClock={(v) => { setClock(v); setMsg(null); }} tz={tz} times={times} other={otherDay} setOther={(d) => { setOtherDay(d); setMsg(null); }} disabled={busy} />
          <label className="block">
            <span className="block font-bold mb-1">{status === "on_hold" || status === "blocked" ? "Reason" : "Comment"} <span className="font-black text-amber-700 dark:text-amber-400">— required</span>{n > 1 && <span className="font-normal text-[var(--color-text-muted)]"> · goes on each step</span>}</span>
            <textarea value={note} onChange={(e) => { setNote(e.target.value); setMsg(null); }} rows={2} disabled={busy}
              placeholder={status === "completed" ? "e.g. Bundle pulled and set on the pad" : status === "in_progress" ? "e.g. Blinds going in, 4 of 9" : "e.g. Waiting on the crane"}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[12.5px] focus:outline-none focus:border-[var(--color-accent-ring)]" />
          </label>
          {msg && <div role="alert" className="font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="h-9 px-3 rounded-lg border border-[var(--color-border-strong)] font-semibold">Cancel</button>
            <button type="button" onClick={() => void save()} disabled={busy}
              className="h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
              {busy ? "Saving…" : `Mark ${word}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
