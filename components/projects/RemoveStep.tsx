"use client";

// Remove a step, from any view: the step card's Remove (calendar, the day's
// side bar, the Shift tab's report, Work orders) asks the schedule (ExecutionView)
// through the "step:remove" event, which opens this. Two ways off:
//   Delete  - put in by mistake: gone, with its comments; Undo right after
//             brings it back.
//   Cancel  - planned but not done on this job: kept on the close-out
//             report as cancelled, with why and where it went.

import React, { useEffect, useRef, useState } from "react";
import { Ban, Trash2, X } from "lucide-react";
import { CancelJobForm } from "@/components/projects/CancelledJobs";
import type { Milestone } from "@/types/schema";

export const REMOVE_STEP_EVENT = "step:remove";

/** Ask the schedule to remove a step (opens its Remove dialog). */
export const askRemoveStep = (id: string) => window.dispatchEvent(new CustomEvent(REMOVE_STEP_EVENT, { detail: { id } }));

export function RemoveStepDialog({ m, under, userId, userName, userEmail, onDelete, onCancelled, onClose }: {
  m: Milestone;
  /** Steps under it (a task with steps goes with them). */
  under: number;
  userId: string; userName?: string; userEmail?: string;
  onDelete: () => void;
  onCancelled: () => void;
  onClose: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
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
  const what = under > 0 ? `${m.name} and the ${under} step${under === 1 ? "" : "s"} under it` : m.name;
  const choice = "w-full flex items-start gap-3 px-1 py-3 text-left";
  return (
    <div ref={boxRef} className="fixed inset-0 z-[320] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in flex items-end sm:items-center justify-center sm:p-4" role="dialog" aria-modal="true" aria-label="Remove a step" onClick={onClose}>
      <div className="w-full sm:max-w-md bg-[var(--color-surface)] rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Take it off the schedule</div>
            <div className="mt-0.5 text-[15px] font-bold text-[var(--color-text)] break-words">{what}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-1.5 w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        {cancelling && m.id ? (
          <CancelJobForm id={m.id} name={m.name} steps={Math.max(1, under)} userId={userId} userName={userName} userEmail={userEmail}
            onClose={() => setCancelling(false)} onDone={onCancelled} />
        ) : (
          <div className="border-y border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            <button type="button" onClick={onDelete} className={`${choice} hover:bg-rose-50 dark:hover:bg-rose-950/30`}>
              <Trash2 className="w-5 h-5 mt-0.5 text-rose-600 dark:text-rose-400 shrink-0" />
              <span>
                <b className="block text-[13.5px] text-[var(--color-text)]">Delete it</b>
                <span className="block text-[12px] text-[var(--color-text-muted)]">Put in by mistake. Gone, with its comments and progress. Undo right after brings it back.</span>
              </span>
            </button>
            <button type="button" onClick={() => setCancelling(true)} className={`${choice} hover:bg-amber-50 dark:hover:bg-amber-950/30`}>
              <Ban className="w-5 h-5 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>
                <b className="block text-[13.5px] text-[var(--color-text)]">Cancel it</b>
                <span className="block text-[12px] text-[var(--color-text-muted)]">Planned, but not done on this job. Kept on the close-out report as cancelled, with why and where it went.</span>
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
