"use client";

// WorkOrdersView: the job by work order. Each WO's equipment, crews,
// plan against actual (start and finish), how far along it is, and how
// many hours ahead or behind. Search for a WO number, equipment, step or
// crew. Open one and its steps are there to update, each with the step
// card: start, %, finish, fix times, and the history with Edit. Steps with
// no WO are listed under their equipment. Print puts the work orders shown
// on paper, every one opened up with all its steps, in a format of its own
// — report, report with history, or the pen-and-paper field tracker
// (lib/workOrdersPrint) — without changing the view.

import React, { useMemo, useState } from "react";
import { Search, ChevronRight, Printer, Ban, Plus } from "lucide-react";
import type { Milestone } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import type { ShiftTimes } from "@/lib/shiftReport";
import { dayKey, dayKeyToMs } from "@/lib/scheduleTz";
import { whenDated } from "@/lib/timeWords";
import { ADDED } from "@/lib/discovery";
import type { PathMarks } from "@/lib/criticalPath";
import CalendarQuickView, { type StepUpdate } from "@/components/projects/CalendarQuickView";
import { useLetterhead } from "@/lib/letterheadStore";
import type { PrintFormat } from "@/lib/workOrdersPrint";
import { groupWorkOrders, showsOrder, findOrders, fieldOrdersOf, workOrdersPrintDocument, SHOW_WORD, STANDING, descOf, type Show, type WorkOrder } from "@/lib/workOrderGroups";
import { printHtml } from "@/lib/updatePrint";
import type { ReportLink } from "@/lib/reportLinks";
import { useProjectWord } from "@/components/projects/ProjectTypeContext";
import { fieldTrackerFor, type FieldOrder } from "@/lib/fieldTracker";
import FieldTrackerPrint, { type FieldChoice } from "@/components/projects/FieldTrackerPrint";
import { CancelJobForm } from "@/components/projects/CancelledJobs";
import AddWorkPicker from "@/components/projects/AddWorkPicker";

export default function WorkOrdersView({ milestones, childrenByParent, tz, times, progress, canEdit, onUpdate, onFixTimes, onOpenDetail, onMoveDays, marks, onDiscovery, onNewWorkOrder, projectId, projectName, user, onCancelled, onOpenReport }: {
  milestones: Milestone[];
  /** Print opens the report in Reports, set to the work orders shown (or one). */
  onOpenReport?: (link: ReportLink) => void;
  /** For printing: the project's letterhead, history and name. */
  projectId?: string; projectName?: string;
  /** Who's working: cancelling a work order is stamped with it. */
  user?: { id: string; name?: string; email?: string };
  /** A work order came off the schedule. */
  onCancelled?: () => void;
  childrenByParent: Map<string, Milestone[]>;
  tz: string; times: ShiftTimes;
  progress?: Map<string, ProgressInfo>;
  canEdit: boolean;
  onUpdate?: (id: string, u: StepUpdate) => Promise<boolean>;
  onFixTimes?: (id: string, t: { start?: number | null; finish?: number | null }) => Promise<boolean>;
  onOpenDetail?: (m: Milestone) => void;
  onMoveDays?: (id: string, delta: number) => void;
  marks?: PathMarks;
  onDiscovery?: (task: Milestone) => void;
  /** A work order of its own (DiscoveryForm, new). */
  onNewWorkOrder?: () => void;
}) {
  const [now] = useState(() => Date.now());
  const word = useProjectWord();
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  // The work order being taken off the schedule (its key).
  const [cancelling, setCancelling] = useState<string | null>(null);
  // Adding discovery or added scope: which work order first.
  const [picking, setPicking] = useState(false);

  const orders = useMemo(() => groupWorkOrders(milestones, childrenByParent, progress, tz, times, now), [milestones, childrenByParent, progress, tz, times, now]);

  const is = (k: Show) => (o: WorkOrder) => showsOrder(o, k, marks);
  const found = findOrders(orders, query);
  // One you have open stays while you work in it, whatever the filter.
  const shown = found.filter((o) => showsOrder(o, show, marks) || open.has(o.key));
  const today = dayKey(now, tz);
  // Always with its date — a multi-week job has more than one Monday.
  const fmt = (t: number) => whenDated(t, tz);
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  // ── Print: the work orders shown, each opened up with all its steps.
  const { lh } = useLetterhead(projectId);
  const [printMenu, setPrintMenu] = useState(false);
  const [printMsg, setPrintMsg] = useState<string | null>(null);
  const printIt = async (format: PrintFormat) => {
    setPrintMenu(false); setPrintMsg(null);
    // Opened at the tap, so the browser doesn't take it for a pop-up.
    const w = window.open("", "_blank");
    if (!w) { setPrintMsg("Your browser blocked the print window - allow pop-ups for this site and try again."); return; }
    w.document.write(`<p style="font:14px Arial,sans-serif;padding:24px">Getting ${shown.length} work order${shown.length === 1 ? "" : "s"} ready to print…</p>`);
    try {
      const scope = `${SHOW_WORD[show]}${query.trim() ? ` · search “${query.trim()}”` : ""}${format === "history" ? " · with each step's history" : ""}`;
      printHtml(await workOrdersPrintDocument({ shown, milestones, projectId, projectName, tz, times, progress, format, scope, lh, word }), w);
    } catch (e) {
      w.document.body.textContent = `Couldn't get the work orders ready: ${(e as Error).message}`;
    }
  };

  // ── The field tracker: a blank form to fill in by pen (lib/fieldTracker),
  // every work order on the schedule, whatever the view shows.
  const [fieldOpen, setFieldOpen] = useState(false);
  const fieldOrders = useMemo<FieldOrder[]>(() => fieldOrdersOf(orders), [orders]);
  const printField = (c: FieldChoice) => {
    setFieldOpen(false); setPrintMsg(null);
    const project = projectName?.trim() || "Schedule";
    if (!printHtml(fieldTrackerFor(c, { project, tz, orders: fieldOrders, dayMs: (d) => dayKeyToMs(d, tz) }))) setPrintMsg("Your browser blocked the print window - allow pop-ups for this site and try again.");
  };


  return (
    <div className="space-y-2">
      {fieldOpen && <FieldTrackerPrint orders={fieldOrders} today={today} onPrint={printField} onClose={() => setFieldOpen(false)} />}
      {picking && onDiscovery && (
        <AddWorkPicker day={today} tz={tz} milestones={milestones}
          onPick={(t) => { setPicking(false); onDiscovery(t); }} onNew={onNewWorkOrder ? () => { setPicking(false); onNewWorkOrder(); } : undefined} onClose={() => setPicking(false)} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 h-9 flex-1 min-w-[220px] max-w-[420px] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 focus-within:border-[var(--color-accent-ring)]">
          <Search className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="WO #, equipment, step, crew…" aria-label="Search work orders"
            className="flex-1 min-w-0 bg-transparent text-[13px] outline-none" />
          {query && <button type="button" onClick={() => setQuery("")} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Clear</button>}
        </label>
        <div className="inline-flex flex-wrap gap-1" role="group" aria-label="Show">
          {([["all", "All"], ["open", "Open"], ["critical", "Critical path"], ["behind", "Behind"], ["notStarted", "Not started"], ["held", "Held"], ["done", "Done"], ["added", "Discovery & added"]] as const).map(([k, l]) => {
            const n = found.filter(is(k)).length;
            return (
              <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)}
                className={`h-8 px-2.5 rounded-full border text-[12px] font-semibold ${show === k ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                {l} <span className="tabular-nums opacity-80">{n}</span>
              </button>
            );
          })}
        </div>
        {canEdit && onNewWorkOrder && (
          <button type="button" onClick={() => onNewWorkOrder()}
            className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[12px] font-bold text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]">
            <Plus className="w-3.5 h-3.5" /> New work order
          </button>
        )}
        {canEdit && onDiscovery && (
          <button type="button" onClick={() => setPicking(true)}
            className={`${onNewWorkOrder ? "" : "ml-auto "}inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-dashed border-[var(--color-accent)] text-[12px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]`}>
            <Plus className="w-3.5 h-3.5" /> Add to a work order
          </button>
        )}
        <span className={`relative inline-flex ${canEdit && (onDiscovery || onNewWorkOrder) ? "" : "ml-auto"}`}>
          <button type="button" onClick={() => setPrintMenu((v) => !v)} aria-expanded={printMenu} disabled={shown.length === 0}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
          {printMenu && (
            <>
              <span className="fixed inset-0 z-[40]" onClick={() => setPrintMenu(false)} aria-hidden />
              <span className="absolute right-0 top-full mt-1 z-[41] w-72 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-1.5 flex flex-col text-[12px]">
                <span className="px-2 pt-1 pb-1.5 text-[11px] text-[var(--color-text-muted)]">The {shown.length} work order{shown.length === 1 ? "" : "s"} shown, each opened up with all its steps. Your view here stays as it is.</span>
                <button type="button" onClick={() => { if (onOpenReport) { setPrintMenu(false); onOpenReport({ id: "workorders", show, query, also: [...open] }); } else void printIt("report"); }} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)]">
                  <span className="font-semibold">Report</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">Plan, actual, status, % and the latest comment</span>
                </button>
                <button type="button" onClick={() => { if (onOpenReport) { setPrintMenu(false); onOpenReport({ id: "workorders", show, query, also: [...open], history: true }); } else void printIt("history"); }} disabled={!projectId} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                  <span className="font-semibold">Report with history</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">Every start, % update, hold and comment, with its time</span>
                </button>
                <button type="button" onClick={() => { setPrintMenu(false); if (onOpenReport) onOpenReport({ id: "field" }); else setFieldOpen(true); }} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)]">
                  <span className="font-semibold">Field tracker - fill in by pen</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">A blank form: the whole job, one work order, one step, or a date range</span>
                </button>
              </span>
            </>
          )}
        </span>
      </div>
      {printMsg && <div role="alert" className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{printMsg}</div>}

      {shown.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">
          {orders.length === 0 ? "No steps on the schedule yet." : "No work orders match."}
        </div>
      ) : (
        <ul className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden divide-y divide-[var(--color-border)]">
          {shown.map((o) => {
            const isOpen = open.has(o.key);
            const st = STANDING[o.standing];
            const single = o.steps.length === 1 && o.steps[0].id === o.owner.id;
            return (
              <li key={o.key}>
                <button type="button" onClick={() => toggle(o.key)} aria-expanded={isOpen}
                  className={`w-full text-left px-3 py-2.5 hover:bg-[var(--color-surface-2)] ${isOpen ? "bg-[var(--color-surface-2)]" : ""}`}>
                  <div className="flex items-start gap-2">
                    <ChevronRight className={`w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)] transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className={`font-mono text-[12.5px] font-bold ${o.wo ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{o.wo ? `WO ${o.wo}` : "No WO"}</span>
                        <span className="text-[13px] font-semibold text-[var(--color-text)] break-words">{o.owner.name}</span>
                      </div>
                      {descOf(o.owner) && <div className="text-[12px] text-[var(--color-text)] line-clamp-2 break-words">{descOf(o.owner)}</div>}
                      <div className="text-[11.5px] text-[var(--color-text-muted)]">
                        {[o.crews.join(", ") || null, single ? null : `${o.done} of ${o.steps.length} steps done`].filter(Boolean).join(" · ")}
                        {o.added.map((x) => (
                          <span key={x.kind} className={`ml-1.5 font-semibold ${x.kind === "added" ? "text-teal-700 dark:text-teal-300" : "text-violet-700 dark:text-violet-300"}`} title={ADDED[x.kind].tip}>
                            + {x.n} {ADDED[x.kind].lower} step{x.n === 1 ? "" : "s"} ({x.h} h)
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[11.5px]">
                        <span className="text-[var(--color-text-muted)]">Plan</span>
                        <span className="text-[var(--color-text)]">{fmt(o.planStart)} → {fmt(o.planFinish)}</span>
                        <span className="text-[var(--color-text-muted)]">Actual</span>
                        <span className="font-semibold text-[var(--color-text)]">{Number.isFinite(o.actStart) ? `${fmt(o.actStart)} → ${Number.isFinite(o.actFinish) ? fmt(o.actFinish) : "…"}` : "not started"}</span>
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold ${st.cls}`}>{st.word}</span>
                      <span className="text-[12px] font-bold tabular-nums text-[var(--color-text)]">{o.pct}%</span>
                      {o.standing !== "done" && Math.abs(o.hours) >= 0.1 && (
                        <span className={`font-mono text-[11px] font-bold ${o.hours < 0 ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{o.hours > 0 ? "+" : "−"}{Math.abs(o.hours)} h</span>
                      )}
                    </div>
                  </div>
                  {/* Done against where the plan says it should be by now. */}
                  <span className="relative mt-1.5 ml-6 block h-1.5 rounded-full bg-slate-200 dark:bg-slate-700" aria-hidden>
                    <span className={`absolute inset-y-0 left-0 rounded-full ${o.standing === "done" ? "bg-emerald-500" : "bg-[var(--color-text)]"}`} style={{ width: `${Math.min(100, o.pct)}%` }} />
                    {o.standing !== "done" && <span className="absolute -top-[3px] w-0.5 h-3 bg-rose-700" style={{ left: `calc(${Math.min(100, o.plan)}% - 1px)` }} title={`Plan ${o.plan}% by now`} />}
                  </span>
                </button>
                {isOpen && (
                  <div className="border-t border-[var(--color-border)]">
                    {((canEdit && onDiscovery) || onOpenReport) && (
                      <div className="px-3 pt-2 flex flex-wrap gap-1.5">
                        {canEdit && onDiscovery && (
                          <button type="button" onClick={() => onDiscovery(o.owner)}
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-dashed border-[var(--color-accent)] text-[12px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
                            <Plus className="w-3.5 h-3.5" /> Add discovery or added scope to this work order
                          </button>
                        )}
                        {onOpenReport && (
                          <button type="button" onClick={() => onOpenReport({ id: "workorders", wo: o.key })} title="This work order in Reports, ready to print"
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-[12px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                            <Printer className="w-3.5 h-3.5" /> Print this work order
                          </button>
                        )}
                      </div>
                    )}
                    <CalendarQuickView whole task={o.owner} onDay={o.steps} others={[]} dayKey={today} band={null} dayLabel="" marks={marks}
                      tz={tz} times={times} progress={progress} canEdit={canEdit}
                      onUpdate={onUpdate} onFixTimes={onFixTimes} onOpenDetail={onOpenDetail} onMoveDays={canEdit ? onMoveDays : undefined} onDiscovery={onDiscovery} />
                    {/* Off this schedule — still done, somewhere else (Put back is above the schedule). */}
                    {canEdit && user && o.owner.id && (
                      <div className="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-surface-2)]/50">
                        {cancelling === o.key ? (
                          <CancelJobForm id={o.owner.id} name={`${o.wo ? `WO ${o.wo} · ` : ""}${o.owner.name}`} steps={o.steps.length}
                            userId={user.id} userName={user.name} userEmail={user.email}
                            onClose={() => setCancelling(null)}
                            onDone={() => { setCancelling(null); toggle(o.key); onCancelled?.(); }} />
                        ) : (
                          <button type="button" onClick={() => setCancelling(o.key)} title="Planned, but not done here: kept on record as cancelled, with why (and where it moved)"
                            className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 px-2 py-1 rounded-md">
                            <Ban className="w-3.5 h-3.5" /> Cancel work order
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="px-1 text-[11px] text-[var(--color-text-muted)]">{shown.length} of {orders.length} work orders · tap one to update its steps</div>
    </div>
  );
}
