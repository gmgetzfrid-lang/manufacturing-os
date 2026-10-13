"use client";

// ShiftReportView — the shift-change briefing, on screen and on paper.
//
// The supervisor's loop: 05:30 meeting with the day crew, 17:30 update
// progress and walk into the night meeting with overall status, what
// got done, what carried over, and the goals for the night. This view
// is that page, itemized by equipment so it reads like the crew works:
//   • what the shift under review did — Completed / Still in progress /
//     Not started, each step on its own line;
//   • carry-over — due by now and not done;
//   • goals for the next shift — carry-over first, then its planned
//     work, critical-path items flagged, with a checkbox per line.
// Opens on the shift ending now; before the job starts, on the first
// shift with work, so it is never an empty page. A future shift is
// measured "as of its end", so the report can be rehearsed before the
// outage. Progress entered in the Day view shows here immediately.

import React, { useEffect, useMemo, useState } from "react";
import { Printer, ChevronLeft, ChevronRight, Sun, Moon, AlertTriangle, CheckCircle2, Flag, Clock, FastForward } from "lucide-react";
import type { Milestone } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import {
  buildShiftReport, shiftWindow, nextShift, previousShift, shiftLabel, defaultReviewShift, nextShiftWithWork,
  DEFAULT_SHIFT_TIMES, type ShiftTimes, type ShiftRow, type ShiftWindow,
} from "@/lib/shiftReport";
import { clockLabel, fmtInTz, tzLabel } from "@/lib/scheduleTz";

interface Props {
  milestones: Milestone[];
  progress?: Map<string, ProgressInfo>;
  criticalIds: Set<string>;
  projectId: string;
  projectName?: string;
}

function loadTimes(projectId: string): ShiftTimes {
  try {
    const raw = localStorage.getItem(`shiftTimes:${projectId}`);
    if (raw) { const p = JSON.parse(raw) as Partial<ShiftTimes>; return { ...DEFAULT_SHIFT_TIMES, ...p }; }
  } catch { /* private mode etc. */ }
  return DEFAULT_SHIFT_TIMES;
}

/** Rows grouped under their equipment (immediate parent), in row order. */
function byEquipment(rows: ShiftRow[]): Array<{ key: string; title: string; crumbs: string; rows: ShiftRow[] }> {
  const out = new Map<string, { key: string; title: string; crumbs: string; rows: ShiftRow[] }>();
  for (const r of rows) {
    const title = r.parentName ?? r.leaf.name;
    const key = r.parentName ? r.path.join("›") : `leaf:${r.leaf.id}`;
    let g = out.get(key);
    if (!g) { g = { key, title, crumbs: r.path.slice(0, -1).join(" › "), rows: [] }; out.set(key, g); }
    g.rows.push(r);
  }
  return Array.from(out.values());
}

export default function ShiftReportView({ milestones, progress, criticalIds, projectId, projectName }: Props) {
  const tz = useScheduleTz();
  const [times, setTimes] = useState<ShiftTimes>(DEFAULT_SHIFT_TIMES);
  useEffect(() => { setTimes(loadTimes(projectId)); }, [projectId]);
  const saveTimes = (t: ShiftTimes) => {
    setTimes(t);
    try { localStorage.setItem(`shiftTimes:${projectId}`, JSON.stringify(t)); } catch { /* ignore */ }
  };

  const [now] = useState(() => Date.now());
  const [sel, setSel] = useState<{ dayKey: string; kind: "day" | "night" } | null>(null);
  const shift: ShiftWindow = useMemo(
    () => (sel ? shiftWindow(sel.dayKey, sel.kind, tz, times) : defaultReviewShift(milestones, now, tz, times)),
    [sel, now, tz, times, milestones],
  );
  const pick = (w: ShiftWindow) => setSel({ dayKey: w.dayKey, kind: w.kind });

  // "As of": now while the shift is under way; the shift's end once it is
  // over, and ALSO for a shift in the future so the page can be rehearsed
  // before the outage with the plan measured at that shift's end.
  const asOf = now >= shift.start && now < shift.end ? now : shift.end;
  const report = useMemo(
    () => buildShiftReport({ milestones, progress, criticalIds, tz, times, shift, now: asOf }),
    [milestones, progress, criticalIds, tz, times, shift, asOf],
  );
  const { overall, review, goals, blocked, next } = report;
  const rehearsal = now < shift.start;
  const jumpTarget = useMemo(() => (review.scheduled.length === 0 ? nextShiftWithWork(milestones, shift, tz, times) : null), [review.scheduled.length, milestones, shift, tz, times]);

  const rowTime = (r: ShiftRow, win: ShiftWindow) => {
    const s = r.start >= win.start && r.start < win.end ? (clockLabel(r.start, tz) || "0:00") : "…";
    const f = r.finish > win.start && r.finish <= win.end ? (clockLabel(r.finish, tz) || "24:00") : "…";
    if (s === "…" && f === "…") return "all shift";
    return `${s}–${f}`;
  };
  const due = (r: ShiftRow) => `${fmtInTz(r.finish, tz, { month: "short", day: "numeric" })} ${clockLabel(r.finish, tz) || ""}`.trim();
  // A step listed on this shift although its plan slot is elsewhere.
  const slot = (r: ShiftRow) => (r.offSchedule ? `planned ${fmtInTz(r.start, tz, { month: "short", day: "numeric" })} ${clockLabel(r.start, tz) || ""}`.trim() : undefined);

  const standingTone = overall.standing === "ahead" ? "text-emerald-700 bg-emerald-50 border-emerald-200"
    : overall.standing === "behind" ? "text-rose-700 bg-rose-50 border-rose-200"
    : "text-[var(--color-text)] bg-[var(--color-surface-2)] border-[var(--color-border)]";

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden">
      <style>{`@media print {
        body * { visibility: hidden !important; }
        .shift-report-print, .shift-report-print * { visibility: visible !important; }
        .shift-report-print { position: absolute !important; left: 0; top: 0; width: 100% !important; padding: 0 !important; }
        .shift-report-print .no-print { display: none !important; }
        .shift-report-print section, .shift-report-print .equip { break-inside: avoid; }
      }`}</style>

      {/* Toolbar */}
      <div className="no-print px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap bg-gradient-to-b from-white to-slate-50/40">
        <button onClick={() => pick(previousShift(shift, tz, times))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Previous shift"><ChevronLeft className="w-4 h-4" /></button>
        <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-md p-0.5 gap-0.5">
          {(["day", "night"] as const).map((k) => (
            <button key={k} onClick={() => setSel({ dayKey: shift.dayKey, kind: k })} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${shift.kind === k ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              {k === "day" ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />} {k === "day" ? "Day" : "Night"}
            </button>
          ))}
        </div>
        <input
          type="date" value={shift.dayKey}
          onChange={(e) => { if (e.target.value) setSel({ dayKey: e.target.value, kind: shift.kind }); }}
          className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-2 bg-[var(--color-surface)]"
          title="Which day's shift to review"
        />
        <button onClick={() => pick(nextShift(shift, tz, times))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Next shift"><ChevronRight className="w-4 h-4" /></button>
        <button onClick={() => setSel(null)} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] border border-[var(--color-border)]">Current shift</button>
        <span className="mx-1 w-px h-4 bg-[var(--color-border)]" />
        <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><Sun className="w-3 h-3" /> starts
          <input type="time" value={times.dayStart} onChange={(e) => saveTimes({ ...times, dayStart: e.target.value || DEFAULT_SHIFT_TIMES.dayStart })} className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
        </label>
        <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><Moon className="w-3 h-3" /> starts
          <input type="time" value={times.nightStart} onChange={(e) => saveTimes({ ...times, nightStart: e.target.value || DEFAULT_SHIFT_TIMES.nightStart })} className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
        </label>
        <button onClick={() => window.print()} className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-3 py-1.5 rounded-lg shadow-sm">
          <Printer className="w-3.5 h-3.5" /> Print for the meeting
        </button>
      </div>

      {/* The report */}
      <div className="shift-report-print p-5 space-y-5 text-[12px] text-[var(--color-text)]">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Shift change report</div>
            <h2 className="text-lg font-black leading-tight">{projectName ?? "Schedule"}</h2>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              <b className="text-[var(--color-text)]">{shiftLabel(shift, tz)}</b> → next: <b className="text-[var(--color-text)]">{shiftLabel(next, tz)}</b>
            </div>
            <div className="text-[10px] text-[var(--color-text-faint)]">
              Plant time {tzLabel(tz)} · as of {fmtInTz(asOf, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {rehearsal && <span className="ml-2 no-print font-bold text-amber-700">Rehearsal — this shift hasn&apos;t started; measured as of its end.</span>}
            </div>
          </div>
          <div className={`rounded-xl border px-4 py-2 text-right ${standingTone}`}>
            <div className="text-[10px] font-black uppercase tracking-widest">Overall</div>
            <div className="text-2xl font-black leading-none">{overall.standing.toUpperCase()}</div>
            <div className="text-[11px] font-bold">{overall.variancePct > 0 ? "+" : ""}{overall.variancePct} pts vs plan</div>
          </div>
        </header>

        <section className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Actual complete" value={`${overall.actualPct}%`} />
          <Stat label="Plan said by now" value={`${overall.plannedPct}%`} />
          <Stat label="Steps done" value={`${overall.stepsDone} / ${overall.stepsTotal}`} />
          <Stat label="Schedule day" value={overall.daysTotal ? `${overall.daysElapsed} / ${overall.daysTotal}` : "—"} sub={overall.plannedFinish ? `finish ${fmtInTz(overall.plannedFinish, tz, { month: "short", day: "numeric" })} ${clockLabel(overall.plannedFinish, tz)}` : undefined} />
        </section>

        {/* ── This shift ───────────────────────────────────────── */}
        <section>
          <SectionTitle icon={<Clock className="w-3.5 h-3.5" />} title={`This shift — ${shiftLabel(shift, tz)}`} sub={`${review.scheduled.length} step${review.scheduled.length === 1 ? "" : "s"} scheduled`} />
          {review.scheduled.length === 0 ? (
            <div className="py-3 flex items-center gap-3 flex-wrap text-[11px] text-[var(--color-text-muted)]">
              <span>Nothing is scheduled on this shift.</span>
              {jumpTarget && (
                <button onClick={() => pick(jumpTarget)} className="no-print inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-accent)] hover:underline">
                  <FastForward className="w-3.5 h-3.5" /> Jump to the next shift with work: {shiftLabel(jumpTarget, tz)}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <ItemList title="Completed this shift" tone="emerald" rows={review.done} empty="Nothing completed." render={(r) => (
                <Line r={r} left={<CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />} time={r.offSchedule ? "early/late" : rowTime(r, shift)} right="Done" note={slot(r)} />
              )} />
              <ItemList title="In progress — all open work" tone="blue" rows={review.inProgress} empty="Nothing part-way." render={(r) => (
                <Line r={r} left={<Box />} time={r.offSchedule ? "open" : rowTime(r, shift)} right={`${r.percent}%`} note={slot(r) ?? (r.carryOver ? "carry-over" : undefined)} />
              )} />
              <ItemList title="Not started" tone="slate" rows={review.notStarted} empty="Everything scheduled was at least started." render={(r) => (
                <Line r={r} left={<Box />} time={rowTime(r, shift)} right={r.status === "blocked" ? "Blocked" : r.status === "on_hold" ? "On hold" : "0%"} note={r.carryOver ? "carry-over" : undefined} />
              )} />
            </div>
          )}
        </section>

        {/* ── Carry-over ───────────────────────────────────────── */}
        <section>
          <SectionTitle icon={<AlertTriangle className="w-3.5 h-3.5 text-rose-600" />} title="Carry-over — due by the end of this shift, not done" sub={review.carryOver.length === 0 ? "Nothing carried over." : `${review.carryOver.length} step${review.carryOver.length === 1 ? "" : "s"} roll into the next shift`} />
          {review.carryOver.length > 0 && (
            <ItemList title="" tone="rose" rows={review.carryOver} empty="" render={(r) => (
              <Line r={r} left={r.critical ? <Flag className="w-3.5 h-3.5 text-rose-600" /> : <Box />} time={`due ${due(r)}`} right={`${r.percent}%`} note={r.critical ? "critical path" : undefined} />
            )} />
          )}
        </section>

        {/* ── Next shift goals ─────────────────────────────────── */}
        <section>
          <SectionTitle icon={<Flag className="w-3.5 h-3.5" />} title={`Goals — ${shiftLabel(next, tz)}`} sub={`${goals.all.length} step${goals.all.length === 1 ? "" : "s"} · ${goals.carryOver.length} carried over · ${goals.critical.length} on the critical path`} />
          {goals.all.length === 0 ? <Empty>Nothing is scheduled for the next shift.</Empty> : (
            <div className="space-y-3">
              {goals.carryOver.length > 0 && (
                <ItemList title="Clear these first — carried over" tone="amber" rows={goals.carryOver} empty="" render={(r) => (
                  <Line r={r} left={r.critical ? <Flag className="w-3.5 h-3.5 text-rose-600" /> : <Box />} time={`due ${due(r)}`} right={`${r.percent}%`} note={r.critical ? "critical path" : undefined} crew />
                )} />
              )}
              <ItemList title="Planned this shift" tone="slate" rows={goals.planned} empty="No new work starts on this shift." render={(r) => (
                <Line r={r} left={r.critical ? <Flag className="w-3.5 h-3.5 text-rose-600" /> : <Box />} time={rowTime(r, next)} right={r.percent > 0 ? `${r.percent}%` : ""} note={r.critical ? "critical path" : undefined} crew />
              )} />
            </div>
          )}
          <div className="mt-1 text-[10px] text-[var(--color-text-faint)]">Flag = on the chain that drives the finish date. Clear carry-overs and flagged items first to get back on track.</div>
        </section>

        {blocked.length > 0 && (
          <section>
            <SectionTitle icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-600" />} title="Blocked / on hold" sub={`${blocked.length} step${blocked.length === 1 ? "" : "s"} need a decision`} />
            <ul className="divide-y divide-[var(--color-border)]">
              {blocked.map((r) => (
                <li key={r.leaf.id} className="py-1.5 text-[11px]">
                  <span className="font-semibold">{r.leaf.name}</span> <span className="text-[var(--color-text-muted)]">{r.path.join(" › ")}</span>
                  <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-amber-700">{r.status === "blocked" ? "Blocked" : "On hold"}</span>
                  {r.reason && <div className="text-[var(--color-text-muted)]">Reason: {r.reason}</div>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="pt-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)] flex justify-between gap-4">
          <span>Plan % = work the schedule expected complete as of {fmtInTz(asOf, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}, hour-weighted. Actual % = entered progress, hour-weighted.</span>
          <span className="shrink-0">Printed {fmtInTz(now, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        </footer>
      </div>
    </div>
  );
}

/** A titled, equipment-grouped list of steps. */
function ItemList({ title, tone, rows, empty, render }: {
  title: string; tone: "emerald" | "blue" | "slate" | "rose" | "amber"; rows: ShiftRow[]; empty: string; render: (r: ShiftRow) => React.ReactNode;
}) {
  const toneCls = tone === "emerald" ? "text-emerald-700" : tone === "blue" ? "text-blue-700" : tone === "rose" ? "text-rose-700" : tone === "amber" ? "text-amber-700" : "text-[var(--color-text-muted)]";
  return (
    <div>
      {title && <div className={`text-[10px] font-black uppercase tracking-widest ${toneCls}`}>{title} <span className="font-mono">({rows.length})</span></div>}
      {rows.length === 0 ? (empty ? <div className="text-[11px] text-[var(--color-text-faint)] py-0.5">{empty}</div> : null) : (
        <div className="mt-1 space-y-1.5">
          {byEquipment(rows).map((g) => (
            <div key={g.key} className="equip rounded-lg border border-[var(--color-border)]">
              <div className="px-2 py-1 bg-[var(--color-surface-2)] rounded-t-lg">
                {g.crumbs && <div className="text-[9px] uppercase tracking-wide text-[var(--color-text-faint)] truncate">{g.crumbs}</div>}
                <div className="text-[11px] font-bold truncate">{g.title}</div>
              </div>
              <ul className="divide-y divide-[var(--color-border)]">
                {g.rows.map((r) => <li key={r.leaf.id}>{render(r)}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One step on one line: marker · time · name · (crew/WO) · note · right. */
function Line({ r, left, time, right, note, crew }: { r: ShiftRow; left: React.ReactNode; time: string; right: string; note?: string; crew?: boolean }) {
  const who = crew ? [r.leaf.responsibleParty, r.leaf.workOrderRef ? `WO ${r.leaf.workOrderRef}` : null].filter(Boolean).join(" · ") : "";
  return (
    <div className="px-2 py-1 flex items-center gap-2 text-[11px]">
      <span className="shrink-0 w-4 flex justify-center">{left}</span>
      <span className="shrink-0 w-[84px] font-mono text-[var(--color-text-muted)] tabular-nums">{time}</span>
      <span className={`flex-1 min-w-0 truncate ${r.status === "completed" || r.percent >= 100 ? "line-through text-[var(--color-text-faint)]" : "font-semibold"}`}>{r.leaf.name}</span>
      {who && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)] truncate max-w-[160px]">{who}</span>}
      {note && <span className={`shrink-0 text-[9px] font-bold uppercase tracking-wider ${note.startsWith("planned") ? "text-[var(--color-text-faint)]" : "text-rose-700"}`}>{note}</span>}
      <span className="shrink-0 w-14 text-right font-mono text-[var(--color-text-muted)]">{right}</span>
    </div>
  );
}

/** A print-friendly checkbox square. */
function Box() {
  return <span className="inline-block w-3 h-3 rounded-[3px] border border-[var(--color-border-strong)]" aria-hidden />;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] px-3 py-2">
      <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">{label}</div>
      <div className="text-lg font-black leading-tight">{value}</div>
      {sub && <div className="text-[10px] text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

function SectionTitle({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-1.5 border-b border-[var(--color-border)] pb-1 flex-wrap">
      <span className="inline-flex items-center gap-1.5 text-[12px] font-black uppercase tracking-wide">{icon} {title}</span>
      {sub && <span className="text-[10px] text-[var(--color-text-muted)]">{sub}</span>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-[11px] text-[var(--color-text-faint)]">{children}</div>;
}
