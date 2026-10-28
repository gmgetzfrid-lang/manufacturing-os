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
import { creditShifts, type ShiftCredit, type ShiftTimes } from "@/lib/shiftReport";

/** The project's clock. Given, the progress form asks which shift a change
 *  counts for — a fix to what last shift entered goes on last shift's
 *  report, and this shift's progress counts from the fixed number. */
export const ShiftClockContext = createContext<{ tz: string; times: ShiftTimes } | null>(null);

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
// crew and the shift report read. One tap picks the %, the comment box is
// ready to type in, Enter saves both. Done and 0 % don't need a comment.

export const PICK_PCTS = [0, 10, 25, 50, 75, 90, 100];

/** Does saving this % need a comment? Anything under way does. */
export const needsComment = (pct: number | null) => pct != null && pct > 0 && pct < 100;

export function ProgressNoteForm({ percent, start, onSave, onCancel, busy, autoFocus = true }: {
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
  const clock = useContext(ShiftClockContext);
  // The shifts before the one running now, as of when the form opened.
  const [earlier] = useState(() => (clock ? creditShifts(Date.now(), clock.tz, clock.times) : []));
  const [forShift, setForShift] = useState<ShiftCredit | null>(null);
  const cur = clamp(percent);
  const [pick, setPick] = useState<number | null>(start ? (cur > 0 && cur < 100 ? cur : null) : null);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const pctRef = useRef<HTMLInputElement>(null);
  // A mouse gets the % box ready to type in; a finger taps the buttons
  // (focusing would pop the keyboard over half the form).
  useEffect(() => { if (autoFocus && window.matchMedia?.("(pointer: fine)").matches) pctRef.current?.focus(); }, [autoFocus]);
  const choose = (v: number) => { setPick(clamp(v)); setTyped(""); setMsg(null); setTimeout(() => noteRef.current?.focus(), 0); };
  const value = pick ?? (start ? null : cur);
  // A new %, or the same % with a fresh comment ("still 25 — waiting on
  // the crane") — both worth saving.
  const changed = pick != null && (start || pick !== cur || !!note.trim());
  // Starting work needs a word even at 0 % ("rigging set, waiting on crane").
  const wantsNote = start ? pick != null && pick < 100 : needsComment(pick);
  const missing = wantsNote && !note.trim();
  // Save stays tappable when only the comment is missing: tapping it says
  // what's needed instead of doing nothing.
  const ready = changed && !saving && !busy;
  const save = async () => {
    if (!changed) { setMsg("Pick a %."); return; }
    if (missing) { setMsg("Add a few words first — what got done, or why it's corrected. It goes on the shift report."); noteRef.current?.focus(); return; }
    setSaving(true);
    try {
      const ok = await onSave(pick!, note.trim(), forShift ?? undefined);
      if (ok === false) setMsg("Not saved.");
    } catch (e) { setMsg((e as Error).message || "Not saved."); }
    finally { setSaving(false); }
  };
  return (
    <div className="w-full space-y-2 text-[11px]">
      <div className="flex items-center gap-1 flex-wrap">
        {PICK_PCTS.map((v) => (
          <button key={v} type="button" disabled={busy || saving} onClick={() => choose(v)}
            className={`h-8 min-w-[36px] px-1.5 rounded-md border font-bold tabular-nums pointer-coarse:h-10 ${value === v ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"} disabled:opacity-50`}>
            {v === 100 ? "Done" : v}
          </button>
        ))}
        <span className="inline-flex items-center gap-0.5">
          <input ref={pctRef} value={typed} inputMode="numeric" placeholder={String(value ?? cur)} aria-label="Percent done"
            onChange={(e) => { const t = e.target.value.replace(/[^0-9]/g, "").slice(0, 3); setTyped(t); if (t !== "") { setPick(clamp(Number(t))); setMsg(null); } }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (typed !== "") choose(Number(typed)); } }}
            className="h-8 w-11 px-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-right font-bold tabular-nums pointer-coarse:h-10 focus:outline-none focus:border-[var(--color-accent-ring)]" />
          <span className="font-bold text-[var(--color-text-muted)]">%</span>
        </span>
      </div>
      {/* Work in progress needs a comment — said up front, not found out
          by a Save that does nothing. */}
      <div className="space-y-0.5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-bold text-[var(--color-text)]">What got done</span>
          {wantsNote
            ? <span className="font-black text-amber-700 dark:text-amber-400">— required</span>
            : <span className="text-[var(--color-text-faint)]">— optional</span>}
        </div>
        <input ref={noteRef} value={note} onChange={(e) => { setNote(e.target.value); setMsg(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } if (e.key === "Escape" && onCancel) { e.stopPropagation(); onCancel(); } }}
          placeholder={wantsNote ? "e.g. bundle half out · or why it's corrected" : "Comment"}
          aria-required={wantsNote}
          className={`w-full h-8 px-2 rounded-md border bg-[var(--color-surface)] pointer-coarse:h-10 focus:outline-none focus:border-[var(--color-accent-ring)] ${missing ? (msg ? "border-2 border-rose-500" : "border-2 border-amber-400 bg-amber-50/60 dark:bg-amber-950/30") : "border-[var(--color-border-strong)]"}`} />
      </div>
      {/* Which shift it counts for: fixing what an earlier shift entered
          shouldn't read as this shift's progress (or its loss). */}
      {earlier.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Counts for">
            <span className="font-bold text-[var(--color-text)] mr-0.5">Counts for</span>
            {[null, ...earlier].map((c) => {
              const on = (forShift?.at ?? null) === (c?.at ?? null);
              return (
                <button key={c?.at ?? "now"} type="button" aria-pressed={on} disabled={busy || saving} onClick={() => { setForShift(c); setMsg(null); }}
                  className={`h-7 px-2 rounded-md border font-semibold pointer-coarse:h-9 disabled:opacity-50 ${on ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-text)]" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>
                  {c ? c.label : "This shift"}
                </button>
              );
            })}
          </div>
          {forShift && (
            <div className="text-[var(--color-text-muted)] leading-snug">
              A fix to what {forShift.label} shift entered: it shows on that shift&rsquo;s report, and this shift&rsquo;s progress counts from it.
            </div>
          )}
        </div>
      )}
      {msg && <div className="text-rose-700 dark:text-rose-400 font-semibold">{msg}</div>}
      <div className="flex items-center gap-2">
        {onCancel && <button type="button" onClick={onCancel} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>}
        <button type="button" disabled={!ready} onClick={() => void save()}
          className={`ml-auto h-8 px-3 rounded-md font-black bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 pointer-coarse:h-10 ${missing ? "opacity-70" : ""}`}>
          {saving ? "Saving…" : missing ? "Add a comment to save" : `${pick === 100 ? "Mark done" : pick != null ? `Save ${pick}%` : "Save"}${forShift && pick != null ? ` for ${forShift.label}` : ""}`}
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
        title={disabled ? `${pct}% complete` : `${pct}% complete — click to set`}
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
