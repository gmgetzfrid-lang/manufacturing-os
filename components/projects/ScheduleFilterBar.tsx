"use client";

// ScheduleFilterBar — find anything in a 500-task schedule instantly.
// A search box + one-tap quick filters (status, group, overdue,
// blocked). Shows a live match count and a one-click Clear. Designed
// to sit above the board in every view (timeline / calendar / report).

import React from "react";
import { Search, X as XIcon, AlertTriangle, PauseCircle, SlidersHorizontal } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import type { ScheduleFilter } from "@/lib/scheduleFilter";
import { isFilterActive } from "@/lib/scheduleFilter";

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

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Search box */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={filter.query}
            onChange={(e) => onChange({ ...filter, query: e.target.value })}
            placeholder="Search tasks, WO#, area, person…"
            className="w-full pl-8 pr-8 py-1.5 text-sm border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
          />
          {filter.query && (
            <button onClick={() => onChange({ ...filter, query: "" })} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-slate-100 text-slate-400" title="Clear search">
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Quick toggles */}
        <button
          onClick={() => onChange({ ...filter, blockedOnly: !filter.blockedOnly })}
          className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors ${filter.blockedOnly ? "bg-rose-50 border-rose-300 text-rose-700" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"}`}
        >
          <PauseCircle className="w-3.5 h-3.5" /> Needs attention
        </button>
        <button
          onClick={() => onChange({ ...filter, overdueOnly: !filter.overdueOnly })}
          className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors ${filter.overdueOnly ? "bg-rose-50 border-rose-300 text-rose-700" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"}`}
        >
          <AlertTriangle className="w-3.5 h-3.5" /> Overdue
        </button>
        <button
          onClick={() => setShowMore((v) => !v)}
          className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors ${showMore || filter.statuses.length || filter.groupIds.length ? "bg-indigo-50 border-indigo-300 text-indigo-700" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"}`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" /> Filters{filter.statuses.length + filter.groupIds.length > 0 ? ` (${filter.statuses.length + filter.groupIds.length})` : ""}
        </button>

        {/* Match count + clear */}
        <span className="text-[11px] text-slate-500 font-mono ml-auto">
          {active ? <><b className="text-slate-900">{matchCount}</b> of {totalCount}</> : <>{totalCount} tasks</>}
        </span>
        {active && (
          <button onClick={() => onChange({ query: "", statuses: [], groupIds: [], overdueOnly: false, blockedOnly: false })} className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-700 hover:text-indigo-900 px-2 py-1 rounded hover:bg-indigo-50">
            <XIcon className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* Expanded: status + group chips */}
      {showMore && (
        <div className="pt-1 space-y-2 border-t border-slate-100">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Status</span>
            {STATUS_CHIPS.map(({ s, label, dot }) => {
              const on = filter.statuses.includes(s);
              return (
                <button key={s} onClick={() => toggleStatus(s)} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold border transition-colors ${on ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dot}`} /> {label}
                </button>
              );
            })}
          </div>
          {groups.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Group</span>
              {groups.map((g) => {
                const on = !!g.id && filter.groupIds.includes(g.id);
                return (
                  <button key={g.id} onClick={() => g.id && toggleGroup(g.id)} className={`px-2 py-1 rounded-full text-[11px] font-semibold border transition-colors ${on ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200 hover:border-indigo-300"}`}>
                    {g.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
