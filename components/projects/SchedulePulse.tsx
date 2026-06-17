"use client";

// SchedulePulse — the at-a-glance "what needs you right now" strip at the top
// of the Execution board. Instead of making the user hunt, it surfaces the few
// facts that should change a decision today — overdue work, active blockers,
// pace, and drift from the approved plan.
//
// Each actionable nudge EXPANDS an inline quick-view of the exact tasks behind
// it; clicking a task opens it (the detail panel). No separate modal, no
// hunting — "show me" actually shows you the tasks, right there.

import React, { useMemo, useState } from "react";
import {
  AlertTriangle, PauseCircle, TrendingDown, CalendarClock, CheckCircle2,
  ChevronDown, ArrowUpRight, ListFilter,
} from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import { computeExecutionReport } from "@/lib/executionReport";

type Category = "overdue" | "stuck" | "drift";

interface Props {
  milestones: Milestone[];
  /** Optionally also filter the board to these (secondary action). */
  onShowOverdue?: () => void;
  onShowBlocked?: () => void;
  /** Open a specific task (the board's detail panel). When omitted, the
   *  quick-view rows are read-only. */
  onOpenTask?: (m: Milestone) => void;
}

const DAY = 86_400_000;
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
};

export default function SchedulePulse({ milestones, onShowOverdue, onShowBlocked, onOpenTask }: Props) {
  const r = useMemo(() => computeExecutionReport(milestones), [milestones]);
  const [open, setOpen] = useState<Category | null>(null);
  const [nowMs] = useState(() => Date.now());

  // The actual task lists behind each nudge.
  const { overdueTasks, stuckTasks, driftTasks } = useMemo(() => {
    const parentIds = new Set<string>();
    for (const m of milestones) if (m.parentId) parentIds.add(m.parentId);
    const isLeaf = (m: Milestone) => !(m.id && parentIds.has(m.id));
    const byId = new Map(milestones.map((m) => [m.id, m] as const));
    const finish = (m: Milestone) => Date.parse(m.plannedAt as string);
    const overdue = milestones
      .filter((m) => isLeaf(m) && m.status !== "completed" && m.plannedAt && finish(m) < nowMs)
      .sort((a, b) => finish(a) - finish(b));
    const stuck = milestones
      .filter((m) => isLeaf(m) && (m.status === "blocked" || m.status === "on_hold"))
      .sort((a, b) => finish(a) - finish(b));
    const drift = (r.baseline?.worstSlips ?? [])
      .map((s) => byId.get(s.id))
      .filter((m): m is Milestone => !!m);
    return { overdueTasks: overdue, stuckTasks: stuck, driftTasks: drift };
  }, [milestones, nowMs, r.baseline]);

  if (r.totalLeaves === 0) return null;

  const nudges: React.ReactNode[] = [];
  if (r.overdue > 0) {
    nudges.push(
      <Nudge key="overdue" tone="rose" active={open === "overdue"} icon={<AlertTriangle className="w-4 h-4" />}
        onClick={() => setOpen((o) => (o === "overdue" ? null : "overdue"))}
        text={<><b>{r.overdue}</b> overdue {r.overdue === 1 ? "task" : "tasks"}</>} cta="Show" />,
    );
  }
  if (r.blocked + r.onHold > 0) {
    nudges.push(
      <Nudge key="stuck" tone="amber" active={open === "stuck"} icon={<PauseCircle className="w-4 h-4" />}
        onClick={() => setOpen((o) => (o === "stuck" ? null : "stuck"))}
        text={<><b>{r.blocked + r.onHold}</b> stuck — {r.blocked} blocked, {r.onHold} on hold</>} cta="Review" />,
    );
  }
  if (r.paceDelta <= -10) {
    nudges.push(
      <Nudge key="pace" tone="rose" icon={<TrendingDown className="w-4 h-4" />}
        text={<><b>{Math.abs(r.paceDelta)} pts</b> behind pace ({r.pctComplete}% done, expected {r.expectedPct}%)</>} />,
    );
  }
  if (r.baseline && r.baseline.finishDriftDays > 0 && driftTasks.length > 0) {
    nudges.push(
      <Nudge key="drift" tone="amber" active={open === "drift"} icon={<CalendarClock className="w-4 h-4" />}
        onClick={() => setOpen((o) => (o === "drift" ? null : "drift"))}
        text={<>Finish slipped <b>{r.baseline.finishDriftDays}d</b> vs plan</>} cta="Which" />,
    );
  }

  const calm = nudges.length === 0;

  const panel = (() => {
    if (open === "overdue") return { title: `${overdueTasks.length} overdue task${overdueTasks.length === 1 ? "" : "s"}`, tasks: overdueTasks, kind: "overdue" as const, onFilter: onShowOverdue };
    if (open === "stuck") return { title: `${stuckTasks.length} blocked / on-hold`, tasks: stuckTasks, kind: "stuck" as const, onFilter: onShowBlocked };
    if (open === "drift") return { title: `Worst slips vs the approved plan`, tasks: driftTasks, kind: "drift" as const, onFilter: undefined };
    return null;
  })();

  return (
    <div className="space-y-2">
      <div className={`rounded-2xl border shadow-sm px-4 py-2.5 flex items-center gap-3 flex-wrap ${calm ? "border-emerald-200 bg-emerald-50/50" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
        {calm ? (
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700">
            <CheckCircle2 className="w-4 h-4" /> On track — nothing needs attention right now.
          </span>
        ) : (
          <>
            <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] shrink-0">Needs you</span>
            {nudges}
          </>
        )}
      </div>

      {panel && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="px-3 py-2 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] flex items-center gap-2">
            <span className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{panel.title}</span>
            <div className="ml-auto flex items-center gap-1">
              {panel.onFilter && (
                <button onClick={panel.onFilter} className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1.5 py-1 rounded hover:bg-[var(--color-surface)]">
                  <ListFilter className="w-3 h-3" /> Filter board
                </button>
              )}
              <button onClick={() => setOpen(null)} className="text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1.5 py-1 rounded hover:bg-[var(--color-surface)]">Close</button>
            </div>
          </div>
          {panel.tasks.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">Nothing here right now.</div>
          ) : (
            <div className="divide-y divide-[var(--color-border)] max-h-72 overflow-auto">
              {panel.tasks.slice(0, 25).map((m) => (
                <TaskRow key={m.id} m={m} kind={panel.kind} nowMs={nowMs} onOpen={onOpenTask} driftDays={driftDaysFor(m, r)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function driftDaysFor(m: Milestone, r: ReturnType<typeof computeExecutionReport>): number | null {
  const slip = r.baseline?.worstSlips.find((s) => s.id === m.id);
  return slip ? slip.days : null;
}

function TaskRow({ m, kind, nowMs, onOpen, driftDays }: {
  m: Milestone; kind: "overdue" | "stuck" | "drift"; nowMs: number; onOpen?: (m: Milestone) => void; driftDays: number | null;
}) {
  const overdueDays = m.plannedAt ? Math.floor((nowMs - Date.parse(m.plannedAt as string)) / DAY) : 0;
  const meta = (
    <span className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-2 flex-wrap">
      <span className="inline-flex items-center gap-1"><CalendarClock className="w-3 h-3" />{fmtDate(m.plannedAt as string)}</span>
      {kind === "overdue" && overdueDays > 0 && <span className="font-bold text-rose-700">{overdueDays}d overdue</span>}
      {kind === "stuck" && <span className="font-bold uppercase tracking-wider text-amber-700">{m.status.replace("_", " ")}</span>}
      {kind === "stuck" && m.statusReason && <span className="italic">— {m.statusReason}</span>}
      {kind === "drift" && driftDays != null && <span className="font-bold text-amber-700">+{driftDays}d vs plan</span>}
    </span>
  );
  const inner = (
    <div className="flex items-center gap-2.5 px-3 py-2 w-full text-left">
      <StatusDot status={m.status} />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold text-[var(--color-text)] truncate">{m.name}</div>
        {meta}
      </div>
      {onOpen && <ArrowUpRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
    </div>
  );
  return onOpen
    ? <button onClick={() => onOpen(m)} className="w-full hover:bg-[var(--color-surface-2)] transition-colors">{inner}</button>
    : <div>{inner}</div>;
}

function StatusDot({ status }: { status: MilestoneStatus }) {
  const tone =
    status === "completed" ? "bg-emerald-500" :
    status === "in_progress" ? "bg-blue-500" :
    status === "blocked" ? "bg-amber-500" :
    status === "on_hold" ? "bg-amber-400" :
    status === "missed" ? "bg-rose-500" : "bg-slate-300";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${tone}`} aria-hidden />;
}

function Nudge({ tone, icon, text, cta, onClick, active }: {
  tone: "rose" | "amber"; icon: React.ReactNode; text: React.ReactNode; cta?: string; onClick?: () => void; active?: boolean;
}) {
  const c = tone === "rose" ? "text-rose-700 bg-rose-50 border-rose-200" : "text-amber-800 bg-amber-50 border-amber-200";
  const content = (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] ${c} ${active ? "ring-2 ring-offset-1 ring-current/30" : ""}`}>
      {icon}{text}
      {cta && onClick && (
        <span className="inline-flex items-center gap-0.5 font-bold ml-1">
          {cta} <ChevronDown className={`w-3 h-3 transition-transform ${active ? "rotate-180" : ""}`} />
        </span>
      )}
    </span>
  );
  return onClick ? <button onClick={onClick} className="hover:brightness-95 transition">{content}</button> : content;
}
