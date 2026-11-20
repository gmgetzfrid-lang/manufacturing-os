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

import { EquipmentField } from "@/components/projects/EquipmentPicker";
import { searchFilter } from "@/lib/fuzzySearch";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, ChevronDown, ChevronUp, Printer, Ban, Plus, Lightbulb } from "lucide-react";
import { notesFor } from "@/lib/milestones";
import { loadProgressLog, type ProgressLogRow } from "@/lib/progressHistory";
import { JobFindings, newFinding } from "@/components/projects/Findings";
import { equipmentOf } from "@/lib/findings";
import type { Milestone, MilestoneNote } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import type { ShiftTimes } from "@/lib/shiftReport";
import { dayKey } from "@/lib/scheduleTz";
import { whenDated } from "@/lib/timeWords";
import { ADDED } from "@/lib/discovery";
import { workOrderOrigin } from "@/lib/origin";
import type { PathMarks } from "@/lib/criticalPath";
import CalendarQuickView, { type StepUpdate } from "@/components/projects/CalendarQuickView";
import { useLetterhead } from "@/lib/letterheadStore";
import type { PrintFormat } from "@/lib/workOrdersPrint";
import { groupWorkOrders, showsOrder, findOrders, workOrdersPrintDocument, SHOW_WORD, STANDING, descOf, type Show, type WorkOrder } from "@/lib/workOrderGroups";
import { printHtml } from "@/lib/updatePrint";
import type { ReportLink } from "@/lib/reportLinks";
import { useProjectWord } from "@/components/projects/ProjectTypeContext";
import { CancelJobForm, CancelledJobsList } from "@/components/projects/CancelledJobs";
import type { CancelledJob } from "@/lib/cancelledJobs";
import AddWorkPicker from "@/components/projects/AddWorkPicker";
import { useWoClasses, passes, WoClassSelects } from "@/components/projects/WoClassFilter";
import { typeLabel, unitLabel } from "@/lib/woClass";
import MoreMenu from "@/components/ui/MoreMenu";

// A quiet button on the white card; the one orange one is New work order.
const QUIET = "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-[10px] bg-[var(--color-surface-2)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-border)] disabled:opacity-50 transition-colors";
// The list: this many work orders, then "Show N more".
const WO_STEP = 40;

export default function WorkOrdersView({ milestones, cancelled = [], childrenByParent, tz, times, progress, canEdit, onUpdate, onFixTimes, onOpenDetail, onMoveDays, marks, onDiscovery, onNewWorkOrder, projectId, projectName, user, onCancelled, onOpenReport, quietMain = false }: {
  milestones: Milestone[];
  /** The page's one orange action is elsewhere (the band): New work order is quiet. */
  quietMain?: boolean;
  /** Work orders taken off the schedule: the Cancelled filter. */
  cancelled?: CancelledJob[];
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
  // The Cancelled filter: the jobs taken off the schedule, not the live ones.
  const [showCancelled, setShowCancelled] = useState(false);
  const cancelledShown = useMemo(() => {
    const q = query.trim();
    return q ? searchFilter(cancelled, q, (j) => [j.m.workOrderRef, j.m.name, ...j.crumbs, j.m.movedTo, j.m.cancelNote, j.m.cancelledByName].filter(Boolean).join(" ")) : cancelled;
  }, [cancelled, query]);
  // Who: the crew named on the steps ("" = steps with no crew named).
  const [who, setWho] = useState<string | null>(null);
  // Unit and equipment type (Setup › Units & equipment).
  const [units, setUnits] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // How many work orders the list shows before "Show N more".
  const [limit, setLimit] = useState(WO_STEP);
  // The work order being taken off the schedule (its key).
  const [cancelling, setCancelling] = useState<string | null>(null);
  // Adding discovery or added scope: which work order first.
  const [picking, setPicking] = useState(false);

  const orders = useMemo(() => groupWorkOrders(milestones, childrenByParent, progress, tz, times, now), [milestones, childrenByParent, progress, tz, times, now]);
  const byIdAll = useMemo(() => new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m])), [milestones]);

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
  // A read that failed says so, instead of looking like "no comments yet".
  const [preErr, setPreErr] = useState(false);
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
    let failed = false;
    Promise.all([
      notesFor(stepKey.split(",")).catch(() => { failed = true; return [] as MilestoneNote[]; }),
      pid ? loadProgressLog(pid).then((l) => l ?? []).catch(() => { failed = true; return [] as ProgressLogRow[]; }) : Promise.resolve([] as ProgressLogRow[]),
    ]).then(([notes, log]) => { if (alive) { setPre({ notes, log }); setPreErr(failed); } });
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
    if (!w) { setPrintMsg("Your browser blocked the print window. Allow pop-ups for this site and try again."); return; }
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
  // Where it came from: imported with the schedule, or added during the
  // job (what for, who found it, who added it, who approved it, when).
  const originBlock = (o: WorkOrder) => {
    const w = workOrderOrigin(o.owner, o.steps, fmt);
    const block = (key: string, lines: string[], tone?: string) => (
      <div key={key} className="text-[11.5px] leading-snug">
        {lines.map((l, i) => <div key={l} className={i === 0 ? `font-semibold ${tone ?? "text-[var(--color-text)]"}` : "text-[var(--color-text-muted)]"}>{l}</div>)}
      </div>
    );
    const toneOf = (k: string) => (k === "added" ? "text-[var(--color-text)] dark:text-[var(--color-text)]" : k === "discovery" ? "text-[var(--color-text)] dark:text-[var(--color-text)]" : undefined);
    return (
      <div className="ml-9 mt-2 space-y-1.5">
        <div className="text-[12px] font-semibold text-[var(--color-text-faint)]">Where it came from</div>
        {block("own", w.own.lines, toneOf(w.own.kind))}
        {w.added.map((a, i) => block(`a${i}`, [`${a.lines[0]} (${a.steps} step${a.steps === 1 ? "" : "s"})`, ...a.lines.slice(1)], toneOf(a.lines[0].startsWith(ADDED.added.word) ? "added" : "discovery")))}
        {w.byHand && block("hand", w.byHand.lines)}
      </div>
    );
  };
  const detailsOf = (o: WorkOrder) => {
    const single = o.steps.length === 1 && o.steps[0].id === o.owner.id;
    return (
      <>
        {descOf(o.owner) && <div className="text-[12px] text-[var(--color-text)] line-clamp-2 break-words">{descOf(o.owner)}</div>}
        <div className="text-[11.5px] text-[var(--color-text-muted)]">
          {[classWords(o.owner), o.crews.join(", ") || null, single ? null : `${o.done} of ${o.steps.length} steps done`].filter(Boolean).join(" · ")}
          {o.added.map((x) => (
            <span key={x.kind} className={`ml-1.5 font-semibold ${x.kind === "added" ? "text-[var(--color-text)] dark:text-[var(--color-text)]" : "text-[var(--color-text)] dark:text-[var(--color-text)]"}`} title={ADDED[x.kind].tip}>
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

  // A long list ends with "Show N more", so it's plain there's more.
  const listed = shown.slice(0, limit);
  return (
    // Inside the Work card: a quiet row of search and filters, then one row
    // per work order, split by hairlines (no boxes in boxes).
    <div>
      {picking && onDiscovery && (
        <AddWorkPicker day={today} tz={tz} milestones={milestones}
          onPick={(t) => { setPicking(false); onDiscovery(t); }} onNew={onNewWorkOrder ? () => { setPicking(false); onNewWorkOrder(); } : undefined} onClose={() => setPicking(false)} />
      )}
      <div className="px-3 sm:px-4 py-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 h-9 flex-1 min-w-[220px] max-w-[420px] rounded-[10px] bg-[var(--color-surface-2)] border border-transparent px-2.5 focus-within:bg-[var(--color-surface)] focus-within:border-[var(--color-border-strong)]">
          <Search className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="WO #, equipment, step, crew…" aria-label="Search work orders"
            className="flex-1 min-w-0 bg-transparent text-[13px] outline-none" />
          {query && <button type="button" onClick={() => setQuery("")} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Clear</button>}
        </label>
        <select value={who ?? "__all"} onChange={(e) => setWho(e.target.value === "__all" ? null : e.target.value)} aria-label="Who"
          className={`h-9 rounded-[10px] border px-2 text-[13px] font-semibold text-[var(--color-text)] ${who != null ? "border-[var(--color-text)] bg-[var(--color-surface)]" : "border-transparent bg-[var(--color-surface-2)]"}`}>
          <option value="__all">Everyone</option>
          {whoList.map(([k, x]) => <option key={k || "__none"} value={k}>{k ? x.name : "No crew named"} ({x.steps} step{x.steps === 1 ? "" : "s"})</option>)}
        </select>
        <WoClassSelects c={wc} units={units} types={types} onUnits={setUnits} onTypes={setTypes} />
        {/* The everyday filters in sight; the rest folded under More. */}
        {(() => {
          const ALL = [["all", "All"], ["open", "Open"], ["critical", "Critical path"], ["behind", "Behind"], ["notStarted", "Not started"], ["held", "Held"], ["done", "Done"], ["added", "Discovery & added"]] as const;
          const UP_FRONT: Show[] = ["all", "open", "behind", "held"];
          const chip = (on: boolean) => `h-9 px-3 rounded-full text-[13px] font-semibold ${on ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface-2)] text-[var(--color-text)] hover:bg-[var(--color-border)]"}`;
          const folded = ALL.filter(([k]) => !UP_FRONT.includes(k));
          const pickedFolded = !showCancelled && !UP_FRONT.includes(show) ? ALL.find(([k]) => k === show) : undefined;
          return (
            <div className="inline-flex flex-wrap items-center gap-1" role="group" aria-label="Show">
              {ALL.filter(([k]) => UP_FRONT.includes(k)).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={!showCancelled && show === k} onClick={() => { setShow(k); setShowCancelled(false); }} className={chip(!showCancelled && show === k)}>
                  {l} <span className="tabular-nums opacity-80">{found.filter(is(k)).length}</span>
                </button>
              ))}
              {/* A folded filter in use shows as a chip of its own. */}
              {pickedFolded && (
                <button type="button" aria-pressed onClick={() => setShow("all")} title="Show all again" className={chip(true)}>
                  {pickedFolded[1]} <span className="tabular-nums opacity-80">{found.filter(is(pickedFolded[0])).length}</span>
                </button>
              )}
              {showCancelled && (
                <button type="button" aria-pressed onClick={() => setShowCancelled(false)} title="Back to the live work orders" className={chip(true)}>
                  Cancelled <span className="tabular-nums opacity-80">{cancelledShown.length}</span>
                </button>
              )}
              <MoreMenu label="More filters" triggerClass="inline-flex items-center gap-1 h-9 px-3 rounded-full text-[13px] font-semibold bg-[var(--color-surface-2)] text-[var(--color-text)] hover:bg-[var(--color-border)]"
                items={[
                  ...folded.map(([k, l]) => ({ icon: <span aria-hidden className="w-4 text-center tabular-nums text-[11px]">{found.filter(is(k)).length}</span>, label: l, current: !showCancelled && show === k, onClick: () => { setShow(k); setShowCancelled(false); } })),
                  { icon: <Ban className="w-4 h-4" />, label: `Cancelled (${cancelled.length})`, current: showCancelled, line: true, onClick: () => setShowCancelled(true) },
                ]} />
            </div>
          );
        })()}
        {canEdit && onNewWorkOrder && (
          <button type="button" onClick={() => onNewWorkOrder()}
            className={`ml-auto ${quietMain ? QUIET : "inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[10px] bg-[var(--color-accent)] text-[13px] font-extrabold text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] shadow-[0_10px_20px_-10px_var(--color-accent)]"}`}>
            <Plus className="w-3.5 h-3.5" /> New work order
          </button>
        )}
        {canEdit && onDiscovery && (
          <button type="button" onClick={() => setPicking(true)}
            className={`${onNewWorkOrder ? "" : "ml-auto "}${QUIET}`}>
            <Plus className="w-3.5 h-3.5" /> Add to a work order
          </button>
        )}
        <span className={`relative inline-flex ${canEdit && (onDiscovery || onNewWorkOrder) ? "" : "ml-auto"}`}>
          <button type="button" onClick={() => setPrintMenu((v) => !v)} aria-expanded={printMenu} disabled={shown.length === 0 || showCancelled}
            className={QUIET}>
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
                    <span className="font-semibold">Shift sheet: fill in by pen</span>
                    <span className="block text-[11px] text-[var(--color-text-muted)]">One page for the coming shift: only its work, by equipment</span>
                  </button>
                )}
              </span>
            </>
          )}
        </span>
      </div>
      {printMsg && <div role="alert" className="px-3 sm:px-4 pb-2 text-[12px] font-semibold text-rose-700 dark:text-rose-400">{printMsg}</div>}
      {preErr && <div role="alert" className="px-3 sm:px-4 pb-2 text-[12px] font-semibold text-rose-700 dark:text-rose-400">Couldn&apos;t read the steps&apos; comments and history. They&apos;re missing below until the page is opened again.</div>}

      {showCancelled ? (
        cancelledShown.length === 0 ? (
          <div className="border-t border-[var(--color-border)] px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">
            {cancelled.length === 0 ? "No work orders cancelled from this schedule." : "No cancelled work orders match."}
          </div>
        ) : (
          <div className="border-t border-[var(--color-border)]">
            <div className="px-3 sm:px-4 py-2.5 text-[13px] text-[var(--color-text)] border-b border-[var(--color-border)]">
              <b>{cancelledShown.length} cancelled</b> from this schedule, still to be done elsewhere. Not counted in any progress, plan or report except the close-out&apos;s cancelled list.
            </div>
            <CancelledJobsList jobs={cancelledShown} canEdit={canEdit && !!user} userId={user?.id ?? ""} userEmail={user?.email} onChanged={() => onCancelled?.()} />
          </div>
        )
      ) : shown.length === 0 ? (
        <div className="border-t border-[var(--color-border)] px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">
          {orders.length === 0 ? "No steps on the schedule yet." : "No work orders match."}
        </div>
      ) : (
        <ul className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {listed.map((o) => {
            const isOpen = open.has(o.key);
            const st = STANDING[o.standing];
            // Ink and paper: the standing is a word; colour only when held (a
            // problem) or done.
            const stTone = o.standing === "held" ? "text-amber-700 dark:text-amber-300" : o.standing === "done" ? "text-emerald-700 dark:text-emerald-300" : o.standing === "in_progress" ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]";
            const single = o.steps.length === 1 && o.steps[0].id === o.owner.id;
            const name = `${o.wo ? `WO ${o.wo}` : "No WO"} ${o.owner.name}`;
            return (
              // Each work order a row on the card; open, its steps sit under it
              // on the warm fill, framed by a dark edge on the left.
              <li key={o.key} className={`relative ${isOpen ? "bg-[var(--color-surface-2)]/50" : ""}`}>
                {isOpen && <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px] bg-[var(--color-text)]" />}
                <button type="button" onClick={() => toggle(o.key)} aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Open"} ${name}`}
                  ref={(el) => { if (el) heads.current.set(o.key, el); else heads.current.delete(o.key); }}
                  className={`w-full text-left px-3 sm:px-4 py-3 ${isOpen ? "sticky top-0 z-20 bg-[var(--color-surface-2)] border-b border-[var(--color-border-strong)]" : "hover:bg-[var(--color-surface-2)]/60"}`}>
                  <div className="flex items-start gap-2.5">
                    <span className={`mt-0.5 shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full border ${isOpen ? "bg-[var(--color-text)] border-[var(--color-text)] text-[var(--color-surface)]" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`} aria-hidden>
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
                      <span className={`text-[12px] font-bold ${stTone}`}>{st.word}</span>
                      <span className="text-[13px] font-bold tabular-nums text-[var(--color-text)]">{o.pct}%</span>
                      {o.standing !== "done" && Math.abs(o.hours) >= 0.1 && (
                        <span className={`font-mono text-[11px] font-bold ${o.hours < 0 ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{o.hours > 0 ? "+" : "−"}{Math.abs(o.hours)} h</span>
                      )}
                    </div>
                  </div>
                  {!isOpen && barOf(o)}
                </button>
                {isOpen && (
                  <div>
                    <div className="px-3 sm:px-4 pt-2 pb-2.5 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
                      <div className="ml-9">{detailsOf(o)}</div>
                      {barOf(o)}
                      {originBlock(o)}
                    </div>
                    <div className="px-3 sm:px-4 pt-2.5 flex flex-wrap gap-1.5">
                        {/* The equipment it's on: picked from the project's unit. */}
                        <EquipmentField milestone={o.owner} milestones={milestones} />
                        {canEdit && onDiscovery && (
                          <button type="button" onClick={() => onDiscovery(o.owner)}
                            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-border)]">
                            <Plus className="w-3.5 h-3.5" /> Add discovery or added scope to this work order
                          </button>
                        )}
                        {onOpenReport && (
                          <button type="button" onClick={() => onOpenReport({ id: "workorders", wo: o.key })} title="This work order in Reports, ready to print"
                            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-border)]">
                            <Printer className="w-3.5 h-3.5" /> Print this work order
                          </button>
                        )}
                        {canEdit && o.owner.id && (
                          <button type="button" onClick={() => newFinding({ milestoneId: o.owner.id })} title="A problem, a lesson, a material shortfall or missed scope on this work order, kept for the next job"
                            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-border)]">
                            <Lightbulb className="w-3.5 h-3.5" /> + Finding
                          </button>
                        )}
                    </div>
                    {/* What was found on it, and on its equipment in past jobs. */}
                    <div className="px-3 sm:px-4 pt-2.5">
                      <JobFindings orgId={o.owner.orgId} projectId={o.owner.projectId ?? projectId} milestoneIds={[o.owner.id, ...o.steps.map((x) => x.id)]} tag={equipmentOf(o.owner, byIdAll)?.tag ?? null} tz={tz} />
                    </div>
                    {/* Its steps: inside the work order, indented, each a row that opens to its card. */}
                    <div className="px-2 sm:px-3 pt-2.5 pb-1">
                      <div className="ml-2 sm:ml-5 pl-2 sm:pl-3 border-l-2 border-[var(--color-border-strong)]">
                        <div className="mb-1 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                          {single ? "The step" : `Steps · ${o.done} of ${o.steps.length} done`}
                        </div>
                        <div className="rounded-xl bg-[var(--color-surface)] shadow-[0_1px_2px_rgb(11_18_32/0.06)] overflow-hidden">
                          <CalendarQuickView whole task={o.owner} onDay={o.steps} others={[]} dayKey={today} band={null} dayLabel="" marks={marks}
                            tz={tz} times={times} progress={progress} canEdit={canEdit} preloaded={pre}
                            onUpdate={onUpdate} onFixTimes={onFixTimes} onOpenDetail={onOpenDetail} onMoveDays={canEdit ? onMoveDays : undefined} />
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
                            className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-[var(--color-text-muted)] hover:text-rose-700 dark:hover:text-rose-400 hover:bg-[var(--color-surface-2)] px-2 py-1 rounded-md">
                            <Ban className="w-3.5 h-3.5" /> Cancel work order
                          </button>
                        )}
                      </div>
                    )}
                    {/* Close it from the bottom: no scrolling back up. */}
                    <button type="button" onClick={() => toggle(o.key)} aria-label={`Close ${name}`}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 border-t border-[var(--color-border)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                      <ChevronUp className="w-4 h-4" /> Close {o.wo ? `WO ${o.wo}` : o.owner.name}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!showCancelled && shown.length > listed.length && (
        <div className="px-3 sm:px-4 py-3 border-t border-[var(--color-border)] flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setLimit((n) => n + WO_STEP)} className={QUIET}>Show {Math.min(WO_STEP, shown.length - listed.length)} more</button>
          <button type="button" onClick={() => setLimit(Infinity)} className="h-9 px-3 rounded-[10px] text-[13px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Show all {shown.length}</button>
        </div>
      )}
      <div className="px-3 sm:px-4 py-3 border-t border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)]">{shown.length} of {orders.length} work orders · tap one to update its steps</div>
    </div>
  );
}
