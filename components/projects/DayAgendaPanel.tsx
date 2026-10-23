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
import { ChevronLeft, ChevronRight, X as XIcon, CalendarDays, Layers, ExternalLink, Search, ArrowDown, Check } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import StatusControl from "@/components/projects/StatusControl";
import ProgressControl from "@/components/projects/ProgressControl";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { clockLabel, dayKey, dayKeyToMs, fmtInTz, addDays, tzAbbrev } from "@/lib/scheduleTz";
import { startMsOf, finishMsOf, wbsCompare } from "@/lib/calendarPlacement";
import { overdueOpenWork, startedEarlyWork } from "@/lib/openWork";
import { completionNote } from "@/lib/scheduleRules";
import { DEFAULT_SHIFT_TIMES, workShiftOf, type ShiftTimes } from "@/lib/shiftReport";
import ShiftMark from "@/components/projects/ShiftMark";

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
  /** Add a note to the step's log. */
  onAddNote?: (id: string, body: string) => Promise<void> | void;
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
  onSetStatus, onSetProgress, onAddNote, onOpenDetail, onChangeDay, onClose, colorOf, shiftTimes = DEFAULT_SHIFT_TIMES,
}: Props) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
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
  const order = useMemo(() => shownGroups.flatMap((g) => g.rows.map((r) => r.leaf.id).filter((x): x is string => !!x)), [shownGroups]);
  const nextOf = (id: string) => { const i = order.indexOf(id); return i >= 0 && i + 1 < order.length ? order[i + 1] : null; };

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
          {totals.n > 0 && (
            <div className="mt-2 relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
                placeholder="Find equipment, WO # or step — e.g. E-606, 4410037"
                className="w-full h-8 pl-8 pr-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent-ring)]" />
              {query && <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]" title="Clear"><XIcon className="w-3.5 h-3.5" /></button>}
            </div>
          )}
        </div>

        {/* Body: equipment groups, each with the steps due today. */}
        <div className="flex-1 overflow-y-auto">
          {shownGroups.map((g) => {
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
                      <li key={r.leaf.id} className={openId === r.leaf.id ? "bg-[var(--color-accent-soft)]/40" : ""}>
                      <div className={`px-4 py-2 flex items-center gap-3 ${openId === r.leaf.id ? "" : r.live === "overdue" ? "bg-rose-50" : r.live === "started-early" ? "bg-blue-50/60" : ""}`}>
                        <ShiftMark work={workShiftOf(r.leaf, tz, shiftTimes)} />
                        <span className={`w-[80px] shrink-0 text-[11px] font-mono tabular-nums ${r.live === "overdue" ? "font-black text-rose-700" : r.live === "started-early" ? "font-bold text-blue-700" : "text-[var(--color-text-muted)]"}`}>{windowOf(r)}</span>
                        <span className="shrink-0">
                          <StatusControl
                            status={r.leaf.status} size="sm" variant="dot" disabled={!canEdit || !onSetStatus || !r.leaf.id}
                            onPick={(st, reason) => { if (r.leaf.id && onSetStatus) onSetStatus(r.leaf.id, st, reason); }}
                            percent={pct}
                            onSetProgress={onSetProgress ? (v) => { if (r.leaf.id) onSetProgress(r.leaf.id, v); } : undefined}
                          />
                        </span>
                        <button onClick={() => setOpenId(openId === r.leaf.id ? null : r.leaf.id ?? null)} className="flex-1 min-w-0 text-left" aria-expanded={openId === r.leaf.id}
                          title={canEdit ? "Update this step here — % done, status, what's blocking it, a note" : "Show this step"}>
                          <span className={`block text-[12px] truncate font-semibold ${r.leaf.status === "completed" ? "line-through text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{r.leaf.name}</span>
                          <span className="block text-[9.5px] text-[var(--color-text-faint)] truncate">
                            {[note, r.leaf.responsibleParty, r.leaf.workOrderRef ? `WO ${r.leaf.workOrderRef}` : null].filter(Boolean).join(" · ")}
                          </span>
                          {(r.leaf.status === "on_hold" || r.leaf.status === "blocked") && (
                            <span className={`block text-[10px] font-semibold truncate ${r.leaf.status === "blocked" ? "text-rose-700 dark:text-rose-400" : "text-amber-700 dark:text-amber-400"}`}>
                              {r.leaf.status === "blocked" ? "Blocked" : "On hold"}: {r.leaf.statusReason || "no reason recorded"}
                            </span>
                          )}
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
                      </div>
                      {openId === r.leaf.id && r.leaf.id && (
                        <QuickEdit key={r.leaf.id} leaf={r.leaf} pct={pct} canEdit={canEdit}
                          onSetStatus={onSetStatus} onSetProgress={onSetProgress} onAddNote={onAddNote}
                          onOpenDetail={() => onOpenDetail(r.leaf)}
                          next={nextOf(r.leaf.id)} onNext={(id) => { setOpenId(id); }} onClose={() => setOpenId(null)} />
                      )}
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
          {groups.length > 0 && shownGroups.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">Nothing on {label} matches &ldquo;{query}&rdquo;.</div>
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
const PCTS = [0, 25, 50, 75, 90, 100];

/** The contractor's report, line by line: % done, status, what's blocking
 *  it, a note. Each change saves on its own; Next opens the step below. */
function QuickEdit({ leaf, pct, canEdit, onSetStatus, onSetProgress, onAddNote, onOpenDetail, next, onNext, onClose }: {
  leaf: Milestone; pct: number; canEdit: boolean;
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string) => void;
  onSetProgress?: (id: string, percent: number) => void;
  onAddNote?: (id: string, body: string) => Promise<void> | void;
  onOpenDetail: () => void;
  next: string | null; onNext: (id: string) => void; onClose: () => void;
}) {
  const id = leaf.id!;
  const [pctDraft, setPctDraft] = useState(String(pct));
  const [hold, setHold] = useState<MilestoneStatus | null>(leaf.status === "on_hold" || leaf.status === "blocked" ? leaf.status : null);
  const [reason, setReason] = useState(leaf.statusReason ?? "");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const pctRef = useRef<HTMLInputElement>(null);
  useEffect(() => { pctRef.current?.focus(); pctRef.current?.select(); }, []);
  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(null), 1800); return () => clearTimeout(t); }, [saved]);
  const ro = !canEdit;

  const setPct = (v: number) => {
    if (ro || !onSetProgress) return;
    const c = Math.max(0, Math.min(100, Math.round(v)));
    setPctDraft(String(c));
    onSetProgress(id, c);
    setSaved(`${c}% saved`);
  };
  const setStatus = (st: MilestoneStatus) => {
    if (ro || !onSetStatus) return;
    if (st === "on_hold" || st === "blocked") { setHold(st); return; } // needs a reason first
    setHold(null);
    onSetStatus(id, st);
    if (st === "completed") setPctDraft("100");
    setSaved(st === "completed" ? "Marked done" : "Marked working");
  };
  const saveHold = () => {
    if (ro || !onSetStatus || !hold) return;
    onSetStatus(id, hold, reason.trim() || undefined);
    setSaved(hold === "blocked" ? "Blocked — reason saved" : "On hold — reason saved");
  };
  const saveNote = async () => {
    if (ro || !onAddNote || !note.trim()) return;
    await onAddNote(id, note.trim());
    setNote("");
    setSaved("Note added");
  };
  const goNext = async () => {
    if (note.trim()) await saveNote();
    // On hold / blocked picked but not saved yet: Next saves it.
    if (hold && (hold !== leaf.status || reason.trim() !== (leaf.statusReason ?? ""))) saveHold();
    if (next) onNext(next); else onClose();
  };
  const active = hold ?? leaf.status;

  return (
    <div className="px-4 pb-3 pt-1 space-y-2 text-[11px]" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="w-16 shrink-0 font-black uppercase tracking-wider text-[9.5px] text-[var(--color-text-muted)]">% done</span>
        {PCTS.map((v) => (
          <button key={v} disabled={ro} onClick={() => setPct(v)}
            className={`h-7 min-w-[38px] px-1.5 rounded-md border font-bold tabular-nums ${Math.round(pct) === v ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"} disabled:opacity-40`}>
            {v === 100 ? "100" : v}
          </button>
        ))}
        <span className="inline-flex items-center gap-1 ml-1">
          <input ref={pctRef} value={pctDraft} disabled={ro} inputMode="numeric"
            onChange={(e) => setPctDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (pctDraft !== "") setPct(Number(pctDraft)); } }}
            onBlur={() => { if (pctDraft !== "" && Number(pctDraft) !== Math.round(pct)) setPct(Number(pctDraft)); }}
            aria-label="Percent done"
            className="h-7 w-12 px-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-right font-bold tabular-nums focus:outline-none focus:border-[var(--color-accent-ring)]" />
          <span className="font-bold text-[var(--color-text-muted)]">%</span>
        </span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="w-16 shrink-0 font-black uppercase tracking-wider text-[9.5px] text-[var(--color-text-muted)]">Status</span>
        {STATUS_BTNS.map((b) => (
          <button key={b.s} disabled={ro} onClick={() => setStatus(b.s)}
            className={`h-7 px-2.5 rounded-md border font-bold ${active === b.s ? b.on : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"} disabled:opacity-40`}>
            {b.label}
          </button>
        ))}
      </div>
      {hold && (
        <div className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 font-black uppercase tracking-wider text-[9.5px] text-[var(--color-text-muted)]">Blocking it</span>
          <input value={reason} disabled={ro} autoFocus onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveHold(); } }}
            placeholder="What's stopping it — permit, scaffold, ops release, parts…"
            className="flex-1 h-7 px-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] focus:outline-none focus:border-[var(--color-accent-ring)]" />
          <button disabled={ro} onClick={saveHold} className={`h-7 px-2.5 rounded-md font-bold text-white ${hold === "blocked" ? "bg-rose-600 hover:bg-rose-700" : "bg-amber-500 hover:bg-amber-600"} disabled:opacity-40`}>
            Save {hold === "blocked" ? "blocked" : "on hold"}
          </button>
        </div>
      )}
      {onAddNote && (
        <div className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 font-black uppercase tracking-wider text-[9.5px] text-[var(--color-text-muted)]">Note</span>
          <input value={note} disabled={ro} onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveNote(); } }}
            placeholder="Comment — shows on the shift report (e.g. sent out for calibration)"
            className="flex-1 h-7 px-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] focus:outline-none focus:border-[var(--color-accent-ring)]" />
        </div>
      )}
      <div className="flex items-center gap-2">
        {saved && <span className="inline-flex items-center gap-1 font-bold text-emerald-700 dark:text-emerald-400"><Check className="w-3.5 h-3.5" /> {saved}</span>}
        <button onClick={onOpenDetail} className="ml-auto inline-flex items-center gap-1 font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          <ExternalLink className="w-3 h-3" /> Full details
        </button>
        <button onClick={() => void goNext()}
          className="inline-flex items-center gap-1 h-7 px-3 rounded-md bg-slate-900 text-white font-bold hover:bg-slate-800">
          {next ? <><ArrowDown className="w-3.5 h-3.5" /> Next step</> : <><Check className="w-3.5 h-3.5" /> Done</>}
        </button>
      </div>
    </div>
  );
}
