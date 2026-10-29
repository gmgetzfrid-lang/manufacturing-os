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
  Mail, FileText, Hourglass, Clock, Pencil, Plus, CalendarClock,
} from "lucide-react";
import type { Milestone, MilestoneNote } from "@/types/schema";
import { buildProgressIndex, leafPercent, type ProgressInfo } from "@/lib/scheduleProgress";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { withWorkOrderCrews } from "@/lib/workOrderCrew";
import { turnoverPlan, nextOf, standing, askedLine, doneOf, crewsOf, doneByTask, shareOf, watchLines, SEVERE_BEHIND_H, pathNote, competition, type TableOrder } from "@/lib/turnoverPlan";
import {
  buildShiftReport, shiftWindow, shiftAt, nextShift, previousShift, defaultReviewShift, nextShiftWithWork, expectedByParent, paceOf, expectedFraction, workShiftOf, staffedDueMs, meetingLeadMin, type Pace, type WorkShift,
  DEFAULT_SHIFT_TIMES, type ShiftTimes, type ShiftRow, type ShiftWindow, type ShiftReport, type PullCrew,
  crewsOnReport, filterShiftReport, whoOf, notesForShift, TURNOVER_GRACE_MS, type PathInfo,
} from "@/lib/shiftReport";
import { buildKickoff, buildCloseout, defaultMeeting, type MeetingKind, type PlanRow } from "@/lib/meetingPlan";
import { clockLabel, fmtInTz, tzAbbrev } from "@/lib/scheduleTz";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { toPlainText, toEmailHtml, type ExportBlock, type ExportCell, type ExportDoc, type ExportStepRow } from "@/lib/reportExport";
import { turnoverUpdate, withoutEmpty, noteLine, hazardJobsOf, crewLine, forecastText, discoverySub, discoveryBlock } from "@/lib/managementUpdate";
import { useShiftTimes, useShiftTimesSaved, saveProjectShiftTimes, shiftTimesProblem } from "@/lib/shiftTimesStore";
import { notesFor } from "@/lib/milestones";
import { useShiftRecords, saveShiftRecord, lastSameKind, openFollowUps, newId, CLOSEOUT_KEY, type CrewCount, type Incident, type ShiftNote, type ShiftRecord, type Lesson } from "@/lib/shiftRecord";
import { buildLookBack, CAUSE_LABEL, type LookBack, type StepLook } from "@/lib/lookBack";
import { CrewCountEditor, IncidentsLine, ShiftNotesBox, AddCompany, TimeLogButton } from "@/components/projects/ShiftRecordParts";
import { useSortRows, Grip } from "@/components/projects/SortRows";
import CalendarQuickView, { type StepUpdate } from "@/components/projects/CalendarQuickView";
import { discoveries, discoveryOf, discoverySummary, discoveryStepLine, impactLine, ADDED, kindOf, addedTitle, type Discovery } from "@/lib/discovery";
import { buildTimeLog, downloadTimeLog } from "@/lib/timeLog";
import { loadProgressLog, scheduleAt, type ProgressLogRow } from "@/lib/progressHistory";
import { resolveCriticalPath, floatsOf, pathMarks, CRITICAL_MODES, type PathMarks } from "@/lib/criticalPath";
import { useCriticalMode, saveCriticalMode } from "@/lib/criticalModeStore";
import { effectiveSpans } from "@/lib/scheduleTime";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { SafetyMomentBox } from "@/components/projects/SafetyMomentBox";
import { useLetterhead } from "@/lib/letterheadStore";
import { letterheadDocument, letterheadLayersHtml, letterheadPrintCss, type Letterhead } from "@/lib/letterhead";
import { riskHistory, type ProjectBase } from "@/lib/safetyTalk";
import type { HazardJobInput, HazardKind } from "@/lib/safetyMoment";
import { QuickLookCard, QuickLookOpen, TaskSearch, useQuickLookOpen } from "@/components/projects/TaskQuickLook";
import { quickLook, quickLookIndex } from "@/lib/taskQuickLook";
import type { CancelledJob } from "@/lib/cancelledJobs";
import { handoverKey, decisionsToShip, suggestCrews, askedOutcomes, askedResult, capacityOf, type HandoverDecision } from "@/lib/shiftHandover";
import { TryControl, ShipBar } from "@/components/projects/HandoverControls";
import { PullAheadPicker } from "@/components/projects/PullAheadPicker";
import { useHandoverDraft } from "@/lib/useHandoverDraft";
import { scopeOf } from "@/lib/pullAhead";
import { ShiftHourlyBox, type HourlyCtx } from "@/components/projects/ShiftHourly";
import { approvedLines, hourlyClocks } from "@/lib/shiftHourly";

/** The crew the report is narrowed to (tables then drop their Who column). */
const ReportCrew = React.createContext<string | null>(null);

interface Props {
  milestones: Milestone[];
  progress?: Map<string, ProgressInfo>;
  /** Unused — the report reads the critical path from lib/criticalPath
   *  itself (the project's own setting), for the shift it shows. */
  criticalIds?: Set<string>;
  projectId: string;
  projectName?: string;
  /** Jobs taken off this schedule (done elsewhere) — on the close-out. */
  cancelled?: CancelledJob[];
  /** Who's at the meeting — marks exceptions and ships the turnover. */
  userId?: string;
  userName?: string;
  canEdit?: boolean;
  /** Update a step from its row — the same save as the calendar's quick view. */
  onUpdateStep?: (id: string, u: StepUpdate) => Promise<boolean>;
  /** Found work: into the schedule (DiscoveryForm, hosted by the schedule). */
  onDiscovery?: (task: Milestone) => void;
  /** The schedule's clock for the critical path — the same moment the
   *  calendar and the discovery preview use, so the forecast reads alike. */
  pathNow?: number;
  /** Opens "Plan the next shift" (swap, pull in, push out — hosted by the
   *  schedule, the same panel as the calendar's). */
  onPlanNext?: (next: ShiftWindow) => void;
  /** Correct when a step really started / finished. */
  onFixTimes?: (id: string, t: { start?: number | null; finish?: number | null }) => Promise<boolean>;
}

const NONE_CANCELLED: CancelledJob[] = [];

const MEETINGS: Array<{ id: MeetingKind; label: string; Icon: typeof Rocket }> = [
  { id: "kickoff", label: "Kick-off", Icon: Rocket },
  { id: "turnover", label: "Shift turnover", Icon: ArrowLeftRight },
  { id: "closeout", label: "Close-out", Icon: Trophy },
];

export default function ShiftReportView({ milestones: rawLive, progress: liveProgress, projectId, projectName, cancelled = NONE_CANCELLED, userId, userName, canEdit = false, onUpdateStep, onDiscovery, pathNow, onPlanNext, onFixTimes }: Props) {
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
  // The company letterhead printed reports sit on (Schedule setup → Printed reports).
  const { lh } = useLetterhead(projectId);
  const lhLayers = useMemo(() => (lh ? letterheadLayersHtml(lh) : null), [lh]);

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
  const recordedBy = shift.end + TURNOVER_GRACE_MS;
  const history = useMemo(
    () => (pastShift && log ? scheduleAt(live, log, recordedBy) : null),
    [pastShift, log, live, recordedBy],
  );
  // Only a record that reaches back to the shift replaces today's
  // progress; otherwise it's today's, and the label says so.
  const asThen = history?.complete ? history : null;
  const milestones = asThen ? asThen.milestones : live;
  const progress = useMemo(() => (asThen ? buildProgressIndex(asThen.milestones, tz) : liveProgress), [asThen, liveProgress, tz]);
  // The schedule as it stood when the shift began — only when the record
  // reaches back. Each step's % then; and the critical path then.
  const atStart = useMemo(() => {
    if (!log) return null;
    const then = scheduleAt(live, log, shift.start);
    if (!then.complete) return null;
    // Times recorded after it began hadn't happened yet.
    const later = (v: unknown) => v != null && Date.parse(String(v)) > shift.start;
    return then.milestones.map((m) => ({ ...m, actualStartAt: later(m.actualStartAt) ? null : m.actualStartAt, actualAt: m.status === "completed" && !later(m.actualAt) ? m.actualAt : null }) as Milestone);
  }, [log, live, shift.start]);
  const startPct = useMemo(() => (atStart ? new Map(atStart.filter((m) => m.id).map((m) => [m.id!, m.status === "completed" ? 100 : m.percentComplete ?? 0])) : undefined), [atStart]);
  // The critical path — the project's own setting, through lib/criticalPath
  // like every other view: as of the report, and when the shift began (what
  // Done credits). Float from the links rides along (lib/cpm).
  const criticalMode = useCriticalMode(projectId);
  // The shift on now (or just ended) reads the path as of now — on the
  // schedule's one clock; an earlier shift, as it stood then.
  const pathAt = pastShift ? asOf : pathNow ?? now;
  const crit = useMemo(() => resolveCriticalPath(milestones, criticalMode, { now: pathAt, tz }), [milestones, criticalMode, pathAt, tz]);
  const critThen = useMemo(() => (atStart ? resolveCriticalPath(atStart, criticalMode, { now: shift.start, tz }) : null), [atStart, criticalMode, shift.start, tz]);
  const criticalIds = crit.ids;
  const path = useMemo<PathInfo>(() => ({
    criticalThen: critThen?.ids, near: crit.near,
    floatH: crit.cpm ? floatsOf(crit.cpm, crit.off) : undefined, floatThenH: critThen?.cpm ? floatsOf(critThen.cpm, critThen.off) : undefined,
  }), [crit, critThen]);
  const forecast = useMemo(() => (crit.cpm && Number.isFinite(crit.cpm.forecastFinish) ? { finish: crit.cpm.forecastFinish, slipH: crit.cpm.slipH } : undefined), [crit]);
  // Discovery work on the schedule (lib/discovery) — as it stood for the shift.
  const discoveryList = useMemo(() => discoveries(milestones), [milestones]);
  // Set to something other than the links while they're there: say what
  // they'd give, and offer the switch (for everyone on the project) — only
  // when it would change what's flagged (hand marks win either way).
  const [pathMsg, setPathMsg] = useState<string | null>(null);
  const pathSource = useMemo(() => {
    if (!crit.cpm || crit.mode === "links") return undefined;
    const links = resolveCriticalPath(milestones, "links", { now: pathAt, tz }).ids;
    if (links.size === crit.ids.size && [...links].every((id) => crit.ids.has(id))) return undefined;
    const calculated = links.size;
    return {
      label: CRITICAL_MODES.find((x) => x.value === crit.mode)?.label ?? crit.mode, theirs: crit.ids.size, calculated,
      onUse: canEdit ? () => { setPathMsg(null); saveCriticalMode(projectId, "links").catch((e: Error) => setPathMsg(e.message)); } : undefined,
      msg: pathMsg,
    };
  }, [crit, milestones, pathAt, tz, canEdit, projectId, pathMsg]);
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
    () => buildShiftReport({ milestones, progress, criticalIds, path, tz, times, shift, now: asOf, pullIds: pullKey ? pullKey.split(",") : undefined, startPct }),
    [milestones, progress, criticalIds, path, tz, times, shift, asOf, pullKey, startPct],
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

  // Each step's comment for THIS shift ("sent out for calibration") — shown
  // as a quiet line under the step, here and in the copied update. Only a
  // comment written for the shift counts (the time it happened, else when
  // it was typed): an older one doesn't trail onto later reports.
  const stepIds = useMemo(() => {
    const parents = new Set(milestones.map((m) => m.parentId).filter(Boolean));
    return milestones.filter((m) => m.id && !parents.has(m.id)).map((m) => m.id!).sort().join(",");
  }, [milestones]);
  const [allNotes, setAllNotes] = useState<MilestoneNote[]>([]);
  const [notesTick, setNotesTick] = useState(0);
  useEffect(() => {
    const on = () => setNotesTick((t) => t + 1);
    window.addEventListener("milestone-notes:changed", on);
    return () => window.removeEventListener("milestone-notes:changed", on);
  }, []);
  useEffect(() => {
    let live = true;
    if (!stepIds) return;
    notesFor(stepIds.split(",")).then((n) => { if (live) setAllNotes(n); }).catch(() => { /* comments are extra */ });
    return () => { live = false; };
  }, [stepIds, notesTick]);
  // Which shift a comment is for: one with the time it happened is that
  // shift's; one typed without a time counts for the turnover it was
  // written at — the hour after a shift ends is still its meeting (the
  // same cut-off as the progress). Each comment lands on one report.
  const grace = recordedBy - shift.end;
  const shiftNotes = useMemo(() => notesForShift(allNotes, shift, grace), [allNotes, shift, grace]);
  const noteThen = useCallback((id: string) => {
    const n = shiftNotes.note.get(id);
    return n ? { body: n.body, at: new Date(n.at).toISOString(), by: n.by } : undefined;
  }, [shiftNotes]);
  // Why a step is behind, as said for this shift — beside its hours.
  const whyOf = useCallback((id: string) => shiftNotes.why.get(id)?.body, [shiftNotes]);
  // The time each step was done on the shift (its finish), or moved last —
  // shown in Done only when "Times" is on; always in the time log.
  const [stamps, setStampsState] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the viewer's own choice, read once after mount
    try { setStampsState(localStorage.getItem("shiftReport:stamps") === "1"); } catch { /* private mode */ }
  }, []);
  const setStamps = useCallback((v: boolean) => { setStampsState(v); try { localStorage.setItem("shiftReport:stamps", v ? "1" : "0"); } catch { /* private mode */ } }, []);
  const movedAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of log ?? []) {
      const t = Date.parse(r.at);
      if (r.old_status != null && t >= shift.start && t <= shift.end) m.set(r.milestone_id, t);
    }
    return m;
  }, [log, shift.start, shift.end]);
  const timeOf = useCallback((id: string) => {
    const m = byId.get(id);
    const a = m?.status === "completed" && m.actualAt ? new Date(m.actualAt).getTime() : NaN;
    return Number.isFinite(a) && a >= shift.start && a <= shift.end ? a : movedAt.get(id);
  }, [byId, movedAt, shift.start, shift.end]);
  // Where a whole task stands: its % done and % planned by now.
  const taskPct = useCallback((id: string) => {
    const p = progress?.get(id)?.percent;
    return p == null ? undefined : { pct: p, plan: planByTask.get(id) };
  }, [progress, planByTask]);
  // The shift's own record: crews on site, incidents, notes & actions.
  const { records, error: recErr } = useShiftRecords(projectId);
  const thisKey = handoverKey(shift), nextKey = handoverKey(report.next);
  const [recMsg, setRecMsg] = useState<string | null>(null);
  const saveRec = useCallback(async (key: string, change: (r: ShiftRecord) => ShiftRecord) => {
    if (!userId || !orgId) return;
    try { await saveShiftRecord({ orgId, projectId, shiftKey: key, userId, change }); setRecMsg(null); }
    catch (e) { setRecMsg((e as Error).message); }
  }, [orgId, projectId, userId]);
  // The shift's entries — the time log for its window — for the
  // hour-by-hour notes to be written from.
  const shiftRows = useCallback(async () => {
    const [rows, notes] = await Promise.all([loadProgressLog(projectId), notesFor(stepIds ? stepIds.split(",") : [])]);
    return buildTimeLog({ milestones: live, log: rows ?? [], notes, records, tz, times, from: shift.start, to: shift.end });
  }, [projectId, stepIds, live, records, tz, times, shift.start, shift.end]);
  const saveHourly = useCallback(async (next: ShiftRecord["hourly"] | null) => {
    if (!userId || !orgId) throw new Error("Sign in to save the notes.");
    await saveShiftRecord({ orgId, projectId, shiftKey: thisKey, userId, change: (r) => ({ ...r, hourly: next ?? undefined }) });
  }, [orgId, projectId, userId, thisKey]);
  // The tables' order as dragged at the meeting — shown at once, kept on
  // the shift's record (the email follows it too).
  const [orderLocal, setOrderLocal] = useState<{ key: string; order: TableOrder } | null>(null);
  const tableOrder = orderLocal?.key === thisKey ? orderLocal.order : records.get(thisKey)?.order;
  const sheet = useMemo<SheetCtx>(() => {
    const recThis = records.get(thisKey), recNext = records.get(nextKey);
    const labelOf = (key: string) => { const [d, k] = key.split(":"); const w = shiftWindow(d, k as "day" | "night", tz, times); return `${ctx.D(w.start)} ${k}`; };
    const by = userName ?? null;
    return {
      stamps, timeOf, whyOf, taskPct,
      edit: canEdit && !!userId && !!orgId,
      crewsThis: recThis?.crews ?? {}, crewsNext: recNext?.crews ?? {},
      hintThis: lastSameKind(records, thisKey)?.crews, hintNext: lastSameKind(records, nextKey)?.crews,
      setCrew: (which, crew, v) => void saveRec(which === "this" ? thisKey : nextKey, (r) => ({ ...r, crews: { ...(r.crews ?? {}), [crew]: { ...(r.crews?.[crew] ?? {}), ...v } } })),
      incidents: recThis?.incidents,
      setNone: (none) => void saveRec(thisKey, (r) => ({ ...r, incidents: { ...(r.incidents ?? {}), none: none ? { at: Date.now(), by } : null } })),
      addIncident: (x) => void saveRec(thisKey, (r) => ({ ...r, incidents: { none: null, items: [...(r.incidents?.items ?? []), { id: newId(), ...x, by }] } })),
      removeIncident: (id) => void saveRec(thisKey, (r) => ({ ...r, incidents: { ...(r.incidents ?? {}), items: (r.incidents?.items ?? []).filter((x) => x.id !== id) } })),
      notes: [...(recThis?.notes ?? []).map((n) => ({ ...n, shiftKey: thisKey })), ...openFollowUps(records, thisKey).map((n) => ({ ...n, from: labelOf(n.shiftKey) }))],
      addNote: (x) => void saveRec(thisKey, (r) => ({ ...r, notes: [...(r.notes ?? []), { id: newId(), ...x, by }] })),
      clearNote: (n) => void saveRec(n.shiftKey, (r) => ({ ...r, notes: (r.notes ?? []).map((y) => (y.id === n.id ? { ...y, cleared: { at: Date.now(), by } } : y)) })),
      removeNote: (n) => void saveRec(n.shiftKey, (r) => ({ ...r, notes: (r.notes ?? []).filter((y) => y.id !== n.id) })),
      error: recMsg ?? (recErr && canEdit ? recErr : null),
      tz,
      hourly: orgId ? {
        notes: recThis?.hourly, save: saveHourly, rows: shiftRows, orgId, projectId, by,
        shiftTitle: `${shift.kind === "day" ? "Day shift" : "Night shift"} ${fmtInTz(shift.start, tz, { weekday: "short", month: "short", day: "numeric" })}`,
        window: ctx.win(shift),
      } : undefined,
      order: tableOrder,
      setOrder: (table, ids) => {
        setOrderLocal({ key: thisKey, order: { ...(tableOrder ?? {}), [table]: ids ?? undefined } });
        void saveRec(thisKey, (r) => ({ ...r, order: { ...(r.order ?? {}), [table]: ids ?? undefined } }));
      },
    };
  }, [records, thisKey, nextKey, tz, times, ctx, userName, stamps, timeOf, whyOf, taskPct, canEdit, userId, orgId, saveRec, recMsg, recErr, tableOrder, setOrderLocal, saveHourly, shiftRows, projectId, shift]);
  const shiftTitle = `${shift.kind === "day" ? "Day shift" : "Night shift"} ${fmtInTz(shift.start, tz, { weekday: "short", month: "short", day: "numeric" })}`;
  // The time log: every step's times, for the project file — its own
  // export, not part of the update.
  const [logBusy, setLogBusy] = useState(false);
  const [logMsg, setLogMsg] = useState<string | null>(null);
  const exportTimeLog = async (scope: "shift" | "job") => {
    setLogBusy(true); setLogMsg(null);
    try {
      const [rows, allNotes] = await Promise.all([loadProgressLog(projectId), notesFor(stepIds ? stepIds.split(",") : [])]);
      const out = buildTimeLog({ milestones: live, log: rows ?? [], notes: allNotes, records, tz, times, ...(scope === "shift" ? { from: shift.start, to: shift.end } : {}) });
      const name = (projectName ?? "Schedule").replace(/[\\/:*?"<>|]/g, "").trim() || "Schedule";
      await downloadTimeLog(out, {
        project: projectName ?? "Schedule", tz,
        title: scope === "shift" ? `Time log — ${shiftName(shift)} ${ctx.D(shift.start)}` : "Time log — whole job to date",
        fileName: `${name} - time log${scope === "shift" ? ` ${shift.dayKey} ${shift.kind}` : ""}.xlsx`,
      });
      setLogMsg(`${out.length} entr${out.length === 1 ? "y" : "ies"} exported.`);
    } catch (e) { setLogMsg(`Not exported: ${(e as Error).message}`); }
    setLogBusy(false);
  };
  // The project around the work: its name and the schedule's groups (a
  // turnaround?), the job's dates, and whether the whole job is behind.
  const safetyProject = useMemo<ProjectBase>(() => {
    const parents = new Set(live.map((m) => m.parentId).filter(Boolean));
    return {
      names: [projectName ?? "", ...live.filter((m) => m.isSummary || (m.id && parents.has(m.id))).map((m) => m.name)],
      start: report.overall.plannedStart, finish: report.overall.plannedFinish, tz,
      behind: report.overall.standing === "behind",
    };
  }, [live, projectName, report.overall.plannedStart, report.overall.plannedFinish, report.overall.standing, tz]);
  // The risk cards of the shifts before the next one, from the schedule —
  // so a kind of work that's led two shifts running steps aside.
  const nextStart = report.next.start;
  const recentRisks = useMemo(() => riskHistory(live, shiftAt(nextStart, tz, times), tz, times), [live, nextStart, tz, times]);
  const safety = useMemo(() => ({ project: safetyProject, recent: recentRisks }), [safetyProject, recentRisks]);
  // The step being updated from its row.
  const [editing, setEditing] = useState<string | null>(null);
  // The close-out's look back (lib/lookBack) — the job as it stands, its
  // whole history of comments and holds — and the lessons the team writes.
  const lookBack = useMemo(() => (meeting === "closeout" ? buildLookBack({ milestones: live, notes: allNotes, discoveries: discoveryList, now: pathAt, tz }) : null), [meeting, live, allNotes, discoveryList, pathAt, tz]);
  const lessonsRec = records.get(CLOSEOUT_KEY)?.lessons;
  const lessons = useMemo<LessonsCtx>(() => ({
    items: lessonsRec ?? [],
    add: canEdit && userId && orgId ? (kind, text) => void saveRec(CLOSEOUT_KEY, (r) => ({ ...r, lessons: [...(r.lessons ?? []), { id: newId(), kind, text, by: userName ?? null, at: Date.now() }] })) : undefined,
    remove: canEdit && userId && orgId ? (id) => void saveRec(CLOSEOUT_KEY, (r) => ({ ...r, lessons: (r.lessons ?? []).filter((x) => x.id !== id) })) : undefined,
    msg: recMsg ?? recErr,
  }), [lessonsRec, canEdit, userId, orgId, saveRec, userName, recMsg, recErr]);
  const sections = useMemo(() => meeting === "kickoff"
    ? kickoffSections(kickoff, ctx)
    : meeting === "closeout"
      ? closeoutSections(closeout, report, ctx, cancelled, discoveryList, lookBack, lessons)
      : turnoverSections(view, ctx, { onJump: jumpTarget ? () => pick(jumpTarget) : undefined, jumpTarget, noteOf: noteThen, times, crew, whole: report, handover: handoverCtx, safety, sheet, onEdit: canEdit && onUpdateStep ? setEditing : undefined, forecast, pathSource, discovery: discoveryList,
        onDiscovery: onDiscovery ? () => { const first = view.goals.all[0]?.parentId ?? view.review.done[0]?.parentId; const t = (first ? live.find((m) => m.id === first) : undefined) ?? live.find((m) => live.some((k) => k.parentId === m.id)); if (t) onDiscovery(t); } : undefined,
        // Only while the next shift is still ahead (or on).
        onPlanNext: onPlanNext && report.next.end > now ? () => onPlanNext(report.next) : undefined }),
  [meeting, kickoff, closeout, report, view, ctx, jumpTarget, noteThen, times, crew, cancelled, handoverCtx, safety, sheet, canEdit, onUpdateStep, forecast, pathSource, discoveryList, onDiscovery, live, onPlanNext, now, lookBack, lessons]);

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
          safetyProject: safety.project,
          safetyRecent: safety.recent,
          showTimes: stamps, timeOf, taskPct, whyOf,
          crewsThis: sheet.crewsThis, crewsNext: sheet.crewsNext,
          incidents: sheet.incidents && (sheet.incidents.none || sheet.incidents.items?.length) ? { none: !!sheet.incidents.none, items: sheet.incidents.items ?? [] } : undefined,
          shiftNotes: sheet.notes.map((n) => ({ at: n.at, text: n.text, followUp: n.followUp, from: n.from })),
          hourly: (() => { const ls = approvedLines(sheet.hourly?.notes); const cl = hourlyClocks(ls.map((l) => l.at), tz); return ls.map((l, i) => ({ clock: cl[i], text: l.text })); })(),
          order: sheet.order,
          forecast,
          discovery: discoveryList,
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
          ${lh ? "" : "@page { size: auto; margin: 9mm; }"}
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
          {meeting === "turnover" && (
            <>
              <button type="button" onClick={() => setStamps(!stamps)} aria-pressed={stamps}
                title="Show the time each step was done in Done — off keeps the update short (the times are always in the time log)"
                className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg border ${stamps ? "bg-slate-900 text-white border-slate-900" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                <Clock className="w-3.5 h-3.5" /> Times {stamps ? "on" : "off"}
              </button>
              <TimeLogButton busy={logBusy} msg={logMsg} onExport={(sc) => void exportTimeLog(sc)} shiftLabel={shiftTitle} />
            </>
          )}
          <CopyUpdate doc={exportDoc} meeting={meeting} lh={lh} stamps={meeting === "turnover" ? { on: stamps, set: setStamps } : undefined} />
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
          offsets or clips it. Hidden on screen by the style above. The
          report first; the safety topics on a page of their own after it.
          On the company letterhead when there is one: the letterhead behind
          every page, the report inside its margins. */}
      {mounted && createPortal(
        <div data-shift-print-root>
          {lh && lhLayers && (
            <>
              <style>{`@media print{${letterheadPrintCss(lh, "[data-shift-print-root]")}}`}</style>
              {/* Built from the checked letterhead: text escaped, pictures only pictures. */}
              {lhLayers.every && <div className="lh-layer" dangerouslySetInnerHTML={{ __html: lhLayers.every }} />}
              {lhLayers.first && <div className="lh-first" dangerouslySetInnerHTML={{ __html: lhLayers.first }} />}
            </>
          )}
          {(() => {
            const safetyAt = sections.findIndex((s) => s.id === "safety");
            const body = (
              <>
                {head(true)}
                <div style={{ padding: "4px 0" }}>
                  {sections.map((s, i) => (i === safetyAt ? null : (
                    <section key={s.id} style={{ marginTop: 10 }}>
                      <div className="sec-head"><SectionHead n={i + 1} s={s} print /></div>
                      <div style={{ marginTop: 4 }}>{s.body(true)}</div>
                    </section>
                  )))}
                  <Footnote meeting={meeting} ctx={ctx} asOf={asOf} now={now} projectName={projectName} />
                </div>
                {safetyAt >= 0 && (
                  <section style={{ breakBefore: "page" }}>
                    <div className="sec-head">
                      <div className="text-[8pt] text-slate-500">{projectName ?? "Schedule"} · shift turnover</div>
                      <div style={{ marginTop: 2 }}><SectionHead n={safetyAt + 1} s={sections[safetyAt]} print /></div>
                    </div>
                    <div style={{ marginTop: 6 }}>{sections[safetyAt].body(true)}</div>
                  </section>
                )}
              </>
            );
            return lh ? (
              <table className="lh-frame">
                <thead><tr><td /></tr></thead>
                <tfoot><tr><td /></tr></tfoot>
                <tbody><tr><td>{body}</td></tr></tbody>
              </table>
            ) : body;
          })()}
        </div>,
        document.body,
      )}
      {/* A row's step, updated right here: the calendar's quick view. */}
      {mounted && editing && onUpdateStep && createPortal(
        <RowEditor id={editing} milestones={live} progress={liveProgress} planNow={planByTask} tz={tz} times={times} shift={shift} marks={pathMarks(crit)}
          canEdit={canEdit} onUpdate={onUpdateStep} onFixTimes={onFixTimes} onClose={() => setEditing(null)} />,
        document.body,
      )}
    </div>
    </ReportCrew.Provider>
  );
}

/** One step from the report, in the quick view: status, %, the time it
 *  happened, its comment (revised in place too), why it's behind. */
function RowEditor({ id, milestones, progress, planNow, tz, times, shift, canEdit, onUpdate, onFixTimes, onClose, marks }: {
  id: string; milestones: Milestone[]; progress?: Map<string, ProgressInfo>; planNow?: Map<string, number>; marks?: PathMarks;
  tz: string; times: ShiftTimes; shift: ShiftWindow; canEdit: boolean;
  onUpdate: (id: string, u: StepUpdate) => Promise<boolean>; onClose: () => void;
  onFixTimes?: (id: string, t: { start?: number | null; finish?: number | null }) => Promise<boolean>;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const step = milestones.find((m) => m.id === id);
  if (!step) return null;
  const parent = step.parentId ? milestones.find((m) => m.id === step.parentId) : undefined;
  const parents = new Set(milestones.map((m) => m.parentId).filter(Boolean));
  const others = parent ? milestones.filter((m) => m.parentId === parent.id && m.id !== id && m.id && !parents.has(m.id)) : [];
  const label = `${shift.kind === "day" ? "Day shift" : "Night shift"} ${fmtInTz(shift.start, tz, { weekday: "short", month: "short", day: "numeric" })}`;
  return (
    <div className="fixed inset-0 z-[180] bg-black/30 print:hidden" onClick={onClose}>
      <div role="dialog" aria-label={`Update ${step.name}`} onClick={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-16 -translate-x-1/2 w-[440px] max-w-[94vw] max-h-[82dvh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-xl max-sm:left-0 max-sm:right-0 max-sm:top-auto max-sm:bottom-0 max-sm:translate-x-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:max-h-[88dvh]">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] pl-3 pr-1.5 py-1">
          <span className="text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Update from the report</span>
          <button type="button" onClick={onClose} aria-label="Close" className="w-7 h-7 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <CalendarQuickView key={id} task={parent ?? step} onDay={[step]} others={others} dayKey={shift.dayKey} band={shift.kind} dayLabel={label}
          tz={tz} times={times} progress={progress} planNow={planNow} canEdit={canEdit} onUpdate={onUpdate} onFixTimes={onFixTimes} marks={marks} />
      </div>
    </div>
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
function CopyUpdate({ doc, meeting, lh, stamps }: { doc: () => ExportDoc; meeting: MeetingKind; lh?: Letterhead | null;
  /** Times on Done steps — the report's switch, mirrored in the box. */
  stamps?: { on: boolean; set: (v: boolean) => void } }) {
  const key = `shiftReport.copyOff.${meeting}`;
  // Sections left out unless ticked (the safety focus): the ones ticked.
  const onKey = `shiftReport.copyOn.${meeting}`;
  // While the box is open the update is rebuilt from the report as it
  // stands — a change made with the box open (times on / off) shows at once.
  const [isOpen, setIsOpen] = useState(false);
  const d = useMemo(() => (isOpen ? doc() : null), [isOpen, doc]);
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
    setOff(new Set([...saved.filter((id) => !flagged.has(id)), ...quiet])); setDone(null); setIsOpen(true);
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

  // Print what goes in the email — the safety topics on a page of their
  // own at the end, on the company letterhead when there is one.
  const printIt = () => {
    const w = window.open("", "_blank");
    if (!w) { setDone({ what: "text", ok: false }); return; }
    const forPrint = picked ? toEmailHtml({ ...picked, sections: [...picked.sections.filter((s) => s.id !== "safety"), ...picked.sections.filter((s) => s.id === "safety")] }) : html;
    const ownPage = `table[data-sec="safety"]{break-before:page}`;
    w.document.write(lh ? letterheadDocument(lh, subject, forPrint, ownPage)
      : `<!doctype html><html><head><meta charset="utf-8"><title>${subject.replace(/</g, "&lt;")}</title><style>@page{margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}${ownPage}</style></head><body>${forPrint}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };

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
        title="The short update: copy it into an email, or print it — see it first">
        <Mail className="w-3.5 h-3.5" /> Email / Print
      </button>
      {d && picked && (
        <Modal onClose={() => setIsOpen(false)} size="xl">
          <ModalHeader icon={Mail} title="Email or print the update" subtitle="What you'll send or print — leave out any section for today." onClose={() => setIsOpen(false)} />
          <ModalBody className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
              <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Include</span>
              {d.sections.map((s) => (
                <label key={idOf(s)} className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" className="accent-[var(--color-accent)]" checked={!off.has(idOf(s))} onChange={() => toggle(idOf(s))} />
                  <span className="font-semibold text-[var(--color-text)]">{s.title.split(" — ")[0]}</span>
                </label>
              ))}
              {stamps && (
                <label className="inline-flex items-center gap-1.5 cursor-pointer select-none border-l border-[var(--color-border)] pl-3" title="The time each step was done, in Done — the time log has them all">
                  <input type="checkbox" className="accent-[var(--color-accent)]" checked={stamps.on} onChange={() => stamps.set(!stamps.on)} />
                  <span className="font-semibold text-[var(--color-text)]">Times in Done</span>
                </label>
              )}
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
            <button onClick={printIt} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-[var(--color-border-strong)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              <Printer className="w-4 h-4" /> Print
            </button>
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
        // Its progress against the plan; its date range only when there's nothing else to say.
        meta: info ? `${info.leafDone} of ${info.leafTotal} steps · ${info.percent}% done${parentId && planOf?.get(parentId) != null ? `, ${planOf.get(parentId)}% planned` : ""}`
          : Number.isFinite(ps) && Number.isFinite(pf) ? span(ps, pf) : "",
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
    tags: (r.tags ?? []).filter((t): t is TagT => !!t).map((t) => ({ t: t.t, tone: t.tone === "wait" ? "muted" as const : t.tone === "violet" ? "slate" as const : t.tone })),
    who: r.who, wo: r.wo, right: r.right, note: r.note,
  }));
}
const stepsBlock = (rows: TRow[], rightHead: string, whenHead = "When", flat?: boolean): ExportBlock =>
  ({ k: "steps", rows: exportRows(rows), rightHead, whenHead, flat });

const shiftName = (w: ShiftWindow) => (w.kind === "day" ? "Day shift" : "Night shift");

function rowFromShift(r: ShiftRow, c: Ctx, o: { when: string; n?: { num: number; tone: NumTone }; box?: boolean; right: string; done?: boolean; extraTags?: Array<TagT | null>; note?: string; why?: string }): TRow {
  return {
    id: r.leaf.id ?? r.leaf.name,
    group: c.group(r.parentId, r.parentName, r.path.slice(0, -1), r.leaf.name),
    n: o.n, box: o.box, when: o.when, name: r.leaf.name, done: o.done,
    tags: [r.critical ? { t: "critical", tone: "rose" } : null, ...(o.extraTags ?? [])],
    who: r.leaf.responsibleParty ?? undefined, wo: r.leaf.workOrderRef ?? undefined,
    right: o.right, note: o.note, why: o.why,
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

/** The shift's notes for the report: times on Done steps, where whole tasks
 *  stand, why steps are behind, and the shift's own record (crews on site,
 *  incidents, notes & actions) with how to change it. */
interface SheetCtx {
  stamps: boolean;
  timeOf: (id: string) => number | undefined;
  whyOf: (id: string) => string | undefined;
  taskPct: (id: string) => { pct: number; plan?: number } | undefined;
  edit: boolean;
  crewsThis: Record<string, CrewCount>; crewsNext: Record<string, CrewCount>;
  hintThis?: Record<string, CrewCount>; hintNext?: Record<string, CrewCount>;
  setCrew: (which: "this" | "next", crew: string, v: Partial<CrewCount>) => void;
  incidents?: ShiftRecord["incidents"];
  setNone: (none: boolean) => void;
  addIncident: (x: Omit<Incident, "id" | "by">) => void;
  removeIncident: (id: string) => void;
  notes: Array<ShiftNote & { from?: string; shiftKey: string }>;
  addNote: (x: { at: number; text: string; followUp: boolean }) => void;
  clearNote: (n: ShiftNote & { shiftKey: string }) => void;
  removeNote: (n: ShiftNote & { shiftKey: string }) => void;
  error: string | null;
  tz: string;
  /** Shift notes, hour by hour: the record's, how to write and save them. */
  hourly?: HourlyCtx;
  /** The tables' order as dragged; null puts a table back the usual way. */
  order?: TableOrder;
  setOrder: (table: keyof TableOrder, ids: string[] | null) => void;
}

function turnoverSections(report: ShiftReport, c: Ctx, o: { onJump?: () => void; jumpTarget: ShiftWindow | null; noteOf?: (id: string) => { body: string; at?: string | null } | undefined; times: ShiftTimes;
  /** The shift's notes and record (above). */
  sheet?: SheetCtx;
  /** Narrowed to one crew: its name, and the whole job's report (the
   *  standing up top stays the whole job's). */
  crew?: string | null; whole?: ShiftReport;
  /** The meeting's exceptions (lib/shiftHandover): steps the next shift
   *  could try, which crew; and what the last turnover asked of this one. */
  handover?: HandoverCtx;
  /** The project around the work, and the risk cards of the shifts before. */
  safety?: { project: ProjectBase; recent?: HazardKind[][] };
  /** Update a step from its row. */
  onEdit?: (id: string) => void;
  /** Where the work lands the finish (lib/cpm). */
  forecast?: { finish: number; slipH: number };
  /** The critical path's source, when it isn't the links and they'd say
   *  otherwise — with the switch. */
  pathSource?: { label: string; theirs: number; calculated: number; onUse?: () => void; msg?: string | null };
  /** Discovery work on the schedule, and the way to add it. */
  discovery?: Discovery[]; onDiscovery?: () => void;
  /** Change what the next shift does, in the schedule. */
  onPlanNext?: () => void }): Sec[] {
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
  const plan = turnoverPlan(report, (id) => !!ho?.decisions[id]?.tryIt, o.sheet?.order);
  const { items, tried: tryList, pulled: pulledRows } = plan;
  const planList = items.filter((x) => x.kind === "next").map((x) => x.r);
  const planHrs = planList.reduce((a, r) => a + (r.hoursNext ?? 0), 0);
  const priorityOf = new Map<string, number>();
  planList.forEach((r, i) => { if (r.leaf.id) priorityOf.set(r.leaf.id, i + 1); });
  // Same crew as critical work at the same time (lib/turnoverPlan).
  const comp = competition(report, items.map((x) => x.r));
  const pathTags = (r: ShiftRow): Array<TagT | null> => {
    const pn = pathNote(r, c.hrs);
    const cp = r.leaf.id ? comp.get(r.leaf.id) : undefined;
    const nums = cp?.critical.map((x) => priorityOf.get(x.leaf.id ?? "")).filter((n): n is number => n != null) ?? [];
    return [
      discoveryOf(r.leaf) ? { t: ADDED[kindOf(discoveryOf(r.leaf))].lower, tone: "violet" } : null,
      pn ? { t: pn, tone: "amber" } : null,
      cp ? { t: `${cp.crew}: critical ${nums.length ? `#${nums.join(", #")}` : cp.critical[0].leaf.name} goes first`, tone: "amber" } : null,
    ];
  };
  // "After #2": a step waiting on another step on this list names its
  // number; on something off the list, its name.
  const waitTag = (r: ShiftRow): TagT | null => {
    if (r.waitingOn.length === 0) return null;
    const nums = r.waitingOn.map((w) => priorityOf.get(w.id)).filter((n): n is number => n != null);
    return nums.length === r.waitingOn.length
      ? { t: nums.length === 1 ? `starts after #${nums[0]} ${r.waitingOn[0].name}` : `starts after #${nums.join(", #")}`, tone: "wait" }
      : { t: `waits on ${r.waitingOn[0].name}${r.waitingOn.length > 1 ? ` +${r.waitingOn.length - 1}` : ""}`, tone: "wait" };
  };
  // Each step's hours ahead / behind, in words: red only past most of a shift.
  const vsTag = (r: ShiftRow): TagT | null => {
    const sh = shareOf(report, r.leaf.id);
    if (!sh) return null;
    const h = c.hrs(Math.round(sh.hours * 10) / 10);
    return sh.side === "ahead" ? { t: `${h} ahead of plan`, tone: "emerald" } : { t: `${h} behind plan`, tone: sh.hours >= SEVERE_BEHIND_H ? "rose" : "amber" };
  };
  // ── Done: finished, and moved forward but on no list below.
  const doneIds = new Set(plan.done.map((r) => r.leaf.id ?? r.leaf.name));
  // One row per task: its steps done or moved this shift, in one cell.
  const doneTasks = doneByTask(report, plan, c, (id) => noteLine(o.noteOf?.(id), shift.start, c.D), { timeOf: o.sheet?.timeOf, taskPct: o.sheet?.taskPct, whyOf: o.sheet?.whyOf });
  // Why a step is behind, under it — said in the quick view.
  const whyFor = (r: ShiftRow) => (r.leaf.id && shareOf(report, r.leaf.id)?.side === "behind" ? o.sheet?.whyOf(r.leaf.id) : undefined);
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
        why: whyFor(r),
        extraTags: (() => {
          const vs = vsTag(r);
          // "Behind plan" says nothing the hours behind don't; late work is
          // amber (the hours say how bad) — red is for blocked.
          const detail = x.detail && !(vs && /^behind plan/.test(x.detail))
            ? { t: x.detail, tone: (x.tone === "rose" && kind !== "held" ? "amber" : x.tone ?? "muted") as TagTone } : null;
          return [vs, detail, kind === "next" || pulled ? waitTag(r) : null, scope ? { t: `${scope}'s scope — coordinate`, tone: "amber" as const } : null, ...pathTags(r)];
        })(),
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
  const hazardJobs: HazardJobInput[] = hazardJobsOf(planList, next, (r) => (r.carryOver ? `due ${c.DTs(r.dueAt)}` : rowTime(r, next)),
    (id) => noteLine(o.noteOf?.(id), shift.start, c.D));
  const capa = capacityOf(ho?.pullSet ?? null, tryList, shiftHrs);
  // The five-second read of the list.
  const watch = watchLines(planList, report, { hrs: c.hrs }, (id) => (id ? priorityOf.get(id) : undefined));
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
  const sh = o.sheet;
  // Each crew: its supervisor at the meeting and head count on site (the
  // attendance) — and any company added at the meeting with no steps.
  const withExtra = (rows: Array<{ crew: string; note?: string }>, counts?: Record<string, CrewCount>): Array<{ crew: string; note?: string }> => {
    const named = new Set(rows.map((x) => x.crew));
    return [...rows, ...Object.keys(counts ?? {}).filter((k) => !named.has(k)).map((k) => ({ crew: k }))];
  };
  const crewCols = [
    { which: "this" as const, title: `${shiftName(shift)} ${c.D(shift.start)} — who was here`, rows: withExtra(cr.worked, sh?.crewsThis), counts: sh?.crewsThis ?? {}, hint: sh?.hintThis },
    { which: "next" as const, title: `${shiftName(next)} ${c.D(next.start)} — who's coming`, rows: withExtra(cr.coming, sh?.crewsNext), counts: sh?.crewsNext ?? {}, hint: sh?.hintNext },
  ];
  const onSite = (counts: Record<string, CrewCount>) => Object.values(counts).reduce((a, x) => a + (x.headcount ?? 0), 0);
  // Each table's rows drag into the order the meeting wants; the email follows.
  // The dragged order shows the same for everyone and in print (as the
  // email has it); only an editor gets the grips.
  const sortOf = (print: boolean, table: keyof TableOrder) => ({ onReorder: !print && sh?.edit ? (ids: string[]) => sh.setOrder(table, ids) : undefined, runs: !!sh?.order?.[table]?.length });
  const putBack = (print: boolean, table: keyof TableOrder) => (!print && sh?.edit && sh.order?.[table]?.length ? (
    <div className="flex justify-end -mb-1 print:hidden">
      <button type="button" onClick={() => sh.setOrder(table, null)} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline">Put back in the usual order</button>
    </div>
  ) : null);
  const editRow = o.onEdit;
  return [
    {
      id: "stand", title: "Where we stand", short: "Status",
      sub: [overall.plannedFinish ? `Day ${overall.daysElapsed} of ${overall.daysTotal} · planned finish ${c.DT(overall.plannedFinish)}` : null,
        o.forecast ? forecastText(o.forecast, { D: c.D, T: c.T, hrs: c.hrs }) : null,
        overall.planBasis === "baseline" ? `vs baseline${overall.baselineSetAt ? ` of ${c.D(Date.parse(overall.baselineSetAt))}` : ""}` : "vs live dates (no baseline)",
        overall.unscheduled > 0 ? `${overall.unscheduled} step${overall.unscheduled === 1 ? "" : "s"} without dates not counted` : null].filter(Boolean).join(" · "),
      flag: overall.standing === "behind" ? "rose" : null,
      body: (print) => (
        <>
          <StandTiles print={print} actual={overall.actualPct} planned={overall.plannedPct} standing={overall.standing}
            gap={{ label: standStats[2].label, value: standStats[2].value }} done={overall.stepsDone} total={overall.stepsTotal}
            pastDue={pastDueAll} pastDueLabel={standStats[4].label} />
          {!print && o.pathSource && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[var(--color-text-muted)] print:hidden">
              <span>Critical path: <b className="text-[var(--color-text)]">{o.pathSource.label}</b> ({o.pathSource.theirs} step{o.pathSource.theirs === 1 ? "" : "s"}). From the schedule&apos;s links it&apos;s {o.pathSource.calculated}, recalculated as work moves — near-critical and float come with it.</span>
              {o.pathSource.onUse && <button type="button" onClick={o.pathSource.onUse} className="font-bold text-[var(--color-accent)] hover:underline">Use the calculated path</button>}
              {o.pathSource.msg && <span className="font-semibold text-amber-700 dark:text-amber-400">{o.pathSource.msg}</span>}
            </div>
          )}
        </>
      ),
      data: () => [
        { k: "stats", items: standStats },
      ],
    },
    {
      id: "who", title: "Crews", short: "Crews",
      sub: [`${cr.worked.length} on the ${shift.kind} shift · ${cr.coming.length} on the ${next.kind} shift`,
        onSite(crewCols[0].counts) ? `${onSite(crewCols[0].counts)} on site` : null, onSite(crewCols[1].counts) ? `${onSite(crewCols[1].counts)} coming on` : null].filter(Boolean).join(" · "),
      body: (print) => (
        <div className="space-y-1.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 keep">
            {crewCols.map((col) => (
              <div key={col.title} className="rounded-md border border-[var(--color-border)] px-3 py-2">
                <div className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1">{col.title}</div>
                {col.rows.length === 0 ? <div className="text-[12px] italic text-[var(--color-text-muted)]">No work planned</div> : (
                  <ul className="space-y-0.5">
                    {col.rows.map((x) => (
                      <li key={x.crew} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[13px]">
                        <span className="min-w-0"><b className="text-[var(--color-text)] break-words">{x.crew}</b>{x.note && <span className="block text-[11px] text-[var(--color-text-muted)] break-words">{x.note}</span>}</span>
                        <CrewCountEditor key={`${col.which}:${x.crew}`}
                          crew={x.crew} value={col.counts[x.crew]} hint={col.hint?.[x.crew]} edit={!!sh?.edit} print={print} onSave={(v) => sh?.setCrew(col.which, x.crew, v)} />
                      </li>
                    ))}
                  </ul>
                )}
                {!print && sh?.edit && <AddCompany onAdd={(name) => sh.setCrew(col.which, name, {})} />}
              </div>
            ))}
          </div>
          {!print && sh?.error && <div role="alert" className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{sh.error}</div>}
        </div>
      ),
      data: () => [{ k: "columns", cols: crewCols.map((col) => ({ title: col.title, rows: col.rows.length ? col.rows.map((x) => ({ title: x.crew, value: crewLine(col.counts[x.crew]), note: x.note })) : [{ title: "No work planned", value: "" }] })) }],
    },
    {
      id: "safety", title: "Safety & people", short: "Safety",
      sub: "Open every turnover here — then the work.",
      body: (print) => (
        <div className="space-y-2">
          <SafetyMomentBox jobs={hazardJobs} shift={next} T={c.T} print={print} project={o.safety?.project} recent={o.safety?.recent} label={`${shiftName(next)} ${c.D(next.start)}`} />
          {sh ? (
            // The incidents line takes the place of its tick-box.
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 keep">
              <IncidentsLine incidents={sh.incidents} edit={sh.edit} print={print} shift={shift} tz={sh.tz} T={c.T} onNone={sh.setNone} onAdd={sh.addIncident} onRemove={sh.removeIncident} />
              <div className="sm:col-span-2"><Prompts print={print} items={["Permits and lock-outs open across the change", "Manpower and equipment — short, down, arriving"]} /></div>
            </div>
          ) : (
            <Prompts print={print} cols={3} items={[
              "Incidents, near misses, first aid since last turnover",
              "Permits and lock-outs open across the change",
              "Manpower and equipment — short, down, arriving",
            ]} />
          )}
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
          {doneRows.length > 0 && putBack(print, "done")}
          {doneRows.length > 0 ? (
            <DoneTasks rows={doneTasks} print={print} stamps={!!sh?.stamps} T={c.T} sort={sortOf(print, "done")} onEdit={print ? undefined : editRow} />
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
          <WatchBox lines={watch} label={`Watch ${next.kind === "night" ? "tonight" : "today"}`} print={print} />
          {planList.length + tryList.length > 0 && putBack(print, "next")}
          {planList.length + tryList.length === 0 ? <Empty>Nothing is scheduled for the next shift.</Empty> : (
            <StepTable print={print} box whenHead="When" rightHead="Done → goal" rows={nextRows(print, true)} sort={sortOf(print, "next")} onEdit={print ? undefined : editRow} />
          )}
          {tryLine && <div className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-300">{tryLine}</div>}
          {goals.pulledHeld.length > 0 && (
            <div className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-300">
              Blocked since it was added — not on the list: {goals.pulledHeld.map((r) => `${r.leaf.name}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}.
            </div>
          )}
          {!print && addButton}
          {!print && o.onPlanNext && (
            <button type="button" onClick={o.onPlanNext}
              className="ml-2 inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-[12px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-surface-2)] print:hidden">
              <CalendarClock className="w-3.5 h-3.5" /> Plan the {next.kind} shift — swap, pull in, push out
            </button>
          )}
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
      body: (print: boolean) => (
        <div className="space-y-2">
          {putBack(print, "later")}
          <StepTable print={print} whenHead="Why" rightHead="Done" rows={nextRows(print, false)} sort={sortOf(print, "later")} onEdit={print ? undefined : editRow} />
        </div>
      ),
      data: () => [stepsBlock(nextRows(true, false), "Done", "Why")],
    } as Sec] : []),
    ...discoverySection(shift, c, o.discovery ?? [], o.onDiscovery),
    ...(sh?.hourly ? [hourlySection(sh, sh.hourly, shift)] : []),
    closeSection("Close", ["Outgoing supervisor", "Incoming supervisor", "Crew lead"], undefined, sh ? (print) => (
      <ShiftNotesBox notes={sh.notes} edit={sh.edit} print={print} shift={shift} tz={sh.tz} T={c.T} D={c.D} onAdd={sh.addNote} onClear={sh.clearNote} onRemove={sh.removeNote} />
    ) : undefined),
  ];
}

/** Shift notes, hour by hour — written from the entries, approved by a
 *  person before the email or paper carries them. */
function hourlySection(sh: SheetCtx, h: HourlyCtx, shift: ShiftWindow): Sec {
  const lines = approvedLines(h.notes);
  const clocks = hourlyClocks(lines.map((l) => l.at), sh.tz);
  const draft = !h.notes?.approved && (h.notes?.lines.length ?? 0) > 0;
  return {
    id: "hourly", title: "Shift notes — hour by hour", short: "Hour by hour",
    sub: draft ? "Draft — approve it to put it in the email" : "What happened on the shift, by the time it happened",
    count: lines.length || undefined,
    flag: draft ? "amber" : null,
    body: (print) => <ShiftHourlyBox h={h} edit={sh.edit} print={print} shift={shift} tz={sh.tz} />,
    data: () => lines.length
      ? [{ k: "table", head: ["Time", "What happened"], align: ["left", "left"], nowrap: [0], rows: lines.map((l, i) => [clocks[i], l.text] as ExportCell[]) }]
      : [{ k: "note", text: "Not written yet.", tone: "muted" }],
  };
}

/** Discovery work — found on the shift, what it added and did to the
 *  schedule; what's still open from earlier; and the way to add it. */
function discoverySection(shift: ShiftWindow, c: Ctx, list: Discovery[], onAdd?: () => void): Sec[] {
  const ds = discoverySummary(list, shift.start, shift.end);
  if (!ds.inShift.length && !ds.open.length && !onAdd) return [];
  return [{
    id: "discovery", title: addedTitle([...ds.inShift, ...ds.open].map((d) => kindOf(d.record))), short: "Added work",
    sub: discoverySub(ds, c.hrs),
    count: ds.inShift.length,
    flag: ds.shift.critical ? "rose" : null,
    body: (print) => (
      <div className="space-y-2">
        {ds.inShift.length === 0 ? <Empty>Nothing added this shift.</Empty> : <DiscoveryList list={ds.inShift} c={c} print={print} />}
        {ds.open.length > 0 && (
          <div className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-300">
            Still open from earlier: {ds.open.map((d) => `${d.task?.name ?? ""} — ${d.record.what} (${d.steps.filter((x) => x.status !== "completed").length} of ${d.steps.length} steps open)`).join("; ")}.
          </div>
        )}
        {!print && onAdd && (
          <button type="button" onClick={onAdd}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-violet-400 dark:border-violet-700 px-3 py-1.5 text-[12px] font-bold text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/40 print:hidden">
            <Plus className="w-3.5 h-3.5" /> Add discovery or added scope
          </button>
        )}
      </div>
    ),
    data: () => ds.inShift.length ? [discoveryBlock(ds.inShift, c)] : [{ k: "note", text: "Nothing added this shift." } as ExportBlock],
  }];
}

/** Each find: when, where, what, the work it added (and where that stands),
 *  and what it did to the schedule. A table where there's room; on a phone,
 *  a card each. */
function DiscoveryList({ list, c, print }: { list: Discovery[]; c: Ctx; print: boolean }) {
  const cell = print ? "px-1 py-[1px]" : "px-2 py-1.5";
  const impactCls = (d: Discovery) => (d.record.impact.critical ? "text-rose-700 dark:text-rose-400 font-bold" : "text-[var(--color-text)]");
  return (
    <>
      {!print && (
        <div className="sm:hidden rounded-md border border-slate-300 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700/60">
          {list.map((d) => (
            <div key={d.record.id} className="px-3 py-2 text-[12.5px] space-y-0.5">
              <div className="flex items-start justify-between gap-2">
                <b className="break-words">{d.task?.name}{d.task?.workOrderRef && <span className="ml-1.5 font-mono text-[11px] text-[var(--color-text-muted)]">WO {d.task.workOrderRef}</span>}</b>
                <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">{c.DTs(d.record.foundAt)}</span>
              </div>
              <div className="break-words"><b className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)] mr-1">{ADDED[kindOf(d.record)].word}</b>{d.record.what}</div>
              {d.steps.map((m) => <div key={m.id} className="text-[11.5px] text-[var(--color-text-muted)] break-words">{discoveryStepLine(m, c.hrs)}</div>)}
              <div className={`text-[11.5px] ${impactCls(d)}`}>{impactLine(d.record.impact, c.hrs)}</div>
            </div>
          ))}
        </div>
      )}
      <div className={print ? "" : "hidden sm:block"}>
        <table className={`w-full border-collapse ${print ? "text-[8pt]" : "text-[12.5px]"}`}>
          <thead>
            <tr className="border-b border-slate-300 dark:border-slate-600 text-[11px] font-medium text-slate-500 dark:text-slate-400 text-left">
              <th className={`${cell} w-[92px]`}>When</th><th className={`${cell} w-[18%]`}>Task</th><th className={cell}>What</th><th className={`${cell} w-[30%]`}>Work it added</th><th className={`${cell} w-[22%]`}>What it did</th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.record.id} className="border-b border-slate-100 dark:border-slate-800 align-top">
                <td className={`${cell} font-mono text-[11px] whitespace-nowrap`}>{c.DTs(d.record.foundAt)}</td>
                <td className={`${cell} font-semibold break-words`}>{d.task?.name}{d.task?.workOrderRef && <div className="font-mono font-normal text-[11px] text-[var(--color-text-muted)]">WO {d.task.workOrderRef}</div>}</td>
                <td className={`${cell} break-words`}><div className="text-[10.5px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{ADDED[kindOf(d.record)].word}</div>{d.record.what}{d.record.approvedBy && <div className="text-[11px] text-[var(--color-text-muted)]">Approved by {d.record.approvedBy}</div>}</td>
                <td className={`${cell} break-words`}>{d.steps.map((m) => <div key={m.id}>{discoveryStepLine(m, c.hrs)}</div>)}</td>
                <td className={`${cell} break-words ${impactCls(d)}`}>{impactLine(d.record.impact, c.hrs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
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

function closeoutSections(co: ReturnType<typeof buildCloseout>, report: ShiftReport, c: Ctx, cancelled: CancelledJob[], found: Discovery[] = [], lookBack: LookBack | null = null, lessons?: LessonsCtx): Sec[] {
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
    // Discovery over the whole job: what was found, the work it added, and
    // what it did to the finish.
    ...(found.length ? [{
      id: "discovery", title: addedTitle(found.map((d) => kindOf(d.record))), short: "Added work",
      sub: `${found.length} added · ${c.hrs(Math.round(found.reduce((a, d) => a + d.record.impact.hours, 0) * 10) / 10)} of work added · ${found.filter((d) => d.record.impact.critical).length} on the critical path`,
      count: found.length,
      flag: null,
      body: (print: boolean) => <DiscoveryList list={found} c={c} print={print} />,
      data: () => [discoveryBlock(found, c)],
    } as Sec] : []),
    // The look back: where the time went, what set the finish, what went
    // well, where to do better.
    ...(lookBack && lookBack.steps.length ? lookBackSections(lookBack, report, c, lessons) : []),
    closeSection("Sign-off", ["Project / turnaround lead", "Operations", "Safety"]),
  ];
}

interface LessonsCtx {
  items: Lesson[];
  add?: (kind: Lesson["kind"], text: string) => void;
  remove?: (id: string) => void;
  msg?: string | null;
}

/** What a step lost, and why — in words. */
function whyLost(s: StepLook, c: Ctx): string[] {
  const out: string[] = [];
  if (s.lost.hold) {
    const said = s.holds.filter((h) => h.reason);
    out.push(said.length ? said.map((h) => `On hold${h.hours > 0 ? ` ${c.hrs(h.hours)}` : " now"} — “${h.reason}”`).join("; ") : `On hold / blocked ${c.hrs(s.lost.hold)}`);
  }
  if (s.lost.longer) out.push(`Ran ${c.hrs(s.lost.longer)} longer than planned`);
  if (s.lost["late-start"]) out.push(`Started ${c.hrs(s.lost["late-start"])} late — no hold or earlier work recorded`);
  if (s.lost.replanned) out.push(`Re-planned (${c.hrs(s.lost.replanned)})${s.replans[0] ? ` — “${s.replans[0]}”` : ""}`);
  if (s.discovery) out.push(`${ADDED[s.addedKind ?? "discovery"].word} — “${s.discovery}”`);
  for (const w of s.why.slice(-2)) out.push(`Said: “${w}”`);
  return out;
}

function lookBackSections(lb: LookBack, report: ShiftReport, c: Ctx, lessons?: LessonsCtx): Sec[] {
  const signed = (h: number) => `${h > 0 ? "+" : h < 0 ? "−" : ""}${c.hrs(Math.abs(h))}`;
  const f = lb.finish;
  const stats = [
    { label: "Planned finish", value: c.DTs(f.baseline), tone: "slate" as const },
    { label: f.done ? "Finished" : "Forecast finish", value: c.DTs(f.actual), tone: "slate" as const },
    { label: f.slipH > 0 ? "Late by" : "Ahead by", value: c.hrs(Math.abs(f.slipH)), tone: (f.slipH >= 1 ? "rose" : f.slipH <= -1 ? "emerald" : "slate") as "rose" | "emerald" | "slate" },
    { label: "Steps that lost time", value: `${lb.setbacks.length}`, tone: (lb.setbacks.length ? "amber" : "emerald") as "amber" | "emerald" },
    { label: "Ahead of plan", value: `${lb.ahead.length}`, tone: (lb.ahead.length ? "emerald" : "slate") as "emerald" | "slate" },
  ];
  const max = Math.max(1, ...lb.byCause.map((x) => x.hours));
  const basis = `Against the baseline${report.overall.baselineSetAt ? ` (set ${c.D(Date.parse(report.overall.baselineSetAt))})` : ""} · times as entered${f.done ? "" : " · work still open at its forecast"}`;
  const setbacks = lb.setbacks.slice(0, 15);
  // The chain, with runs of steps that only passed the slip on folded.
  type Row = { kind: "step"; i: number } | { kind: "fold"; n: number };
  const chainRows: Row[] = [];
  lb.chain.forEach((l, i) => {
    const quiet = Math.abs(l.addedH) < 1 && i > 0 && i < lb.chain.length - 1;
    const last = chainRows[chainRows.length - 1];
    if (quiet && last?.kind === "fold") last.n++;
    else if (quiet) chainRows.push({ kind: "fold", n: 1 });
    else chainRows.push({ kind: "step", i });
  });
  const first = lb.chain.find((l) => l.addedH >= 1);
  const name = (s: StepLook) => `${s.task ? `${s.task} › ` : ""}${s.name}`;
  const txt = (print: boolean) => (print ? "text-[8.5pt]" : "text-[12.5px]");
  const bullets = (items: string[], tone: "emerald" | "amber", print: boolean) => (
    <ul className={`space-y-1 ${txt(print)}`}>
      {items.map((x) => <li key={x} className="flex gap-2"><span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${tone === "emerald" ? "bg-emerald-500" : "bg-amber-500"}`} /><span className="text-[var(--color-text)]">{x}</span></li>)}
    </ul>
  );
  const teamNotes = (kind: Lesson["kind"], print: boolean) => <LessonNotes kind={kind} ctx={lessons} print={print} c={c} />;
  const noteData = (kind: Lesson["kind"]): ExportBlock[] => {
    const xs = (lessons?.items ?? []).filter((l) => l.kind === kind);
    return xs.length ? [{ k: "label", text: "From the team" }, { k: "list", items: xs.map((l) => ({ text: l.text, ...(l.by ? { note: l.by } : {}) })) }] : [];
  };
  return [
    {
      id: "lookback", title: "Look back — where the time went", short: "Look back",
      sub: basis,
      flag: f.slipH >= 1 ? "amber" : null,
      body: (print) => (
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 keep">
            {stats.map((x) => <Stat key={x.label} label={x.label} value={x.value} tone={x.tone} />)}
          </div>
          {lb.byCause.length > 0 && (
            <div className={`keep rounded-md border border-[var(--color-border)] px-2.5 py-2 space-y-1 ${txt(print)}`}>
              <div className="text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Hours lost, by cause</div>
              {lb.byCause.map((x) => (
                <div key={x.cause} className="grid grid-cols-[minmax(0,15rem)_1fr_auto] items-center gap-2 max-sm:grid-cols-[1fr_auto]">
                  <span className="text-[var(--color-text)] break-words max-sm:col-span-2">{CAUSE_LABEL[x.cause]}</span>
                  <span className="h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden"><span className="block h-full rounded-full bg-amber-500" style={{ width: `${Math.round((x.hours / max) * 100)}%` }} /></span>
                  <span className="tabular-nums text-[var(--color-text-muted)]"><b className="text-[var(--color-text)]">{c.hrs(x.hours)}</b> · {x.steps} step{x.steps === 1 ? "" : "s"}</span>
                </div>
              ))}
              <div className="text-[11px] text-[var(--color-text-faint)]">Hours each step lost on its own, added up — work runs side by side, so this is more than the finish moved. What moved the finish is under The chain of events.</div>
            </div>
          )}
        </div>
      ),
      data: () => [{ k: "stats", items: stats }, ...(lb.byCause.length ? [{ k: "table", head: ["Cause", "Hours lost", "Steps"], align: ["left", "right", "right"], rows: lb.byCause.map((x) => [CAUSE_LABEL[x.cause], c.hrs(x.hours), `${x.steps}`]) } as ExportBlock] : [])],
    },
    {
      id: "setbacks", title: "What set us back", short: "Set back", count: lb.setbacks.length, flag: lb.setbacks.length ? "amber" : null,
      sub: "Steps that lost the most time on their own — time handed on from the work before isn't counted again",
      body: (print) => setbacks.length === 0 ? <Empty>No step lost an hour or more on its own.</Empty> : (
        <div className={`rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)] ${txt(print)}`}>
          {setbacks.map((s) => (
            <div key={s.id} className={`keep ${print ? "px-1.5 py-1" : "px-2.5 py-1.5"} grid grid-cols-[1fr_auto] gap-x-3`}>
              <div className="min-w-0">
                <b className="text-[var(--color-text)] break-words">{s.name}</b>
                <span className="text-[var(--color-text-muted)]"> · {[s.task, s.wo ? `WO ${s.wo}` : null, s.crew].filter(Boolean).join(" · ")}{s.done ? "" : " · forecast"}</span>
                <div className="text-[var(--color-text-muted)] break-words">{whyLost(s, c).join(" · ")}</div>
              </div>
              <div className="text-right tabular-nums font-bold text-rose-700 dark:text-rose-400 whitespace-nowrap">{signed(s.lostH)}</div>
            </div>
          ))}
          {lb.setbacks.length > setbacks.length && <div className="px-2.5 py-1 text-[var(--color-text-muted)]">+ {lb.setbacks.length - setbacks.length} more, each losing less</div>}
        </div>
      ),
      data: () => [setbacks.length === 0 ? { k: "empty", text: "No step lost an hour or more on its own." } : {
        k: "table", head: ["Step", "WO", "Who", "Lost", "Why"], align: ["left", "left", "left", "right", "left"], nowrap: [3],
        rows: setbacks.map((s) => [{ t: s.name, note: s.task || undefined }, s.wo, s.crew, { t: signed(s.lostH), tone: "rose", bold: true }, whyLost(s, c).join(" · ")]),
      }],
    },
    {
      id: "chain", title: "The chain of events", short: "Chain",
      sub: lb.chain.length ? `The work that set the finish, first to last — ${first ? `the slip starts at ${name(first.step)}` : "no step on it lost time"}` : undefined,
      body: (print) => lb.chain.length === 0 ? <Empty>The schedule&apos;s links don&apos;t show a chain into the finish.</Empty> : (
        <ol className={`relative space-y-0 ${txt(print)}`}>
          {chainRows.map((r, k) => r.kind === "fold" ? (
            <li key={`f${k}`} className="pl-5 py-0.5 text-[var(--color-text-faint)] border-l-2 border-dashed border-[var(--color-border-strong)] ml-1.5">
              … {r.n} step{r.n === 1 ? "" : "s"} passed it on, adding nothing
            </li>
          ) : (() => {
            const l = lb.chain[r.i], s = l.step;
            const tone = l.addedH >= 1 ? "text-rose-700 dark:text-rose-400" : l.addedH <= -1 ? "text-emerald-700 dark:text-emerald-400" : "text-[var(--color-text-muted)]";
            return (
              <li key={s.id} className="keep pl-5 py-1 border-l-2 border-[var(--color-border-strong)] ml-1.5 relative">
                <span className={`absolute -left-[5px] top-[9px] h-2 w-2 rounded-full ${l.addedH >= 1 ? "bg-rose-500" : l.addedH <= -1 ? "bg-emerald-500" : "bg-slate-400"}`} />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <b className="text-[var(--color-text)] break-words">{name(s)}</b>
                  <span className={`font-bold tabular-nums ${tone}`}>{l.addedH >= 1 ? `added ${signed(l.addedH)}` : l.addedH <= -1 ? `made up ${c.hrs(-l.addedH)}` : "passed it on"}</span>
                  <span className="text-[var(--color-text-muted)] tabular-nums">· finish {signed(l.slipH)} after it</span>
                </div>
                <div className="text-[var(--color-text-muted)]">
                  planned {c.DTs(s.bs)}–{c.DTs(s.bf)} · {s.done ? "did" : "forecast"} {c.DTs(s.as)}–{c.DTs(s.af)}{l.addedH >= 1 && whyLost(s, c).length ? ` · ${whyLost(s, c).join(" · ")}` : ""}
                </div>
              </li>
            );
          })())}
        </ol>
      ),
      data: () => [lb.chain.length === 0 ? { k: "empty", text: "The schedule's links don't show a chain into the finish." } : {
        k: "table", head: ["Step", "Planned finish", f.done ? "Finished" : "Finish (forecast)", "Added", "Why"], align: ["left", "left", "left", "right", "left"], nowrap: [1, 2, 3],
        rows: lb.chain.filter((l, i) => Math.abs(l.addedH) >= 1 || i === 0 || i === lb.chain.length - 1).map((l) => [{ t: l.step.name, note: l.step.task || undefined }, c.DTs(l.step.bf), c.DTs(l.step.af),
          { t: l.addedH >= 1 ? signed(l.addedH) : l.addedH <= -1 ? `made up ${c.hrs(-l.addedH)}` : "—", tone: l.addedH >= 1 ? "rose" : l.addedH <= -1 ? "emerald" : "muted", bold: true }, l.addedH >= 1 ? whyLost(l.step, c).join(" · ") : ""]),
      }],
    },
    {
      id: "well", title: "What went well", short: "Went well", count: lb.ahead.length || undefined, flag: null,
      sub: "To keep doing next time",
      body: (print) => (
        <div className="space-y-2">
          {lb.keep.length > 0 && bullets(lb.keep, "emerald", print)}
          {lb.ahead.length > 0 && (
            <div className={`keep rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)] ${txt(print)}`}>
              <div className="px-2.5 py-1 text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Finished ahead of plan</div>
              {lb.ahead.slice(0, 8).map((s) => (
                <div key={s.id} className="px-2.5 py-1 grid grid-cols-[1fr_auto] gap-x-3">
                  <span className="min-w-0 break-words"><b className="text-[var(--color-text)]">{s.name}</b><span className="text-[var(--color-text-muted)]"> · {[s.task, s.crew].filter(Boolean).join(" · ")}</span></span>
                  <span className="tabular-nums font-bold text-emerald-700 dark:text-emerald-400 whitespace-nowrap">{c.hrs(-s.finishH)} early</span>
                </div>
              ))}
            </div>
          )}
          {lb.absorbed.length > 0 && <div className={`text-[var(--color-text)] ${txt(print)}`}>Discovery that fit in the float: {lb.absorbed.map((d) => `“${d.record.what}” (${c.hrs(d.record.impact.hours)})`).join("; ")}.</div>}
          {lb.crews.length > 0 && (
            <div className={`keep rounded-md border border-[var(--color-border)] ${txt(print)}`}>
              <div className="px-2.5 py-1 text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Crews — steps done on plan</div>
              {lb.crews.map((x) => (
                <div key={x.crew} className="px-2.5 py-0.5 grid grid-cols-[1fr_auto_auto] gap-x-3 tabular-nums">
                  <span className="text-[var(--color-text)] truncate">{x.crew}</span>
                  <span className="text-[var(--color-text-muted)]">{x.onPlan} of {x.done} on plan</span>
                  <span className={`font-bold ${x.done && x.onPlan === x.done ? "text-emerald-700 dark:text-emerald-400" : "text-[var(--color-text-muted)]"}`}>{Math.round((x.onPlan / x.done) * 100)}%</span>
                </div>
              ))}
            </div>
          )}
          {teamNotes("keep", print)}
        </div>
      ),
      data: () => [
        ...(lb.keep.length ? [{ k: "list", items: lb.keep.map((t) => ({ text: t })) } as ExportBlock] : []),
        ...(lb.ahead.length ? [{ k: "table", head: ["Finished ahead of plan", "Crew", "Early"], align: ["left", "left", "right"], rows: lb.ahead.slice(0, 8).map((s) => [{ t: s.name, note: s.task || undefined }, s.crew, { t: c.hrs(-s.finishH), tone: "emerald", bold: true }]) } as ExportBlock] : []),
        ...(lb.crews.length ? [{ k: "table", head: ["Crew", "On plan", ""], align: ["left", "right", "right"], rows: lb.crews.map((x) => [x.crew, `${x.onPlan} of ${x.done}`, `${Math.round((x.onPlan / x.done) * 100)}%`]) } as ExportBlock] : []),
        ...noteData("keep"),
      ],
    },
    {
      id: "improve", title: "Where we can improve", short: "Improve", count: lb.improve.length || undefined, flag: lb.improve.length ? "amber" : null,
      sub: "What the record says to change next time",
      body: (print) => (
        <div className="space-y-2">
          {lb.improve.length ? bullets(lb.improve, "amber", print) : <Empty>Nothing in the record stands out.</Empty>}
          {teamNotes("improve", print)}
        </div>
      ),
      data: () => [...(lb.improve.length ? [{ k: "list", items: lb.improve.map((t) => ({ text: t })) } as ExportBlock] : [{ k: "empty", text: "Nothing in the record stands out." } as ExportBlock]), ...noteData("improve")],
    },
  ];
}

/** The team's own lessons — kept with the close-out, on the screen, the
 *  print and the email. */
function LessonNotes({ kind, ctx, print, c }: { kind: Lesson["kind"]; ctx?: LessonsCtx; print: boolean; c: Ctx }) {
  const [text, setText] = useState("");
  const items = (ctx?.items ?? []).filter((l) => l.kind === kind);
  if (print && !items.length) return null;
  return (
    <div className={`keep rounded-md border border-[var(--color-border)] px-2.5 py-1.5 space-y-1 ${print ? "text-[8.5pt]" : "text-[12.5px]"}`}>
      <div className="text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">{kind === "keep" ? "Keep doing — from the team" : "Do better — from the team"}</div>
      {items.map((l) => (
        <div key={l.id} className="flex items-start gap-2">
          <span className="flex-1 min-w-0 break-words text-[var(--color-text)]">{l.text}<span className="text-[11px] text-[var(--color-text-faint)]">{l.by ? ` — ${l.by}` : ""} · {c.D(l.at)}</span></span>
          {!print && ctx?.remove && <button type="button" onClick={() => ctx.remove!(l.id)} aria-label="Remove" className="text-[var(--color-text-faint)] hover:text-rose-600 print:hidden"><X className="w-3.5 h-3.5" /></button>}
        </div>
      ))}
      {!print && ctx?.add && (
        <form className="flex items-center gap-1.5 print:hidden" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { ctx.add!(kind, text.trim()); setText(""); } }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === "keep" ? "e.g. Staging bundles the night before saved hours" : "e.g. Get hot-work permits signed before the shift starts"}
            aria-label={kind === "keep" ? "Something to keep doing" : "Something to do better"}
            className="flex-1 min-w-0 h-8 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]" />
          <button type="submit" disabled={!text.trim()} className="h-8 px-3 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12px] font-bold disabled:opacity-50">Add</button>
        </form>
      )}
      {!print && ctx?.msg && <div className="text-[11.5px] text-rose-700 dark:text-rose-300">{ctx.msg}</div>}
      {!print && !items.length && !ctx?.add && <div className="text-[var(--color-text-faint)]">None written yet.</div>}
    </div>
  );
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

function closeSection(title: string, signers: string[], sub = "Notes, actions and sign-off", notes?: (print: boolean) => React.ReactNode): Sec {
  return {
    id: "close", title, short: title, sub,
    body: (print) => (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 keep">
        <div className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5">
          <div className="text-[12px] font-semibold text-slate-600 dark:text-slate-300">Notes &amp; actions</div>
          {notes ? notes(print) : Array.from({ length: print ? 4 : 3 }).map((_, i) => <div key={i} className="h-5 border-b border-dotted border-[var(--color-border-strong)]" />)}
        </div>
        <div className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 space-y-2">
          <div className="text-[12px] font-semibold text-slate-600 dark:text-slate-300">Sign-off</div>
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
      ? { label: closeout.done >= closeout.steps ? "Complete" : `${closeout.steps - closeout.done} open`, cls: closeout.done >= closeout.steps ? "emerald" : "amber", Icon: CheckCircle2 }
      : standing === "ahead" ? { label: "Ahead", cls: "emerald", Icon: TrendingUp }
        : standing === "behind" ? { label: "Behind", cls: "rose", Icon: TrendingDown } : { label: "On track", cls: "slate", Icon: Minus };
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
            <span className={`text-[11px] font-semibold ${print ? "text-slate-500" : "text-slate-400"}`}>{title}</span>
            <h2 className={`${print ? "text-[14pt]" : "text-[18px]"} font-bold tracking-tight leading-tight truncate`}>{projectName ?? "Schedule"}</h2>
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
            <div className="inline-flex items-center gap-1 text-[13px] font-bold leading-none"><pill.Icon className="w-3.5 h-3.5" /> {pill.label}</div>
            {meeting === "turnover" && <div className="text-[10.5px] font-medium opacity-90">{overall.actualPct}% done vs {overall.plannedPct}% planned</div>}
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
        Critical = on the chain that drives the finish date. Hours are planned work-hours. Behind {SEVERE_BEHIND_H} h or more shows red; less, amber.
      </span>
      <span className="shrink-0">Printed {c.DT(now)}{projectName ? ` · ${projectName}` : ""}</span>
    </footer>
  );
}

// ─── Building blocks ─────────────────────────────────────────────────

function SectionHead({ n, s, collapsed, big, print }: { n: number; s: Sec; collapsed?: boolean; big?: boolean; print?: boolean }) {
  return (
    <div className={`flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 ${print ? "pb-[2px] border-b-[1.5px] border-slate-900" : "pb-1.5 border-b-2 border-slate-900 dark:border-slate-500"}`}>
      <span className={`${big ? "w-7 h-7 text-[13px]" : print ? "w-4 h-4 text-[7.5pt]" : "w-5 h-5 text-[11px]"} self-center rounded-full bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900 font-bold flex items-center justify-center shrink-0`}>{n}</span>
      <span className={`${big ? "text-[20px]" : print ? "text-[11pt]" : "text-[16px]"} min-w-0 font-bold tracking-tight`}>{s.title}</span>
      {s.sub && <span className={`min-w-0 ${big ? "text-[13px]" : print ? "text-[8pt]" : "text-[12px]"} text-[var(--color-text-muted)]`}>{s.sub}</span>}
      {!print && !big && <ChevronDown className={`ml-auto self-center w-4 h-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${collapsed ? "-rotate-90" : ""}`} />}
    </div>
  );
}

/** Where the job stands, four tiles: progress against the plan (with the
 *  plan marked), work behind or ahead, steps done, past due. Colour only
 *  on a number that's off. */
function StandTiles({ actual, planned, standing, gap, done, total, pastDue, pastDueLabel, print }: {
  actual: number; planned: number; standing: "ahead" | "behind" | "on track"; gap: { label: string; value: string };
  done: number; total: number; pastDue: number; pastDueLabel: string; print: boolean;
}) {
  const tile = `rounded-lg border border-slate-200 dark:border-slate-700 ${print ? "px-2 py-1" : "px-3 py-2"}`;
  const label = `font-medium text-slate-500 dark:text-slate-400 ${print ? "text-[7.5pt]" : "text-[11px]"}`;
  const value = `font-bold tracking-tight tabular-nums leading-tight ${print ? "text-[14pt]" : "text-[22px]"}`;
  const small = `font-medium text-slate-600 dark:text-slate-300 ${print ? "text-[8pt]" : "text-[13px]"}`;
  const sub = `text-slate-500 dark:text-slate-400 ${print ? "text-[7pt]" : "text-[11px]"}`;
  const gapTone = standing === "behind" ? "text-rose-700 dark:text-rose-400" : standing === "ahead" ? "text-emerald-700 dark:text-emerald-400" : "";
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-4 ${print ? "gap-1.5" : "gap-2"} keep`}>
      <div className={tile}>
        <div className={label}>Progress</div>
        <div className={value}>{actual}% <span className={small}>of {planned}% planned</span></div>
        <div className="relative mt-1.5 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700" aria-hidden>
          <div className="absolute inset-y-0 left-0 rounded-full bg-slate-900 dark:bg-slate-200" style={{ width: `${Math.min(100, actual)}%` }} />
          <div className={`absolute -top-[3px] w-0.5 h-3 ${standing === "behind" ? "bg-rose-700" : "bg-slate-500"}`} style={{ left: `calc(${Math.min(100, planned)}% - 1px)` }} />
        </div>
      </div>
      <div className={tile}>
        <div className={label}>{gap.label}</div>
        <div className={`${value} ${gapTone}`}>{gap.value}</div>
        <div className={sub}>{standing === "behind" ? "planned work-hours not done" : standing === "ahead" ? "work-hours done early" : "planned work-hours, either way"}</div>
      </div>
      <div className={tile}>
        <div className={label}>Steps done</div>
        <div className={value}>{done} <span className={small}>of {total}</span></div>
        <div className={sub}>all crews, whole job</div>
      </div>
      <div className={tile}>
        <div className={label}>{pastDueLabel}</div>
        <div className={`${value} ${pastDue ? "text-amber-700 dark:text-amber-400" : ""}`}>{pastDue}</div>
        <div className={sub}>steps past their finish</div>
      </div>
    </div>
  );
}

/** The next shift's list in a few lines — what to watch. */
function WatchBox({ lines, label, print }: { lines: ReturnType<typeof watchLines>; label: string; print: boolean }) {
  if (!lines.length) return null;
  const dot = { rose: "bg-rose-700", amber: "bg-amber-600", slate: "bg-slate-500" };
  return (
    <div className={`keep rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 ${print ? "px-2 py-1" : "px-3.5 py-2.5"}`}>
      <div className={`font-semibold text-slate-900 dark:text-slate-100 ${print ? "text-[8.5pt]" : "text-[12.5px]"}`}>{label}</div>
      <ul className={`mt-0.5 space-y-0.5 text-slate-800 dark:text-slate-200 ${print ? "text-[8pt]" : "text-[12.5px]"}`}>
        {lines.map((l) => (
          <li key={l.strong} className="flex items-baseline gap-2 leading-snug">
            <span className={`shrink-0 w-[7px] h-[7px] rounded-full -translate-y-px ${dot[l.tone]}`} aria-hidden />
            <span><b className="font-semibold">{l.strong}</b>{l.rest}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A number in a plain tile — coloured only when it's off. */
function Stat({ label, value, tone }: { label: string; value: string; tone: "emerald" | "rose" | "amber" | "slate" }) {
  const t = tone === "emerald" ? "text-emerald-700 dark:text-emerald-400" : tone === "rose" ? "text-rose-700 dark:text-rose-400" : tone === "amber" ? "text-amber-700 dark:text-amber-400" : "text-[var(--color-text)]";
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5">
      <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-[20px] font-bold leading-tight tabular-nums ${t}`}>{value}</div>
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


type TagTone = "rose" | "amber" | "emerald" | "muted" | "wait" | "violet";
interface TagT { t: string; tone: TagTone }
function TagChip({ t, tone }: TagT) {
  const cls = tone === "rose" ? "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900"
    : tone === "amber" ? "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900"
      : tone === "emerald" ? "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900"
        : tone === "violet" ? "bg-violet-100 text-violet-800 border-violet-300 dark:bg-violet-950/40 dark:text-violet-200 dark:border-violet-900"
        : "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700";
  return <span className={`inline-block max-w-full whitespace-nowrap px-1 py-px rounded border text-[10px] font-bold align-middle ${cls}`}>{t}</span>;
}

/** The one filled colour on the page: work on the chain that drives the finish. */
function CriticalTag({ print }: { print?: boolean }) {
  return <span className={`ml-2 inline-block rounded px-1.5 py-px font-bold leading-snug bg-rose-700 text-white align-[1px] ${print ? "text-[7pt]" : "text-[10.5px]"}`}>Critical</span>;
}

/** What's going on with a step, as one quiet line: how far behind (red only
 *  past most of a shift), late, what it waits on — the first word capitalised. */
const TONE_TEXT: Record<TagTone, string> = {
  rose: "text-rose-700 dark:text-rose-400 font-semibold",
  amber: "text-amber-700 dark:text-amber-400 font-medium",
  emerald: "text-emerald-700 dark:text-emerald-400 font-medium",
  muted: "text-slate-600 dark:text-slate-300",
  wait: "text-slate-600 dark:text-slate-300",
  violet: "text-violet-700 dark:text-violet-300 font-semibold",
};
function StatusLine({ tags, print }: { tags: TagT[]; print?: boolean }) {
  if (!tags.length) return null;
  return (
    <div className={`mt-0.5 leading-snug ${print ? "text-[7.5pt]" : "text-[12px]"}`}>
      {tags.map((t, i) => (
        <span key={`${t.t}${i}`} className={TONE_TEXT[t.tone]}>
          {i > 0 && <span className="mx-1.5 font-normal text-slate-400" aria-hidden>·</span>}
          {t.tone === "wait" && <Hourglass className="inline w-3 h-3 -mt-0.5 mr-0.5" aria-hidden />}
          {i === 0 ? t.t.charAt(0).toUpperCase() + t.t.slice(1) : t.t}
        </span>
      ))}
    </div>
  );
}

type NumTone = "rose" | "amber" | "slate";
/** The order on the list: a plain number — colour is for problems. */
function Num({ n }: { n: number; tone?: NumTone }) {
  return <span className="inline-block min-w-[14px] text-right font-mono text-[12px] text-slate-500 dark:text-slate-400 tabular-nums">{n}</span>;
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
  /** Why it's behind plan, as said for the report. */
  why?: string;
  /** On screen only: a control under the step (the meeting's decision). */
  control?: React.ReactNode;
  /** A small action beside the step's name (never printed). */
  inline?: React.ReactNode;
}

/** "E-17 - Transmix Feed…" → the tag in bold, then the name. */
function GroupTitle({ title }: { title: string }) {
  const m = /^([A-Z0-9][A-Z0-9./-]{0,14})\s+[-–—]\s+(.+)$/i.exec(title.trim());
  return m && /\d/.test(m[1])
    ? <><b className="font-bold text-slate-900 dark:text-slate-100">{m[1]}</b> · {m[2]}</>
    : <b className="font-bold text-slate-900 dark:text-slate-100">{title}</b>;
}

/** "25% · goal 100%": where it is, a thin bar, and the shift's goal marked. */
function Progress({ right, print }: { right: string; print?: boolean }) {
  const m = /^(\d+)%(?: · goal (\d+)%)?$/.exec(right.trim());
  if (!m) return <span className={`font-mono font-semibold text-slate-700 dark:text-slate-200 ${print ? "text-[8pt]" : "text-[12px]"}`}>{right}</span>;
  const pct = Math.min(100, +m[1]), goal = m[2] != null ? Math.min(100, +m[2]) : null;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className={`font-mono font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap ${print ? "text-[8pt]" : "text-[12px]"}`}>
        {pct}%{goal != null && <span className="font-normal text-slate-500 dark:text-slate-400"> → {goal}%</span>}
      </span>
      <span className={`relative block h-1 rounded-full bg-slate-200 dark:bg-slate-700 ${print ? "w-16" : "w-20"}`} aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-full bg-slate-900 dark:bg-slate-200" style={{ width: `${pct}%` }} />
        {goal != null && <span className="absolute -top-[3px] w-0.5 h-2.5 bg-slate-500" style={{ left: `calc(${goal}% - 1px)` }} />}
      </span>
    </span>
  );
}

/** One line per step, grouped under its equipment: the task to read first,
 *  then what's going on with it (quiet unless it matters), when, who, WO,
 *  how far along. The same reading order in every list. */
function StepTable({ rows, print, box, rightHead = "", whenHead = "When", ownerLine, flat, sort, onEdit }: {
  rows: TRow[]; print: boolean; box?: boolean; rightHead?: string; whenHead?: string;
  /** Rows dragged into order at the meeting; `runs` once an order is set —
   *  the rows keep it, and a task is named again where it comes back. */
  sort?: { onReorder?: (ids: string[]) => void; runs: boolean };
  /** Update a step right from its row (status, %, time, comment). */
  onEdit?: (id: string) => void;
  /** One list in the given order, the equipment named on each line (a
   *  sequence — the critical chain — reads in order, not by equipment). */
  flat?: boolean;
  /** Adds a blank "owner / decision" line under each row (decisions). */
  ownerLine?: boolean;
}) {
  // Group consecutive-by-first-appearance, keeping each group's rows in
  // order — or, in a dragged order, by runs.
  const groups: Array<{ g: TGroup; rows: TRow[]; key: string }> = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const base = r.group.title && !flat ? r.group.key : "__solo";
    const last = groups[groups.length - 1];
    const k = sort?.runs ? (last && last.g.key === base ? last.key : `${base}#${groups.length}`) : base;
    if (!at.has(k)) { at.set(k, groups.length); groups.push({ g: r.group.title && !flat ? r.group : { key: "__solo", title: "", crumbs: "", meta: "" }, rows: [], key: k }); }
    groups[at.get(k)!].rows.push(r);
  }
  const { box: sortBox, grip, indicator: sortLine, moving } = useSortRows(print ? undefined : sort?.onReorder);
  const edit = (r: TRow) => (!print && onEdit ? <EditBtn label={r.name} onClick={() => onEdit(r.id)} /> : null);
  const crew = React.useContext(ReportCrew);
  const open = useQuickLookOpen();
  const hasN = rows.some((r) => r.n);
  // Narrowed to one crew, every row's Who is that crew.
  const hasWho = !crew && rows.some((r) => r.who);
  const hasWo = rows.some((r) => r.wo);
  // A When column that says the same thing on every line ("Day crew") says it once, in the heading.
  const hasWhen = new Set(rows.map((r) => r.when)).size > 1;
  const cols = (box ? 1 : 0) + (hasN ? 1 : 0) + 2 + (hasWhen ? 1 : 0) + (hasWho ? 1 : 0) + (hasWo ? 1 : 0);
  const critical = (r: TRow) => (r.tags ?? []).some((t) => t?.t === "critical");
  const statusOf = (r: TRow) => (r.tags ?? []).filter((t): t is TagT => !!t && t.t !== "critical");
  const nameOf = (r: TRow, cls: string) => open && !print ? (
    <button type="button" onClick={() => open(r.id)} title="When it's due, the goal for the shift, what comes next"
      className={`text-left hover:underline decoration-dotted underline-offset-2 ${r.done ? "line-through text-slate-400" : cls}`}>{r.name}</button>
  ) : <span className={r.done ? "line-through text-slate-400" : cls}>{r.name}</span>;
  const cell = print ? "px-1 py-[3px]" : "px-2 py-2";
  const taskCls = `font-semibold text-slate-900 dark:text-slate-50 ${print ? "text-[9pt]" : "text-[13.5px]"}`;
  return (
    <div ref={sortBox} className="relative">
    {sortLine}
    {/* On a phone: a full-width line per step — the task, what's going on
        with it, who · when · WO, and how far along. */}
    {!print && (
      <div className="sm:hidden">
        {groups.map(({ g, rows: list, key }) => (
          <div key={key} className="mt-3 first:mt-0">
            {g.title && (
              <div className="group/sort pb-1 border-b border-slate-300 dark:border-slate-600 text-[12px] font-semibold text-slate-700 dark:text-slate-300">
                <Grip props={grip(list.map((x) => x.id), g.title)} />
                <GroupTitle title={g.title} />
                {g.meta && <div className="text-[11px] font-normal text-slate-500 dark:text-slate-400">{g.meta}</div>}
              </div>
            )}
            {list.map((r) => (
              <div key={r.id} data-sort-id={r.id} className={`group/sort py-2.5 border-b border-slate-100 dark:border-slate-800 ${moving(r.id) ? "opacity-40" : ""}`}>
                <div className="flex items-start gap-2">
                  <Grip props={grip([r.id], r.name)} className="mt-0.5 ml-0" />
                  {box && <span className="pt-1"><Box /></span>}
                  {r.n && <span className="pt-0.5"><Num n={r.n.num} /></span>}
                  <div className="flex-1 min-w-0">
                    <div className="text-[14.5px] leading-snug">
                      {flat && r.group.title && <span className="text-slate-500 dark:text-slate-400">{r.group.title} › </span>}
                      {nameOf(r, "font-semibold text-slate-900 dark:text-slate-50")}{critical(r) && <CriticalTag />}{edit(r)}
                    </div>
                    <StatusLine tags={statusOf(r)} />
                    <div className="mt-1 text-[12px] text-slate-600 dark:text-slate-300">
                      {[!crew && r.who ? r.who : null, r.when, r.wo ? `WO ${r.wo}` : null].filter(Boolean).join(" · ")}
                    </div>
                    {r.note && <div className="text-[11.5px] italic text-slate-600 dark:text-slate-300 mt-0.5">{r.note}</div>}
                    {r.why && <div className="text-[11.5px] italic font-medium text-amber-800 dark:text-amber-300 mt-0.5">Why behind: {r.why}</div>}
                    {r.inline && <div className="mt-1.5">{r.inline}</div>}
                  </div>
                  <div className="shrink-0 pt-0.5"><Progress right={r.right} /></div>
                </div>
                {r.control && <div className="mt-1.5">{r.control}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    )}
    <div className={print ? "" : "hidden sm:block overflow-x-auto"}>
      <table className={`w-full border-collapse table-fixed ${print ? "text-[8pt]" : "text-[12px]"}`}>
        <thead>
          <tr className={`text-left font-medium text-slate-500 dark:text-slate-400 border-b border-slate-300 dark:border-slate-600 ${print ? "text-[7.5pt]" : "text-[11px]"}`}>
            {box && <th className={`${cell} w-6 font-medium`} />}
            {hasN && <th className={`${cell} w-7 font-medium text-right`}>#</th>}
            <th className={`${cell} font-medium`}>Task</th>
            {hasWhen && <th className={`${cell} font-medium ${print ? "w-[86px]" : "w-[112px]"}`}>{whenHead}</th>}
            {hasWho && <th className={`${cell} font-medium ${print ? "w-[96px]" : "w-[124px]"}`}>Who</th>}
            {hasWo && <th className={`${cell} font-medium ${print ? "w-[52px]" : "w-[70px]"}`}>WO</th>}
            <th className={`${cell} font-medium text-right ${print ? "w-[84px]" : "w-[118px]"}`}>{rightHead}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ g, rows: list, key }) => (
            <React.Fragment key={key}>
              {g.title && (
                <tr className="group/sort border-b border-slate-300 dark:border-slate-600">
                  <td colSpan={cols} className={`${print ? "px-1 pt-[7px] pb-[2px] text-[8pt]" : "px-2 pt-3.5 pb-1 text-[12px]"} font-semibold text-slate-700 dark:text-slate-300`}>
                    <Grip props={grip(list.map((x) => x.id), g.title)} />
                    <GroupTitle title={g.title} />
                    {g.meta && <span className={`float-right font-normal text-slate-500 dark:text-slate-400 ${print ? "text-[7.5pt]" : "text-[11px]"}`}>{g.meta}</span>}
                  </td>
                </tr>
              )}
              {list.map((r) => (
                <React.Fragment key={r.id}>
                  <tr data-sort-id={r.id} className={`group/sort border-b border-slate-100 dark:border-slate-800 align-top ${moving(r.id) ? "opacity-40" : ""}`}>
                    {box && <td className={cell}><Box /></td>}
                    {hasN && <td className={`${cell} text-right`}>{r.n ? <Num n={r.n.num} /> : null}</td>}
                    <td className={cell}>
                      <div className="leading-snug">
                        {flat && r.group.title && <span className="text-slate-500 dark:text-slate-400">{r.group.title} › </span>}
                        <Grip props={grip([r.id], r.name)} />
                        {nameOf(r, taskCls)}{critical(r) && <CriticalTag print={print} />}{edit(r)}
                        {!print && r.inline && <span className="ml-2 align-middle">{r.inline}</span>}
                      </div>
                      <StatusLine tags={statusOf(r)} print={print} />
                      {r.note && <div className={`italic text-slate-600 dark:text-slate-300 mt-0.5 ${print ? "text-[7.5pt]" : "text-[11.5px]"}`}>{r.note}</div>}
                      {r.why && <div className={`italic font-medium text-amber-800 dark:text-amber-300 mt-0.5 ${print ? "text-[7.5pt]" : "text-[11.5px]"}`}>Why behind: {r.why}</div>}
                      {ownerLine && <div className="text-[10px] text-slate-500 mt-0.5">Owner / decision: <span className="inline-block w-44 border-b border-dotted border-slate-400 align-baseline">&nbsp;</span></div>}
                    </td>
                    {hasWhen && <td className={`${cell} text-slate-700 dark:text-slate-300 break-words`}>{r.when}</td>}
                    {hasWho && <td className={`${cell} font-medium text-slate-900 dark:text-slate-100 truncate`} title={r.who}>{r.who}</td>}
                    {hasWo && <td className={`${cell} font-mono text-slate-500 dark:text-slate-400 truncate ${print ? "text-[7.5pt]" : "text-[11.5px]"}`}>{r.wo}</td>}
                    <td className={`${cell} text-right`}><Progress right={r.right} print={print} /></td>
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
    </div>
  );
}

/** A quiet pencil on a row: update the step right here. */
function EditBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={`Update ${label}`} title="Update this step — status, %, time, comment"
      className="ml-1 inline-flex items-center justify-center w-5 h-5 align-middle rounded text-slate-400 opacity-50 group-hover/sort:opacity-100 pointer-coarse:opacity-100 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-700/60 dark:hover:text-slate-200 focus:opacity-100 print:hidden">
      <Pencil className="w-3 h-3" />
    </button>
  );
}

/** What got done, one row per work order: a table where there's room;
 *  on a phone, a short card each — nothing to scroll sideways for. */
type DoneTask = ReturnType<typeof doneByTask>[number];

/** The steps a task did this shift — one per line: its WO when the task
 *  has several, its time when times are on, its comment under it. */
function DoneLines({ x, stamps, T, print, onEdit }: { x: DoneTask; stamps: boolean; T: (ms: number) => string; print: boolean; onEdit?: (id: string) => void }) {
  return (
    <div>
      <div>{x.head}:</div>
      {x.lines.map((l) => {
        const lead = [l.wo ? `WO ${l.wo}` : "", stamps && l.time != null ? T(l.time) : ""].filter(Boolean).join(" ");
        return (
          <div key={l.id} className="mt-0.5">
            {lead && <span className={`font-mono text-slate-600 dark:text-slate-300 mr-1.5 ${print ? "text-[7.5pt]" : "text-[11.5px]"}`}>{lead}</span>}
            <span>{l.name}</span>
            {l.critical && <span className={`ml-1.5 font-bold text-rose-700 dark:text-rose-400 ${print ? "text-[7pt]" : "text-[10.5px]"}`}>critical path</span>}
            {l.discovery && <span className={`ml-1.5 font-bold text-violet-700 dark:text-violet-300 ${print ? "text-[7pt]" : "text-[10.5px]"}`}>{l.discovery}</span>}
            {!print && onEdit && <EditBtn label={l.name} onClick={() => onEdit(l.id)} />}
            {l.note && <div className={`italic text-slate-500 dark:text-slate-400 ${lead ? "ml-3" : ""} ${print ? "text-[7.5pt]" : "text-[11px]"}`}>“{l.note}”</div>}
          </div>
        );
      })}
    </div>
  );
}

function DoneTasks({ rows, print, stamps = false, T, sort, onEdit }: { rows: DoneTask[]; print: boolean; stamps?: boolean; T: (ms: number) => string;
  /** Tasks dragged into order at the meeting. */
  sort?: { onReorder?: (keys: string[]) => void };
  onEdit?: (id: string) => void;
}) {
  const { box: sortBox, grip, indicator: sortLine, moving } = useSortRows(print ? undefined : sort?.onReorder);
  const hasWo = rows.some((x) => x.wo);
  const resultCls = (t: string) => (t === "amber" ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-400");
  const vsCls = (t?: string) => (t === "rose" ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400");
  const cell = print ? "px-1 py-[1px]" : "px-2 py-1.5";
  const pctLine = (x: DoneTask) => (x.taskPct ? `task ${x.taskPct.pct}% done${x.taskPct.plan != null ? ` · plan ${x.taskPct.plan}%` : ""}` : null);
  const whyLine = (x: DoneTask) => x.why && <div className={`mt-0.5 italic font-medium text-amber-800 dark:text-amber-300 ${print ? "text-[7.5pt]" : "text-[11.5px]"}`}>Why behind: {x.why}</div>;
  return (
    <div ref={sortBox} className="relative">
      {sortLine}
      {!print && (
        <div className="sm:hidden rounded-md border border-slate-300 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700/60">
          {rows.map((x) => (
            <div key={x.ids.join(",")} data-sort-id={x.key} className={`group/sort px-3 py-2 text-[12.5px] space-y-0.5 ${moving(x.key) ? "opacity-40" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <b className="text-[var(--color-text)] break-words"><Grip props={grip([x.key], x.task)} />{x.task}{x.critical && <CriticalTag />}{x.wo && <span className="ml-1.5 font-mono font-semibold text-[11px] text-[var(--color-text-muted)]">WO {x.wo}</span>}</b>
                {x.vs.text && <b className={`shrink-0 font-mono text-[12px] ${vsCls(x.vs.tone)}`}>{x.vs.text}</b>}
              </div>
              {pctLine(x) && <div className="text-[11px] text-[var(--color-text-muted)]">{pctLine(x)}</div>}
              <div className="text-[var(--color-text)] break-words"><DoneLines x={x} stamps={stamps} T={T} print={false} onEdit={onEdit} /></div>
              <div className={`font-bold break-words ${resultCls(x.result.tone)}`}>{x.result.text}</div>
              {whyLine(x)}
              {x.who && <div className="text-[11.5px] text-[var(--color-text-muted)] break-words">{x.who}</div>}
            </div>
          ))}
        </div>
      )}
      <div className={print ? "" : "hidden sm:block"}>
        <table className={`w-full border-collapse ${print ? "text-[8pt]" : "text-[12.5px]"}`}>
          <thead>
            <tr className="border-b border-slate-300 dark:border-slate-600 text-[11px] font-medium text-slate-500 dark:text-slate-400 text-left">
              <th className={`${cell} w-[18%]`}>Task</th>{hasWo && <th className={`${cell} w-[62px]`}>WO</th>}<th className={cell}>Done this shift</th><th className={`${cell} w-[13%]`}>Who</th>
              <th className={`${cell} w-[20%]`}>What it means</th><th className={`${cell} w-[64px] text-right`}>vs plan</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.ids.join(",")} data-sort-id={x.key} className={`group/sort border-b border-slate-100 dark:border-slate-800 align-top ${moving(x.key) ? "opacity-40" : ""}`}>
                <td className={`${cell} font-semibold break-words`}><Grip props={grip([x.key], x.task)} />{x.task}{x.critical && <CriticalTag print={print} />}{pctLine(x) && <div className={`font-normal text-slate-500 dark:text-slate-400 ${print ? "text-[7.5pt]" : "text-[11px]"}`}>{pctLine(x)}</div>}</td>
                {hasWo && <td className={`${cell} font-mono text-[11px] break-words`}>{x.wo.split(/,\s*/).map((w, i) => <span key={i} className="block">{w}</span>)}</td>}
                <td className={`${cell} break-words`}><DoneLines x={x} stamps={stamps} T={T} print={print} onEdit={onEdit} /></td>
                <td className={`${cell} text-[11.5px] text-[var(--color-text-muted)] break-words`}>{x.who}</td>
                <td className={`${cell} font-bold break-words ${resultCls(x.result.tone)}`}>{x.result.text}{whyLine(x)}</td>
                <td className={`${cell} text-right font-mono font-bold whitespace-nowrap ${vsCls(x.vs.tone)}`}>{x.vs.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
          <tr className="border-b border-slate-300 dark:border-slate-600 text-[11px] font-medium text-slate-500 dark:text-slate-400 text-left">
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
