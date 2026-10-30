"use client";

// AddWorkPicker — adding discovery or added scope from a calendar day, or
// an hour of the shift notes: first the work order it goes under (the ones
// worked that day on top), then the same form as on Work orders, with the
// day (or the hour) filled in.

import React, { useMemo, useState } from "react";
import { Plus, Search, X as XIcon } from "lucide-react";
import type { Milestone } from "@/types/schema";
import { dayKeyToMs, fmtInTz, fromDateTimeInput } from "@/lib/scheduleTz";
import { inheritedWorkOrders } from "@/lib/workOrderCrew";

const ms = (v: unknown) => (v == null || v === "" ? NaN : Date.parse(String(v)));

/** The work orders discovery can go under (tasks with steps), those with
 *  work planned or done on the day first. */
export function workOrdersForDay(milestones: Milestone[], day: string, tz: string): { onDay: Milestone[]; others: Milestone[] } {
  const kids = new Map<string, Milestone[]>();
  for (const m of milestones) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
  const isLeaf = (m: Milestone) => !m.id || !(kids.get(m.id) ?? []).length;
  const from = dayKeyToMs(day, tz), to = from + 86_400_000;
  const touches = (s: Milestone) => {
    const ps = ms(s.plannedStartAt ?? s.plannedAt), pf = ms(s.plannedAt);
    const as = ms(s.actualStartAt), af = ms(s.actualAt);
    return (ps < to && pf > from) || (as < to && (Number.isFinite(af) ? af : as) >= from);
  };
  const tasks = milestones.filter((m) => m.id && !m.cancelledAt && (kids.get(m.id) ?? []).some(isLeaf));
  const onDay: Milestone[] = [], others: Milestone[] = [];
  for (const t of tasks) ((kids.get(t.id!) ?? []).some((s) => isLeaf(s) && touches(s)) ? onDay : others).push(t);
  const byName = (a: Milestone, b: Milestone) => a.name.localeCompare(b.name, undefined, { numeric: true });
  return { onDay: onDay.sort(byName), others: others.sort(byName) };
}

export default function AddWorkPicker({ day: when, tz, milestones, onPick, onNew, onClose }: {
  /** "YYYY-MM-DD", or "YYYY-MM-DDTHH:mm" for an hour. */
  day: string; tz: string; milestones: Milestone[];
  onPick: (task: Milestone) => void;
  /** A work order of its own, not under one on the schedule. */
  onNew?: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const day = when.slice(0, 10);
  const { onDay, others } = useMemo(() => workOrdersForDay(milestones, day, tz), [milestones, day, tz]);
  const wos = useMemo(() => inheritedWorkOrders(milestones), [milestones]);
  const parentName = useMemo(() => new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m.name])), [milestones]);
  const wo = (m: Milestone) => m.workOrderRef?.trim() || (m.id ? wos.get(m.id) : undefined) || "";
  const hit = (m: Milestone) => !q.trim() || `${m.name} ${wo(m)} ${m.parentId ? parentName.get(m.parentId) ?? "" : ""}`.toLowerCase().includes(q.trim().toLowerCase());
  const at = when.length >= 16 ? Date.parse(fromDateTimeInput(when, tz) ?? "") : NaN;
  const label = Number.isFinite(at)
    ? fmtInTz(at, tz, { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
    : fmtInTz(dayKeyToMs(day, tz) + 12 * 3_600_000, tz, { weekday: "long", month: "short", day: "numeric" });
  const list = (title: string, xs: Milestone[]) => {
    const shown = xs.filter(hit);
    if (!shown.length) return null;
    return (
      <div>
        <div className="px-3 pt-2 pb-1 text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">{title}</div>
        {shown.map((m) => (
          <button key={m.id} type="button" onClick={() => onPick(m)}
            className="w-full text-left px-3 py-2 hover:bg-[var(--color-surface-2)] border-t border-[var(--color-border)] first:border-t-0">
            {m.parentId && <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)] truncate">{parentName.get(m.parentId)}</div>}
            <div className="text-[13px] font-semibold text-[var(--color-text)] break-words">{m.name}{wo(m) && <span className="ml-1.5 font-normal text-[var(--color-text-muted)]">WO {wo(m)}</span>}</div>
          </button>
        ))}
      </div>
    );
  };
  return (
    <div className="fixed inset-0 z-[180] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-label={`Add discovery or added scope - ${label}`} onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-xl">
        <div className="px-4 pt-3 pb-2 border-b border-[var(--color-border)]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[15px] font-bold text-[var(--color-text)] inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> Add discovery or added scope</div>
              <div className="text-[12px] text-[var(--color-text-muted)]">{label} - {onNew ? "a new work order, or under one on the schedule?" : "which work order is it under?"}</div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><XIcon className="w-4 h-4" /></button>
          </div>
          <div className="mt-2 relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find equipment or WO #"
              autoFocus={typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches}
              className="w-full h-8 pl-8 pr-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent-ring)]" />
          </div>
        </div>
        <div className="overflow-y-auto">
          {onNew && !q.trim() && (
            <button type="button" onClick={onNew}
              className="w-full text-left px-3 py-2.5 border-b border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
              <div className="text-[13px] font-bold text-[var(--color-accent)] inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> New work order</div>
              <div className="text-[11.5px] text-[var(--color-text-muted)]">Its own WO #, name, steps and crew - not under one already on the schedule</div>
            </button>
          )}
          {list("Worked this day", onDay)}
          {list(onDay.length ? "Every other work order" : "Work orders", others)}
          {![...onDay, ...others].some(hit) && <div className="px-4 py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">No work order matches.</div>}
        </div>
      </div>
    </div>
  );
}
