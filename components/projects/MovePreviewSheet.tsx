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
}

export default function MovePreviewSheet({ targets, deltaDays, onCancel, onConfirm, busy }: Props) {
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
    return w;
  }, [targets, deltaDays, mode, nowMs]);

  return (
    <div className="fixed inset-0 z-[260] flex items-end sm:items-center justify-center p-4" onClick={onCancel}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]" />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl ring-1 ring-slate-900/10 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2 bg-gradient-to-b from-white to-slate-50/50">
          <CalendarRange className="w-4 h-4 text-indigo-600" />
          <h2 className="font-bold text-slate-900 text-sm flex-1 min-w-0 truncate">
            Move {multi ? `${targets.length} tasks` : `“${primary.name}”`} {absDays} day{absDays === 1 ? "" : "s"} {dir}
          </h2>
          <button onClick={onCancel} className="p-1 rounded hover:bg-slate-100 text-slate-500"><XIcon className="w-4 h-4" /></button>
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
          <div className={`rounded-lg border p-3 text-sm ${mode === "extend" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
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

          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 space-y-1">
              {warnings.map((wn, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[12px] text-amber-900">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {wn}
                </div>
              ))}
              <div className="text-[10px] text-amber-700/80 pl-5">You can still continue — this is just a heads-up.</div>
            </div>
          )}

          {primary.status && (
            <div className="text-[11px] text-slate-400">
              Defaulted to <b className="text-slate-600">{defaultMode === "extend" ? "taking longer" : "shift the date"}</b> because {multi ? "the selection includes" : "this is"} {statusWord(primary.status, multi, targets)}.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50/60 flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Cancel</button>
          <button onClick={() => onConfirm(mode)} disabled={busy} className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg disabled:opacity-40">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarRange className="w-4 h-4" />}
            {mode === "extend" ? "Extend" : "Shift"} {multi ? `${targets.length} tasks` : "task"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeCard({ active, disabled, onClick, title, body, tone }: {
  active: boolean; disabled?: boolean; onClick: () => void; title: string; body: string; tone: "slate" | "amber";
}) {
  const ring = active ? (tone === "amber" ? "border-amber-400 ring-2 ring-amber-200 bg-amber-50" : "border-indigo-400 ring-2 ring-indigo-200 bg-indigo-50") : "border-slate-200 hover:border-slate-300 bg-white";
  return (
    <button onClick={onClick} disabled={disabled} className={`text-left rounded-xl border p-3 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${ring}`}>
      <div className="text-[13px] font-bold text-slate-900">{title}</div>
      <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">{body}</div>
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
