"use client";

// ShiftReportView — the job's MEETINGS, as agendas you run live and hand out.
//
//   Kick-off   before / on day one — the job, readiness, equipment windows,
//              the critical chain, who's who, the first day and night shifts.
//   Turnover   every shift change — where we stand, safety & people, last
//              shift's results, decisions, the next shift's plan, close.
//   Close-out  at the end — final standing, what's open, lessons, sign-off.
//
// Built for running a meeting from it: a numbered agenda bar that stays on
// screen and jumps to each item (with its count and a red/amber flag when
// it needs attention), Present mode that shows one item at a time (← → keys),
// collapsible items, and dense tables — one line per step, grouped under
// its equipment — instead of a card per equipment.
//
// Copying: each agenda item also describes itself as data, written out as
// plain text or as an email (inline-styled tables Outlook keeps) — the same
// report as an update for management, minus the meeting's prompts and
// sign-off lines.
//
// Printing: the same agendas render a second time into a portal at the
// document root (hidden on screen) in a compact print layout: small type,
// one-line header, tables that may break across pages between rows (never
// mid-row), so a turnover fits on one or two sheets instead of leaving half
// pages blank.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Printer, ChevronLeft, ChevronRight, ChevronDown, Sun, Moon, CheckCircle2, Flag, FastForward,
  TrendingUp, TrendingDown, Minus, Zap, Presentation, X, Settings2, Rocket, ArrowLeftRight, Trophy,
  Copy, Mail, FileText,
} from "lucide-react";
import type { Milestone } from "@/types/schema";
import { buildProgressIndex, leafPercent, type ProgressInfo } from "@/lib/scheduleProgress";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { withWorkOrderCrews } from "@/lib/workOrderCrew";
import { turnoverPlan, nextOf, standing, askedLine, doneOf, crewsOf, vsPlan, doneByTask } from "@/lib/turnoverPlan";
import {
  buildShiftReport, shiftWindow, nextShift, previousShift, defaultReviewShift, nextShiftWithWork, expectedByParent, paceOf, expectedFraction, workShiftOf, staffedDueMs, meetingLeadMin, type Pace, type WorkShift,
  DEFAULT_SHIFT_TIMES, type ShiftTimes, type ShiftRow, type ShiftWindow, type ShiftReport, type PullCrew,
  crewsOnReport, filterShiftReport, whoOf,
} from "@/lib/shiftReport";
import { buildKickoff, buildCloseout, defaultMeeting, type MeetingKind, type PlanRow } from "@/lib/meetingPlan";
import { clockLabel, fmtInTz, tzAbbrev } from "@/lib/scheduleTz";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { toPlainText, toEmailHtml, type ExportBlock, type ExportDoc, type ExportStepRow } from "@/lib/reportExport";
import { turnoverUpdate, withoutEmpty, noteLine, hazardJobsOf } from "@/lib/managementUpdate";
import { useShiftTimes, useShiftTimesSaved, saveProjectShiftTimes, shiftTimesProblem } from "@/lib/shiftTimesStore";
import { latestNotes } from "@/lib/milestones";
import { loadProgressLog, scheduleAt, type ProgressLogRow } from "@/lib/progressHistory";
import { effectiveSpans } from "@/lib/scheduleTime";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { SafetyMomentBox } from "@/components/projects/SafetyMomentBox";
import type { HazardJobInput } from "@/lib/safetyMoment";
import { QuickLookCard, QuickLookOpen, TaskSearch, useQuickLookOpen } from "@/components/projects/TaskQuickLook";
import { quickLook, quickLookIndex } from "@/lib/taskQuickLook";
import type { CancelledJob } from "@/lib/cancelledJobs";
import { handoverKey, decisionsToShip, suggestCrews, askedOutcomes, askedResult, capacityOf, type HandoverDecision } from "@/lib/shiftHandover";
import { TryControl, ShipBar } from "@/components/projects/HandoverControls";
import { PullAheadPicker } from "@/components/projects/PullAheadPicker";
import { useHandoverDraft } from "@/lib/useHandoverDraft";
import { scopeOf } from "@/lib/pullAhead";

/** The crew the report is narrowed to (tables then drop their Who column). */
const ReportCrew = React.createContext<string | null>(null);

interface Props {
  milestones: Milestone[];
  progress?: Map<string, ProgressInfo>;
  criticalIds: Set<string>;
  projectId: string;
  projectName?: string;
  /** Jobs taken off this schedule (done elsewhere) — on the close-out. */
  cancelled?: CancelledJob[];
  /** Who's at the meeting — marks exceptions and ships the turnover. */
  userId?: string;
  userName?: string;
  canEdit?: boolean;
}

const NONE_CANCELLED: CancelledJob[] = [];

const MEETINGS: Array<{ id: MeetingKind; label: string; Icon: typeof Rocket }> = [
  { id: "kickoff", label: "Kick-off", Icon: Rocket },
  { id: "turnover", label: "Shift turnover", Icon: ArrowLeftRight },
  { id: "closeout", label: "Close-out", Icon: Trophy },
];

export default function ShiftReportView({ milestones: rawLive, progress: liveProgress, criticalIds, projectId, projectName, cancelled = NONE_CANCELLED, userId, userName, canEdit = false }: Props) {
  const tz = useScheduleTz();
  // The project's shift-change times — the same on every device.
  const times = useShiftTimes(projectId);
  // Never saved: the day / night split is the app's 05:30 / 17:30 guess.
  const timesSaved = useShiftTimesSaved(projectId);
  const [timesDraft, setTimesDraft] = useState<ShiftTimes | null>(null);
  const [timesMsg, setTimesMsg] = useState<string | null>(null);
  const draft = timesDraft ?? times;
  const saveTimes = async () => {
    if (!timesDraft) return;
    const problem = shiftTimesProblem(timesDraft);
    if (problem) { setTimesMsg(problem); return; }
    try { await saveProjectShiftTimes(projectId, timesDraft); setTimesMsg("Saved for everyone on this project."); setTimesDraft(null); }
    catch (e) { setTimesMsg((e as Error).message); setTimesDraft(null); }
  };
  const [showTimes, setShowTimes] = useState(false);
  // A step with no crew named is reported under its work order's crew.
  const live = useMemo(() => withWorkOrderCrews(rawLive), [rawLive]);

  // Re-evaluated every minute so a tab left open rolls over a shift
  // boundary (and "as of now" stays current) without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(id); }, []);

  const [meetingPick, setMeetingPick] = useState<MeetingKind | null>(null);
  const meeting = meetingPick ?? defaultMeeting(live, now, liveProgress, tz);

  const [sel, setSel] = useState<{ dayKey: string; kind: "day" | "night" } | null>(null);
  const shift: ShiftWindow = useMemo(
    () => (sel ? shiftWindow(sel.dayKey, sel.kind, tz, times) : defaultReviewShift(live, now, tz, times)),
    [sel, now, tz, times, live],
  );
  const pick = (w: ShiftWindow) => setSel({ dayKey: w.dayKey, kind: w.kind });

  // "As of": now while the shift is under way; the shift's end once it is
  // over, and ALSO for a shift in the future so the page can be rehearsed.
  // From the turnover meeting (30 min before the change by default) it's
  // the shift as it ends: what's due by the change and not done carries.
  const lead = meetingLeadMin(times) * 60_000;
  const inMeeting = now >= shift.end - lead && now < shift.end;
  const asOf = now >= shift.start && now < shift.end && !inMeeting ? now : shift.end;

  // An earlier shift (before the one just ended) shows the job as it stood
  // then, from the progress log: what was recorded by an hour after its
  // end (late entries for the shift count). Without the log it reads
  // against today's progress, and says so.
  const pastShift = now > nextShift(shift, tz, times).end;
  // The turnover also reads it for the shift just ending: where each step
  // stood when the shift began, so the report says what moved during it.
  // Re-read as progress is entered.
  const needLog = pastShift || meeting === "turnover";
  const liveSig = useMemo(() => live.map((m) => `${m.id}:${m.percentComplete ?? 0}:${m.status}`).join("|"), [live]);
  const [logState, setLogState] = useState<{ rows: ProgressLogRow[] | null } | undefined>(undefined);
  useEffect(() => {
    if (!needLog) return;
    let alive = true;
    const t = setTimeout(() => {
      loadProgressLog(projectId).then((l) => { if (alive) setLogState({ rows: l }); }).catch(() => { if (alive) setLogState({ rows: null }); });
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [needLog, projectId, liveSig]);
  const log = logState?.rows;
  const recordedBy = shift.end + 3_600_000;
  const history = useMemo(
    () => (pastShift && log ? scheduleAt(live, log, recordedBy) : null),
    [pastShift, log, live, recordedBy],
  );
  // Only a record that reaches back to the shift replaces today's
  // progress; otherwise it's today's, and the label says so.
  const asThen = history?.complete ? history : null;
  const milestones = asThen ? asThen.milestones : live;
  const progress = useMemo(() => (asThen ? buildProgressIndex(asThen.milestones, tz) : liveProgress), [asThen, liveProgress, tz]);
  // Each step's % when the shift began — only when the record reaches back.
  const startPct = useMemo(() => {
    if (!log) return undefined;
    const then = scheduleAt(live, log, shift.start);
    if (!then.complete) return undefined;
    return new Map(then.milestones.filter((m) => m.id).map((m) => [m.id!, m.status === "completed" ? 100 : m.percentComplete ?? 0]));
  }, [log, live, shift.start]);
  const historyNote = !pastShift ? null
    : history?.complete ? `progress as recorded by ${clockLabel(recordedBy, tz)} ${fmtInTz(recordedBy, tz, { month: "short", day: "numeric" })}`
      : `progress as entered by now — the record doesn't reach back to this shift`;

  // ── The turnover as decided and shipped (lib/shiftHandover) ──
  // Decisions are about the next shift (key = the shift handed to); the
  // last turnover's are read back on this one (what was asked of it).
  const hoKey = handoverKey(nextShift(shift, tz, times)), priorKey = handoverKey(shift);
  const [shipBusy, setShipBusy] = useState(false);
  const orgId = live[0]?.orgId ?? "";
  const canShip = canEdit && !!userId && !!orgId;
  const hand = useHandoverDraft({ active: meeting === "turnover", projectId, orgId, userId, hoKey, priorKey });
  const { decisions, shippedAt } = hand;
  // The crew kept for pulled-forward work: this turnover's own, else the
  // project's default. Null when nobody has set one — no made-up size.
  const pullSet: PullCrew | null = hand.savedPull ?? times.helpers ?? null;
  const pullShown: PullCrew = useMemo(() => hand.pullDraft ?? pullSet ?? { crew: null, hands: 2, hours: 12 }, [hand.pullDraft, pullSet]);
  const pullForReport: PullCrew | null = hand.pullDraft ?? pullSet;
  // Steps pulled forward for the next shift — on the report as rows.
  const pullKey = useMemo(() => Object.entries(decisions).filter(([, d]) => d.tryIt && d.pulled).map(([id]) => id).sort().join(","), [decisions]);

  const report = useMemo(
    () => buildShiftReport({ milestones, progress, criticalIds, tz, times, shift, now: asOf, pullIds: pullKey ? pullKey.split(",") : undefined, startPct }),
    [milestones, progress, criticalIds, tz, times, shift, asOf, pullKey, startPct],
  );
  // One crew at a time: the whole turnover narrows to their steps.
  const crews = useMemo(() => crewsOnReport(report), [report]);
  const [crewPick, setCrewPick] = useState<string | null>(null);
  const crew = meeting === "turnover" && crewPick && crews.some((x) => x.who === crewPick) ? crewPick : null;
  // Pulled work is the extra crew's, not the step owner's: in one crew's
  // view it shows when it's that crew's to do (or its own scope).
  const pulledCrewFallback = (hand.pullDraft ?? pullSet)?.crew ?? null;
  const view = useMemo(() => {
    if (!crew) return report;
    const v = filterShiftReport(report, crew);
    const mine = (r: ShiftRow) => (decisions[r.leaf.id ?? ""]?.crew ?? pulledCrewFallback) === crew || whoOf(r) === crew;
    return { ...v, goals: { ...v.goals, pulled: report.goals.pulled.filter(mine), pulledHeld: report.goals.pulledHeld.filter(mine) } };
  }, [report, crew, decisions, pulledCrewFallback]);
  const kickoff = useMemo(() => buildKickoff({ milestones, progress, criticalIds, tz, times }), [milestones, progress, criticalIds, tz, times]);
  const closeout = useMemo(() => buildCloseout({ milestones, progress, criticalIds, tz }), [milestones, progress, criticalIds, tz]);
  const rehearsal = now < shift.start;
  const jumpTarget = useMemo(() => (report.review.scheduled.length === 0 ? nextShiftWithWork(milestones, shift, tz, times) : null), [report.review.scheduled.length, milestones, shift, tz, times]);
  const byId = useMemo(() => { const m = new Map<string, Milestone>(); for (const x of milestones) if (x.id) m.set(x.id, x); return m; }, [milestones]);

  // Each main task's planned % by now — "on plan" or "behind", and "x% of
  // y% planned" next to its progress.
  const planByTask = useMemo(() => expectedByParent(milestones, asOf, tz, times), [milestones, asOf, tz, times]);
  const ctx = useMemo(() => makeCtx(tz, byId, progress, planByTask), [tz, byId, progress, planByTask]);

  const { update: updateDraft } = hand;
  const setDecision = useCallback((id: string, d: HandoverDecision) => { void updateDraft((cur) => ({ ...cur, [id]: d })); }, [updateDraft]);
  // Steps carried to the other crew — the ones the next shift could try —
  // and steps pulled forward from later in the schedule.
  const carried = useMemo(() => [...report.goals.otherShift, ...report.goals.movedOff, ...report.goals.paused, ...report.goals.pulled], [report]);
  // ── Add work for the next shift (PullAheadPicker) ──
  const [pickerOpen, setPickerOpen] = useState(false);
  // The whole remaining job, only while the picker is open.
  const lookAhead = useMemo(() => (pickerOpen
    ? buildShiftReport({ milestones, progress, criticalIds, tz, times, shift, now: asOf, lookAheadUntil: Infinity, pullIds: pullKey ? pullKey.split(",") : undefined }).goals.lookAhead
    : []), [pickerOpen, milestones, progress, criticalIds, tz, times, shift, asOf, pullKey]);
  const togglePull = useCallback((r: ShiftRow, on: boolean) => {
    const id = r.leaf.id;
    if (!id) return;
    void updateDraft((cur) => {
      const rest = { ...cur };
      // No crew of its own: it follows the crew set for the extra work.
      if (on) rest[id] = { tryIt: true, pulled: true, crew: null };
      else delete rest[id];
      return rest;
    });
  }, [updateDraft]);
  const allCrews = useMemo(() => [...new Set(live.map((m) => m.responsibleParty?.trim()).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [live]);
  const priorNow = hand.prior;
  const asked = useMemo(() => askedOutcomes(priorNow, (id) => progress?.get(id)?.percent ?? live.find((m) => m.id === id)?.percentComplete ?? undefined), [priorNow, progress, live]);
  const handoverCtx = useMemo(() => ({
    kind: report.next.kind, decisions, locked: !!shippedAt || !canShip, set: setDecision,
    suggest: (r: ShiftRow) => suggestCrews(r, report), crews: allCrews, asked,
    pull: pullShown, pullSet: pullForReport, key: hoKey, openPicker: canShip && !shippedAt ? () => setPickerOpen(true) : undefined,
  }), [report, decisions, shippedAt, canShip, setDecision, allCrews, asked, pullShown, pullForReport, hoKey]);

  // The latest comment on each step ("sent out for calibration") — shown
  // as a quiet line under the step, here and in the copied update.
  const [notes, setNotes] = useState<Map<string, { body: string; at: string | null; by: string | null }>>(new Map());
  const stepIds = useMemo(() => {
    const parents = new Set(milestones.map((m) => m.parentId).filter(Boolean));
    return milestones.filter((m) => m.id && !parents.has(m.id)).map((m) => m.id!).sort().join(",");
  }, [milestones]);
  useEffect(() => {
    let live = true;
    if (!stepIds) return;
    latestNotes(stepIds.split(",")).then((n) => { if (live) setNotes(n); }).catch(() => { /* comments are extra */ });
    return () => { live = false; };
  }, [stepIds]);
  // A comment written after an earlier shift isn't part of that shift's story.
  const noteThen = useCallback((id: string) => {
    const n = notes.get(id);
    if (n && pastShift && n.at && Date.parse(n.at) > recordedBy) return undefined;
    return n;
  }, [notes, pastShift, recordedBy]);
  const sections = useMemo(() => meeting === "kickoff"
    ? kickoffSections(kickoff, ctx)
    : meeting === "closeout"
      ? closeoutSections(closeout, report, ctx, cancelled)
      : turnoverSections(view, ctx, { onJump: jumpTarget ? () => pick(jumpTarget) : undefined, jumpTarget, noteOf: noteThen, times, crew, whole: report, handover: handoverCtx }),
  [meeting, kickoff, closeout, report, view, ctx, jumpTarget, noteThen, times, crew, cancelled, handoverCtx]);

  // A step's card: asked about mid-meeting, answered from the schedule.
  const qlIndex = useMemo(() => quickLookIndex(milestones), [milestones]);
  const [lookId, setLookId] = useState<string | null>(null);
  const look = useMemo(
    () => (lookId ? quickLook(lookId, qlIndex, { progress, tz, times, asOf, goalAt: report.next.end }) : null),
    [lookId, qlIndex, progress, tz, times, asOf, report.next.end],
  );
  const openLook = useCallback((id: string) => { if (qlIndex.byId.has(id)) setLookId(id); }, [qlIndex]);

  // ── live-meeting navigation ──
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [presenting, setPresenting] = useState<number | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const goTo = useCallback((id: string) => {
    if (presenting != null) { setPresenting(Math.max(0, sections.findIndex((s) => s.id === id))); return; }
    setCollapsed((c) => { const n = new Set(c); n.delete(id); return n; });
    requestAnimationFrame(() => refs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [presenting, sections]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- keep the presented item in range when the agenda shrinks
  useEffect(() => { setPresenting((p) => (p == null ? null : Math.min(p, sections.length - 1))); }, [sections.length]);
  useEffect(() => {
    if (presenting == null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      // A dialog open over the slides (Add work…) keeps its own keys.
      if (t?.closest?.("[role=dialog]") || document.querySelector("[role=dialog]")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); setPresenting((p) => Math.min(sections.length - 1, (p ?? 0) + 1)); }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); setPresenting((p) => Math.max(0, (p ?? 0) - 1)); }
      if (e.key === "Escape") setPresenting(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, sections.length]);

  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- portal target exists only after mount
  useEffect(() => { setMounted(true); }, []);

  // When each main task really finishes: its last step (for "planned finish").
  const taskSpans = useMemo(() => effectiveSpans(milestones), [milestones]);
  // Each main task's steps and where each stands — for "next step" in the update.
  // Every step under a task — its sub-groups' too, as its % complete counts them.
  const stepsByTask = useMemo(() => {
    const parents = new Set(milestones.map((m) => m.parentId).filter((x): x is string => !!x));
    const out = new Map<string, Array<{ id?: string; name: string; start: number; finish: number; percent: number; pace: Pace; expectedPct: number; status: string; work: WorkShift }>>();
    for (const m of milestones) {
      if (!m.parentId || (m.id && parents.has(m.id))) continue;
      const pct = (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
      const step = { id: m.id, name: m.name, start: startMsOf(m), finish: finishMsOf(m), dueAt: staffedDueMs(m, tz, times), percent: pct, pace: paceOf(m, pct, asOf, tz, times), expectedPct: Math.round(expectedFraction(m, asOf, tz, times) * 100), status: m.status, work: workShiftOf(m, tz, times) };
      const seen = new Set<string>();
      for (let pid: string | null | undefined = m.parentId; pid && !seen.has(pid); pid = byId.get(pid)?.parentId) {
        seen.add(pid);
        out.set(pid, [...(out.get(pid) ?? []), step]);
      }
    }
    return out;
  }, [milestones, progress, asOf, tz, times, byId]);

  // The report as data — for Copy (text / email).
  const exportDoc = (): ExportDoc => {
    const { overall, shift: sh, next } = report;
    const kind = meeting === "kickoff" ? "Kick-off meeting" : meeting === "closeout" ? "Close-out meeting" : `Shift turnover${crew ? ` — ${crew}` : ""}`;
    const when = meeting === "turnover"
      ? `${shiftName(sh)} ${ctx.D(sh.start)} ${ctx.win(sh)} → ${shiftName(next)} ${ctx.D(next.start)} ${ctx.win(next)}`
      : meeting === "kickoff"
        ? (kickoff.start != null ? `Job starts ${ctx.DL(kickoff.start)} ${ctx.T(kickoff.start)} · ${kickoff.daysTotal} days` : "No dated work yet")
        : (closeout.finish != null ? `Planned finish ${ctx.DT(closeout.finish)}` : "");
    const status: ExportDoc["status"] = meeting === "kickoff" ? undefined
      : meeting === "closeout"
        ? (closeout.done >= closeout.steps ? { label: "COMPLETE", tone: "emerald" } : { label: `${closeout.steps - closeout.done} OPEN`, tone: "amber" })
        : { label: overall.standing === "ahead" ? "AHEAD" : overall.standing === "behind" ? "BEHIND" : "ON TRACK",
          tone: overall.standing === "ahead" ? "emerald" : overall.standing === "behind" ? "rose" : "slate",
          detail: `${overall.actualPct}% vs ${overall.plannedPct}% plan` };
    return {
      kind, project: projectName ?? "Schedule", when,
      asOf: `${ctx.DT(meeting === "turnover" ? asOf : now)} ${tzAbbrev(ctx.tz, now)}${meeting === "turnover" && rehearsal ? " · rehearsal — shift not started" : meeting === "turnover" && historyNote ? ` · ${historyNote}` : ""}`,
      status,
      // The update management reads, not the meeting's agenda: short
      // tables, one line per main task, and nothing that's empty.
      sections: meeting === "turnover"
        ? turnoverUpdate(view, { D: ctx.D, DTs: ctx.DTs, T: ctx.T, win: ctx.win, hrs: ctx.hrs }, {
          pctOf: (id) => progress?.get(id)?.percent,
          finishOf: (id) => taskSpans.get(id)?.finish,
          planOf: (id) => planByTask.get(id),
          stepsOf: (id) => stepsByTask.get(id),
          noteOf: noteThen,
          // What the meeting decided: steps the next shift could try, and
          // what became of the last turnover's.
          tryOf: (id) => (decisions[id]?.tryIt ? decisions[id] : undefined),
          asked,
          pull: pullForReport,
        })
        : withoutEmpty(sections.filter((x) => x.data).map((x) => ({ id: x.id, title: x.title, sub: x.sub, flag: x.flag ?? null, blocks: x.data!() }))),
    };
  };

  const head = (print: boolean) => (
    <Masthead meeting={meeting} report={report} kickoff={kickoff} closeout={closeout} ctx={ctx} asOf={asOf} now={now}
      rehearsal={rehearsal} historyNote={historyNote} projectName={projectName} print={print} crew={crew} />
  );

  return (
    <ReportCrew.Provider value={crew}>
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03]">
      <style>{`
        [data-shift-print-root] { display: none; }
        @media print {
          @page { size: auto; margin: 9mm; }
          body > *:not([data-shift-print-root]) { display: none !important; }
          [data-shift-print-root] { display: block !important; width: 100%; max-width: 100%; margin: 0; font-size: 9pt; line-height: 1.3; color: #0f172a; background: #fff; }
          [data-shift-print-root] * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          [data-shift-print-root] .sec-head { break-after: avoid; }
          [data-shift-print-root] tr, [data-shift-print-root] .keep { break-inside: avoid; }
          [data-shift-print-root] thead { display: table-header-group; }
          [data-shift-print-root] .no-print { display: none !important; }
          /* Paper can't scroll: tables wrap to the page instead. */
          [data-shift-print-root] .overflow-x-auto, [data-shift-print-root] .overflow-auto { overflow: visible !important; }
        }
      `}</style>

      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap rounded-t-2xl bg-gradient-to-b from-white to-slate-50/40 dark:from-transparent dark:to-transparent">
        <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-lg p-0.5 gap-0.5" role="tablist" aria-label="Meeting">
          {MEETINGS.map(({ id, label, Icon }) => (
            <button key={id} role="tab" aria-selected={meeting === id} onClick={() => { setMeetingPick(id); setPresenting(null); }}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold transition-colors ${meeting === id ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              <Icon className="w-3 h-3" /> {label}
            </button>
          ))}
        </div>

        {meeting === "turnover" && (
          <>
            <span className="mx-0.5 w-px h-4 bg-[var(--color-border)]" />
            <button onClick={() => pick(previousShift(shift, tz, times))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Previous shift"><ChevronLeft className="w-4 h-4" /></button>
            <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-md p-0.5 gap-0.5">
              {(["day", "night"] as const).map((k) => (
                <button key={k} onClick={() => setSel({ dayKey: shift.dayKey, kind: k })} className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold ${shift.kind === k ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                  {k === "day" ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />} {k === "day" ? "Day" : "Night"}
                </button>
              ))}
            </div>
            <input type="date" value={shift.dayKey} onChange={(e) => { if (e.target.value) setSel({ dayKey: e.target.value, kind: shift.kind }); }}
              className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-2 bg-[var(--color-surface)]" title="Which day's shift to close" />
            <button onClick={() => pick(nextShift(shift, tz, times))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Next shift"><ChevronRight className="w-4 h-4" /></button>
            <button onClick={() => setSel(null)} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">Current shift</button>
          </>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative">
            {timesSaved === false ? (
              <button onClick={() => setShowTimes((v) => !v)} aria-expanded={showTimes} title="The day / night split is a guess until the shift times are saved"
                className="inline-flex items-center gap-1 rounded-md border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/50 px-2 py-1 text-[11px] font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/50">
                <Settings2 className="w-3.5 h-3.5" /> Set shift times
              </button>
            ) : (
              <button onClick={() => setShowTimes((v) => !v)} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Shift times" aria-expanded={showTimes}><Settings2 className="w-4 h-4" /></button>
            )}
            {showTimes && (
              <div className="absolute right-0 top-full mt-1 z-30 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-2.5 space-y-1.5 text-[11px] w-52">
                <div className="font-bold text-[var(--color-text)]">Shift change times (plant time)</div>
                <label className="flex items-center justify-between gap-2 text-[var(--color-text-muted)]"><span className="inline-flex items-center gap-1"><Sun className="w-3 h-3" /> Day starts</span>
                  <input type="time" value={draft.dayStart} onChange={(e) => { setTimesMsg(null); setTimesDraft({ ...draft, dayStart: e.target.value || DEFAULT_SHIFT_TIMES.dayStart }); }} className="h-7 border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
                </label>
                <label className="flex items-center justify-between gap-2 text-[var(--color-text-muted)]"><span className="inline-flex items-center gap-1"><Moon className="w-3 h-3" /> Night starts</span>
                  <input type="time" value={draft.nightStart} onChange={(e) => { setTimesMsg(null); setTimesDraft({ ...draft, nightStart: e.target.value || DEFAULT_SHIFT_TIMES.nightStart }); }} className="h-7 border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
                </label>
                <label className="flex items-center justify-between gap-2 text-[var(--color-text-muted)]"><span>Turnover meeting, min before</span>
                  <input type="number" min={0} max={180} step={5} value={meetingLeadMin(draft)} onChange={(e) => { setTimesMsg(null); setTimesDraft({ ...draft, meetingBefore: Number(e.target.value) }); }} className="h-7 w-16 border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
                </label>
                {!timesDraft && timesSaved === false && (
                  <div className="flex justify-end pt-0.5">
                    <button onClick={() => { void saveProjectShiftTimes(projectId, times).then(() => setTimesMsg("Saved for everyone on this project.")).catch((e: Error) => setTimesMsg(e.message)); }}
                      className="px-2.5 py-1 rounded-md font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]">These are right — confirm</button>
                  </div>
                )}
                {timesDraft && (
                  <div className="flex justify-end gap-1.5 pt-0.5">
                    <button onClick={() => { setTimesDraft(null); setTimesMsg(null); }} className="px-2 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
                    <button onClick={() => void saveTimes()} className="px-2.5 py-1 rounded-md font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]">Save for the project</button>
                  </div>
                )}
                {timesMsg && <div className={`leading-snug ${/^Saved for everyone/.test(timesMsg) ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}>{timesMsg}</div>}
              </div>
            )}
          </div>
          <button onClick={() => setPresenting(presenting == null ? 0 : null)}
            className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg border ${presenting != null ? "bg-slate-900 text-white border-slate-900" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}
            title="Run the meeting one agenda item at a time (← → keys, Esc to leave)">
            {presenting != null ? <><X className="w-3.5 h-3.5" /> Leave present</> : <><Presentation className="w-3.5 h-3.5" /> Present</>}
          </button>
          <CopyUpdate doc={exportDoc} meeting={meeting} />
          <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-3 py-1.5 rounded-lg shadow-sm">
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
        </div>
      </div>

      {meeting === "turnover" && pickerOpen && (
        <PullAheadPicker items={lookAhead} next={report.next} shiftHours={(report.next.end - report.next.start) / 3_600_000}
          onLists={[
            ...report.goals.all.map((row) => ({ row, where: `on the ${report.next.kind} shift's list` })),
            ...report.goals.otherShift.map((row) => ({ row, where: `carries to the ${report.next.kind === "day" ? "night" : "day"} shift` })),
            ...report.goals.movedOff.map((row) => ({ row, where: `carries to the ${report.next.kind === "day" ? "night" : "day"} shift` })),
            ...report.goals.paused.map((row) => ({ row, where: "under way — the other crew's" })),
          ]}
          picked={report.goals.pulled}
          counted={[...carried.filter((r) => r.leaf.id && decisions[r.leaf.id]?.tryIt && !report.goals.pulled.includes(r)), ...report.goals.pulled]}
          pull={pullShown} sizeSet={!!pullForReport} crews={allCrews} fmt={{ D: ctx.D, T: ctx.T }} locked={!!shippedAt || !canShip}
          onToggle={togglePull} onPull={hand.setPull}
          onSaveDefault={(p) => saveProjectShiftTimes(projectId, { ...times, helpers: p })}
          onClose={() => setPickerOpen(false)} />
      )}
      {meeting === "turnover" && (
        <ShipBar shippedAt={shippedAt} shippedBy={hand.shippedByName} canShip={canShip} busy={shipBusy} err={hand.err}
          tries={Object.keys(decisionsToShip(decisions, carried)).length}
          when={(iso) => `${ctx.DTs(Date.parse(iso))}`}
          onShip={() => { setShipBusy(true); void hand.ship((d) => decisionsToShip(d, carried, (hand.pullDraft ?? pullSet)?.crew ?? null), hand.pullDraft ?? pullSet, exportDoc, userName).finally(() => setShipBusy(false)); }}
          onUnship={() => { setShipBusy(true); void hand.unship().finally(() => setShipBusy(false)); }} />
      )}
      {head(false)}

      {/* ── Agenda bar: stays on screen, jumps to each item ───────────── */}
      <div className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur">
      <nav className="px-3 py-1.5 flex items-center gap-1 overflow-x-auto" aria-label="Agenda">
        {sections.map((s, i) => {
          const active = presenting === i;
          const tone = s.flag === "rose" ? "border-rose-300 bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900"
            : s.flag === "amber" ? "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900"
              : "border-[var(--color-border)] text-[var(--color-text)]";
          return (
            <button key={s.id} onClick={() => goTo(s.id)}
              className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border pl-1 pr-2.5 py-0.5 text-[11px] font-bold hover:brightness-95 ${tone} ${active ? "ring-2 ring-[var(--color-accent)]" : ""}`}>
              <span className="w-[18px] h-[18px] rounded-full bg-slate-900 text-white text-[10px] font-black flex items-center justify-center">{i + 1}</span>
              {s.short}
              {s.count != null && <span className="font-mono font-bold opacity-70">{s.count}</span>}
            </button>
          );
        })}
      </nav>
      {/* ── One crew at a time, and look up any step ───────────────── */}
      {meeting === "turnover" && (
        <div className="px-3 pb-1.5 flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1.5">
          {crews.length > 1 && (
            <div className="min-w-0 w-full sm:w-auto sm:flex-1 flex items-center gap-1 overflow-x-auto scroll-quiet" role="group" aria-label="Show one crew">
              <span className="shrink-0 text-[9.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mr-0.5">Crew</span>
              {[{ who: null as string | null, steps: 0 }, ...crews].map((x) => {
                const on = crew === x.who;
                return (
                  <button key={x.who ?? "__all"} type="button" aria-pressed={on} onClick={() => setCrewPick(x.who)}
                    className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${on ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                    {x.who ?? "All"}
                    {x.who && <span className="font-mono opacity-60">{x.steps}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <TaskSearch idx={qlIndex} fmt={ctx} onPick={openLook} />
        </div>
      )}
      </div>

      {/* ── Screen body ─────────────────────────────────────────────── */}
      <QuickLookOpen.Provider value={openLook}>
      {presenting != null && sections[presenting] ? (
        <div className="px-6 py-5 min-h-[420px] text-[14px]">
          <SectionHead n={presenting + 1} s={sections[presenting]} big />
          <div className="mt-3">{sections[presenting].body(false)}</div>
          <div className="mt-6 flex items-center justify-between no-print">
            <button disabled={presenting === 0} onClick={() => setPresenting(presenting - 1)} className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-[12px] font-bold disabled:opacity-30">
              <ChevronLeft className="w-4 h-4" /> {presenting > 0 ? sections[presenting - 1].short : "Back"}
            </button>
            <span className="text-[11px] text-[var(--color-text-muted)]">{presenting + 1} of {sections.length} · ← → to move · Esc to leave</span>
            <button disabled={presenting === sections.length - 1} onClick={() => setPresenting(presenting + 1)} className="inline-flex items-center gap-1 rounded-lg bg-slate-900 text-white px-3 py-2 text-[12px] font-bold disabled:opacity-30">
              {presenting < sections.length - 1 ? sections[presenting + 1].short : "Done"} <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 sm:px-5 py-3 space-y-3 text-[12.5px] text-[var(--color-text)]">
          {sections.map((s, i) => {
            const isCollapsed = collapsed.has(s.id);
            return (
              <section key={s.id} ref={(el) => { if (el) refs.current.set(s.id, el); else refs.current.delete(s.id); }} className="scroll-mt-12">
                <button className="w-full text-left" onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} aria-expanded={!isCollapsed}>
                  <SectionHead n={i + 1} s={s} collapsed={isCollapsed} />
                </button>
                {!isCollapsed && <div className="mt-2">{s.body(false)}</div>}
              </section>
            );
          })}
          <Footnote meeting={meeting} ctx={ctx} asOf={asOf} now={now} projectName={projectName} />
        </div>
      )}
      </QuickLookOpen.Provider>
      {look && (
        <QuickLookCard look={look} fmt={ctx} onOpen={openLook} onClose={() => setLookId(null)}
          goalAt={report.next} noteOf={noteThen} />
      )}

      {/* Print copy — a direct child of <body>, so the page layout never
          offsets or clips it. Hidden on screen by the style above. */}
      {mounted && createPortal(
        <div data-shift-print-root>
          {head(true)}
          <div style={{ padding: "4px 0" }}>
            {sections.map((s, i) => (
              <section key={s.id} style={{ marginTop: 8 }}>
                <div className="sec-head"><SectionHead n={i + 1} s={s} print /></div>
                <div style={{ marginTop: 3 }}>{s.body(true)}</div>
              </section>
            ))}
            <Footnote meeting={meeting} ctx={ctx} asOf={asOf} now={now} projectName={projectName} />
          </div>
        </div>,
        document.body,
      )}
    </div>
    </ReportCrew.Provider>
  );
}

// ─── Copy ────────────────────────────────────────────────────────────

/** Rich copy: HTML for an email body, plain text alongside for anything
 *  that can't take HTML. Falls back to copying a selection where the
 *  clipboard API can't write HTML. */
async function copyRich(html: string, text: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
      return true;
    }
  } catch { /* fall through */ }
  const el = document.createElement("div");
  el.innerHTML = html;
  el.style.cssText = "position:fixed;left:-10000px;top:0;";
  document.body.appendChild(el);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges(); sel?.addRange(range);
  const ok = document.execCommand("copy");
  sel?.removeAllRanges(); el.remove();
  return ok;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.cssText = "position:fixed;left:-10000px;top:0;";
  document.body.appendChild(ta); ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

/** Copy — the update as it will be sent, with a box per section to leave
 *  one out today (remembered for next time), then copy it for an email
 *  (tables and colors kept in Outlook, Gmail…) or as plain text. */
function CopyUpdate({ doc, meeting }: { doc: () => ExportDoc; meeting: MeetingKind }) {
  const key = `shiftReport.copyOff.${meeting}`;
  // Sections left out unless ticked (the safety focus): the ones ticked.
  const onKey = `shiftReport.copyOn.${meeting}`;
  const [d, setD] = useState<ExportDoc | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<{ what: "email" | "text"; ok: boolean } | null>(null);
  const open = () => {
    let saved: string[] = [];
    try { saved = JSON.parse(localStorage.getItem(key) ?? "[]") as string[]; } catch { /* private mode */ }
    const fresh = doc();
    // A section that's flagged today (blocked work, things behind) is always
    // ticked when the box opens: unticking it once must not hide tomorrow's
    // problems from management.
    // So is Where we stand: the verdict and the bottom line always go.
    const flagged = new Set(fresh.sections.filter((x) => x.flag || x.id === "stand").map((x) => x.id ?? x.title));
    let on: string[] = [];
    try { on = JSON.parse(localStorage.getItem(onKey) ?? "[]") as string[]; } catch { /* private mode */ }
    const quiet = fresh.sections.filter((x) => x.offByDefault && !on.includes(x.id ?? x.title)).map((x) => x.id ?? x.title);
    setOff(new Set([...saved.filter((id) => !flagged.has(id)), ...quiet])); setDone(null); setD(fresh);
  };
  const toggle = (id: string) => setOff((cur) => {
    const n = new Set(cur);
    if (n.has(id)) n.delete(id); else n.add(id);
    const byDefault = new Set((d?.sections ?? []).filter((x) => x.offByDefault).map((x) => x.id ?? x.title));
    try {
      localStorage.setItem(key, JSON.stringify([...n].filter((x) => !byDefault.has(x))));
      // Keep a choice for a section that isn't in today's update (no safety focus today).
      const before = (JSON.parse(localStorage.getItem(onKey) ?? "[]") as string[]).filter((x) => !byDefault.has(x));
      localStorage.setItem(onKey, JSON.stringify([...before, ...[...byDefault].filter((x) => !n.has(x))]));
    } catch { /* ignore */ }
    return n;
  });
  const idOf = (s: ExportDoc["sections"][number]) => s.id ?? s.title;
  const picked = d ? { ...d, sections: d.sections.filter((s) => !off.has(idOf(s))) } : null;
  const html = picked ? toEmailHtml(picked) : "";
  const subject = d ? `${d.project} — ${d.kind} — ${d.when.split(" → ").pop()}` : "";

  const run = async (what: "email" | "text") => {
    if (!picked) return;
    const text = toPlainText(picked);
    const ok = what === "email" ? await copyRich(html, text) : await copyText(text);
    setDone({ what, ok });
  };

  return (
    <>
      <button onClick={open}
        className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
        title="Copy a short update for email or a message — see it first">
        <Copy className="w-3.5 h-3.5" /> Copy
      </button>
      {d && picked && (
        <Modal onClose={() => setD(null)} size="xl">
          <ModalHeader icon={Mail} title="Copy the update" subtitle="What you'll send — leave out any section for today." onClose={() => setD(null)} />
          <ModalBody className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
              <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Include</span>
              {d.sections.map((s) => (
                <label key={idOf(s)} className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" className="accent-[var(--color-accent)]" checked={!off.has(idOf(s))} onChange={() => toggle(idOf(s))} />
                  <span className="font-semibold text-[var(--color-text)]">{s.title.split(" — ")[0]}</span>
                </label>
              ))}
            </div>
            <div className="rounded-lg border border-[var(--color-border)] bg-white p-4 max-h-[58vh] overflow-y-auto">
              {/* The email body itself — escaped text in inline-styled tables. */}
              <div dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          </ModalBody>
          <ModalFooter>
            {done && (
              <span role="status" className={`mr-auto text-[12px] font-bold ${done.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700"}`}>
                {!done.ok ? "Your browser blocked the copy — try again." : done.what === "email"
                  ? <>Copied — paste into your email (Ctrl+V). <a className="underline" href={`mailto:?subject=${encodeURIComponent(subject)}`}>New email with subject</a></>
                  : "Copied as text — paste anywhere (Ctrl+V)."}
              </span>
            )}
            <button onClick={() => void run("text")} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-[var(--color-border-strong)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              <FileText className="w-4 h-4" /> Copy as text
            </button>
            <button onClick={() => void run("email")} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)]">
              <Mail className="w-4 h-4" /> Copy for email
            </button>
          </ModalFooter>
        </Modal>
      )}
    </>
  );
}

// ─── Formatting context ──────────────────────────────────────────────

interface Ctx {
  tz: string;
  D: (ms: number) => string;
  DL: (ms: number) => string;
  T: (ms: number) => string;
  DT: (ms: number) => string;
  /** Short date + time for table cells: "Oct 22 7:30". */
  DTs: (ms: number) => string;
  hrs: (h: number) => string;
  win: (w: ShiftWindow) => string;
  span: (a: number, b: number) => string;
  group: (parentId: string | null, parentName: string | null, crumbs: string[], fallback: string) => TGroup;
}

interface HandoverCtx {
  kind: "day" | "night";
  decisions: Record<string, HandoverDecision>;
  locked: boolean;
  set: (id: string, d: HandoverDecision) => void;
  suggest: (r: ShiftRow) => Array<{ crew: string; why: string }>;
  crews: string[];
  asked: ReturnType<typeof askedOutcomes>;
  /** The crew kept for pulled-forward work, and its size (as shown in
   *  the picker), and the size actually set — null: none set, no capacity. */
  pull: PullCrew;
  pullSet: PullCrew | null;
  /** The shift handed to — keys the controls so nothing follows a step
   *  onto another shift's report. */
  key: string;
  /** Opens "Add work for the next shift" — absent once shipped. */
  openPicker?: () => void;
}

function makeCtx(tz: string, byId: Map<string, Milestone>, progress?: Map<string, ProgressInfo>, planOf?: Map<string, number>): Ctx {
  const D = (ms: number) => fmtInTz(ms, tz, { weekday: "short", month: "short", day: "numeric" });
  const DL = (ms: number) => fmtInTz(ms, tz, { weekday: "long", month: "long", day: "numeric" });
  const T = (ms: number) => clockLabel(ms, tz) || "0:00";
  const DT = (ms: number) => `${D(ms)} ${T(ms)}`;
  const day = (ms: number) => fmtInTz(ms, tz, { year: "numeric", month: "numeric", day: "numeric" });
  const DS = (ms: number) => fmtInTz(ms, tz, { month: "short", day: "numeric" });
  const DTs = (ms: number) => `${DS(ms)} ${T(ms)}`;
  const span = (a: number, b: number) => (!Number.isFinite(a) || !Number.isFinite(b) ? "—" : day(a) === day(b) ? `${DS(a)} ${T(a)}–${T(b)}` : `${DTs(a)} → ${DTs(b)}`);
  return {
    tz, D, DL, T, DT, DTs, span,
    hrs: (h: number) => `${Math.round(h * 10) / 10} h`,
    win: (w) => `${T(w.start)}–${T(w.end)}${day(w.start) === day(w.end) ? "" : ` (${D(w.end)})`}`,
    group: (parentId, parentName, crumbs, fallback) => {
      const parent = parentId ? byId.get(parentId) : undefined;
      const info = parentId ? progress?.get(parentId) : undefined;
      const ps = parent ? startMsOf(parent) : NaN, pf = parent ? finishMsOf(parent) : NaN;
      return {
        key: parentId ?? `solo:${fallback}`,
        title: parentName ?? "",
        crumbs: crumbs.join(" › "),
        meta: [Number.isFinite(ps) && Number.isFinite(pf) ? span(ps, pf) : null, info ? `${info.leafDone}/${info.leafTotal} steps · ${info.percent}%${parentId && planOf?.get(parentId) != null ? ` of ${planOf.get(parentId)}% planned` : ""}` : null].filter(Boolean).join(" · "),
      };
    },
  };
}

// ─── Agenda items ────────────────────────────────────────────────────

type Flag = "rose" | "amber" | null;
interface Sec {
  id: string;
  title: string;
  /** Short label for the agenda bar. */
  short: string;
  sub?: string;
  count?: number;
  flag?: Flag;
  body: (print: boolean) => React.ReactNode;
  /** The item as data for a copied report (text / email). Absent for the
   *  talk-track items — prompts and sign-off — which an update leaves out. */
  data?: () => ExportBlock[];
}

/** Table rows as export rows: same text, tags without the null slots. */
function exportRows(rows: TRow[]): ExportStepRow[] {
  return rows.map((r) => ({
    group: r.group.title ? { title: r.group.title, crumbs: r.group.crumbs || undefined, meta: r.group.meta || undefined } : undefined,
    n: r.n?.num, when: r.when, name: r.name,
    tags: (r.tags ?? []).filter((t): t is TagT => !!t).map((t) => ({ t: t.t, tone: t.tone })),
    who: r.who, wo: r.wo, right: r.right, note: r.note,
  }));
}
const stepsBlock = (rows: TRow[], rightHead: string, whenHead = "When", flat?: boolean): ExportBlock =>
  ({ k: "steps", rows: exportRows(rows), rightHead, whenHead, flat });

const shiftName = (w: ShiftWindow) => (w.kind === "day" ? "Day shift" : "Night shift");

function rowFromShift(r: ShiftRow, c: Ctx, o: { when: string; n?: { num: number; tone: NumTone }; box?: boolean; right: string; done?: boolean; extraTags?: Array<TagT | null>; note?: string }): TRow {
  return {
    id: r.leaf.id ?? r.leaf.name,
    group: c.group(r.parentId, r.parentName, r.path.slice(0, -1), r.leaf.name),
    n: o.n, box: o.box, when: o.when, name: r.leaf.name, done: o.done,
    tags: [r.critical ? { t: "critical", tone: "rose" } : null, ...(o.extraTags ?? [])],
    who: r.leaf.responsibleParty ?? undefined, wo: r.leaf.workOrderRef ?? undefined,
    right: o.right, note: o.note,
  };
}

function rowFromPlan(r: PlanRow, c: Ctx, o: { when?: string; right?: string; n?: { num: number; tone: NumTone }; note?: string; extraTags?: Array<TagT | null>; noCriticalTag?: boolean }): TRow {
  return {
    id: r.leaf.id ?? r.leaf.name,
    group: c.group(r.parentId, r.parentName, r.crumbs, r.leaf.name),
    n: o.n, when: o.when ?? c.span(r.start, r.finish), name: r.leaf.name,
    tags: [r.critical && !o.noCriticalTag ? { t: "critical", tone: "rose" } : null, ...(o.extraTags ?? [])],
    who: r.who ?? undefined, wo: r.leaf.workOrderRef ?? undefined,
    right: o.right ?? c.hrs(r.hours), note: o.note,
  };
}

function turnoverSections(report: ShiftReport, c: Ctx, o: { onJump?: () => void; jumpTarget: ShiftWindow | null; noteOf?: (id: string) => { body: string; at?: string | null } | undefined; times: ShiftTimes;
  /** Narrowed to one crew: its name, and the whole job's report (the
   *  standing up top stays the whole job's). */
  crew?: string | null; whole?: ShiftReport;
  /** The meeting's exceptions (lib/shiftHandover): steps the next shift
   *  could try, which crew; and what the last turnover asked of this one. */
  handover?: HandoverCtx }): Sec[] {
  const { overall, review, goals, shift, next } = report;
  // A step's latest comment, as one quiet line under it (each step shows once).
  const comment = (r: ShiftRow) => {
    const n = noteLine(r.leaf.id ? o.noteOf?.(r.leaf.id) : undefined, shift.start, c.D);
    return n ? `“${n}”` : undefined;
  };
  const rowTime = (r: ShiftRow, w: ShiftWindow) => {
    // Work moved onto its crew's hours shows those hours.
    const a = r.reflowed ? r.crewStart : r.start, b = r.reflowed ? r.crewFinish : r.finish;
    const s = a >= w.start && a < w.end ? c.T(a) : null;
    const f = b > w.start && b <= w.end ? c.T(b) : null;
    if (!s && !f) return "all shift";
    return `${s ?? "…"}–${f ?? "…"}`;
  };
  const isHeld = (r: ShiftRow) => r.status === "blocked" || r.status === "on_hold";
  const gap = goals.gapHours;
  const ho = o.handover;
  const tryOf = (r: ShiftRow) => (r.leaf.id && ho?.decisions[r.leaf.id]?.tryIt ? ho.decisions[r.leaf.id] : undefined);
  // Where every step goes — decided once (lib/turnoverPlan), the same as
  // the email: each step appears once, where it says what happens to it.
  const plan = turnoverPlan(report, (id) => !!ho?.decisions[id]?.tryIt);
  const { items, tried: tryList, pulled: pulledRows } = plan;
  const planList = items.filter((x) => x.kind === "next").map((x) => x.r);
  const planHrs = planList.reduce((a, r) => a + (r.hoursNext ?? 0), 0);
  const priorityOf = new Map<string, number>();
  planList.forEach((r, i) => { if (r.leaf.id) priorityOf.set(r.leaf.id, i + 1); });
  // "After #2": a step waiting on another step on this list names its
  // number; on something off the list, its name.
  const waitTag = (r: ShiftRow): TagT | null => {
    if (r.waitingOn.length === 0) return null;
    const nums = r.waitingOn.map((w) => priorityOf.get(w.id)).filter((n): n is number => n != null);
    return nums.length === r.waitingOn.length
      ? { t: `after #${nums.join(", #")}`, tone: "amber" }
      : { t: `waits on ${r.waitingOn[0].name}${r.waitingOn.length > 1 ? ` +${r.waitingOn.length - 1}` : ""}`, tone: "amber" };
  };
  // Each step's hours ahead / behind ride on its own row (vsPlan).
  const vsTag = (r: ShiftRow): TagT | null => { const v = vsPlan(report, r, c.hrs); return v.text ? { t: `${v.text} vs plan`, tone: v.tone ?? "muted" } : null; };
  // ── Done: finished, and moved forward but on no list below.
  const doneIds = new Set(plan.done.map((r) => r.leaf.id ?? r.leaf.name));
  // One row per task: its steps done or moved this shift, in one cell.
  const doneTasks = doneByTask(report, plan, c, (id) => noteLine(o.noteOf?.(id), shift.start, c.D));
  const creditedIds = new Set([...plan.done, ...plan.moved].map((r) => r.leaf.id));
  const doneRows = [...plan.done, ...plan.moved].map((r) => {
    const fin = doneIds.has(r.leaf.id ?? r.leaf.name);
    // What it meant for the plan — on plan, early, late — not a bare ✓.
    const d = doneOf(report, r, c);
    return rowFromShift(r, c, {
      when: r.offSchedule ? `planned ${c.D(r.start)}` : rowTime(r, shift),
      right: fin ? d.label.toLowerCase() : d.label,
      done: fin,
      note: comment(r),
      extraTags: [{ t: d.detail, tone: d.tone }, vsTag(r)],
    });
  });
  // ── Next: one list. The next crew's work (numbered, in priority order),
  // what it could try, what waits for its own crew, what's blocked.
  const shiftHrs = (next.end - next.start) / 3_600_000;
  // The next crew's table: its own work and what it could try. The other
  // crew's carried work and anything blocked: their own table below.
  const isTonight = (k: string) => k === "next" || k === "try";
  const nextRows = (print: boolean, tonight: boolean) => items.filter((x) => isTonight(x.kind) === tonight).map(({ r, kind }) => {
    const pulled = pulledRows.includes(r);
    const d = tryOf(r);
    const crewName = kind === "try" ? d?.crew ?? (pulled ? ho?.pullSet?.crew ?? null : null) : null;
    const x = nextOf(report, r, kind, c, { pulled, crew: crewName });
    const scope = pulled ? scopeOf({ row: r }, crewName) : null;
    return {
      ...rowFromShift(r, c, {
        when: kind === "carry" ? `${otherKind === "day" ? "Day" : "Night"} crew` : x.label,
        n: kind === "next" ? { num: priorityOf.get(r.leaf.id ?? "") ?? 0, tone: r.critical ? "rose" : r.carryOver ? "amber" : "slate" } : undefined,
        right: standing(r, kind),
        // The step's comment shows once: with its credit under Done, if it moved.
        note: [kind === "try" && d?.note ? `“${d.note}”` : null, creditedIds.has(r.leaf.id) ? null : comment(r)].filter(Boolean).join(" ") || undefined,
        extraTags: [
          x.detail ? { t: x.detail, tone: x.tone ?? "muted" } : null,
          vsTag(r),
          kind === "next" || pulled ? waitTag(r) : null,
          scope ? { t: `${scope}'s scope — coordinate`, tone: "amber" } : null,
        ],
      }),
      // The meeting's call on it (never printed): could the next crew try
      // it? One small button on the line; once marked, its crew and note.
      inline: !print && ho && r.leaf.id && kind === "carry" ? (
        <button type="button" disabled={ho.locked} onClick={() => ho.set(r.leaf.id!, { ...ho.decisions[r.leaf.id!], tryIt: true, crew: ho.suggest(r)[0]?.crew ?? null })}
          className="whitespace-nowrap rounded-full border border-indigo-300 dark:border-indigo-800 px-1.5 py-px text-[10px] font-bold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 disabled:opacity-60 print:hidden">
          + {next.kind} could try
        </button>
      ) : undefined,
      control: !print && ho && r.leaf.id && kind === "try" ? (
        <TryControl key={`${ho.key}:${r.leaf.id}`} kind={next.kind} decision={ho.decisions[r.leaf.id]} suggestions={ho.suggest(r)} crews={ho.crews}
          inherit={pulled && ho.pullSet?.crew ? ho.pullSet.crew : undefined}
          disabled={ho.locked} onChange={(nd) => ho.set(r.leaf.id!, { ...nd, pulled: pulled || undefined })} />
      ) : undefined,
    };
  });
  // The next shift's work as the safety moment ranks it.
  const hazardJobs: HazardJobInput[] = hazardJobsOf(planList, next, (r) => (r.carryOver ? `due ${c.DTs(r.dueAt)}` : rowTime(r, next)));
  const capa = capacityOf(ho?.pullSet ?? null, tryList, shiftHrs);
  const addButton = ho?.openPicker ? (
    <button type="button" onClick={ho.openPicker}
      className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-indigo-400 dark:border-indigo-700 px-3 py-1.5 text-[12px] font-bold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 print:hidden">
      <Zap className="w-3.5 h-3.5" /> Add work for the {next.kind} shift
    </button>
  ) : null;
  const asked = ho?.asked ?? [];
  const askedText = asked.length ? `Asked last turnover: ${askedLine(asked, askedResult)}` : null;
  const otherKind = next.kind === "day" ? "night" : "day";
  const tryLine = tryList.length
    ? `Could try if possible: ${tryList.length} step${tryList.length === 1 ? "" : "s"}, ${c.hrs(capa.used)}${capa.hours > 0 && ho?.pullSet ? ` of ${c.hrs(capa.hours)}${capa.over ? " — over" : ""} (${ho.pullSet.crew ? `${ho.pullSet.crew}, ` : ""}${ho.pullSet.hands} × ${Math.min(ho.pullSet.hours, shiftHrs)} h)` : ""}.`
    : null;
  const nextSub = [
    `${planList.length} step${planList.length === 1 ? "" : "s"} · ${c.hrs(planHrs)}`,
    tryList.length ? `${tryList.length} could try` : null,
  ].filter(Boolean).join(" · ");
  const laterCount = plan.carries.length + plan.held.length;
  const laterSub = [plan.carries.length ? `${plan.carries.length} for the ${otherKind} crew` : null, plan.held.length ? `${plan.held.length} blocked or on hold` : null].filter(Boolean).join(" · ") + ` — not the ${next.kind} shift's work`;
  const pastDueAll = (o.whole ?? report).review.carryOver.filter((r) => !isHeld(r)).length;
  const forCrew = o.crew ? ` for ${o.crew}` : "";
  const standStats = [
    { label: "Actual", value: `${overall.actualPct}%`, tone: (overall.standing === "behind" ? "rose" : overall.standing === "ahead" ? "emerald" : "slate") as "rose" | "emerald" | "slate" },
    { label: "Plan by now", value: `${overall.plannedPct}%`, tone: "slate" as const },
    // Coloured by the headline verdict, so it can't read red under ON TRACK.
    { label: overall.standing === "behind" ? "Work behind" : overall.standing === "ahead" ? "Work ahead" : "Gap",
      // On track but not even: say which way, in words. Behind / ahead
      // always shows the hours (never "even" under a BEHIND verdict).
      value: overall.standing !== "on track" ? c.hrs(Math.abs(gap)) : Math.abs(gap) <= 0.5 ? "even" : `${c.hrs(Math.abs(gap))} ${gap > 0 ? "behind" : "ahead"}`,
      tone: (overall.standing === "behind" ? "rose" : overall.standing === "ahead" ? "emerald" : "slate") as "rose" | "emerald" | "slate" },
    { label: "Steps done", value: `${overall.stepsDone}/${overall.stepsTotal}`, tone: "slate" as const },
    // Past due across every crew (blocked work is counted under decisions).
    { label: o.crew ? "Past due · all crews" : "Past due", value: `${pastDueAll}`, tone: (pastDueAll ? "amber" : "emerald") as "amber" | "emerald" },
  ];
  const nothingLast = review.scheduled.length === 0 && doneRows.length === 0;

  // Who was here, and who's coming — right after where we stand.
  const cr = crewsOf(report, plan, c.hrs);
  const crewCols = [
    { title: `${shiftName(shift)} ${c.D(shift.start)} — who was here`, rows: cr.worked },
    { title: `${shiftName(next)} ${c.D(next.start)} — who's coming`, rows: cr.coming },
  ];
  return [
    {
      id: "stand", title: "Where we stand", short: "Status",
      sub: [overall.plannedFinish ? `Day ${overall.daysElapsed} of ${overall.daysTotal} · planned finish ${c.DT(overall.plannedFinish)}` : null,
        overall.planBasis === "baseline" ? `vs baseline${overall.baselineSetAt ? ` of ${c.D(Date.parse(overall.baselineSetAt))}` : ""}` : "vs live dates (no baseline)",
        overall.unscheduled > 0 ? `${overall.unscheduled} step${overall.unscheduled === 1 ? "" : "s"} without dates not counted` : null].filter(Boolean).join(" · "),
      flag: overall.standing === "behind" ? "rose" : null,
      body: () => (
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 keep">
            {standStats.map((x) => <Stat key={x.label} label={x.label} value={x.value} tone={x.tone} />)}
          </div>
        </div>
      ),
      data: () => [
        { k: "stats", items: standStats },
      ],
    },
    {
      id: "who", title: "Crews", short: "Crews",
      sub: `${cr.worked.length} on the ${shift.kind} shift · ${cr.coming.length} on the ${next.kind} shift`,
      body: () => (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 keep">
          {crewCols.map((col) => (
            <div key={col.title} className="rounded-md border border-[var(--color-border)] px-3 py-2">
              <div className="text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{col.title}</div>
              {col.rows.length === 0 ? <div className="text-[12px] italic text-[var(--color-text-muted)]">No work planned</div> : (
                <ul className="space-y-0.5">
                  {col.rows.map((x) => (
                    <li key={x.crew} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                      <b className="text-[var(--color-text)] break-words">{x.crew}</b>
                      <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">{x.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      ),
      data: () => [{ k: "columns", cols: crewCols.map((col) => ({ title: col.title, rows: col.rows.length ? col.rows.map((x) => ({ title: x.crew, value: x.text })) : [{ title: "No work planned", value: "" }] })) }],
    },
    {
      id: "safety", title: "Safety & people", short: "Safety",
      sub: "Open every turnover here — then the work.",
      body: (print) => (
        <div className="space-y-2">
          <SafetyMomentBox jobs={hazardJobs} shiftKind={next.kind} shiftStart={next.start} print={print} />
          <Prompts print={print} cols={3} items={[
            "Incidents, near misses, first aid since last turnover",
            "Permits and lock-outs open across the change",
            "Manpower and equipment — short, down, arriving",
          ]} />
        </div>
      ),
    },
    {
      // ── Done — what the shift finished, and what it moved forward.
      id: "done", title: `Done — ${shiftName(shift)} ${c.D(shift.start)} ${c.win(shift)}`, short: "Done",
      sub: [`${plan.done.length} finished`, plan.moved.length ? `${plan.moved.length} moved forward` : null].filter(Boolean).join(" · "),
      count: plan.done.length,
      flag: null,
      data: () => [
        ...(askedText ? [{ k: "note", text: askedText } as ExportBlock] : []),
        doneRows.length === 0 ? { k: "empty", text: `Nothing was ${nothingLast ? "planned" : "completed"}${forCrew} on this shift.` }
          : { k: "table", head: ["Task", "Done this shift", "Who", "What it means", "vs plan"], align: ["left", "left", "left", "left", "right"], nowrap: [4],
            rows: doneTasks.map((x) => [{ t: x.task, bold: true }, x.steps, { t: x.who, tone: "muted" }, { t: x.result.text, tone: x.result.tone === "amber" ? "amber" : "emerald", bold: true }, { t: x.vs.text, tone: x.vs.tone, bold: true }]) } as ExportBlock,
      ],
      body: (print) => (
        <div className="space-y-2">
          {askedText && <div className="text-[11.5px] font-semibold text-slate-700 dark:text-slate-200">{askedText}</div>}
          {doneRows.length > 0 ? (
            <SimpleTable print={print} head={["Task", "Done this shift", "Who", "What it means", "vs plan"]} rows={doneTasks.map((x) => ({
              id: x.ids.join(","),
              cells: [
                <b key="t">{x.task}</b>,
                <span key="s">{x.steps}</span>,
                <span key="w" className="text-[var(--color-text-muted)]">{x.who}</span>,
                <b key="r" className={x.result.tone === "amber" ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-400"}>{x.result.text}</b>,
                <b key="v" className={`font-mono whitespace-nowrap ${x.vs.tone === "rose" ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{x.vs.text}</b>,
              ],
            }))} />
          ) : (
            <Empty>
              Nothing was {nothingLast ? "planned" : "completed"}{forCrew} on this shift.
              {nothingLast && o.onJump && o.jumpTarget && !print && (
                <button onClick={o.onJump} className="ml-2 inline-flex items-center gap-1 font-bold text-[var(--color-accent)] hover:underline">
                  <FastForward className="w-3.5 h-3.5" /> Jump to {o.jumpTarget.kind} shift, {c.D(o.jumpTarget.start)}
                </button>
              )}
            </Empty>
          )}
        </div>
      ),
    },
    {
      // ── Next — one list, each step once, with what happens to it.
      id: "next", title: `Next — ${shiftName(next)} ${c.D(next.start)} ${c.win(next)}`, short: "Next",
      sub: nextSub,
      count: planList.length,
      flag: null,
      body: (print) => (
        <div className="space-y-2">
          {next.kind === "night" && o.times.nightJobs === undefined && (
            // Not decided: the list follows the schedule file's hours.
            <div role="alert" className="rounded-md border-2 border-rose-400 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-[12px] text-rose-900 dark:text-rose-100">
              <b>Night crews aren&apos;t set</b> — this list follows the schedule file&apos;s hours, which can hand day work to nights. Set them once in <b>Schedule setup → Night crews</b>.
            </div>
          )}
          {planList.length + tryList.length === 0 ? <Empty>Nothing is scheduled for the next shift.</Empty> : (
            <StepTable print={print} box whenHead="When" rightHead="Done · goal" rows={nextRows(print, true)} />
          )}
          {tryLine && <div className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-300">{tryLine}</div>}
          {goals.pulledHeld.length > 0 && (
            <div className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-300">
              Blocked since it was added — not on the list: {goals.pulledHeld.map((r) => `${r.leaf.name}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}.
            </div>
          )}
          {!print && addButton}
        </div>
      ),
      data: () => [
        planList.length + tryList.length === 0 ? { k: "empty", text: "Nothing is scheduled for the next shift." } : stepsBlock(nextRows(true, true), "Done · goal", "When"),
        ...(tryLine ? [{ k: "note", text: tryLine, tone: "amber" } as ExportBlock] : []),
      ],
    },
    ...(laterCount ? [{
      // ── Carries to the other shift: its crew's unfinished and ongoing
      // work, and anything blocked — not the next shift's list.
      id: "carries", title: `Carries over to ${otherKind} shift — ${c.D(next.end)}`, short: `To ${otherKind} shift`,
      sub: laterSub, count: laterCount,
      flag: plan.held.some((r) => r.status === "blocked") ? "rose" : null,
      body: (print: boolean) => <StepTable print={print} whenHead="Why" rightHead="Done" rows={nextRows(print, false)} />,
      data: () => [stepsBlock(nextRows(true, false), "Done", "Why")],
    } as Sec] : []),
    closeSection("Close", ["Outgoing supervisor", "Incoming supervisor", "Crew lead"]),
  ];
}

function kickoffSections(k: ReturnType<typeof buildKickoff>, c: Ctx): Sec[] {
  const jobStats = [
    { label: "Days", value: `${k.daysTotal}`, tone: "slate" as const },
    { label: "Steps", value: `${k.steps}`, tone: "slate" as const },
    { label: "Work-hours", value: c.hrs(k.hours), tone: "slate" as const },
    { label: "Equipment / areas", value: `${k.groups.length}`, tone: "slate" as const },
    { label: "On critical path", value: `${k.critical.length}`, tone: (k.critical.length ? "rose" : "slate") as "rose" | "slate" },
  ];
  const unscheduledMsg = k.unscheduled > 0 ? `${k.unscheduled} step${k.unscheduled === 1 ? " has" : "s have"} no planned dates yet — not in the numbers above.` : null;
  const notReadyRows = k.notReady.map((r) => rowFromPlan(r, c, {
    extraTags: [r.leaf.status === "blocked" ? { t: "blocked", tone: "rose" } : { t: "on hold", tone: "amber" }],
    note: r.leaf.statusReason ? `Reason: ${r.leaf.statusReason}` : "No reason recorded.",
  }));
  const critRows = k.critical.map((r, i) => rowFromPlan(r, c, { n: { num: i + 1, tone: "rose" }, noCriticalTag: true }));
  const shiftRowsOf = (s: (typeof k.firstShifts)[number]) => s.rows.map((r, j) => rowFromShift(r, c, {
    when: (() => { const a = r.start >= s.window.start ? c.T(r.start) : "…"; const b = r.finish <= s.window.end ? c.T(r.finish) : "…"; return `${a}–${b}`; })(),
    n: { num: j + 1, tone: r.critical ? "rose" : "slate" }, right: c.hrs(r.hoursNext ?? r.hoursLeft),
    extraTags: [r.finish > s.window.end ? { t: `to ${c.D(r.finish)}`, tone: "muted" } : null],
  }));
  const secs: Sec[] = [
    {
      id: "job", title: "The job at a glance", short: "The job",
      sub: k.start != null && k.finish != null ? `${c.DT(k.start)} → ${c.DT(k.finish)}` : "No dated steps yet",
      flag: k.unscheduled > 0 ? "amber" : null,
      body: () => (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 keep">
            {jobStats.map((x) => <Stat key={x.label} label={x.label} value={x.value} tone={x.tone} />)}
          </div>
          {unscheduledMsg && <div className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-300">{unscheduledMsg}</div>}
        </div>
      ),
      data: () => [{ k: "stats", items: jobStats }, ...(unscheduledMsg ? [{ k: "note", text: unscheduledMsg, tone: "amber" } as ExportBlock] : [])],
    },
    {
      id: "ready", title: "Safety & readiness", short: "Readiness",
      sub: k.notReady.length ? `${k.notReady.length} step${k.notReady.length === 1 ? "" : "s"} blocked or on hold before day one` : "Nothing blocked or on hold",
      count: k.notReady.length || undefined, flag: k.notReady.length ? "rose" : null,
      body: (print) => (
        <div className="space-y-2">
          <Prompts print={print} items={[
            "Job safety plan reviewed — hazards, permits, rescue plans, emergency muster",
            "Isolations, blinds and lock-out list agreed with operations",
            "Materials, tools, cranes and scaffold on site or dated",
            "Contacts — operations, safety, QA/QC, each contractor's lead",
          ]} />
          {k.notReady.length > 0 && <StepTable print={print} rightHead="Hours" ownerLine rows={notReadyRows} />}
        </div>
      ),
      data: () => [k.notReady.length ? stepsBlock(notReadyRows, "Hours") : { k: "empty", text: "Nothing blocked or on hold before day one." }],
    },
    {
      id: "equip", title: "Equipment & windows", short: "Equipment",
      sub: "Each piece of work, its window, and who does it — in start order",
      count: k.groups.length,
      body: (print) => k.groups.length === 0 ? <Empty>No dated work yet.</Empty> : (
        <SimpleTable print={print} head={["Equipment / area", "Window", "Steps", "Hours", "Who"]}
          rows={k.groups.map((g) => ({
            id: g.id,
            cells: [
              <span key="n"><b>{g.name}</b>{g.crumbs.length ? <span className="text-[var(--color-text-faint)]"> · {g.crumbs.join(" › ")}</span> : null}{g.critical ? <> <TagChip t={`${g.critical} critical`} tone="rose" /></> : null}</span>,
              c.span(g.start, g.finish), `${g.steps}`, c.hrs(g.hours), g.who.join(", ") || "—",
            ],
          }))} />
      ),
      data: () => [k.groups.length === 0 ? { k: "empty", text: "No dated work yet." } : {
        k: "table", head: ["Equipment / area", "Window", "Steps", "Hours", "Who"],
        rows: k.groups.map((g) => [`${g.name}${g.critical ? ` (${g.critical} critical)` : ""}`, c.span(g.start, g.finish), `${g.steps}`, c.hrs(g.hours), g.who.join(", ") || "—"]),
      }],
    },
    {
      id: "crit", title: "Critical path — what drives the finish date", short: "Critical path",
      sub: k.critical.length ? `${k.critical.length} steps · any slip here moves the end date` : "No critical chain computed",
      count: k.critical.length,
      body: (print) => k.critical.length === 0 ? <Empty>No critical chain — check the step links.</Empty> : (
        <StepTable print={print} flat rightHead="Hours" rows={critRows} />
      ),
      data: () => [k.critical.length === 0 ? { k: "empty", text: "No critical chain computed." } : stepsBlock(critRows, "Hours", "When", true)],
    },
    {
      id: "who", title: "Who's who", short: "Who's who",
      sub: k.people.length ? `${k.people.length} crews / companies named on the schedule` : "No responsible parties on the schedule",
      count: k.people.length,
      body: (print) => k.people.length === 0 ? <Empty>Add a responsible party to steps to see who does what.</Empty> : (
        <SimpleTable print={print} head={["Crew / company", "Steps", "Hours", "First on the job", "Contact"]}
          rows={k.people.map((p) => ({ id: p.name, cells: [<b key="n">{p.name}</b>, `${p.steps}`, c.hrs(p.hours), c.DT(p.first), <Blank key="b" print={print} />] }))} />
      ),
      data: () => [k.people.length === 0 ? { k: "empty", text: "No responsible parties on the schedule." } : {
        k: "table", head: ["Crew / company", "Steps", "Hours", "First on the job"],
        rows: k.people.map((p) => [p.name, `${p.steps}`, c.hrs(p.hours), c.DT(p.first)]),
      }],
    },
    ...k.firstShifts.map((s, i): Sec => ({
      id: `first${i}`, title: `${i === 0 ? "First" : "Then"}: ${shiftName(s.window)} ${c.D(s.window.start)} ${c.win(s.window)}`,
      short: i === 0 ? `Day 1 ${s.window.kind}` : `${s.window.kind === "day" ? "Day" : "Night"} ${c.D(s.window.start).split(",")[0]}`,
      sub: `${s.rows.length} steps · ${c.hrs(s.hours)}`,
      count: s.rows.length,
      body: (print) => s.rows.length === 0 ? <Empty>Nothing scheduled on this shift.</Empty> : (
        <StepTable print={print} box rightHead="Hours" rows={shiftRowsOf(s)} />
      ),
      data: () => [s.rows.length === 0 ? { k: "empty", text: "Nothing scheduled on this shift." } : stepsBlock(shiftRowsOf(s), "Hours")],
    })),
    closeSection("Close", ["Project / turnaround lead", "Operations", "Safety", "Each contractor lead"], "Attendance and sign-off"),
  ];
  return secs;
}

function closeoutSections(co: ReturnType<typeof buildCloseout>, report: ShiftReport, c: Ctx, cancelled: CancelledJob[]): Sec[] {
  const finalStats = [
    { label: "Complete", value: `${co.actualPct}%`, tone: (co.actualPct >= 100 ? "emerald" : "amber") as "emerald" | "amber" },
    { label: "Steps done", value: `${co.done}/${co.steps}`, tone: "slate" as const },
    // No "on time / late": when a step is marked done isn't when it finished.
    { label: "Still open", value: `${co.open.length}`, tone: (co.open.length ? "amber" : "emerald") as "amber" | "emerald" },
    { label: "Blocked / on hold", value: `${co.blocked.length}`, tone: (co.blocked.length ? "rose" : "slate") as "rose" | "slate" },
  ];
  const openRows = co.open.map((r) => rowFromPlan(r, c, { right: `${r.percent}%` }));
  const blockedRows = co.blocked.map((r) => rowFromPlan(r, c, {
    right: `${r.percent}%`,
    extraTags: [r.leaf.status === "blocked" ? { t: "blocked", tone: "rose" } : { t: "on hold", tone: "amber" }],
    note: r.leaf.statusReason ? `Reason: ${r.leaf.statusReason}` : undefined,
  }));
  return [
    {
      id: "final", title: "Final standing", short: "Standing",
      sub: co.finish != null ? `Planned finish ${c.DT(co.finish)}` : undefined,
      flag: co.done < co.steps ? "amber" : null,
      body: () => (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 keep">
          {finalStats.map((x) => <Stat key={x.label} label={x.label} value={x.value} tone={x.tone} />)}
        </div>
      ),
      data: () => [{ k: "stats", items: finalStats }],
    },
    {
      id: "open", title: "Still open", short: "Open work", count: co.open.length, flag: co.open.some((r) => r.critical) ? "rose" : co.open.length ? "amber" : null,
      sub: co.open.length ? "Finish, hand over to operations, or move to the punch list" : "Every step is done",
      body: (print) => co.open.length === 0 ? <Empty>Nothing open.</Empty> : (
        <StepTable print={print} box ownerLine rightHead="Done" rows={openRows} />
      ),
      data: () => [co.open.length === 0 ? { k: "empty", text: "Nothing open." } : stepsBlock(openRows, "Done")],
    },
    {
      id: "blocked", title: "Blocked / on hold", short: "Blocked", count: co.blocked.length, flag: co.blocked.length ? "rose" : null,
      body: (print) => co.blocked.length === 0 ? <Empty>Nothing blocked or on hold.</Empty> : (
        <StepTable print={print} ownerLine rightHead="Done" rows={blockedRows} />
      ),
      data: () => [co.blocked.length === 0 ? { k: "empty", text: "Nothing blocked or on hold." } : stepsBlock(blockedRows, "Done")],
    },
    ...(cancelled.length ? [cancelledSection(cancelled, c)] : []),
    {
      id: "lessons", title: "Hand-back & lessons", short: "Lessons",
      body: (print) => <Prompts print={print} lines={2} items={[
        "Equipment handed back to operations — isolations removed, blinds out, permits closed",
        "Punch list and turnover documents — what's outstanding and who owns it",
        "What went well — keep doing",
        "What didn't — change next time",
      ]} />,
    },
    closeSection("Sign-off", ["Project / turnaround lead", "Operations", "Safety"]),
  ];
}

/** Jobs taken off this schedule that still get done somewhere else —
 *  with the note and where they went, so none is forgotten. */
function cancelledSection(jobs: CancelledJob[], c: Ctx): Sec {
  const when = (j: CancelledJob) => [j.at != null && Number.isFinite(j.at) ? c.D(j.at) : null, j.m.cancelledByName].filter(Boolean).join(" · ");
  const title = (j: CancelledJob) => (j.crumbs.length ? `${j.crumbs[j.crumbs.length - 1]} — ${j.m.name}` : j.m.name);
  return {
    id: "cancelled", title: "Cancelled from this schedule", short: "Cancelled", count: jobs.length, flag: "amber",
    sub: "Still to be done — moved off this schedule",
    body: (print) => (
      <div className={`rounded-md border border-amber-300 dark:border-amber-800/70 divide-y divide-amber-200 dark:divide-amber-900/60 ${print ? "text-[8.5pt]" : "text-[12.5px]"}`}>
        {jobs.map((j) => (
          <div key={j.m.id ?? j.m.name} className={`keep ${print ? "px-1.5 py-1" : "px-2.5 py-2"} flex flex-col gap-0.5`}>
            <div className="flex items-baseline gap-x-2 flex-wrap">
              <b className="text-[var(--color-text)]">{title(j)}</b>
              {j.crumbs.length > 1 && <span className="text-[11px] text-[var(--color-text-faint)]">{j.crumbs.slice(0, -1).join(" › ")}</span>}
              {j.steps > 1 && <span className="text-[11px] text-[var(--color-text-muted)]">{j.steps} steps</span>}
            </div>
            <div className="text-[var(--color-text)]">
              <span className="text-[10px] font-black uppercase tracking-wider text-amber-700 dark:text-amber-400">Moved to </span>
              {j.m.movedTo ? <b>{j.m.movedTo}</b> : <span className="text-[var(--color-text-faint)]">not said</span>}
            </div>
            {j.m.cancelNote && <div className="text-[var(--color-text-muted)] italic">“{j.m.cancelNote}”</div>}
            <div className="text-[10.5px] text-[var(--color-text-faint)]">Cancelled {when(j)}</div>
          </div>
        ))}
      </div>
    ),
    data: () => [{
      k: "table", head: ["Job", "Moved to", "Note", "Cancelled"],
      rows: jobs.map((j) => [title(j), j.m.movedTo || "—", j.m.cancelNote || "", when(j)]),
    }],
  };
}

function closeSection(title: string, signers: string[], sub = "Notes, actions and sign-off"): Sec {
  return {
    id: "close", title, short: title, sub,
    body: (print) => (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 keep">
        <div className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5">
          <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Notes & actions</div>
          {Array.from({ length: print ? 4 : 3 }).map((_, i) => <div key={i} className="h-5 border-b border-dotted border-[var(--color-border-strong)]" />)}
        </div>
        <div className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 space-y-2">
          <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Sign-off</div>
          {signers.map((who) => (
            <div key={who} className="flex items-end gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span className="w-40 shrink-0">{who}</span>
              <span className="flex-1 border-b border-[var(--color-border-strong)]" />
              <span className="w-12 border-b border-[var(--color-border-strong)] text-center text-[9px]">time</span>
            </div>
          ))}
        </div>
      </div>
    ),
  };
}

// ─── Masthead & footnote ─────────────────────────────────────────────

function Masthead({ meeting, report, kickoff, closeout, ctx: c, asOf, now, rehearsal, historyNote, projectName, print, crew }: {
  meeting: MeetingKind; report: ShiftReport; kickoff: ReturnType<typeof buildKickoff>; closeout: ReturnType<typeof buildCloseout>;
  ctx: Ctx; asOf: number; now: number; rehearsal: boolean; historyNote: string | null; projectName?: string; print: boolean;
  /** The crew the report is narrowed to. */
  crew?: string | null;
}) {
  const { overall, shift, next } = report;
  const standing = overall.standing;
  const pill = meeting === "kickoff" ? null
    : meeting === "closeout"
      ? { label: closeout.done >= closeout.steps ? "COMPLETE" : `${closeout.steps - closeout.done} OPEN`, cls: closeout.done >= closeout.steps ? "emerald" : "amber", Icon: CheckCircle2 }
      : standing === "ahead" ? { label: "AHEAD", cls: "emerald", Icon: TrendingUp }
        : standing === "behind" ? { label: "BEHIND", cls: "rose", Icon: TrendingDown } : { label: "ON TRACK", cls: "slate", Icon: Minus };
  const pillCls = !pill ? "" : print
    ? `border-2 ${pill.cls === "emerald" ? "border-emerald-700 text-emerald-800" : pill.cls === "rose" ? "border-rose-700 text-rose-800" : pill.cls === "amber" ? "border-amber-700 text-amber-800" : "border-slate-700 text-slate-800"}`
    : pill.cls === "emerald" ? "bg-emerald-600 text-white" : pill.cls === "rose" ? "bg-rose-600 text-white" : pill.cls === "amber" ? "bg-amber-500 text-white" : "bg-slate-700 text-white";
  const title = meeting === "kickoff" ? "Kick-off meeting" : meeting === "closeout" ? "Close-out meeting" : "Shift turnover";
  const when = meeting === "turnover"
    ? <>{shiftName(shift)} {c.D(shift.start)} {c.win(shift)} <span className="opacity-60">→</span> <b>{shiftName(next)} {c.D(next.start)} {c.win(next)}</b></>
    : meeting === "kickoff"
      ? <>{kickoff.start != null ? <>Job starts <b>{c.DL(kickoff.start)} {c.T(kickoff.start)}</b> · {kickoff.daysTotal} days</> : "No dated work yet"}</>
      : <>{closeout.finish != null ? <>Planned finish <b>{c.DT(closeout.finish)}</b></> : null}</>;
  return (
    <header className={print ? "pb-1.5 border-b-2 border-slate-900" : "px-4 sm:px-5 py-2.5 bg-slate-900 text-white"}>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className={`text-[10px] font-black uppercase tracking-[0.18em] ${print ? "text-slate-500" : "text-slate-400"}`}>{title}</span>
            <h2 className={`${print ? "text-[13pt]" : "text-[17px]"} font-black leading-tight truncate`}>{projectName ?? "Schedule"}</h2>
          </div>
          <div className={`text-[11px] ${print ? "text-slate-700" : "text-slate-300"}`}>
            {when} · as of {c.T(meeting === "turnover" ? asOf : now)} {tzAbbrev(c.tz, now)}
            {crew && meeting === "turnover" && <span className={`ml-2 whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-black uppercase ${print ? "border border-slate-700 text-slate-900" : "bg-white text-slate-900"}`}>{crew} only</span>}
            {rehearsal && meeting === "turnover" && <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-black uppercase ${print ? "border border-amber-700 text-amber-800" : "bg-amber-400 text-slate-900"}`}>Rehearsal — shift not started</span>}
            {historyNote && meeting === "turnover" && <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${print ? "border border-slate-500 text-slate-700" : "bg-slate-700 text-slate-100"}`}>Earlier shift — {historyNote}</span>}
          </div>
        </div>
        {pill && (
          <div className={`rounded-lg px-2.5 py-1 text-right shrink-0 ${pillCls}`}>
            <div className="inline-flex items-center gap-1 text-[13px] font-black leading-none"><pill.Icon className="w-3.5 h-3.5" /> {pill.label}</div>
            {meeting === "turnover" && <div className="text-[10px] font-bold opacity-90">{overall.actualPct}% vs {overall.plannedPct}% plan</div>}
          </div>
        )}
      </div>
    </header>
  );
}

function Footnote({ meeting, ctx: c, asOf, now, projectName }: { meeting: MeetingKind; ctx: Ctx; asOf: number; now: number; projectName?: string }) {
  return (
    <footer className="pt-2 mt-2 border-t border-[var(--color-border)] text-[9.5px] text-[var(--color-text-faint)] flex justify-between gap-3 flex-wrap">
      <span>
        {meeting === "turnover" ? `Plan % = work the schedule expected done by ${c.DT(asOf)}, hour-weighted; actual % = progress entered. Gap = the difference in planned work-hours. ` : ""}
        Critical = on the chain that drives the finish date. Hours are planned work-hours.
      </span>
      <span className="shrink-0">Printed {c.DT(now)}{projectName ? ` · ${projectName}` : ""}</span>
    </footer>
  );
}

// ─── Building blocks ─────────────────────────────────────────────────

function SectionHead({ n, s, collapsed, big, print }: { n: number; s: Sec; collapsed?: boolean; big?: boolean; print?: boolean }) {
  const ring = s.flag === "rose" ? "bg-rose-600" : s.flag === "amber" ? "bg-amber-500" : "bg-slate-900";
  return (
    <div className={`flex items-center gap-2 ${print ? "pb-0.5 border-b border-slate-900" : "pb-1 border-b-2 border-slate-900 dark:border-slate-500"}`}>
      <span className={`${big ? "w-7 h-7 text-[13px]" : "w-5 h-5 text-[10.5px]"} rounded-full ${ring} text-white font-black flex items-center justify-center shrink-0`}>{n}</span>
      <span className={`${big ? "text-[18px]" : print ? "text-[10.5pt]" : "text-[13.5px]"} font-black uppercase tracking-wide`}>{s.title}</span>
      {s.sub && <span className={`min-w-0 truncate print:whitespace-normal print:overflow-visible ${big ? "text-[12px]" : "text-[11px]"} text-[var(--color-text-muted)]`}>— {s.sub}</span>}
      {!print && !big && <ChevronDown className={`ml-auto w-4 h-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${collapsed ? "-rotate-90" : ""}`} />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "emerald" | "rose" | "amber" | "slate" }) {
  const t = tone === "emerald" ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-900"
    : tone === "rose" ? "border-rose-300 bg-rose-50 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200 dark:border-rose-900"
      : tone === "amber" ? "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-900"
        : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]";
  return (
    <div className={`rounded-md border px-2.5 py-1 ${t}`}>
      <div className="text-[8.5px] font-black uppercase tracking-widest opacity-70">{label}</div>
      <div className="text-[17px] font-black leading-tight tabular-nums">{value}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-1 text-[11.5px] text-[var(--color-text-muted)] italic">{children}</div>;
}

function Blank({ print }: { print: boolean }) {
  return <span className={`inline-block ${print ? "w-28" : "w-24"} border-b border-dotted border-[var(--color-border-strong)]`}>&nbsp;</span>;
}

/** Talking points the meeting covers, with a box to tick. */
function Prompts({ items, print, lines = 0, cols = 2 }: { items: string[]; print: boolean; lines?: number; cols?: 2 | 3 }) {
  return (
    <ul className={`grid ${lines ? "grid-cols-1" : cols === 3 ? "grid-cols-1 sm:grid-cols-3 print:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"} gap-x-4 gap-y-1 keep`}>
      {items.map((t) => (
        <li key={t} className="text-[11.5px]">
          <label className="flex items-start gap-1.5">
            {print ? <Box /> : <input type="checkbox" className="mt-0.5 shrink-0" />}
            <span>{t}</span>
          </label>
          {Array.from({ length: lines }).map((_, i) => <div key={i} className="ml-5 h-4 border-b border-dotted border-[var(--color-border-strong)]" />)}
        </li>
      ))}
    </ul>
  );
}


type TagTone = "rose" | "amber" | "emerald" | "muted";
interface TagT { t: string; tone: TagTone }
function TagChip({ t, tone }: TagT) {
  const cls = tone === "rose" ? "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900"
    : tone === "amber" ? "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900"
      : tone === "emerald" ? "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900"
        : "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700";
  return <span className={`inline-block max-w-full whitespace-normal sm:whitespace-nowrap break-words px-1 py-px rounded border text-[8.5px] font-black uppercase tracking-wider align-middle ${cls}`}>{t}</span>;
}

type NumTone = "rose" | "amber" | "slate";
function Num({ n, tone }: { n: number; tone: NumTone }) {
  const cls = tone === "rose" ? "bg-rose-600 text-white" : tone === "amber" ? "bg-amber-500 text-white" : "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100";
  return <span className={`inline-flex w-[18px] h-[18px] rounded-full text-[9.5px] font-black items-center justify-center ${cls}`}>{n}</span>;
}

function Box() {
  return <span className="inline-block w-3 h-3 mt-0.5 rounded-[2px] border-[1.5px] border-slate-500 shrink-0" aria-hidden />;
}

interface TGroup { key: string; title: string; crumbs: string; meta: string }
interface TRow {
  id: string;
  group: TGroup;
  n?: { num: number; tone: NumTone };
  box?: boolean;
  when: string;
  name: string;
  done?: boolean;
  tags?: Array<TagT | null>;
  who?: string;
  wo?: string;
  right: string;
  /** A second line under the step (a reason). */
  note?: string;
  /** On screen only: a control under the step (the meeting's decision). */
  control?: React.ReactNode;
  /** A small action beside the step's name (never printed). */
  inline?: React.ReactNode;
}

/** One line per step, grouped under its equipment with the equipment's
 *  window and progress on a thin header row. */
function StepTable({ rows, print, box, rightHead = "", whenHead = "When", ownerLine, flat }: {
  rows: TRow[]; print: boolean; box?: boolean; rightHead?: string; whenHead?: string;
  /** One list in the given order, the equipment named on each line (a
   *  sequence — the critical chain — reads in order, not by equipment). */
  flat?: boolean;
  /** Adds a blank "owner / decision" line under each row (decisions). */
  ownerLine?: boolean;
}) {
  // Group consecutive-by-first-appearance, keeping each group's rows in order.
  const groups: Array<{ g: TGroup; rows: TRow[] }> = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const k = r.group.title && !flat ? r.group.key : "__solo";
    if (!at.has(k)) { at.set(k, groups.length); groups.push({ g: r.group.title && !flat ? r.group : { key: "__solo", title: "", crumbs: "", meta: "" }, rows: [] }); }
    groups[at.get(k)!].rows.push(r);
  }
  const crew = React.useContext(ReportCrew);
  const open = useQuickLookOpen();
  const hasN = rows.some((r) => r.n);
  // Narrowed to one crew, every row's Who is that crew.
  const hasWho = !crew && rows.some((r) => r.who);
  const hasWo = rows.some((r) => r.wo);
  const cols = (box ? 1 : 0) + (hasN ? 1 : 0) + 3 + (hasWho ? 1 : 0) + (hasWo ? 1 : 0);
  const one = "whitespace-nowrap overflow-hidden text-ellipsis";
  const cell = print ? "px-1 py-[1px]" : "px-1.5 py-[3px]";
  return (
    <div className={`rounded-md border border-slate-300 dark:border-slate-700 ${print ? "" : "overflow-x-auto"}`}>
      <table className={`w-full border-collapse table-fixed ${print ? "text-[8.5pt]" : "text-[12px]"}`}>
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800/60 text-[9px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 text-left">
            {box && <th className={`${cell} w-5`} />}
            {hasN && <th className={`${cell} w-6`}>#</th>}
            <th className={`${cell} ${print ? "w-[104px]" : "w-[76px] sm:w-[124px]"}`}>{whenHead}</th>
            <th className={cell}>Step</th>
            {/* Kept as zero-width columns on a phone (not removed), so the
                equipment rows' full-width cells don't add phantom columns
                that squeeze the step's. */}
            {hasWho && <th className={`${cell} w-0 sm:w-[132px] print:w-[132px] max-sm:p-0 max-sm:text-[0px] overflow-hidden`}>Who</th>}
            {hasWo && <th className={`${cell} w-0 md:w-[64px] print:w-[64px] max-md:p-0 max-md:text-[0px] overflow-hidden`}>WO</th>}
            <th className={`${cell} w-[96px] text-right`}>{rightHead}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ g, rows: list }) => (
            <React.Fragment key={g.key}>
              {g.title && (
                <tr className="bg-slate-100 dark:bg-slate-800 border-t border-slate-300 dark:border-slate-700">
                  <td colSpan={cols} className={`${cell} text-[11px]`}>
                    <b>{g.title}</b>
                    {g.crumbs && <span className="text-slate-500 dark:text-slate-400"> · {g.crumbs}</span>}
                    {g.meta && <span className="float-right font-mono text-[10px] text-slate-600 dark:text-slate-300">{g.meta}</span>}
                  </td>
                </tr>
              )}
              {list.map((r) => (
                <React.Fragment key={r.id}>
                  <tr className="border-t border-slate-200 dark:border-slate-700/60 align-top">
                    {box && <td className={cell}><Box /></td>}
                    {hasN && <td className={cell}>{r.n ? <Num n={r.n.num} tone={r.n.tone} /> : null}</td>}
                    <td className={`${cell} font-mono tabular-nums font-bold text-[10.5px] break-words overflow-hidden`}>{r.when}</td>
                    <td className={cell}>
                      {flat && r.group.title && <span className="text-slate-500 dark:text-slate-400">{r.group.title} › </span>}
                      {open && !print ? (
                        <button type="button" onClick={() => open(r.id)} title="When it's due, the goal for the shift, what comes next"
                          className={`text-left hover:underline decoration-dotted underline-offset-2 ${r.done ? "line-through text-slate-400" : "font-semibold"}`}>{r.name}</button>
                      ) : (
                        <span className={r.done ? "line-through text-slate-400" : "font-semibold"}>{r.name}</span>
                      )}
                      {r.tags?.filter((t): t is TagT => !!t).map((t) => <span key={t.t} className="ml-1"><TagChip t={t.t} tone={t.tone} /></span>)}
                      {!print && r.inline && <span className="ml-1.5 align-middle">{r.inline}</span>}
                      {r.note && <div className="text-[10.5px] italic text-slate-600 dark:text-slate-300">{r.note}</div>}

                      {ownerLine && <div className="text-[10px] text-slate-500 mt-0.5">Owner / decision: <span className="inline-block w-44 border-b border-dotted border-slate-400 align-baseline">&nbsp;</span></div>}
                    </td>
                    {hasWho && <td className={`${cell} hidden sm:table-cell print:table-cell text-[10.5px] text-slate-600 dark:text-slate-300 max-w-[132px] ${one}`} title={r.who}>{r.who}</td>}
                    {hasWo && <td className={`${cell} hidden md:table-cell print:table-cell font-mono text-[10px] text-slate-600 dark:text-slate-300 ${one}`}>{r.wo}</td>}
                    <td className={`${cell} text-right font-mono font-bold text-[10.5px] text-slate-700 dark:text-slate-200 whitespace-nowrap`}>{r.right}</td>
                  </tr>
                  {/* The meeting's decision on this step — its own full-width line. */}
                  {!print && r.control && (
                    <tr className="align-top"><td colSpan={cols} className={`${cell} pt-0`}>{r.control}</td></tr>
                  )}
                </React.Fragment>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A plain table: header + rows of cells. */
function SimpleTable({ head, rows, print }: { head: string[]; rows: Array<{ id: string; cells: React.ReactNode[] }>; print: boolean }) {
  const cell = print ? "px-1 py-[1px]" : "px-1.5 py-[3px]";
  return (
    <div className={`rounded-md border border-slate-300 dark:border-slate-700 ${print ? "" : "overflow-x-auto"}`}>
      <table className={`w-full border-collapse ${print ? "text-[8.5pt]" : "text-[12px]"}`}>
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800/60 text-[9px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 text-left">
            {head.map((h) => <th key={h} className={cell}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-slate-200 dark:border-slate-700/60 align-top">
              {r.cells.map((c, i) => <td key={i} className={`${cell} ${i === 0 ? "" : "whitespace-nowrap font-mono text-[10.5px]"}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
