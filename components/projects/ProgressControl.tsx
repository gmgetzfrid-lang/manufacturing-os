"use client";

// ProgressControl — set a LEAF task's physical % complete.
//
// Two shapes share one slider:
//   <ProgressSlider/>  — the inline control (detail panel): a 0–100 slider plus
//                        0/25/50/75/Done quick buttons.
//   <ProgressControl/> — a compact "62%" chip (timeline rows, calendar tiles)
//                        that opens the slider in a portal popover.
//
// Summary/parent tasks never use this — their % is rolled up from children
// (see lib/scheduleProgress.ts), so callers render it read-only there.

import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { previousShift, shiftAt, shiftWindow, DEFAULT_SHIFT_TIMES, type ShiftCredit, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { clockForWork } from "@/components/projects/ShiftRecordParts";
import { dayKey, toDateTimeInput } from "@/lib/scheduleTz";
import DateTimePicker from "@/components/projects/DateTimePicker";
import PctSlider from "@/components/projects/PctSlider";

/** The project's clock. Given, the progress form asks which shift a change
 *  counts for — a fix to what last shift entered goes on last shift's
 *  report, and this shift's progress counts from the fixed number. */
export const ShiftClockContext = createContext<{ tz: string; times: ShiftTimes } | null>(null);

/** The shifts a change can be put at: the one running now and the two
 *  before it ("Mon night", "Mon day"). */
export function shiftChoices(clock: { tz: string; times: ShiftTimes }, now: number): Array<{ w: ShiftWindow; label: string }> {
  const cur = shiftAt(now, clock.tz, clock.times);
  const p1 = previousShift(cur, clock.tz, clock.times), p2 = previousShift(p1, clock.tz, clock.times);
  const name = (w: ShiftWindow) => `${new Date(w.start).toLocaleDateString("en-US", { weekday: "short", timeZone: clock.tz })} ${w.kind}`;
  return [{ w: cur, label: "This shift" }, { w: p1, label: name(p1) }, { w: p2, label: name(p2) }];
}

/** The shifts to pick from for when something happened: this shift and
 *  the two before it, plus the card's own shift when it isn't one of them.
 *  The card's shift is picked first — unless it hasn't started yet (a card
 *  further on in the calendar): work done ahead of plan happened now, or
 *  earlier, so this shift is picked and `ahead` says so. */
export function whenChoices(own: { w: ShiftWindow; label: string }, clock: { tz: string; times: ShiftTimes }, now: number): { choices: Array<{ w: ShiftWindow; label: string }>; idx: number; ahead: boolean } {
  const choices = shiftChoices(clock, now);
  if (own.w.start > now) return { choices, idx: 0, ahead: true };
  const at = choices.findIndex((c) => c.w.start === own.w.start && c.w.end === own.w.end);
  if (at >= 0) return { choices, idx: at, ahead: false };
  // Its place in time order (newest first) — after this shift.
  const pos = Math.max(1, choices.findIndex((c) => c.w.start < own.w.start) < 0 ? choices.length : choices.findIndex((c) => c.w.start < own.w.start));
  return { choices: [...choices.slice(0, pos), own, ...choices.slice(pos)], idx: pos, ahead: false };
}

/** The shift picked: a chip, or another day typed in (`other`, a plant day). */
export function pickOf(choices: Array<{ w: ShiftWindow; label: string }>, idx: number, other: string | null | undefined, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): { w: ShiftWindow; label: string } {
  return other ? { w: shiftWindow(other, "day", tz, times), label: other } : choices[idx] ?? choices[0];
}

/** When it happened — the shift and a 24-hour time — or what's wrong. A
 *  time that isn't on the shift picked lands on the shift it is on that day. */
export function resolveWhen(choice: { w: ShiftWindow; label: string }, clock: string, tz: string, times: ShiftTimes = DEFAULT_SHIFT_TIMES): { credit: ShiftCredit } | { error: string } {
  if (!clock.trim()) return { error: "Put in the time it happened." };
  const r = clockForWork(choice.w, clock, tz, times);
  if ("error" in r) return r;
  const label = new Date(r.at).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
  return { credit: { at: r.at, label } };
}

/** When it happened — a date chip and a time chip (calendar, time wheel,
 *  Now): required wherever the project's clock is known. Picks go in as
 *  the day (`other`) and the 24-hour time (`clock`). */
export function WhenFields({ choices, idx, clock, setClock, tz, disabled, other, setOther, times = DEFAULT_SHIFT_TIMES }: {
  choices: Array<{ w: ShiftWindow; label: string }>; idx: number; setIdx?: (i: number) => void;
  clock: string; setClock: (v: string) => void; tz: string; disabled?: boolean;
  /** The day picked (a plant day). */
  other?: string | null; setOther?: (d: string | null) => void;
  times?: ShiftTimes;
}) {
  // Before a day is picked: this shift is today; an earlier one, its day.
  const [today] = useState(() => dayKey(Date.now(), tz));
  const pick = pickOf(choices, idx, other, tz, times);
  const r = clock.trim() ? clockForWork(pick.w, clock, tz, times, Infinity) : null;
  const value = r && "at" in r ? toDateTimeInput(r.at, tz) : (other ?? (idx === 0 ? today : dayKey(pick.w.start, tz)));
  return (
    <DateTimePicker label="When" hint="- required" value={value} tz={tz} times={times} disabled={disabled}
      onChange={(v) => { setOther?.(v.slice(0, 10)); setClock(v.length >= 16 ? v.slice(11, 16) : ""); }} />
  );
}

function clamp(p: number): number {
  return Math.max(0, Math.min(100, Math.round(p || 0)));
}

const QUICK = [0, 25, 50, 75, 100];

interface SliderProps {
  percent: number;
  onPick: (percent: number) => void;
  disabled?: boolean;
  busy?: boolean;
  /** Save a pick even when it equals the starting value — for a slider
   *  that opens on a suggestion (marking a task in progress opens at 50%),
   *  where "50%" is a real answer, not "no change". */
  commitSame?: boolean;
  /** Shows a "Start at N%" button that saves the value on the slider. */
  confirmLabel?: (percent: number) => string;
}

export function ProgressSlider({ percent, onPick, disabled, busy, commitSame, confirmLabel }: SliderProps) {
  const target = clamp(percent);
  const [val, setVal] = useState(target);
  const [synced, setSynced] = useState(target);
  const [dragging, setDragging] = useState(false);
  // Track external changes (optimistic updates, refetches) unless the user is
  // mid-drag — we don't want the thumb to jump while they're dragging. Adjusting
  // during render (not in an effect) is React's recommended pattern for this.
  if (!dragging && target !== synced) {
    setSynced(target);
    setVal(target);
  }

  const commit = (v: number) => {
    const c = clamp(v);
    setDragging(false);
    setVal(c);
    if (commitSame || c !== clamp(percent)) onPick(c);
  };

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Progress</span>
        <span className="text-sm font-black text-[var(--color-text)] tabular-nums">{val}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={val}
        disabled={disabled || busy}
        onPointerDown={() => setDragging(true)}
        onChange={(e) => setVal(Number(e.target.value))}
        onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        // Arrow keys move the thumb; Enter (or leaving the slider) saves.
        onKeyUp={(e) => { if (e.key === "Enter") commit(Number((e.target as HTMLInputElement).value)); }}
        onBlur={(e) => { if (clamp(Number(e.target.value)) !== clamp(percent)) commit(Number(e.target.value)); }}
        className="w-full accent-[var(--color-accent)] cursor-pointer disabled:opacity-50"
        aria-label="Percent complete"
      />
      <div className="mt-2 flex items-center gap-1">
        {QUICK.map((q) => (
          <button
            key={q}
            type="button"
            disabled={disabled || busy}
            onClick={() => commit(q)}
            className={`flex-1 text-[11px] font-bold py-1 rounded-md border transition-colors disabled:opacity-50 ${
              val === q
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]"
                : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
            }`}
          >
            {q === 100 ? "Done" : `${q}%`}
          </button>
        ))}
      </div>
      {confirmLabel && (
        <button type="button" disabled={disabled || busy} onClick={() => commit(val)}
          className="mt-2 w-full text-[12px] font-black py-1.5 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
          {confirmLabel(val)}
        </button>
      )}
    </div>
  );
}

// ── % with a comment ──────────────────────────────────────────────
// Work in progress always says what got done — that line is what the next
// crew and the shift report read. Slide to the %, say what got done, Enter
// saves both.

export const PICK_PCTS = [0, 10, 25, 50, 75, 90, 100];

/** Does saving this % need a comment? Anything under way does. */
export const needsComment = (pct: number | null) => pct != null && pct > 0 && pct < 100;

export function ProgressNoteForm({ percent, start, onSave, onCancel, busy }: {
  percent: number;
  /** Starting work ("In progress"): a pick is required, even the current %. */
  start?: boolean;
  /** Saves the % and the comment together — filed under an earlier shift
   *  when one was picked; false = not saved. */
  onSave: (percent: number, note: string, forShift?: ShiftCredit) => Promise<unknown> | unknown;
  onCancel?: () => void;
  busy?: boolean;
  autoFocus?: boolean;
}) {
  const clockCtx = useContext(ShiftClockContext);
  // This shift and the two before it, as of when the form opened.
  const [choices] = useState(() => (clockCtx ? shiftChoices(clockCtx, Date.now()) : []));
  const [whenIdx, setWhenIdx] = useState(0);
  const [when, setWhen] = useState("");
  const [otherDay, setOtherDay] = useState<string | null>(null);
  const cur = clamp(percent);
  const [pick, setPick] = useState<number | null>(start ? (cur > 0 && cur < 100 ? cur : null) : null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const value = pick ?? (start ? null : cur);
  // A new %, or the same % with a fresh comment ("still 25 — waiting on
  // the crane") — both worth saving.
  const changed = pick != null && (start || pick !== cur || !!note.trim());
  // Every change says what happened — it goes on the report: work done,
  // done, or why it went back.
  const wantsNote = pick != null;
  const missing = wantsNote && !note.trim();
  // Save stays tappable when only the comment is missing: tapping it says
  // what's needed instead of doing nothing.
  const ready = changed && !saving && !busy;
  const save = async () => {
    if (!changed) { setMsg("Slide it to the new %."); return; }
    if (missing) { setMsg("Add a few words first - what got done, or why it's corrected. It goes on the shift report."); noteRef.current?.focus(); return; }
    let forShift: ShiftCredit | undefined;
    if (clockCtx && choices.length) {
      const r = resolveWhen(pickOf(choices, whenIdx, otherDay, clockCtx.tz, clockCtx.times), when, clockCtx.tz, clockCtx.times);
      if ("error" in r) { setMsg(r.error); return; }
      forShift = r.credit;
    }
    setSaving(true);
    try {
      const ok = await onSave(pick!, note.trim(), forShift);
      if (ok === false) setMsg("Not saved.");
    } catch (e) { setMsg((e as Error).message || "Not saved."); }
    finally { setSaving(false); }
  };
  return (
    <div className="w-full space-y-2 text-[11px]">
      <PctSlider value={value ?? cur} was={cur} disabled={busy || saving} onChange={(v) => { setPick(v); setMsg(null); }} />
      {/* Work in progress needs a comment — said up front, not found out
          by a Save that does nothing. */}
      <div className="space-y-0.5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-bold text-[var(--color-text)]">What got done</span>
          {wantsNote
            ? <span className="font-black text-amber-700 dark:text-amber-400">- required</span>
            : <span className="text-[var(--color-text-faint)]">- optional</span>}
        </div>
        <input ref={noteRef} value={note} onChange={(e) => { setNote(e.target.value); setMsg(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } if (e.key === "Escape" && onCancel) { e.stopPropagation(); onCancel(); } }}
          placeholder={wantsNote ? "e.g. bundle half out · or why it's corrected" : "Comment"}
          aria-required={wantsNote}
          className={`w-full h-8 px-2 rounded-md border bg-[var(--color-surface)] pointer-coarse:h-10 focus:outline-none focus:border-[var(--color-accent-ring)] ${missing ? (msg ? "border-2 border-rose-500" : "border-2 border-amber-400 bg-amber-50/60 dark:bg-amber-950/30") : "border-[var(--color-border-strong)]"}`} />
      </div>
      {/* When it happened: the shift and the time — it goes on that
          shift's report at that time. */}
      {choices.length > 0 && <WhenFields choices={choices} idx={whenIdx} setIdx={(i) => { setWhenIdx(i); setMsg(null); }} clock={when} setClock={(v) => { setWhen(v); setMsg(null); }} tz={clockCtx!.tz} times={clockCtx!.times} other={otherDay} setOther={(d) => { setOtherDay(d); setMsg(null); }} disabled={busy || saving} />}
      {msg && <div className="text-rose-700 dark:text-rose-400 font-semibold">{msg}</div>}
      <div className="flex items-center gap-2">
        {onCancel && <button type="button" onClick={onCancel} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>}
        <button type="button" disabled={!ready} onClick={() => void save()}
          className={`ml-auto h-8 px-3 rounded-md font-black bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 pointer-coarse:h-10 ${missing ? "opacity-70" : ""}`}>
          {saving ? "Saving…" : missing ? "Add a comment to save" : `${pick === 100 ? "Mark done" : pick != null ? `Save ${pick}%` : "Save"}${when && pick != null ? ` at ${when}` : ""}`}
        </button>
      </div>
    </div>
  );
}

interface ChipProps extends SliderProps {
  /** Saves the % with a comment (required for work in progress). When
   *  given, the chip opens the comment form instead of the bare slider. */
  onSaveWithNote?: (percent: number, note: string, forShift?: ShiftCredit) => Promise<unknown> | unknown;
  onDisabledClick?: () => void;
  size?: "sm" | "md";
}

export default function ProgressControl({ percent, onPick, disabled, onDisabledClick, busy, size = "md", onSaveWithNote }: ChipProps) {
  const [open, setOpen] = useState(false);
  // Esc closes the menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; anchorTop: number }>({ top: 0, left: 0, anchorTop: 0 });
  const pct = clamp(percent);
  // Opens upward when there's no room below (bottom of a list or panel).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!open || !el) return;
    const h = el.offsetHeight;
    el.style.top = `${pos.top + h > window.innerHeight - 8 ? Math.max(8, pos.anchorTop - h - 4) : pos.top}px`;
  }, [open, pos]);

  const openMenu = () => {
    if (disabled) { onDisabledClick?.(); return; }
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - (onSaveWithNote ? 312 : 240))), anchorTop: r.top });
    }
    setOpen((v) => !v);
  };

  const tone = pct >= 100
    ? "text-emerald-700 bg-emerald-50 border-emerald-200"
    : pct > 0
      ? "text-blue-700 bg-blue-50 border-blue-200"
      : "text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]";

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); openMenu(); }}
        title={disabled ? `${pct}% complete` : `${pct}% complete - click to set`}
        className={`relative inline-flex items-center justify-center rounded-md border font-bold tabular-nums after:absolute after:-inset-1 pointer-coarse:after:-inset-2.5 after:content-[''] ${
          size === "sm" ? "px-1 py-0 text-[9px]" : "px-1.5 py-0.5 text-[10px]"
        } ${tone} ${disabled ? "cursor-default opacity-80" : "cursor-pointer hover:brightness-95"}`}
      >
        {pct}%
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 z-[300]" onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            className={`fixed z-[310] ${onSaveWithNote ? "w-[300px] max-w-[calc(100vw-16px)]" : "w-[224px]"} bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg p-3 animate-in fade-in zoom-in-95 duration-150`}
            style={{ top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            {onSaveWithNote ? (
              <ProgressNoteForm percent={pct} busy={busy} onCancel={() => setOpen(false)}
                onSave={async (v, n, w) => { const ok = await onSaveWithNote(v, n, w); if (ok !== false) setOpen(false); return ok; }} />
            ) : (
              /* A pick saves and closes — one click per task. */
              <ProgressSlider percent={pct} onPick={(v) => { onPick(v); setOpen(false); }} busy={busy} />
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
