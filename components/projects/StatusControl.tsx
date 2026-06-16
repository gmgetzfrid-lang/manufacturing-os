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

import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Circle, Loader2, CircleCheck, PauseCircle, AlertTriangle, XCircle } from "lucide-react";
import type { MilestoneStatus } from "@/types/schema";

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
  onPick: (status: MilestoneStatus, reason?: string) => void;
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
}

export default function StatusControl({ status, onPick, disabled, onDisabledClick, busy, variant = "pill", size = "md", readOnly, title }: Props) {
  const [open, setOpen] = useState(false);
  const [reasonFor, setReasonFor] = useState<MilestoneStatus | null>(null);
  const [reason, setReason] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const meta = STATUS_META[status];

  const openMenu = () => {
    if (disabled) return;
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.min(r.left, window.innerWidth - 188);
      setPos({ top: r.bottom + 4, left: Math.max(8, left) });
    }
    setReasonFor(null);
    setReason("");
    setOpen((v) => !v);
  };

  const choose = (s: MilestoneStatus) => {
    if (STATUS_META[s].needsReason) {
      setReasonFor(s);      // ask for an optional reason before committing
      setReason("");
      return;
    }
    onPick(s);
    setOpen(false);
  };

  const dotSize = size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5";

  // Derived (summary) status: show it, don't let it be set. Rendered as a
  // static element so it reads as informational, not a broken button.
  if (readOnly) {
    return (
      <span
        title={title ?? `${meta.label} — rolls up from sub-tasks`}
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
        title={disabled ? (onDisabledClick ? `${meta.label} — view only` : meta.label) : `${meta.label} — click to change`}
        className={
          variant === "dot"
            ? `inline-flex items-center justify-center rounded-full border ${dotSize} ${meta.dot} ${disabled ? `opacity-70 ${onDisabledClick ? "cursor-pointer" : "cursor-default"}` : "cursor-pointer hover:scale-110 transition-transform"}`
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
            className="fixed z-[310] w-[180px] bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg py-1 animate-in fade-in zoom-in-95 duration-150"
            style={{ top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            {reasonFor ? (
              <div className="p-2">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-faint)] mb-1">
                  {STATUS_META[reasonFor].label} — why? (optional)
                </div>
                <input
                  autoFocus
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { onPick(reasonFor, reason.trim() || undefined); setOpen(false); } }}
                  placeholder={reasonFor === "on_hold" ? "waiting on parts…" : "what's blocking it…"}
                  className="w-full text-xs px-2 py-1.5 border border-[var(--color-border-strong)] rounded-md outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]/30"
                />
                <div className="flex items-center justify-end gap-1.5 mt-2">
                  <button onClick={() => setReasonFor(null)} className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 transition-colors">Back</button>
                  <button
                    onClick={() => { onPick(reasonFor, reason.trim() || undefined); setOpen(false); }}
                    className="text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-2.5 py-1 rounded-md transition-colors"
                  >
                    Set {STATUS_META[reasonFor].label}
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
