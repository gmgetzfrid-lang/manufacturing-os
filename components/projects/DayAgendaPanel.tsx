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
//
// Built for entering a shift's progress from the contractors' reports in
// one sitting: click a step and it opens IN PLACE with what the report
// gives — % done, status, what's blocking it, a note — then Next moves to
// the following step. A search box narrows the list to an equipment tag
// or WO number. The full detail panel is one click away and never needed
// for a progress update.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X as XIcon, CalendarDays, Layers, ExternalLink, Search, ArrowDown, Check, Sun, Moon } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import StatusControl from "@/components/projects/StatusControl";
import ProgressControl, { PICK_PCTS } from "@/components/projects/ProgressControl";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { clockLabel, dayKey, dayKeyToMs, fmtInTz, addDays, tzAbbrev } from "@/lib/scheduleTz";
import { startMsOf, finishMsOf, wbsCompare, stepShiftOnDay } from "@/lib/calendarPlacement";
import { overdueOpenWork, startedEarlyWork } from "@/lib/openWork";
import { completionNote } from "@/lib/scheduleRules";
import { DEFAULT_SHIFT_TIMES, expectedByParent, expectedFraction, shiftAt, shiftWindow, workShiftOf, type ShiftTimes } from "@/lib/shiftReport";
import { latestNotes, updateMilestoneNote } from "@/lib/milestones";
import ShiftMark from "@/components/projects/ShiftMark";

interface Props {
  day: string; // "YYYY-MM-DD" in the plant zone
  /** Kept mounted but out of sight (a task's details are open on top). */
  hidden?: boolean;
  /** Shown in the page (the calendar's Day view) instead of sliding over it. */
  inline?: boolean;
  /** Each task's planned % by now over ALL its steps (a crew or search
   *  filter mustn't shrink the plan behind "x% of y% planned"). */
  planNow?: Map<string, number>;
  tz: string;
  milestones: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  ancestorsOf: (m: Milestone) => Milestone[];
  progress?: Map<string, ProgressInfo>;
  canEdit: boolean;
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string, percent?: number) => unknown;
  onSetProgress?: (id: string, percent: number) => unknown;
  /** Add a note to the step's log. */
  onAddNote?: (id: string, body: string) => Promise<void> | void;
  /** Who is signed in — their own comments can be edited here. */
  userId?: string;
  /** Set a step's % with what got done (required for work in progress). */
  onSetProgressNote?: (id: string, percent: number, note: string) => Promise<boolean> | boolean;
  /** Start a step with what got done. */
  onStartNote?: (id: string, percent: number, note: string) => Promise<boolean> | boolean;
  /** The project's shift-change times — which crew does each step. */
  shiftTimes?: ShiftTimes;
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
  onSetStatus, onSetProgress, onAddNote, onOpenDetail, onChangeDay, onClose, colorOf, shiftTimes = DEFAULT_SHIFT_TIMES, hidden, planNow: planNowAll, userId, onSetProgressNote, onStartNote, inline,
}: Props) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // Each piece of equipment is a section that folds open and shut; which
  // ones the person opened or closed (by group key).
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
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
    // Equipment in the order its work starts; its steps in time order inside.
    return out;
  }, [milestones, childrenByParent, ancestorsOf, day, tz, live]);

  // Narrow to an equipment tag, WO number, step name or crew — the way a
  // contractor's report names the work.
  const shownGroups = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/[\s_-]+/g, "");
    if (!q) return groups;
    const hit = (t?: string | null) => !!t && t.toLowerCase().replace(/[\s_-]+/g, "").includes(q);
    return groups.map((g) => {
      const groupHit = hit(g.parent?.name) || g.crumbs.some((c) => hit(c.name));
      return { ...g, rows: groupHit ? g.rows : g.rows.filter((r) => hit(r.leaf.name) || hit(r.leaf.workOrderRef) || hit(r.leaf.responsibleParty) || hit(r.leaf.location)) };
    }).filter((g) => g.rows.length > 0);
  }, [groups, query]);
  // The day shift's work, then the night shift's: a step the night crew
  // works goes under Night shift, so night work never sits in the middle
  // of the day's list. Without night work there's one list, no headings.
  const sections = useMemo(() => {
    // Night work on this day: when it's scheduled today, for the crews
    // that can work then (a round-the-clock crew's 18:00 step is night).
    const dayShift = shiftWindow(day, "day", tz, shiftTimes);
    const nextDay = addDays(dayMs, 1, tz);
    const isNight = (r: Row) => {
      const crew = workShiftOf(r.leaf, tz, shiftTimes);
      return (r.live ? crew : stepShiftOnDay(r.startMs, r.finishMs, crew, dayMs, nextDay, dayShift)) === "night";
    };
    const part = (pred: (r: Row) => boolean) => shownGroups
      .map((g) => ({ ...g, rows: g.rows.filter(pred) }))
      .filter((g) => g.rows.length > 0);
    const first = (g: EquipmentGroup) => g.rows[0];
    const lead = (r: Row) => (r.live === "overdue" ? 0 : r.live === "started-early" ? 1 : 2);
    const dayGroups = part((r) => !isNight(r));
    const nightGroups = part(isNight).sort((a, b) => lead(first(a)) - lead(first(b)) || first(a).startMs - first(b).startMs);
    if (nightGroups.length === 0) return [{ key: "all", shift: null, groups: dayGroups }];
    return [
      ...(dayGroups.length ? [{ key: "day", shift: "day" as const, groups: dayGroups }] : []),
      { key: "night", shift: "night" as const, groups: nightGroups },
    ];
  }, [shownGroups, tz, shiftTimes, day, dayMs]);

  // Each step's latest comment: on its row, and in its box to edit.
  const [latestByStep, setLatestByStep] = useState<Map<string, LatestNote>>(new Map());
  const [notesTick, setNotesTick] = useState(0);
  const dayStepIds = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.leaf.id).filter((x): x is string => !!x)).sort().join(","), [groups]);
  useEffect(() => {
    if (!dayStepIds) return;
    let alive = true;
    latestNotes(dayStepIds.split(",")).then((m) => { if (alive) setLatestByStep(m); }).catch(() => undefined);
    return () => { alive = false; };
  }, [dayStepIds, notesTick]);
  const keyOf = (g: EquipmentGroup) => g.parent?.id ?? `top-${g.rows[0].leaf.id}`;
  const isOpen = (g: EquipmentGroup) => {
    if (query.trim()) return true;
    const t = toggled.get(keyOf(g));
    if (t !== undefined) return t;
    // Few pieces of equipment: all open. Many: closed, except ones with
    // late work and the one holding the step being edited.
    return inline || groups.length <= 4 || g.rows.some((r) => r.live === "overdue" || r.leaf.id === openId);
  };
  const toggle = (g: EquipmentGroup) => setToggled((m) => new Map(m).set(keyOf(g), !isOpen(g)));
  // Next into a section the person closed opens it, so the step shows.
  const openGroupOf = (id: string) => {
    const g = shownGroups.find((x) => x.rows.some((r) => r.leaf.id === id));
    if (g && toggled.get(keyOf(g)) === false) setToggled((m) => new Map(m).set(keyOf(g), true));
  };
  const order = useMemo(() => sections.flatMap((sec) => sec.groups.flatMap((g) => g.rows.map((r) => r.leaf.id).filter((x): x is string => !!x))), [sections]);
  const nextOf = (id: string) => { const i = order.indexOf(id); return i >= 0 && i + 1 < order.length ? order[i + 1] : null; };

  // Where the plan has each piece of equipment right now — "19% of 25%
  // planned" beside its progress.
  const [nowMs] = useState(() => Date.now());
  const planNowHere = useMemo(() => (planNowAll ? null : expectedByParent(milestones, nowMs, tz, shiftTimes)), [planNowAll, milestones, nowMs, tz, shiftTimes]);
  const planNow = planNowAll ?? planNowHere ?? new Map<string, number>();
  // Where each step should be by the end of the shift: today, the shift
  // running now; another day, the end of that day's night shift.
  const goalAt = isToday ? shiftAt(nowMs, tz, shiftTimes).end : shiftWindow(day, "night", tz, shiftTimes).end;
  const goalLabel = isToday ? clockLabel(goalAt, tz) : fmtInTz(goalAt, tz, { weekday: "short" }) + " " + clockLabel(goalAt, tz);
  const goalOf = (m: Milestone) => Math.round(expectedFraction(m, goalAt, tz, shiftTimes) * 100);
  // What a step waits on, by name: predecessors not done yet.
  const byIdAll = useMemo(() => new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m])), [milestones]);
  const waitsOn = (m: Milestone) => (m.dependsOn ?? []).map((id) => byIdAll.get(id))
    .filter((p): p is Milestone => !!p && p.status !== "completed" && (p.percentComplete ?? 0) < 100);
  // A search also finds steps on other days, to jump to them.
  const otherDays = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const here = new Set(groups.flatMap((g) => g.rows.map((r) => r.leaf.id)));
    const kids = new Set(milestones.map((m) => m.parentId).filter(Boolean));
    const hit = (s?: string | null) => !!s && s.toLowerCase().includes(q);
    return milestones
      .filter((m) => m.id && !kids.has(m.id) && !here.has(m.id) && m.plannedAt)
      .filter((m) => hit(m.name) || hit(m.workOrderRef) || hit(m.responsibleParty) || ancestorsOf(m).some((a) => hit(a.name)))
      .sort((a, b) => startMsOf(a) - startMsOf(b))
      .slice(0, 12);
  }, [query, groups, milestones, ancestorsOf]);
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
    <div className={inline ? (hidden ? "hidden" : "") : `fixed inset-0 z-[170] flex justify-end ${hidden ? "hidden" : ""}`} onClick={inline ? undefined : onClose}>
      {!inline && <div className="absolute inset-0 bg-slate-900/30" />}
      <div
        className={inline
          ? "relative w-full max-h-[78vh] bg-[var(--color-surface)] text-[var(--color-text)] flex flex-col"
          : "relative h-full w-full max-w-xl bg-[var(--color-surface)] text-[var(--color-text)] shadow-2xl ring-1 ring-black/10 flex flex-col animate-in slide-in-from-right duration-150"}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: the day, navigation, and the day's completion. */}
        <div className="px-4 py-3 border-b border-[var(--color-border)] bg-gradient-to-b from-white dark:from-[var(--color-surface)] to-slate-50/40 dark:to-[var(--color-surface)]">
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
                {isToday && live.overdue.length > 0 && <span className="ml-2 font-bold text-rose-700 dark:text-rose-300">{live.overdue.length} carried over</span>}
                {isToday && live.early.length > 0 && <span className="ml-2 font-bold text-blue-700 dark:text-blue-300">{live.early.length} started early</span>}
              </div>
            </div>
            <button onClick={() => onChangeDay(dayKey(addDays(dayMs, 1, tz), tz))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Next day"><ChevronRight className="w-4 h-4" /></button>
            {!inline && <button onClick={onClose} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Close"><XIcon className="w-4 h-4" /></button>}
          </div>
          {totals.n > 0 && (
            <div className="mt-2 h-1.5 rounded-full bg-black/10 overflow-hidden">
              <div className={`h-full ${totals.avg >= 100 ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${totals.avg}%` }} />
            </div>
          )}
          {totals.n > 0 && (
            <div className="mt-2 relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
              <input value={query} onChange={(e) => setQuery(e.target.value)}
                // A keyboard popping up on a tablet hides half the list: focus only with a mouse.
                autoFocus={typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches}
                placeholder="Find equipment, WO # or step — e.g. E-606, 4410037"
                className="w-full h-8 pl-8 pr-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent-ring)]" />
              {query && <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]" title="Clear"><XIcon className="w-3.5 h-3.5" /></button>}
            </div>
          )}
          {groups.length > 1 && (
            <div className="mt-2 flex items-center gap-3 text-[11px] font-bold text-[var(--color-text-muted)]">
              <button onClick={() => setToggled(new Map(groups.map((g) => [keyOf(g), true])))} className="hover:text-[var(--color-text)]">Open all</button>
              <button onClick={() => setToggled(new Map(groups.map((g) => [keyOf(g), false])))} className="hover:text-[var(--color-text)]">Close all</button>
            </div>
          )}
        </div>

        {/* Body: equipment groups, each with the steps due today. */}
        <div className="flex-1 overflow-y-auto">
          {sections.map((sec) => (
            <React.Fragment key={sec.key}>
            {sec.shift === "day" && (
              <div className="sticky top-0 z-[1] px-4 py-1.5 flex items-center gap-2 border-b border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
                <Sun className="w-3.5 h-3.5" aria-hidden />
                <span className="text-[12px] font-black">Day shift</span>
                <span className="text-[11px] opacity-80">{shiftTimes.dayStart}–{shiftTimes.nightStart}</span>
                <span className="ml-auto text-[10.5px] font-semibold opacity-80">{sec.groups.reduce((a, g) => a + g.rows.length, 0)} steps</span>
              </div>
            )}
            {sec.shift === "night" && (
              <div className="sticky top-0 z-[1] px-4 py-1.5 flex items-center gap-2 bg-indigo-900 text-white dark:bg-indigo-950">
                <Moon className="w-3.5 h-3.5 text-indigo-200" aria-hidden />
                <span className="text-[12px] font-black">Night shift</span>
                <span className="text-[11px] text-indigo-200">{shiftTimes.nightStart}–{shiftTimes.dayStart}</span>
                <span className="ml-auto text-[10.5px] font-semibold text-indigo-200">{sec.groups.reduce((a, g) => a + g.rows.length, 0)} steps</span>
              </div>
            )}
            {sec.groups.map((g) => {
            const color = colorOf(g.top);
            const head = g.parent ?? g.rows[0].leaf;
            const headInfo = head.id ? progress?.get(head.id) : undefined;
            return (
              <section key={`${sec.key}:${keyOf(g)}`} className="border-b border-[var(--color-border)]">
                <div className={`px-4 py-2 flex items-center gap-2 ${color.soft}`}>
                  <button onClick={() => toggle(g)} aria-expanded={isOpen(g)} title={isOpen(g) ? "Close" : "Open"}
                    className="shrink-0 p-1 -m-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-[var(--color-text-muted)]">
                    <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isOpen(g) ? "rotate-90" : ""}`} />
                  </button>
                  <span className={`w-1.5 h-5 rounded-sm shrink-0 ${color.bar}`} />
                  <div className="flex-1 min-w-0">
                    {/* Just the area it's in (Exchangers, Towers) — the full path
                        is on the task itself. */}
                    {g.crumbs.length > 0 && (
                      <div className={`text-[9px] font-bold uppercase tracking-wide truncate ${color.text}`} title={g.crumbs.map((c) => c.name).join(" › ")}>
                        {g.crumbs[g.crumbs.length - 1].name}
                      </div>
                    )}
                    <button onClick={() => onOpenDetail(head)} className="flex items-start gap-1 text-[12px] font-bold text-[var(--color-text)] hover:underline text-left max-w-full">
                      <Layers className="w-3 h-3 shrink-0 opacity-70 mt-0.5" />
                      <span className="break-words min-w-0">{head.name}</span>
                      <ExternalLink className="w-3 h-3 shrink-0 opacity-50 mt-0.5" />
                    </button>
                    {/* Under the name, so the name keeps the width: how the
                        equipment stands overall and how many steps today. */}
                    <div className="text-[10px] font-mono text-[var(--color-text-muted)]" title="This equipment overall">
                      {g.parent && headInfo ? <>
                        {headInfo.percent}%{head.id && planNow.get(head.id) != null ? <> of {planNow.get(head.id)}% planned</> : null} · {headInfo.leafDone}/{headInfo.leafTotal} steps · </> : null}
                      {g.rows.length} today
                    </div>
                  </div>
                </div>
                {isOpen(g) && <ul className="divide-y divide-[var(--color-border)]">
                  {g.rows.map((r) => {
                    const pct = pctOf(r.leaf);
                    const note = spanNote(r);
                    return (
                      <li key={r.leaf.id} className={openId === r.leaf.id ? "bg-[var(--color-accent-soft)]/40" : ""}>
                      <div className={`px-4 py-2 flex items-center gap-3 ${openId === r.leaf.id ? "" : r.live === "overdue" ? "bg-rose-50 dark:bg-rose-950/40" : r.live === "started-early" ? "bg-blue-50/60 dark:bg-blue-950/30" : ""}`}>
                        {/* Day-only or night-only work is marked; round the clock is the norm. */}
                        {(() => { const w = workShiftOf(r.leaf, tz, shiftTimes); return w === "both" ? <span className="w-4 shrink-0" aria-hidden /> : <ShiftMark work={w} />; })()}
                        <span className={`w-[80px] shrink-0 text-[11px] font-mono tabular-nums ${r.live === "overdue" ? "font-black text-rose-700 dark:text-rose-300" : r.live === "started-early" ? "font-bold text-blue-700 dark:text-blue-300" : "text-[var(--color-text-muted)]"}`}>{windowOf(r)}</span>
                        <span className="shrink-0">
                          <StatusControl
                            status={r.leaf.status} size="sm" variant="dot" disabled={!canEdit || !onSetStatus || !r.leaf.id}
                            onPick={(st, reason, p) => { if (r.leaf.id && onSetStatus) onSetStatus(r.leaf.id, st, reason, p); }}
                            percent={pct}
                            onSetProgress={onSetProgress ? (v) => { if (r.leaf.id) onSetProgress(r.leaf.id, v); } : undefined}
                            onStartWithNote={onStartNote && r.leaf.id ? async (v, n) => { const ok = await onStartNote(r.leaf.id!, v, n); setNotesTick((t) => t + 1); return ok; } : undefined}
                          />
                        </span>
                        <button onClick={() => setOpenId(openId === r.leaf.id ? null : r.leaf.id ?? null)} className="flex-1 min-w-0 text-left" aria-expanded={openId === r.leaf.id}
                          title={canEdit ? "Update this step here — % done, status, what's blocking it, a note" : "Show this step"}>
                          <span className={`block text-[12px] leading-snug break-words font-semibold ${r.leaf.status === "completed" ? "line-through text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{r.leaf.name}</span>
                          <span className="block text-[9.5px] text-[var(--color-text-faint)] truncate">
                            {[note, r.leaf.responsibleParty, r.leaf.workOrderRef ? `WO ${r.leaf.workOrderRef}` : null].filter(Boolean).join(" · ")}
                          </span>
                          {r.leaf.id && latestByStep.get(r.leaf.id) && (
                            <span className="block text-[10px] italic text-[var(--color-text-muted)] break-words">&ldquo;{latestByStep.get(r.leaf.id)!.body}&rdquo;</span>
                          )}
                          {r.leaf.status !== "completed" && waitsOn(r.leaf).length > 0 && (
                            <span className="block text-[10px] font-semibold text-amber-700 dark:text-amber-400 break-words">
                              Waits on {waitsOn(r.leaf).map((p) => `${ancestorsOf(p)[0]?.name ? `${ancestorsOf(p)[0].name} · ` : ""}${p.name}${p.responsibleParty ? ` (${p.responsibleParty})` : ""}`).join("; ")}
                            </span>
                          )}
                          {(r.leaf.status === "on_hold" || r.leaf.status === "blocked") && (
                            <span className={`block text-[10px] font-semibold break-words ${r.leaf.status === "blocked" ? "text-rose-700 dark:text-rose-400" : "text-amber-700 dark:text-amber-400"}`}>
                              {r.leaf.status === "blocked" ? "Blocked" : "On hold"}: {r.leaf.statusReason || "no reason recorded"}
                            </span>
                          )}
                        </button>
                        <span className="shrink-0 w-[76px] flex flex-col items-end gap-0.5">
                        <span className="flex items-center justify-end gap-1">
                          <span className="h-1 w-8 rounded-full bg-black/10 overflow-hidden">
                            <span className={`block h-full ${pct >= 100 ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${pct}%` }} />
                          </span>
                          <ProgressControl
                            percent={pct}
                            onPick={(v) => { if (r.leaf.id && onSetProgress) onSetProgress(r.leaf.id, v); }}
                            onSaveWithNote={onSetProgressNote && r.leaf.id ? async (v, n) => { const ok = await onSetProgressNote(r.leaf.id!, v, n); setNotesTick((t) => t + 1); return ok; } : undefined}
                            disabled={!canEdit || !onSetProgress || !r.leaf.id}
                            size="sm"
                          />
                        </span>
                        {pct < 100 && (() => {
                          const g = goalOf(r.leaf);
                          const short = g - pct >= 5;
                          return (
                            <span title={`The plan has this step at ${g}% by ${goalLabel}`}
                              className={`text-right text-[9.5px] font-bold tabular-nums leading-tight ${short ? "text-amber-700 dark:text-amber-400" : "text-[var(--color-text-faint)]"}`}>
                              goal {g}%<span className="block font-semibold opacity-80">by {goalLabel}</span>
                            </span>
                          );
                        })()}
                        </span>
                      </div>
                      {openId === r.leaf.id && r.leaf.id && (
                        <QuickEdit key={r.leaf.id} leaf={r.leaf} pct={pct} canEdit={canEdit}
                          latest={latestByStep.get(r.leaf.id)} userId={userId} onNotesChanged={() => setNotesTick((t) => t + 1)}
                          onSetStatus={onSetStatus} onSetProgress={onSetProgress} onAddNote={onAddNote}
                          onOpenDetail={() => onOpenDetail(r.leaf)}
                          next={nextOf(r.leaf.id)} onNext={(id) => { setOpenId(id); openGroupOf(id); }} onClose={() => setOpenId(null)} />
                      )}
                      </li>
                    );
                  })}
                </ul>}
              </section>
            );
          })}
            </React.Fragment>
          ))}
          {groups.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">No steps are scheduled on {label}.</div>
          )}
          {groups.length > 0 && shownGroups.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">Nothing on {label} matches &ldquo;{query}&rdquo;.</div>
          )}
          {otherDays.length > 0 && (
            <section className="border-t border-[var(--color-border)]">
              <div className="px-4 py-2 text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] bg-[var(--color-surface-2)]">On other days — click to go to its day</div>
              <ul className="divide-y divide-[var(--color-border)]">
                {otherDays.map((m) => {
                  const d = dayKey(startMsOf(m), tz);
                  return (
                    <li key={m.id}>
                      <button onClick={() => { setQuery(""); setOpenId(m.id ?? null); onChangeDay(d); }}
                        className="w-full px-4 py-2 flex items-start gap-3 text-left hover:bg-[var(--color-surface-2)]">
                        <span className="w-[80px] shrink-0 text-[11px] font-mono font-bold text-[var(--color-accent)]">{fmtInTz(startMsOf(m), tz, { weekday: "short", month: "short", day: "numeric" })}</span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[12px] font-semibold break-words">{m.name}</span>
                          <span className="block text-[9.5px] text-[var(--color-text-faint)] truncate">{[ancestorsOf(m)[0]?.name, m.responsibleParty, `${pctOf(m)}%`].filter(Boolean).join(" · ")}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        <div className="px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)]">
          Click a step to update it here · Next moves down the list · an ellipsis means the step continues past this day.
        </div>
      </div>
    </div>
  );
}

// ─── Update one step in place ────────────────────────────────────────

const STATUS_BTNS: Array<{ s: MilestoneStatus; label: string; on: string }> = [
  { s: "in_progress", label: "Working", on: "bg-blue-600 text-white border-blue-600" },
  { s: "completed", label: "Done", on: "bg-emerald-600 text-white border-emerald-600" },
  { s: "on_hold", label: "On hold", on: "bg-amber-500 text-white border-amber-500" },
  { s: "blocked", label: "Blocked", on: "bg-rose-600 text-white border-rose-600" },
];
const PCTS = PICK_PCTS;

/** The contractor's report, line by line: % done, status, what's blocking
 *  it, a note. Each change saves on its own; Next opens the step below. */
type LatestNote = { id: string; body: string; at: string | null; by: string | null; byId: string | null };

function QuickEdit({ leaf, pct, canEdit, onSetStatus, onSetProgress, onAddNote, onOpenDetail, next, onNext, onClose, latest, userId, onNotesChanged }: {
  leaf: Milestone; pct: number; canEdit: boolean;
  /** The step's latest comment — shown here; its author edits it in place. */
  latest?: LatestNote; userId?: string; onNotesChanged?: () => void;
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string, percent?: number) => unknown;
  onSetProgress?: (id: string, percent: number) => unknown;
  onAddNote?: (id: string, body: string) => Promise<void> | void;
  onOpenDetail: () => void;
  next: string | null; onNext: (id: string) => void; onClose: () => void;
}) {
  const id = leaf.id!;
  const [pctDraft, setPctDraft] = useState(String(pct));
  const [hold, setHold] = useState<MilestoneStatus | null>(leaf.status === "on_hold" || leaf.status === "blocked" ? leaf.status : null);
  const [reason, setReason] = useState(leaf.statusReason ?? "");
  // Your own latest comment opens ready to edit (fix it before the report
  // goes out); someone else's shows above the box and yours adds a new one.
  const own = !!latest && !!userId && latest.byId === userId;
  const [noteMode, setNoteMode] = useState<"edit" | "new">(own ? "edit" : "new");
  const [note, setNote] = useState(own ? latest!.body : "");
  const [saved, setSaved] = useState<string | null>(null);
  const pctRef = useRef<HTMLInputElement>(null);
  // Ready to type with a mouse; on a tablet the keyboard would cover the form.
  useEffect(() => { if (window.matchMedia?.("(pointer: fine)").matches) { pctRef.current?.focus(); pctRef.current?.select(); } }, []);
  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(null), 1800); return () => clearTimeout(t); }, [saved]);
  const ro = !canEdit;

  // "Saved" shows only once the save went through — a cancelled "record it
  // early?" or a failed write says so instead.
  const report = (ok: unknown, msg: string) => setSaved(ok === false ? "Not saved" : msg);
  // One save per value: Enter, then the box losing focus to the "record it
  // early?" dialog, mustn't ask (and save) twice.
  const inFlight = useRef<number | null>(null);
  const setPct = async (v: number): Promise<boolean> => {
    if (ro || !onSetProgress) return false;
    const c = Math.max(0, Math.min(100, Math.round(v)));
    if (inFlight.current === c) return false;
    inFlight.current = c;
    setPctDraft(String(c));
    // Finishing the step ends any hold picked here — closing the box mustn't
    // put a done step back on hold.
    if (c >= 100) { setHold(null); setHoldTouched(false); }
    try { const ok = await onSetProgress(id, c); report(ok, `${c}% saved`); return ok !== false; }
    finally { inFlight.current = null; }
  };
  // A % picked here waits for its comment: work in progress always says
  // what got done. Done (100) and 0 save at once. "Working" picked here
  // also waits for the comment.
  const [stage, setStage] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [needMsg, setNeedMsg] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  const pickPct = (v: number) => {
    const c = Math.max(0, Math.min(100, Math.round(v)));
    setPctDraft(String(c)); setNeedMsg(false);
    if (!onAddNote || (!starting && (c === 0 || c >= 100))) { setStage(null); void setPct(c); return; }
    setStage(c === Math.round(pct) && !starting ? null : c);
    setTimeout(() => noteRef.current?.focus(), 0);
  };
  const setStatus = async (st: MilestoneStatus) => {
    if (ro || !onSetStatus) return;
    if (st === "in_progress" && onAddNote) { setStarting(true); setHold(null); setHoldTouched(false); setTimeout(() => noteRef.current?.focus(), 0); return; }
    setStarting(false); setStage(null);
    if (st === "on_hold" || st === "blocked") { setHold(st); setHoldTouched(true); return; } // needs a reason first
    setHold(null); setHoldTouched(false);
    if (st === "completed") setPctDraft("100");
    report(await onSetStatus(id, st), st === "completed" ? "Marked done" : "Marked working");
  };
  // The hold last saved from this box, so closing doesn't save it twice.
  const savedHold = useRef<string | null>(null);
  // Pending only when the person picked or edited the hold in this box —
  // not merely because the live status has since changed.
  const [holdTouched, setHoldTouched] = useState(false);
  const holdPending = () => holdTouched && !!hold && savedHold.current !== `${hold}|${reason.trim()}` && (hold !== leaf.status || reason.trim() !== (leaf.statusReason ?? ""));
  const saveHold = async () => {
    if (ro || !onSetStatus || !hold) return;
    savedHold.current = `${hold}|${reason.trim()}`;
    report(await onSetStatus(id, hold, reason.trim() || undefined), hold === "blocked" ? "Blocked — reason saved" : "On hold — reason saved");
  };
  const sentNote = useRef<string | null>(own ? latest!.body.trim() : null);
  // Edit mode: only a changed comment is written; new mode: added.
  const writeNote = async (text: string) => {
    if (noteMode === "edit" && latest) await updateMilestoneNote(latest.id, text);
    else if (onAddNote) await onAddNote(id, text);
    onNotesChanged?.();
  };
  const notePending = () => !!note.trim() && note.trim() !== sentNote.current;
  // A staged % / start, and whether it still needs its comment.
  const stagedPct = stage ?? (starting ? Math.round(pct) : null);
  const progressPending = () => stage != null || starting;
  const needsNote = () => progressPending() && (stagedPct ?? 0) < 100 && !notePending();
  // Save the staged % (or start) and the comment together.
  const commit = async (): Promise<boolean> => {
    if (ro) return false;
    if (!progressPending()) { await saveNote(); return true; }
    if (needsNote()) { setNeedMsg(true); noteRef.current?.focus(); return false; }
    let ok = true;
    if (starting && onSetStatus) {
      const v = stagedPct ?? 0;
      ok = (await onSetStatus(id, v >= 100 ? "completed" : "in_progress", undefined, v)) !== false;
      report(ok, v >= 100 ? "Marked done" : `Working — ${v}% saved`);
    } else if (stage != null) ok = await setPct(stage);
    if (!ok) return false;
    setStage(null); setStarting(false); setNeedMsg(false);
    if (notePending()) await saveNote();
    return true;
  };
  const saveNote = async () => {
    if (ro || !notePending()) return;
    const text = note.trim();
    sentNote.current = text;
    try {
      await writeNote(text);
      if (noteMode === "new") setNote("");
      setSaved(noteMode === "edit" ? "Comment updated" : "Note added");
    } catch { setSaved("Note not saved"); sentNote.current = null; }
  };
  const goNext = async () => {
    if (progressPending()) { if (!(await commit())) return; }
    else if (notePending()) await saveNote();
    // On hold / blocked picked but not saved yet: Next saves it.
    if (holdPending()) await saveHold();
    if (next) onNext(next); else onClose();
  };
  // Closing the row — Esc, the X, another row — keeps what was typed or
  // picked: a note in the box and a hold that looks selected are saved,
  // not dropped.
  const flush = useRef<() => void>(() => undefined);
  useEffect(() => {
    flush.current = () => {
      if (ro) return;
      // A staged % with its comment is saved; one without a comment isn't
      // (work in progress always says what got done).
      if (progressPending() && !needsNote()) void commit();
      else if (notePending()) void writeNote(note.trim()).catch(() => undefined);
      if (holdPending() && hold && onSetStatus) onSetStatus(id, hold, reason.trim() || undefined);
    };
  });
  useEffect(() => () => flush.current(), []);
  const active = hold ?? leaf.status;

  return (
    <div className="px-4 pb-3 pt-1 space-y-2 text-[11px]" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="w-16 shrink-0 font-black uppercase tracking-wider text-[9.5px] text-[var(--color-text-muted)]">% done</span>
        {PCTS.map((v) => (
          <button key={v} disabled={ro} onClick={() => pickPct(v)}
            className={`h-7 min-w-[38px] px-1.5 rounded-md border font-bold tabular-nums pointer-coarse:h-9 ${(stagedPct ?? Math.round(pct)) === v ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"} disabled:opacity-40`}>
            {v === 100 ? "100" : v}
          </button>
        ))}
        <span className="inline-flex items-center gap-1 ml-1">
          <input ref={pctRef} value={pctDraft} disabled={ro} inputMode="numeric"
            onChange={(e) => setPctDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (pctDraft !== "") pickPct(Number(pctDraft)); } }}
            onBlur={() => { if (pctDraft !== "" && Number(pctDraft) !== (stagedPct ?? Math.round(pct))) pickPct(Number(pctDraft)); }}
            aria-label="Percent done"
            className="h-7 w-12 px-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-right font-bold tabular-nums focus:outline-none focus:border-[var(--color-accent-ring)]" />
          <span className="font-bold text-[var(--color-text-muted)]">%</span>
        </span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="w-16 shrink-0 font-black uppercase tracking-wider text-[9.5px] text-[var(--color-text-muted)]">Status</span>
        {STATUS_BTNS.map((b) => (
          <button key={b.s} disabled={ro} onClick={() => void setStatus(b.s)}
            className={`h-7 px-2.5 rounded-md border font-bold pointer-coarse:h-9 ${(starting ? "in_progress" : active) === b.s ? b.on : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"} disabled:opacity-40`}>
            {b.label}
          </button>
        ))}
      </div>
      {hold && (
        <div className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 font-black uppercase tracking-wider text-[9.5px] text-[var(--color-text-muted)]">Blocking it</span>
          <input value={reason} disabled={ro} autoFocus onChange={(e) => { setReason(e.target.value); setHoldTouched(true); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveHold(); } }}
            placeholder="What's stopping it — permit, scaffold, ops release, parts…"
            className="flex-1 h-7 px-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] focus:outline-none focus:border-[var(--color-accent-ring)]" />
          <button disabled={ro} onClick={() => void saveHold()} className={`h-7 px-2.5 rounded-md font-bold text-white ${hold === "blocked" ? "bg-rose-600 hover:bg-rose-700" : "bg-amber-500 hover:bg-amber-600"} disabled:opacity-40`}>
            Save {hold === "blocked" ? "blocked" : "on hold"}
          </button>
        </div>
      )}
      {onAddNote && latest && noteMode === "new" && (
        <div className="flex items-start gap-1.5">
          <span className="w-16 shrink-0 font-black uppercase tracking-wider text-[9.5px] text-[var(--color-text-muted)]">Latest</span>
          <span className="flex-1 italic text-[var(--color-text-muted)]">&ldquo;{latest.body}&rdquo; — {latest.by ?? "someone"}{latest.at ? `, ${new Date(latest.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</span>
        </div>
      )}
      {onAddNote && (
        <div className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 font-black uppercase tracking-wider text-[9.5px] text-[var(--color-text-muted)]">{noteMode === "edit" ? "Comment" : "Note"}</span>
          <input ref={noteRef} value={note} disabled={ro} onChange={(e) => { setNote(e.target.value); setNeedMsg(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } }}
            placeholder={progressPending() ? "What got done? (needed to save the %)" : "Comment — shows on the shift report (e.g. sent out for calibration)"}
            className={`flex-1 h-7 px-2 rounded-md border bg-[var(--color-surface)] pointer-coarse:h-9 focus:outline-none focus:border-[var(--color-accent-ring)] ${needMsg ? "border-rose-400" : "border-[var(--color-border-strong)]"}`} />
          {progressPending() && (
            <button disabled={ro} onClick={() => void commit()}
              className="shrink-0 h-7 px-2.5 rounded-md font-black bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 pointer-coarse:h-9">
              Save {stagedPct ?? 0}%
            </button>
          )}
          {own && (
            <button disabled={ro} onClick={() => { if (noteMode === "edit") { setNoteMode("new"); setNote(""); sentNote.current = null; } else { setNoteMode("edit"); setNote(latest!.body); sentNote.current = latest!.body.trim(); } }}
              className="shrink-0 text-[10.5px] font-bold text-[var(--color-accent)] hover:underline">
              {noteMode === "edit" ? "New comment instead" : "Edit my last one"}
            </button>
          )}
        </div>
      )}
      {needMsg && <div className="pl-[70px] font-semibold text-rose-700 dark:text-rose-400">Say what got done to save {stagedPct ?? 0}% — it goes on the shift report.</div>}
      <div className="flex items-center gap-2">
        {saved && <span className="inline-flex items-center gap-1 font-bold text-emerald-700 dark:text-emerald-400"><Check className="w-3.5 h-3.5" /> {saved}</span>}
        <button onClick={onOpenDetail} className="ml-auto inline-flex items-center gap-1 font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          <ExternalLink className="w-3 h-3" /> Full details
        </button>
        <button onClick={() => void goNext()}
          className="inline-flex items-center gap-1 h-7 px-3 rounded-md bg-slate-900 text-white font-bold hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white">
          {next ? <><ArrowDown className="w-3.5 h-3.5" /> Next step</> : <>Close</>}
        </button>
      </div>
    </div>
  );
}
