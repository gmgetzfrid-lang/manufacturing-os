"use client";

// CloseoutSteps - closing out a job, step by step, on the close-out:
// the work done, the PSSR (uploaded right here and read into items), the
// punch list, the turnover package, change orders waiting on a decision,
// the lessons & findings review, then marking the project complete. Each
// says where it stands and opens the place to finish it.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, UploadCloud, ArrowRight } from "lucide-react";
import type { Milestone } from "@/types/schema";
import { gatherProjectSnapshot } from "@/lib/projectSnapshot";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";
import { listChecklists, listChecklistItems, computeChecklistProgress, type Checklist } from "@/lib/checklists";
import { NewChecklistFlow } from "@/components/projects/QualityTab";
import { openFindingsReview } from "@/components/projects/Findings";
import { Modal, ModalBody, ModalHeader } from "@/components/ui/Modal";
import { fmtInTz } from "@/lib/scheduleTz";

/** Ask the project page to go to a tab, or to open Complete. */
export const goToProjectTab = (tab: string) => window.dispatchEvent(new CustomEvent("project:tab", { detail: tab }));
export const askCompleteProject = () => window.dispatchEvent(new CustomEvent("project:complete"));

type Pssr = { list: Checklist; satisfied: number; applicable: number; needsEvidence: number } | null;

export default function CloseoutSteps({ orgId, projectId, projectName, milestones, tz, userId, userEmail, canEdit, phaseName }: {
  orgId: string; projectId: string; projectName?: string; milestones: Milestone[]; tz: string;
  userId?: string; userEmail?: string | null; canEdit: boolean;
  /** The phase being closed out (the phase picked), else the project. */
  phaseName?: string | null;
}) {
  const [snap, setSnap] = useState<ProjectStateSnapshot | null>(null);
  const [pssr, setPssr] = useState<Pssr | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Read again after the PSSR is saved.
  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    void (async () => {
      const [s, lists] = await Promise.all([gatherProjectSnapshot(orgId, projectId).catch(() => null), listChecklists(orgId, projectId).catch(() => [] as Checklist[])]);
      const p = lists.find((c) => c.kind === "pssr" && c.status !== "void") ?? null;
      const prog = p ? computeChecklistProgress(await listChecklistItems(p.id)) : null;
      if (!live) return;
      setSnap(s);
      setPssr(p && prog ? { list: p, satisfied: prog.satisfied, applicable: prog.applicable, needsEvidence: prog.needsEvidence } : null);
    })();
    return () => { live = false; };
  }, [orgId, projectId, tick]);

  // The work: the steps in this close-out (the phase picked, or all).
  const work = useMemo(() => {
    const parents = new Set(milestones.map((m) => m.parentId).filter(Boolean) as string[]);
    const leaves = milestones.filter((m) => m.id && !parents.has(m.id) && !m.isSummary);
    const done = leaves.filter((m) => m.status === "completed" || Number(m.percentComplete ?? 0) >= 100);
    const last = done.map((m) => Date.parse(String(m.actualAt ?? ""))).filter(Number.isFinite);
    return { total: leaves.length, done: done.length, finished: leaves.length > 0 && done.length === leaves.length && last.length ? Math.max(...last) : null };
  }, [milestones]);

  const when = (t: number) => `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;
  type Step = { key: string; title: string; detail: string; ok: boolean | null; action?: React.ReactNode };
  const btn = "inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap";
  const pri = "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12.5px] font-black whitespace-nowrap";
  const steps: Step[] = [
    { key: "work", title: "Work done", ok: work.total > 0 && work.done === work.total,
      detail: work.total === 0 ? "No schedule here yet." : `${work.done} of ${work.total} steps done${work.finished != null ? ` · finished ${when(work.finished)}` : ""}` },
    { key: "pssr", title: "PSSR (pre-startup safety review)",
      ok: pssr === undefined ? null : !!pssr && (pssr.list.status === "complete" || (pssr.applicable > 0 && pssr.satisfied === pssr.applicable)),
      detail: pssr === undefined ? "Checking…" : !pssr ? "Upload your PSSR checklist (PDF). It's saved to the project's documents and read into items you check off; the proof already on file is found for you."
        : `${pssr.list.title}: ${pssr.satisfied} of ${pssr.applicable} items done${pssr.needsEvidence ? ` · ${pssr.needsEvidence} need proof` : ""}${pssr.list.status === "complete" ? " · complete" : ""}`,
      action: !pssr ? (canEdit ? <button type="button" onClick={() => { setErr(null); setUploading(true); }} className={pri}><UploadCloud className="w-4 h-4" /> Upload PSSR</button> : null)
        : <button type="button" onClick={() => goToProjectTab("quality")} className={btn}>Open <ArrowRight className="w-3.5 h-3.5" /></button> },
    { key: "punch", title: "Punch list", ok: snap ? snap.punchOpen === 0 : null,
      detail: !snap ? "Checking…" : snap.punchOpen === 0 ? "Nothing open" : `${snap.punchOpen} open`,
      action: <button type="button" onClick={() => goToProjectTab("quality")} className={btn}>Punch list <ArrowRight className="w-3.5 h-3.5" /></button> },
    { key: "turnover", title: "Turnover package", ok: snap ? snap.turnoverRequired === 0 || snap.turnoverAccepted >= snap.turnoverRequired : null,
      detail: !snap ? "Checking…" : snap.turnoverRequired === 0 ? "Nothing required" : `${snap.turnoverAccepted} of ${snap.turnoverRequired} accepted`,
      action: snap && snap.turnoverRequired > snap.turnoverAccepted ? <button type="button" onClick={() => goToProjectTab("quality")} className={btn}>Turnover <ArrowRight className="w-3.5 h-3.5" /></button> : undefined },
    { key: "co", title: "Change orders", ok: snap ? snap.openChangeOrders === 0 : null,
      detail: !snap ? "Checking…" : snap.openChangeOrders === 0 ? "None waiting on a decision" : `${snap.openChangeOrders} waiting on a decision`,
      action: snap && snap.openChangeOrders > 0 ? <button type="button" onClick={() => goToProjectTab("costs")} className={btn}>Decide <ArrowRight className="w-3.5 h-3.5" /></button> : undefined },
    { key: "lessons", title: "Lessons & findings", ok: null, detail: "Keep what this job taught for next time.",
      action: <button type="button" onClick={openFindingsReview} className={btn}>Review</button> },
  ];
  const ready = steps.filter((s) => s.ok === false).length;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="px-3.5 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2">
        <b className="text-[13.5px] text-[var(--color-text)]">Close out{phaseName ? ` ${phaseName}` : ""}</b>
        <span className="text-[12px] text-[var(--color-text-muted)]">{ready === 0 && snap ? "every step clear" : `${ready} step${ready === 1 ? "" : "s"} to finish`}</span>
      </div>
      <ol className="divide-y divide-[var(--color-border)]">
        {steps.map((s, i) => (
          <li key={s.key} className="px-3.5 py-2.5 flex items-start gap-3">
            <span className={`mt-0.5 w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[12px] font-black ${s.ok ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : s.ok === false ? "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
              {s.ok ? <Check className="w-3.5 h-3.5" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-bold text-[var(--color-text)]">{s.title}</div>
              <div className="text-[12px] text-[var(--color-text-muted)] leading-snug">{s.detail}</div>
            </div>
            {s.action && <div className="shrink-0">{s.action}</div>}
          </li>
        ))}
      </ol>
      {canEdit && (
        <div className="px-3.5 py-2.5 border-t border-[var(--color-border)] flex justify-end">
          <button type="button" onClick={askCompleteProject} className={pri}><Check className="w-4 h-4" /> Mark the project complete</button>
        </div>
      )}
      {uploading && (
        <Modal onClose={() => setUploading(false)} size="lg">
          <ModalHeader icon={UploadCloud} title="Upload the PSSR" subtitle="Saved to this project's documents, then read into checklist items. You check them before anything is kept." onClose={() => setUploading(false)} />
          <ModalBody className="!p-0">
            {err && <div role="alert" className="px-4 pt-3 text-[12.5px] font-semibold text-rose-700 dark:text-rose-400">{err}</div>}
            <NewChecklistFlow orgId={orgId} projectId={projectId} projectName={projectName} actor={{ uid: userId ?? "", email: userEmail ?? null }}
              onDone={() => { setUploading(false); load(); }} onCancel={() => setUploading(false)} setErr={setErr} kindDefault="pssr" />
          </ModalBody>
        </Modal>
      )}
    </div>
  );
}
