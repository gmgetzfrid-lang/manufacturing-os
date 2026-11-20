"use client";

// WorkflowDiagramModal — makes the 10-state drafting-request lifecycle legible.
//
// New requesters routinely don't understand why an RFI takes two weeks (the
// engineering-review loop) or what "PENDING_IFC" means. This is a plain-
// language map of the whole flow with the current ticket's stage highlighted,
// a one-line "what this means / what happens next" for every state, and the
// branch points (engineer loop, revision loop) called out explicitly.

import React from "react";
import { X, ArrowDown, RotateCcw, GitBranch } from "lucide-react";
import type { TicketStatus } from "@/types/schema";

interface StageDef {
  status: TicketStatus;
  label: string;
  blurb: string;
}

// Canonical happy-path order. Branch states (REVISION_REQ, CANCELED) are shown
// separately because they're loops/exits, not steps.
const MAIN_FLOW: StageDef[] = [
  { status: "PENDING_ASSIGNMENT", label: "Awaiting drafter", blurb: "Where every new request lands. An Admin - or the DraftingSupervisor, if one is set - assigns a drafter, or flags it for engineering review first." },
  { status: "DRAFTING", label: "Drafting", blurb: "A drafter is actively producing the deliverable. Files are staged here until submitted." },
  { status: "PENDING_REVIEW", label: "In review", blurb: "Draft submitted. The requester (or reviewer) checks it and either approves or requests a revision." },
  { status: "PENDING_FINAL_APPROVAL", label: "Final approval", blurb: "Sent to an engineer for sign-off before it can be issued for construction." },
  { status: "PENDING_IFC", label: "Ready to issue (IFC)", blurb: "Approved. The final IFC package is being prepared / issued for construction." },
  { status: "FINAL_DRAFT", label: "Final package", blurb: "The issued package awaiting the requester's acknowledgement." },
  { status: "CLOSED", label: "Closed", blurb: "Done and acknowledged. Reopen only if something was missed." },
];

/** The main path as short step labels, for a StepPath on the request. */
export const REQUEST_STEPS = ["Assign", "Draft", "Review", "Final approval", "Issue (IFC)", "Final package", "Closed"];

/** Where a status sits on the main path. Branches fold onto the step they
 *  return to (engineering review onto Assign, a revision onto Draft);
 *  a canceled request has no place on it (-1). */
export function requestStepIndex(status?: TicketStatus): number {
  if (!status || status === "CANCELED") return -1;
  if (status === "NEW" || status === "PENDING_ENG_INITIAL" || status === "PENDING_ENG_TEAM") return 0;
  if (status === "REVISION_REQ") return 1;
  return MAIN_FLOW.findIndex((s) => s.status === status);
}

const BRANCHES: StageDef[] = [
  { status: "PENDING_ENG_TEAM", label: "Engineering review (optional)", blurb: "When an assigner flags a request, a specific engineer reviews the scope, then hands it back to assignment or returns it with questions. Not every request needs this." },
  { status: "REVISION_REQ", label: "Revision requested", blurb: "A reviewer sent it back. It loops to Drafting with the revision reason - fix and resubmit." },
  { status: "CANCELED", label: "Canceled", blurb: "Withdrawn or returned to the requester. A terminal exit off the main flow." },
];

const TONE: Record<string, string> = {
  current: "border-[var(--color-text)] bg-[var(--color-surface-2)] ring-1 ring-[var(--color-text)]",
  done: "border-emerald-200 bg-emerald-50/40",
  upcoming: "border-[var(--color-border)] bg-[var(--color-surface)]",
};

export default function WorkflowDiagramModal({
  current,
  onClose,
}: {
  current?: TicketStatus;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const currentIdx = MAIN_FLOW.findIndex((s) => s.status === current);

  return (
    <div
      className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl my-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[var(--color-border)]">
          <GitBranch className="w-4 h-4 text-[var(--color-text-muted)]" />
          <div className="flex-1">
            <h2 className="text-sm font-black text-[var(--color-text)]">How a drafting request flows</h2>
            <p className="text-[11px] text-[var(--color-text-muted)]">The ringed stage is where it is now.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          <ol className="space-y-1.5">
            {MAIN_FLOW.map((stage, i) => {
              const tone = stage.status === current ? "current" : currentIdx >= 0 && i < currentIdx ? "done" : "upcoming";
              return (
                <li key={stage.status}>
                  <div className={`rounded-xl border p-3 ${TONE[tone]}`}>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-black ${tone === "current" ? "bg-[var(--color-text)] text-[var(--color-surface)]" : tone === "done" ? "bg-emerald-500 text-white" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>{i + 1}</span>
                      <span className="text-sm font-bold text-[var(--color-text)]">{stage.label}</span>
                      {stage.status === current && <span className="ml-auto text-[11px] font-black uppercase tracking-wider text-[var(--color-text)]">You are here</span>}
                    </div>
                    <p className="text-[11px] text-[var(--color-text-muted)] mt-1 leading-relaxed pl-7">{stage.blurb}</p>
                  </div>
                  {i < MAIN_FLOW.length - 1 && (
                    <div className="flex justify-center py-0.5"><ArrowDown className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /></div>
                  )}
                </li>
              );
            })}
          </ol>

          <div className="mt-5 pt-4 border-t border-[var(--color-border)]">
            <div className="flex items-center gap-1.5 mb-2">
              <RotateCcw className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
              <h3 className="text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Branches & exits</h3>
            </div>
            <div className="space-y-1.5">
              {BRANCHES.map((b) => (
                <div key={b.status} className={`rounded-xl border p-3 ${b.status === current ? TONE.current : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-[var(--color-text)]">{b.label}</span>
                    {b.status === current && <span className="ml-auto text-[11px] font-black uppercase tracking-wider text-[var(--color-text)]">You are here</span>}
                  </div>
                  <p className="text-[11px] text-[var(--color-text-muted)] mt-1 leading-relaxed">{b.blurb}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
