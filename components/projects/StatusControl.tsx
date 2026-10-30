"use client";

// StatusControl — the single, consistent way to see and set a task's
// status everywhere in the scheduling UI (timeline rows, calendar
// chips, sub-task lists, the detail panel).
//
// Why one component: the app had grown three different status
// affordances — a done-only checkbox on sub-tasks, a 3-state cycle dot
// on chips, and a full 5-button row in the detail panel. Users couldn't
// tell what any one of them did or set "on hold"/"blocked" on a
// sub-task at all. This replaces all of them.
//
// Interaction: the control shows the current status (colored dot, with
// an optional label). Click it → a small popover lists every status;
// pick one. "On hold" and "Blocked" optionally capture a one-line
// reason. The popover renders in a portal so it's never clipped by a
// card's overflow.

import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Circle, Loader2, CircleCheck, PauseCircle, AlertTriangle, XCircle } from "lucide-react";
import type { MilestoneStatus } from "@/types/schema";
import type { ShiftCredit } from "@/lib/shiftReport";
import { ProgressSlider, ProgressNoteForm, ShiftClockContext, WhenFields, resolveWhen, shiftChoices, pickOf } from "@/components/projects/ProgressControl";

export const STATUS_ORDER: MilestoneStatus[] = ["planned", "in_progress", "completed", "on_hold", "blocked", "missed"];

interface Meta { label: string; dot: string; pill: string; Icon: React.ComponentType<{ className?: string }>; needsReason?: boolean }
export const STATUS_META: Record<MilestoneStatus, Meta> = {
  planned:     { label: "Planned",     dot: "bg-slate-300 border-slate-400",   pill: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",     Icon: Circle },
  in_progress: { label: "In progress", dot: "bg-blue-500 border-blue-600",     pill: "bg-blue-100 text-blue-800 border-blue-200",        Icon: Loader2 },
  completed:   { label: "Done",        dot: "bg-emerald-500 border-emerald-600",pill: "bg-emerald-100 text-emerald-800 border-emerald-200",Icon: CircleCheck },
  on_hold:     { label: "On hold",     dot: "bg-amber-500 border-amber-600",   pill: "bg-amber-100 text-amber-900 border-amber-200",     Icon: PauseCircle, needsReason: true },
  blocked:     { label: "Blocked",     dot: "bg-rose-500 border-rose-600",     pill: "bg-rose-100 text-rose-800 border-rose-200",        Icon: AlertTriangle, needsReason: true },
  missed:      { label: "Missed",      dot: "bg-rose-600 border-rose-700",     pill: "bg-rose-100 text-rose-900 border-rose-300",        Icon: XCircle },
};

export function statusLabel(s: MilestoneStatus): string { return STATUS_META[s].label; }

interface Props {
  status: MilestoneStatus;
  /** `percent` comes with "in progress" picked from the how-far step.
   *  `reason` is the comment said with it (a hold's reason, or what got
   *  done); `forShift` when it happened. */
  onPick: (status: MilestoneStatus, reason?: string, percent?: number, forShift?: ShiftCredit) => void;
  disabled?: boolean;
  /** Called when a disabled control is clicked — lets callers explain WHY
   *  it's read-only (e.g. "you're not a project member") instead of the tap
   *  doing nothing and feeling broken. */
  onDisabledClick?: () => void;
  busy?: boolean;
  /** "dot" = just the colored dot (chips, dense rows). "pill" = dot +
   *  label (detail panel, list rows with room). */
  variant?: "dot" | "pill";
  size?: "sm" | "md";
  /** Read-only: the status is DERIVED (a summary/parent rolling up its
   *  children) and can't be set directly. Renders the same dot/pill but with
   *  no popover, plus an explanatory tooltip. */
  readOnly?: boolean;
  /** Tooltip override — used to explain a derived/read-only status. */
  title?: string;
  /** Current % complete + a setter. When supplied, picking "In progress"
   *  opens a quick % picker right in the popover (so you can set progress
   *  without opening the detail drawer). 100 ⇒ done, 0 ⇒ planned. */
  percent?: number;
  onSetProgress?: (percent: number) => void;
  /** Starting work with a comment: "In progress" asks how far and what got
   *  done, and saves both (status + % + note). */
  onStartWithNote?: (percent: number, note: string, forShift?: ShiftCredit) => Promise<unknown> | unknown;
}

export default function StatusControl({ status, onPick, disabled, onDisabledClick, busy, variant = "pill", size = "md", readOnly, title, percent, onSetProgress, onStartWithNote }: Props) {
  const [open, setOpen] = useState(false);
  // Esc closes the menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  const [reasonFor, setReasonFor] = useState<MilestoneStatus | null>(null);
  const [reason, setReason] = useState("");
  // When it happened — required wherever the project's clock is known.
  const clockCtx = useContext(ShiftClockContext);
  const [choices, setChoices] = useState<ReturnType<typeof shiftChoices>>([]);
  const [whenIdx, setWhenIdx] = useState(0);
  const [when, setWhen] = useState("");
  const [otherDay, setOtherDay] = useState<string | null>(null);
  const [whyMsg, setWhyMsg] = useState<string | null>(null);
  const [pctStep, setPctStep] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; anchorTop: number }>({ top: 0, left: 0, anchorTop: 0 });
  // Near the bottom of the screen (the last sub-task in the side bar) the
  // menu opens UPWARD instead of running off the page — measured after it
  // renders, and again when it grows (the % slider, the reason box).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!open || !el) return;
    const h = el.offsetHeight;
    const below = pos.top;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, pos.anchorTop - h - 4) : below;
    el.style.top = `${top}px`;
  }, [open, pctStep, reasonFor, pos]);
  const meta = STATUS_META[status];

  const openMenu = () => {
    if (disabled) return;
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.min(r.left, window.innerWidth - (onStartWithNote ? 312 : 188));
      setPos({ top: r.bottom + 4, left: Math.max(8, left), anchorTop: r.top });
    }
    setReasonFor(null);
    setReason("");
    setPctStep(false);
    setWhen(""); setWhenIdx(0); setOtherDay(null); setWhyMsg(null);
    setChoices(clockCtx ? shiftChoices(clockCtx, Date.now()) : []);
    setOpen((v) => !v);
  };

  const choose = (s: MilestoneStatus) => {
    // "In progress" with progress wiring → ask "how far?" right here instead of
    // committing a bare in_progress the user then has to open a drawer to set.
    if (s === "in_progress" && (onSetProgress || onStartWithNote)) {
      setPctStep(true);
      return;
    }
    if (s === status) { setOpen(false); return; }
    // Every change says why or what got done, and when — it goes on the report.
    setReasonFor(s);
    setReason("");
    setWhyMsg(null);
  };
  const commit = () => {
    if (!reasonFor) return;
    if (!reason.trim()) { setWhyMsg("Add a few words - it goes on the report."); return; }
    let forShift: ShiftCredit | undefined;
    if (clockCtx && choices.length) {
      const r = resolveWhen(pickOf(choices, whenIdx, otherDay, clockCtx.tz, clockCtx.times), when, clockCtx.tz, clockCtx.times);
      if ("error" in r) { setWhyMsg(r.error); return; }
      forShift = r.credit;
    }
    onPick(reasonFor, reason.trim(), undefined, forShift);
    setOpen(false);
  };
  const askFor = (s: MilestoneStatus) => (s === "completed" ? "What got done" : s === "on_hold" ? "Why it's on hold" : s === "blocked" ? "What's blocking it" : s === "missed" ? "Why it was missed" : "Why it's going back");

  // Seed the in-progress % picker: keep a real mid-progress value, but never
  // 0 (that's "planned") or 100 (that's "done") — default to 50 so a tap or
  // two sets it. Quick buttons (incl. 0 / Done) can still flip the status.
  const seedPct = (() => {
    const p = Math.round(percent ?? 0);
    return p > 0 && p < 100 ? p : 50;
  })();

  const dotSize = size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5";

  // Derived (summary) status: show it, don't let it be set. Rendered as a
  // static element so it reads as informational, not a broken button.
  if (readOnly) {
    return (
      <span
        title={title ?? `${meta.label} - rolls up from sub-tasks`}
        className={
          variant === "dot"
            ? `inline-flex items-center justify-center rounded-full border ${dotSize} ${meta.dot} opacity-90`
            : `inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${meta.pill} opacity-90`
        }
      >
        {variant === "dot"
          ? (status === "completed" ? <CircleCheck className="w-2.5 h-2.5 text-white" /> : null)
          : <><span className={`w-1.5 h-1.5 rounded-full ${meta.dot.split(" ")[0]}`} />{meta.label}</>}
      </span>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); if (disabled) { onDisabledClick?.(); return; } openMenu(); }}
        aria-disabled={disabled}
        title={disabled ? (onDisabledClick ? `${meta.label} - view only` : meta.label) : `${meta.label} - click to change`}
        className={
          variant === "dot"
            ? `relative inline-flex items-center justify-center rounded-full border ${dotSize} ${meta.dot} after:absolute after:-inset-1.5 pointer-coarse:after:-inset-3 after:content-[''] ${disabled ? `opacity-70 ${onDisabledClick ? "cursor-pointer" : "cursor-default"}` : "cursor-pointer hover:scale-110 transition-transform"}`
            : `inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${meta.pill} ${disabled ? `opacity-70 ${onDisabledClick ? "cursor-pointer" : "cursor-default"}` : "cursor-pointer hover:brightness-95"}`
        }
      >
        {busy
          ? <Loader2 className={`${size === "sm" ? "w-2.5 h-2.5" : "w-3 h-3"} animate-spin`} />
          : variant === "dot"
            ? (status === "completed" ? <CircleCheck className="w-2.5 h-2.5 text-white" /> : null)
            : <><span className={`w-1.5 h-1.5 rounded-full ${meta.dot.split(" ")[0]}`} />{meta.label}</>}
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 z-[300]" onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            className={`fixed z-[310] ${(pctStep && onStartWithNote) || reasonFor ? "w-[300px] max-w-[calc(100vw-16px)]" : "w-[180px]"} bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg py-1 animate-in fade-in zoom-in-95 duration-150`}
            style={{ top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            {pctStep ? (
              <div className="p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-faint)]">How far along?</span>
                  <button onClick={() => setPctStep(false)} className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Back</button>
                </div>
                {onStartWithNote ? (
                  <ProgressNoteForm percent={percent ?? 0} start busy={busy} onCancel={() => setOpen(false)}
                    onSave={async (v, n, w) => { const ok = await onStartWithNote(v, n, w); if (ok !== false) setOpen(false); return ok; }} />
                ) : <ProgressSlider
                  percent={seedPct}
                  commitSame
                  confirmLabel={(v) => (v >= 100 ? "Mark done" : `Start at ${v}%`)}
                  // 0% = started, nothing measurable yet: in progress, not
                  // back to planned (which a 0% progress update would mean).
                  // One write: the status and the % together, so starting a
                  // blocked or on-hold task takes it off hold (a % alone keeps
                  // the hold — 40% done and still blocked is real).
                  onPick={(v) => { if (v >= 100) onPick("completed"); else onPick("in_progress", undefined, v); setOpen(false); }}
                />}
              </div>
            ) : reasonFor ? (
              <div className="p-2.5 space-y-2 text-[11px]">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-faint)]">
                  {STATUS_META[reasonFor].label}
                </div>
                <div>
                  <div className="font-bold text-[var(--color-text)] mb-1">{askFor(reasonFor)} <span className="font-black text-amber-700 dark:text-amber-400">- required</span></div>
                  <input
                    autoFocus
                    value={reason}
                    onChange={(e) => { setReason(e.target.value); setWhyMsg(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
                    placeholder={reasonFor === "on_hold" ? "waiting on parts…" : reasonFor === "blocked" ? "what's blocking it…" : reasonFor === "completed" ? "what got done…" : "why…"}
                    className="w-full text-xs px-2 py-1.5 border border-[var(--color-border-strong)] rounded-md outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]/30"
                  />
                </div>
                {choices.length > 0 && clockCtx && <WhenFields choices={choices} idx={whenIdx} setIdx={(i) => { setWhenIdx(i); setWhyMsg(null); }} clock={when} setClock={(v) => { setWhen(v); setWhyMsg(null); }} tz={clockCtx.tz} times={clockCtx.times} other={otherDay} setOther={(d) => { setOtherDay(d); setWhyMsg(null); }} />}
                {whyMsg && <div className="font-semibold text-rose-700 dark:text-rose-400">{whyMsg}</div>}
                <div className="flex items-center justify-end gap-1.5">
                  <button onClick={() => setReasonFor(null)} className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 transition-colors">Back</button>
                  <button
                    onClick={commit}
                    className="text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-2.5 py-1 rounded-md transition-colors"
                  >
                    {reasonFor === "completed" ? "Mark done" : `Set ${STATUS_META[reasonFor].label}`}{when ? ` at ${when}` : ""}
                  </button>
                </div>
              </div>
            ) : (
              STATUS_ORDER.map((s) => {
                const m = STATUS_META[s];
                const Icon = m.Icon;
                return (
                  <button
                    key={s}
                    onClick={() => choose(s)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--color-surface-2)] transition-colors ${s === status ? "font-bold text-[var(--color-accent)]" : "font-medium text-[var(--color-text)]"}`}
                  >
                    <span className={`w-3 h-3 rounded-full border ${m.dot} inline-flex items-center justify-center`}>
                      {s === "completed" && <CircleCheck className="w-2 h-2 text-white" />}
                    </span>
                    <span className="flex-1">{m.label}</span>
                    {s === status && <Icon className="w-3 h-3 text-[var(--color-text-faint)]" />}
                  </button>
                );
              })
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
