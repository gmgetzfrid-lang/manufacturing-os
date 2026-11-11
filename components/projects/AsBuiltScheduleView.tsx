"use client";

// AsBuiltScheduleView - the job as it was really worked (As-built), and the
// schedule suggested for next time made from it (Suggested), side by side
// behind one toggle. As-built: each activity's shifts with progress, the
// shifts it sat (and why, in the crew's own comments), the shifts it was
// ready but its crew was elsewhere (and where), the crews and their hands
// against the work. Suggested: this year's job with the found work in, the
// waits planned for, a person's changes ("Tell the schedule", hands typed
// in), the crew load and the hands it needs. lib/asBuiltWork, lib/nextPlan.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Send, Undo2, Upload, Check, X, Download, Printer, CalendarClock } from "lucide-react";
import type { Milestone, MilestoneNote } from "@/types/schema";
import type { CancelledJob } from "@/lib/cancelledJobs";
import type { ProjectPhase } from "@/lib/projectPhases";
import type { ShiftTimes } from "@/lib/shiftReport";
import type { ShiftRecord } from "@/lib/shiftRecord";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { buildAsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork, shiftKey, type AsBuiltWork, type WaitRun } from "@/lib/asBuiltWork";
import { nextPlan, finishLever, dayNumber, type NextPlan, type PlanChange } from "@/lib/nextPlan";
import { loadNextPlanSettings, saveNextPlanChanges, saveStaffingPlan, type NextPlanSettings } from "@/lib/nextPlanStore";
import { parseStaffingGrid, type StaffingPlan } from "@/lib/staffingPlan";
import { talkCatalog, parseTalkReply } from "@/lib/nextPlanTalk";
import { loadProgressLog } from "@/lib/progressHistory";
import { notesFor } from "@/lib/milestones";
import { loadShiftRecords } from "@/lib/shiftRecord";
import { loadManpowerSettings, companyOf as companyOfCrew, type ManpowerSettings } from "@/lib/manpower";
import { fmtInTz } from "@/lib/scheduleTz";
import { supabase } from "@/lib/supabase";

const PX = 34;
const PALETTE = ["#2563eb", "#059669", "#7c3aed", "#64748b", "#0891b2", "#db2777", "#b45309", "#475569", "#0d9488", "#9333ea"];
const r1 = (n: number) => Math.round(n * 10) / 10;

interface Props {
  projectId: string;
  orgId: string | null;
  milestones: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  cancelled?: CancelledJob[];
  phases: ProjectPhase[];
  phase: string | null;
  tz: string;
  times: ShiftTimes;
  canEdit: boolean;
  userName?: string | null;
  onExcel?: () => void;
  onPrint?: () => void;
}

export default function AsBuiltScheduleView(p: Props) {
  const { tz, times } = p;
  const [view, setView] = useState<"built" | "next">("built");
  const [data, setData] = useState<{ log: ProgressLogRow[]; notes: MilestoneNote[]; records: Map<string, ShiftRecord>; mp: ManpowerSettings; settings: NextPlanSettings } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const built = useMemo(() => buildAsBuilt({ milestones: p.milestones, childrenByParent: p.childrenByParent, cancelled: p.cancelled, phases: p.phases, tz }), [p.milestones, p.childrenByParent, p.cancelled, p.phases, tz]);
  const stepIds = useMemo(() => built.orders.flatMap((o) => o.steps.map((s) => s.id)), [built]);
  const idsKey = stepIds.join(",");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [log, notes, records, mp, settings] = await Promise.all([
          loadProgressLog(p.projectId), notesFor(stepIds), loadShiftRecords(p.projectId).catch(() => new Map<string, ShiftRecord>()),
          loadManpowerSettings(p.projectId), loadNextPlanSettings(p.projectId),
        ]);
        if (live) setData({ log: log ?? [], notes, records, mp, settings });
      } catch (e) { if (live) setErr((e as Error).message); }
    })();
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the step list, by its ids
  }, [p.projectId, idsKey]);

  const work = useMemo(() => (data ? buildAsBuiltWork({ built, milestones: p.milestones, log: data.log, notes: data.notes, records: data.records, plans: data.settings.staffing, companyOf: (c) => companyOfCrew(c, data.mp), tz, times, now: Date.now() }) : null), [data, built, p.milestones, tz, times]);
  const scope = p.phase ?? "all";
  const changes = useMemo(() => data?.settings.changes[scope] ?? [], [data, scope]);
  const plan = useMemo(() => (work ? nextPlan({ built, work, milestones: p.milestones, tz, times, changes }) : null), [work, built, p.milestones, tz, times, changes]);

  const crews = useMemo(() => {
    const names = [...new Set([...(work?.crews.map((c) => c.crew) ?? []), ...Object.keys(plan?.load ?? {})])];
    return new Map(names.map((n, i) => [n, PALETTE[i % PALETTE.length]]));
  }, [work, plan]);
  const colorOf = (c: string) => crews.get(c) ?? "#94a3b8";

  const saveChanges = useCallback(async (next: PlanChange[]) => {
    if (!data) return;
    setData({ ...data, settings: { ...data.settings, changes: { ...data.settings.changes, [scope]: next } } });
    try { await saveNextPlanChanges(p.projectId, scope, next); setMsg(null); } catch (e) { setMsg((e as Error).message); }
  }, [data, scope, p.projectId]);

  if (err) return <div className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/30 p-3 text-[13px] text-rose-800 dark:text-rose-200">{err}</div>;
  if (!data || !work || !plan) return <div className="py-10 text-center text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Reading the job shift by shift…</div>;
  if (!built.orders.length) return <div className="py-8 text-center text-[13px] text-[var(--color-text-muted)]">No schedule here yet.</div>;

  return (
    <div className="space-y-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Schedule" className="inline-flex rounded-lg border border-slate-400 overflow-hidden">
          {([["built", "As-built"], ["next", "Suggested for next time"]] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={view === k} type="button" onClick={() => setView(k)}
              className={`px-3 py-1.5 text-[13px] font-bold cursor-pointer ${view === k ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>{label}</button>
          ))}
        </div>
        {p.onExcel && <button type="button" onClick={p.onExcel} className={btnQuiet}><Download className="w-4 h-4" /> Excel</button>}
        {p.onPrint && <button type="button" onClick={p.onPrint} className={btnQuiet}><Printer className="w-4 h-4" /> Print</button>}
        {msg && <span role="status" className="text-[12px] font-semibold text-rose-700 dark:text-rose-400">{msg}</span>}
      </div>
      {view === "built"
        ? <BuiltView {...p} built={built} work={work} colorOf={colorOf} changes={changes} onAdd={(c) => void saveChanges([...changes, c])} />
        : <NextView {...p} built={built} work={work} plan={plan} colorOf={colorOf} changes={changes} settings={data.settings} onChanges={(n) => void saveChanges(n)}
            onStaffing={(next) => setData({ ...data, settings: { ...data.settings, staffing: next } })} />}
    </div>
  );
}

const btnQuiet = "inline-flex items-center gap-1.5 rounded-lg border border-slate-400 bg-[var(--color-surface)] px-3 py-1.5 text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] cursor-pointer disabled:opacity-50";
const btnPri = "inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-bold text-[var(--color-accent-fg)] hover:opacity-90 cursor-pointer disabled:opacity-50";

// ── Shared timeline bits ─────────────────────────────────────────────────

function useAxis(work: { shifts: Array<{ start: number; end: number; kind: string; dayKey: string }> }) {
  const shifts = work.shifts;
  const x = (t: number) => {
    if (!shifts.length) return 0;
    if (t <= shifts[0].start) return 0;
    for (let i = 0; i < shifts.length; i++) {
      const s = shifts[i];
      if (t < s.end) return i * PX + (PX * (t - s.start)) / (s.end - s.start);
    }
    return shifts.length * PX;
  };
  return { x, width: shifts.length * PX };
}

function Header({ shifts, tz, dayLabel }: { shifts: Array<{ start: number; kind: string }>; tz: string; dayLabel?: (t: number) => string }) {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < shifts.length; i++) {
    const s = shifts[i];
    if (s.kind !== "day" && i !== 0) continue;
    const span = s.kind === "day" ? 2 : 1;
    out.push(
      <div key={i} className="absolute top-0 border-l border-[var(--color-border)] pl-1 text-[10.5px] text-[var(--color-text-muted)] leading-tight" style={{ left: i * PX, width: span * PX }}>
        <b className="text-[var(--color-text)]">{dayLabel ? dayLabel(s.start) : fmtInTz(s.start, tz, { weekday: "short" })}</b> {dayLabel ? fmtInTz(s.start, tz, { weekday: "short" }) : fmtInTz(s.start, tz, { month: "short", day: "numeric" })}
        <div className="flex mt-0.5">{span === 2 ? <><span className="flex-1 text-center">D</span><span className="flex-1 text-center">N</span></> : <span className="flex-1 text-center">{s.kind === "night" ? "N" : "D"}</span>}</div>
      </div>,
    );
  }
  return <div className="relative h-8" style={{ width: shifts.length * PX }}>{out}</div>;
}

function Grid({ shifts }: { shifts: Array<{ kind: string }> }) {
  return <>{shifts.map((s, i) => <i key={i} aria-hidden className={`absolute top-0 bottom-0 ${s.kind === "night" ? "border-l border-dashed border-[var(--color-border)] bg-slate-500/[0.03]" : "border-l border-[var(--color-border)]"}`} style={{ left: i * PX, width: PX }} />)}</>;
}

const when = (t: number | null, tz: string) => (t == null ? "-" : `${fmtInTz(t, tz, { weekday: "short", month: "numeric", day: "numeric" })} ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`);
const hatch = (a: string, b: string) => ({ background: `repeating-linear-gradient(135deg, ${a} 0 4px, ${b} 4px 8px)` });
const WAIT = { ...hatch("#fde68a", "#fff7d6"), border: "1px solid #f59e0b" };
const READY = { ...hatch("#bfdbfe", "#eff6ff"), border: "1px solid #60a5fa" };
/** On a work order's own line: a shift between its first and last work with
 *  nothing logged on any of its activities (its "shifts waited"). */
const ORDER_WAIT = hatch("#94a3b8", "#f1f5f9");

function Legend({ items }: { items: Array<[React.CSSProperties, string]> }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-text-muted)]">
      {items.map(([st, label]) => <span key={label} className="inline-flex items-center gap-1"><span className="inline-block w-4 h-2.5 rounded-sm" style={st} />{label}</span>)}
    </div>
  );
}

const cellAct = "sticky left-0 z-[2] bg-[var(--color-surface)] border-r border-[var(--color-border)] align-top px-2 py-1.5 w-[170px] min-w-[170px] max-w-[170px] sm:w-[290px] sm:min-w-[290px] sm:max-w-[290px]";
const cellDt = "align-top px-2 py-1.5 text-[11px] whitespace-nowrap text-[var(--color-text)]";
const cellN = "align-top px-1.5 py-1.5 text-center font-bold text-[12.5px] min-w-[44px]";

// ── As-built ─────────────────────────────────────────────────────────────

function BuiltView(p: Props & { built: ReturnType<typeof buildAsBuilt>; work: AsBuiltWork; colorOf: (c: string) => string; changes: PlanChange[]; onAdd: (c: PlanChange) => void }) {
  const { tz, built, work } = p;
  const { x, width } = useAxis(work);
  const keys = work.shifts.map(shiftKey);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const [planning, setPlanning] = useState<{ step: string; run: number } | null>(null);
  const planFin = built.planFinish;
  const line = planFin != null ? <i aria-hidden title="Planned finish" className="absolute top-0 bottom-0 border-l-2 border-red-600" style={{ left: x(planFin) }} /> : null;
  const orders = [...built.orders].sort((a, b) => (a.planStart ?? Infinity) - (b.planStart ?? Infinity));
  const t = work.totals;
  const late = built.finish != null && built.planFinish != null ? r1((built.finish - built.planFinish) / 3_600_000) : null;
  const planned = (k: string, crew: string) => work.crews.find((c) => c.crew === crew)?.byShift[k];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-[12.5px]">
        <Chip>Planned finish <b>{when(built.planFinish, tz)}</b></Chip>
        <Chip>Actual finish <b className={late != null && late > 0.5 ? "text-rose-700 dark:text-rose-400" : ""}>{built.finish != null ? when(built.finish, tz) : "not done yet"}</b>{late != null && Math.abs(late) >= 0.5 ? <span className="text-[var(--color-text-muted)]"> {Math.abs(late)} h {late > 0 ? "late" : "early"}</span> : null}</Chip>
        <Chip><b>{built.steps}</b> activities · <b>{built.added}</b> added during the job</Chip>
        <Chip>Sat in progress: <b>{t.waitedSteps}</b> activities, <b>{t.waitedShifts}</b> shifts</Chip>
        <Chip>Ready but not started: <b>{t.readySteps}</b> activities, <b>{t.readyShifts}</b> shifts</Chip>
      </div>
      <Legend items={[[{ background: "#334155" }, "Progress logged that shift"], [ORDER_WAIT, "Work order open, nothing logged that shift"], [WAIT, "Activity in progress, nothing logged"], [READY, "Ready, not started: its crew was elsewhere"], [{ background: "#cbd5e1", height: 4 }, "Plan"], [{ borderLeft: "2px solid #dc2626", width: 2 }, "Planned finish"]]} />
      <div className="overflow-auto max-h-[75vh] rounded-xl border border-[var(--color-border)]">
        <table className="border-separate border-spacing-0 w-max text-[12px]">
          <thead className="sticky top-0 z-[4] bg-[var(--color-surface-2)]">
            <tr className="text-[11px] text-[var(--color-text-muted)] text-left">
              <th className={`${cellAct} !bg-[var(--color-surface-2)] z-[5]`}>Activity</th>
              <th className="px-2 font-semibold">Planned</th><th className="px-2 font-semibold">Actual</th>
              <th className="px-1 font-semibold text-center">Shifts<br />worked</th><th className="px-1 font-semibold text-center">Shifts<br />waited</th>
              <th className="p-0"><Header shifts={work.shifts} tz={tz} /></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const ow = work.orders.get(o.key);
              return (
                <React.Fragment key={o.key}>
                  <tr className="bg-[var(--color-surface-2)]">
                    <td className={`${cellAct} !bg-[var(--color-surface-2)]`}>
                      <div className="font-black text-[12.5px] text-[var(--color-text)]">{o.name}</div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">{o.wo ? `${o.wo} · ` : ""}{o.steps.length} activit{o.steps.length === 1 ? "y" : "ies"}{o.steps.some((s) => !s.inPlan) ? ` · ${o.steps.filter((s) => !s.inPlan).length} added` : ""}</div>
                    </td>
                    <td className={cellDt}>{when(o.planStart, tz)}<br />{when(o.planFinish, tz)}</td>
                    <td className={cellDt}>{when(o.start, tz)}<br />{when(o.finish, tz)}</td>
                    <td className={cellN}>{ow?.worked ?? 0}</td>
                    <td className={`${cellN} ${ow?.waited ? "text-amber-700 dark:text-amber-400" : ""}`}>{ow?.waited || "-"}</td>
                    <td className="p-0 relative"><div className="relative h-11" style={{ width }}>
                      <Grid shifts={work.shifts} />
                      {o.planStart != null && o.planFinish != null && <i className="absolute top-1.5 h-1 rounded bg-slate-300" style={{ left: x(o.planStart), width: Math.max(2, x(o.planFinish) - x(o.planStart)) }} />}
                      {ow?.cells.map((c, i) => c && <i key={i} className="absolute top-4 h-2.5 rounded-sm" style={{ left: i * PX + 1, width: PX - 2, ...(c === "work" ? { background: "#334155" } : ORDER_WAIT) }} title={c === "work" ? "Progress logged that shift" : "Work order open, nothing logged that shift"} />)}
                      {line}
                    </div></td>
                  </tr>
                  {[...o.steps].sort((a, b) => (a.start ?? a.planStart ?? 0) - (b.start ?? b.planStart ?? 0)).map((s) => {
                    const w = work.steps.get(s.id);
                    if (!w) return null;
                    const waited = w.waits.reduce((n, r) => n + r.shifts, 0) + (w.ready?.shifts.length ?? 0);
                    return (
                      <tr key={s.id}>
                        <td className={cellAct}>
                          <div className="font-bold text-[var(--color-text)]">{s.name}{!s.inPlan && <span className="ml-1 rounded bg-orange-100 dark:bg-orange-900/40 px-1 text-[10px] font-black text-orange-900 dark:text-orange-200">Added</span>}</div>
                          <div className="text-[11px] text-[var(--color-text-muted)]"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(w.crew) }} />{w.crew} · plan {r1(s.plannedH)} h</div>
                          {w.ready && <div className="text-[11px] text-blue-700 dark:text-blue-300">Ready {when(w.ready.at, tz)}, waited {w.ready.shifts.length} shift{w.ready.shifts.length === 1 ? "" : "s"} to start: {w.ready.busyOn.length ? `${w.crew} was on ${[...new Set(w.ready.busyOn.map((b) => b.split(" - ")[0]))].join(", ")}` : `${w.crew} logged nothing those shifts`}</div>}
                          {w.waits.map((r, i) => (
                            <div key={i} className="text-[11px] text-amber-800 dark:text-amber-300">
                              Waited {r.shifts} shift{r.shifts === 1 ? "" : "s"}: {r.why.length ? r.why.map((x) => `"${x}"`).join(" · ") : "no reason recorded"}
                              {p.canEdit && r.why.length > 0 && <button type="button" onClick={() => setPlanning({ step: s.id, run: i })} className="ml-1 font-bold underline cursor-pointer text-[var(--color-accent)]">Plan for it next time</button>}
                              {planning?.step === s.id && planning.run === i && <PlanFor run={r} stepName={s.name} crews={work.crews.map((c) => c.crew)} doneBefore={progressBefore(w.moved, r, idx)} onCancel={() => setPlanning(null)} onSave={(c) => { p.onAdd({ ...c, ...(c.kind === "split" ? { actId: s.id } : {}) } as PlanChange); setPlanning(null); }} />}
                            </div>
                          ))}
                        </td>
                        <td className={cellDt}>{when(s.planStart, tz)}<br />{when(s.planFinish, tz)}</td>
                        <td className={cellDt}>{when(s.start, tz)}<br />{when(s.finish, tz)}</td>
                        <td className={cellN}>{w.worked.length}</td>
                        <td className={`${cellN} ${waited ? "text-amber-700 dark:text-amber-400" : ""}`}>{waited || "-"}</td>
                        <td className="p-0 relative"><div className="relative min-h-[42px] h-full" style={{ width }}>
                          <Grid shifts={work.shifts} />
                          {s.planStart != null && s.planFinish != null && <i className="absolute top-1.5 h-1 rounded bg-slate-300" style={{ left: x(s.planStart), width: Math.max(2, x(s.planFinish) - x(s.planStart)) }} />}
                          {w.worked.map((k) => idx.has(k) && <i key={k} title={`${w.moved[k] ? `${r1(w.moved[k])}% moved` : "started"}`} className="absolute top-3.5 h-4 rounded-sm" style={{ left: idx.get(k)! * PX + 2, width: PX - 4, background: p.colorOf(w.crew) }} />)}
                          {w.waits.flatMap((r) => keys.slice(idx.get(r.from)!, idx.get(r.to)! + 1)).map((k) => <i key={`w${k}`} className="absolute top-3.5 h-4 rounded-sm" style={{ left: idx.get(k)! * PX + 2, width: PX - 4, ...WAIT }} />)}
                          {w.ready?.shifts.map((k) => idx.has(k) && <i key={`r${k}`} className="absolute top-3.5 h-4 rounded-sm" style={{ left: idx.get(k)! * PX + 2, width: PX - 4, ...READY }} />)}
                          {line}
                        </div></td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
            <SectionRow title="Crews" sub="activities moved each shift; hands where counted at the meeting" width={width} shifts={work.shifts} />
            {work.crews.map((c) => (
              <tr key={c.crew}>
                <td className={cellAct}><div className="font-bold"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(c.crew) }} />{c.crew}</div><div className="text-[11px] text-[var(--color-text-muted)]">most moved in a shift: {c.mostMoved}</div></td>
                <td /><td /><td className={cellN}>{Object.values(c.byShift).filter((x) => x.moved).length}</td><td />
                <td className="p-0 relative"><div className="relative h-11" style={{ width }}>
                  <Grid shifts={work.shifts} />
                  {keys.map((k, i) => { const b = c.byShift[k]; const hands = b?.counted?.direct ?? b?.counted?.total; return b && (b.moved || hands) ? (
                    <span key={k} className="absolute top-1.5 h-8 rounded text-white text-center font-black text-[11px] leading-[13px] pt-0.5" style={{ left: i * PX + 2, width: PX - 4, background: p.colorOf(c.crew) }}>{b.moved}{hands ? <small className="block text-[8.5px] font-bold">{hands} hands</small> : null}</span>
                  ) : null; })}
                </div></td>
              </tr>
            ))}
            <SectionRow title="Hands against the work" sub="planned (staffing plan) or counted hands, and the plan hours of work each moved. Green about right, amber more hands than work logged, blue stretched." width={width} shifts={work.shifts} />
            {work.crews.filter((c) => Object.values(c.byShift).some((x) => x.counted || x.planned)).map((c) => {
              const verdicts = Object.entries(c.byShift).filter(([, x]) => x.verdict);
              const say = (v: string) => verdicts.filter(([, x]) => x.verdict === v).map(([k]) => shiftWords(k, work, tz)).join(", ");
              return (
                <tr key={`h${c.crew}`}>
                  <td className={cellAct}>
                    <div className="font-bold"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(c.crew) }} />{c.crew}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">{c.perHand != null ? `${r1(c.perHand)} plan h of work per hand a shift on average` : "too few hands entered to judge"}{c.pace ? ` · ${c.pace.mhPerPlanH} man-hours per plan hour (${c.pace.from === "plan" ? "staffing plan" : c.pace.from === "counted" ? "counts" : "hands per job"})` : ""}</div>
                    {say("low") && <div className="text-[11px] text-amber-800 dark:text-amber-300">More hands than work logged: {say("low")}</div>}
                    {say("high") && <div className="text-[11px] text-blue-700 dark:text-blue-300">Stretched: {say("high")}</div>}
                  </td>
                  <td /><td /><td /><td />
                  <td className="p-0 relative"><div className="relative h-11" style={{ width }}>
                    <Grid shifts={work.shifts} />
                    {keys.map((k, i) => { const b = c.byShift[k]; if (!b || !(b.counted || b.planned)) return null; const hands = b.planned?.direct ?? b.counted?.direct ?? b.counted?.total; const tone = b.verdict === "low" ? "bg-amber-100 border-amber-400 text-amber-900" : b.verdict === "high" ? "bg-blue-100 border-blue-300 text-blue-900" : "bg-emerald-100 border-emerald-300 text-emerald-900";
                      return <span key={k} title={`${b.planned ? `Planned ${b.planned.direct} on the tools + ${b.planned.indirect}` : ""}${b.counted ? `${b.planned ? "; " : ""}counted ${b.counted.total ?? b.counted.direct}` : ""}; ${b.earned} plan h of work moved`} className={`absolute top-1.5 h-8 rounded border text-center font-black text-[11px] leading-[13px] pt-0.5 ${tone}`} style={{ left: i * PX + 2, width: PX - 4 }}>{hands}<small className="block text-[8.5px] font-bold">{b.counted && b.planned ? `had ${b.counted.total ?? b.counted.direct}` : `${Math.round(b.earned)} h`}</small></span>; })}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-[var(--color-text-muted)]">A solid block is a shift where that crew logged progress (at the time you set, not when you typed it). Yellow: it sat in progress with nothing logged; the reason is the crew&apos;s own comments. Blue: everything before it was done, but its crew was elsewhere. Calendar time between start and finish is never counted as work.</p>
    </div>
  );
}

function progressBefore(moved: Record<string, number>, r: WaitRun, idx: Map<string, number>): number {
  const at = idx.get(r.from) ?? 0;
  return Object.entries(moved).filter(([k]) => (idx.get(k) ?? 0) < at).reduce((n, [, v]) => n + v, 0) / 100;
}

function shiftWords(k: string, work: AsBuiltWork, tz: string): string {
  const w = work.shifts.find((s) => shiftKey(s) === k);
  return w ? `${fmtInTz(w.start, tz, { weekday: "short", month: "numeric", day: "numeric" })} ${w.kind}` : k;
}

function Chip({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5">{children}</div>;
}

function SectionRow({ title, sub, width, shifts }: { title: string; sub: string; width: number; shifts: Array<{ kind: string }> }) {
  return (
    <tr className="bg-indigo-50 dark:bg-indigo-950/30">
      <td className={`${cellAct} !bg-indigo-50 dark:!bg-indigo-950/30`}><div className="font-black">{title}</div><div className="text-[11px] text-[var(--color-text-muted)]">{sub}</div></td>
      <td /><td /><td /><td />
      <td className="p-0"><div className="relative h-full min-h-[40px]" style={{ width }}><Grid shifts={shifts} /></div></td>
    </tr>
  );
}

/** A wait made into something planned next time: before the shutdown (a
 *  booking, materials), or a step in the job (the activity split around it). */
function PlanFor({ run, stepName, crews, doneBefore, onSave, onCancel }: { run: WaitRun; stepName: string; crews: string[]; doneBefore: number; onSave: (c: PlanChange) => void; onCancel: () => void }) {
  const reason = run.why[run.why.length - 1] ?? "";
  const guess = crews.find((c) => new RegExp(`\\b${c.split(/[\s(]/)[0].replace(/[^\w/]/g, "")}\\b`, "i").test(run.why.join(" "))) ?? "";
  const [where, setWhere] = useState<"pre" | "split">(doneBefore > 0.02 && doneBefore < 0.98 ? "split" : "pre");
  const [name, setName] = useState(reason.slice(0, 120));
  const [crew, setCrew] = useState(guess);
  const [hours, setHours] = useState(String(run.shifts * 12));
  const field = "rounded border border-slate-400 bg-[var(--color-surface)] px-1.5 py-1 text-[12px] text-[var(--color-text)]";
  const save = () => {
    const base = { id: `p${Date.now().toString(36)}`, said: `${stepName}: ${reason}`, at: Date.now() };
    if (where === "pre") onSave({ ...base, kind: "add", name: name.trim() || reason, crew, hours: 0, pre: true });
    else onSave({ ...base, kind: "split", actId: "", fraction: Math.min(0.95, Math.max(0.05, doneBefore || 0.5)), name: name.trim() || reason, crew, hours: Math.max(0, Number(hours) || 0) });
  };
  return (
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 space-y-1.5 text-[var(--color-text)] whitespace-normal">
      <div className="flex flex-wrap gap-1">
        {([["pre", "Before the shutdown"], ["split", "As a step in the job"]] as const).map(([k, l]) => <button key={k} type="button" onClick={() => setWhere(k)} className={`rounded-full border px-2 py-0.5 text-[11.5px] font-bold cursor-pointer ${where === k ? "bg-[var(--color-text)] text-[var(--color-surface)] border-[var(--color-text)]" : "border-slate-400"}`}>{l}</button>)}
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="What it is" className={`${field} w-full`} />
      {where === "split" && (
        <div className="flex flex-wrap gap-1.5 items-center text-[11.5px]">
          <select value={crew} onChange={(e) => setCrew(e.target.value)} aria-label="Crew" className={field}><option value="">Crew?</option>{crews.map((c) => <option key={c}>{c}</option>)}</select>
          <input value={hours} onChange={(e) => setHours(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" aria-label="Hours" className={`${field} w-16`} /> h (it waited {run.shifts * 12} h this year)
        </div>
      )}
      <div className="flex gap-1.5"><button type="button" onClick={save} className={btnPri}><Check className="w-3.5 h-3.5" /> Add to next time</button><button type="button" onClick={onCancel} className={btnQuiet}>Cancel</button></div>
    </div>
  );
}

// ── Suggested for next time ──────────────────────────────────────────────

function NextView(p: Props & { built: ReturnType<typeof buildAsBuilt>; work: AsBuiltWork; plan: NextPlan; colorOf: (c: string) => string; changes: PlanChange[]; settings: NextPlanSettings; onChanges: (c: PlanChange[]) => void; onStaffing: (s: NextPlanSettings["staffing"]) => void }) {
  const { tz, times, built, work, plan, changes } = p;
  const { x, width } = useAxis(plan);
  const dayOf = (t: number) => dayNumber(plan, t, tz);
  const dayLabel = (t: number) => `Day ${dayOf(t)}`;
  const at = (t: number) => `Day ${dayOf(t)} · ${fmtInTz(t, tz, { weekday: "short" })} ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;
  const orderName = useMemo(() => new Map(built.orders.map((o) => [o.key, o.name])), [built]);
  const actName = useMemo(() => new Map(plan.acts.map((a) => [a.id, a.name])), [plan]);
  const driving = useMemo(() => new Set(plan.driving), [plan]);
  const crewWork = useMemo(() => new Map(work.crews.map((c) => [c.crew, c])), [work]);

  // Tell the schedule.
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ understood: string; changes: PlanChange[]; question: string | null; finish: number | null; lever: { change: PlanChange; finish: number; savedH: number; acts: number; hours: number } | null; err?: string } | null>(null);
  const send = async () => {
    const said = text.trim(); if (!said || !p.orgId) return;
    setBusy(true); setAnswer(null);
    try {
      const catalog = talkCatalog(plan, built.orders.map((o) => ({ key: o.key, name: o.name, wo: o.wo })), dayOf);
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/projects/next-plan", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` }, body: JSON.stringify({ orgId: p.orgId, projectId: p.projectId, text: said, catalog }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const shiftsOfDay = (day: number, kind: "day" | "night") => Math.max(0, (day - 1) * 2 + (kind === "night" ? 1 : 0) - (plan.shifts[0]?.kind === "night" ? 1 : 0));
      const r = parseTalkReply(json, { orders: new Set(built.orders.map((o) => o.key)), acts: new Set(plan.acts.map((a) => a.id)), crews: new Set(Object.keys(plan.load)) }, said, shiftsOfDay);
      const input = { built, work, milestones: p.milestones, tz, times };
      const after = r.changes.length ? nextPlan({ ...input, changes: [...changes, ...r.changes] }) : null;
      const wantsSooner = /critical|asap|as soon|sooner|faster|finish|pull in|speed/i.test(said);
      const lever = wantsSooner && (!after || after.finish >= plan.finish - 30 * 60_000) ? finishLever({ ...input, changes: [...changes, ...r.changes] }, after ?? plan) : null;
      setAnswer({ ...r, finish: after?.finish ?? null, lever: lever ? { ...lever, change: { ...lever.change, id: `l${Date.now().toString(36)}`, said } } : null });
    } catch (e) { setAnswer({ understood: "", changes: [], question: null, finish: null, lever: null, err: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const keep = (list: PlanChange[]) => { p.onChanges([...changes, ...list]); setAnswer(null); setText(""); };

  const finishWords = (f: number) => { const d = (plan.finish - f) / 3_600_000; return Math.abs(d) < 0.5 ? "no change to the finish" : `${r1(Math.abs(d))} h ${d > 0 ? "sooner" : "later"}`; };
  const drivingOrders = [...new Set(plan.driving.map((id) => plan.acts.find((a) => a.id === id)?.order).filter(Boolean) as string[])].map((o) => orderName.get(o) ?? o);

  // Hands typed in: one change per crew and shift (the last one wins).
  const setHeads = (crew: string, shift: number, v: string) => {
    const rest = changes.filter((c) => !(c.kind === "heads" && c.crew === crew && c.shift === shift));
    if (v.trim() === "") { p.onChanges(rest); return; }
    const n = Math.max(0, Math.round(Number(v)));
    if (!Number.isFinite(n)) return;
    p.onChanges([...rest, { id: `h${Date.now().toString(36)}${shift}`, said: `${crew} hands`, at: Date.now(), kind: "heads", crew, shift, n }]);
  };

  // Staffing plan read in.
  const [company, setCompany] = useState("");
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const companies = [...new Set(work.crews.map((c) => c.company))].sort();
  const readPlan = async (f: File) => {
    setPlanMsg(null);
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: true });
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
      const g = parseStaffingGrid(rows as unknown[][]);
      if (!g) { setPlanMsg("That doesn't look like a staffing plan: crafts down the side, dates across the top, a Day and a Night column under each date."); return; }
      const co = company || companies.find((c) => !/kern|\(KE\)/i.test(c)) || "Contractor";
      const plan1 = { file: f.name, at: new Date().toISOString(), by: p.userName ?? null, shifts: g.shifts, phases: g.phases };
      await saveStaffingPlan(p.projectId, co, plan1);
      p.onStaffing({ ...p.settings.staffing, [co]: plan1 });
      setPlanMsg(`Read for ${co}: ${g.crafts.length} crafts, ${g.from} to ${g.to}${g.phases.length ? ` (${g.phases.map((x) => x.name).join(", ")})` : ""}.`);
    } catch (e) { setPlanMsg((e as Error).message); }
  };

  // This year's hands for the same shift: a staffing plan, else the count.
  const thisYear = (crew: string, i: number): { n: number; word: string } | null => {
    const s = work.shifts[i]; const cw = crewWork.get(crew);
    if (!s || !cw) return null;
    const b = cw.byShift[shiftKey(s)];
    if (b?.planned) return { n: b.planned.direct, word: "plan" };
    const counted = b?.counted?.direct ?? b?.counted?.total;
    return counted != null ? { n: counted, word: "had" } : null;
  };

  const byOrder = new Map<string, NextPlan["acts"]>();
  for (const a of plan.acts) { if (!byOrder.has(a.order)) byOrder.set(a.order, []); byOrder.get(a.order)!.push(a); }
  const orders = [...byOrder.entries()].sort((a, b) => Math.min(...a[1].map((x) => x.start)) - Math.min(...b[1].map((x) => x.start)));
  const kinds = plan.acts.reduce((m, a) => { m[a.kind] = (m[a.kind] ?? 0) + 1; return m; }, {} as Record<string, number>);
  const planFin = built.planFinish;
  const lines = <>{planFin != null && <i aria-hidden title="This year's planned finish" className="absolute top-0 bottom-0 border-l-2 border-red-600" style={{ left: x(planFin) }} />}<i aria-hidden title="Suggested finish" className="absolute top-0 bottom-0 border-l-2 border-dashed border-blue-600" style={{ left: x(plan.finish) }} /></>;
  const KIND: Record<string, [string, string]> = { new: ["New", "bg-emerald-100 text-emerald-900"], found: ["Found this year", "bg-orange-100 text-orange-900"], shorter: ["Shorter", "bg-blue-100 text-blue-900"], split: ["Split", "bg-violet-100 text-violet-900"], changed: ["Changed", "bg-violet-100 text-violet-900"] };
  const headsList = changes.filter((c) => c.kind === "heads");

  return (
    <div className="space-y-2">
      {p.canEdit && (
        <div className="rounded-xl border border-indigo-200 dark:border-indigo-800 bg-[var(--color-surface)] p-3 space-y-2">
          <div className="font-black text-[13px]">Tell the schedule</div>
          <div className="flex gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }} placeholder='"V-7 is critical path, start it as soon as possible", "Ancon has 2 crews on nights", "PSV-021 needs 6 hours"'
              aria-label="Tell the schedule" className="flex-1 min-w-0 rounded-lg border border-slate-400 bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-text)]" />
            <button type="button" onClick={() => void send()} disabled={busy || !text.trim() || !p.orgId} className={btnPri}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send</button>
          </div>
          {answer && (
            <div className="rounded-lg bg-indigo-50 dark:bg-indigo-950/30 px-3 py-2 text-[12.5px] space-y-1.5">
              {answer.err && <p className="text-rose-700 dark:text-rose-300">{answer.err}</p>}
              {answer.question && <p><b>{answer.question}</b></p>}
              {answer.understood && <p>{answer.understood}</p>}
              {answer.changes.length > 0 && <ul className="list-disc pl-5">{answer.changes.filter((c) => c.kind !== "heads").map((c) => <li key={c.id}>{describe(c, orderName, actName, dayOf)}</li>)}{answer.changes.some((c) => c.kind === "heads") && <li>Hands set on {answer.changes.filter((c) => c.kind === "heads").length} shifts</li>}</ul>}
              {answer.finish != null && <p>Finish: <b>{at(plan.finish)}</b> to <b>{at(answer.finish)}</b>, {finishWords(answer.finish)}.</p>}
              {answer.lever && (
                <p><b>{answer.finish != null && answer.finish < plan.finish - 30 * 60_000 ? "Also" : "What pulls the finish in"}:</b> {answer.lever.change.kind === "nights" ? `run ${answer.lever.acts} day-shift activities on the finish path (${drivingOrders.slice(0, 3).join(", ")}) on nights too, ${answer.lever.hours} h of work` : `let ${orderName.get((answer.lever.change as { target: { order?: string } }).target.order ?? "") ?? "it"} start as soon as its links allow`}. Finish {at(answer.lever.finish)}, {answer.lever.savedH} h sooner.</p>
              )}
              {!answer.changes.length && !answer.lever && !answer.err && !answer.question && <p>Nothing to change for that. The finish is set by {drivingOrders.slice(0, 3).join(", ")}.</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                {answer.lever && <button type="button" onClick={() => keep([...answer.changes, answer.lever!.change])} className={btnPri}><Check className="w-4 h-4" /> {answer.changes.length ? "Do both" : "Do it"}</button>}
                {answer.changes.length > 0 && <button type="button" onClick={() => keep(answer.changes)} className={answer.lever ? btnQuiet : btnPri}><Check className="w-4 h-4" /> {answer.lever ? "Only what I said" : "Do it"}</button>}
                <button type="button" onClick={() => setAnswer(null)} className={btnQuiet}><X className="w-4 h-4" /> No</button>
              </div>
            </div>
          )}
          {!p.orgId && <p className="text-[11.5px] text-[var(--color-text-muted)]">Needs the project&apos;s workspace to talk to the schedule.</p>}
        </div>
      )}

      {(changes.length > 0) && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="font-bold text-[12.5px] mb-1">Changes made ({changes.length})</div>
          <ul className="space-y-1 text-[12.5px]">
            {changes.filter((c) => c.kind !== "heads").map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                <span className="flex-1">{describe(c, orderName, actName, dayOf)}{c.said ? <span className="text-[var(--color-text-muted)]"> · from &quot;{c.said.slice(0, 120)}&quot;</span> : null}</span>
                {p.canEdit && <button type="button" onClick={() => p.onChanges(changes.filter((x) => x.id !== c.id))} className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text-muted)] hover:text-rose-700 cursor-pointer"><Undo2 className="w-3.5 h-3.5" /> Undo</button>}
              </li>
            ))}
            {[...new Set(headsList.map((c) => (c as { crew: string }).crew))].map((crew) => (
              <li key={`h${crew}`} className="flex items-start gap-2">
                <span className="flex-1">{crew}: hands set on {headsList.filter((c) => (c as { crew: string }).crew === crew).length} shifts</span>
                {p.canEdit && <button type="button" onClick={() => p.onChanges(changes.filter((x) => !(x.kind === "heads" && x.crew === crew)))} className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text-muted)] hover:text-rose-700 cursor-pointer"><Undo2 className="w-3.5 h-3.5" /> Undo</button>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-[12.5px] space-y-1.5">
        <div className="font-bold">Staffing plans</div>
        {Object.entries(p.settings.staffing).map(([co, sp]) => {
          const s = summaryOver(sp, work.shifts.map(shiftKey));
          return <div key={co}><b>{co}</b> ({sp.file}): days <b>{s.day.direct} on the tools</b> + {s.day.indirect}, nights <b>{s.night.direct}</b> + {s.night.indirect}, over these dates. {p.canEdit && <button type="button" onClick={() => void saveStaffingPlan(p.projectId, co, null).then(() => { const n = { ...p.settings.staffing }; delete n[co]; p.onStaffing(n); })} className="underline font-bold text-[var(--color-text-muted)] cursor-pointer">Remove</button>}</div>;
        })}
        {!Object.keys(p.settings.staffing).length && <div className="text-[var(--color-text-muted)]">None read yet. A contractor&apos;s staffing plan gives each shift its planned hands, by date, so each phase lines up with its own days.</div>}
        {p.canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company" className="rounded border border-slate-400 bg-[var(--color-surface)] px-2 py-1 text-[12.5px]"><option value="">Company?</option>{companies.map((c) => <option key={c}>{c}</option>)}</select>
            <label className={`${btnQuiet} !py-1`}><Upload className="w-4 h-4" /> Read a staffing plan<input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void readPlan(f); }} /></label>
          </div>
        )}
        {planMsg && <div role="status" className="text-[12px]">{planMsg}</div>}
      </div>

      <div className="flex flex-wrap gap-2 text-[12.5px]">
        <Chip>Suggested finish <b>{at(plan.finish)}</b></Chip>
        {built.planFinish != null && <Chip>This year: planned <b>{at(built.planFinish)}</b>{built.finish != null && <>, actual <b>{at(built.finish)}</b></>}</Chip>}
        <Chip><b>{plan.acts.length + plan.pre.length}</b> activities{Object.entries(kinds).filter(([k]) => k !== "same").map(([k, n]) => ` · ${n} ${(KIND[k]?.[0] ?? k).toLowerCase()}`).join("")}{plan.pre.length ? ` · ${plan.pre.length} before the shutdown` : ""}</Chip>
        <Chip><CalendarClock className="w-3.5 h-3.5 inline mr-1" />Sets the finish: {drivingOrders.slice(0, 3).join(", ")}</Chip>
      </div>
      <Legend items={[[{ background: "#2563eb" }, "Crew's work"], [{ background: "#fff", boxShadow: "0 0 0 1.5px #ea580c" }, "Not in this year's plan"], [{ background: "#fee2e2", borderLeft: "3px solid #dc2626" }, "Sets the finish"], [{ borderLeft: "2px solid #dc2626", width: 2 }, "This year's planned finish"], [{ borderLeft: "2px dashed #2563eb", width: 2 }, "Suggested finish"]]} />

      <div className="overflow-auto max-h-[75vh] rounded-xl border border-[var(--color-border)]">
        <table className="border-separate border-spacing-0 w-max text-[12px]">
          <thead className="sticky top-0 z-[4] bg-[var(--color-surface-2)]">
            <tr className="text-[11px] text-[var(--color-text-muted)] text-left">
              <th className={`${cellAct} !bg-[var(--color-surface-2)] z-[5]`}>Activity</th>
              <th className="px-1 font-semibold text-center">Hours</th><th className="px-2 font-semibold">Start</th><th className="px-2 font-semibold">Finish</th>
              <th className="p-0"><Header shifts={plan.shifts} tz={tz} dayLabel={dayLabel} /></th>
            </tr>
          </thead>
          <tbody>
            {plan.pre.length > 0 && <SectionRow4 title="Before the shutdown" sub="bookings and materials" width={width} shifts={plan.shifts} />}
            {plan.pre.map((a) => (
              <tr key={a.id}><td className={cellAct}><div className="font-bold">{a.name} <span className="rounded bg-emerald-100 px-1 text-[10px] font-black text-emerald-900">New</span></div>{a.basis && <div className="text-[11px] text-[var(--color-text-muted)]">{a.basis}</div>}</td><td className={cellN}>-</td><td className={cellDt}>Before Day 1</td><td className={cellDt} /><td className="p-0"><div className="relative h-10" style={{ width }}><Grid shifts={plan.shifts} /><span className="absolute left-1.5 top-2.5 rounded bg-emerald-100 px-1.5 text-[10.5px] font-bold text-emerald-900">before the shutdown</span></div></td></tr>
            ))}
            {orders.map(([key, acts]) => {
              const s0 = Math.min(...acts.map((a) => a.start)), s1 = Math.max(...acts.map((a) => a.finish));
              const crit = acts.some((a) => driving.has(a.id));
              const changed = acts.filter((a) => a.kind !== "same" || a.changedBy?.length).length;
              return (
                <React.Fragment key={key}>
                  <tr className="bg-[var(--color-surface-2)]">
                    <td className={`${cellAct} !bg-[var(--color-surface-2)]`}>
                      <div className="font-black text-[12.5px]">{orderName.get(key) ?? key}{crit && <span className="ml-1 rounded bg-rose-100 px-1 text-[10px] font-black text-rose-900">Sets the finish</span>}</div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">{acts.length} activit{acts.length === 1 ? "y" : "ies"}{changed ? ` · ${changed} changed` : ""}</div>
                    </td>
                    <td className={cellN}>{r1(acts.reduce((n, a) => n + a.hours, 0))}</td><td className={cellDt}>{at(s0)}</td><td className={cellDt}>{at(s1)}</td>
                    <td className="p-0"><div className="relative h-11" style={{ width }}><Grid shifts={plan.shifts} /><i className="absolute top-4 h-2.5 rounded-sm bg-slate-700" style={{ left: x(s0), width: Math.max(3, x(s1) - x(s0)) }} />{lines}</div></td>
                  </tr>
                  {[...acts].sort((a, b) => a.start - b.start).map((a) => {
                    const k = KIND[a.kind];
                    const isCrit = driving.has(a.id);
                    return (
                      <tr key={a.id} className={isCrit ? "[&>td:first-child]:shadow-[inset_3px_0_0_#dc2626]" : ""}>
                        <td className={`${cellAct} ${isCrit ? "!bg-rose-50 dark:!bg-rose-950/20" : ""}`}>
                          <div className="font-bold">{a.name}{k && <span className={`ml-1 rounded px-1 text-[10px] font-black ${k[1]}`}>{k[0]}</span>}{a.heldForCrew && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-black text-amber-900">Waits for hands</span>}</div>
                          <div className="text-[11px] text-[var(--color-text-muted)]"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(a.crew) }} />{a.crew} · {a.cal === "both" ? "days and nights" : a.cal === "night" ? "nights" : "days"}</div>
                          {a.basis && a.kind !== "found" && <div className="text-[11px] text-blue-800 dark:text-blue-300">{a.basis}</div>}
                          {a.waitedForCrew && <div className="text-[11px] text-blue-700 dark:text-blue-300">This year it waited {a.waitedForCrew.shifts} shift{a.waitedForCrew.shifts === 1 ? "" : "s"} for {a.waitedForCrew.crew}{a.waitedForCrew.busyOn.length ? ` (on ${[...new Set(a.waitedForCrew.busyOn.map((b) => b.split(" - ")[0]))].join(", ")})` : ""}. Check {a.waitedForCrew.crew}&apos;s hands below.</div>}
                        </td>
                        <td className={cellN}>{r1(a.hours)}</td><td className={cellDt}>{at(a.start)}</td><td className={cellDt}>{at(a.finish)}</td>
                        <td className="p-0"><div className="relative h-11" style={{ width }}><Grid shifts={plan.shifts} />
                          <i title={`${a.name}: ${r1(a.hours)} h`} className="absolute top-3 h-4 rounded-sm" style={{ left: x(a.start), width: Math.max(3, x(a.finish) - x(a.start)), background: p.colorOf(a.crew), boxShadow: a.kind === "new" || a.kind === "found" ? "0 0 0 2px #fff, 0 0 0 3.5px #ea580c" : undefined }} />{lines}</div></td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
            <SectionRow4 title="Hands on the tools" sub={`suggested for each crew, day and night${p.canEdit ? "; type a number to set it, and the schedule follows" : ""}. Red: more than this year (its staffing plan, or what was counted).`} width={width} shifts={plan.shifts} />
            {Object.keys(plan.load).sort((a, b) => plan.load[b].reduce((n, h) => n + h, 0) - plan.load[a].reduce((n, h) => n + h, 0)).map((crew) => {
              const pace = plan.pace[crew];
              return (
                <tr key={`hd${crew}`}>
                  <td className={cellAct}><div className="font-bold"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(crew) }} />{crew}</div><div className="text-[11px] text-[var(--color-text-muted)]">{pace ? `${pace.mh} man-hours for each plan hour: ${pace.from}` : "not counted this year: 1 per job going; set it"}</div></td>
                  <td className={cellN}>{Math.max(0, ...plan.heads[crew].map((h, i) => plan.headsSet[crew][i] ?? h))}<div className="text-[10px] font-normal text-[var(--color-text-muted)]">most</div></td><td /><td />
                  <td className="p-0"><div className="relative h-12" style={{ width }}><Grid shifts={plan.shifts} />
                    {plan.shifts.map((_, i) => {
                      const sug = plan.heads[crew][i] ?? 0, set = plan.headsSet[crew][i];
                      const ty = thisYear(crew, i);
                      if (!sug && set == null && !ty) return null;
                      const v = set ?? sug;
                      const over = ty != null && v > ty.n;
                      return (
                        <span key={i} className="absolute top-1" style={{ left: i * PX + 2, width: PX - 4 }}>
                          <input key={`${set ?? sug}`} defaultValue={String(v)} disabled={!p.canEdit} inputMode="numeric" aria-label={`${crew} hands, ${dayLabel(plan.shifts[i].start)} ${plan.shifts[i].kind}`}
                            onBlur={(e) => { if (e.target.value !== String(v)) setHeads(crew, i, e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            className={`w-full h-5 rounded border text-center text-[11px] font-black p-0 ${set != null ? "border-[var(--color-accent)] bg-orange-50 dark:bg-orange-950/30" : over ? "border-red-500 text-red-700 bg-red-50 dark:bg-red-950/30" : "border-slate-400 bg-[var(--color-surface)]"} text-[var(--color-text)]`} />
                          {ty && <span className="block text-center text-[8.5px] text-[var(--color-text-muted)] leading-tight">{ty.word} {ty.n}</span>}
                        </span>
                      );
                    })}
                  </div></td>
                </tr>
              );
            })}
            <SectionRow4 title="Crew load" sub="hours of its work scheduled each shift. Red outline: more jobs going at once than that crew ever moved in a shift this year." width={width} shifts={plan.shifts} />
            {Object.entries(plan.load).map(([crew, l]) => {
              const most = crewWork.get(crew)?.mostMoved ?? 1;
              return (
                <tr key={`ld${crew}`}>
                  <td className={cellAct}><div className="font-bold"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(crew) }} />{crew}</div><div className="text-[11px] text-[var(--color-text-muted)]">{Math.round(l.reduce((n, h) => n + h, 0))} h scheduled · this year at most {most} job{most === 1 ? "" : "s"} moving in a shift</div></td>
                  <td className={cellN}>{Math.round(l.reduce((n, h) => n + h, 0))}</td><td /><td />
                  <td className="p-0"><div className="relative h-10" style={{ width }}><Grid shifts={plan.shifts} />
                    {l.map((h, i) => h > 0.05 && <span key={i} title={`${Math.round(h)} h of work, ${plan.jobs[crew][i]} going`} className="absolute top-2 h-6 rounded text-white text-center text-[11px] font-black leading-6" style={{ left: i * PX + 2, width: PX - 4, background: p.colorOf(crew), opacity: 0.45 + 0.55 * Math.min(1, h / 36), outline: plan.jobs[crew][i] > most ? "2px solid #dc2626" : undefined, outlineOffset: 1 }}>{Math.round(h)}</span>)}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[12px] text-[var(--color-text)]">
        <b>How it&apos;s built.</b> This year&apos;s activities, links, crews, day or night calendars, and planned start dates as the earliest each can start. Work found this year is in from the start, in the order and on the shifts it was really done. An activity done inside fewer shifts than its plan gets that length; nothing is made longer from a guess. Start-up begins once every work order is done. A crew&apos;s hands, when set, limit how much of its work runs at once; the rest waits, the most urgent first. Waits you plan for (from the As-built view) go in as steps or before the shutdown.
      </div>
    </div>
  );
}

function SectionRow4({ title, sub, width, shifts }: { title: string; sub: string; width: number; shifts: Array<{ kind: string }> }) {
  return (
    <tr className="bg-indigo-50 dark:bg-indigo-950/30">
      <td className={`${cellAct} !bg-indigo-50 dark:!bg-indigo-950/30`}><div className="font-black">{title}</div><div className="text-[11px] text-[var(--color-text-muted)]">{sub}</div></td>
      <td /><td /><td />
      <td className="p-0"><div className="relative h-full min-h-[40px]" style={{ width }}><Grid shifts={shifts} /></div></td>
    </tr>
  );
}

/** A change, in words. */
function describe(c: PlanChange, orders: Map<string, string>, acts: Map<string, string>, dayOf: (t: number) => number): string {
  void dayOf;
  const tgt = (t: { order?: string; ids?: string[] }) => (t.order ? orders.get(t.order) ?? "a work order" : t.ids?.length === 1 ? acts.get(t.ids[0]) ?? "an activity" : `${t.ids?.length ?? 0} activities`);
  switch (c.kind) {
    case "nights": return c.on ? `Nights too: ${tgt(c.target)}` : `Days only: ${tgt(c.target)}`;
    case "asap": return `As soon as its links allow: ${tgt(c.target)}`;
    case "first": return `Goes first when its crew is short: ${tgt(c.target)}`;
    case "hold": return `Not before Day ${c.day}: ${tgt(c.target)}`;
    case "drop": return `Not needed next time: ${tgt(c.target)}`;
    case "hours": return `${acts.get(c.actId) ?? "An activity"}: ${c.hours} h`;
    case "add": return c.pre ? `Before the shutdown: ${c.name}` : `New: ${c.name}${c.crew ? ` (${c.crew}` : ""}${c.crew ? `, ${c.hours} h)` : `, ${c.hours} h`}`;
    case "split": return `${acts.get(c.actId) ?? acts.get(`${c.actId}:1`)?.replace(/ \(1 of 2\)$/, "") ?? "An activity"} split around: ${c.name}${c.crew ? ` (${c.crew}, ${c.hours} h)` : ""}`;
    case "heads": return `${c.crew}: ${c.n} hands`;
  }
}

/** A plan's most hands on any day shift and any night shift of this job. */
function summaryOver(plan: StaffingPlan, keys: string[]): { day: { direct: number; indirect: number }; night: { direct: number; indirect: number } } {
  const day = { direct: 0, indirect: 0 }, night = { direct: 0, indirect: 0 };
  for (const k of keys) {
    const v = plan.shifts[k]; if (!v) continue;
    const t = k.endsWith(":night") ? night : day;
    if (v.direct + v.indirect > t.direct + t.indirect) { t.direct = v.direct; t.indirect = v.indirect; }
  }
  return { day, night };
}

