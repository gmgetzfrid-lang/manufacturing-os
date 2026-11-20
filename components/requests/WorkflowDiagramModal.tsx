"use client";

// WorkflowDiagramModal — makes the 10-state drafting-request lifecycle legible.
//
// New requesters routinely don't understand why an RFI takes two weeks (the
// engineering-review loop) or what "PENDING_IFC" means. This is a plain-
// language map of the whole flow with the current ticket's stage highlighted,
// a one-line "what this means / what happens next" for every state, and the
// branch points (engineer loop, revision loop) called out explicitly.

import React from "react";
import { X, RotateCcw } from "lucide-react";
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
      className="fixed inset-0 z-[300] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="How a drafting request flows"
        className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl my-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 px-5 sm:px-6 pt-5 pb-4 border-b border-[var(--color-border)]">
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">How a drafting request flows</div>
            <h2 className="mt-1.5 font-display text-[24px] leading-tight font-semibold text-[var(--color-text)]">
              {currentIdx >= 0 ? `Step ${currentIdx + 1} of ${MAIN_FLOW.length}: ${MAIN_FLOW[currentIdx].label}.` : BRANCHES.find((b) => b.status === current)?.label ?? "Seven steps, start to close."}
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 grid place-items-center rounded-[10px] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 sm:px-6 py-5 max-h-[70vh] overflow-y-auto">
          {/* One path: done steps filled, this one ringed, later ones faint. */}
          <ol aria-label="Steps">
            {MAIN_FLOW.map((stage, i) => {
              const tone = stage.status === current ? "current" : currentIdx >= 0 && i < currentIdx ? "done" : "upcoming";
              const last = i === MAIN_FLOW.length - 1;
              return (
                <li key={stage.status} className="relative flex gap-3 pb-4 last:pb-0" aria-current={tone === "current" ? "step" : undefined}>
                  {!last && <span aria-hidden className={`absolute left-[9px] top-5 bottom-0 w-0.5 ${tone === "done" ? "bg-[var(--color-text)]" : "bg-[var(--color-border)]"}`} />}
                  <span className={`relative z-10 mt-0.5 w-5 h-5 rounded-full shrink-0 grid place-items-center text-[11px] font-black ${
                    tone === "done" ? "bg-[var(--color-text)] text-[var(--color-surface)]"
                      : tone === "current" ? "border-2 border-[var(--color-text)] bg-[var(--color-surface)] text-[var(--color-text)]"
                        : "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-faint)]"}`}>{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-[14px] font-bold ${tone === "upcoming" ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}`}>{stage.label}</span>
                      {stage.status === current && <span className="ml-auto text-[13px] font-semibold text-[var(--color-text)]">You are here</span>}
                    </div>
                    <p className="text-[13px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">{stage.blurb}</p>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="mt-5 pt-4 border-t border-[var(--color-border)]">
            <div className="flex items-center gap-1.5 mb-2">
              <RotateCcw className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
              <h3 className="text-[13px] font-semibold text-[var(--color-text-muted)]">Branches and exits</h3>
            </div>
            <div className="divide-y divide-[var(--color-border)]">
              {BRANCHES.map((b) => (
                <div key={b.status} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-bold text-[var(--color-text)]">{b.label}</span>
                    {b.status === current && <span className="ml-auto text-[13px] font-semibold text-[var(--color-text)]">You are here</span>}
                  </div>
                  <p className="text-[13px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">{b.blurb}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
