"use client";

// ScheduleFilterBar — find anything in a 500-task schedule instantly.
// A search box + one-tap quick filters (status, group, overdue,
// blocked). Shows a live match count and a one-click Clear. Designed
// to sit above the board in every view (timeline / calendar / report).

import React from "react";
import { Search, X as XIcon, AlertTriangle, PauseCircle, SlidersHorizontal, Sun, Moon, Sunset, Flame, TrendingDown, Circle } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import type { ScheduleFilter } from "@/lib/scheduleFilter";
import { isFilterActive, EMPTY_FILTER } from "@/lib/scheduleFilter";
import { ADDED } from "@/lib/discovery";

const STATUS_CHIPS: Array<{ s: MilestoneStatus; label: string; dot: string }> = [
  { s: "planned", label: "Planned", dot: "bg-slate-400" },
  { s: "in_progress", label: "In progress", dot: "bg-[var(--color-text-muted)]" },
  { s: "completed", label: "Done", dot: "bg-[var(--state-released)]" },
  { s: "on_hold", label: "On hold", dot: "bg-[var(--state-held)]" },
  { s: "blocked", label: "Blocked", dot: "bg-[var(--state-overdue)]" },
  { s: "missed", label: "Missed", dot: "bg-[var(--state-overdue)]" },
];

interface Props {
  filter: ScheduleFilter;
  onChange: (f: ScheduleFilter) => void;
  /** Top-level groups for the group chips. */
  groups: Milestone[];
  /** How many leaf tasks match right now (for the count badge). */
  matchCount: number;
  totalCount: number;
  /** The unit and equipment type pickers (components/projects/WoClassFilter). */
  classSelects?: React.ReactNode;
}

export default function ScheduleFilterBar({ filter, onChange, groups, matchCount, totalCount, classSelects }: Props) {
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

  // Picked: dark, like every other chip here.
  const ON = "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)] ring-1 ring-inset ring-[var(--color-accent-text)]/30 border-transparent";
  const quick = (label: string, icon: React.ReactNode, on: boolean, flip: () => void) => (
    <button type="button" onClick={flip} aria-pressed={on}
      className={`shrink-0 whitespace-nowrap inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors ${on ? ON : "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"}`}>
      {icon} {label}
    </button>
  );

  return (
    // A quiet row on the card it sits in (Plan's task list, the Work board).
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Search box */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
          <input
            value={filter.query}
            onChange={(e) => onChange({ ...filter, query: e.target.value })}
            placeholder="Search tasks, work-order number, area, person…"
            aria-label="Search tasks"
            className="w-full h-9 pl-8 pr-8 text-[13px] rounded-[10px] bg-[var(--color-surface-2)] border border-transparent placeholder:text-[var(--color-text-faint)] focus:bg-[var(--color-surface)]"
          />
          {filter.query && (
            <button onClick={() => onChange({ ...filter, query: "" })} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] transition-colors" title="Clear search">
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* One Filter button: the quick filters, units, status and groups are
            in its panel, so the work itself is on screen. */}
          <button
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
            className={`shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] text-[13px] font-semibold transition-colors ${showMore || filter.statuses.length || filter.groupIds.length || filter.shifts.length ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)] ring-1 ring-inset ring-[var(--color-accent-text)]/30" : "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}
          >
            {(() => { const n = filter.statuses.length + filter.groupIds.length + filter.shifts.length + [filter.criticalOnly, filter.behindOnly, filter.overdueOnly, filter.notStartedOnly, filter.blockedOnly, !!filter.added?.length].filter(Boolean).length + (filter.units?.length ?? 0) + (filter.types?.length ?? 0); return <><SlidersHorizontal className="w-3.5 h-3.5" /> Filter{n > 0 ? ` (${n})` : ""}</>; })()}
          </button>
        {/* Match count + clear */}
        <span className="text-[12px] text-[var(--color-text-muted)] tabular-nums ml-auto">
          {active ? <><b className="text-[var(--color-text)]">{matchCount}</b> of {totalCount}</> : <>{totalCount} tasks</>}
        </span>
        {active && (
          <button onClick={() => onChange(EMPTY_FILTER)} className="inline-flex items-center gap-1 h-9 text-[13px] font-semibold text-[var(--color-text)] px-2 rounded-[10px] hover:bg-[var(--color-surface-2)] transition-colors">
            <XIcon className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* Expanded: status + group chips */}
      {showMore && (
        <div className="pt-2.5 space-y-2 border-t border-[var(--color-border)]">
          <div role="group" aria-label="Show only" className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-[var(--color-text-muted)] mr-1">Show only</span>
          {classSelects}
          {quick("Critical path", <Flame className="w-3.5 h-3.5" />, !!filter.criticalOnly, () => onChange({ ...filter, criticalOnly: !filter.criticalOnly }))}
          {quick("Behind", <TrendingDown className="w-3.5 h-3.5" />, !!filter.behindOnly, () => onChange({ ...filter, behindOnly: !filter.behindOnly }))}
          {quick("Overdue", <AlertTriangle className="w-3.5 h-3.5" />, filter.overdueOnly, () => onChange({ ...filter, overdueOnly: !filter.overdueOnly }))}
          {quick("Not started", <Circle className="w-3.5 h-3.5" />, !!filter.notStartedOnly, () => onChange({ ...filter, notStartedOnly: !filter.notStartedOnly }))}
          {quick("Needs attention", <PauseCircle className="w-3.5 h-3.5" />, filter.blockedOnly, () => onChange({ ...filter, blockedOnly: !filter.blockedOnly }))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-[var(--color-text-muted)] mr-1">Status</span>
            {STATUS_CHIPS.map(({ s, label, dot }) => {
              const on = filter.statuses.includes(s);
              return (
                <button key={s} onClick={() => toggleStatus(s)} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold border transition-colors ${on ? ON : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dot}`} /> {label}
                </button>
              );
            })}
          </div>
          {groups.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[13px] font-semibold text-[var(--color-text-muted)] mr-1">Group</span>
              {groups.map((g) => {
                const on = !!g.id && filter.groupIds.includes(g.id);
                return (
                  <button key={g.id} onClick={() => g.id && toggleGroup(g.id)} className={`px-2 py-1 rounded-full text-[11px] font-semibold border transition-colors ${on ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)] ring-1 ring-inset ring-[var(--color-accent-text)]/30 border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>
                    {g.name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-[var(--color-text-muted)] mr-1">Discovery &amp; added</span>
            {(["discovery", "added"] as const).map((k) => {
              const on = !!filter.added?.includes(k);
              return (
                <button key={k} aria-pressed={on} onClick={() => onChange({ ...filter, added: on ? (filter.added ?? []).filter((x) => x !== k) : [...(filter.added ?? []), k] })}
                  className={`px-2 py-1 rounded-full text-[11px] font-semibold border transition-colors ${on ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)] ring-1 ring-inset ring-[var(--color-accent-text)]/30 border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>
                  {ADDED[k].word}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-[var(--color-text-muted)] mr-1">Shift</span>
            {(["day", "night", "swing"] as const).map((sh) => {
              const on = filter.shifts.includes(sh);
              const has = filter.shifts.includes(sh);
              return (
                <button
                  key={sh}
                  onClick={() => onChange({ ...filter, shifts: has ? filter.shifts.filter((x) => x !== sh) : [...filter.shifts, sh] })}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold border capitalize transition-colors ${on ? ON : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}
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
