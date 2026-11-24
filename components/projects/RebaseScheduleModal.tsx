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
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { dayKey, fmtInTz, fromDateTimeInput, toDateTimeInput, tzAbbrev } from "@/lib/scheduleTz";
import { CalendarClock, X, ArrowRight, Loader2, AlertTriangle, CheckCircle2, CircleAlert } from "lucide-react";
import { rebaseSchedule, type RebaseResult } from "@/lib/milestones";
import { sayError } from "@/components/projects/sayError";

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
  const tz = useScheduleTz();
  const [target, setTarget] = useState<string>("");      // YYYY-MM-DD
  const [targetTime, setTargetTime] = useState<string>("08:00"); // HH:MM
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RebaseResult | null>(null);
  const [resetBaseline, setResetBaseline] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Escape closes, as the X does (not while it's moving the tasks).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Default target = today (or the current anchor's time-of-day).
  useEffect(() => {
    // Today and the anchor's time-of-day, both on the plant's clock.
    setTarget(dayKey(Date.now(), tz));
    if (currentAnchorIso) {
      const t = toDateTimeInput(currentAnchorIso, tz).slice(11, 16);
      if (t) setTargetTime(t);
    }
  }, [currentAnchorIso, tz]);

  // Preview: what's the day-delta?
  const previewDelta = useMemo(() => {
    if (!target || !currentAnchorIso) return null;
    try {
      const oldA = new Date(currentAnchorIso);
      const iso = fromDateTimeInput(`${target}T${targetTime}`, tz);
      if (!iso) return null;
      const newA = new Date(iso);
      const days = Math.round((newA.getTime() - oldA.getTime()) / 86400000);
      return { days, oldA, newA };
    } catch { return null; }
  }, [target, targetTime, currentAnchorIso, tz]);

  const submit = async () => {
    if (!target) return;
    setBusy(true); setErr(null);
    try {
      const res = await rebaseSchedule({
        orgId, projectId,
        newStartIso: fromDateTimeInput(`${target}T${targetTime}`, tz) ?? new Date(`${target}T${targetTime}:00`).toISOString(),
        resetBaseline,
        // Whole days by the plant's calendar (a daylight-saving change in
        // between doesn't move tasks by an hour).
        timeZone: tz,
        actorUserId, actorUserName, actorUserEmail, actorUserRole,
      });
      setResult(res);
      if (res.errors.length === 0 && res.shiftedCount > 0) {
        // Brief success beat, then close + reload upstream.
        setTimeout(() => onDone(), 1200);
      }
    } catch (e) { setErr(`Couldn't move the schedule: ${sayError(e)}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-[var(--color-ink)]/55 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-xl bg-[var(--color-surface)] rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center">
              <CalendarClock className="w-5 h-5 text-[var(--color-text-muted)]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-reading font-medium text-[var(--color-text)]">Rebase schedule</h2>
              <div className="text-caption text-[var(--color-text-muted)] truncate">
                Move every task to a new start date. {projectName && <>Project: <b>{projectName}</b>.</>}
              </div>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="ui-hit p-1.5 rounded hover:bg-[var(--color-surface)] text-[var(--color-text-muted)] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-caption text-[var(--color-text-muted)]">
            Every task moves by the same number of days. Spacing, hours and the outline stay; actual dates already recorded don&apos;t move.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-caption font-medium text-[var(--color-text-muted)]">New start date</span>
              <input
                type="date"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="mt-1 w-full px-3 py-2 pointer-coarse:min-h-11 text-body border border-[var(--color-border-strong)] rounded-lg"
              />
            </label>
            <label className="block">
              <span className="text-caption font-medium text-[var(--color-text-muted)]">Start time ({tzAbbrev(tz)})</span>
              <input
                type="time"
                value={targetTime}
                onChange={(e) => setTargetTime(e.target.value)}
                className="mt-1 w-full px-3 py-2 pointer-coarse:min-h-11 text-body border border-[var(--color-border-strong)] rounded-lg"
              />
            </label>
          </div>

          <label className="flex items-start gap-2 rounded-xl border border-[var(--color-border)] px-3 py-2 text-caption text-[var(--color-text)]">
            <input type="checkbox" checked={resetBaseline} onChange={(e) => setResetBaseline(e.target.checked)} className="mt-0.5" />
            <span>
              <b>Treat the new dates as the plan of record:</b> reset the baseline so the shift report&apos;s &ldquo;plan said by now&rdquo; follows the moved schedule.
              Untick to keep measuring against the old dates (you will read as behind by the shift).
            </span>
          </label>

          {/* Preview */}
          {currentAnchorIso ? (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-caption">
              <div className="font-medium text-[var(--color-text)] mb-1 text-body">Preview</div>
              <div className="flex items-center gap-2 text-[var(--color-text)]">
                <span className="font-display tabular-nums">{fmtInTz(currentAnchorIso, tz, { dateStyle: "medium", timeStyle: "short" })}</span>
                <ArrowRight className="w-3 h-3 text-[var(--color-text-muted)]" />
                <span className="font-display tabular-nums font-bold">{previewDelta ? fmtInTz(previewDelta.newA, tz, { dateStyle: "medium", timeStyle: "short" }) : "-"}</span>
              </div>
              {previewDelta && (
                <div className={`mt-1 text-caption font-bold ${
                  previewDelta.days > 0 ? "text-[var(--state-held-text)]" : previewDelta.days < 0 ? "text-[var(--state-released-text)]" : "text-[var(--color-text-muted)]"
                }`}>
                  Shift: {previewDelta.days > 0 ? "+" : ""}{previewDelta.days} day{Math.abs(previewDelta.days) === 1 ? "" : "s"}
                  {" · "}
                  Will move {totalTaskCount} task{totalTaskCount === 1 ? "" : "s"}.
                </div>
              )}
            </div>
          ) : (
            <div className="border-l-2 border-[var(--state-held)] pl-3 text-caption text-[var(--state-held-text)]">
              No task has a planned date yet, so there&apos;s nothing to move from. Give at least one task a date first.
            </div>
          )}

          {result && (
            <div className={`pl-3 py-1 border-l-2 ${result.errors.length > 0 ? "border-[var(--state-overdue)]" : "border-[var(--state-released)]"}`}>
              <div className="flex items-center gap-2 font-medium text-body">
                {result.errors.length > 0
                  ? <><AlertTriangle className="w-4 h-4 text-[var(--state-overdue-text)]" /> Rebased with errors</>
                  : <><CheckCircle2 className="w-4 h-4 text-[var(--state-released-text)]" /> Schedule rebased</>}
              </div>
              <div className="mt-1 text-caption space-y-0.5">
                <div>Shifted: <b>{result.shiftedCount}</b> tasks ({result.shiftDays >= 0 ? "+" : ""}{result.shiftDays} days)</div>
                {result.errors.length > 0 && (
                  <div className="text-[var(--state-overdue-text)] mt-1">
                    {result.errors.length} error{result.errors.length === 1 ? "" : "s"}:
                    <ul className="ml-5 list-disc max-h-24 overflow-y-auto">
                      {result.errors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}
          {err && <div role="alert" className="text-caption text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{err}</span></div>}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="text-body text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5 transition-colors">Close</button>
          <button
            onClick={submit}
            disabled={busy || !target || !currentAnchorIso || !!result}
            className="inline-flex items-center gap-1.5 text-body font-medium text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-4 py-2 rounded-lg shadow-sm disabled:opacity-40 transition-colors"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarClock className="w-4 h-4" />}
            Rebase schedule
          </button>
        </div>
      </div>
    </div>
  );
}
