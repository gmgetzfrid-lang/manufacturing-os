"use client";

// MarkSheet — marking several steps at once (or a step from a list that
// has no form of its own) asks the same as marking one: when it happened
// (the shift and the time — which shift's report it's on) and a comment
// (the line the report reads; for a hold or a block, the reason). The
// comment goes on each step.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { MilestoneStatus } from "@/types/schema";
import type { ShiftCredit, ShiftTimes } from "@/lib/shiftReport";
import { shiftChoices, resolveWhen, WhenFields, pickOf } from "@/components/projects/ProgressControl";
import { useDraft } from "@/hooks/useDraft";

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
  // The comment comes back after a reload until it's saved.
  const draft = useDraft<string>(`mark:${status}:${names.join("|").slice(0, 300)}`, note, setNote, (v) => !v.trim());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const word = WORD[status] ?? status;
  const n = names.length;
  // Escape closes, as the X does.
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only the dialog on top closes.
      // (On screen only: a closed drawer can stay in the page, moved off it.)
      const open = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left < window.innerWidth && r.right > 0; });
      if (open.length && open[open.length - 1] !== boxRef.current) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    const when = resolveWhen(pickOf(choices, wi, otherDay, tz, times), clock, tz, times);
    if ("error" in when) { setMsg(when.error); return; }
    if (!note.trim()) { setMsg(status === "on_hold" || status === "blocked" ? "Put in the reason." : "Put in a comment: it's the line the report reads."); return; }
    setBusy(true);
    const ok = await onSave(when.credit, note.trim());
    setBusy(false);
    if (ok) { draft.clear(); onClose(); }
  };

  return (
    <div ref={boxRef} aria-modal="true" className="fixed inset-0 z-[185] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in" onClick={onClose}>
      <div role="dialog" aria-label={`Mark ${word}`} onClick={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-16 -translate-x-1/2 w-[440px] max-w-[96vw] max-h-[86dvh] overflow-y-auto rounded-2xl bg-[var(--color-surface)] text-[var(--color-text)] shadow-2xl text-[12.5px] max-sm:left-0 max-sm:right-0 max-sm:top-auto max-sm:bottom-0 max-sm:translate-x-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 pt-3 pb-2.5">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">{n === 1 ? "Mark a step" : `Mark ${n} steps`}</div>
            <div className="mt-0.5 text-[15px] font-bold">{word}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-1.5 w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <ul className="max-h-24 overflow-y-auto border-l-2 border-[var(--color-border-strong)] pl-2.5 space-y-0.5">
            {names.map((s, i) => <li key={i} className="break-words">{s}</li>)}
          </ul>
          {ahead > 0 && (
            <div className="border-l-2 border-amber-500 pl-2 py-0.5 text-amber-800 dark:text-amber-300">
              {ahead === n ? (n === 1 ? "It's" : "They're") : `${ahead} of these ${ahead === 1 ? "is" : "are"}`} planned for a later day. The plan keeps that day; the calendar shows {ahead === 1 ? "it" : "them"} on the day {ahead === 1 ? "it was" : "they were"} worked, marked ahead.
            </div>
          )}
          <WhenFields choices={choices} idx={wi} setIdx={(i) => { setWi(i); setMsg(null); }} clock={clock} setClock={(v) => { setClock(v); setMsg(null); }} tz={tz} times={times} other={otherDay} setOther={(d) => { setOtherDay(d); setMsg(null); }} disabled={busy} />
          <label className="block">
            <span className="block mb-1"><span className="text-[13px] font-semibold text-[var(--color-text-muted)]">{status === "on_hold" || status === "blocked" ? "Reason" : "Comment"}</span> <span className="text-[11.5px] text-[var(--color-text-muted)]">(required{n > 1 ? ", goes on each step" : ""})</span></span>
            <textarea value={note} onChange={(e) => { setNote(e.target.value); setMsg(null); }} rows={2} disabled={busy}
              placeholder={status === "completed" ? "e.g. Bundle pulled and set on the pad" : status === "in_progress" ? "e.g. Blinds going in, 4 of 9" : "e.g. Waiting on the crane"}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[12.5px] focus:outline-none focus:border-[var(--color-accent-ring)]" />
          </label>
          {msg && <div role="alert" className="font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="h-9 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] font-semibold hover:bg-[var(--color-surface-2)]">Cancel</button>
            <button type="button" onClick={() => void save()} disabled={busy}
              className="h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-semibold hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
              {busy ? "Saving…" : `Mark ${word}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
