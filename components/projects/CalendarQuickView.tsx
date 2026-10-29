"use client";

// CalendarQuickView — the one place to update work from the calendar.
//
// Tap a card: its work order, where the whole task stands against plan,
// and each step on the shift you tapped — its planned window, % against
// plan, hours behind, last comment, hold reason. Tap a step to update it
// right there: status, %, the time it happened (you're on the day — just
// the time), a comment (required, it goes on the report), and why it's
// behind. Its history is one tap away, so you see what you're overriding.
// No sidebar; the schedule details (move, depends on) are a link away.

import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, Layers } from "lucide-react";
import type { Milestone, MilestoneNote } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { leafPercent } from "@/lib/scheduleProgress";
import { expectedFraction, shiftWindow, workHours, notesForShift, TURNOVER_GRACE_MS, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { fmtInTz } from "@/lib/scheduleTz";
import { notesFor } from "@/lib/milestones";
import { loadProgressLog, type ProgressLogRow } from "@/lib/progressHistory";
import StepCard, { type StepUpdate } from "@/components/projects/StepCard";
import { builtSpan } from "@/lib/asBuilt";
import type { PathMarks } from "@/lib/criticalPath";
import PathTag from "@/components/projects/PathTag";
import DiscoveryTag from "@/components/projects/DiscoveryTag";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";

/** What the quick view saves for a step. */
export type { StepUpdate } from "@/components/projects/StepCard";

const DOT: Record<string, string> = { planned: "bg-slate-300", in_progress: "bg-blue-600", on_hold: "bg-amber-500", blocked: "bg-rose-600", missed: "bg-rose-800", completed: "bg-emerald-500" };
const WORD: Record<string, string> = { planned: "Not started", in_progress: "In progress", on_hold: "On hold", blocked: "Blocked", missed: "Missed", completed: "Done" };
const ms = (v: unknown) => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

export default function CalendarQuickView({ task, onDay, others, dayKey, band, dayLabel, tz, times, progress, planNow, canEdit, onUpdate, onFixTimes, onOpenDetail, onMoveDays, marks, onDiscovery, whole }: {
  task: Milestone;
  /** Steps on the shift (or day) tapped; the rest behind a toggle. */
  onDay: Milestone[]; others: Milestone[];
  dayKey: string; band?: "day" | "night" | null; dayLabel: string;
  tz: string; times: ShiftTimes;
  progress?: Map<string, ProgressInfo>;
  /** Each task's % planned by now. */
  planNow?: Map<string, number>;
  canEdit: boolean;
  onUpdate?: (id: string, u: StepUpdate) => Promise<boolean>;
  /** Correct when a step really started / finished. */
  onFixTimes?: (id: string, t: { start?: number | null; finish?: number | null }) => Promise<boolean>;
  /** The side bar, for planning changes — not offered where there's none. */
  onOpenDetail?: (m: Milestone) => void;
  onMoveDays?: (id: string, delta: number) => void;
  /** The critical path (lib/criticalPath) — each step marked against it. */
  marks?: PathMarks;
  /** Found work on this task: into the schedule. */
  onDiscovery?: (task: Milestone) => void;
  /** All its steps, under a heading already shown (the work order list). */
  whole?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const all = useMemo(() => [...onDay, ...others], [onDay, others]);
  // The steps it opened with stay where they were while it's open — a
  // start or finish put in for another day moves the step there on the
  // calendar, not out from under you here.
  const [opened] = useState(() => new Map(onDay.map((m, i) => [m.id ?? m.name, i])));
  const here = useMemo(() => {
    const now = new Set(onDay.map((m) => m.id ?? m.name));
    const rank = (m: Milestone) => opened.get(m.id ?? m.name) ?? opened.size + onDay.indexOf(m);
    return {
      main: all.filter((m) => opened.has(m.id ?? m.name) || now.has(m.id ?? m.name)).sort((a, b) => rank(a) - rank(b)),
      rest: all.filter((m) => !opened.has(m.id ?? m.name) && !now.has(m.id ?? m.name)),
    };
  }, [all, onDay, opened]);
  const ids = useMemo(() => all.map((m) => m.id).filter((x): x is string => !!x), [all]);
  const idsKey = ids.join(",");
  // Each step's comments, reasons and history.
  const [notes, setNotes] = useState<MilestoneNote[]>([]);
  const [log, setLog] = useState<ProgressLogRow[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener("milestone-notes:changed", on);
    return () => window.removeEventListener("milestone-notes:changed", on);
  }, []);
  // Re-read when a step's status or % changes too.
  const sig = all.map((m) => `${m.id}:${m.status}:${m.percentComplete ?? 0}`).join("|");
  useEffect(() => {
    let alive = true;
    if (!idsKey) return;
    notesFor(idsKey.split(",")).then((n) => { if (alive) setNotes(n); }).catch(() => { /* comments are extra */ });
    if (task.projectId) loadProgressLog(task.projectId).then((l) => { if (alive) setLog((l ?? []).filter((r) => idsKey.includes(r.milestone_id))); }).catch(() => { /* history is extra */ });
    return () => { alive = false; };
  }, [idsKey, task.projectId, tick, sig]);

  const pctOf = (m: Milestone) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
  const planOf = (m: Milestone) => Math.round(expectedFraction(m, now, tz, times) * 100);
  // Work-hours ahead (+) or behind (−) of plan by now.
  const hoursOf = (m: Milestone) => Math.round(((pctOf(m) - planOf(m)) / 100) * workHours(m, tz) * 10) / 10;
  const isLeaf = all.length === 1 && all[0].id === task.id;
  const taskPct = task.id && !isLeaf ? progress?.get(task.id)?.percent : undefined;
  const taskPlan = task.id && !isLeaf ? planNow?.get(task.id) : undefined;
  const taskHours = Math.round(all.reduce((a, m) => a + hoursOf(m), 0) * 10) / 10;
  const wos = [...new Set([task.workOrderRef, ...all.map((m) => m.workOrderRef)].map((x) => x?.trim()).filter(Boolean))] as string[];
  // The time you type is on this shift (or this day).
  const win: ShiftWindow = useMemo(() => {
    if (band) return shiftWindow(dayKey, band, tz, times);
    const d = shiftWindow(dayKey, "day", tz, times), n = shiftWindow(dayKey, "night", tz, times);
    return { kind: "day", dayKey, start: d.start, end: n.end };
  }, [band, dayKey, tz, times]);
  // "Tue 2:30 PM" this week; further off, with its date ("Oct 23, 4:23 PM").
  const fmt = (t: number) => fmtInTz(t, tz, Math.abs(t - now) < 6 * 86_400_000
    ? { weekday: "short", hour: "numeric", minute: "2-digit", hour12: true }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  const [open, setOpen] = useState<string | null>(onDay.length === 1 ? onDay[0].id ?? null : null);
  const [showOthers, setShowOthers] = useState(false);

  const stepInfo = (m: Milestone) => {
    const mine = notes.filter((n) => n.milestoneId === m.id);
    const latest = (k: MilestoneNote["kind"]) => mine.filter((n) => n.kind === k && n.body?.trim()).sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
    const rows = log.filter((r) => r.milestone_id === m.id);
    const since = [...rows].reverse().find((r) => r.new_status === m.status)?.at;
    // The comment this shift's report shows for it (lib/shiftReport) — the
    // one Revise changes; the latest overall is context.
    const forShift = notesForShift(mine, win, TURNOVER_GRACE_MS).note.get(m.id ?? "");
    return { comment: latest("note"), shiftComment: forShift, why: latest("behind"), since: since ? Date.parse(since) : NaN, rows, mine };
  };

  const header = (
    <div className="px-3 py-2 border-b border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)]">
      <div className="flex items-baseline gap-2">
        <Layers className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0 self-center" />
        <span className="text-[13px] font-bold text-[var(--color-text)] flex-1 min-w-0 break-words">{task.name}</span>
        {wos.length > 0 && <span className="font-mono text-[11.5px] font-semibold text-[var(--color-text)] shrink-0">WO {wos.join(", ")}</span>}
      </div>
      <div className="mt-0.5 text-[10.5px] text-[var(--color-text-muted)]">
        <b className="text-[var(--color-text)]">{dayLabel}</b>{all.length > 1 ? ` · ${onDay.length} of ${all.length} steps ${band ? "this shift" : "this day"}` : ""}
      </div>
      {taskPct != null && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--color-text)]">
          <span className="whitespace-nowrap"><b>Task {taskPct}%</b> done{taskPlan != null ? ` · plan ${taskPlan}%` : ""}</span>
          <span className="relative flex-1 min-w-[60px] h-1.5 rounded-full bg-slate-200 dark:bg-slate-700" aria-hidden>
            <span className="absolute inset-y-0 left-0 rounded-full bg-slate-900 dark:bg-slate-200" style={{ width: `${Math.min(100, taskPct)}%` }} />
            {taskPlan != null && <span className="absolute -top-[3px] w-0.5 h-3 bg-rose-700" style={{ left: `calc(${Math.min(100, taskPlan)}% - 1px)` }} />}
          </span>
          {Math.abs(taskHours) >= 0.1 && <b className={`font-mono whitespace-nowrap ${taskHours < 0 ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{taskHours > 0 ? "+" : "−"}{Math.abs(taskHours)} h</b>}
        </div>
      )}
    </div>
  );

  const stepRow = (m: Milestone, muted?: boolean) => {
    const id = m.id ?? m.name;
    const pct = pctOf(m), plan = planOf(m), h = hoursOf(m);
    const info = stepInfo(m);
    const held = m.status === "on_hold" || m.status === "blocked";
    const isOpen = open === id;
    const s0 = startMsOf(m), f0 = finishMsOf(m);
    return (
      <li key={id} className={`border-b border-[var(--color-border)] last:border-b-0 ${muted ? "opacity-70" : ""}`}>
        <button type="button" onClick={() => setOpen(isOpen ? null : id)} aria-expanded={isOpen}
          className={`w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--color-surface-2)] ${isOpen ? "bg-[var(--color-surface-2)]" : ""}`}>
          <span className={`mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${DOT[m.status] ?? DOT.planned}`} aria-label={WORD[m.status]} />
          <span className="flex-1 min-w-0">
            <span className={`block text-[12.5px] font-semibold break-words ${m.status === "completed" ? "line-through text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{m.name} <PathTag id={m.id} marks={marks} /> <DiscoveryTag m={m} tz={tz} /></span>
            {!isOpen && <><span className="block text-[10.5px] text-[var(--color-text-muted)]">
              {(() => {
                // Where it actually happened, beside the plan.
                const b = builtSpan(m);
                const planned = Number.isFinite(s0) && Number.isFinite(f0) ? `${fmt(s0)} → ${fmt(f0)}` : "";
                if (b.kind === "done") return `Done ${fmt(b.finish)}${planned ? ` · planned ${planned}` : ""}`;
                if (b.kind === "started") return `Started ${fmt(b.start)}${planned ? ` · planned ${planned}` : ""}`;
                return planned;
              })()}{m.status !== "completed" ? ` · plan ${plan}% by now` : ""}{m.workOrderRef && wos.length > 1 ? ` · WO ${m.workOrderRef}` : ""}
            </span>
            {held && (
              <span className="block text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                {WORD[m.status]}{Number.isFinite(info.since) ? ` since ${fmt(info.since)}` : ""}{m.statusReason ? ` — “${m.statusReason}”` : " — no reason given"}
              </span>
            )}
            {info.comment && <span className="block text-[11px] italic text-[var(--color-text-muted)] break-words">“{info.comment.body}” — {fmt(ms(info.comment.happenedAt ?? info.comment.createdAt))}</span>}
            {info.why && h < 0 && <span className="block text-[11px] italic font-medium text-amber-800 dark:text-amber-300 break-words">Why behind: {info.why.body}</span>}</>}
          </span>
          <span className="shrink-0 flex flex-col items-end gap-0.5">
            <span className={`rounded-md border px-1 text-[10px] font-bold tabular-nums ${pct >= 100 ? "text-emerald-700 bg-emerald-50 border-emerald-200" : pct > 0 ? "text-blue-700 bg-blue-50 border-blue-200" : "text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]"}`}>{pct}%</span>
            {Math.abs(h) >= 0.1 && m.status !== "completed" && <span className={`font-mono text-[10.5px] font-bold ${h < 0 ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{h > 0 ? "+" : "−"}{Math.abs(h)} h</span>}
          </span>
        </button>
        {isOpen && (
          <StepCard key={id} m={m} wo={(m.workOrderRef?.trim() || task.workOrderRef?.trim() || wos[0]) ?? undefined} pct={pct} hours={h} rows={info.rows} notes={info.mine}
            tz={tz} times={times} now={now} canEdit={canEdit && !!onUpdate && !!m.id} onUpdate={onUpdate && m.id ? (u) => onUpdate(m.id!, u) : undefined}
            onFixTimes={onFixTimes && m.id ? (t) => onFixTimes(m.id!, t) : undefined} onMoveDays={onMoveDays} />
        )}
      </li>
    );
  };

  return (
    <div>
      {!whole && header}
      {here.main.length === 0
        ? <div className="px-3 py-3 text-[11px] text-[var(--color-text-faint)]">Nothing under this task is scheduled on {dayLabel}.</div>
        : <ul>{here.main.map((m) => stepRow(m))}</ul>}
      {here.rest.length > 0 && (
        <div className="border-t border-[var(--color-border)]">
          <button type="button" onClick={() => setShowOthers((v) => !v)} className="w-full px-3 py-1.5 text-left text-[10.5px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] inline-flex items-center gap-1">
            <ChevronRight className={`w-3 h-3 transition-transform ${showOthers ? "rotate-90" : ""}`} />
            {here.rest.length} step{here.rest.length === 1 ? "" : "s"} on other {band ? "shifts" : "days"}
          </button>
          {showOthers && <ul className="border-t border-[var(--color-border)]">{here.rest.map((m) => stepRow(m, true))}</ul>}
        </div>
      )}
      <div className="px-3 py-1.5 border-t border-[var(--color-border)] flex items-center justify-between gap-2 text-[10.5px] text-[var(--color-text-faint)]">
        {onDiscovery ? (
          <button type="button" onClick={() => onDiscovery(task)} className="font-bold text-violet-700 dark:text-violet-300 hover:underline">+ Discovery work found</button>
        ) : <span>Tap a step to update it.</span>}
        {onOpenDetail && <button type="button" onClick={() => onOpenDetail(task)} className="font-semibold text-[var(--color-accent)] hover:underline">Schedule details (move, depends on) ›</button>}
      </div>
    </div>
  );
}

