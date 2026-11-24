"use client";

// AsBuiltScheduleView - the job as it was really worked (As-built), and the
// schedule suggested for next time made from it (Suggested), side by side
// behind one toggle. As-built opens on each work order against its own
// plan, most late first, phase by phase (how late, the shifts it waited);
// opened, a work order shows each activity's shifts with progress in its
// crew's color, the shifts it sat (and why, in the crew's own comments) and
// the shifts it was ready but its crew was elsewhere (and where). Shift by
// shift is the whole job on one grid, with the crews and their hands
// against the work. Suggested: this year's job with the found work in, the
// waits planned for, a person's changes ("Tell the schedule", hands typed
// in), the crew load and the hands it needs. lib/asBuiltWork, lib/nextPlan.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Send, Undo2, Check, X, Download, Printer, CalendarClock, ChevronRight, ChevronsDownUp, ChevronsUpDown, Maximize2, Minimize2, CalendarDays } from "lucide-react";
import type { Milestone, MilestoneNote } from "@/types/schema";
import type { CancelledJob } from "@/lib/cancelledJobs";
import { phaseIndex, type ProjectPhase } from "@/lib/projectPhases";
import type { ShiftTimes } from "@/lib/shiftReport";
import type { ShiftRecord } from "@/lib/shiftRecord";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { buildAsBuilt, laneSteps, stepBar, BUILT_WORD, lateOf, answerOf, phaseBlocks, mostLateFirst, type BuiltStep, type PhaseBlock } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork, shiftKey, type AsBuiltWork, type WaitRun } from "@/lib/asBuiltWork";
import { nextPlan, finishLever, dayNumber, shiftParts, rampWarning, CREW_RULE, type NextPlan, type PlanChange, type CrewSize } from "@/lib/nextPlan";
import { checkPlan, planRisks, CHECK_H, type PlanCheck, type PlanRisk } from "@/lib/nextPlanCheck";
import { replayAsBuilt, oneOffDelays, CAPACITY_RULE, type Replay, type ReplayInput, type OneOffDelay } from "@/lib/asBuiltReplay";
import { loadNextPlanSettings, saveNextPlanChanges, type NextPlanSettings } from "@/lib/nextPlanStore";
import { planLessons, lessonChanges, lessonEffects, toTarget, type Lesson } from "@/lib/nextPlanLessons";
import { msProjectXml, asBuiltTasks, suggestedTasks } from "@/lib/msProject";
import { saveFile } from "@/lib/saveFile";
import { openContractor } from "@/lib/costsNav";
import type { StaffingPlan } from "@/lib/staffingPlan";
import { talkCatalog, parseTalkReply } from "@/lib/nextPlanTalk";
import { loadProgressLog } from "@/lib/progressHistory";
import { notesFor } from "@/lib/milestones";
import { loadShiftRecords } from "@/lib/shiftRecord";
import { loadManpowerSettings, companyOf as companyOfCrew, type ManpowerSettings } from "@/lib/manpower";
import { fmtInTz, startOfDay, addDays } from "@/lib/scheduleTz";
import { hoursDays } from "@/lib/phaseReport";
import { supabase } from "@/lib/supabase";
import { useDraft } from "@/hooks/useDraft";
import { sayError } from "@/components/projects/sayError";
import { SubTabs } from "@/components/projects/SubTabs";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import HelpTooltip from "@/components/ui/HelpTooltip";

/** Width of one shift on the chart: fitted to the space it has (see the
 *  view), between 14 and 56 px. */
const PxCtx = React.createContext(34);
const PALETTE = ["var(--color-main)", "color-mix(in srgb, var(--color-text) 72%, var(--color-surface))", "color-mix(in srgb, var(--color-text) 60%, var(--color-surface))"];
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
  /** For file names: the project, and the phase or "All phases". */
  projectName?: string;
  scopeName?: string;
  /** Show the dates and counts columns (set by the view's toolbar). */
  cols?: boolean;
}

export default function AsBuiltScheduleView(p: Props) {
  const { tz, times } = p;
  const [view, setView] = useState<"built" | "next">("built");
  const [data, setData] = useState<{ log: ProgressLogRow[]; notes: MilestoneNote[]; records: Map<string, ShiftRecord>; mp: ManpowerSettings; settings: NextPlanSettings } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [cols, setCols] = useState(false);
  // As-built: each work order against its own plan, or the shift-by-shift grid.
  const [mode, setMode] = useState<"orders" | "shifts">("orders");
  const [full, setFull] = useState(false);
  // The view's own box (shown once the job is read): its width sets the chart's.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setBoxW(Math.round(e.contentRect.width)));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  useEffect(() => {
    if (!full) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [full]);

  const built = useMemo(() => buildAsBuilt({ milestones: p.milestones, childrenByParent: p.childrenByParent, cancelled: p.cancelled, phases: p.phases, tz }), [p.milestones, p.childrenByParent, p.cancelled, p.phases, tz]);
  const stepIds = useMemo(() => built.orders.flatMap((o) => o.steps.map((s) => s.id)), [built]);
  const idsKey = stepIds.join(",");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        let recordsFailed = false;
        const [log, notes, records, mp, settings] = await Promise.all([
          loadProgressLog(p.projectId), notesFor(stepIds), loadShiftRecords(p.projectId).catch(() => { recordsFailed = true; return new Map<string, ShiftRecord>(); }),
          loadManpowerSettings(p.projectId), loadNextPlanSettings(p.projectId),
        ]);
        if (live) setData({ log: log ?? [], notes, records, mp, settings });
        // Said, not hidden: without the shift records there are no head counts.
        if (live && recordsFailed) setMsg("Couldn't read the shift records: head counts are missing.");
      } catch (e) { if (live) setErr(sayError(e)); }
    })();
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the step list, by its ids
  }, [p.projectId, idsKey]);

  const work = useMemo(() => (data ? buildAsBuiltWork({ built, milestones: p.milestones, log: data.log, notes: data.notes, records: data.records, plans: data.settings.staffing, companyOf: (c) => companyOfCrew(c, data.mp), tz, times, now: Date.now() }) : null), [data, built, p.milestones, tz, times]);
  const scope = p.phase ?? "all";
  const changes = useMemo(() => data?.settings.changes[scope] ?? [], [data, scope]);
  // What this job taught (lib/nextPlanLessons), put in unless a person left it out.
  const base = useMemo(() => (work ? nextPlan({ built, work, milestones: p.milestones, tz, times, changes: [] }) : null), [work, built, p.milestones, tz, times]);
  const lessons = useMemo(() => (work && base && data ? planLessons({ built, work, milestones: p.milestones, tz, times, notes: data.notes, base, now: Date.now() }) : []), [work, base, data, built, p.milestones, tz, times]);
  const skipped = useMemo(() => new Set(changes.flatMap((c) => (c.kind === "skip" ? [c.lesson] : []))), [changes]);
  // Hands shift by shift aren't planned (a crew's size is held the whole
  // job): a count saved for one shift is left out. A crew's size a person
  // typed in, held the whole job, is kept.
  const applied = useMemo(() => [...lessonChanges(lessons, skipped), ...changes.filter((c) => c.kind !== "skip" && c.kind !== "heads")], [lessons, skipped, changes]);
  const plan = useMemo(() => (work ? nextPlan({ built, work, milestones: p.milestones, tz, times, changes: applied }) : null), [work, built, p.milestones, tz, times, applied]);
  // Whether to trust it: this year replayed through the same rules.
  const check = useMemo(() => (work ? checkPlan({ built, work, milestones: p.milestones, tz, times }) : null), [work, built, p.milestones, tz, times]);
  // What could still move it: found work, jobs that ran long.
  const risks = useMemo(() => (work && plan ? planRisks({ built, work, milestones: p.milestones, tz, times, changes: applied }, plan, { max: 12 }) : []), [work, plan, built, p.milestones, tz, times, applied]);

  const crews = useMemo(() => {
    const names = [...new Set([...(work?.crews.map((c) => c.crew) ?? []), ...Object.keys(plan?.load ?? {})])];
    return new Map(names.map((n, i) => [n, PALETTE[i % PALETTE.length]]));
  }, [work, plan]);
  const colorOf = (c: string) => crews.get(c) ?? "var(--viz-neutral)";

  const saveChanges = useCallback(async (next: PlanChange[]) => {
    if (!data) return;
    const before = data;
    setData({ ...data, settings: { ...data.settings, changes: { ...data.settings.changes, [scope]: next } } });
    // Not saved: put the plan back as it was, and say so.
    try { await saveNextPlanChanges(p.projectId, scope, next); setMsg(null); } catch (e) { setData(before); setMsg(`Not saved: ${sayError(e)}`); }
  }, [data, scope, p.projectId]);

  // The schedule on screen as a Microsoft Project file.
  const toProject = async () => {
    if (!work || !plan) return;
    const what = view === "built" ? "as-built schedule" : "suggested schedule";
    const title = [p.projectName || "Project", what, p.scopeName].filter(Boolean).join(", ");
    const orderName = (k: string) => { const o = built.orders.find((x) => x.key === k); return o ? `${o.wo ? `WO ${o.wo} · ` : ""}${o.name}` : k; };
    const tasks = view === "built"
      ? asBuiltTasks(built, new Map(p.milestones.filter((m) => m.id).map((m) => [m.id!, m.dependsOn ?? []])), Date.now())
      : suggestedTasks(plan, orderName);
    if (!tasks.length) { setMsg("Nothing to export."); return; }
    const xml = msProjectXml({ title, tz, times, tasks });
    const ok = await saveFile(new TextEncoder().encode(xml), `${title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim()}.xml`, "application/xml");
    setMsg(ok ? null : "Tap Microsoft Project again to save the file.");
  };

  // One shift's width: the whole job across the space the chart has.
  const nShifts = view === "built" ? work?.shifts.length ?? 0 : plan?.shifts.length ?? 0;
  const left = boxW >= 640 ? 290 : 170;
  const px = nShifts && boxW ? Math.max(14, Math.min(56, Math.floor((boxW - left - (cols ? 350 : 0) - 6) / nShifts))) : 34;

  if (err) return <ErrorNote title="Couldn't read the job." next={err} />;
  if (!data || !work || !plan || !check) return <SkeletonRows rows={8} cols={3} what="the job, shift by shift" sheet={false} />;
  if (!built.orders.length) return <p className="py-6 text-reading text-[var(--color-text-muted)]">No schedule here yet. Import it on Plan.</p>;

  return (
    <PxCtx.Provider value={px}>
    <div ref={setBox} className={full ? "fixed inset-0 z-[300] overflow-auto bg-[var(--color-canvas)] p-3 sm:p-5 space-y-3" : "space-y-3 min-w-0"}>
      <div className="flex flex-wrap items-center gap-2">
        <SubTabs label="Schedule" value={view} onChange={(k) => setView(k)} className="mr-2"
          items={[{ id: "built" as const, label: "As-built" }, { id: "next" as const, label: "Suggested for next time" }]} />
        <button type="button" onClick={() => setFull(!full)} className={btnQuiet}>{full ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />} {full ? "Close full screen" : "Full screen"}</button>
        {(view === "next" || mode === "shifts") && <button type="button" aria-pressed={cols} onClick={() => setCols(!cols)} className={btnQuiet}><CalendarDays className="w-4 h-4" /> {cols ? "Hide dates" : "Show dates"}</button>}
        {p.onExcel && view === "built" && <button type="button" onClick={p.onExcel} className={btnQuiet}><Download className="w-4 h-4" /> Excel</button>}
        <button type="button" onClick={() => void toProject()} className={btnQuiet} title="A file Microsoft Project opens: File, Open, XML Format"><Download className="w-4 h-4" /> Microsoft Project</button>
        {p.onPrint && <button type="button" onClick={p.onPrint} className={btnQuiet}><Printer className="w-4 h-4" /> Print</button>}
        {msg && <ErrorNote compact title={msg} next="" />}
      </div>
      {view === "built"
        ? <BuiltView {...p} cols={cols} built={built} work={work} colorOf={colorOf} changes={changes} onAdd={(c) => void saveChanges([...changes, c])} mode={mode} onMode={setMode} boxW={boxW} />
        : <NextView {...p} cols={cols} built={built} work={work} notes={data.notes} plan={plan} colorOf={colorOf} changes={changes} applied={applied} check={check} risks={risks} lessons={lessons} skipped={skipped} settings={data.settings} onChanges={(n) => void saveChanges(n)}
            onStaffing={(next) => setData({ ...data, settings: { ...data.settings, staffing: next } })} />}
    </div>
    </PxCtx.Provider>
  );
}

const btnQuiet = "inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] cursor-pointer disabled:opacity-50 whitespace-nowrap";
const btnPri = "inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 rounded-lg bg-[var(--color-accent)] px-3 text-body font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] cursor-pointer disabled:opacity-50 whitespace-nowrap";
/** Two choices, as plain radio buttons (not a filled toggle). */
function Choice<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: ReadonlyArray<readonly [T, string]>; label: string }) {
  const name = React.useId();
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-x-4 gap-y-1">
      {options.map(([k, l]) => (
        <label key={k} className={`inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 text-body cursor-pointer ${value === k ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
          <input type="radio" name={name} checked={value === k} onChange={() => onChange(k)} className="w-4 h-4 accent-[var(--color-current)]" />{l}
        </label>
      ))}
    </div>
  );
}

// ── Shared timeline bits ─────────────────────────────────────────────────

function useAxis(work: { shifts: Array<{ start: number; end: number; kind: string; dayKey: string }> }) {
  const PX = React.useContext(PxCtx);
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
  const PX = React.useContext(PxCtx);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < shifts.length; i++) {
    const s = shifts[i];
    if (s.kind !== "day" && i !== 0) continue;
    const span = s.kind === "day" ? 2 : 1;
    out.push(
      <div key={i} className="absolute top-0 border-l border-[var(--color-border)] pl-1 text-caption text-[var(--color-text-muted)] leading-tight whitespace-nowrap overflow-hidden" style={{ left: i * PX, width: span * PX }}>
        <b className="text-[var(--color-text)]">{dayLabel ? dayLabel(s.start) : PX < 20 ? fmtInTz(s.start, tz, { day: "numeric" }) : PX < 26 ? fmtInTz(s.start, tz, { month: "numeric", day: "numeric" }) : fmtInTz(s.start, tz, { weekday: "short" })}</b> {PX < 26 ? "" : dayLabel ? fmtInTz(s.start, tz, { weekday: "short" }) : fmtInTz(s.start, tz, { month: "short", day: "numeric" })}
        <div className="flex mt-0.5">{span === 2 ? <><span className="flex-1 text-center">D</span><span className="flex-1 text-center">N</span></> : <span className="flex-1 text-center">{s.kind === "night" ? "N" : "D"}</span>}</div>
      </div>,
    );
  }
  return <div className="relative h-8" style={{ width: shifts.length * PX }}>{out}</div>;
}

function Grid({ shifts }: { shifts: Array<{ kind: string }> }) {
  const PX = React.useContext(PxCtx);
  return <>{shifts.map((s, i) => <i key={i} aria-hidden className={`absolute top-0 bottom-0 ${s.kind === "night" ? "border-l border-dashed border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-text)_3%,transparent)]" : "border-l border-[var(--color-border)]"}`} style={{ left: i * PX, width: PX }} />)}</>;
}

const when = (t: number | null, tz: string) => (t == null ? "-" : `${fmtInTz(t, tz, { weekday: "short", month: "numeric", day: "numeric" })} ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`);
const hatch = (a: string, b: string) => ({ background: `repeating-linear-gradient(135deg, ${a} 0 4px, ${b} 4px 8px)` });
const WAIT = { ...hatch("color-mix(in srgb, var(--state-held) 38%, var(--color-surface))", "color-mix(in srgb, var(--state-held) 10%, var(--color-surface))"), border: "1px solid var(--state-held)" };
const READY = { ...hatch("color-mix(in srgb, var(--color-text) 16%, var(--color-surface))", "var(--color-surface)"), border: "1px solid var(--viz-neutral)" };
/** On a work order's own line: a shift between its first and last work with
 *  nothing logged on any of its activities (its "shifts waited"). */
const ORDER_WAIT = hatch("var(--viz-neutral)", "var(--color-surface-2)");

function Legend({ items }: { items: Array<[React.CSSProperties, string]> }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-[var(--color-text-muted)]">
      {items.map(([st, label]) => <span key={label} className="inline-flex items-center gap-1"><span className="inline-block w-4 h-2.5 rounded-sm" style={st} />{label}</span>)}
    </div>
  );
}

/** A work order's bar, one piece per step (or activity), start to finish;
 *  pieces at the same time stacked. Returns the pieces and their height. */
type Piece = { key: string; from: number; to: number; color: string; title: string; label?: string; ring?: string };
function pieces(items: Piece[], x: (t: number) => number, top: number): { h: number; nodes: React.ReactNode } {
  const { lanes, at } = laneSteps(items);
  const nodes = at.map((q) => {
    const l = x(q.from), w = Math.max(3, x(q.to) - l);
    return (
      <i key={q.key} title={q.title} className="absolute rounded-md overflow-hidden whitespace-nowrap not-italic text-white text-caption font-medium leading-[10px] px-[3px]"
        style={{ left: l + 0.75, width: Math.max(2, w - 1.5), top: top + q.lane * 13, height: 10, background: q.color, boxShadow: q.ring }}>
        {q.label && w >= 34 ? q.label : null}
      </i>
    );
  });
  return { h: Math.max(1, lanes) * 13, nodes };
}

/** Fold every work order's steps away, or show them all. */
function FoldAll({ open, total, onAll }: { open: number; total: number; onAll: (open: boolean) => void }) {
  const all = open >= total;
  return (
    <div className="flex flex-wrap items-center gap-2 text-caption text-[var(--color-text-muted)]">
      <button type="button" onClick={() => onAll(!all)} className={btnQuiet}>{all ? <ChevronsDownUp className="w-4 h-4" /> : <ChevronsUpDown className="w-4 h-4" />} {all ? "Fold the steps away" : "Show every step"}</button>
      <span>Each work order&apos;s bar is its steps, one piece each. Tap a work order to see its steps.</span>
    </div>
  );
}

function OrderName({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="w-full text-left flex items-start gap-1 cursor-pointer pointer-coarse:min-h-11">
      <ChevronRight className={`w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? "rotate-90" : ""}`} />
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

const cellAct = "sticky left-0 z-[2] bg-[var(--color-surface)] border-r border-[var(--color-border)] align-top px-2 py-1.5 w-[170px] min-w-[170px] max-w-[170px] sm:w-[290px] sm:min-w-[290px] sm:max-w-[290px]";
const cellDt = "col-x align-top px-2 py-1.5 text-caption whitespace-nowrap text-[var(--color-text)]";
const cellN = "col-x align-top px-1.5 py-1.5 text-center font-medium text-caption min-w-[44px]";

// ── As-built: each work order against its own plan (the default) ────────
//
// One row per work order: its full name, planned finish, actual finish,
// how late against its own planned finish, and the shifts it waited; one
// bar (the plan a gray box, as built solid, the part past its own planned
// finish red, the shifts it waited hatched). Most late first. Each phase
// is its own block, on its own dates, with its own planned-finish line.
// Crews and shift-by-shift marks show when a row is opened.

const HOUR = 3_600_000;
type BuiltProps = Props & { built: ReturnType<typeof buildAsBuilt>; work: AsBuiltWork; colorOf: (c: string) => string; changes: PlanChange[]; onAdd: (c: PlanChange) => void };
type Order = BuiltProps["built"]["orders"][number];
type Planning = { step: string; run: number } | null;
/** A phase on screen: its span with a little room each side, and its midnights. */
interface Block extends PhaseBlock { t0: number; t1: number; days: number[] }
const NIGHTS = "Night shifts count as waiting only for work that ran on nights (its crew worked that work order on two or more nights). Day work sitting overnight is not waiting.";
const MARKS = "Each solid mark is a shift where that crew logged progress (at the time set, not when it was typed). Amber hatched: it sat in progress with nothing logged; the reason is the crew's own comments. Gray hatched: everything before it was done, but its crew was elsewhere. Calendar time between start and finish is never counted as work.";
/** The plan: a gray box with an edge that reads on a sheet (3:1). */
const PLAN_BOX: React.CSSProperties = { background: "color-mix(in srgb, var(--color-text) 8%, var(--color-surface))", boxShadow: "inset 0 0 0 1.5px var(--color-border-control)" };
const ACTUAL = "var(--color-main)";
const LATE = "var(--state-overdue)";
/** Stripes laid over the bar: the shifts it waited with nothing logged. */
const WAITED: React.CSSProperties = { background: "repeating-linear-gradient(135deg, transparent 0 3px, var(--color-surface) 3px 6px)" };
const WAITED_KEY: React.CSSProperties = { background: `repeating-linear-gradient(135deg, ${ACTUAL} 0 3px, var(--color-surface) 3px 6px)` };
/** Work order, planned finish, actual finish, late by, waited, the bar. */
const COLS = "grid-cols-[minmax(0,1.6fr)_5.75rem_5.75rem_6.5rem_4.5rem_minmax(0,2.4fr)]";
const pct = (x: (t: number) => number, a: number, b: number): React.CSSProperties => ({ left: `${x(a)}%`, width: `${Math.max(0.5, x(b) - x(a))}%` });
/** One shift's mark, a pixel in from each side. */
const mark = (x: (t: number) => number, a: number, b: number): React.CSSProperties => ({ left: `calc(${x(a)}% + 1px)`, width: `max(2px, calc(${Math.max(0, x(b) - x(a))}% - 2px))` });
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The work orders by phase (lib/asBuiltSchedule phaseBlocks, the same as
 *  the printout), each on its own dates. */
function blocksOf(built: BuiltProps["built"], now: number, tz: string): Block[] {
  return phaseBlocks(built, now).map((b) => {
    const pad = (b.to - b.from) * 0.015;
    const t0 = b.from - pad, t1 = b.to + pad;
    const days: number[] = [];
    for (let d = addDays(startOfDay(t0, tz), 1, tz), g = 0; d < t1 && g < 400; d = addDays(d, 1, tz), g++) days.push(d);
    return { ...b, t0, t1, days };
  });
}

/** "12 h", "26 h (1.1 days)", "on time (3 h early)", "6 h so far". */
function LateWords({ item, now, words }: { item: { planFinish: number | null; finish: number | null }; now: number; words?: boolean }) {
  const { h, sofar } = lateOf(item, now);
  if (h == null) return <span className="text-[var(--color-text-muted)]">{item.planFinish == null ? "no plan" : "not due yet"}</span>;
  if (h >= 0.5) return <b className="font-medium text-[var(--state-overdue-text)]">{hoursDays(h)}{words ? " late" : ""}{sofar ? " so far" : ""}</b>;
  if (sofar) return <span className="text-[var(--color-text)]">due now</span>;
  return <span className="text-[var(--color-text)]">on time{h <= -0.5 ? <span className="text-[var(--color-text-muted)]"> ({hoursDays(-h)} early)</span> : null}</span>;
}

function WhenCell({ t, tz }: { t: number | null; tz: string }) {
  if (t == null) return <span className="text-caption text-[var(--color-text-muted)]">-</span>;
  return <span className="text-caption text-[var(--color-text)]">{fmtInTz(t, tz, { weekday: "short", month: "numeric", day: "numeric" })}<br />{fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}</span>;
}

/** A row's bar area on its phase's dates: a line each midnight, and the
 *  phase's planned finish as a dark line. */
function Track({ b, x, children }: { b: Block; x: (t: number) => number; children?: React.ReactNode }) {
  return (
    <div className="relative h-7">
      {b.days.map((t) => <i key={t} aria-hidden className="absolute inset-y-0 border-l border-[var(--color-border)]" style={{ left: `${x(t)}%` }} />)}
      {children}
      {b.planFinish != null && <i aria-hidden className="absolute -inset-y-1 border-l-2 border-[var(--color-text)]" style={{ left: `${x(b.planFinish)}%` }} />}
    </div>
  );
}

/** The phase's days over the bars (as many as there's room to read), and
 *  its planned finish named where its line is. */
function Axis({ b, x, tz, room }: { b: Block; x: (t: number) => number; tz: string; room: number }) {
  const step = Math.max(1, Math.ceil(b.days.length / Math.max(2, Math.floor(room / 64))));
  // Near the right edge a label reads leftward from its line, so it never runs off.
  const at = (t: number) => (x(t) > 75 ? { st: { right: `${100 - x(t)}%` }, thin: "border-r", thick: "border-r-2" } : { st: { left: `${x(t)}%` }, thin: "border-l", thick: "border-l-2" });
  return (
    <div aria-hidden className="relative h-9 overflow-hidden text-caption text-[var(--color-text-muted)]">
      {b.days.map((t, i) => { if (i % step) return null; const a = at(t); return <span key={t} className={`absolute top-0 px-1 whitespace-nowrap ${a.thin} border-[var(--color-border)]`} style={a.st}>{fmtInTz(t, tz, { month: "short", day: "numeric" })}</span>; })}
      {b.planFinish != null && (() => { const a = at(b.planFinish); return <span className={`absolute bottom-0 px-1 whitespace-nowrap font-medium text-[var(--color-text)] ${a.thick} border-[var(--color-text)]`} style={a.st}>Plan finish</span>; })()}
    </div>
  );
}

function BuiltView(p: BuiltProps & { mode: "orders" | "shifts"; onMode: (m: "orders" | "shifts") => void; boxW: number }) {
  const { tz, built, work } = p;
  const [now] = useState(() => Date.now());
  const [order, setOrder] = useState<"late" | "plan">("late");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [planning, setPlanning] = useState<Planning>(null);
  const blocks = useMemo(() => blocksOf(built, now, tz), [built, now, tz]);
  const idx = useMemo(() => new Map(work.shifts.map((w, i) => [shiftKey(w), i])), [work]);
  const t = work.totals;
  // Wide: the numbers in columns beside the bar; narrow: under the name.
  const wide = p.boxW >= 880;
  const room = wide ? Math.max(120, Math.round((p.boxW - 420) * 0.6)) : Math.max(120, p.boxW - 32);
  const all = built.orders.map((o) => o.key);
  const flip = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const sorted = (os: Order[]) => (order === "plan" ? os : mostLateFirst(os, now));
  const answers = blocks.map((b) => answerOf(b, now));

  return (
    <div className="space-y-3">
      <div>
        {blocks.length === 1 ? (
          <p className={`text-section font-semibold ${answers[0].late ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>{answers[0].text}</p>
        ) : (
          <p className="text-reading text-[var(--color-text)]">
            {blocks.map((b, i) => <React.Fragment key={b.name ?? i}>{i > 0 && " · "}<b className="font-medium">{b.name ?? "No phase"}:</b> <span className={answers[i].late ? "font-semibold text-[var(--state-overdue-text)]" : ""}>{lowerFirst(answers[i].text)}</span></React.Fragment>)}
          </p>
        )}
        <p className="mt-0.5 text-caption text-[var(--color-text-muted)]">{built.steps} activities, {built.added} added during the job · sat in progress: {t.waitedSteps} activities, {t.waitedShifts} shifts · ready but not started: {t.readySteps} activities, {t.readyShifts} shifts</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-2"><span className="text-caption font-medium text-[var(--color-text-muted)]">Show</span>
          <Choice label="Show" value={p.mode} onChange={p.onMode} options={[["orders", "Work orders"], ["shifts", "Shift by shift"]] as const} /></div>
        {p.mode === "orders" && <div className="flex flex-wrap items-center gap-x-2"><span className="text-caption font-medium text-[var(--color-text-muted)]">Order</span>
          <Choice label="Order" value={order} onChange={setOrder} options={[["late", "Most late first"], ["plan", "Schedule order"]] as const} /></div>}
        {p.mode === "orders" && (
          <button type="button" onClick={() => setOpen(open.size >= all.length ? new Set() : new Set(all))} className={btnQuiet}>
            {open.size >= all.length ? <ChevronsDownUp className="w-4 h-4" /> : <ChevronsUpDown className="w-4 h-4" />} {open.size >= all.length ? "Fold the steps away" : "Show every step"}
          </button>
        )}
      </div>

      {p.mode === "shifts" ? <ShiftGrid {...p} /> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Legend items={[[PLAN_BOX, "Plan"], [{ background: ACTUAL }, "As built"], [{ background: LATE }, "Past its own planned finish"], [WAITED_KEY, "Shifts waited, nothing logged"], [{ borderLeft: "2px solid var(--color-text)", width: 2 }, blocks.some((x) => x.name) ? "The phase's planned finish" : "Planned finish"]]} />
            <HelpTooltip>{NIGHTS}</HelpTooltip>
          </div>
          {blocks.map((b, bi) => {
            const x = (v: number) => Math.max(0, Math.min(100, ((v - b.t0) / (b.t1 - b.t0)) * 100));
            return (
              <section key={b.name ?? bi} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 sm:px-4 py-3" data-phase-block={b.name ?? ""}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  {b.name && <h3 className="text-reading font-semibold text-[var(--color-text)]">{b.name}</h3>}
                  <span className="text-caption text-[var(--color-text-muted)]">
                    Planned finish <b className="font-medium text-[var(--color-text)]">{when(b.planFinish, tz)}</b> · {b.finish != null ? <>finished <b className="font-medium text-[var(--color-text)]">{when(b.finish, tz)}</b></> : "not done yet"}
                    {blocks.length > 1 && <> · <span className={answers[bi].late ? "font-medium text-[var(--state-overdue-text)]" : ""}>{lowerFirst(answers[bi].text)}</span></>} · {b.orders.length} work order{b.orders.length === 1 ? "" : "s"}
                  </span>
                </div>
                {wide ? (
                  <div className={`mt-2 grid ${COLS} gap-x-3 items-end border-b border-[var(--color-border)] pb-1 text-caption font-medium text-[var(--color-text-muted)]`}>
                    <span>Work order</span><span>Planned finish</span><span>Actual finish</span><span className="text-right">Late by</span><span className="text-right">Shifts waited</span>
                    <Axis b={b} x={x} tz={tz} room={room} />
                  </div>
                ) : <div className="mt-2 border-b border-[var(--color-border)] pb-1"><Axis b={b} x={x} tz={tz} room={room} /></div>}
                <div className="divide-y divide-[var(--color-border)]">
                  {sorted(b.orders).map((o) => (
                    <React.Fragment key={o.key}>
                      <OrderRow o={o} b={b} x={x} p={p} now={now} wide={wide} open={open.has(o.key)} onToggle={() => flip(o.key)} />
                      {open.has(o.key) && <StepsOpen o={o} b={b} x={x} p={p} now={now} wide={wide} idx={idx} planning={planning} setPlanning={setPlanning} />}
                    </React.Fragment>
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

/** A work order: its numbers in words, and its one bar. */
function OrderRow({ o, b, x, p, now, wide, open, onToggle }: { o: Order; b: Block; x: (t: number) => number; p: BuiltProps; now: number; wide: boolean; open: boolean; onToggle: () => void }) {
  const { tz } = p;
  const ow = p.work.orders.get(o.key);
  const added = o.steps.filter((s) => !s.inPlan).length;
  const pf = o.planFinish, start = o.barStart;
  const end = o.finish ?? (o.status !== "not_started" ? now : null);
  const meta = [o.wo ? `WO ${o.wo}` : null, `${o.steps.length} step${o.steps.length === 1 ? "" : "s"}`, added ? `${added} added` : null].filter(Boolean).join(" · ");
  const name = (
    <OrderName open={open} onToggle={onToggle}>
      <span className="block font-medium text-body text-[var(--color-text)]">{o.name}</span>
      {o.foundOn && <span className="block text-caption text-[var(--color-text-muted)]">Found on {o.foundOn}</span>}
      <span className="block text-caption text-[var(--color-text-muted)]">{meta}</span>
    </OrderName>
  );
  const bar = (
    <Track b={b} x={x}>
      {o.planStart != null && pf != null && <i title={`Plan: ${when(o.planStart, tz)} to ${when(pf, tz)}`} className="absolute top-0.5 h-6 rounded-md" style={{ ...pct(x, o.planStart, pf), ...PLAN_BOX }} />}
      {start != null && end != null && end > start && (pf == null || start < pf) && (
        <i title={`As built: ${when(start, tz)} to ${o.finish != null ? when(o.finish, tz) : "still going"}`} className="absolute top-2 h-3 rounded-[3px]" style={{ ...pct(x, start, pf == null ? end : Math.min(end, pf)), background: ACTUAL }} />
      )}
      {start != null && end != null && pf != null && end > pf && (
        <i title={`Past its planned finish: ${hoursDays((end - pf) / HOUR)}`} className="absolute top-2 h-3 rounded-[3px]" style={{ ...pct(x, Math.max(start, pf), end), background: LATE }} />
      )}
      {ow?.cells.map((c, i) => (c === "wait" ? <i key={i} title={`${shiftWords(shiftKey(p.work.shifts[i]), p.work, tz)}: work order open, nothing logged`} className="absolute top-2 h-3" style={{ ...pct(x, p.work.shifts[i].start, p.work.shifts[i].end), ...WAITED }} /> : null))}
    </Track>
  );
  const waited = ow?.waited ?? 0;
  if (wide) {
    return (
      <div className={`grid ${COLS} gap-x-3 items-start py-2`} data-order={o.key}>
        <div className="min-w-0">{name}</div>
        <WhenCell t={pf} tz={tz} />
        {o.finish != null ? <WhenCell t={o.finish} tz={tz} /> : <span className="text-caption text-[var(--color-text-muted)]">{BUILT_WORD[o.status].toLowerCase()}</span>}
        <span className="text-body text-right"><LateWords item={o} now={now} /></span>
        <span className={`text-body text-right tabular-nums ${waited ? "font-medium text-[var(--state-held-text)]" : "text-[var(--color-text-muted)]"}`}>{waited || "-"}</span>
        <div className="pt-1">{bar}</div>
      </div>
    );
  }
  return (
    <div className="py-2 space-y-1" data-order={o.key}>
      <div className="flex items-start gap-3"><div className="min-w-0 flex-1">{name}</div><span className="shrink-0 pt-0.5 text-body text-right"><LateWords item={o} now={now} words /></span></div>
      <div className="pl-5 text-caption text-[var(--color-text-muted)]">
        Planned finish {when(pf, tz)} · {o.finish != null ? `finished ${when(o.finish, tz)}` : BUILT_WORD[o.status].toLowerCase()}
        {waited ? <> · <b className="font-medium text-[var(--state-held-text)]">{waited} shift{waited === 1 ? "" : "s"} waited</b></> : null}
      </div>
      {bar}
    </div>
  );
}

/** A work order opened: each step, its crew in its color, and a mark for
 *  each shift it was worked, sat or was ready, on the phase's dates. */
function StepsOpen({ o, b, x, p, now, wide, idx, planning, setPlanning }: { o: Order; b: Block; x: (t: number) => number; p: BuiltProps; now: number; wide: boolean; idx: Map<string, number>; planning: Planning; setPlanning: (v: Planning) => void }) {
  const { tz, work } = p;
  const steps = [...o.steps].sort((a, c) => (a.start ?? a.planStart ?? 0) - (c.start ?? c.planStart ?? 0));
  const crews = [...new Set(steps.map((s) => work.steps.get(s.id)?.crew).filter((c): c is string => !!c))];
  const at = (k: string) => { const i = idx.get(k); return i == null ? null : work.shifts[i]; };
  return (
    <div className="pb-2" data-order-steps={o.key}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pl-5 text-caption text-[var(--color-text-muted)]">
        <span className="font-medium text-[var(--color-text)]">Color = crew:</span>
        {crews.map((c) => <span key={c} className="inline-flex items-center gap-1"><span aria-hidden className="inline-block w-3 h-3 rounded-sm" style={{ background: p.colorOf(c) }} />{c}</span>)}
        <Legend items={[[WAIT, "In progress, nothing logged"], [READY, "Ready, not started"], [PLAN_BOX, "Plan"]]} />
        <HelpTooltip>{MARKS}</HelpTooltip>
      </div>
      <div className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
        {steps.map((s) => {
          const w = work.steps.get(s.id);
          if (!w) return null;
          const waited = w.waits.reduce((n, r) => n + r.shifts, 0) + (w.ready?.shifts.length ?? 0);
          const took = s.elapsedH != null ? `took ${s.elapsedH} h` : s.status === "done" ? "start not recorded" : s.status === "not_started" ? "not started" : "still going";
          const text = (
            <div className="min-w-0 flex-1 pl-5">
              <div className="font-medium text-body text-[var(--color-text)]">{s.name}{!s.inPlan && <span className="ml-1 rounded border border-[var(--color-border-strong)] px-1 text-caption font-medium text-[var(--color-text)]">Added</span>}</div>
              <div className="text-caption text-[var(--color-text-muted)]"><b aria-hidden className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(w.crew) }} />{w.crew} · plan {r1(s.plannedH)} h · {took}</div>
              {w.ready && <div className="text-caption text-[var(--color-text-muted)]">Ready {when(w.ready.at, tz)}, waited {w.ready.shifts.length} shift{w.ready.shifts.length === 1 ? "" : "s"} to start: {w.ready.busyOn.length ? `${w.crew} was on ${[...new Set(w.ready.busyOn.map((y) => y.split(" - ")[0]))].join(", ")}` : `${w.crew} logged nothing those shifts`}</div>}
              {w.waits.map((r, i) => (
                <div key={i} className="text-caption text-[var(--state-held-text)]">
                  Waited {r.shifts} shift{r.shifts === 1 ? "" : "s"}: {r.why.length ? r.why.map((y) => `"${y}"`).join(" · ") : "no reason recorded"}
                  {p.canEdit && r.why.length > 0 && <button type="button" onClick={() => setPlanning({ step: s.id, run: i })} className="ml-1 underline cursor-pointer text-[var(--color-accent-text)]">Plan for it next time</button>}
                  {planning?.step === s.id && planning.run === i && <PlanFor run={r} stepName={s.name} crews={work.crews.map((c) => c.crew)} doneBefore={progressBefore(w.moved, r, idx)} onCancel={() => setPlanning(null)} onSave={(c) => { p.onAdd({ ...c, ...(c.kind === "split" ? { actId: s.id } : {}) } as PlanChange); setPlanning(null); }} />}
                </div>
              ))}
            </div>
          );
          const marks = (
            <Track b={b} x={x}>
              {s.planStart != null && s.planFinish != null && <i title={`Plan: ${when(s.planStart, tz)} to ${when(s.planFinish, tz)}`} className="absolute top-0.5 h-6 rounded-md" style={{ ...pct(x, s.planStart, s.planFinish), ...PLAN_BOX }} />}
              {w.worked.map((k) => { const sh = at(k); return sh ? <i key={k} title={`${shiftWords(k, work, tz)}: ${w.crew}, ${w.moved[k] ? `${r1(w.moved[k])}% moved` : "started"}`} className="absolute top-2 h-3 rounded-[2px]" style={{ ...mark(x, sh.start, sh.end), background: p.colorOf(w.crew) }} /> : null; })}
              {w.waits.flatMap((r) => r.keys).map((k) => { const sh = at(k); return sh ? <i key={`w${k}`} title={`${shiftWords(k, work, tz)}: in progress, nothing logged`} className="absolute top-2 h-3 rounded-[2px]" style={{ ...mark(x, sh.start, sh.end), ...WAIT }} /> : null; })}
              {w.ready?.shifts.map((k) => { const sh = at(k); return sh ? <i key={`r${k}`} title={`${shiftWords(k, work, tz)}: ready, not started`} className="absolute top-2 h-3 rounded-[2px]" style={{ ...mark(x, sh.start, sh.end), ...READY }} /> : null; })}
            </Track>
          );
          return wide ? (
            <div key={s.id} className={`grid ${COLS} gap-x-3 items-start py-1.5`} data-step={s.id}>
              {text}
              <WhenCell t={s.planFinish} tz={tz} />
              {s.finish != null ? <WhenCell t={s.finish} tz={tz} /> : <span className="text-caption text-[var(--color-text-muted)]">{BUILT_WORD[s.status].toLowerCase()}</span>}
              <span className="text-body text-right"><LateWords item={s} now={now} /></span>
              <span className={`text-body text-right tabular-nums ${waited ? "font-medium text-[var(--state-held-text)]" : "text-[var(--color-text-muted)]"}`}>{waited || "-"}</span>
              <div className="pt-1">{marks}</div>
            </div>
          ) : (
            <div key={s.id} className="py-1.5 space-y-1" data-step={s.id}>
              <div className="flex items-start gap-3">{text}<span className="shrink-0 text-body text-right"><LateWords item={s} now={now} words /></span></div>
              <div className="pl-5 text-caption text-[var(--color-text-muted)]">Planned finish {when(s.planFinish, tz)} · {s.finish != null ? `finished ${when(s.finish, tz)}` : BUILT_WORD[s.status].toLowerCase()}{waited ? ` · ${waited} shift${waited === 1 ? "" : "s"} waited` : ""}</div>
              {marks}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── As-built, shift by shift (the whole job on one grid) ─────────────────

function ShiftGrid(p: BuiltProps) {
  const { tz, built, work } = p;
  const PX = React.useContext(PxCtx);
  const { x, width } = useAxis(work);
  const keys = work.shifts.map(shiftKey);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const [planning, setPlanning] = useState<{ step: string; run: number } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [now] = useState(() => Date.now());
  const planFin = built.planFinish;
  const line = planFin != null ? <i aria-hidden title="Whole job's planned finish" className="absolute top-0 bottom-0 border-l-2 border-[var(--state-overdue)]" style={{ left: x(planFin) }} /> : null;
  const orders = [...built.orders].sort((a, b) => (a.planStart ?? Infinity) - (b.planStart ?? Infinity));
  const flip = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // A step's piece: its start to its finish as built; with no start
  // recorded, from the first shift it was worked.
  const spanOf = (st: BuiltStep): { from: number; to: number } | null => {
    const b = stepBar(st, now);
    if (b) return b;
    const ks = (work.steps.get(st.id)?.worked ?? []).map((k) => idx.get(k)).filter((i): i is number => i != null);
    if (!ks.length) return null;
    return { from: work.shifts[Math.min(...ks)].start, to: st.finish ?? work.shifts[Math.max(...ks)].end };
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Legend items={[[{ background: "var(--color-main)" }, "Color = crew: a step, start to finish (on a step's own line, each shift it was worked)"], [ORDER_WAIT, "Work order open, nothing logged that shift"], [WAIT, "Activity in progress, nothing logged"], [READY, "Ready, not started"], [{ background: "var(--color-border-control)", height: 6 }, "Plan"], [{ borderLeft: "2px solid var(--state-overdue)", width: 2 }, "Whole job's planned finish"]]} />
        <HelpTooltip>{NIGHTS}</HelpTooltip>
      </div>
      <FoldAll open={open.size} total={orders.length} onAll={(all) => setOpen(all ? new Set(orders.map((o) => o.key)) : new Set())} />
      <div className="overflow-auto max-h-[75vh] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className={`border-separate border-spacing-0 w-max text-caption ${p.cols ? "" : "[&_.col-x]:hidden"}`}>
          <thead className="sticky top-0 z-[4] bg-[var(--color-surface-2)]">
            <tr className="text-caption text-[var(--color-text-muted)] text-left">
              <th className={`${cellAct} !bg-[var(--color-surface-2)] z-[5]`}>Activity</th>
              <th className="col-x px-2 font-medium">Planned</th><th className="col-x px-2 font-medium">Actual</th>
              <th className="col-x px-1 font-medium text-center">Shifts<br />worked</th><th className="col-x px-1 font-medium text-center">Shifts<br />waited</th>
              <th className="p-0"><Header shifts={work.shifts} tz={tz} /></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const ow = work.orders.get(o.key);
              const isOpen = open.has(o.key);
              const bar = pieces(o.steps.flatMap((st) => {
                const sp = spanOf(st); const crew = work.steps.get(st.id)?.crew ?? st.crew ?? "";
                return sp ? [{ key: st.id, ...sp, color: p.colorOf(crew), label: st.elapsedH != null ? `${st.elapsedH} h` : undefined,
                  title: `${st.name} · ${crew} · ${when(sp.from, tz)} to ${st.finish != null ? when(st.finish, tz) : "still going"}${st.elapsedH != null ? ` · took ${st.elapsedH} h` : ""}${!st.inPlan ? " · added" : ""}` }] : [];
              }), x, 12);
              return (
                <React.Fragment key={o.key}>
                  <tr className="bg-[var(--color-surface-2)]" data-order={o.key}>
                    <td className={`${cellAct} !bg-[var(--color-surface-2)]`}>
                      <OrderName open={isOpen} onToggle={() => flip(o.key)}>
                        <div className="font-medium text-caption text-[var(--color-text)]">{o.name}</div>
                        {o.foundOn && <div className="text-caption font-medium text-[var(--color-text-muted)]">Found on {o.foundOn}</div>}
                        <div className="text-caption text-[var(--color-text-muted)]">{o.wo ? `${o.wo} · ` : ""}{o.steps.length} step{o.steps.length === 1 ? "" : "s"}{o.steps.some((s) => !s.inPlan) ? ` · ${o.steps.filter((s) => !s.inPlan).length} added` : ""}{!p.cols && ow ? <> · {ow.worked} shift{ow.worked === 1 ? "" : "s"} worked{ow.waited ? <> · <b className="whitespace-nowrap font-medium text-[var(--state-held-text)]">{ow.waited} waited</b></> : null}</> : null}</div>
                      </OrderName>
                    </td>
                    <td className={cellDt}>{when(o.planStart, tz)}<br />{when(o.planFinish, tz)}</td>
                    <td className={cellDt}>{when(o.start, tz)}<br />{when(o.finish, tz)}</td>
                    <td className={cellN}>{ow?.worked ?? 0}</td>
                    <td className={`${cellN} ${ow?.waited ? "text-[var(--state-held-text)]" : ""}`}>{ow?.waited || "-"}</td>
                    <td className="p-0 relative"><div className="relative" style={{ width, height: Math.max(44, 12 + bar.h + 7) }}>
                      <Grid shifts={work.shifts} />
                      {o.planStart != null && o.planFinish != null && <i title="Plan" className="absolute top-1 h-1.5 rounded bg-[var(--color-border-control)]" style={{ left: x(o.planStart), width: Math.max(2, x(o.planFinish) - x(o.planStart)) }} />}
                      {bar.nodes}
                      {ow?.cells.map((c, i) => c === "wait" && <i key={i} className="absolute bottom-1 h-[4px] rounded-sm" style={{ left: i * PX + 1, width: PX - 2, ...ORDER_WAIT }} title="Work order open, nothing logged that shift" />)}
                      {line}
                    </div></td>
                  </tr>
                  {isOpen && [...o.steps].sort((a, b) => (a.start ?? a.planStart ?? 0) - (b.start ?? b.planStart ?? 0)).map((s) => {
                    const w = work.steps.get(s.id);
                    if (!w) return null;
                    const waited = w.waits.reduce((n, r) => n + r.shifts, 0) + (w.ready?.shifts.length ?? 0);
                    return (
                      <tr key={s.id}>
                        <td className={cellAct}>
                          <div className="font-medium text-[var(--color-text)]">{s.name}{!s.inPlan && <span className="ml-1 rounded border border-[var(--color-border-strong)] px-1 text-caption font-medium text-[var(--color-text)]">Added</span>}</div>
                          <div className="text-caption text-[var(--color-text-muted)]"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(w.crew) }} />{w.crew} · plan {r1(s.plannedH)} h{!p.cols ? ` · ${s.elapsedH != null ? `took ${s.elapsedH} h` : s.status === "done" ? "start not recorded" : s.status === "not_started" ? "not started" : "still going"}` : ""}</div>
                          {w.ready && <div className="text-caption text-[var(--color-text-muted)]">Ready {when(w.ready.at, tz)}, waited {w.ready.shifts.length} shift{w.ready.shifts.length === 1 ? "" : "s"} to start: {w.ready.busyOn.length ? `${w.crew} was on ${[...new Set(w.ready.busyOn.map((b) => b.split(" - ")[0]))].join(", ")}` : `${w.crew} logged nothing those shifts`}</div>}
                          {w.waits.map((r, i) => (
                            <div key={i} className="text-caption text-[var(--state-held-text)]">
                              Waited {r.shifts} shift{r.shifts === 1 ? "" : "s"}: {r.why.length ? r.why.map((x) => `"${x}"`).join(" · ") : "no reason recorded"}
                              {p.canEdit && r.why.length > 0 && <button type="button" onClick={() => setPlanning({ step: s.id, run: i })} className="ml-1 underline cursor-pointer text-[var(--color-accent-text)]">Plan for it next time</button>}
                              {planning?.step === s.id && planning.run === i && <PlanFor run={r} stepName={s.name} crews={work.crews.map((c) => c.crew)} doneBefore={progressBefore(w.moved, r, idx)} onCancel={() => setPlanning(null)} onSave={(c) => { p.onAdd({ ...c, ...(c.kind === "split" ? { actId: s.id } : {}) } as PlanChange); setPlanning(null); }} />}
                            </div>
                          ))}
                        </td>
                        <td className={cellDt}>{when(s.planStart, tz)}<br />{when(s.planFinish, tz)}</td>
                        <td className={cellDt}>{when(s.start, tz)}<br />{when(s.finish, tz)}</td>
                        <td className={cellN}>{w.worked.length}</td>
                        <td className={`${cellN} ${waited ? "text-[var(--state-held-text)]" : ""}`}>{waited || "-"}</td>
                        <td className="p-0 relative"><div className="relative min-h-[42px] h-full" style={{ width }}>
                          <Grid shifts={work.shifts} />
                          {s.planStart != null && s.planFinish != null && <i title="Plan" className="absolute top-1 h-1.5 rounded bg-[var(--color-border-control)]" style={{ left: x(s.planStart), width: Math.max(2, x(s.planFinish) - x(s.planStart)) }} />}
                          {w.worked.map((k) => idx.has(k) && <i key={k} title={`${w.moved[k] ? `${r1(w.moved[k])}% moved` : "started"}`} className="absolute top-3.5 h-4 rounded-sm" style={{ left: idx.get(k)! * PX + 2, width: PX - 4, background: p.colorOf(w.crew) }} />)}
                          {w.waits.flatMap((r) => r.keys).map((k) => <i key={`w${k}`} className="absolute top-3.5 h-4 rounded-sm" style={{ left: idx.get(k)! * PX + 2, width: PX - 4, ...WAIT }} />)}
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
                <td className={cellAct}><div className="font-medium"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(c.crew) }} />{c.crew}</div><div className="text-caption text-[var(--color-text-muted)]">most moved in a shift: {c.mostMoved}</div></td>
                <td className="col-x" /><td className="col-x" /><td className={cellN}>{Object.values(c.byShift).filter((x) => x.moved).length}</td><td className="col-x" />
                <td className="p-0 relative"><div className="relative h-11" style={{ width }}>
                  <Grid shifts={work.shifts} />
                  {keys.map((k, i) => { const b = c.byShift[k]; const hands = b?.counted?.direct ?? b?.counted?.total; return b && (b.moved || hands) ? (
                    <span key={k} className="absolute top-1.5 h-8 rounded text-white text-center font-medium text-caption leading-[13px] pt-0.5" style={{ left: i * PX + 2, width: PX - 4, background: p.colorOf(c.crew) }}>{b.moved}{hands ? <small className="block text-caption leading-none font-medium">{hands} hands</small> : null}</span>
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
                    <div className="font-medium"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(c.crew) }} />{c.crew}</div>
                    <div className="text-caption text-[var(--color-text-muted)]">{c.perHand != null ? `${r1(c.perHand)} plan h of work per hand a shift on average` : "too few hands entered to judge"}{c.pace ? ` · ${c.pace.mhPerPlanH} man-hours per plan hour (${c.pace.from === "plan" ? "staffing plan" : c.pace.from === "counted" ? "counts" : "hands per job"})` : ""}</div>
                    {say("low") && <div className="text-caption text-[var(--state-held-text)]">More hands than work logged: {say("low")}</div>}
                    {say("high") && <div className="text-caption text-[var(--color-text-muted)]">Stretched: {say("high")}</div>}
                  </td>
                  <td className="col-x" /><td className="col-x" /><td className="col-x" /><td className="col-x" />
                  <td className="p-0 relative"><div className="relative h-11" style={{ width }}>
                    <Grid shifts={work.shifts} />
                    {keys.map((k, i) => { const b = c.byShift[k]; if (!b || !(b.counted || b.planned)) return null; const hands = b.planned?.direct ?? b.counted?.direct ?? b.counted?.total; const tone = b.verdict === "low" ? "bg-transparent border-[var(--state-held)] text-[var(--state-held-text)]" : b.verdict === "high" ? "bg-blue-100 border-blue-300 text-blue-900" : "bg-transparent border-[var(--color-border)] text-[var(--state-released-text)]";
                      return <span key={k} title={`${b.planned ? `Planned ${b.planned.direct} on the tools + ${b.planned.indirect}` : ""}${b.counted ? `${b.planned ? "; " : ""}counted ${b.counted.total ?? b.counted.direct}` : ""}; ${b.earned} plan h of work moved`} className={`absolute top-1.5 h-8 rounded border text-center font-medium text-caption leading-[13px] pt-0.5 ${tone}`} style={{ left: i * PX + 2, width: PX - 4 }}>{hands}<small className="block text-caption leading-none font-medium">{b.counted && b.planned ? `had ${b.counted.total ?? b.counted.direct}` : `${Math.round(b.earned)} h`}</small></span>; })}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-caption text-[var(--color-text-muted)]">A solid block is a shift where that crew logged progress (at the time you set, not when you typed it); its color is the crew. Amber hatched: it sat in progress with nothing logged; the reason is the crew&apos;s own comments. Gray hatched: everything before it was done, but its crew was elsewhere. Calendar time between start and finish is never counted as work.</p>
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
    <tr className="bg-[var(--color-surface-2)]">
      <td className={`${cellAct} !bg-[var(--color-surface-2)]`}><div className="font-medium">{title}</div><div className="text-caption text-[var(--color-text-muted)]">{sub}</div></td>
      <td className="col-x" /><td className="col-x" /><td className="col-x" /><td className="col-x" />
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
  const field = "rounded border border-[var(--color-border-control)] bg-[var(--color-surface)] px-1.5 py-1 text-caption text-[var(--color-text)]";
  const save = () => {
    const base = { id: `p${Date.now().toString(36)}`, said: `${stepName}: ${reason}`, at: Date.now() };
    if (where === "pre") onSave({ ...base, kind: "add", name: name.trim() || reason, crew, hours: 0, pre: true });
    else onSave({ ...base, kind: "split", actId: "", fraction: Math.min(0.95, Math.max(0.05, doneBefore || 0.5)), name: name.trim() || reason, crew, hours: Math.max(0, Number(hours) || 0) });
  };
  return (
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 space-y-1.5 text-[var(--color-text)] whitespace-normal">
      <Choice label="Where it goes" value={where} onChange={setWhere} options={[["pre", "Before the shutdown"], ["split", "As a step in the job"]] as const} />
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="What it is" className={`${field} w-full`} />
      {where === "split" && (
        <div className="flex flex-wrap gap-1.5 items-center text-caption">
          <select value={crew} onChange={(e) => setCrew(e.target.value)} aria-label="Crew" className={field}><option value="">Crew?</option>{crews.map((c) => <option key={c}>{c}</option>)}</select>
          <input value={hours} onChange={(e) => setHours(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" aria-label="Hours" className={`${field} w-16`} /> h (it waited {run.shifts * 12} h this year)
        </div>
      )}
      <div className="flex gap-1.5"><button type="button" onClick={save} className={btnPri}><Check className="w-3.5 h-3.5" /> Add to next time</button><button type="button" onClick={onCancel} className={btnQuiet}>Cancel</button></div>
    </div>
  );
}

// ── Same people, same work, better sequence (lib/asBuiltReplay) ──────────
//
// The owner's rule (docs/next-update.md, section 6): first how the job could
// have run on what really happened, by timing and sequence alone; time or
// people only after that. So the suggestion opens on the replay: its finish,
// each move with the hours it saves and why, the one-off delays to take out
// as a what-if, and what the replay can't know.

/** The replay, never a crash: a record it can't read says so. */
function safeReplay(input: ReplayInput): Replay | null {
  try { return replayAsBuilt(input); } catch { return null; }
}

/** "Before adding anything: ..." said wherever the suggestion adds people,
 *  nights or time, so how far sequencing alone got is always in sight. */
function replayWords(r: Replay | null, tz: string): string {
  if (!r) return "Before adding anything: the record couldn't be replayed with the same crews.";
  if (r.replayFinish == null) return "Before adding anything: the replay above couldn't run on this record.";
  if (r.savedH > 0) return `Before adding anything: the same crews, better sequenced, finish ${when(r.replayFinish, tz)}, ${hoursDays(r.savedH)} sooner than this year${r.actualFinish != null ? ` (${when(r.actualFinish, tz)})` : ""}.`;
  return "Before adding anything: the record shows no way to finish sooner with the same crews.";
}

const MOVES_SHOWN = 8;

function ReplaySection({ input, replay, delays, tz, finished, planFinish }: { input: ReplayInput; replay: Replay | null; delays: OneOffDelay[]; tz: string;
  /** The planned finish of the work shown (its steps' latest planned finish). */
  planFinish: number | null;
  /** With all phases shown and the job not finished: the phases that are,
   *  which can be replayed one at a time. */
  finished?: string[] }) {
  const [all, setAll] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  // One-off delays taken out as a what-if: none until a person ticks one.
  const [out, setOut] = useState<string[]>([]);
  const whatIf = useMemo(() => (out.length ? safeReplay({ ...input, without: out })?.whatIf ?? null : null), [input, out]);
  const ran = !!replay && replay.replayFinish != null;
  const moves = useMemo(() => [...(replay?.moves ?? [])].sort((a, b) => b.savedH - a.savedH), [replay]);
  const shown = all ? moves : moves.slice(0, MOVES_SHOWN);
  // The first sentence of what the replay says is the headline's: the rest
  // (what sets the finish) goes under it, never the same number twice.
  const rest = replay ? replay.said.replace(/^Same crews, same work, better timed: [^\n]*?sooner\.\s*/, "") : "";
  const limits = replay?.limits ?? [];
  const flip = (id: string) => setOut((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:p-4 space-y-3" data-replay>
      <div>
        <h3 className="text-section font-semibold text-[var(--color-text)]">Same people, same work, better sequence</h3>
        {!replay ? (
          <p className="mt-1 text-reading text-[var(--color-text)]">The record couldn&apos;t be replayed.</p>
        ) : !ran ? (
          <p className="mt-1 text-reading text-[var(--color-text)]">{replay.said}{finished?.length ? <> {finished.join(" and ")} {finished.length === 1 ? "is" : "are"} finished: pick {finished.length === 1 ? "it" : "one"} under Showing at the top to replay {finished.length === 1 ? "it" : "that phase"}.</> : null}</p>
        ) : replay.savedH > 0 ? (
          <p className="mt-1 text-reading text-[var(--color-text)]" data-replay-answer>
            Could have finished <b className="font-medium">{when(replay.replayFinish, tz)}</b>, <b className="text-title font-bold tabular-nums whitespace-nowrap text-[var(--color-text)]">{hoursDays(replay.savedH)}</b> sooner
          </p>
        ) : (
          <p className="mt-1 text-reading font-medium text-[var(--color-text)]" data-replay-answer>The record shows no way to finish sooner with the same crews</p>
        )}
        {ran && (
          <div className="mt-0.5 flex items-start gap-1">
            <p className="min-w-0 text-body text-[var(--color-text-muted)]">{replay!.savedH > 0 && replay!.actualFinish != null ? `It really finished ${when(replay!.actualFinish, tz)}. ` : ""}{replay!.savedH > 0 ? rest : replay!.said}</p>
            <HelpTooltip placement="left">{REPLAY_RULES}</HelpTooltip>
          </div>
        )}
        {ran && replay!.notDone.length > 0 && (
          <p className="mt-0.5 text-body text-[var(--color-text)]" data-not-done>
            {replay!.notDone.join("; ")} {replay!.notDone.length === 1 ? "isn't" : "aren't"} marked done: kept as {replay!.notDone.length === 1 ? "it" : "they"} ran, to {replay!.notDone.length === 1 ? "its" : "their"} last logged shift.
          </p>
        )}
      </div>

      {ran && (moves.length ? (
        <div>
          <div className="text-body font-medium text-[var(--color-text-muted)]">What moves, most hours saved first <span className="font-normal">· {moves.length}</span></div>
          <ul className="mt-1 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {shown.map((m) => (
              <li key={m.stepId} className="py-2" data-move={m.stepId}>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <b className="font-medium text-body text-[var(--color-text)]">{m.stepName}</b>
                  <span className="text-caption text-[var(--color-text-muted)]">{m.order} · {m.crew}</span>
                  <span className={`ml-auto text-body font-medium tabular-nums whitespace-nowrap ${m.savedH < 0 ? "text-[var(--state-held-text)]" : "text-[var(--color-text)]"}`}>{m.savedH > 0 ? `${hoursDays(m.savedH)} sooner` : m.savedH < 0 ? `${hoursDays(-m.savedH)} later` : "same finish"}</span>
                </div>
                <div className="text-caption text-[var(--color-text)]">was {when(m.wasStart, tz)} → could start {when(m.nowStart, tz)}</div>
                <p className="text-caption text-[var(--color-text-muted)]">{m.why}</p>
              </li>
            ))}
          </ul>
          {moves.length > MOVES_SHOWN && (
            <button type="button" onClick={() => setAll(!all)} className="mt-1 min-h-10 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-accent-text)] hover:underline cursor-pointer">
              {all ? `Show the top ${MOVES_SHOWN}` : `Show all ${moves.length}`}
            </button>
          )}
        </div>
      ) : <p className="text-body text-[var(--color-text-muted)]">No step could have started sooner with the same crews.</p>)}

      {ran && delays.length > 0 && (
        <div data-one-off>
          <div className="text-body font-medium text-[var(--color-text-muted)]">One-off delays <span className="font-normal">· tick one to see the finish without it</span></div>
          <ul className="mt-1">
            {delays.map((d) => (
              <li key={d.id}>
                <label className="flex items-start gap-2 min-h-10 pointer-coarse:min-h-11 py-1 text-body text-[var(--color-text)] cursor-pointer">
                  <input type="checkbox" checked={out.includes(d.id)} onChange={() => flip(d.id)} className="mt-0.5 w-4 h-4 shrink-0 accent-[var(--color-accent)]" />
                  <span className="min-w-0">
                    {d.short} <span className="text-[var(--color-text-muted)] tabular-nums whitespace-nowrap">· {hoursDays(d.hours)}</span>
                    {d.said && <span className="block text-caption text-[var(--color-text-muted)]">Written: &ldquo;{d.said}&rdquo;</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {whatIf && (
            <p role="status" className="mt-1 text-body text-[var(--color-text)]" data-what-if>
              {whatIf.savedH > 0 && whatIf.finishWithout != null
                ? <>Without {whatIf.without.length === 1 ? "it" : `these ${whatIf.without.length}`}: <b className="font-medium">{when(whatIf.finishWithout, tz)}</b>, <b className="font-medium">{hoursDays(whatIf.savedH)} sooner</b>{whatIf.finishWith != null ? <span className="text-[var(--color-text-muted)]"> (with {whatIf.without.length === 1 ? "it" : "them"}: {when(whatIf.finishWith, tz)})</span> : null}</>
                : whatIf.said}
              {whatIf.finishWithout != null && planFinish != null && (() => {
                const late = (whatIf.finishWithout - planFinish) / 3_600_000;
                return <span className="block font-medium" data-what-if-plan>Against the planned finish ({when(planFinish, tz)}): {late >= 0.5 ? `${hoursDays(r1(late))} late` : late <= -0.5 ? `${hoursDays(r1(-late))} early` : "on time"}.</span>;
              })()}
            </p>
          )}
        </div>
      )}

      {limits.length > 0 && (
        <div>
          {/* Folded, with its count: what the replay can't know. */}
          <button type="button" onClick={() => setLimitsOpen(!limitsOpen)} aria-expanded={limitsOpen}
            className="inline-flex items-center gap-1.5 min-h-10 pointer-coarse:min-h-11 -ml-1 px-1 rounded-md text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <ChevronRight aria-hidden className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${limitsOpen ? "rotate-90" : ""}`} />
            What the replay can&apos;t know <span className="font-normal text-[var(--color-text-muted)]">· {limits.length}</span>
          </button>
          {limitsOpen && <ul className="mt-1 list-disc pl-5 space-y-1 text-caption text-[var(--color-text)]">{limits.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}

const REPLAY_RULES = `This year replayed on what really happened: each step takes the shifts it was really worked, on its crew's real days or nights. ${CAPACITY_RULE} Only the links the work really needed are kept. A trip off site keeps its real time, and a wait with a recorded reason (parts, material, vendor, inspection, permit, weather, a hold) keeps its real length. Found and added work starts no sooner than it really did. The shutdown stays as it ran; start-up starts once every work order is done. Only waits with nothing logged and no reason, and shifts a step sat ready while its crew had room, are taken out.`;

// ── Suggested for next time ──────────────────────────────────────────────

function NextView(p: Props & { built: ReturnType<typeof buildAsBuilt>; work: AsBuiltWork; notes: MilestoneNote[]; plan: NextPlan; colorOf: (c: string) => string; changes: PlanChange[]; applied: PlanChange[]; check: PlanCheck; risks: PlanRisk[]; lessons: Lesson[]; skipped: Set<string>; settings: NextPlanSettings; onChanges: (c: PlanChange[]) => void; onStaffing: (s: NextPlanSettings["staffing"]) => void }) {
  const { tz, times, built, work, plan, changes } = p;
  const PX = React.useContext(PxCtx);
  const { x, width } = useAxis(plan);
  const dayOf = (t: number) => dayNumber(plan, t, tz);
  const dayLabel = (t: number) => `Day ${dayOf(t)}`;
  const at = (t: number) => `Day ${dayOf(t)} · ${fmtInTz(t, tz, { weekday: "short" })} ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;
  const orderName = useMemo(() => new Map(built.orders.map((o) => [o.key, o.name])), [built]);
  const actName = useMemo(() => new Map(plan.acts.map((a) => [a.id, a.name])), [plan]);
  // Same people, same work, better sequence: first, before anything is added.
  // The phase picked at the top: its steps only, as the rest of the page.
  const phaseIds = useMemo(() => {
    if (!p.phase || !p.phases.length) return null;
    const idx = phaseIndex(p.milestones, p.phases);
    return built.orders.flatMap((o) => o.steps.map((s) => s.id)).filter((id) => idx.get(id) === p.phase);
  }, [p.phase, p.phases, p.milestones, built]);
  const replayInput = useMemo<ReplayInput>(() => ({ built, work, milestones: p.milestones, tz, times, notes: p.notes, phaseIds }), [built, work, p.milestones, tz, times, p.notes, phaseIds]);
  const replay = useMemo(() => safeReplay(replayInput), [replayInput]);
  const delays = useMemo(() => { try { return oneOffDelays(replayInput); } catch { return []; } }, [replayInput]);
  const sayReplay = replayWords(replay, tz);
  // The planned finish of what's shown: its planned steps' latest finish.
  const scopePlanFinish = useMemo(() => {
    const ids = phaseIds ? new Set(phaseIds) : null;
    const xs = built.orders.flatMap((o) => o.steps).filter((s) => (!ids || ids.has(s.id)) && s.inPlan && s.planFinish != null).map((s) => s.planFinish as number);
    return xs.length ? Math.max(...xs) : null;
  }, [built, phaseIds]);
  // All phases shown and the job not finished: which phases can be replayed
  // on their own (each one run, not guessed).
  const finished = useMemo(() => {
    if (p.phase || !p.phases.length || !replay || replay.replayFinish != null) return [];
    const idx = phaseIndex(p.milestones, p.phases);
    const ids = built.orders.flatMap((o) => o.steps.map((s) => s.id));
    return p.phases.filter((ph) => {
      const mine = ids.filter((id) => idx.get(id) === ph.id);
      return mine.length > 0 && safeReplay({ ...replayInput, phaseIds: mine })?.replayFinish != null;
    }).map((ph) => ph.name);
  }, [p.phase, p.phases, p.milestones, built, replay, replayInput]);
  const driving = useMemo(() => new Set(plan.driving), [plan]);
  const crewWork = useMemo(() => new Map(work.crews.map((c) => [c.crew, c])), [work]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const flip = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  // Tell the schedule.
  const [text, setText] = useState("");
  // What's typed comes back after a reload until the change is kept.
  useDraft<string>(p.canEdit ? `tell-schedule:${p.projectId}:${p.phase ?? "all"}` : null, text, setText, (v) => !v.trim());
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
      const after = r.changes.length ? nextPlan({ ...input, changes: [...p.applied, ...r.changes] }) : null;
      const wantsSooner = /critical|asap|as soon|sooner|faster|finish|pull in|speed/i.test(said);
      const lever = wantsSooner && (!after || after.finish >= plan.finish - 30 * 60_000) ? finishLever({ ...input, changes: [...p.applied, ...r.changes] }, after ?? plan) : null;
      setAnswer({ ...r, finish: after?.finish ?? null, lever: lever ? { ...lever, change: { ...lever.change, id: `l${Date.now().toString(36)}`, said } } : null });
    } catch (e) { setAnswer({ understood: "", changes: [], question: null, finish: null, lever: null, err: sayError(e) }); }
    finally { setBusy(false); }
  };
  const keep = (list: PlanChange[]) => { p.onChanges([...changes, ...list]); setAnswer(null); setText(""); };

  const finishWords = (f: number) => { const d = (plan.finish - f) / 3_600_000; return Math.abs(d) < 0.5 ? "no change to the finish" : `${r1(Math.abs(d))} h ${d > 0 ? "sooner" : "later"}`; };
  const drivingOrders = [...new Set(plan.driving.map((id) => plan.acts.find((a) => a.id === id)?.order).filter(Boolean) as string[])].map((o) => orderName.get(o) ?? o);

  // A crew's contractor and its staffing plan (by the contractor's name).
  const planOf = (crew: string): { co: string; plan: StaffingPlan | null; plant: boolean } => {
    const co = crewWork.get(crew)?.company ?? crew;
    const hit = Object.entries(p.settings.staffing).find(([k]) => k.toLowerCase() === co.toLowerCase() || k.toLowerCase() === crew.toLowerCase());
    return { co, plan: hit?.[1] ?? null, plant: /\(\s*KE\s*\)$/i.test(crew) || /^kern/i.test(co) };
  };
  const trusted = p.check.can && p.check.ok;

  const byOrder = new Map<string, NextPlan["acts"]>();
  for (const a of plan.acts) { if (!byOrder.has(a.order)) byOrder.set(a.order, []); byOrder.get(a.order)!.push(a); }
  const orders = [...byOrder.entries()].sort((a, b) => Math.min(...a[1].map((x) => x.start)) - Math.min(...b[1].map((x) => x.start)));
  const kinds = plan.acts.reduce((m, a) => { m[a.kind] = (m[a.kind] ?? 0) + 1; return m; }, {} as Record<string, number>);
  const planFin = built.planFinish;
  const lines = <>{planFin != null && <i aria-hidden title="This year's planned finish" className="absolute top-0 bottom-0 border-l-2 border-[var(--state-overdue)]" style={{ left: x(planFin) }} />}<i aria-hidden title="Suggested finish" className="absolute top-0 bottom-0 border-l-2 border-dashed border-blue-600" style={{ left: x(plan.finish) }} /></>;
  // What kind of change each activity is: plain tags, the word says it.
  const TAG = "border border-[var(--color-border-strong)] text-[var(--color-text)]";
  const KIND: Record<string, [string, string]> = { new: ["New", TAG], found: ["Added scope", TAG], shorter: ["Shorter", TAG], split: ["Split", TAG], changed: ["Changed", TAG] };
  const mine = changes.filter((c) => c.kind !== "heads" && c.kind !== "skip");

  return (
    <div className="space-y-2">
      <ReplaySection input={replayInput} replay={replay} delays={delays} tz={tz} finished={finished} planFinish={scopePlanFinish} />
      <div className="pt-3" data-adds>
        <h3 className="text-section font-semibold text-[var(--color-text)]">If it still misses the target: added people or time</h3>
        <p className="mt-0.5 text-body text-[var(--color-text-muted)]">{sayReplay} The suggested schedule below is worked out on its own from this year&apos;s record; each change it makes is listed with what it does.</p>
      </div>
      <Taught {...p} at={at} orderName={(k) => orderName.get(k) ?? k} replayWords={sayReplay} />
      {p.canEdit && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2">
          <div className="font-medium text-body">Tell the schedule</div>
          <div className="flex gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }} placeholder='"V-7 is critical path, start it as soon as possible", "Ancon has 2 crews on nights", "PSV-021 needs 6 hours"'
              aria-label="Tell the schedule" className="flex-1 min-w-0 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] px-3 py-2 text-body text-[var(--color-text)]" />
            <button type="button" onClick={() => void send()} disabled={busy || !text.trim() || !p.orgId} className={btnQuiet}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} {busy ? "Sending" : "Send"}</button>
          </div>
          {answer && (
            <div className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-caption space-y-1.5">
              {answer.err && <p className="text-[var(--state-overdue-text)]">{answer.err}</p>}
              {answer.question && <p><b>{answer.question}</b></p>}
              {answer.understood && <p>{answer.understood}</p>}
              {answer.changes.length > 0 && <ul className="list-disc pl-5">{answer.changes.map((c) => <li key={c.id}>{describe(c, orderName, actName, dayOf)}</li>)}</ul>}
              {answer.finish != null && <p>Finish: <b>{at(plan.finish)}</b> to <b>{at(answer.finish)}</b>, {finishWords(answer.finish)}.</p>}
              {answer.lever && (
                <p><b>{answer.finish != null && answer.finish < plan.finish - 30 * 60_000 ? "Also" : "What pulls the finish in"}:</b> {answer.lever.change.kind === "nights" ? `run ${answer.lever.acts} day-shift activities on the finish path (${drivingOrders.slice(0, 3).join(", ")}) on nights too, ${answer.lever.hours} h of work, with the night shift already on site (no one added)` :`let ${orderName.get((answer.lever.change as { target: { order?: string } }).target.order ?? "") ?? "it"} start as soon as its links allow`}. Finish {at(answer.lever.finish)}, {answer.lever.savedH} h sooner. <span className="text-[var(--color-text-muted)]">{sayReplay}</span></p>
              )}
              {!answer.changes.length && !answer.lever && !answer.err && !answer.question && <p>Nothing to change for that. The finish is set by {drivingOrders.slice(0, 3).join(", ")}.</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                {answer.lever && <button type="button" onClick={() => keep([...answer.changes, answer.lever!.change])} className={btnPri}><Check className="w-4 h-4" /> {answer.changes.length ? "Do both" : "Do it"}</button>}
                {answer.changes.length > 0 && <button type="button" onClick={() => keep(answer.changes)} className={answer.lever ? btnQuiet : btnPri}><Check className="w-4 h-4" /> {answer.lever ? "Only what I said" : "Do it"}</button>}
                <button type="button" onClick={() => setAnswer(null)} className={btnQuiet}><X className="w-4 h-4" /> No</button>
              </div>
            </div>
          )}
          {!p.orgId && <p className="text-caption text-[var(--color-text-muted)]">Needs the project&apos;s workspace to talk to the schedule.</p>}
        </div>
      )}

      {mine.length > 0 && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="font-medium text-caption mb-1">Your changes ({mine.length})</div>
          <ul className="space-y-1 text-caption">
            {mine.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                <span className="flex-1">{describe(c, orderName, actName, dayOf)}{c.said ? <span className="text-[var(--color-text-muted)]"> · from &quot;{c.said.slice(0, 120)}&quot;</span> : null}</span>
                {p.canEdit && <button type="button" onClick={() => p.onChanges(changes.filter((x) => x.id !== c.id))} className="cursor-pointer inline-flex items-center justify-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--state-overdue-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"><Undo2 className="w-3.5 h-3.5" /> Undo</button>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-caption">
        <Chip>Suggested finish <b>{at(plan.finish)}</b>{!trusted && <span className="font-medium text-[var(--state-held-text)]"> {p.check.can ? "not reliable yet" : "not checked yet"}</span>}</Chip>
        {built.planFinish != null && <Chip>This year: planned <b>{at(built.planFinish)}</b>{built.finish != null && <>, actual <b>{at(built.finish)}</b></>}</Chip>}
        <Chip><b>{plan.acts.length + plan.pre.length}</b> activities{Object.entries(kinds).filter(([k]) => k !== "same").map(([k, n]) => ` · ${n} ${(KIND[k]?.[0] ?? k).toLowerCase()}`).join("")}{plan.pre.length ? ` · ${plan.pre.length} before the shutdown` : ""}</Chip>
        <Chip><CalendarClock className="w-3.5 h-3.5 inline mr-1" />Sets the finish: {drivingOrders.slice(0, 3).join(", ")}</Chip>
      </div>
      <Legend items={[[{ background: "var(--color-main)" }, "Crew's work: each piece of a work order's bar is one activity"], [{ background: "var(--color-surface)", boxShadow: "0 0 0 1.5px var(--state-held)" }, "Not in this year's plan"], [{ background: "color-mix(in srgb, var(--state-overdue) 12%, var(--color-surface))", boxShadow: "0 0 0 1.5px var(--state-overdue)" }, "Sets the finish"], [{ borderLeft: "2px solid var(--state-overdue)", width: 2 }, "This year's planned finish"], [{ borderLeft: "2px dashed var(--color-main)", width: 2 }, "Suggested finish"]]} />

      <FoldAll open={open.size} total={orders.length} onAll={(all) => setOpen(all ? new Set(orders.map(([k]) => k)) : new Set())} />
      <div className="overflow-auto max-h-[75vh] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className={`border-separate border-spacing-0 w-max text-caption ${p.cols ? "" : "[&_.col-x]:hidden"}`}>
          <thead className="sticky top-0 z-[4] bg-[var(--color-surface-2)]">
            <tr className="text-caption text-[var(--color-text-muted)] text-left">
              <th className={`${cellAct} !bg-[var(--color-surface-2)] z-[5]`}>Activity</th>
              <th className="col-x px-1 font-medium text-center">Hours</th><th className="col-x px-2 font-medium">Start</th><th className="col-x px-2 font-medium">Finish</th>
              <th className="p-0"><Header shifts={plan.shifts} tz={tz} dayLabel={dayLabel} /></th>
            </tr>
          </thead>
          <tbody>
            {plan.pre.length > 0 && <SectionRow4 title="Before the shutdown" sub="bookings and materials" width={width} shifts={plan.shifts} />}
            {plan.pre.map((a) => (
              <tr key={a.id}><td className={cellAct}><div className="font-medium">{a.name} <span className="rounded bg-transparent px-1 text-caption font-medium text-[var(--state-released-text)]">New</span></div>{a.basis && <div className="text-caption text-[var(--color-text-muted)]">{a.basis}</div>}</td><td className={cellN}>-</td><td className={cellDt}>Before Day 1</td><td className={cellDt} /><td className="p-0"><div className="relative h-10" style={{ width }}><Grid shifts={plan.shifts} /><span className="absolute left-1.5 top-2.5 rounded bg-transparent px-1.5 text-caption font-medium text-[var(--state-released-text)]">before the shutdown</span></div></td></tr>
            ))}
            {orders.map(([key, acts]) => {
              const s0 = Math.min(...acts.map((a) => a.start)), s1 = Math.max(...acts.map((a) => a.finish));
              const crit = acts.some((a) => driving.has(a.id));
              const changed = acts.filter((a) => a.kind !== "same" || a.changedBy?.length).length;
              const isOpen = open.has(key);
              const bar = pieces(acts.filter((a) => a.finish > a.start).flatMap((a) => shiftParts(a, plan.shifts).map(([s0, s1], i, all) => ({
                key: `${a.id}:${i}`, from: s0, to: s1, color: p.colorOf(a.crew), label: all.length === 1 || (s1 - s0) === Math.max(...all.map(([q0, q1]) => q1 - q0)) ? `${r1(a.hours)} h` : undefined,
                ring: driving.has(a.id) ? "0 0 0 1.5px var(--state-overdue)" : a.kind === "new" || a.kind === "found" ? "0 0 0 1.5px var(--state-held)" : undefined,
                title: `${a.name} · ${a.crew} · ${at(a.start)} to ${at(a.finish)} · ${r1(a.hours)} h, ${a.cal === "both" ? "days and nights" : a.cal === "night" ? "nights" : "days"}${driving.has(a.id) ? " · sets the finish" : ""}`,
              }))), x, 8);
              const bo = built.orders.find((o) => o.key === key);
              return (
                <React.Fragment key={key}>
                  <tr className="bg-[var(--color-surface-2)]" data-order={key}>
                    <td className={`${cellAct} !bg-[var(--color-surface-2)]`}>
                      <OrderName open={isOpen} onToggle={() => flip(key)}>
                        <div className="font-medium text-caption">{orderName.get(key) ?? key}{crit && <span className="ml-1 rounded bg-transparent px-1 text-caption font-medium text-[var(--state-overdue-text)]">Sets the finish</span>}</div>
                        {bo?.foundOn && <div className="text-caption font-medium text-[var(--color-text-muted)]">Found on {bo.foundOn}</div>}
                        <div className="text-caption text-[var(--color-text-muted)]">{acts.length} activit{acts.length === 1 ? "y" : "ies"} · {r1(acts.reduce((n, a) => n + a.hours, 0))} h{changed ? ` · ${changed} changed` : ""}</div>
                      </OrderName>
                    </td>
                    <td className={cellN}>{r1(acts.reduce((n, a) => n + a.hours, 0))}</td><td className={cellDt}>{at(s0)}</td><td className={cellDt}>{at(s1)}</td>
                    <td className="p-0"><div className="relative" style={{ width, height: Math.max(44, 8 + bar.h + 4) }}><Grid shifts={plan.shifts} />{bar.nodes}{lines}</div></td>
                  </tr>
                  {isOpen && [...acts].sort((a, b) => a.start - b.start).map((a) => {
                    const k = KIND[a.kind];
                    const isCrit = driving.has(a.id);
                    return (
                      <tr key={a.id} className={isCrit ? "[&>td:first-child]:shadow-[inset_3px_0_0_var(--state-overdue)]" : ""}>
                        <td className={`${cellAct} ${isCrit ? "!bg-transparent dark:!bg-[var(--state-overdue)]" : ""}`}>
                          <div className="font-medium">{a.name}{k && <span className={`ml-1 rounded px-1 text-caption font-medium ${k[1]}`}>{k[0]}</span>}{a.heldForCrew && <span className="ml-1 rounded bg-transparent px-1 text-caption font-medium text-[var(--state-held-text)]">Waits for its crew</span>}</div>
                          <div className="text-caption text-[var(--color-text-muted)]"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(a.crew) }} />{a.crew} · {r1(a.hours)} h · {a.cal === "both" ? "days and nights" : a.cal === "night" ? "nights" : "days"}</div>
                          {a.basis && a.kind !== "found" && <div className="text-caption text-[var(--color-text-muted)]">{a.basis}</div>}
                          {a.waitedForCrew && <div className="text-caption text-[var(--color-text-muted)]">This year it waited {a.waitedForCrew.shifts} shift{a.waitedForCrew.shifts === 1 ? "" : "s"} for {a.waitedForCrew.crew}{a.waitedForCrew.busyOn.length ? ` (on ${[...new Set(a.waitedForCrew.busyOn.map((b) => b.split(" - ")[0]))].join(", ")})` : ""}. See {a.waitedForCrew.crew} under Crews below.</div>}
                        </td>
                        <td className={cellN}>{r1(a.hours)}</td><td className={cellDt}>{at(a.start)}</td><td className={cellDt}>{at(a.finish)}</td>
                        <td className="p-0"><div className="relative h-11" style={{ width }}><Grid shifts={plan.shifts} />
                          {shiftParts(a, plan.shifts).map(([s0, s1], i) => <i key={i} title={`${a.name}: ${r1(a.hours)} h, ${a.cal === "both" ? "days and nights" : a.cal === "night" ? "nights" : "days"}`} className="absolute top-3 h-4 rounded-sm" style={{ left: x(s0) + 1, width: Math.max(3, x(s1) - x(s0) - 2), background: p.colorOf(a.crew), boxShadow: a.kind === "new" || a.kind === "found" ? "0 0 0 2px var(--color-surface), 0 0 0 3.5px var(--state-held)" : undefined }} />)}{lines}</div></td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
            <SectionRow4 title="Crews" sub="each crew's size, held from its first shift to its last (the line), and under it what its work takes each shift: hands for a crew held by hands, jobs going at once for one held by jobs at a time. Never more than the line. Amber: a contractor on site with nothing to do." width={width} shifts={plan.shifts} />
            {Object.keys(plan.load).filter((c) => c !== "Off site" && c !== "Not set").sort((a, b) => plan.load[b].reduce((n, h) => n + h, 0) - plan.load[a].reduce((n, h) => n + h, 0)).map((crew) => {
              const jobs = plan.jobs[crew] ?? [];
              const size = plan.sizes[crew] as CrewSize | undefined;
              const byHands = !!size?.hands;
              const works = size?.works ?? { day: true, night: true };
              const busy = jobs.map((n) => n > 0);
              const first = busy.indexOf(true), last = busy.lastIndexOf(true);
              const sp = planOf(crew);
              // A contractor on site with nothing to do is paid to stand by; plant crews have their other work.
              const onSite = (i: number) => !sp.plant && i >= first && i <= last && works[plan.shifts[i].kind === "night" ? "night" : "day"];
              const idle = plan.shifts.filter((_, i) => onSite(i) && !jobs[i]).length;
              const sum = sp.plan ? summaryOver(sp.plan, plan.shifts.map(shiftKey)) : null;
              const days = first >= 0 ? `${dayLabel(plan.shifts[first].start)} to ${dayLabel(plan.shifts[last].start)}` : "";
              const warn = size ? rampWarning(sp.co, size, dayOf, dayOf(plan.finish)) : null;
              const mineSet = changes.filter((c) => (c.kind === "jobs" || c.kind === "crew") && c.crew === crew);
              // Each shift: hands its work takes (held by hands) or jobs going at once.
              const cell = (i: number) => (byHands ? plan.heads[crew]?.[i] ?? 0 : jobs[i] ?? 0);
              const sizeOf = (i: number) => (byHands ? size!.hands![plan.shifts[i].kind === "night" ? "night" : "day"] : size?.jobs ?? null);
              return (
                <tr key={`cr${crew}`} data-crew={crew}>
                  <td className={cellAct}>
                    <div className="font-medium"><b className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: p.colorOf(crew) }} />{crew}</div>
                    {size && <div className="text-caption font-medium text-[var(--color-text)]" data-crew-size>{sizeWords(size)}{size.hands ? "" : works.night ? (works.day ? ", days and nights" : ", nights") : ", days"}{days ? `, ${days}` : ""}</div>}
                    {size && <div className="text-caption text-[var(--color-text-muted)]">{sourceWords(size, sp.co, dayLabel)}</div>}
                    {warn && <div role="note" className="mt-0.5 border-l-2 border-[var(--state-held)] pl-1.5 text-caption text-[var(--state-held-text)]" data-ramp>{warn}</div>}
                    {idle > 0 && <div className="text-caption font-medium text-[var(--state-held-text)]">{idle} shift{idle === 1 ? "" : "s"} on site with nothing to do</div>}
                    {sp.plant ? <div className="text-caption text-[var(--color-text-muted)]">Kern Energy crew: no contractor staffing plan.</div>
                      : sum ? <div className="text-caption text-[var(--color-text-muted)]">Staffing plan ({sp.plan!.file || "typed in"}). <button type="button" onClick={() => openContractor(sp.co)} className="text-[var(--color-accent-text)] hover:underline cursor-pointer">Open it</button></div>
                      : <div className="text-caption text-[var(--color-text-muted)]">No staffing plan yet. <button type="button" onClick={() => openContractor(sp.co)} className="text-[var(--color-accent-text)] hover:underline cursor-pointer">Put in {sp.co}&apos;s</button></div>}
                    {p.canEdit && size && <CrewSizeEdit crew={crew} size={size} pace={plan.pace[crew]?.mh ?? null} mine={mineSet.length > 0}
                      onSave={(c) => p.onChanges([...changes.filter((x) => !mineSet.includes(x)), c])} onClear={() => p.onChanges(changes.filter((x) => !mineSet.includes(x)))} />}
                  </td>
                  <td className={cellN}>{size ? (byHands ? [size.hands!.day, size.hands!.night].filter((n) => n != null).join(" / ") : size.jobs) : "-"}<div className="text-caption font-normal text-[var(--color-text-muted)]">{byHands ? "hands held" : "jobs at a time"}</div></td><td className="col-x" /><td className="col-x" />
                  <td className="p-0"><div className="relative h-[52px]" style={{ width }}><Grid shifts={plan.shifts} />
                    {size && first >= 0 && (
                      // The size, flat from its first shift to its last.
                      <span aria-hidden className="absolute top-1 h-[16px] rounded-sm border-t-2 text-caption font-medium leading-[13px] pl-1 whitespace-nowrap overflow-hidden text-[var(--color-text)] bg-[var(--color-surface-2)]"
                        style={{ left: first * PX + 1, width: Math.max(PX - 2, (last - first + 1) * PX - 2), borderColor: p.colorOf(crew) }} title={`${crew}: ${sizeWords(size)}, ${days}`}>{sizeWords(size)}</span>
                    )}
                    {plan.shifts.map((w, i) => {
                      const n = jobs[i] ?? 0;
                      if (!n && !onSite(i)) return null;
                      const v = cell(i), cap = sizeOf(i);
                      const plannedHands = sp.plan?.shifts[shiftKey(w)]?.direct;
                      return (
                        <span key={i} title={`${dayLabel(w.start)} ${w.kind}: ${n ? `${n} job${n === 1 ? "" : "s"} going at once, ${Math.round(plan.load[crew]?.[i] ?? 0)} h of work${byHands ? `, about ${v} of the ${cap} on the tools` : cap != null ? ` (held at ${cap} at a time)` : ""}` : "on site, nothing to do"}${plannedHands != null ? `; staffing plan ${plannedHands} on the tools` : ""}`}
                          className={`absolute top-[22px] h-6 rounded border text-center text-caption font-medium leading-[22px] ${!n ? "bg-transparent border-[var(--color-border)] text-[var(--state-held-text)]" : "text-white border-transparent"}`}
                          style={{ left: i * PX + 2, width: PX - 4, background: n ? p.colorOf(crew) : undefined }}>{n ? v : 0}</span>
                      );
                    })}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-caption text-[var(--color-text)]">
        <b>How it&apos;s built.</b> This year&apos;s activities and crews, in the order they were really done: a link the crews didn&apos;t wait on gives way to what that work waited on, and a work order&apos;s steps done before a step started come first. Nights as this year really ran: a crew that worked a work order on two or more nights works it days and nights, otherwise days, 12-hour shifts; the shutdown and start-up run around the clock. Planned start dates are the earliest each can start, or when it really started if sooner. Missed scope added this year is in; work found by inspection is not planned, it shows as a risk above with what it would do to the finish. An activity done inside fewer shifts than its plan gets that length; nothing is made longer from a guess. Start-up begins once every work order is done. {CREW_RULE} What this job taught (the box at the top) goes in: time off site at the clock time it really took, with what gets it out moved to first thing. The check at the top runs this year back through these same rules with each step at the length it really took; the schedule is trusted only when that lands within {CHECK_H} hours of the real finish.
      </div>
    </div>
  );
}

const AREA_WORD: Record<Lesson["area"], string> = { logistics: "Logistics", contractors: "Contractors", planning: "Planning" };

/** What this job taught, put into the suggested schedule, and what it
 *  takes to make this year's target. */
function Taught(p: Props & { built: ReturnType<typeof buildAsBuilt>; work: AsBuiltWork; plan: NextPlan; changes: PlanChange[]; applied: PlanChange[]; check: PlanCheck; risks: PlanRisk[]; lessons: Lesson[]; skipped: Set<string>; onChanges: (c: PlanChange[]) => void; at: (t: number) => string; orderName: (k: string) => string;
  /** How far the same crews got by sequence alone (the replay), said before any lever that adds people, nights or time. */
  replayWords?: string }) {
  const { built, work, plan, tz, times, lessons, skipped } = p;
  const input = useMemo(() => ({ built, work, milestones: p.milestones, tz, times }), [built, work, p.milestones, tz, times]);
  const person = useMemo(() => { const mine = new Set(lessons.flatMap((l) => l.changes.map((c) => c.id))); return p.applied.filter((c) => !mine.has(c.id)); }, [p.applied, lessons]);
  const effects = useMemo(() => lessonEffects(input, lessons, skipped, person, plan), [input, lessons, skipped, person, plan]);
  const target = built.planFinish;
  const { orderName } = p;
  const reach = useMemo(() => (target != null ? toTarget(input, p.applied, plan, target, orderName) : null), [input, p.applied, plan, target, orderName]);
  const { check, risks } = p;
  const trusted = check.can && check.ok;
  const [allRisks, setAllRisks] = useState(false);
  const moving = risks.filter((r) => r.finishH >= 0.5), still = risks.filter((r) => r.finishH < 0.5);
  const offWord = (h: number) => (Math.abs(h) < 0.5 ? "the same time" : `${r1(Math.abs(h))} h ${h < 0 ? "before" : "after"} it`);
  const lateH = target != null ? r1((plan.finish - target) / 3_600_000) : null;
  const byId = new Map(plan.acts.map((a) => [a.id, a]));
  const pathOrders = [...new Set(plan.driving.map((id) => byId.get(id)?.order).filter((o): o is string => !!o))].map(orderName);
  const offPath = plan.driving.map((id) => byId.get(id)).find((a) => a && a.crew === "Off site");
  const skip = (id: string, out: boolean) => p.onChanges(out ? [...p.changes, { id: `skip:${id}`, said: "", at: 0, kind: "skip", lesson: id }] : p.changes.filter((c) => !(c.kind === "skip" && c.lesson === id)));
  const effectWord = (h: number | undefined) => (h == null ? "" : Math.abs(h) < 0.5 ? "no change to the finish" : h > 0 ? `${r1(h)} h sooner` : `${r1(-h)} h later`);
  return (
    <section className="rounded-xl border-2 border-[var(--color-text)] bg-[var(--color-surface)] p-3 sm:p-4 space-y-3" data-taught>
      <div>
        <div className={`border-l-2 pl-3 py-1 text-caption text-[var(--color-text)] ${trusted ? "border-[var(--state-released)]" : "border-[var(--state-held)]"}`} data-check={trusted ? "ok" : check.can ? "off" : "none"}>
          {check.can ? (
            <><b>{trusted ? "Checked against this year." : "Not reliable yet."}</b> This year run back through these rules, each step at the length it really took and the found work in, lands {p.at(check.replay!)}; it really finished {p.at(check.actual!)} ({offWord(check.offH!)}). {trusted ? `Within ${CHECK_H} h, so the rules hold for this job.` : `More than ${CHECK_H} h apart, so the finish below is not a promise.`}
              {!trusted && check.gap && <span className="block mt-1">Where they part: <b>{check.gap.name}</b> ({check.gap.order}) started {p.at(check.gap.start)}, {r1(Math.abs(check.gap.hours))} h {check.gap.hours >= 0 ? "after" : "before"} {check.gap.after} finished; the rules start it right away. If work went on in between, add it to {check.gap.order} with its times and this check runs again with it. If it only waited, that wait is something the schedule can&apos;t see coming.</span>}</>
          ) : (
            <><b>Not checked yet.</b> The check runs this year back through these rules once every step is done, and holds it against the real finish. Until then the finish below is not a promise.</>
          )}
        </div>
        <div className="mt-3 text-body font-medium text-[var(--color-text-muted)]">What this job taught, put in</div>
        {trusted && target != null && lateH != null && (
          lateH <= 0.5 ? (
            <p className="mt-1 text-reading font-medium leading-snug text-[var(--color-text)]">{lateH < -0.5 ? `Makes this year's target: finishes ${p.at(plan.finish)}, ${r1(-lateH)} h before the plan's ${p.at(target)}.` : `Makes this year's target: ${p.at(target)}.`} <span className="font-medium text-[var(--color-text-muted)]">This year it {built.finish != null ? `finished ${p.at(built.finish)}` : "is not finished"}.</span></p>
          ) : reach && reach.shortH <= 0.5 && reach.levers.length ? (
            <div className="mt-1 space-y-1.5">
              <p className="text-reading font-medium leading-snug text-[var(--color-text)]">Misses this year&apos;s target ({p.at(target)}) by {lateH} h. {reach.levers.length === 1 ? "This makes it" : `These ${reach.levers.length} make it`}:</p>
              {p.replayWords && <p className="text-body text-[var(--color-text-muted)]" data-replay-first>{p.replayWords}</p>}
              <ol className="list-decimal pl-5 text-body space-y-0.5">{reach.levers.map((l) => <li key={l.change.id}>{l.words}: <b>{r1(l.savedH)} h sooner</b></li>)}</ol>
              {p.canEdit && <button type="button" onClick={() => p.onChanges([...p.changes, ...reach.levers.map((l, i) => ({ ...l.change, id: `t${Date.now().toString(36)}${i}`, said: "to make the target", at: Date.now() }))])} className={btnPri}><Check className="w-4 h-4" /> Put {reach.levers.length === 1 ? "it" : "them"} in</button>}
            </div>
          ) : (
            <div className="mt-1 space-y-1.5">
              <p className="text-reading font-medium leading-snug text-[var(--color-text)]">Misses this year&apos;s target ({p.at(target)}) by {reach ? reach.shortH : lateH} h{reach?.levers.length ? " even with the changes below" : ""}. What sets the finish: {pathOrders.slice(0, 3).join(", ")}.</p>
              {reach?.levers.length && p.replayWords ? <p className="text-body text-[var(--color-text-muted)]" data-replay-first>{p.replayWords}</p> : null}
              {reach?.levers.length ? <ol className="list-decimal pl-5 text-body space-y-0.5">{reach.levers.map((l) => <li key={l.change.id}>{l.words}: <b>{r1(l.savedH)} h sooner</b></li>)}</ol> : null}
              <p className="text-body text-[var(--color-text)]">Only that much more time is needed{offPath ? `, or ${offPath.name.replace(/\s*\(\d of 2\)$/, "")} back sooner than ${offPath.hours >= 36 ? `${r1(offPath.hours / 24)} days` : `${Math.round(offPath.hours)} h`}` : ""}.</p>
              {p.canEdit && reach?.levers.length ? <button type="button" onClick={() => p.onChanges([...p.changes, ...reach.levers.map((l, i) => ({ ...l.change, id: `t${Date.now().toString(36)}${i}`, said: "to close on the target", at: Date.now() }))])} className={btnQuiet}><Check className="w-4 h-4" /> Put {reach.levers.length === 1 ? "it" : "them"} in</button> : null}
            </div>
          )
        )}
      </div>
      {lessons.length > 0 && (
        <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {lessons.map((l) => {
            // The crew rule is the schedule's own: said here, not left out.
            const out = !l.rule && skipped.has(l.id);
            return (
              <li key={l.id} className={`py-2.5 ${out ? "opacity-60" : ""}`} data-lesson={l.id}>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="rounded bg-[var(--color-surface-2)] px-1.5 text-caption font-medium text-[var(--color-text-muted)]">{AREA_WORD[l.area]}</span>
                  <b className="order-last basis-full sm:order-none sm:basis-0 sm:flex-1 min-w-0 text-body text-[var(--color-text)]">{l.title}</b>
                  {!out && !l.rule && <span className={`text-caption font-medium ${(effects[l.id] ?? 0) >= 0.5 ? "text-[var(--state-released-text)]" : (effects[l.id] ?? 0) <= -0.5 ? "text-[var(--state-held-text)]" : "text-[var(--color-text-muted)]"}`}>{effectWord(effects[l.id])}</span>}
                  {p.canEdit && !l.rule && <button type="button" onClick={() => skip(l.id, !out)} className="text-body text-[var(--color-accent-text)] hover:underline cursor-pointer">{out ? "Put back" : "Leave out"}</button>}
                </div>
                <p className="mt-0.5 text-caption text-[var(--color-text-muted)]">{l.saw}</p>
                <p className="mt-0.5 text-caption text-[var(--color-text)]">{out ? "Left out of the suggested schedule." : l.does}</p>
              </li>
            );
          })}
        </ul>
      )}
      {risks.length > 0 && (
        <div data-risks>
          <div className="text-body font-medium text-[var(--color-text-muted)]">Risks: not planned, what each does if it happens again</div>
          <ul className="mt-1 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {[...moving, ...(allRisks ? still : [])].map((r) => (
              <li key={r.id} className="py-2" data-risk={r.id}>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="rounded bg-[var(--color-surface-2)] px-1.5 text-caption font-medium text-[var(--color-text-muted)]">{r.kind === "found" ? "Found" : "Ran long"}</span>
                  <b className="order-last basis-full sm:order-none sm:basis-0 sm:flex-1 min-w-0 text-body text-[var(--color-text)]">{r.where}</b>
                  <span className={`text-caption font-medium ${r.finishH >= 0.5 ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text-muted)]"}`}>{r.finishH >= 0.5 ? `finish ${r1(r.finishH)} h later` : "no change to the finish"}</span>
                </div>
                <p className="mt-0.5 text-caption text-[var(--color-text-muted)]">{r.kind === "found" ? `Found this year: ${r.title} (${r.crew}, ${r1(r.hours)} h of work).` : `This year: ${r.title}. ${r1(r.hours)} h past plan in all (${r.crew}).`}</p>
              </li>
            ))}
          </ul>
          {still.length > 0 && <button type="button" onClick={() => setAllRisks(!allRisks)} className="mt-1 text-body text-[var(--color-accent-text)] hover:underline cursor-pointer">{allRisks ? "Hide the ones that don't move the finish" : `${still.length} more that don't move the finish`}</button>}
        </div>
      )}
      <p className="text-caption text-[var(--color-text-muted)]">From this job&apos;s record, the same facts the post-event review reads. Each one&apos;s effect is against leaving it out{lessons.some((l) => l.honest) ? "; for time off site, against the real time away on this year's dates" : ""}.</p>
    </section>
  );
}

function SectionRow4({ title, sub, width, shifts }: { title: string; sub: string; width: number; shifts: Array<{ kind: string }> }) {
  return (
    <tr className="bg-[var(--color-surface-2)]">
      <td className={`${cellAct} !bg-[var(--color-surface-2)]`}><div className="font-medium">{title}</div><div className="text-caption text-[var(--color-text-muted)]">{sub}</div></td>
      <td className="col-x" /><td className="col-x" /><td className="col-x" />
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
    case "jobs": return `${c.crew}: ${c.n} job${c.n === 1 ? "" : "s"} at a time, the whole job`;
    case "crew": return `${c.crew} held at ${[c.day != null ? `${c.day} on the tools on days` : "", c.night != null ? `${c.night} on nights` : ""].filter(Boolean).join(", ") || "its default size"}, the whole job`;
    case "more": return `Another ${c.crew} crew${c.crews > 1 ? ` (${c.crews} in all)` : ""} for the whole job, from its first shift`;
    case "skip": return "A lesson left out";
    case "set": return `${acts.get(c.actId) ?? "An activity"}: ${c.hours != null ? `${c.hours} h` : "changed"}`;
    case "relink": return `${acts.get(c.actId) ?? "An activity"}: links changed`;
    case "floor": return `Earliest start changed: ${tgt(c.target)}`;
  }
}

/** A crew's held size in words: "14 on the tools on days, 4 on nights", "3 jobs at a time". */
function sizeWords(s: CrewSize): string {
  const jobs = s.jobs != null ? `${s.jobs} job${s.jobs === 1 ? "" : "s"} at a time` : "";
  if (!s.hands) return jobs;
  const { day, night } = s.hands;
  const hands = day != null && night != null ? `${day} on the tools on days, ${night} on nights` : day != null ? `${day} on the tools on days` : night != null ? `${night} on the tools on nights` : "";
  return [hands, jobs ? `at most ${jobs}` : ""].filter(Boolean).join(", ");
}

/** Where a crew's size came from, in words (the system says, so it can be checked). */
function sourceWords(s: CrewSize, co: string, dayLabel: (t: number) => string): string {
  const more = s.more > 0 ? `; ${s.more === 1 ? "another crew" : `${s.more} more crews`} brought for the whole job` : "";
  if (s.from === "person") return `Set by you${s.jobs != null && !s.hands && s.jobs > s.worked + s.more ? ` (more than it worked in any one shift this year: ${s.worked})` : ""}${more}.`;
  if (s.from === "worked") {
    const why = s.missing === "night" ? "No count on nights" : s.missing === "day" ? "No count on days" : s.missing === "pace" ? "Too few counts to know how much work its hands do" : "No hands entered";
    return s.worked > 0 ? `${why}: held to the most jobs it worked in one shift this year${more}.` : `${why} and no progress logged by it this year: one job at a time${more}.`;
  }
  const { day: d, night: n } = s.first;
  const one = (f: NonNullable<typeof d>, k: "day" | "night") => (f.from === "plan" ? `${co}'s staffing plan, its first ${k} shift on this job (${dayLabel(f.at)})` : `the head count at the ${dayLabel(f.at)} ${k} meeting`);
  const from = d && n
    ? d.from === "plan" && n.from === "plan" ? `From ${co}'s staffing plan, its first day and night shifts on this job (${dayLabel(d.at)}${dayLabel(n.at) !== dayLabel(d.at) ? ` and ${dayLabel(n.at)}` : ""})`
      : d.from === "counted" && n.from === "counted" ? `From the head counts at the ${dayLabel(d.at)} day and ${dayLabel(n.at)} night meetings`
      : `Days from ${one(d, "day")}; nights from ${one(n, "night")}`
    : d ? `From ${one(d, "day")}` : n ? `From ${one(n, "night")}` : "From the record";
  return `${from}${more}.`;
}

/** A person's own size for a crew, held the whole job: hands on the tools
 *  (when its pace is known) or jobs at a time. */
function CrewSizeEdit({ crew, size, pace, mine, onSave, onClear }: { crew: string; size: CrewSize; pace: number | null; mine: boolean; onSave: (c: PlanChange) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"hands" | "jobs">(size.hands && pace ? "hands" : "jobs");
  const [day, setDay] = useState(String(size.hands?.day ?? ""));
  const [night, setNight] = useState(String(size.hands?.night ?? ""));
  const [jobs, setJobs] = useState(String(size.jobs ?? Math.max(1, size.worked)));
  const field = "w-14 rounded border border-[var(--color-border-control)] bg-[var(--color-surface)] px-1.5 py-0.5 text-caption text-[var(--color-text)]";
  const num = (v: string) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 ? n : null; };
  const ok = mode === "jobs" ? num(jobs) != null : (!size.works.day || num(day) != null) && (!size.works.night || num(night) != null);
  const save = () => {
    const base = { id: `size${Date.now().toString(36)}`, said: "typed in on the crews row", at: Date.now() };
    onSave(mode === "jobs" ? { ...base, kind: "jobs", crew, n: num(jobs)! } : { ...base, kind: "crew", crew, day: size.works.day ? num(day) : null, night: size.works.night ? num(night) : null });
    setOpen(false);
  };
  const link = "text-caption text-[var(--color-accent-text)] hover:underline cursor-pointer";
  if (!open) return (
    <div className="flex gap-2 mt-0.5">
      <button type="button" onClick={() => setOpen(true)} className={link}>Change the size</button>
      {mine && <button type="button" onClick={onClear} className={link}>Back to the size from the record</button>}
    </div>
  );
  return (
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 space-y-1.5 whitespace-normal text-caption text-[var(--color-text)]">
      {pace != null && (
        <Choice label="Set it by" value={mode} onChange={setMode} options={[["hands", "Hands on the tools"], ["jobs", "Jobs at a time"]] as const} />
      )}
      {mode === "jobs"
        ? <label className="flex items-center gap-1.5"><input value={jobs} onChange={(e) => setJobs(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" aria-label={`${crew}: jobs at a time`} className={field} /> jobs at a time</label>
        : <div className="flex flex-wrap items-center gap-2">
            {size.works.day && <label className="flex items-center gap-1"><input value={day} onChange={(e) => setDay(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" aria-label={`${crew}: hands on days`} className={field} /> on days</label>}
            {size.works.night && <label className="flex items-center gap-1"><input value={night} onChange={(e) => setNight(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" aria-label={`${crew}: hands on nights`} className={field} /> on nights</label>}
          </div>}
      <div className="text-caption text-[var(--color-text-muted)]">Held every shift of the job, from its first shift to its last.</div>
      <div className="flex gap-1.5"><button type="button" disabled={!ok} onClick={save} className={btnQuiet}><Check className="w-3.5 h-3.5" /> Hold it</button><button type="button" onClick={() => setOpen(false)} className={btnQuiet}>Cancel</button></div>
    </div>
  );
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

