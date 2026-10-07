"use client";

// MovePreviewSheet — the frictionless "here's what's about to happen"
// confirmation shown before a reschedule commits. It exists for three
// reasons the user called out:
//   1. Tooltips were hidden behind the cursor — this shows the impact
//      in a fixed sheet, not a hover tip.
//   2. "Am I deferring or adding time?" — the sheet states it plainly
//      and lets the user switch.
//   3. Confidence — it shows the work-hours impact so a supervisor
//      knows whether they just added work or only shifted a date.
//
// The default mode comes from status (in-progress slipping later =
// taking longer = extend; otherwise defer), but the user can flip it.

import React, { useMemo, useState } from "react";
import { X as XIcon, CalendarRange, Clock, ArrowRight, Loader2, AlertTriangle } from "lucide-react";
import type { Milestone } from "@/types/schema";
import type { MoveMode } from "@/lib/scheduleReflow";
import { defaultMoveMode } from "@/lib/scheduleReflow";

interface Props {
  /** The tasks being moved (1, or a multi-selection). */
  targets: Milestone[];
  deltaDays: number;
  onCancel: () => void;
  onConfirm: (mode: MoveMode) => void;
  busy?: boolean;
  /** The computed change set for a mode — every row the move rewrites
   *  (cascaded dependents, a dragged phase's descendants), each with its
   *  new finish and its baseline finish. When given, the baseline warning
   *  counts over it (PC SCHED-3 / PT SCH-4); without it only the dragged
   *  targets are counted. */
  changeSetFor?: (mode: MoveMode) => BaselineCheckRow[];
  /** The move as it will be WRITTEN, per mode (PT SCH-4): every row the
   *  batch rewrites (so the sheet's count is the write's count), the locked
   *  dependents it could not move, and a refusal when the links loop —
   *  shown instead of a Confirm. Takes precedence over changeSetFor. */
  planFor?: (mode: MoveMode) => MovePlan;
}

/** What a move will write, computed by the caller from the same engine
 *  calls the commit makes. */
export interface MovePlan {
  rows: Array<BaselineCheckRow & { id: string; name: string }>;
  /** Names of locked dependents (done / imported) left in place although
   *  the move now breaks their link. */
  held: string[];
  /** Why the move cannot be made (a loop in the links), or null. */
  refusal: string | null;
}

/** A row the baseline warning reads: its finish after the move and its
 *  approved-plan finish. */
export interface BaselineCheckRow { plannedAt: string; baselineFinishAt?: string | null }

/** How many rows would finish past their approved baseline. Pure. */
export function countPastBaseline(rows: BaselineCheckRow[]): number {
  return rows.filter((r) => r.baselineFinishAt && Date.parse(r.plannedAt) > Date.parse(r.baselineFinishAt)).length;
}

export default function MovePreviewSheet({ targets, deltaDays, onCancel, onConfirm, busy, changeSetFor, planFor }: Props) {
  const primary = targets[0];
  // Default mode: if ANY moved task is in-progress and we're slipping
  // later, default to extend; else defer.
  const defaultMode = useMemo<MoveMode>(() => {
    if (deltaDays < 0) return "defer";
    const anyInProgress = targets.some((t) => t.status === "in_progress");
    return defaultMoveMode(anyInProgress ? "in_progress" : "planned", deltaDays);
  }, [targets, deltaDays]);
  const [mode, setMode] = useState<MoveMode>(defaultMode);

  const dir = deltaDays > 0 ? "later" : "earlier";
  const absDays = Math.abs(deltaDays);
  const canExtend = deltaDays > 0; // can't extend backwards

  // Work-hours impact: extend adds (delta × per-day-rate) of work per
  // task that carries hours. We approximate per-day from durationHours
  // over the task's current span.
  const hoursImpact = useMemo(() => {
    if (mode !== "extend") return null;
    let added = 0, base = 0, counted = 0;
    for (const t of targets) {
      const h = typeof t.durationHours === "number" ? t.durationHours : 0;
      if (h <= 0) continue;
      counted++;
      base += h;
      const span = spanDays(t);
      added += (h / span) * deltaDays;
    }
    if (counted === 0) return null;
    return { added: Math.round(added), base: Math.round(base), after: Math.round(base + added) };
  }, [mode, targets, deltaDays]);

  const multi = targets.length > 1;
  // What this mode will actually write (PT SCH-4): the count on the sheet is
  // the count of the write, cascaded dependents and phase envelopes included.
  const plan = useMemo(() => (planFor ? planFor(mode) : null), [planFor, mode]);
  const writes = plan ? plan.rows.length : null;

  // Capture "now" once per mount so the warnings memo stays pure.
  const [nowMs] = useState<number>(() => Date.now());

  // Gentle guardrails — surfaced, never blocking. Caught before commit
  // in plain language.
  const warnings = useMemo(() => {
    const w: string[] = [];
    if (deltaDays < 0) {
      const landsInPast = targets.some((t) => {
        const projected = Date.parse((t.plannedStartAt as string | undefined) ?? (t.plannedAt as string)) + deltaDays * 86400000;
        return projected < nowMs - 86400000;
      });
      if (landsInPast) w.push("This lands in the past.");
    }
    if (mode === "extend" && targets.some((t) => t.status === "completed")) {
      w.push("Some selected tasks are already Done — extending a finished task is unusual.");
    }
    // Baseline drift (PC SCHED-3 / PT SCH-4): say so before the move commits, the way the single-task form does —
    // over the computed change set when the caller hands it over, else over the dragged targets.
    if (plan && plan.held.length > 0) {
      w.push(`${plan.held.length} dependent task${plan.held.length === 1 ? " is" : "s are"} done or imported, so ${plan.held.length === 1 ? "it stays" : "they stay"} put and will now start before this finishes: ${plan.held.slice(0, 3).join(", ")}${plan.held.length > 3 ? ", …" : ""}.`);
    }
    const pastBaseline = plan
      ? countPastBaseline(plan.rows)
      : changeSetFor
      ? countPastBaseline(changeSetFor(mode))
      : deltaDays > 0
        ? countPastBaseline(targets.map((t) => {
            const finish = Date.parse(t.plannedAt as string) + deltaDays * 86400000;
            return { plannedAt: Number.isFinite(finish) ? new Date(finish).toISOString() : "", baselineFinishAt: t.baselineFinishAt as string | null | undefined };
          }))
        : 0;
    if (pastBaseline > 0) w.push(`${pastBaseline} task${pastBaseline === 1 ? "" : "s"} would finish past the approved baseline.`);
    return w;
  }, [targets, deltaDays, mode, nowMs, changeSetFor, plan]);

  return (
    <div className="fixed inset-0 z-[260] flex items-end sm:items-start sm:items-center justify-center overflow-y-auto p-4" onClick={onCancel}>
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm animate-in fade-in" />
      <div className="relative w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl ring-1 ring-slate-900/10 overflow-hidden animate-in fade-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-[var(--color-border)] flex items-center gap-2 bg-gradient-to-b from-white to-slate-50/50">
          <CalendarRange className="w-4 h-4 text-[var(--color-accent)]" />
          <h2 className="font-bold text-[var(--color-text)] text-sm flex-1 min-w-0 truncate">
            Move {multi ? `${targets.length} tasks` : `“${primary.name}”`} {absDays} day{absDays === 1 ? "" : "s"} {dir}
          </h2>
          <button onClick={onCancel} className="p-1 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors"><XIcon className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-3">
          {/* Mode chooser */}
          <div className="grid grid-cols-2 gap-2">
            <ModeCard
              active={mode === "defer"}
              onClick={() => setMode("defer")}
              title="Shift the date"
              body={`Move the whole ${multi ? "selection" : "task"} ${dir}. Same duration — no work hours added.`}
              tone="slate"
            />
            <ModeCard
              active={mode === "extend"}
              disabled={!canExtend}
              onClick={() => canExtend && setMode("extend")}
              title="It's taking longer"
              body={canExtend ? "Keep the start, push the finish out. Adds work hours." : "Only when moving later."}
              tone="amber"
            />
          </div>

          {/* Impact line — the confidence-builder */}
          <div className={`rounded-lg border p-3 text-sm ${mode === "extend" ? "border-amber-500/40 bg-amber-500/[0.08] text-amber-900 dark:text-amber-200" : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]"}`}>
            {mode === "defer" ? (
              <div className="flex items-center gap-2">
                <ArrowRight className="w-4 h-4 shrink-0" />
                <span>Just shifting the planned date {absDays} day{absDays === 1 ? "" : "s"} {dir}. <b>Duration and work hours unchanged.</b></span>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <span>Extending the finish by {absDays} day{absDays === 1 ? "" : "s"} — <b>this adds work</b>.</span>
                  {hoursImpact ? (
                    <div className="mt-1 font-mono text-[12px]">
                      +{hoursImpact.added} h · {hoursImpact.base} h → <b>{hoursImpact.after} h</b>
                    </div>
                  ) : (
                    <div className="mt-1 text-[11px] opacity-80">No work-hours recorded on {multi ? "these tasks" : "this task"}, so only the duration grows.</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {plan?.refusal ? (
            <div role="alert" className="rounded-lg border border-rose-500/50 bg-rose-500/[0.08] p-2.5 text-[12px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {plan.refusal}
            </div>
          ) : writes !== null && (
            <div className="text-[12px] text-[var(--color-text-muted)]">
              Writes <b className="text-[var(--color-text)]">{writes} task{writes === 1 ? "" : "s"}</b>
              {writes > targets.length && <> — {targets.length} moved, {writes - targets.length} more follow (dependents and the phases around them)</>}
              {writes === 0 && <> — nothing here can move (done or imported tasks stay where they are)</>}.
            </div>
          )}

          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-500/50 bg-amber-500/[0.08] p-2.5 space-y-1">
              {warnings.map((wn, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[12px] text-amber-900 dark:text-amber-200">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {wn}
                </div>
              ))}
              <div className="text-[10px] text-amber-800 dark:text-amber-300 pl-5">You can still continue — this is just a heads-up.</div>
            </div>
          )}

          {primary.status && (
            <div className="text-[11px] text-[var(--color-text-faint)]">
              Defaulted to <b className="text-[var(--color-text-muted)]">{defaultMode === "extend" ? "taking longer" : "shift the date"}</b> because {multi ? "the selection includes" : "this is"} {statusWord(primary.status, multi, targets)}.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-slate-50/60 flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5 transition-colors">Cancel</button>
          <button onClick={() => onConfirm(mode)} disabled={busy || !!plan?.refusal || writes === 0} className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-4 py-2 rounded-lg disabled:opacity-40 transition-colors">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarRange className="w-4 h-4" />}
            {mode === "extend" ? "Extend" : "Shift"} {writes !== null ? `${writes} task${writes === 1 ? "" : "s"}` : multi ? `${targets.length} tasks` : "task"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeCard({ active, disabled, onClick, title, body, tone }: {
  active: boolean; disabled?: boolean; onClick: () => void; title: string; body: string; tone: "slate" | "amber";
}) {
  const ring = active ? (tone === "amber" ? "border-amber-400 ring-2 ring-amber-500/40 bg-amber-500/[0.08]" : "border-[var(--color-accent-ring)] ring-2 ring-[var(--color-accent-ring)]/30 bg-[var(--color-accent-soft)]") : "border-[var(--color-border)] hover:border-[var(--color-border-strong)] bg-[var(--color-surface)]";
  return (
    <button onClick={onClick} disabled={disabled} className={`text-left rounded-xl border p-3 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${ring}`}>
      <div className="text-[13px] font-bold text-[var(--color-text)]">{title}</div>
      <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 leading-snug">{body}</div>
    </button>
  );
}

function statusWord(status: string, multi: boolean, targets: Milestone[]): string {
  if (multi) {
    return targets.some((t) => t.status === "in_progress") ? "in-progress work" : "not-yet-started work";
  }
  return status === "in_progress" ? "in progress" : status === "on_hold" ? "on hold" : status === "blocked" ? "blocked" : "planned";
}

function spanDays(m: Milestone): number {
  const s = m.plannedStartAt ? Date.parse(m.plannedStartAt as string) : Date.parse(m.plannedAt as string);
  const f = Date.parse(m.plannedAt as string);
  return Math.max(1, Math.round((f - s) / 86400000) + 1);
}
