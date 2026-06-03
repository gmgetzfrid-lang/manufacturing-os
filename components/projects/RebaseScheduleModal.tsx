"use client";

// RebaseScheduleModal — pick a new start date for an existing project
// schedule and shift every milestone by the date delta. The relative
// spacing between tasks, durations, and the WBS are all preserved.
//
// Use cases:
//   * Reuse a turnaround / capital project schedule from last year.
//   * Slip the project start date by N days without touching every
//     task manually.
//   * Compress a schedule by rebasing to an earlier date.
//
// Actual dates (actual_at, actual_start_at) are NOT shifted — those
// represent history and must stay where they happened.

import React, { useEffect, useMemo, useState } from "react";
import { CalendarClock, X, ArrowRight, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { rebaseSchedule, type RebaseResult } from "@/lib/milestones";

interface Props {
  orgId: string;
  projectId: string;
  projectName?: string;
  /** Current earliest planned date in the schedule. The modal pre-
   *  fills the new-start picker with today so the most common case
   *  ("use this schedule starting today") needs no extra clicks. */
  currentAnchorIso?: string | null;
  totalTaskCount: number;
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
  onClose: () => void;
  onDone: () => void;
}

export default function RebaseScheduleModal({
  orgId, projectId, projectName, currentAnchorIso, totalTaskCount,
  actorUserId, actorUserName, actorUserEmail, actorUserRole,
  onClose, onDone,
}: Props) {
  const [target, setTarget] = useState<string>("");      // YYYY-MM-DD
  const [targetTime, setTargetTime] = useState<string>("08:00"); // HH:MM
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RebaseResult | null>(null);

  // Default target = today (or the current anchor's time-of-day).
  useEffect(() => {
    const now = new Date();
    setTarget(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
    if (currentAnchorIso) {
      try {
        const d = new Date(currentAnchorIso);
        setTargetTime(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
      } catch { /* keep default */ }
    }
  }, [currentAnchorIso]);

  // Preview: what's the day-delta?
  const previewDelta = useMemo(() => {
    if (!target || !currentAnchorIso) return null;
    try {
      const oldA = new Date(currentAnchorIso);
      const newA = new Date(`${target}T${targetTime}:00`);
      const days = Math.round((newA.getTime() - oldA.getTime()) / 86400000);
      return { days, oldA, newA };
    } catch { return null; }
  }, [target, targetTime, currentAnchorIso]);

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await rebaseSchedule({
        orgId, projectId,
        newStartIso: new Date(`${target}T${targetTime}:00`).toISOString(),
        actorUserId, actorUserName, actorUserEmail, actorUserRole,
      });
      setResult(res);
      if (res.errors.length === 0 && res.shiftedCount > 0) {
        // Brief success beat, then close + reload upstream.
        setTimeout(() => onDone(), 1200);
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-violet-50 via-white to-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center shadow-md shadow-violet-900/30">
              <CalendarClock className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h2 className="font-black text-slate-900">Rebase schedule</h2>
              <div className="text-[11px] text-slate-600 truncate">
                Shift every task by a date delta. {projectName && <>Project: <b>{projectName}</b>.</>}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-200 text-slate-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-xs text-slate-700">
            Pick a new start date. Every task&apos;s planned start + finish shifts by the delta from the current earliest scheduled date.
            Relative spacing, durations, and the WBS are preserved. Actual dates (history) are NOT touched.
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-500">New start date</label>
              <input
                type="date"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/40"
              />
            </div>
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-500">Start time</label>
              <input
                type="time"
                value={targetTime}
                onChange={(e) => setTargetTime(e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/40"
              />
            </div>
          </div>

          {/* Preview */}
          {currentAnchorIso ? (
            <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-xs">
              <div className="font-black text-violet-900 mb-1 uppercase tracking-widest text-[10px]">Preview</div>
              <div className="flex items-center gap-2 text-slate-800">
                <span className="font-mono">{new Date(currentAnchorIso).toLocaleString()}</span>
                <ArrowRight className="w-3 h-3 text-violet-600" />
                <span className="font-mono font-bold">{previewDelta?.newA?.toLocaleString() ?? "—"}</span>
              </div>
              {previewDelta && (
                <div className={`mt-1 text-[11px] font-bold ${
                  previewDelta.days > 0 ? "text-amber-700" : previewDelta.days < 0 ? "text-emerald-700" : "text-slate-500"
                }`}>
                  Shift: {previewDelta.days > 0 ? "+" : ""}{previewDelta.days} day{Math.abs(previewDelta.days) === 1 ? "" : "s"}
                  {" · "}
                  Will move {totalTaskCount} task{totalTaskCount === 1 ? "" : "s"}.
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              No current anchor date detected — make sure the project has at least one milestone with a planned date before rebasing.
            </div>
          )}

          {result && (
            <div className={`rounded-xl p-3 border ${
              result.errors.length > 0
                ? "border-rose-200 bg-rose-50"
                : "border-emerald-200 bg-emerald-50"
            }`}>
              <div className="flex items-center gap-2 font-bold text-sm">
                {result.errors.length > 0
                  ? <><AlertTriangle className="w-4 h-4 text-rose-600" /> Rebased with errors</>
                  : <><CheckCircle2 className="w-4 h-4 text-emerald-600" /> Schedule rebased</>}
              </div>
              <div className="mt-1 text-xs space-y-0.5">
                <div>Shifted: <b>{result.shiftedCount}</b> tasks ({result.shiftDays >= 0 ? "+" : ""}{result.shiftDays} days)</div>
                {result.errors.length > 0 && (
                  <div className="text-rose-700 mt-1">
                    {result.errors.length} error{result.errors.length === 1 ? "" : "s"}:
                    <ul className="ml-5 list-disc max-h-24 overflow-y-auto">
                      {result.errors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Close</button>
          <button
            onClick={submit}
            disabled={busy || !target || !currentAnchorIso || !!result}
            className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-violet-600 hover:bg-violet-700 px-4 py-2 rounded-lg shadow-sm disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarClock className="w-4 h-4" />}
            Rebase schedule
          </button>
        </div>
      </div>
    </div>
  );
}
