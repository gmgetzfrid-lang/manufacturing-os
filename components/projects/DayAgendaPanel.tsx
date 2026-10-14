"use client";

// DayAgendaPanel — one day of the turnaround as a work list. Opened from
// the calendar by clicking a day number. Answers, without hunting:
//   • what is expected today (every step whose span covers the day),
//   • under which equipment and group it sits,
//   • when in the day it runs,
//   • how far along it is — status dot + % control on every line, with
//     the day's completion at the top updating as you enter progress.
// Steps that started earlier or run on are marked so a carry-over is
// never mistaken for new work. Nothing is hidden behind "+N more".

import React, { useMemo } from "react";
import { ChevronLeft, ChevronRight, X as XIcon, CalendarDays, Layers, ExternalLink } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import StatusControl from "@/components/projects/StatusControl";
import ProgressControl from "@/components/projects/ProgressControl";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { clockLabel, dayKey, dayKeyToMs, fmtInTz, addDays, tzAbbrev } from "@/lib/scheduleTz";
import { startMsOf, finishMsOf, wbsCompare } from "@/lib/calendarPlacement";
import { overdueOpenWork, startedEarlyWork } from "@/lib/openWork";
import { completionNote } from "@/lib/scheduleRules";

interface Props {
  day: string; // "YYYY-MM-DD" in the plant zone
  tz: string;
  milestones: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  ancestorsOf: (m: Milestone) => Milestone[];
  progress?: Map<string, ProgressInfo>;
  canEdit: boolean;
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string) => void;
  onSetProgress?: (id: string, percent: number) => void;
  onOpenDetail: (m: Milestone) => void;
  onChangeDay: (day: string) => void;
  onClose: () => void;
  /** Color per top-level group id (same palette as the calendar). */
  colorOf: (top: Milestone) => { bar: string; soft: string; text: string; dot: string };
}

interface Row {
  leaf: Milestone;
  startsToday: boolean;
  endsToday: boolean;
  startMs: number;
  finishMs: number;
  /** Why this row is on today although its plan slot is elsewhere. */
  live?: "overdue" | "started-early";
}

interface EquipmentGroup {
  /** The leaf's immediate parent (the equipment / bottom group), or null for a stray leaf. */
  parent: Milestone | null;
  /** Ancestors above the parent, outermost first — the breadcrumb. */
  crumbs: Milestone[];
  top: Milestone;
  rows: Row[];
}

export default function DayAgendaPanel({
  day, tz, milestones, childrenByParent, ancestorsOf, progress, canEdit,
  onSetStatus, onSetProgress, onOpenDetail, onChangeDay, onClose, colorOf,
}: Props) {
  const dayMs = dayKeyToMs(day, tz);
  const label = fmtInTz(dayMs, tz, { weekday: "long", month: "long", day: "numeric" });
  // Today (plant time) also carries LIVE work whatever the plan says:
  // overdue open steps (carry-over) and steps started ahead of plan.
  const isToday = dayKey(Date.now(), tz) === day;
  const live = useMemo(() => {
    if (!isToday) return { overdue: [] as ReturnType<typeof overdueOpenWork>, early: [] as ReturnType<typeof startedEarlyWork> };
    return { overdue: overdueOpenWork(milestones, dayMs), early: startedEarlyWork(milestones, addDays(dayMs, 1, tz)) };
  }, [isToday, milestones, dayMs, tz]);

  const groups = useMemo(() => {
    const isLeaf = (m: Milestone) => !m.id || (childrenByParent.get(m.id) ?? []).length === 0;
    const rows: Row[] = [];
    for (const m of milestones) {
      if (!isLeaf(m) || !m.plannedAt) continue;
      const s = startMsOf(m), f = finishMsOf(m);
      if (!Number.isFinite(s) || !Number.isFinite(f)) continue;
      const sKey = dayKey(s, tz), fKey = dayKey(f, tz);
      if (sKey > day || fKey < day) continue;
      rows.push({ leaf: m, startsToday: sKey === day, endsToday: fKey === day, startMs: s, finishMs: f });
    }
    for (const w of live.overdue) rows.push({ leaf: w.leaf, startsToday: false, endsToday: false, startMs: w.start, finishMs: w.finish, live: "overdue" });
    for (const w of live.early) rows.push({ leaf: w.leaf, startsToday: false, endsToday: false, startMs: w.start, finishMs: w.finish, live: "started-early" });
    // Group by immediate parent; order groups by their first step's time.
    const byParent = new Map<string, EquipmentGroup>();
    for (const r of rows) {
      const chain = ancestorsOf(r.leaf);
      const parent = chain[0] ?? null;
      const key = parent?.id ?? `__top:${r.leaf.id}`;
      let g = byParent.get(key);
      if (!g) {
        const top = chain.length ? chain[chain.length - 1] : r.leaf;
        g = { parent, crumbs: chain.slice(1).reverse(), top, rows: [] };
        byParent.set(key, g);
      }
      g.rows.push(r);
    }
    const rank = (r: Row) => (r.live === "overdue" ? 0 : r.live === "started-early" ? 1 : r.startsToday ? 3 : 2);
    const cmpRow = (a: Row, b: Row) => {
      // Overdue carry-over first, then work started early, then today's
      // carry-ins (running since 00:00), then by start time.
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (a.startMs - b.startMs) || (a.finishMs - b.finishMs) || wbsCompare(a.leaf.wbs, b.leaf.wbs) || a.leaf.name.localeCompare(b.leaf.name);
    };
    const out = Array.from(byParent.values());
    for (const g of out) g.rows.sort(cmpRow);
    out.sort((a, b) => cmpRow(a.rows[0], b.rows[0]));
    return out;
  }, [milestones, childrenByParent, ancestorsOf, day, tz, live]);

  const pctOf = (m: Milestone) =>
    (m.id ? progress?.get(m.id)?.percent : undefined) ?? (m.percentComplete != null ? Math.round(m.percentComplete) : (m.status === "completed" ? 100 : 0));

  const totals = useMemo(() => {
    let n = 0, done = 0, sum = 0;
    for (const g of groups) for (const r of g.rows) { n++; const p = pctOf(r.leaf); sum += p; if (r.leaf.status === "completed" || p >= 100) done++; }
    return { n, done, avg: n ? Math.round(sum / n) : 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, progress]);

  const windowOf = (r: Row) => {
    if (r.live === "overdue") return "OVERDUE";
    if (r.live === "started-early") return "early";
    const a = r.startsToday ? (clockLabel(r.startMs, tz) || "0:00") : "…";
    const b = r.endsToday ? (clockLabel(r.finishMs, tz) || "24:00") : "…";
    if (a === "…" && b === "…") return "all day";
    return `${a}–${b}`;
  };
  const spanNote = (r: Row) => {
    if (r.leaf.status === "completed") { const n = completionNote(r.leaf.actualAt, r.finishMs, tz); if (n) return n; }
    if (r.live === "overdue") return `was due ${fmtInTz(r.finishMs, tz, { month: "short", day: "numeric" })} ${clockLabel(r.finishMs, tz)} — carry-over, finish or re-plan it`;
    if (r.live === "started-early") return `planned ${fmtInTz(r.startMs, tz, { month: "short", day: "numeric" })} ${clockLabel(r.startMs, tz)} — started ahead of plan`;
    if (r.startsToday && r.endsToday) return null;
    const parts: string[] = [];
    if (!r.startsToday) parts.push(`started ${fmtInTz(r.startMs, tz, { month: "short", day: "numeric" })}`);
    if (!r.endsToday) parts.push(`runs to ${fmtInTz(r.finishMs, tz, { month: "short", day: "numeric" })}`);
    return parts.join(" · ");
  };

  return (
    <div className="fixed inset-0 z-[170] flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30" />
      <div
        className="relative h-full w-full max-w-xl bg-[var(--color-surface)] text-[var(--color-text)] shadow-2xl ring-1 ring-black/10 flex flex-col animate-in slide-in-from-right duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: the day, navigation, and the day's completion. */}
        <div className="px-4 py-3 border-b border-[var(--color-border)] bg-gradient-to-b from-white to-slate-50/40">
          <div className="flex items-center gap-2">
            <button onClick={() => onChangeDay(dayKey(addDays(dayMs, -1, tz), tz))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Previous day"><ChevronLeft className="w-4 h-4" /></button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-[var(--color-accent)] shrink-0" />
                <span className="text-sm font-black truncate">{label}</span>
                <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title={`Plant time: ${tz}`}>{tzAbbrev(tz, dayMs)}</span>
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {totals.n === 0 ? "Nothing scheduled this day." : <>{totals.n} step{totals.n === 1 ? "" : "s"} · {totals.done} done · {totals.avg}% complete</>}
                {isToday && live.overdue.length > 0 && <span className="ml-2 font-bold text-rose-700">{live.overdue.length} carried over</span>}
                {isToday && live.early.length > 0 && <span className="ml-2 font-bold text-blue-700">{live.early.length} started early</span>}
              </div>
            </div>
            <button onClick={() => onChangeDay(dayKey(addDays(dayMs, 1, tz), tz))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Next day"><ChevronRight className="w-4 h-4" /></button>
            <button onClick={onClose} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Close"><XIcon className="w-4 h-4" /></button>
          </div>
          {totals.n > 0 && (
            <div className="mt-2 h-1.5 rounded-full bg-black/10 overflow-hidden">
              <div className={`h-full ${totals.avg >= 100 ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${totals.avg}%` }} />
            </div>
          )}
        </div>

        {/* Body: equipment groups, each with the steps due today. */}
        <div className="flex-1 overflow-y-auto">
          {groups.map((g) => {
            const color = colorOf(g.top);
            const head = g.parent ?? g.rows[0].leaf;
            const headInfo = head.id ? progress?.get(head.id) : undefined;
            return (
              <section key={g.parent?.id ?? `top-${g.rows[0].leaf.id}`} className="border-b border-[var(--color-border)]">
                <div className={`px-4 py-2 flex items-center gap-2 ${color.soft}`}>
                  <span className={`w-1.5 h-5 rounded-sm shrink-0 ${color.bar}`} />
                  <div className="flex-1 min-w-0">
                    {g.crumbs.length > 0 && (
                      <div className={`text-[9px] font-bold uppercase tracking-wide truncate ${color.text}`}>
                        {g.crumbs.map((c) => c.name).join(" › ")}
                      </div>
                    )}
                    <button onClick={() => onOpenDetail(head)} className="flex items-center gap-1 text-[12px] font-bold text-[var(--color-text)] hover:underline text-left truncate max-w-full">
                      <Layers className="w-3 h-3 shrink-0 opacity-70" />
                      <span className="truncate">{head.name}</span>
                      <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
                    </button>
                  </div>
                  {g.parent && headInfo && (
                    <span className="shrink-0 text-[10px] font-mono text-[var(--color-text-muted)]" title="This equipment overall">
                      {headInfo.leafDone}/{headInfo.leafTotal} · {headInfo.percent}%
                    </span>
                  )}
                </div>
                <ul className="divide-y divide-[var(--color-border)]">
                  {g.rows.map((r) => {
                    const pct = pctOf(r.leaf);
                    const note = spanNote(r);
                    return (
                      <li key={r.leaf.id} className={`px-4 py-2 flex items-center gap-3 ${r.live === "overdue" ? "bg-rose-50" : r.live === "started-early" ? "bg-blue-50/60" : ""}`}>
                        <span className={`w-[88px] shrink-0 text-[11px] font-mono tabular-nums ${r.live === "overdue" ? "font-black text-rose-700" : r.live === "started-early" ? "font-bold text-blue-700" : "text-[var(--color-text-muted)]"}`}>{windowOf(r)}</span>
                        <span className="shrink-0">
                          <StatusControl
                            status={r.leaf.status} size="sm" variant="dot" disabled={!canEdit || !onSetStatus || !r.leaf.id}
                            onPick={(st, reason) => { if (r.leaf.id && onSetStatus) onSetStatus(r.leaf.id, st, reason); }}
                            percent={pct}
                            onSetProgress={onSetProgress ? (v) => { if (r.leaf.id) onSetProgress(r.leaf.id, v); } : undefined}
                          />
                        </span>
                        <button onClick={() => onOpenDetail(r.leaf)} className="flex-1 min-w-0 text-left">
                          <span className={`block text-[12px] truncate ${r.leaf.status === "completed" ? "line-through text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{r.leaf.name}</span>
                          <span className="block text-[9.5px] text-[var(--color-text-faint)] truncate">
                            {[note, r.leaf.responsibleParty, r.leaf.workOrderRef ? `WO ${r.leaf.workOrderRef}` : null].filter(Boolean).join(" · ")}
                          </span>
                        </button>
                        <span className="shrink-0 w-16 flex items-center justify-end gap-1">
                          <span className="h-1 w-8 rounded-full bg-black/10 overflow-hidden">
                            <span className={`block h-full ${pct >= 100 ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${pct}%` }} />
                          </span>
                          <ProgressControl
                            percent={pct}
                            onPick={(v) => { if (r.leaf.id && onSetProgress) onSetProgress(r.leaf.id, v); }}
                            disabled={!canEdit || !onSetProgress || !r.leaf.id}
                            size="sm"
                          />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {groups.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">No steps are scheduled on {label}.</div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)]">
          Dot = status · % = progress · an ellipsis means the step continues past this day · click a name to open it.
        </div>
      </div>
    </div>
  );
}
