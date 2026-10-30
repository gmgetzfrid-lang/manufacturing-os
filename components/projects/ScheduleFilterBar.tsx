"use client";

// ScheduleFilterBar — find anything in a 500-task schedule instantly.
// A search box + one-tap quick filters (status, group, overdue,
// blocked). Shows a live match count and a one-click Clear. Designed
// to sit above the board in every view (timeline / calendar / report).

import React from "react";
import { Search, X as XIcon, AlertTriangle, PauseCircle, SlidersHorizontal, Sun, Moon, Sunset, PlusCircle, Flame, TrendingDown, Circle } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import type { ScheduleFilter } from "@/lib/scheduleFilter";
import { isFilterActive, EMPTY_FILTER } from "@/lib/scheduleFilter";
import { ADDED } from "@/lib/discovery";

const STATUS_CHIPS: Array<{ s: MilestoneStatus; label: string; dot: string }> = [
  { s: "planned", label: "Planned", dot: "bg-slate-400" },
  { s: "in_progress", label: "In progress", dot: "bg-blue-500" },
  { s: "completed", label: "Done", dot: "bg-emerald-500" },
  { s: "on_hold", label: "On hold", dot: "bg-amber-500" },
  { s: "blocked", label: "Blocked", dot: "bg-rose-500" },
  { s: "missed", label: "Missed", dot: "bg-rose-600" },
];

interface Props {
  filter: ScheduleFilter;
  onChange: (f: ScheduleFilter) => void;
  /** Top-level groups for the group chips. */
  groups: Milestone[];
  /** How many leaf tasks match right now (for the count badge). */
  matchCount: number;
  totalCount: number;
}

export default function ScheduleFilterBar({ filter, onChange, groups, matchCount, totalCount }: Props) {
  const active = isFilterActive(filter);
  const [showMore, setShowMore] = React.useState(false);

  const toggleStatus = (s: MilestoneStatus) => {
    const has = filter.statuses.includes(s);
    onChange({ ...filter, statuses: has ? filter.statuses.filter((x) => x !== s) : [...filter.statuses, s] });
  };
  const toggleGroup = (id: string) => {
    const has = filter.groupIds.includes(id);
    onChange({ ...filter, groupIds: has ? filter.groupIds.filter((x) => x !== id) : [...filter.groupIds, id] });
  };

  const TONE = {
    rose: "bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300",
    amber: "bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300",
    violet: "bg-violet-50 dark:bg-violet-950/40 border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300",
    slate: "bg-slate-100 dark:bg-slate-800 border-slate-400 dark:border-slate-500 text-slate-800 dark:text-slate-100",
  };
  const quick = (label: string, icon: React.ReactNode, on: boolean, tone: keyof typeof TONE, flip: () => void) => (
    <button type="button" onClick={flip} aria-pressed={on}
      className={`shrink-0 whitespace-nowrap inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors ${on ? TONE[tone] : "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"}`}>
      {icon} {label}
    </button>
  );

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03] px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Search box */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
          <input
            value={filter.query}
            onChange={(e) => onChange({ ...filter, query: e.target.value })}
            placeholder="Search tasks, work-order number, area, person…"
            className="w-full pl-8 pr-8 py-1.5 text-sm border border-[var(--color-border-strong)] rounded-lg outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]/30 focus:border-[var(--color-accent-ring)]"
          />
          {filter.query && (
            <button onClick={() => onChange({ ...filter, query: "" })} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] transition-colors" title="Clear search">
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Quick filters: each narrows what's shown, together they narrow
            each other (critical and behind = critical steps behind). */}
        <div role="group" aria-label="Quick filters" className="flex items-center gap-1.5 sm:flex-wrap max-sm:w-full max-sm:overflow-x-auto max-sm:pb-0.5 scroll-quiet">
          {quick("Critical path", <Flame className="w-3.5 h-3.5" />, !!filter.criticalOnly, "rose", () => onChange({ ...filter, criticalOnly: !filter.criticalOnly }))}
          {quick("Behind", <TrendingDown className="w-3.5 h-3.5" />, !!filter.behindOnly, "amber", () => onChange({ ...filter, behindOnly: !filter.behindOnly }))}
          {quick("Overdue", <AlertTriangle className="w-3.5 h-3.5" />, filter.overdueOnly, "rose", () => onChange({ ...filter, overdueOnly: !filter.overdueOnly }))}
          {quick("Not started", <Circle className="w-3.5 h-3.5" />, !!filter.notStartedOnly, "slate", () => onChange({ ...filter, notStartedOnly: !filter.notStartedOnly }))}
          {quick("Needs attention", <PauseCircle className="w-3.5 h-3.5" />, filter.blockedOnly, "rose", () => onChange({ ...filter, blockedOnly: !filter.blockedOnly }))}
          {/* Work added after the plan: discovery and added scope. */}
          {quick(filter.added?.length === 1 ? ADDED[filter.added[0]].word : "Discovery & added", <PlusCircle className="w-3.5 h-3.5" />, !!filter.added?.length, "violet",
            () => onChange({ ...filter, added: filter.added?.length ? [] : ["discovery", "added"] }))}
          <button
            onClick={() => setShowMore((v) => !v)}
            className={`shrink-0 whitespace-nowrap inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors ${showMore || filter.statuses.length || filter.groupIds.length || filter.shifts.length ? "bg-[var(--color-accent-soft)] border-[var(--color-accent-ring)]/50 text-[var(--color-accent)]" : "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"}`}
          >
            {(() => { const n = filter.statuses.length + filter.groupIds.length + filter.shifts.length; return <><SlidersHorizontal className="w-3.5 h-3.5" /> Filters{n > 0 ? ` (${n})` : ""}</>; })()}
          </button>
        </div>

        {/* Match count + clear */}
        <span className="text-[11px] text-[var(--color-text-muted)] font-mono ml-auto">
          {active ? <><b className="text-[var(--color-text)]">{matchCount}</b> of {totalCount}</> : <>{totalCount} tasks</>}
        </span>
        {active && (
          <button onClick={() => onChange(EMPTY_FILTER)} className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] px-2 py-1 rounded hover:bg-[var(--color-accent-soft)] transition-colors">
            <XIcon className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* Expanded: status + group chips */}
      {showMore && (
        <div className="pt-1 space-y-2 border-t border-[var(--color-border)]">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mr-1">Status</span>
            {STATUS_CHIPS.map(({ s, label, dot }) => {
              const on = filter.statuses.includes(s);
              return (
                <button key={s} onClick={() => toggleStatus(s)} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold border transition-colors ${on ? "bg-slate-900 text-white border-slate-900" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dot}`} /> {label}
                </button>
              );
            })}
          </div>
          {groups.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mr-1">Group</span>
              {groups.map((g) => {
                const on = !!g.id && filter.groupIds.includes(g.id);
                return (
                  <button key={g.id} onClick={() => g.id && toggleGroup(g.id)} className={`px-2 py-1 rounded-full text-[11px] font-semibold border transition-colors ${on ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-accent-ring)]/60"}`}>
                    {g.name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mr-1">Added work</span>
            {(["discovery", "added"] as const).map((k) => {
              const on = !!filter.added?.includes(k);
              return (
                <button key={k} aria-pressed={on} onClick={() => onChange({ ...filter, added: on ? (filter.added ?? []).filter((x) => x !== k) : [...(filter.added ?? []), k] })}
                  className={`px-2 py-1 rounded-full text-[11px] font-semibold border transition-colors ${on ? "bg-violet-700 text-white border-violet-700" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>
                  {ADDED[k].word}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mr-1">Shift</span>
            {(["day", "night", "swing"] as const).map((sh) => {
              const on = filter.shifts.includes(sh);
              const has = filter.shifts.includes(sh);
              return (
                <button
                  key={sh}
                  onClick={() => onChange({ ...filter, shifts: has ? filter.shifts.filter((x) => x !== sh) : [...filter.shifts, sh] })}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold border capitalize transition-colors ${on ? "bg-slate-900 text-white border-slate-900" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}
                >
                  {sh === "day" ? <Sun className="w-3 h-3" /> : sh === "night" ? <Moon className="w-3 h-3" /> : <Sunset className="w-3 h-3" />} {sh}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
