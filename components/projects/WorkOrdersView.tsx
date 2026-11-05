"use client";

// WorkOrdersView: the job by work order. Each WO's equipment, crews,
// plan against actual (start and finish), how far along it is, and how
// many hours ahead or behind. Search for a WO number, equipment, step or
// crew. Open one and its steps are there to update, each with the step
// card: start, %, finish, fix times, and the history with Edit. Steps with
// no WO are listed under their equipment. Print puts the work orders shown
// on paper, every one opened up with all its steps, in a format of its own
// — report, or report with history (lib/workOrdersPrint) — without
// changing the view; the shift sheet for the field is in Reports.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, ChevronDown, ChevronUp, Printer, Ban, Plus, Lightbulb } from "lucide-react";
import { notesFor } from "@/lib/milestones";
import { loadProgressLog, type ProgressLogRow } from "@/lib/progressHistory";
import { newFinding } from "@/components/projects/Findings";
import type { Milestone, MilestoneNote } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import type { ShiftTimes } from "@/lib/shiftReport";
import { dayKey } from "@/lib/scheduleTz";
import { whenDated } from "@/lib/timeWords";
import { ADDED } from "@/lib/discovery";
import type { PathMarks } from "@/lib/criticalPath";
import CalendarQuickView, { type StepUpdate } from "@/components/projects/CalendarQuickView";
import { useLetterhead } from "@/lib/letterheadStore";
import type { PrintFormat } from "@/lib/workOrdersPrint";
import { groupWorkOrders, showsOrder, findOrders, workOrdersPrintDocument, SHOW_WORD, STANDING, descOf, type Show, type WorkOrder } from "@/lib/workOrderGroups";
import { printHtml } from "@/lib/updatePrint";
import type { ReportLink } from "@/lib/reportLinks";
import { useProjectWord } from "@/components/projects/ProjectTypeContext";
import { CancelJobForm } from "@/components/projects/CancelledJobs";
import AddWorkPicker from "@/components/projects/AddWorkPicker";
import { useWoClasses, passes, WoClassSelects } from "@/components/projects/WoClassFilter";
import { typeLabel, unitLabel } from "@/lib/woClass";

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
  // Who: the crew named on the steps ("" = steps with no crew named).
  const [who, setWho] = useState<string | null>(null);
  // Unit and equipment type (Setup › Units & equipment).
  const [units, setUnits] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // The work order being taken off the schedule (its key).
  const [cancelling, setCancelling] = useState<string | null>(null);
  // Adding discovery or added scope: which work order first.
  const [picking, setPicking] = useState(false);

  const orders = useMemo(() => groupWorkOrders(milestones, childrenByParent, progress, tz, times, now), [milestones, childrenByParent, progress, tz, times, now]);

  const is = (k: Show) => (o: WorkOrder) => showsOrder(o, k, marks);
  // Each step's own crew, as named on it: a blank one is "no crew named",
  // so names taken off by mistake can be found and put right.
  const crewOf = (m: Milestone) => m.responsibleParty?.trim() ?? "";
  const crewKey = (c: string) => c.trim().toLowerCase();
  const whoList = useMemo(() => {
    const n = new Map<string, { name: string; steps: number }>();
    for (const o of orders) for (const st of o.steps) { const c = crewOf(st); const k = crewKey(c); const cur = n.get(k) ?? { name: c, steps: 0 }; cur.steps++; n.set(k, cur); }
    return [...n.entries()].sort((a, b) => Number(a[0] === "") - Number(b[0] === "") || a[1].name.localeCompare(b[1].name, undefined, { numeric: true }));
  }, [orders]);
  const byWho = (o: WorkOrder) => who == null || o.steps.some((st) => crewKey(crewOf(st)) === who);
  const wc = useWoClasses(projectId, milestones);
  const found = findOrders(orders, query).filter(byWho).filter((o) => passes(wc, o.owner, units, types));
  // One you have open stays while you work in it, whatever the filter.
  const shown = found.filter((o) => showsOrder(o, show, marks) || open.has(o.key));
  const today = dayKey(now, tz);
  // Always with its date — a multi-week job has more than one Monday.
  const fmt = (t: number) => whenDated(t, tz);

  // Every step's comments and history, read once for the whole list (and
  // again after a change): a work order opens complete, nothing moves in
  // after it's open.
  const stepKey = useMemo(() => orders.flatMap((o) => o.steps.map((x) => x.id)).filter((x): x is string => !!x).sort().join(","), [orders]);
  const sig = useMemo(() => milestones.map((m) => `${m.id}:${m.status}:${m.percentComplete ?? 0}`).join("|"), [milestones]);
  const [pre, setPre] = useState<{ notes: MilestoneNote[]; log: ProgressLogRow[] } | null>(null);
  const [preTick, setPreTick] = useState(0);
  useEffect(() => {
    const on = () => setPreTick((t) => t + 1);
    window.addEventListener("milestone-notes:changed", on);
    return () => window.removeEventListener("milestone-notes:changed", on);
  }, []);
  useEffect(() => {
    if (!stepKey) return;
    let alive = true;
    const pid = projectId ?? milestones[0]?.projectId;
    Promise.all([
      notesFor(stepKey.split(",")).catch(() => [] as MilestoneNote[]),
      pid ? loadProgressLog(pid).then((l) => l ?? []).catch(() => [] as ProgressLogRow[]) : Promise.resolve([] as ProgressLogRow[]),
    ]).then(([notes, log]) => { if (alive) setPre({ notes, log }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the steps, their status or the comments change
  }, [stepKey, sig, preTick, projectId]);

  // Opening or closing a work order keeps its header where it was under
  // your finger; closed from below (the Close button, or its header held
  // at the top while you scrolled its steps), it lands at the top.
  const heads = useRef(new Map<string, HTMLElement>());
  const scroller = (el: HTMLElement): { top: number; by: (dy: number) => void } => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return { top: p.getBoundingClientRect().top, by: (dy) => p.scrollBy(0, dy) };
    }
    return { top: 0, by: (dy) => window.scrollBy(0, dy) };
  };
  const toggle = (k: string) => {
    const el = heads.current.get(k);
    const sc = el ? scroller(el) : null;
    const before = el ? el.getBoundingClientRect().top : null;
    const closing = open.has(k);
    setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
    if (!el || !sc || before == null) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const after = el.getBoundingClientRect().top;
      // Where it should be: where it was, or the top when it was stuck there.
      const want = closing && before <= sc.top + 2 ? sc.top + 8 : before;
      if (Math.abs(after - want) > 1) sc.by(after - want);
    }));
  };

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

  // A work order's crews, dates and progress: in its header while closed;
  // open, just under it, so the header held at the top stays short.
  // Its equipment type and unit, when known: "Exchangers, LRU".
  const classWords = (m: Milestone) => {
    const c = wc.classOf(m);
    if (!c || !wc.book) return null;
    const unitShort = (code: string) => { const l = unitLabel(code, wc.book!); return l.match(/\(([^)]+)\)\s*$/)?.[1] ?? l; };
    return [c.type ? typeLabel(c.type, wc.book) : null, c.unit && wc.choices.units.length > 1 ? unitShort(c.unit) : null].filter(Boolean).join(", ") || null;
  };
  const detailsOf = (o: WorkOrder) => {
    const single = o.steps.length === 1 && o.steps[0].id === o.owner.id;
    return (
      <>
        {descOf(o.owner) && <div className="text-[12px] text-[var(--color-text)] line-clamp-2 break-words">{descOf(o.owner)}</div>}
        <div className="text-[11.5px] text-[var(--color-text-muted)]">
          {[classWords(o.owner), o.crews.join(", ") || null, single ? null : `${o.done} of ${o.steps.length} steps done`].filter(Boolean).join(" · ")}
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
      </>
    );
  };
  // Done against where the plan says it should be by now.
  const barOf = (o: WorkOrder) => (
    <span className="relative mt-1.5 ml-9 block h-1.5 rounded-full bg-slate-200 dark:bg-slate-700" aria-hidden>
      <span className={`absolute inset-y-0 left-0 rounded-full ${o.standing === "done" ? "bg-emerald-500" : "bg-[var(--color-text)]"}`} style={{ width: `${Math.min(100, o.pct)}%` }} />
      {o.standing !== "done" && <span className="absolute -top-[3px] w-0.5 h-3 bg-rose-700" style={{ left: `calc(${Math.min(100, o.plan)}% - 1px)` }} title={`Plan ${o.plan}% by now`} />}
    </span>
  );

  return (
    <div className="space-y-2">
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
        <select value={who ?? "__all"} onChange={(e) => setWho(e.target.value === "__all" ? null : e.target.value)} aria-label="Who"
          className={`h-8 rounded-lg border px-2 text-[12px] font-semibold ${who != null ? "border-[var(--color-accent)] text-[var(--color-text)]" : "border-[var(--color-border-strong)] text-[var(--color-text)]"} bg-[var(--color-surface)]`}>
          <option value="__all">Everyone</option>
          {whoList.map(([k, x]) => <option key={k || "__none"} value={k}>{k ? x.name : "No crew named"} ({x.steps} step{x.steps === 1 ? "" : "s"})</option>)}
        </select>
        <WoClassSelects c={wc} units={units} types={types} onUnits={setUnits} onTypes={setTypes} />
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
                <button type="button" onClick={() => { if (onOpenReport) { setPrintMenu(false); onOpenReport({ id: "workorders", show, query, also: [...open], units, types }); } else void printIt("report"); }} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)]">
                  <span className="font-semibold">Report</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">Plan, actual, status, % and the latest comment</span>
                </button>
                <button type="button" onClick={() => { if (onOpenReport) { setPrintMenu(false); onOpenReport({ id: "workorders", show, query, also: [...open], history: true, units, types }); } else void printIt("history"); }} disabled={!projectId} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                  <span className="font-semibold">Report with history</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">Every start, % update, hold and comment, with its time</span>
                </button>
                {onOpenReport && (
                  <button type="button" onClick={() => { setPrintMenu(false); onOpenReport({ id: "sheet" }); }} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)]">
                    <span className="font-semibold">Shift sheet - fill in by pen</span>
                    <span className="block text-[11px] text-[var(--color-text-muted)]">One page for the coming shift: only its work, by equipment</span>
                  </button>
                )}
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
        <ul className="space-y-2">
          {shown.map((o) => {
            const isOpen = open.has(o.key);
            const st = STANDING[o.standing];
            const single = o.steps.length === 1 && o.steps[0].id === o.owner.id;
            const name = `${o.wo ? `WO ${o.wo}` : "No WO"} ${o.owner.name}`;
            return (
              // Each work order its own card; open, it's framed in the accent
              // colour and its steps sit inside it, indented on a grey panel.
              <li key={o.key} className={`rounded-xl border bg-[var(--color-surface)] ${isOpen ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] shadow-md" : "border-[var(--color-border)] shadow-sm"}`}>
                <button type="button" onClick={() => toggle(o.key)} aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Open"} ${name}`}
                  ref={(el) => { if (el) heads.current.set(o.key, el); else heads.current.delete(o.key); }}
                  className={`w-full text-left px-3 py-2.5 rounded-t-[10px] ${isOpen ? "sticky top-0 z-20 bg-[var(--color-accent-soft)] border-b border-[var(--color-accent)]/30" : "rounded-b-[10px] hover:bg-[var(--color-surface-2)]"}`}>
                  <div className="flex items-start gap-2.5">
                    <span className={`mt-0.5 shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full border ${isOpen ? "bg-[var(--color-accent)] border-[var(--color-accent)] text-[var(--color-accent-fg)]" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`} aria-hidden>
                      {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className={`font-mono text-[12.5px] font-bold ${o.wo ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{o.wo ? `WO ${o.wo}` : "No WO"}</span>
                        <span className="text-[14px] font-bold text-[var(--color-text)] break-words">{o.owner.name}{o.also?.map((x) => <span key={x.id} className="text-[var(--color-text-muted)]"> · {x.name}</span>)}</span>
                      </div>
                      {!isOpen && detailsOf(o)}
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold ${st.cls}`}>{st.word}</span>
                      <span className="text-[12px] font-bold tabular-nums text-[var(--color-text)]">{o.pct}%</span>
                      {o.standing !== "done" && Math.abs(o.hours) >= 0.1 && (
                        <span className={`font-mono text-[11px] font-bold ${o.hours < 0 ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{o.hours > 0 ? "+" : "−"}{Math.abs(o.hours)} h</span>
                      )}
                    </div>
                  </div>
                  {!isOpen && barOf(o)}
                </button>
                {isOpen && (
                  <div className="rounded-b-[10px] bg-slate-100/80 dark:bg-slate-900/60">
                    <div className="px-3 pt-2 pb-2.5 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
                      <div className="ml-9">{detailsOf(o)}</div>
                      {barOf(o)}
                    </div>
                    {(canEdit || onOpenReport) && (
                      <div className="px-3 pt-2.5 flex flex-wrap gap-1.5">
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
                        {canEdit && o.owner.id && (
                          <button type="button" onClick={() => newFinding({ milestoneId: o.owner.id })} title="A problem, a lesson, a material shortfall or missed scope on this work order - kept for the next job"
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-[12px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                            <Lightbulb className="w-3.5 h-3.5" /> + Finding
                          </button>
                        )}
                      </div>
                    )}
                    {/* Its steps: inside the work order, indented, each a row that opens to its card. */}
                    <div className="px-2 sm:px-3 pt-2.5 pb-1">
                      <div className="ml-2 sm:ml-5 pl-2 sm:pl-3 border-l-2 border-[var(--color-accent)]/40">
                        <div className="mb-1 text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                          {single ? "The step" : `Steps · ${o.done} of ${o.steps.length} done`}
                        </div>
                        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
                          <CalendarQuickView whole task={o.owner} onDay={o.steps} others={[]} dayKey={today} band={null} dayLabel="" marks={marks}
                            tz={tz} times={times} progress={progress} canEdit={canEdit} preloaded={pre}
                            onUpdate={onUpdate} onFixTimes={onFixTimes} onOpenDetail={onOpenDetail} onMoveDays={canEdit ? onMoveDays : undefined} onDiscovery={onDiscovery} />
                        </div>
                      </div>
                    </div>
                    {/* Off this schedule — still done, somewhere else (Put back is above the schedule). */}
                    {canEdit && user && o.owner.id && (
                      <div className="px-3 py-2">
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
                    {/* Close it from the bottom: no scrolling back up. */}
                    <button type="button" onClick={() => toggle(o.key)} aria-label={`Close ${name}`}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-b-[10px] border-t border-[var(--color-border)] text-[12px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
                      <ChevronUp className="w-4 h-4" /> Close {o.wo ? `WO ${o.wo}` : o.owner.name}
                    </button>
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
