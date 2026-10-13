"use client";

// ShiftReportView — the shift-change MEETING, as a page you run top to
// bottom and hand out. Sections are numbered in the order a supervisor
// runs the hand-over:
//   1  Where we stand        — ahead/behind, actual vs plan, day X of N
//   2  Last shift: results   — completed, then did-not-finish (carry-over)
//   3  Needs a decision      — blocked / on hold, with the reason
//   4  Next shift: the plan  — numbered priorities, then scheduled work
//   5  Close                 — notes and sign-off
// Design rules: every block says its full date; everything that needs
// attention is red (critical path, blocked) or amber (carry-over) with
// an icon; every step sits under its equipment, with the equipment's
// own window and progress, so nothing is context-free. Prints as a
// clean agenda with the same hierarchy.

import React, { useEffect, useMemo, useState } from "react";
import { Printer, ChevronLeft, ChevronRight, Sun, Moon, AlertTriangle, CheckCircle2, Flag, FastForward, ArrowRight, Ban, PauseCircle, TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { Milestone } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import {
  buildShiftReport, shiftWindow, nextShift, previousShift, defaultReviewShift, nextShiftWithWork,
  DEFAULT_SHIFT_TIMES, type ShiftTimes, type ShiftRow, type ShiftWindow,
} from "@/lib/shiftReport";
import { clockLabel, fmtInTz, tzAbbrev } from "@/lib/scheduleTz";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";

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
function byEquipment(rows: ShiftRow[]): Array<{ key: string; parentId: string | null; title: string; crumbs: string; rows: ShiftRow[] }> {
  const out = new Map<string, { key: string; parentId: string | null; title: string; crumbs: string; rows: ShiftRow[] }>();
  for (const r of rows) {
    const title = r.parentName ?? r.leaf.name;
    const key = r.parentId ?? `leaf:${r.leaf.id}`;
    let g = out.get(key);
    if (!g) { g = { key, parentId: r.parentId, title, crumbs: r.path.slice(0, -1).join(" › "), rows: [] }; out.set(key, g); }
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

  // Re-evaluated every minute so a tab left open rolls over a shift
  // boundary (and "as of now" stays current) without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(id); }, []);
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
  const byId = useMemo(() => { const m = new Map<string, Milestone>(); for (const x of milestones) if (x.id) m.set(x.id, x); return m; }, [milestones]);

  // ── formatting helpers (plant time) ──
  const D = (ms: number) => fmtInTz(ms, tz, { weekday: "short", month: "short", day: "numeric" });        // Mon, Oct 26
  const DL = (ms: number) => fmtInTz(ms, tz, { weekday: "long", month: "long", day: "numeric" });         // Monday, October 26
  const T = (ms: number) => { const c = clockLabel(ms, tz); return c || (new Date(ms).getUTCHours() === 0 ? "0:00" : "0:00"); };
  const DT = (ms: number) => `${D(ms)} ${T(ms)}`;
  const win = (w: ShiftWindow) => `${T(w.start)} – ${T(w.end)}${fmtInTz(w.start, tz, { day: "numeric" }) !== fmtInTz(w.end, tz, { day: "numeric" }) ? ` (${D(w.end)})` : ""}`;
  const rowTime = (r: ShiftRow, w: ShiftWindow) => {
    const s = r.start >= w.start && r.start < w.end ? T(r.start) : null;
    const f = r.finish > w.start && r.finish <= w.end ? T(r.finish) : null;
    if (!s && !f) return "all shift";
    return `${s ?? "…"} – ${f ?? "…"}`;
  };

  // "Did not finish" on the closing shift = everything open that was due,
  // plus this shift's planned steps that were not started.
  const didNotFinish = useMemo(() => {
    const seen = new Set<string>();
    const out: ShiftRow[] = [];
    for (const r of [...review.carryOver, ...review.inProgress, ...review.notStarted]) {
      if (!r.leaf.id || seen.has(r.leaf.id)) continue;
      seen.add(r.leaf.id); out.push(r);
    }
    return out.sort((a, b) => Number(b.critical) - Number(a.critical) || Number(b.carryOver) - Number(a.carryOver) || a.start - b.start);
  }, [review]);

  const standing = overall.standing;
  const standingUi = standing === "ahead"
    ? { label: "AHEAD OF PLAN", cls: "bg-emerald-600 text-white", Icon: TrendingUp }
    : standing === "behind"
      ? { label: "BEHIND PLAN", cls: "bg-rose-600 text-white", Icon: TrendingDown }
      : { label: "ON TRACK", cls: "bg-slate-700 text-white", Icon: Minus };

  // Priority number per goal, in the order the plan lists them
  // (carry-overs first, critical on top, then scheduled work).
  const priorityOf = useMemo(() => {
    const m = new Map<string, number>();
    goals.all.forEach((r, i) => { if (r.leaf.id) m.set(r.leaf.id, i + 1); });
    return m;
  }, [goals.all]);

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden">
      <style>{`
        @media print {
          @page { margin: 12mm; }
          body * { visibility: hidden !important; }
          .shift-report-print, .shift-report-print * { visibility: visible !important; }
          .shift-report-print { position: absolute !important; left: 0; top: 0; width: 100% !important; padding: 0 !important; font-size: 11pt; }
          .shift-report-print .no-print { display: none !important; }
          .shift-report-print section { break-inside: avoid; }
          .shift-report-print .equip { break-inside: avoid; }
          .shift-report-print * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>

      {/* ── Toolbar (screen only) ─────────────────────────────────── */}
      <div className="no-print px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap bg-gradient-to-b from-white to-slate-50/40">
        <button onClick={() => pick(previousShift(shift, tz, times))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Previous shift"><ChevronLeft className="w-4 h-4" /></button>
        <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-md p-0.5 gap-0.5">
          {(["day", "night"] as const).map((k) => (
            <button key={k} onClick={() => setSel({ dayKey: shift.dayKey, kind: k })} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${shift.kind === k ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              {k === "day" ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />} {k === "day" ? "Day" : "Night"}
            </button>
          ))}
        </div>
        <input type="date" value={shift.dayKey} onChange={(e) => { if (e.target.value) setSel({ dayKey: e.target.value, kind: shift.kind }); }}
          className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-2 bg-[var(--color-surface)]" title="Which day's shift to close" />
        <button onClick={() => pick(nextShift(shift, tz, times))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Next shift"><ChevronRight className="w-4 h-4" /></button>
        <button onClick={() => setSel(null)} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] border border-[var(--color-border)]">Current shift</button>
        <span className="mx-1 w-px h-4 bg-[var(--color-border)]" />
        <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><Sun className="w-3 h-3" /> day starts
          <input type="time" value={times.dayStart} onChange={(e) => saveTimes({ ...times, dayStart: e.target.value || DEFAULT_SHIFT_TIMES.dayStart })} className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
        </label>
        <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><Moon className="w-3 h-3" /> night starts
          <input type="time" value={times.nightStart} onChange={(e) => saveTimes({ ...times, nightStart: e.target.value || DEFAULT_SHIFT_TIMES.nightStart })} className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
        </label>
        <button onClick={() => window.print()} className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-3 py-1.5 rounded-lg shadow-sm">
          <Printer className="w-3.5 h-3.5" /> Print agenda
        </button>
      </div>

      {/* ── The agenda ────────────────────────────────────────────── */}
      <div className="shift-report-print text-[12.5px] text-[var(--color-text)]">

        {/* Masthead: which meeting this is. */}
        <header className="px-6 py-4 bg-slate-900 text-white">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Shift change meeting</div>
              <h2 className="text-xl font-black leading-tight truncate">{projectName ?? "Schedule"}</h2>
              <div className="text-[11px] text-slate-300 mt-0.5">
                {DL(asOf)} · as of <b className="text-white">{T(asOf)}</b> plant time ({tzAbbrev(tz, asOf)})
                {rehearsal && <span className="no-print ml-2 px-1.5 py-0.5 rounded bg-amber-400 text-slate-900 text-[10px] font-black uppercase">Rehearsal — shift not started yet</span>}
              </div>
            </div>
            <div className={`rounded-xl px-4 py-2 text-right shrink-0 ${standingUi.cls}`}>
              <div className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest opacity-90"><standingUi.Icon className="w-3.5 h-3.5" /> Overall</div>
              <div className="text-xl font-black leading-none">{standingUi.label}</div>
              <div className="text-[11px] font-bold opacity-90">{overall.variancePct > 0 ? "+" : ""}{overall.variancePct} points vs plan</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-2 items-stretch">
            <ShiftCard label="Closing" kind={shift.kind} date={DL(shift.start)} window={win(shift)} />
            <div className="hidden sm:flex items-center justify-center text-slate-400"><ArrowRight className="w-5 h-5" /></div>
            <ShiftCard label="Opening" kind={next.kind} date={DL(next.start)} window={win(next)} emphasis />
          </div>
        </header>

        <div className="px-6 py-5 space-y-7">

          {/* 1 ── Where we stand */}
          <section>
            <Agenda n={1} title="Where we stand" sub={overall.plannedFinish ? `Schedule day ${overall.daysElapsed} of ${overall.daysTotal} · planned finish ${DT(overall.plannedFinish)}` : undefined} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Actual complete" value={`${overall.actualPct}%`} tone={standing === "behind" ? "rose" : standing === "ahead" ? "emerald" : "slate"} />
              <Stat label="Plan said by now" value={`${overall.plannedPct}%`} tone="slate" />
              <Stat label="Steps done" value={`${overall.stepsDone}`} sub={`of ${overall.stepsTotal}`} tone="slate" />
              <Stat label="Carry-over" value={`${review.carryOver.length}`} sub={review.carryOver.length ? "steps overdue" : "nothing overdue"} tone={review.carryOver.length ? "amber" : "emerald"} />
            </div>
            <div className="mt-2 space-y-1">
              <Bar label="Actual" pct={overall.actualPct} cls={standing === "behind" ? "bg-rose-500" : "bg-emerald-500"} />
              <Bar label="Plan" pct={overall.plannedPct} cls="bg-slate-400" />
            </div>
          </section>

          {/* 2 ── Last shift: results */}
          <section>
            <Agenda n={2} title={`Last shift: results`} sub={`${shift.kind === "day" ? "Day" : "Night"} shift · ${D(shift.start)} · ${win(shift)} · ${review.scheduled.length} step${review.scheduled.length === 1 ? "" : "s"} planned`} />
            {review.scheduled.length === 0 && review.done.length === 0 && didNotFinish.length === 0 ? (
              <EmptyRow>
                Nothing was planned for this shift.
                {jumpTarget && (
                  <button onClick={() => pick(jumpTarget)} className="no-print ml-2 inline-flex items-center gap-1 font-bold text-[var(--color-accent)] hover:underline">
                    <FastForward className="w-3.5 h-3.5" /> Jump to {jumpTarget.kind} shift, {D(jumpTarget.start)}
                  </button>
                )}
              </EmptyRow>
            ) : (
              <div className="space-y-4">
                <Block tone="emerald" icon={<CheckCircle2 className="w-4 h-4" />} title="Completed" count={review.done.length} empty="Nothing was completed on this shift.">
                  <Equipment rows={review.done} byId={byId} progress={progress} D={D} T={T} render={(r) => (
                    <Line marker={<CheckCircle2 className="w-4 h-4 text-emerald-600" />} time={r.offSchedule ? "early" : rowTime(r, shift)} name={r.leaf.name} done
                      tags={[r.offSchedule ? { t: `planned ${DT(r.start)}`, tone: "muted" as const } : null]} right="Done" />
                  )} />
                </Block>
                <Block tone="amber" icon={<AlertTriangle className="w-4 h-4" />} title="Did not finish — carries over" count={didNotFinish.length} empty="Everything planned for this shift is done.">
                  <Equipment rows={didNotFinish} byId={byId} progress={progress} D={D} T={T} render={(r) => (
                    <Line marker={r.critical ? <Flag className="w-4 h-4 text-rose-600" /> : <Box />} time={r.offSchedule ? `due ${DT(r.finish)}` : rowTime(r, shift)} name={r.leaf.name}
                      tags={[
                        r.critical ? { t: "critical path", tone: "rose" as const } : null,
                        r.status === "blocked" ? { t: "blocked", tone: "rose" as const } : r.status === "on_hold" ? { t: "on hold", tone: "amber" as const } : null,
                        r.carryOver && !r.offSchedule ? { t: "overdue", tone: "amber" as const } : null,
                        r.offSchedule ? { t: `planned ${D(r.start)}`, tone: "muted" as const } : null,
                      ]}
                      right={r.percent > 0 ? `${r.percent}%` : "not started"} />
                  )} />
                </Block>
              </div>
            )}
          </section>

          {/* 3 ── Needs a decision */}
          <section>
            <Agenda n={3} title="Needs a decision" sub={blocked.length === 0 ? "No blocked or on-hold work." : `${blocked.length} step${blocked.length === 1 ? "" : "s"} blocked or on hold`} />
            {blocked.length > 0 && (
              <Equipment rows={blocked} byId={byId} progress={progress} D={D} T={T} render={(r) => (
                <div className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {r.status === "blocked" ? <Ban className="w-4 h-4 text-rose-600 shrink-0" /> : <PauseCircle className="w-4 h-4 text-amber-600 shrink-0" />}
                    <span className="font-bold">{r.leaf.name}</span>
                    <Tag t={r.status === "blocked" ? "blocked" : "on hold"} tone={r.status === "blocked" ? "rose" : "amber"} />
                    {r.critical && <Tag t="critical path" tone="rose" />}
                    <span className="ml-auto text-[11px] font-mono text-[var(--color-text-muted)]">due {DT(r.finish)} · {r.percent}%</span>
                  </div>
                  <div className={`mt-1 ml-6 text-[12px] ${r.reason ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)] italic"}`}>
                    {r.reason ? <>Reason: {r.reason}</> : "No reason recorded — ask the crew lead."}
                  </div>
                  <div className="mt-1 ml-6 text-[11px] text-[var(--color-text-faint)]">Decision / owner: <span className="inline-block w-56 border-b border-dotted border-[var(--color-border-strong)] align-baseline" /></div>
                </div>
              )} />
            )}
          </section>

          {/* 4 ── Next shift: the plan */}
          <section>
            <Agenda n={4} title="Next shift: the plan" sub={`${next.kind === "day" ? "Day" : "Night"} shift · ${D(next.start)} · ${win(next)} · ${goals.all.length} step${goals.all.length === 1 ? "" : "s"} · ${goals.critical.length} on the critical path`} />
            {goals.all.length === 0 ? <EmptyRow>Nothing is scheduled for the next shift.</EmptyRow> : (
              <div className="space-y-4">
                {goals.carryOver.length > 0 && (
                  <Block tone="rose" icon={<Flag className="w-4 h-4" />} title="Priorities — clear these first" count={goals.carryOver.length} empty="">
                    <Equipment rows={goals.carryOver} byId={byId} progress={progress} D={D} T={T} render={(r) => (
                      <Line marker={<Num n={priorityOf.get(r.leaf.id ?? "") ?? 0} tone={r.critical ? "rose" : "amber"} />} time={`due ${DT(r.finish)}`} name={r.leaf.name}
                        tags={[r.critical ? { t: "critical path", tone: "rose" as const } : null, { t: "carry-over", tone: "amber" as const }]}
                        who={[r.leaf.responsibleParty, r.leaf.workOrderRef ? `WO ${r.leaf.workOrderRef}` : null].filter(Boolean).join(" · ")}
                        right={`${r.percent}%`} box />
                    )} />
                  </Block>
                )}
                <Block tone="slate" icon={<ArrowRight className="w-4 h-4" />} title="Scheduled this shift" count={goals.planned.length} empty="No new work starts on this shift.">
                  <Equipment rows={goals.planned} byId={byId} progress={progress} D={D} T={T} render={(r) => (
                    <Line marker={<Num n={priorityOf.get(r.leaf.id ?? "") ?? 0} tone={r.critical ? "rose" : "slate"} />} time={rowTime(r, next)} name={r.leaf.name}
                      tags={[r.critical ? { t: "critical path", tone: "rose" as const } : null, r.start < next.start ? { t: `started ${D(r.start)}`, tone: "muted" as const } : null, r.finish > next.end ? { t: `runs to ${D(r.finish)}`, tone: "muted" as const } : null]}
                      who={[r.leaf.responsibleParty, r.leaf.workOrderRef ? `WO ${r.leaf.workOrderRef}` : null].filter(Boolean).join(" · ")}
                      right={r.percent > 0 ? `${r.percent}%` : ""} box />
                  )} />
                </Block>
              </div>
            )}
          </section>

          {/* 5 ── Close */}
          <section>
            <Agenda n={5} title="Close" sub="Notes, safety items, resource asks — and who owns the sheet." />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-[var(--color-border)] p-3">
                <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-2">Notes</div>
                {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-5 border-b border-dotted border-[var(--color-border-strong)]" />)}
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-3">
                <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Sign-off</div>
                {["Outgoing supervisor", "Incoming supervisor", "Crew lead"].map((who) => (
                  <div key={who} className="flex items-end gap-2 text-[11px] text-[var(--color-text-muted)]">
                    <span className="w-36 shrink-0">{who}</span>
                    <span className="flex-1 border-b border-[var(--color-border-strong)]" />
                    <span className="w-16 border-b border-[var(--color-border-strong)] text-center text-[9px]">time</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <footer className="pt-3 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)] flex justify-between gap-4 flex-wrap">
            <span>Plan % = work the schedule expected complete by {DT(asOf)}, hour-weighted. Actual % = progress entered, hour-weighted. Flag = on the chain that drives the finish date.</span>
            <span className="shrink-0">Printed {DT(now)} · {projectName ?? ""}</span>
          </footer>
        </div>
      </div>
    </div>
  );
}

// ─── building blocks ───────────────────────────────────────────────

function ShiftCard({ label, kind, date, window, emphasis }: { label: string; kind: "day" | "night"; date: string; window: string; emphasis?: boolean }) {
  const Icon = kind === "day" ? Sun : Moon;
  return (
    <div className={`rounded-xl px-4 py-2.5 border ${emphasis ? "bg-white text-slate-900 border-white" : "bg-slate-800 text-white border-slate-700"}`}>
      <div className={`text-[10px] font-black uppercase tracking-[0.18em] ${emphasis ? "text-[var(--color-accent)]" : "text-slate-400"}`}>{label}</div>
      <div className="flex items-center gap-2 mt-0.5">
        <Icon className="w-4 h-4 shrink-0" />
        <span className="text-[15px] font-black">{kind === "day" ? "Day shift" : "Night shift"}</span>
      </div>
      <div className="text-[12px] font-semibold">{date}</div>
      <div className={`text-[11px] font-mono ${emphasis ? "text-slate-600" : "text-slate-300"}`}>{window}</div>
    </div>
  );
}

function Agenda({ n, title, sub }: { n: number; title: string; sub?: string }) {
  return (
    <div className="flex items-start gap-3 mb-3 pb-2 border-b-2 border-slate-900">
      <span className="w-7 h-7 rounded-full bg-slate-900 text-white font-black text-[13px] flex items-center justify-center shrink-0">{n}</span>
      <div className="min-w-0">
        <div className="text-[15px] font-black uppercase tracking-wide leading-7">{title}</div>
        {sub && <div className="text-[11px] text-[var(--color-text-muted)] -mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "emerald" | "rose" | "amber" | "slate" }) {
  const t = tone === "emerald" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : tone === "rose" ? "border-rose-300 bg-rose-50 text-rose-900" : tone === "amber" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]";
  return (
    <div className={`rounded-xl border px-3 py-2 ${t}`}>
      <div className="text-[9px] font-black uppercase tracking-widest opacity-70">{label}</div>
      <div className="text-2xl font-black leading-tight">{value}{sub && <span className="text-[11px] font-semibold opacity-70 ml-1">{sub}</span>}</div>
    </div>
  );
}

function Bar({ label, pct, cls }: { label: string; pct: number; cls: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-12 shrink-0 font-bold text-[var(--color-text-muted)]">{label}</span>
      <span className="flex-1 h-2.5 rounded-full bg-slate-200 overflow-hidden"><span className={`block h-full ${cls}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></span>
      <span className="w-10 text-right font-mono font-bold">{pct}%</span>
    </div>
  );
}

function Block({ tone, icon, title, count, empty, children }: { tone: "emerald" | "amber" | "rose" | "slate"; icon: React.ReactNode; title: string; count: number; empty: string; children: React.ReactNode }) {
  const t = tone === "emerald" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : tone === "rose" ? "text-rose-700" : "text-slate-700";
  return (
    <div>
      <div className={`inline-flex items-center gap-1.5 text-[12px] font-black uppercase tracking-wide ${t}`}>{icon} {title} <span className="font-mono font-bold opacity-80">({count})</span></div>
      {count === 0 ? (empty ? <div className="text-[11px] text-[var(--color-text-faint)] italic mt-0.5">{empty}</div> : null) : <div className="mt-1.5 space-y-2">{children}</div>}
    </div>
  );
}

/** Steps grouped under their equipment: a card per equipment with its own
 *  planned window and overall progress, so each line has its context. */
function Equipment({ rows, byId, progress, D, T, render }: {
  rows: ShiftRow[]; byId: Map<string, Milestone>; progress?: Map<string, ProgressInfo>;
  D: (ms: number) => string; T: (ms: number) => string; render: (r: ShiftRow) => React.ReactNode;
}) {
  return (
    <>
      {byEquipment(rows).map((g) => {
        const parent = g.parentId ? byId.get(g.parentId) : undefined;
        const info = g.parentId ? progress?.get(g.parentId) : undefined;
        const ps = parent ? startMsOf(parent) : NaN, pf = parent ? finishMsOf(parent) : NaN;
        return (
          <div key={g.key} className="equip rounded-lg border border-[var(--color-border)] overflow-hidden">
            <div className="px-3 py-1.5 bg-slate-100 border-b border-[var(--color-border)] flex items-center gap-3">
              <div className="min-w-0 flex-1">
                {g.crumbs && <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-faint)] truncate">{g.crumbs}</div>}
                <div className="text-[13px] font-black truncate">{g.title}</div>
              </div>
              {parent && Number.isFinite(ps) && Number.isFinite(pf) && (
                <div className="text-right shrink-0">
                  <div className="text-[10px] font-mono text-[var(--color-text-muted)]">{D(ps)} {T(ps)} → {D(pf)} {T(pf)}</div>
                  {info && <div className="text-[10px] font-bold text-[var(--color-text-muted)]">{info.leafDone}/{info.leafTotal} steps · {info.percent}% overall</div>}
                </div>
              )}
            </div>
            <ul className="divide-y divide-[var(--color-border)]">
              {g.rows.map((r) => <li key={r.leaf.id}>{render(r)}</li>)}
            </ul>
          </div>
        );
      })}
    </>
  );
}

type TagTone = "rose" | "amber" | "muted";
function Tag({ t, tone }: { t: string; tone: TagTone }) {
  const cls = tone === "rose" ? "bg-rose-100 text-rose-800 border-rose-200" : tone === "amber" ? "bg-amber-100 text-amber-800 border-amber-200" : "bg-slate-100 text-slate-600 border-slate-200";
  return <span className={`shrink-0 px-1.5 py-px rounded border text-[9px] font-black uppercase tracking-wider ${cls}`}>{t}</span>;
}

function Line({ marker, time, name, tags, who, right, done, box }: {
  marker: React.ReactNode; time: string; name: string; tags?: Array<{ t: string; tone: TagTone } | null>; who?: string; right: string; done?: boolean; box?: boolean;
}) {
  return (
    <div className="px-3 py-1.5 flex items-center gap-2.5">
      {box && <Box />}
      <span className="shrink-0 w-5 flex justify-center">{marker}</span>
      <span className="shrink-0 w-[118px] font-mono text-[11px] font-bold tabular-nums text-[var(--color-text)]">{time}</span>
      <span className={`min-w-0 flex-1 truncate text-[12.5px] ${done ? "line-through text-[var(--color-text-faint)]" : "font-semibold"}`}>{name}</span>
      {tags?.filter(Boolean).map((tg) => <Tag key={tg!.t} t={tg!.t} tone={tg!.tone} />)}
      {who && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)] truncate max-w-[150px]">{who}</span>}
      <span className="shrink-0 w-16 text-right font-mono text-[11px] font-bold text-[var(--color-text-muted)]">{right}</span>
    </div>
  );
}

function Num({ n, tone }: { n: number; tone: "rose" | "amber" | "slate" }) {
  const cls = tone === "rose" ? "bg-rose-600 text-white" : tone === "amber" ? "bg-amber-500 text-white" : "bg-slate-200 text-slate-800";
  return <span className={`w-5 h-5 rounded-full text-[10px] font-black flex items-center justify-center ${cls}`}>{n}</span>;
}

function Box() {
  return <span className="inline-block w-3.5 h-3.5 rounded-[3px] border-2 border-slate-400 shrink-0" aria-hidden />;
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-[12px] text-[var(--color-text-muted)]">{children}</div>;
}
