"use client";

// Jobs taken off this schedule that still get done somewhere else.
//   CancelJobForm    — in the task panel: a note and where it went, one click
//   CancelledJobsBar — above the schedule: what came off, and Put back

import React, { useState } from "react";
import { Ban, ChevronDown, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { cancelMilestone, restoreCancelledMilestone } from "@/lib/milestones";
import { fmtInTz } from "@/lib/scheduleTz";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import type { CancelledJob } from "@/lib/cancelledJobs";

export function CancelJobForm({ id, name, steps, userId, userName, userEmail, onDone, onClose }: {
  id: string; name: string; steps: number;
  userId: string; userName?: string; userEmail?: string;
  onDone: () => void; onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [movedTo, setMovedTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await cancelMilestone({ id, note, movedTo, actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail });
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const input = "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-amber-400/60";
  return (
    <div className="w-full space-y-2">
      <div className="text-[12px] text-[var(--color-text)]">
        Take <b>{name}</b>{steps > 1 ? <> and its {steps} steps</> : null} off this schedule. It&apos;s listed on the close-out report so it isn&apos;t forgotten.
      </div>
      <label className="block">
        <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Moved to</span>
        <input autoFocus value={movedTo} onChange={(e) => setMovedTo(e.target.value)} maxLength={200}
          placeholder="e.g. Nov 15 · spring 2027 outage · WO 123456" className={input} />
      </label>
      <label className="block">
        <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Note</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000}
          placeholder="Why, and anything to remember" className={`${input} resize-y`} />
      </label>
      {err && <div className="text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
      <div className="flex items-center justify-end gap-2">
        <button onClick={onClose} disabled={busy} className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1">Back</button>
        <button onClick={() => void save()} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-[12px] font-bold px-3 py-1.5 disabled:opacity-50">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />} Cancel job
        </button>
      </div>
    </div>
  );
}

export function CancelledJobsBar({ jobs, canEdit, userId, userEmail, onChanged }: {
  jobs: CancelledJob[]; canEdit: boolean; userId: string; userEmail?: string; onChanged: () => void | Promise<void>;
}) {
  const tz = useScheduleTz();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const putBack = async (id: string) => {
    setBusy(id); setErr(null);
    try { await restoreCancelledMilestone({ id, actorUserId: userId, actorUserEmail: userEmail }); await onChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const n = jobs.length;
  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/30">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12.5px] text-amber-900 dark:text-amber-200">
        <Ban className="w-4 h-4 shrink-0" />
        <span className="flex-1 min-w-0"><b>{n} job{n === 1 ? "" : "s"} cancelled</b> from this schedule - still to be done elsewhere</span>
        {open ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
      </button>
      {open && (
        <div className="border-t border-amber-200 dark:border-amber-900/60 divide-y divide-amber-200 dark:divide-amber-900/60">
          {err && <div className="px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
          {jobs.map((j) => (
            <div key={j.m.id} className="px-3 py-2 flex items-start gap-3">
              <div className="flex-1 min-w-0 text-[12.5px] space-y-0.5">
                <div className="text-[var(--color-text)]">
                  <b className="break-words">{j.m.name}</b>
                  {j.crumbs.length > 0 && <span className="text-[11px] text-[var(--color-text-muted)]"> · {j.crumbs.join(" › ")}</span>}
                  {j.steps > 1 && <span className="text-[11px] text-[var(--color-text-muted)]"> · {j.steps} steps</span>}
                </div>
                <div className="text-[var(--color-text)]">
                  <span className="text-[10px] font-black uppercase tracking-wider text-amber-700 dark:text-amber-400">Moved to </span>
                  {j.m.movedTo ? <b>{j.m.movedTo}</b> : <span className="text-[var(--color-text-faint)]">not said</span>}
                </div>
                {j.m.cancelNote && <div className="italic text-[var(--color-text-muted)] break-words">“{j.m.cancelNote}”</div>}
                <div className="text-[10.5px] text-[var(--color-text-faint)]">
                  Cancelled {j.at != null && Number.isFinite(j.at) ? fmtInTz(j.at, tz, { weekday: "short", month: "short", day: "numeric" }) : ""}{j.m.cancelledByName ? ` · ${j.m.cancelledByName}` : ""}
                </div>
              </div>
              {canEdit && j.m.id && (
                <button onClick={() => void putBack(j.m.id!)} disabled={busy != null} title="Put this job back on the schedule"
                  className="shrink-0 inline-flex items-center gap-1 rounded-md border border-amber-300 dark:border-amber-800 px-2 py-1 text-[11px] font-bold text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50">
                  {busy === j.m.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Put back
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
