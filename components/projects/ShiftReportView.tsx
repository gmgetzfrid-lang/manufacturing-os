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

import { useEscapeClose } from "@/hooks/useEscapeClose";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SubTabs } from "@/components/projects/SubTabs";
import { Button, useActionFeedback } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { badgeText } from "@/lib/badge";
import { createPortal } from "react-dom";
import {
  Printer, ChevronLeft, ChevronRight, ChevronDown, Sun, Moon, Flag, FastForward,
  Zap, Presentation, X, Settings2, Rocket, ArrowLeftRight, Trophy,
  Mail, FileText, Hourglass, Clock, Pencil, Plus, CalendarClock, Eye, EyeOff, ListChecks, ListFilter,
} from "lucide-react";
import HelpTooltip from "@/components/ui/HelpTooltip";
import MoreMenu from "@/components/ui/MoreMenu";
import { useIsMobile } from "@/hooks/useIsMobile";
import { OPEN_SETUP_EVENT } from "@/lib/scheduleSetup";
import type { Milestone, MilestoneNote } from "@/types/schema";
import { buildProgressIndex, leafPercent, type ProgressInfo } from "@/lib/scheduleProgress";
import { behindWhy, chainText, chainLabel, labelHours, whyTitle, type BehindWhy } from "@/lib/behindWhy";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { withWorkOrderCrews } from "@/lib/workOrderCrew";
import { turnoverPlan, nextOf, standing, askedLine, doneOf, crewsOf, doneByTask, shareOf, SEVERE_BEHIND_H, pathNote, competition, type TableOrder, type DoneLine } from "@/lib/turnoverPlan";
import {
  buildShiftReport, shiftWindow, shiftAt, nextShift, previousShift, defaultReviewShift, nextShiftWithWork, expectedByParent, paceOf, expectedFraction, workShiftOf, staffedDueMs, meetingLeadMin, type Pace, type WorkShift, type ShiftBreak,
  DEFAULT_SHIFT_TIMES, type ShiftTimes, type ShiftRow, type ShiftWindow, type ShiftReport, type PullCrew,
  crewsOnReport, filterShiftReport, whoOf, notesForShift, TURNOVER_GRACE_MS, rowTask, type PathInfo, type ShiftPlan,
} from "@/lib/shiftReport";
import { buildKickoff, buildCloseout, defaultMeeting, type MeetingKind, type PlanRow } from "@/lib/meetingPlan";
import { clockLabel, fmtInTz, tzAbbrev, toDateTimeInput } from "@/lib/scheduleTz";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { forManagement, managementForm, headcountLine, type ExportBlock, type ExportCell, type ExportDoc, type ExportSection, type ExportStepRow, type Tone } from "@/lib/reportExport";
import { turnoverUpdate, withoutEmpty, noteLine, hazardJobsOf, forecastText, discoverySub, discoveryBlock } from "@/lib/managementUpdate";
import { useShiftTimes, useShiftTimesSaved, saveProjectShiftTimes, shiftTimesProblem } from "@/lib/shiftTimesStore";
import { isDefaultType, typeWord } from "@/lib/projectType";
import { useProjectTypeCtx } from "@/components/projects/ProjectTypeContext";
import { notesFor } from "@/lib/milestones";
import { useShiftRecords, saveShiftRecord, openFollowUps, newId, CLOSEOUT_KEY, editIncident, editNote, unclearNote, restoreIncident, restoreNote, type CrewCount, type Incident, type IncidentKind, type ShiftNote, type ShiftRecord } from "@/lib/shiftRecord";
import { lostWords, buildLookBack, CAUSE_LABEL, type LookBack, type StepLook } from "@/lib/lookBack";
import { IncidentsLine, ShiftNotesBox, TimeLogButton } from "@/components/projects/ShiftRecordParts";
import { useSortRows, Grip } from "@/components/projects/SortRows";
import AddWorkPicker from "@/components/projects/AddWorkPicker";
import { useWoClasses, passes, WoClassSelects } from "@/components/projects/WoClassFilter";
import { typeLabel, unitLabel, NONE } from "@/lib/woClass";
import CalendarQuickView, { type StepUpdate } from "@/components/projects/CalendarQuickView";
import { discoveries, discoveryOf, discoverySummary, discoveryStepLine, impactLine, impactNowLine, hoursNow, ADDED, kindOf, addedTitle, type Discovery } from "@/lib/discovery";
import { buildTimeLog, downloadTimeLog } from "@/lib/timeLog";
import { loadProgressLog, scheduleAt, type ProgressLogRow } from "@/lib/progressHistory";
import { waitingAndReady, type WaitingReady } from "@/lib/waitingReady";
import { CAUSE_WORD, jobWord, orderWord } from "@/lib/postEventReview";
import { workSummary, workSteps, vsPlanWords, type WorkSummary } from "@/lib/closeoutStatus";
import { usePhases } from "@/components/projects/PhaseContext";
import { inPhase } from "@/lib/projectPhases";
import { phaseOfDay, lateWords } from "@/lib/phaseStanding";
import { noScheduleWords, closeoutPrint, withDays } from "@/lib/phaseReport";
import { resolveCriticalPath, floatsOf, pathMarks, CRITICAL_MODES, type PathMarks } from "@/lib/criticalPath";
import { useCriticalMode, saveCriticalMode } from "@/lib/criticalModeStore";
import { effectiveSpans } from "@/lib/scheduleTime";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { SafetyMomentBox } from "@/components/projects/SafetyMomentBox";
import { useLetterhead } from "@/lib/letterheadStore";
import { letterheadLayersHtml, letterheadPrintCss, type Letterhead } from "@/lib/letterhead";
import { copyRich, printHtml, sectionsOff, updatePrintDocument, updateSubject, sendParts, sendPrintDocument, updateDocx, updateFileName, saveFile, saveList, readFormat, readHeaderOff, readFormOff, FORMAT_KEY, HEADER_OFF_KEY, FORM_OFF_KEY, type SendFormat, setSendScope, scopedKey, readRaw, saveChoice } from "@/lib/updatePrint";
import { HEADER_PARTS, type HeaderPart } from "@/lib/reportExport";
import type { ReportLink, ShiftPick } from "@/lib/reportLinks";
import { riskHistory, safetyBrief, projectFacts, RISKS_RANKED, type ProjectBase } from "@/lib/safetyTalk";
import { rankHazards, type HazardJobInput, type HazardKind } from "@/lib/safetyMoment";
import { QuickLookCard, QuickLookOpen, TaskSearch, useQuickLookOpen } from "@/components/projects/TaskQuickLook";
import { quickLook, quickLookIndex } from "@/lib/taskQuickLook";
import type { CancelledJob } from "@/lib/cancelledJobs";
import { handoverKey, decisionsToShip, suggestCrews, askedOutcomes, askedResult, capacityOf, type HandoverDecision } from "@/lib/shiftHandover";
import { TryControl, ShipBar } from "@/components/projects/HandoverControls";
import { appAlert } from "@/components/providers/DialogProvider";
import { PullAheadPicker } from "@/components/projects/PullAheadPicker";
import { ShiftPlanPicker } from "@/components/projects/ShiftPlanPicker";
import { planChoices, planSearchPool, planSetText, offPlanText, planCheckText } from "@/lib/nightPlan";
import { useHandoverDraft } from "@/lib/useHandoverDraft";
import { scopeOf } from "@/lib/pullAhead";
import { MeetingBox, ShiftHourlyBox, type HourlyCtx, type MeetingCtx } from "@/components/projects/ShiftHourly";
import { meetingLines, meetingParts, meetingRows, meetingTitle, meetingRecord, meetingEmpty, knownNames, type MeetingParts } from "@/lib/shiftMeeting";
import { overtimeOf, overtimeEnd, overtimeLine, sentHomeLine, shiftEntries, type HoldOver, type OvertimeWindow } from "@/lib/holdOver";
import { HourlyLogExport } from "@/components/projects/HourlyLogExport";
import { FindingsReview, PastJobsPanel, KindChip, useProjectFindings, usePastJobs, pastJobLines, type PastJob } from "@/components/projects/Findings";
import { APPLIES_WORD, KIND_WORD, leadTag, type Finding } from "@/lib/findings";
import { shiftForm, FORM_ROWS, type FormRowId } from "@/lib/shiftForm";
import { exportedLabel, logSteps, shiftLog } from "@/lib/hourlyLog";
// The hourly log file makers load when a log is saved (lib/hourlyLogFiles).
import type { LogFormat } from "@/lib/hourlyLogFiles";
import { slotClocks, hourlyRows, hourSlots, breaksOn, breakLabel, plainLine, workOrderClosers, briefNotes, selfNamed } from "@/lib/shiftHourly";
import { saidWithLatest } from "@/lib/stepComment";
import { sayError } from "@/components/projects/sayError";

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
  /** Discovery / added scope on a task; `at` ("YYYY-MM-DDTHH:mm"): from an hour of the notes. */
  onDiscovery?: (task: Milestone, at?: string) => void;
  /** A work order of its own; `at`: from an hour of the notes. */
  onNewWorkOrder?: (at?: string) => void;
  /** The schedule's clock for the critical path — the same moment the
   *  calendar and the discovery preview use, so the forecast reads alike. */
  pathNow?: number;
  /** Opens "Plan the next shift" (swap, pull in, push out — hosted by the
   *  schedule, the same panel as the calendar's). */
  onPlanNext?: (next: ShiftWindow) => void;
  /** Correct when a step really started / finished. */
  onFixTimes?: (id: string, t: { start?: number | null; finish?: number | null }) => Promise<boolean>;
  /** Only this meeting, no others to switch to (Today: the turnover;
   *  Reports: the kick-off or close-out). */
  meetingFixed?: MeetingKind;
  /** The shift, chosen outside (Reports); null: the current one. */
  shiftPick?: ShiftPick | null;
  /** Reports: nothing on screen, only the update as it goes out (onDoc). */
  docOnly?: boolean;
  /** The update as it would be printed or sent, whenever it changes. */
  onDoc?: (doc: ExportDoc) => void;
  /** Opens a report in Reports, set to this shift (the hourly log, the
   *  time log): in place of making the file here. */
  onOpenReport?: (link: ReportLink) => void;
  /** Start presenting at once (Reports › Present). */
  presentOnOpen?: boolean;
  /** Quiet tools for the report's toolbar row (Update by note). */
  tools?: React.ReactNode;
  /** Rows under the toolbar: setup still to finish, undo. */
  notice?: React.ReactNode;
  /** The page's one orange action is in the band above: Email / Print is quiet. */
  quietMain?: boolean;
}

// A quiet button on the white card; the one accent one is Email / Print.
const QUIET = "inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors";
// The toolbar's shift picker: a field (16 px on a phone, 44 px to touch).
const PICK = "h-9 pointer-coarse:h-11 min-w-0 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] px-2.5 text-body max-sm:text-reading text-[var(--color-text)] tabular-nums";
// Back / forward a shift: an icon button.
const ARROW = "w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 shrink-0 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]";
// A small add button on a line of text (the folded empty sections' line).
const SMALL = "inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-2.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]";
// The sections that list steps: the step filters live in the first of them.
const STEP_SECTIONS = ["done", "next", "after"];
// A quiet text action in the toolbar.
const LINK = "inline-flex items-center gap-1.5 min-h-9 pointer-coarse:min-h-11 px-1 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2 whitespace-nowrap";


const NONE_CANCELLED: CancelledJob[] = [];
/** "Project / turnaround lead"; for a plain project, "Project lead". */
const leadOf = (word: string) => (word.toLowerCase() === "project" ? "Project lead" : `Project / ${word} lead`);

const MEETINGS: Array<{ id: MeetingKind; label: string; Icon: typeof Rocket }> = [
  { id: "kickoff", label: "Kick-off", Icon: Rocket },
  { id: "turnover", label: "Shift turnover", Icon: ArrowLeftRight },
  { id: "closeout", label: "Close-out", Icon: Trophy },
];

export default function ShiftReportView({ milestones: rawLive, progress: liveProgress, projectId, projectName, cancelled = NONE_CANCELLED, userId, userName, canEdit = false, onUpdateStep, onDiscovery, onNewWorkOrder, pathNow, onPlanNext, onFixTimes, meetingFixed, shiftPick, docOnly, onDoc, onOpenReport, presentOnOpen, tools, notice, quietMain }: Props) {
  // The Email / Print choices are kept per project (lib/updatePrint).
  setSendScope(projectId);
  const tz = useScheduleTz();
  // What kind of project it is: the word the report says (Setup › Project type).
  const ptype = useProjectTypeCtx();
  const word = typeWord(ptype);
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
    catch (e) { setTimesMsg(sayError(e)); setTimesDraft(null); }
  };
  const [showTimes, setShowTimes] = useState(false);
  const timesSave = useActionFeedback();
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
  const meeting = meetingFixed ?? meetingPick ?? defaultMeeting(live, now, liveProgress, tz);

  const [ownSel, setSel] = useState<{ dayKey: string; kind: "day" | "night" } | null>(null);
  const sel = shiftPick !== undefined ? shiftPick : ownSel;
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
  // A time fixed on a step (its % and status the same) changes the log
  // too: read it again then.
  const [logTick, setLogTick] = useState(0);
  useEffect(() => {
    const on = () => setLogTick((t) => t + 1);
    window.addEventListener("milestone-notes:changed", on);
    window.addEventListener("schedule:changed", on);
    return () => { window.removeEventListener("milestone-notes:changed", on); window.removeEventListener("schedule:changed", on); };
  }, []);
  useEffect(() => {
    if (!needLog) return;
    let alive = true;
    const t = setTimeout(() => {
      loadProgressLog(projectId).then((l) => { if (alive) setLogState({ rows: l }); }).catch(() => { if (alive) setLogState({ rows: null }); });
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [needLog, projectId, liveSig, logTick]);
  const log = logState?.rows;
  // The shift's own record (crews on site, incidents, notes, the hours), the
  // next one's and the one before's.
  const { records, error: recErr } = useShiftRecords(projectId);
  const thisKey = handoverKey(shift), nextKey = handoverKey(nextShift(shift, tz, times)), prevKey = handoverKey(previousShift(shift, tz, times));
  // Crews held over past the shift's end (overtime), and the ones the shift
  // before held over into it: their work counts for the shift that held them.
  const overtime = useMemo(() => overtimeOf(records.get(thisKey)?.holdOver, shift.end, now, shift.end + (shift.end - shift.start)), [records, thisKey, shift.end, shift.start, now]);
  const heldIn = useMemo(() => overtimeOf(records.get(prevKey)?.holdOver, shift.start, now, shift.end), [records, prevKey, shift.start, shift.end, now]);
  const otTo = overtimeEnd(overtime, shift.end);
  const heldTo = useCallback((w: OvertimeWindow[], m: Milestone) => {
    const c = m.responsibleParty?.trim().toLowerCase();
    return c ? w.filter((x) => x.crew.toLowerCase() === c).reduce<number | null>((a, x) => Math.max(a ?? 0, x.to), null) : null;
  }, []);
  const recordedBy = shift.end + TURNOVER_GRACE_MS;
  const history = useMemo(
    // A held-over crew's work: as it stood when it was sent home.
    () => (pastShift && log ? scheduleAt(live, log, recordedBy, overtime.length ? (m) => Math.max(recordedBy, heldTo(overtime, m) ?? 0) : undefined) : null),
    [pastShift, log, live, recordedBy, overtime, heldTo],
  );
  // Only a record that reaches back to the shift replaces today's
  // progress; otherwise it's today's, and the label says so.
  // The close-out is the end of the job: always as it stands now, never
  // replayed to the last shift it was planned to run.
  const closing = meeting === "closeout";
  const asThen = !closing && history?.complete ? history : null;
  const milestones = asThen ? asThen.milestones : live;
  const progress = useMemo(() => (asThen ? buildProgressIndex(asThen.milestones, tz) : liveProgress), [asThen, liveProgress, tz]);
  // A project split in phases with all of them picked: where the job
  // stands, its critical path and its forecast are those of the phase this
  // shift is in (lib/phaseStanding). Phases run in separate weeks and are
  // never blended into one percent or one verdict. The shift's lists still
  // cover every step. The close-out is the whole project's, phase by phase.
  const phx = usePhases();
  const standPhase = useMemo(() => (!phx.phase && !closing ? phaseOfDay(shift.dayKey, phx.phases, phx.all, tz) : null), [phx, closing, shift.dayKey, tz]);
  const standingIds = useMemo(() => (standPhase ? new Set(inPhase(milestones, phx.phases, standPhase.id).map((m) => m.id).filter((x): x is string => !!x)) : undefined), [standPhase, milestones, phx.phases]);
  const standMs = useMemo(() => (standingIds ? milestones.filter((m) => !!m.id && standingIds.has(m.id)) : milestones), [standingIds, milestones]);
  // The schedule as it stood when the shift began — only when the record
  // reaches back. Each step's % then; and the critical path then.
  const atStart = useMemo(() => {
    if (!log) return null;
    // A crew the shift before held over: where its work stood when it was sent home.
    const cutOf = (m: Milestone) => heldTo(heldIn, m) ?? shift.start;
    const then = scheduleAt(live, log, shift.start, heldIn.length ? cutOf : undefined);
    if (!then.complete) return null;
    // Times recorded after it began hadn't happened yet.
    const later = (m: Milestone, v: unknown) => v != null && Date.parse(String(v)) > cutOf(m);
    return then.milestones.map((m) => ({ ...m, actualStartAt: later(m, m.actualStartAt) ? null : m.actualStartAt, actualAt: m.status === "completed" && !later(m, m.actualAt) ? m.actualAt : null }) as Milestone);
  }, [log, live, shift.start, heldIn, heldTo]);
  const startPct = useMemo(() => (atStart ? new Map(atStart.filter((m) => m.id).map((m) => [m.id!, m.status === "completed" ? 100 : m.percentComplete ?? 0])) : undefined), [atStart]);
  // The critical path — the project's own setting, through lib/criticalPath
  // like every other view: as of the report, and when the shift began (what
  // Done credits). Float from the links rides along (lib/cpm).
  const criticalMode = useCriticalMode(projectId);
  // The shift on now (or just ended) reads the path as of now — on the
  // schedule's one clock; an earlier shift, as it stood then.
  const pathAt = pastShift ? asOf : pathNow ?? now;
  const crit = useMemo(() => resolveCriticalPath(standMs, criticalMode, { now: pathAt, tz }), [standMs, criticalMode, pathAt, tz]);
  const critThen = useMemo(() => (atStart ? resolveCriticalPath(standingIds ? atStart.filter((m) => !!m.id && standingIds.has(m.id)) : atStart, criticalMode, { now: shift.start, tz }) : null), [atStart, standingIds, criticalMode, shift.start, tz]);
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
    const links = resolveCriticalPath(standMs, "links", { now: pathAt, tz }).ids;
    if (links.size === crit.ids.size && [...links].every((id) => crit.ids.has(id))) return undefined;
    const calculated = links.size;
    return {
      label: CRITICAL_MODES.find((x) => x.value === crit.mode)?.label ?? crit.mode, theirs: crit.ids.size, calculated,
      onUse: canEdit ? () => { setPathMsg(null); saveCriticalMode(projectId, "links").catch((e: Error) => setPathMsg(sayError(e))); } : undefined,
      msg: pathMsg,
    };
  }, [crit, standMs, pathAt, tz, canEdit, projectId, pathMsg]);
  const historyNote = !pastShift || closing ? null
    : history?.complete ? `progress as recorded by ${clockLabel(recordedBy, tz)} ${fmtInTz(recordedBy, tz, { month: "short", day: "numeric" })}`
      : `progress as entered by now - the record doesn't reach back to this shift`;

  // ── The turnover as decided and shipped (lib/shiftHandover) ──
  // Decisions are about the next shift (key = the shift handed to); the
  // last turnover's are read back on this one (what was asked of it).
  const hoKey = handoverKey(nextShift(shift, tz, times)), priorKey = handoverKey(shift);
  const [shipBusy, setShipBusy] = useState(false);
  const orgId = live[0]?.orgId ?? "";
  const canShip = canEdit && !!userId && !!orgId;
  const hand = useHandoverDraft({ active: meeting === "turnover", projectId, orgId, userId, hoKey, priorKey });
  const { decisions, shippedAt } = hand;
  // Locked when the turnover is: this shift's report can't be changed by
  // mistake (unlock it on purpose to change it).
  const locked = meeting === "turnover" && !!shippedAt;
  // The crew kept for pulled-forward work: this turnover's own, else the
  // project's default. Null when nobody has set one — no made-up size.
  const pullSet: PullCrew | null = hand.savedPull ?? times.helpers ?? null;
  const pullShown: PullCrew = useMemo(() => hand.pullDraft ?? pullSet ?? { crew: null, hands: 2, hours: 12 }, [hand.pullDraft, pullSet]);
  const pullForReport: PullCrew | null = hand.pullDraft ?? pullSet;
  // Steps pulled forward for the next shift — on the report as rows.
  const pullKey = useMemo(() => Object.entries(decisions).filter(([, d]) => d.tryIt && d.pulled).map(([id]) => id).sort().join(","), [decisions]);

  // The next shift's plan, set by hand (lib/nightPlan), and the one this
  // shift was given: the list, and what the report reads it against.
  const nextPlan = records.get(nextKey)?.plan, thisPlan = records.get(thisKey)?.plan;
  const report = useMemo(
    () => buildShiftReport({ milestones, progress, criticalIds, path, tz, times, shift, now: asOf, pullIds: pullKey ? pullKey.split(",") : undefined, startPct, plan: nextPlan, reviewPlan: thisPlan, standingIds }),
    [milestones, progress, criticalIds, path, tz, times, shift, asOf, pullKey, startPct, nextPlan, thisPlan, standingIds],
  );
  // The shift after that (the other crew's next): its own plan, set the
  // same way, and its list read the same way (the schedule's, with what
  // this crew leaves open).
  const afterWin = useMemo(() => nextShift(report.next, tz, times), [report.next, tz, times]);
  const afterKey = handoverKey(afterWin);
  const afterPlan = records.get(afterKey)?.plan;
  const afterReport = useMemo(() => (meeting === "turnover"
    ? buildShiftReport({ milestones, progress, criticalIds, path, tz, times, shift: report.next, now: asOf, plan: afterPlan })
    : null), [meeting, milestones, progress, criticalIds, path, tz, times, report.next, asOf, afterPlan]);
  // One crew at a time: the whole turnover narrows to their steps.
  const crews = useMemo(() => crewsOnReport(report), [report]);
  const [crewPick, setCrewPick] = useState<string | null>(null);
  const crew = meeting === "turnover" && crewPick && crews.some((x) => x.who === crewPick) ? crewPick : null;
  // Only the critical path, only work added after the plan (discovery,
  // added scope): each narrows the turnover, with the crew.
  const [onlyPick, setOnlyPick] = useState<{ critical: boolean; added: boolean }>({ critical: false, added: false });
  const addedOnly = meeting === "turnover" && onlyPick.added;
  const criticalOnly = meeting === "turnover" && onlyPick.critical;
  // One unit, one equipment type (Setup › Units & equipment).
  const wc = useWoClasses(projectId, milestones);
  const [classPick, setClassPick] = useState<{ units: string[]; types: string[] }>({ units: [], types: [] });
  const classOn = meeting === "turnover" && (classPick.units.length > 0 || classPick.types.length > 0);
  const classOnly = classOn && wc.book ? [...classPick.units.map((u) => (u === NONE ? "No unit" : unitLabel(u, wc.book!))), ...classPick.types.map((t) => (t === NONE ? "No type" : typeLabel(t, wc.book!)))].join(", ") : null;
  // Pulled work is the extra crew's, not the step owner's: in one crew's
  // view it shows when it's that crew's to do (or its own scope).
  const pulledCrewFallback = (hand.pullDraft ?? pullSet)?.crew ?? null;
  const view = useMemo(() => {
    if (!crew && !addedOnly && !criticalOnly && !classOn) return report;
    const added = (r: ShiftRow) => (!addedOnly || !!discoveryOf(r.leaf)) && (!criticalOnly || r.critical) && (!classOn || passes(wc, r.leaf, classPick.units, classPick.types));
    const v = filterShiftReport(report, (r) => (!crew || whoOf(r) === crew) && added(r));
    const mine = (r: ShiftRow) => (!crew || (decisions[r.leaf.id ?? ""]?.crew ?? pulledCrewFallback) === crew || whoOf(r) === crew) && added(r);
    return { ...v, goals: { ...v.goals, pulled: report.goals.pulled.filter(mine), pulledHeld: report.goals.pulledHeld.filter(mine) } };
  }, [report, crew, addedOnly, criticalOnly, decisions, pulledCrewFallback, classOn, wc, classPick]);
  // Why it's behind: each step's hours of work traced to what holds it up
  // (lib/behindWhy) — the whole job's, like the standing.
  const why = useMemo(() => behindWhy({ behind: report.overall.drivers.behind, ahead: report.overall.drivers.aheadHours, milestones, now: report.now,
    pctOf: (m) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m), critical: criticalIds }), [report, milestones, progress, criticalIds]);
  const kickoff = useMemo(() => buildKickoff({ milestones, progress, criticalIds, tz, times }), [milestones, progress, criticalIds, tz, times]);
  const closeout = useMemo(() => buildCloseout({ milestones, progress, criticalIds, tz }), [milestones, progress, criticalIds, tz]);
  // When the last step really finished, against the plan (the close-out's standing).
  const workDone = useMemo(() => (meeting === "closeout" ? workSummary(milestones) : undefined), [meeting, milestones]);
  // The whole project in phases: a phase with no schedule yet means it isn't done.
  const unscheduled = useMemo(() => (meeting === "closeout" && !phx.phase && phx.phases.length
    ? phx.phases.filter((p) => workSteps(inPhase(phx.all, phx.phases, p.id)).length === 0) : []), [meeting, phx]);
  const unscheduledWords = useMemo(() => unscheduled.map((p) => noScheduleWords(p, now, tz)), [unscheduled, now, tz]);
  const rehearsal = now < shift.start;
  const jumpTarget = useMemo(() => (report.review.scheduled.length === 0 ? nextShiftWithWork(milestones, shift, tz, times) : null), [report.review.scheduled.length, milestones, shift, tz, times]);
  const byId = useMemo(() => { const m = new Map<string, Milestone>(); for (const x of milestones) if (x.id) m.set(x.id, x); return m; }, [milestones]);
  // Each task's steps: how many are done, of how many - "4 of 10 steps done".
  const stepTally = useMemo(() => {
    const parents = new Set(milestones.map((m) => m.parentId).filter((x): x is string => !!x));
    const n = new Map<string, { done: number; total: number }>();
    for (const m of milestones) {
      if (!m.parentId || (m.id && parents.has(m.id))) continue;
      const done = m.status === "completed" || ((m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m)) >= 100;
      const seen = new Set<string>();
      for (let pid: string | null | undefined = m.parentId; pid && !seen.has(pid); pid = byId.get(pid)?.parentId) {
        seen.add(pid);
        const c = n.get(pid) ?? { done: 0, total: 0 };
        n.set(pid, { done: c.done + (done ? 1 : 0), total: c.total + 1 });
      }
    }
    return n;
  }, [milestones, byId, progress]);

  // Each main task's planned % by now — "on plan" or "behind", and "x% of
  // y% planned" next to its progress.
  const planByTask = useMemo(() => expectedByParent(milestones, asOf, tz, times), [milestones, asOf, tz, times]);
  const ctx = useMemo(() => makeCtx(tz, byId, progress, planByTask, word), [tz, byId, progress, planByTask, word]);
  // Where the job (or the phase the shift is in) stands, in one sentence
  // with its one number: the same words on screen, in the email and in
  // print, named the way the page header names it ("Phase 1", "The work"),
  // and never "on track" over a finish that came late.
  const standWork = useMemo(() => workSummary(standMs), [standMs]);
  const scopeName = standPhase?.name ?? (phx.phase ? phx.phases.find((p) => p.id === phx.phase)?.name : undefined) ?? "The work";
  const say = useMemo(() => standSay({ overall: report.overall, gap: report.goals.gapHours, forecast, work: standWork, scope: scopeName, c: ctx, now: report.now }),
    [report, forecast, standWork, scopeName, ctx]);

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
  // ── Plan the next shift (ShiftPlanPicker): what to pick from is the
  // schedule's own read, without the plan.
  // Which shift is being planned: the next one, or the one after it.
  const [planFor, setPlanFor] = useState<"this" | "next" | "after" | null>(null);
  const planOpen = planFor != null;
  const setPlanOpen = (on: boolean) => setPlanFor(on ? "next" : null);
  const planBase = useMemo(() => (planFor
    // Planned from the shift before the one being planned: this shift from
    // the last, the next from this, the one after from the next.
    ? buildShiftReport({ milestones, progress, criticalIds, path, tz, times, shift: planFor === "after" ? report.next : planFor === "this" ? previousShift(shift, tz, times) : shift, now: planFor === "this" ? Math.min(asOf, shift.start) : asOf, lookAheadUntil: Infinity, startPct: planFor === "next" ? startPct : undefined })
    : null), [planFor, milestones, progress, criticalIds, path, tz, times, shift, report.next, asOf, startPct]);
  const planGroups = useMemo(() => (planBase ? planChoices(planBase) : []), [planBase]);
  const planPool = useMemo(() => (planBase ? planSearchPool(planBase, planGroups) : []), [planBase, planGroups]);
  const savePlan = useCallback((p: ShiftPlan | undefined, key: string = nextKey) => saveShiftRecord({ orgId, projectId, shiftKey: key, userId: userId ?? "",
    change: (r) => { const n = { ...r }; if (p) n.plan = p; else delete n.plan; return n; } }).then(() => undefined), [orgId, projectId, nextKey, userId]);
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
  // A step's comment this shift: the one typed with its last change, or
  // after it. One from an earlier update isn't shown with a later change.
  const noteThen = useCallback((id: string) => {
    const n = shiftNotes.note.get(id);
    return n && saidWithLatest(n.at, timeOf(id)) ? { body: n.body, at: new Date(n.at).toISOString(), by: n.by } : undefined;
  }, [shiftNotes, timeOf]);
  // Where a whole task stands: its % done and % planned by now.
  const taskPct = useCallback((id: string) => {
    const p = progress?.get(id)?.percent;
    return p == null ? undefined : { pct: p, plan: planByTask.get(id) };
  }, [progress, planByTask]);
  // A save to the shift's record that didn't go through: what went wrong,
  // and the same save again (shown above the report until it's done).
  const [recFail, setRecFail] = useState<{ msg: string; retry: () => void } | null>(null);
  const recMsg = recFail?.msg ?? null;
  const saveRec = useCallback(async (key: string, change: (r: ShiftRecord) => ShiftRecord): Promise<boolean> => {
    if (!userId || !orgId) { setRecFail({ msg: "Sign in to save.", retry: () => undefined }); return false; }
    try { await saveShiftRecord({ orgId, projectId, shiftKey: key, userId, change }); setRecFail(null); return true; }
    catch (e) {
      const again = (): void => { void saveShiftRecordAgain(); };
      const saveShiftRecordAgain = async () => {
        try { await saveShiftRecord({ orgId, projectId, shiftKey: key, userId, change }); setRecFail(null); }
        catch (e2) { setRecFail({ msg: sayError(e2), retry: again }); }
      };
      setRecFail({ msg: sayError(e), retry: again });
      return false;
    }
  }, [orgId, projectId, userId]);
  // The shift's entries — the time log for its window — for the
  // hour-by-hour notes to be written from.
  const shiftRows = useCallback(async () => {
    const [rows, notes] = await Promise.all([loadProgressLog(projectId), notesFor(stepIds ? stepIds.split(",") : [])]);
    return buildTimeLog({ milestones: live, log: rows ?? [], notes, records, tz, times, from: shift.start, to: otTo, word });
  }, [projectId, stepIds, live, records, tz, times, shift.start, otTo, word]);
  const updateHourly = useCallback(async (change: (cur: ShiftRecord["hourly"]) => ShiftRecord["hourly"] | null) => {
    if (!userId || !orgId) throw new Error("Sign in to save the notes.");
    await saveShiftRecord({ orgId, projectId, shiftKey: thisKey, userId, change: (r) => ({ ...r, hourly: change(r.hourly) ?? undefined }) });
  }, [orgId, projectId, userId, thisKey]);
  // The shift's entries as the hours say them: the time log for its window,
  // each comment with the entry it was typed with. Re-read as progress is entered.
  // Its held-over crews' work after its end is its own; the crews the shift
  // before held over aren't.
  const entries = useMemo(() => (log ? shiftEntries(buildTimeLog({ milestones: live, log, notes: allNotes, records, tz, times, from: shift.start, to: otTo, word }), shift, overtime, heldIn) : null),
    [log, live, allNotes, records, tz, times, shift, otTo, overtime, heldIn, word]);
  // The shift by the hour: its meeting (from the shift times), the first
  // hour (permitting), then each hour; a crew held over, its overtime.
  const slots = useMemo(() => hourSlots(shift, meetingLeadMin(times), breaksOn(shift, times.breaks, tz),
    overtime.length ? { to: otTo, open: overtime.some((x) => x.open), label: overtimeLine(overtime), endLabel: sentHomeLine(overtime) } : undefined), [shift, times, tz, overtime, otTo]);
  // The tables' order as dragged at the meeting — shown at once, kept on
  // the shift's record (the email follows it too).
  const [orderLocal, setOrderLocal] = useState<{ key: string; order: TableOrder } | null>(null);
  // Work added from an hour of the notes: which work order, then the form at that hour.
  const [addAt, setAddAt] = useState<number | null>(null);
  const tableOrder = orderLocal?.key === thisKey ? orderLocal.order : records.get(thisKey)?.order;
  // The entries that finish a whole work order: green in the hours.
  const closers = useMemo(() => workOrderClosers(live), [live]);
  const sheet = useMemo<SheetCtx>(() => {
    const recThis = records.get(thisKey), recNext = records.get(nextKey);
    const labelOf = (key: string) => { const [d, k] = key.split(":"); const w = shiftWindow(d, k as "day" | "night", tz, times); return `${ctx.D(w.start)} ${k}`; };
    const shiftName = (key: string) => { const [d, k] = key.split(":"); const w = shiftWindow(d, k as "day" | "night", tz, times); return `${fmtInTz(w.start, tz, { weekday: "short", month: "short", day: "numeric" })} ${k} shift`; };
    // Each meeting's crews: its own, or carried from the last same shift.
    const mThis = meetingRecord(records, thisKey), mNext = meetingRecord(records, nextKey);
    const carriedOf = (x: { record?: ShiftRecord; from: string | null }) => (x.from ? { crews: x.record?.crews ?? {}, label: shiftName(x.from) } : undefined);
    const by = userName ?? null;
    return {
      stamps, timeOf, whyOf, taskPct, projectId, thisKey, nextKey,
      // A locked report: nothing on it changes until it's unlocked.
      edit: canEdit && !!userId && !!orgId && !locked,
      locked,
      crewsThis: mThis.record?.crews ?? {}, crewsNext: mNext.record?.crews ?? {},
      recThis: mThis.record, recNext: mNext.record,
      carriedThis: carriedOf(mThis), carriedNext: carriedOf(mNext),
      // The meetings: each on the record of the shift it starts (this
      // shift's, and the next one's at its end).
      saveMeeting: async (which, change) => {
        if (!userId || !orgId) throw new Error("Sign in to save the meeting.");
        await saveShiftRecord({ orgId, projectId, shiftKey: which === "this" ? thisKey : nextKey, userId, change });
      },
      known: knownNames(records),
      setCrew: (which, crew, v) => void saveRec(which === "this" ? thisKey : nextKey, (r) => ({ ...r, crews: { ...(r.crews ?? {}), [crew]: { ...(r.crews?.[crew] ?? {}), ...v } } })),
      incidents: recThis?.incidents,
      setNone: (none) => void saveRec(thisKey, (r) => ({ ...r, incidents: { ...(r.incidents ?? {}), none: none ? { at: Date.now(), by } : null } })),
      addIncident: (x) => saveRec(thisKey, (r) => ({ ...r, incidents: { none: null, items: [...(r.incidents?.items ?? []), { id: newId(), ...x, by }] } })),
      removeIncident: (id) => void saveRec(thisKey, (r) => ({ ...r, incidents: { ...(r.incidents ?? {}), items: (r.incidents?.items ?? []).filter((x) => x.id !== id) } })),
      editIncident: (id, x) => saveRec(thisKey, (r) => editIncident(r, id, x, by)),
      restoreIncident: (x) => void saveRec(thisKey, (r) => restoreIncident(r, x)),
      notes: [...(recThis?.notes ?? []).map((n) => ({ ...n, shiftKey: thisKey })), ...openFollowUps(records, thisKey).map((n) => ({ ...n, from: labelOf(n.shiftKey) }))],
      addNote: (x) => saveRec(thisKey, (r) => ({ ...r, notes: [...(r.notes ?? []), { id: newId(), ...x, by }] })),
      clearNote: (n) => void saveRec(n.shiftKey, (r) => ({ ...r, notes: (r.notes ?? []).map((y) => (y.id === n.id ? { ...y, cleared: { at: Date.now(), by } } : y)) })),
      removeNote: (n) => void saveRec(n.shiftKey, (r) => ({ ...r, notes: (r.notes ?? []).filter((y) => y.id !== n.id) })),
      editNote: (n, x) => saveRec(n.shiftKey, (r) => editNote(r, n.id, x, by)),
      unclearNote: (n) => void saveRec(n.shiftKey, (r) => unclearNote(r, n.id)),
      restoreNote: (n) => { const { shiftKey, ...note } = n; void saveRec(shiftKey, (r) => restoreNote(r, note)); },
      error: recMsg ?? (recErr && canEdit ? recErr : null),
      tz,
      hourly: orgId ? {
        notes: recThis?.hourly, update: updateHourly, entries, slots, upTo: Math.min(now, otTo),
        // Keeping a crew on past the end of the shift (overtime).
        overtime: canEdit && userId && !locked ? {
          list: recThis?.holdOver ?? [], crews: allCrews, shiftEnd: shift.end, cap: shift.end + (shift.end - shift.start), tz,
          // What a hold-over costs at the contractor's rate sheet.
          projectId, shiftKey: thisKey, shiftHours: (shift.end - shift.start) / 3_600_000,
          save: async (change: (l: HoldOver[]) => HoldOver[]) => {
            await saveShiftRecord({ orgId, projectId, shiftKey: thisKey, userId, change: (r) => ({ ...r, holdOver: change(r.holdOver ?? []) }) });
          },
        } : undefined,
        onAddWork: canEdit && onDiscovery && !locked ? setAddAt : undefined,
        closes: closers,
        meet: {
          start: { title: meetingTitle(shift.kind), lines: meetingLines(mThis.record, shift.start), parts: meetingParts(mThis.record, shift.start), carried: carriedOf(mThis)?.label },
          end: { title: meetingTitle(report.next.kind), lines: meetingLines(mNext.record, shift.end), parts: meetingParts(mNext.record, shift.end), carried: carriedOf(mNext)?.label },
          // The end meeting shows early only for what was entered for it.
          // A crew held over in place of the next shift: no meeting with it unless put back.
          ...meetingRows(recThis, mNext.from ? { ...(recNext ?? {}), crews: {} } : recNext, shift.end, { startOff: heldIn.length > 0, endOff: overtime.length > 0 }),
        },
      } : undefined,
      order: tableOrder,
      setOrder: (table, ids) => {
        setOrderLocal({ key: thisKey, order: { ...(tableOrder ?? {}), [table]: ids ?? undefined } });
        void saveRec(thisKey, (r) => ({ ...r, order: { ...(r.order ?? {}), [table]: ids ?? undefined } }));
      },
    };
  }, [records, thisKey, nextKey, tz, times, ctx, userName, stamps, timeOf, whyOf, taskPct, canEdit, userId, orgId, projectId, saveRec, recMsg, recErr, tableOrder, setOrderLocal, updateHourly, entries, shift, slots, now, onDiscovery, report.next.kind, locked, closers, allCrews, heldIn.length, otTo, overtime.length]);
  const shiftTitle = `${shift.kind === "day" ? "Day shift" : "Night shift"} ${fmtInTz(shift.start, tz, { weekday: "short", month: "short", day: "numeric" })}`;
  // The hourly log of the shift on screen (any shift, backed up by date),
  // as a file on the letterhead.
  const exportHourly = async (format: LogFormat) => {
    const [rows, progressRows] = await Promise.all([shiftRows(), log ? Promise.resolve(log) : loadProgressLog(projectId)]);
    const a = meetingRecord(records, thisKey), b = meetingRecord(records, nextKey);
    const one = shiftLog({ shift, tz, times, record: a.record, next: b.record, prev: records.get(prevKey), carried: { start: !!a.from, end: !!b.from }, rows, steps: logSteps(live, tz, times), log: progressRows ?? [], now: Date.now(), closes: closers });
    const name = (projectName ?? "Schedule").trim() || "Schedule";
    const { saveHourlyLog, pngInBrowser } = await import("@/lib/hourlyLogFiles");
    await saveHourlyLog([one], format, { project: name, lh, exported: exportedLabel(Date.now(), tz), toPng: pngInBrowser, fileName: `${name} - hourly log ${shift.dayKey} ${shift.kind}` });
    return "Saved.";
  };
  // The same export, from the hour-by-hour section itself.
  const exportRef = useRef(exportHourly);
  useEffect(() => { exportRef.current = exportHourly; });
  const shiftDayKey = shift.dayKey, shiftKind = shift.kind;
  const hourlyExport = useMemo(() => (onOpenReport
    ? <OpenReportButton label="Hourly log" onClick={() => onOpenReport({ id: "hourly", shift: { dayKey: shiftDayKey, kind: shiftKind } })} />
    : <HourlyLogExport formats={["pdf", "docx"]} what={`Hourly log - ${shiftTitle}`} letterhead={!!lh} onExport={(f) => exportRef.current(f)} label={lh ? "Export on letterhead" : "Export hourly log"} />
  ), [shiftTitle, lh, onOpenReport, shiftDayKey, shiftKind]);
  // The time log: every step's times, for the project file — its own
  // export, not part of the update.
  const [logBusy, setLogBusy] = useState(false);
  const [logMsg, setLogMsg] = useState<string | null>(null);
  const exportTimeLog = async (scope: "shift" | "job") => {
    setLogBusy(true); setLogMsg(null);
    try {
      const [rows, allNotes] = await Promise.all([loadProgressLog(projectId), notesFor(stepIds ? stepIds.split(",") : [])]);
      const out = buildTimeLog({ milestones: live, log: rows ?? [], notes: allNotes, records, tz, times, word, ...(scope === "shift" ? { from: shift.start, to: shift.end } : {}) });
      const name = (projectName ?? "Schedule").replace(/[\\/:*?"<>|]/g, "").trim() || "Schedule";
      await downloadTimeLog(out, {
        project: projectName ?? "Schedule", tz,
        title: scope === "shift" ? `Time log - ${shiftName(shift)} ${ctx.D(shift.start)}` : "Time log - whole job to date",
        fileName: `${name} - time log${scope === "shift" ? ` ${shift.dayKey} ${shift.kind}` : ""}.xlsx`,
      });
      setLogMsg(`${out.length} entr${out.length === 1 ? "y" : "ies"} exported.`);
    } catch (e) { setLogMsg(`Not exported: ${sayError(e)}`); }
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
      // Nothing set or read from the name and groups: the safety topics read the names themselves, as always.
      ...(isDefaultType(ptype) ? {} : { type: ptype }),
    };
  }, [live, projectName, report.overall.plannedStart, report.overall.plannedFinish, report.overall.standing, tz, ptype]);
  // The risk cards of the shifts before the next one, from the schedule —
  // so a kind of work that's led two shifts running steps aside.
  const nextStart = report.next.start;
  const recentRisks = useMemo(() => riskHistory(live, shiftAt(nextStart, tz, times), tz, times), [live, nextStart, tz, times]);
  const safety = useMemo(() => ({ project: safetyProject, recent: recentRisks }), [safetyProject, recentRisks]);
  // The step being updated from its row.
  const [editing, setEditing] = useState<string | null>(null);
  // The close-out's look back (lib/lookBack) — the job as it stands, its
  // whole history of comments and holds — and the lessons the team writes.
  const lookBack = useMemo(() => (meeting === "closeout" ? buildLookBack({ milestones: live, notes: allNotes, discoveries: discoveryList, now: pathAt, tz, word, log }) : null), [meeting, live, allNotes, discoveryList, pathAt, tz, word, log]);
  // Lessons & findings (the close-out's one review), and what past jobs on
  // this equipment and unit taught (the kick-off).
  const { rows: findingRows } = useProjectFindings(meeting === "closeout" ? projectId : null);
  const { list: pastJobs } = usePastJobs(meeting === "kickoff" ? orgId : null, projectId, ptype.word, live);
  // The team's close-out lessons not reviewed yet: still in print and the
  // email, under their own heading, until each is kept or dropped.
  const teamLessons = records.get(CLOSEOUT_KEY)?.lessons;
  const findingsCtx = useMemo<FindingsCtx>(() => {
    const reviewed = new Set(findingRows.filter((f) => f.source === "lesson" && f.sourceRef).map((f) => f.sourceRef));
    return {
      orgId, projectId, projectType: ptype.word, canEdit: canEdit && !!userId, kept: findingRows.filter((f) => f.status === "kept"), past: pastJobs, live,
      team: (teamLessons ?? []).filter((l) => !reviewed.has(l.id)).map((l) => ({ text: l.text, by: l.by ?? null })),
    };
  }, [orgId, projectId, ptype.word, canEdit, userId, findingRows, pastJobs, live, teamLessons]);
  // The shift's waiting and ready lists (lib/waitingReady), once the log is in.
  const waitList = useMemo(() => (meeting === "turnover" && log ? waitingAndReady({ milestones: live, log, notes: allNotes, tz, times, shift: view.shift }) : null), [meeting, log, live, allNotes, tz, times, view.shift]);
  const baseSections = useMemo(() => meeting === "kickoff"
    ? kickoffSections(kickoff, ctx, findingsCtx)
    : meeting === "closeout"
      ? closeoutOrder(closeoutSections(closeout, report, ctx, cancelled, discoveryList, lookBack, findingsCtx, workDone, unscheduledWords))
      : turnoverSections(view, ctx, { say, onJump: jumpTarget ? () => pick(jumpTarget) : undefined, jumpTarget, noteOf: noteThen, times, crew, whole: report, handover: handoverCtx, safety, sheet, hourlyExport, onEdit: canEdit && onUpdateStep && !locked ? setEditing : undefined, forecast, standPhase: standPhase?.name, pathSource, discovery: discoveryList, why, taskSteps: (id) => stepTally.get(id),
        onDiscovery: onDiscovery && !locked ? () => { const first = view.goals.all[0]?.parentId ?? view.review.done[0]?.parentId; const t = (first ? live.find((m) => m.id === first) : undefined) ?? live.find((m) => live.some((k) => k.parentId === m.id)); if (t) onDiscovery(t); } : undefined,
        // Only while the next shift is still ahead (or on).
        onPlanNext: onPlanNext && report.next.end > now && !locked ? () => onPlanNext(report.next) : undefined,
        nightPlan: { plan: nextPlan, open: report.next.end > now && (canShip || nextPlan) ? () => setPlanOpen(true) : undefined },
        after: afterReport ? { report: afterReport, plan: afterPlan, open: afterWin.end > now && (canShip || afterPlan) ? () => setPlanFor("after") : undefined } : undefined,
        // This shift's own plan: the work after its meeting, set (or fixed) here.
        thisPlan: { plan: thisPlan, open: canShip || thisPlan ? () => setPlanFor("this") : undefined } }),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setPlanOpen / setPlanFor are state setters
  [meeting, kickoff, closeout, report, view, ctx, say, jumpTarget, noteThen, times, crew, cancelled, handoverCtx, safety, sheet, canEdit, onUpdateStep, forecast, standPhase, pathSource, discoveryList, why, stepTally, onDiscovery, live, onPlanNext, now, lookBack, hourlyExport, locked, findingsCtx, nextPlan, canShip, workDone, unscheduledWords, afterReport, afterPlan, afterWin, thisPlan]);
  // Waiting and ready sits right after what the shift got done.
  const allSections = useMemo(() => {
    if (meeting !== "turnover" || !waitList) return baseSections;
    const sec = waitingSection(waitList, view.shift, ctx);
    const at = baseSections.findIndex((x) => x.id === "done");
    return at < 0 ? [...baseSections, sec] : [...baseSections.slice(0, at + 1), sec, ...baseSections.slice(at + 1)];
  }, [baseSections, meeting, waitList, view.shift, ctx]);
  // Sections left off the report, on screen and in print — the viewer's own
  // choice for each meeting, remembered like the email's. Each comes back
  // with a tap (listed at the bottom); the email keeps its own choice.
  const [hiddenBy, setHiddenBy] = useState<Record<string, string[]>>({});
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the viewer's own choice, read once after mount
    try { setHiddenBy((JSON.parse(localStorage.getItem("shiftReport:hidden") ?? "{}") ?? {}) as Record<string, string[]>); } catch { /* private mode */ }
  }, []);
  const setHidden = useCallback((id: string | null, hide: boolean) => setHiddenBy((cur) => {
    const was = cur[meeting] ?? [];
    const next = { ...cur, [meeting]: id == null ? [] : hide ? [...new Set([...was, id])] : was.filter((x) => x !== id) };
    try { localStorage.setItem("shiftReport:hidden", JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  }), [meeting]);
  // The report's items (the agenda-only ones aside), less the hidden ones;
  // and the meeting's agenda, in its order (Today › Meeting).
  const reportAll = useMemo(() => allSections.filter((x) => x.agenda !== "only"), [allSections]);
  const reportSections = useMemo(() => reportAll.filter((x) => !(hiddenBy[meeting] ?? []).includes(x.id)), [reportAll, hiddenBy, meeting]);
  const hiddenSecs = useMemo(() => reportAll.filter((x) => (hiddenBy[meeting] ?? []).includes(x.id)), [reportAll, hiddenBy, meeting]);
  const agendaList = useMemo(() => (meeting === "turnover" ? [...allSections.filter((x) => x.agenda === "only"), ...allSections.filter((x) => x.agenda === "also")] : []), [allSections, meeting]);
  const [screen, setScreenState] = useState<"report" | "meeting">("report");
  const inMeetingView = screen === "meeting" && agendaList.length > 0;
  // A phone folds the toolbar to two rows: the Report / Meeting switch goes in More.
  const phone = useIsMobile();
  const sections = inMeetingView ? agendaList : reportSections;
  const [showSecs, setShowSecs] = useState(false);

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
  const [presenting, setPresenting] = useState<number | null>(presentOnOpen ? 0 : null);
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
    const { shift: sh, next } = report;
    const hourlyList = sheet.hourly ? (() => {
            const h = sheet.hourly;
            const hr = hourlyRows(h.notes, h.slots, h.upTo, h.entries, tz, { ...h.meet, closes: h.closes });
            const cl = slotClocks(hr.map((r) => r.slot), tz);
            return hr.map((r, i) => {
              const m = r.slot.kind === "meeting" ? h.meet?.start : r.slot.kind === "handover" ? h.meet?.end : undefined;
              // A meeting in the hours: on site and the safety topic (its table is its own section).
              const brief = (p: MeetingParts) => [...(p.rows.some((x) => !x.plant && x.onSite != null) ? [`On the job: ${p.rows.reduce((a, x) => a + (x.plant ? 0 : x.onSite ?? 0), 0)}`] : []), ...(p.safety ? [`Safety topic: ${p.safety}`] : [])];
              if (r.slot.kind === "overtime") return { clock: cl[i], kind: r.slot.kind, title: r.slot.label ?? "Overtime", text: "" };
              return { clock: cl[i], kind: r.slot.kind, ...(m ? { title: m.title } : {}), text: m ? (m.parts ? brief(m.parts) : m.lines).join("\n") : r.slot.kind === "break" ? breakLabel(r.slot) : plainLine(r.text), progress: r.progress.map(plainLine), closed: r.closed.map(plainLine) };
            });
          })() : [];
    const kind = meeting === "kickoff" ? "Kick-off meeting" : meeting === "closeout" ? "Close-out meeting" : `Shift turnover${crew ? ` - ${crew}` : ""}`;
    const when = meeting === "turnover"
      ? `${shiftName(sh)} ${ctx.D(sh.start)} ${ctx.win(sh)} → ${shiftName(next)} ${ctx.D(next.start)} ${ctx.win(next)}`
      : meeting === "kickoff"
        ? (kickoff.start != null ? `Job starts ${ctx.DL(kickoff.start)} ${ctx.T(kickoff.start)} · ${kickoff.daysTotal} days` : "No dated work yet")
        : (closeout.finish != null ? `Planned finish ${ctx.DT(closeout.finish)}` : "");
    const status: ExportDoc["status"] = meeting === "kickoff" ? undefined
      : meeting === "closeout"
        ? (unscheduled.length ? { label: `${unscheduled.map((p) => p.name).join(", ").toUpperCase()} NOT SCHEDULED`, tone: "amber" }
          : closeout.done >= closeout.steps ? { label: "COMPLETE", tone: "emerald" } : { label: `${closeout.steps - closeout.done} OPEN`, tone: "amber" })
        // One sentence and its number, the same as Where we stand on screen:
        // a phase that finished late says so, never "on track".
        : { label: say.label, tone: say.tone, key: say.key, detail: say.text };
    // Who is on site, in one line up top (the names go at the end): the
    // counts entered at this shift's meeting, plant staff not counted.
    const counts = meetingParts(sheet.recThis, view.shift.start).rows.filter((x) => !x.plant && x.onSite != null).map((x) => ({ crew: x.crew, n: x.onSite! }));
    // The plant's required format (lib/shiftForm): the shift's own record
    // and what the report has planned and done, by crew.
    const formOf = (): ExportDoc["form"] => {
      const w = view.shift;
      const parts = meetingParts(sheet.recThis, w.start);
      const tagOf = (r: ShiftRow) => { const t = rowTask(r); const name = (t?.name ?? r.parentName ?? "").trim(); return leadTag(name) ?? name; };
      // A step goes on its equipment's line ("E-32 – Set Blinds, Pull
      // Bundle"); one that names its own (PSV-209 - …) is its own line.
      const item = (r: ShiftRow, extra?: string) => {
        const nm = r.leaf.name.trim();
        const tag = leadTag(nm) || selfNamed(nm) ? "" : tagOf(r);
        const plain = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
        const text = extra ? `${nm} ${extra}` : nm;
        return tag && !plain(nm).includes(plain(tag)) ? { group: tag, text } : { text };
      };
      const crewOf = (r: ShiftRow) => r.leaf.actualParty?.trim() || r.leaf.responsibleParty?.trim() || "Other";
      const doneIds = new Set(view.review.done.map((r) => r.leaf.id));
      // The meeting hands over the work still to do: a step already
      // finished before it (done last night, entered this morning) isn't.
      const meetAt = w.start - meetingLeadMin(times) * 60_000;
      const doneBeforeMeeting = (r: ShiftRow) => r.leaf.status === "completed" && Number.isFinite(Date.parse(String(r.leaf.actualAt ?? ""))) && Date.parse(String(r.leaf.actualAt)) < meetAt;
      // Started this shift and no % yet: it's still work done on the shift.
      const progressedIds = new Set(view.review.progressed.map((r) => r.leaf.id));
      const startedHere = view.review.inProgress.filter((r) => {
        if (doneIds.has(r.leaf.id) || progressedIds.has(r.leaf.id)) return false;
        const a = Date.parse(String(r.leaf.actualStartAt ?? ""));
        return Number.isFinite(a) && a >= meetAt && a < w.end;
      });
      // The plant's table in the update's order, with short row names (lib/reportExport).
      return managementForm(shiftForm({
        project: projectName ?? "Schedule",
        date: fmtInTz(w.start, tz, { month: "long", day: "numeric", year: "numeric" }), start: ctx.T(w.start), end: ctx.T(w.end),
        weekday: fmtInTz(w.start, tz, { weekday: "long" }), shift: w.kind === "night" ? "Night shift" : "Day shift",
        // As of: the time, and the date only when it's another day.
        asOf: `${fmtInTz(asOf, tz, { year: "numeric", month: "numeric", day: "numeric" }) === fmtInTz(w.start, tz, { year: "numeric", month: "numeric", day: "numeric" }) ? ctx.T(asOf) : ctx.DT(asOf)}${rehearsal ? " · rehearsal - shift not started" : historyNote ? ` · ${historyNote}` : ""}`,
        meeting: ctx.T(w.start - meetingLeadMin(times) * 60_000),
        attendees: parts.rows.map((x) => ({ crew: x.crew, names: x.attendees })),
        incidents: sheet.incidents && (sheet.incidents.none || sheet.incidents.items?.length)
          ? { none: !!sheet.incidents.none, items: (sheet.incidents.items ?? []).map((x) => ({ kind: x.kind, text: x.text, time: ctx.T(x.at) })) } : undefined,
        safetyTopic: parts.safety,
        // The plan set for this shift (at its meeting), else the schedule's.
        planned: (view.review.plan
          ? (() => { const p = view.review.plan!; const rows = [...p.done, ...p.moved, ...p.untouched]; const order = new Map((thisPlan?.ids ?? []).map((id, i) => [id, i])); return rows.sort((a, b) => (order.get(a.leaf.id ?? "") ?? 0) - (order.get(b.leaf.id ?? "") ?? 0)); })()
          : view.review.scheduled.filter((r) => !doneBeforeMeeting(r))).map((r) => ({ crew: r.leaf.responsibleParty?.trim() || "Other", ...item(r) })),
        completed: [
          ...view.review.done.map((r) => ({ crew: crewOf(r), ...item(r) })),
          ...view.review.progressed.filter((r) => !doneIds.has(r.leaf.id)).map((r) => ({ crew: crewOf(r), ...item(r, r.pctStart != null ? `(${r.pctStart}% to ${r.percent}%)` : `(${r.percent}%)`) })),
          ...startedHere.map((r) => ({ crew: crewOf(r), ...item(r, "(started)") })),
        ],
        followUps: sheet.notes.filter((n) => n.followUp && !n.cleared).map((n) => n.text),
        // The waiting and ready lists, once the log is in (lib/waitingReady).
        ...(waitList ? { waiting: {
          started: waitList.waiting.map((j) => `${jobWord(j)} – ${waitWhy(j)}${j.said ? `: "${j.said}"` : ""} (${j.crew}, ${shiftsWord(j.shifts)})`),
          ready: waitList.ready.map((j) => `${jobWord(j)} – ready since ${ctx.DT(j.readyAt)}; ${readyWhy(j).charAt(0).toLowerCase()}${readyWhy(j).slice(1)} (${j.crew}, ${shiftsWord(j.shifts)})`),
          service: waitList.service.map((j) => `${jobWord(j)}${j.said ? `: "${j.said}"` : ""} (${j.crew})`),
        } } : {}),
        // The hours, short, the way a shift writes them (lib/shiftHourly briefNotes).
        notes: sheet.hourly
          ? briefNotes(hourlyRows(sheet.hourly.notes, sheet.hourly.slots, sheet.hourly.upTo, sheet.hourly.entries, tz, { ...sheet.hourly.meet, closes: sheet.hourly.closes }), sheet.hourly.entries, sheet.hourly.slots, tz)
          : [],
        headcount: counts,
      }), { meeting: ctx.T(meetAt), end: ctx.T(w.end) });
    };
    const formCheck = meeting === "turnover" ? [
      ...(sheet.carriedThis ? [`Attendees and head count are carried from the ${sheet.carriedThis.label}: update them on the Meeting before you send.`] : []),
      ...(!sheet.incidents || !(sheet.incidents.none || sheet.incidents.items?.length) ? ["Incidents aren't entered for this shift: mark none, or add them, in Safety."] : []),
    ] : [];
    const doc: ExportDoc = {
      ...(meeting === "turnover" ? { form: formOf(), formCheck } : {}),
      kind, project: projectName ?? "Schedule", when,
      asOf: `${ctx.DT(meeting === "turnover" ? asOf : now)} ${tzAbbrev(ctx.tz, now)}${meeting === "turnover" && rehearsal ? " · rehearsal - shift not started" : meeting === "turnover" && historyNote ? ` · ${historyNote}` : ""}`,
      status,
      // The update management reads, not the meeting's agenda: short
      // tables, one line per main task, and nothing that's empty.
      sections: meeting === "turnover"
        ? withWaiting(turnoverUpdate(view, { D: ctx.D, DTs: ctx.DTs, T: ctx.T, win: ctx.win, hrs: ctx.hrs, word: ctx.word }, {
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
          plan: nextPlan,
          after: afterReport ? { report: afterReport, plan: afterPlan } : undefined,
          safetyProject: safety.project,
          safetyRecent: safety.recent,
          showTimes: stamps, timeOf, taskPct, whyOf,
          crewsThis: sheet.crewsThis, crewsNext: sheet.crewsNext,
          incidents: sheet.incidents && (sheet.incidents.none || sheet.incidents.items?.length) ? { none: !!sheet.incidents.none, items: sheet.incidents.items ?? [] } : undefined,
          shiftNotes: sheet.notes.map((n) => ({ at: n.at, text: n.text, followUp: n.followUp, from: n.from })),
          hourly: hourlyList,
          meetings: sheet.hourly ? (() => {
            const h = sheet.hourly;
            const hr = hourlyRows(h.notes, h.slots, h.upTo, h.entries, tz, { ...h.meet, closes: h.closes });
            const cl = slotClocks(hr.map((r) => r.slot), tz);
            return hr.flatMap((r, i) => {
              const m = r.slot.kind === "meeting" ? h.meet?.start : r.slot.kind === "handover" ? h.meet?.end : undefined;
              return m?.parts && !meetingEmpty(m.parts) ? [{ clock: cl[i], title: m.title, parts: m.parts, ...(m.carried ? { carried: m.carried } : {}) }] : [];
            });
          })() : [],
          order: sheet.order,
          forecast,
          standPhase: standPhase?.name,
          discovery: discoveryList,
          why,
        }), waitList ? waitingExport(waitList, view.shift, ctx) : null)
        : withoutEmpty(allSections.filter((x) => x.data).map((x) => ({ id: x.id, title: x.title, sub: x.sub, flag: x.flag ?? null, blocks: x.data!() }))),
    };
    // The close-out as it prints and goes out from Reports too: where the
    // time went under the opening tiles, repeats counted, long notes under
    // their rows (lib/phaseReport).
    if (meeting === "closeout") return closeoutPrint(doc);
    if (meeting !== "turnover") return doc;
    // What management reads: the status sentence and the head count first,
    // then done, the next shift, problems and follow-ups, safety, and the
    // people last; short titles with each shift's times beside them.
    const after = afterReport?.next;
    return forManagement({ ...doc, ...(headcountLine(counts) ? { headcount: headcountLine(counts) } : {}) }, {
      done: `${shiftName(sh)} ${ctx.D(sh.start)} ${ctx.win(sh)}`,
      next: `${shiftName(next)} ${ctx.D(next.start)} ${ctx.win(next)}`,
      ...(after ? { after: `${shiftName(after)} ${ctx.D(after.start)} ${ctx.win(after)}` } : {}),
    });
  };

  // Reports: the update as it goes out, each time it changes.
  const lastDoc = useRef("");
  useEffect(() => {
    if (!onDoc) return;
    const d = exportDoc();
    const k = JSON.stringify(d);
    if (k !== lastDoc.current) { lastDoc.current = k; onDoc(d); }
  });

  // ── Empty sections fold into one line together ("Nothing finished,
  // waiting or added this shift."), their add buttons small on that line.
  // Show opens them all; an add with nothing of its own to run opens its
  // section. Nothing is dropped: each is still in the section list.
  const [unfoldAll, setUnfoldAll] = useState(false);
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const isFolded = useCallback((x: Sec) => !!x.fold && !unfoldAll && !unfolded.has(x.id), [unfoldAll, unfolded]);
  const folded = sections.filter(isFolded);
  const firstFold = sections.findIndex(isFolded);
  const openSection = (id: string) => {
    setUnfolded((u) => new Set(u).add(id));
    requestAnimationFrame(() => refs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const foldActions = folded.flatMap((x) => (x.fold?.actions ?? []).map((a, i) => ({ ...a, key: `${x.id}:${i}`, open: () => (a.run ? a.run() : openSection(x.id)) })));
  // Each section's number on the path (and on paper); the folded ones have none.
  const numOf = new Map<string, number>();
  sections.filter((x) => !isFolded(x)).forEach((x, i) => numOf.set(x.id, i + 1));

  // ── The filters live with the steps they narrow: in the first section
  // that lists steps (Done, the next shift, the shift after), folded behind
  // one "Filter steps" line; the other step sections say what is on.
  const filtersOn = !!crew || criticalOnly || addedOnly || classOn;
  const filterWords = [crew ? `${crew} only` : null, criticalOnly ? "critical path only" : null, addedOnly ? "discovery and added only" : null, classOnly ? `${classOnly} only` : null].filter(Boolean).join(", ");
  const clearFilters = () => { setCrewPick(null); setOnlyPick({ critical: false, added: false }); setClassPick({ units: [], types: [] }); };
  const [filterOpen, setFilterOpen] = useState(false);
  const filterHost = meeting !== "turnover" ? null
    : sections.find((x) => STEP_SECTIONS.includes(x.id) && !isFolded(x))?.id ?? (filtersOn && folded.length ? "fold" : null);
  const filterBar = (
    <div className="mb-2.5 print:hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onClick={() => setFilterOpen((v) => !v)} aria-expanded={filterOpen}
          className="inline-flex items-center gap-1.5 min-h-9 pointer-coarse:min-h-11 -ml-1 px-1 rounded-md text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
          <ListFilter aria-hidden className="w-4 h-4 text-[var(--color-text-muted)]" /> Filter steps
          {filtersOn && <span className="font-normal text-[var(--color-text-muted)]">· {filterWords}</span>}
          <ChevronDown aria-hidden className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${filterOpen ? "" : "-rotate-90"}`} />
        </button>
        {filtersOn && <button type="button" onClick={clearFilters} className={LINK}>Clear</button>}
      </div>
      {filterOpen && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 ui-reveal">
          {crews.length > 1 && (
            <label className="min-w-0 max-sm:w-full flex items-center gap-2">
              <span className="shrink-0 text-body text-[var(--color-text-muted)]">Crew</span>
              <select value={crew ?? ""} onChange={(e) => setCrewPick(e.target.value || null)} aria-label="Show one crew"
                className={`${PICK} pr-7 max-sm:flex-1 ${crew ? "font-medium" : ""}`}>
                <option value="">All crews</option>
                {crews.map((x) => <option key={x.who} value={x.who}>{x.who} ({x.steps})</option>)}
              </select>
            </label>
          )}
          <div className="shrink-0 flex flex-wrap items-center gap-x-4" role="group" aria-label="Show only">
            <label className="inline-flex items-center gap-2 min-h-9 pointer-coarse:min-h-11 text-body text-[var(--color-text)] cursor-pointer select-none">
              <input type="checkbox" checked={criticalOnly} onChange={() => setOnlyPick((v) => ({ ...v, critical: !v.critical }))} className="w-4 h-4 accent-[var(--color-current)]" />
              Critical path only
            </label>
            <label className="inline-flex items-center gap-2 min-h-9 pointer-coarse:min-h-11 text-body text-[var(--color-text)] cursor-pointer select-none">
              <input type="checkbox" checked={addedOnly} onChange={() => setOnlyPick((v) => ({ ...v, added: !v.added }))} className="w-4 h-4 accent-[var(--color-current)]" />
              Discovery &amp; added only
            </label>
          </div>
          <WoClassSelects c={wc} units={classPick.units} types={classPick.types} className="max-sm:w-full"
            onUnits={(v) => setClassPick((c) => ({ ...c, units: v }))} onTypes={(v) => setClassPick((c) => ({ ...c, types: v }))} />
        </div>
      )}
    </div>
  );
  const filterNote = filtersOn ? (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 text-body text-[var(--color-text-muted)] print:hidden">
      <ListFilter aria-hidden className="w-4 h-4 shrink-0" /> <span>Showing {filterWords}.</span>
      <button type="button" onClick={clearFilters} className={LINK}>Clear</button>
    </div>
  ) : null;
  const stepTools = (id: string) => (meeting !== "turnover" ? null : id === filterHost ? filterBar : STEP_SECTIONS.includes(id) ? filterNote : null);

  // The report's lock: one phrase and one button on the line under the
  // toolbar, beside the shifts it covers (never a banner of its own).
  const lockEl = meeting === "turnover" ? (
    <ShipBar shippedAt={shippedAt} shippedBy={hand.shippedByName} canShip={canShip} busy={shipBusy} err={hand.err} label={`${fmtInTz(shift.start, tz, { weekday: "short", month: "short", day: "numeric" })} ${shift.kind} shift`}
      endedAt={now >= shift.end ? new Date(shift.end).toISOString() : null}
      tries={Object.keys(decisionsToShip(decisions, carried)).length}
      when={(iso) => `${ctx.DTs(Date.parse(iso))}`}
      onShip={() => { setShipBusy(true); void hand.ship((d) => decisionsToShip(d, carried, (hand.pullDraft ?? pullSet)?.crew ?? null), hand.pullDraft ?? pullSet, exportDoc, userName).finally(() => setShipBusy(false)); }}
      onUnship={() => { setShipBusy(true); void hand.unship().finally(() => setShipBusy(false)); }} />
  ) : null;
  const head = (print: boolean) => (
    <Masthead meeting={meeting} report={report} kickoff={kickoff} closeout={closeout} ctx={ctx} asOf={asOf} now={now}
      rehearsal={rehearsal} historyNote={historyNote} projectName={projectName} print={print} crew={crew} addedOnly={addedOnly} criticalOnly={criticalOnly} classOnly={classOnly}
      kindShown={!meetingFixed} lock={print ? undefined : lockEl} />
  );

  if (docOnly) return null;
  return (
    <ReportCrew.Provider value={crew}>
    {/* On screen, one white card on the paper; on paper, its own copy (below). */}
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
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
      {/* The few tools used every shift, labelled and in sight: which view
          (the report or the meeting), which shift, Update by note, and
          Email / Print (the one accent). Everything else is under More,
          grouped by job. On a phone, the views and the shift sit on their
          own row under the actions. */}
      <div className="px-3 sm:px-4 pt-2 pb-2 border-b border-[var(--color-border)] flex items-center gap-x-3 gap-y-2 flex-wrap rounded-t-xl bg-[var(--color-surface)]">
        {!meetingFixed && (
          <SubTabs label="Meeting" value={meeting} size="sm"
            onChange={(id) => { setMeetingPick(id); setPresenting(null); }}
            items={MEETINGS.map(({ id, label }) => ({ id, label }))} />
        )}

        {/* The report, or the meeting's agenda (attendance, the safety topic, what the next shift picks up). */}
        {meeting === "turnover" && agendaList.length > 0 && (
          <SubTabs label="Report or meeting" value={inMeetingView ? "meeting" : "report"} size="sm"
            onChange={(id) => { setScreenState(id); setPresenting(null); }}
            items={[{ id: "report" as const, label: "Report" }, { id: "meeting" as const, label: "Meeting" }]} />
        )}

        {meeting === "turnover" && (
          // Which shift: back and forward a shift at a time, or pick the day and which half.
          <div role="group" aria-label="Which shift" className="flex items-center gap-1 max-md:order-2 max-md:w-full">
            {(!meetingFixed || agendaList.length > 0) && <span aria-hidden className="max-md:hidden mr-2 w-px h-5 bg-[var(--color-border)]" />}
            <button type="button" onClick={() => pick(previousShift(shift, tz, times))} className={ARROW} title="Previous shift" aria-label="Previous shift"><ChevronLeft className="w-4 h-4" /></button>
            <select value={shift.kind} onChange={(e) => setSel({ dayKey: shift.dayKey, kind: e.target.value as "day" | "night" })}
              aria-label="Which shift hands over"
              title="Day → Night: the day shift's report and the plan for the night after it"
              className={`${PICK} pr-7 max-md:shrink-0`}>
              <option value="day">{phone ? "Day" : "Day → Night"}</option>
              <option value="night">{phone ? "Night" : "Night → Day"}</option>
            </select>
            <input type="date" value={shift.dayKey} onChange={(e) => { if (e.target.value) setSel({ dayKey: e.target.value, kind: shift.kind }); }}
              aria-label="Which day's shift" title="Which day's shift to close"
              className={`${PICK} w-[9.5rem] max-md:flex-1 max-md:w-auto max-md:min-w-[8.5rem]`} />
            <button type="button" onClick={() => pick(nextShift(shift, tz, times))} className={ARROW} title="Next shift" aria-label="Next shift"><ChevronRight className="w-4 h-4" /></button>
            {/* Back to the shift on now: only once another one is picked. */}
            {ownSel != null && <button type="button" onClick={() => setSel(null)} className={`${LINK} ml-2 max-md:hidden`}>Current shift</button>}
          </div>
        )}

        {tools}
        <div className="relative ml-auto flex flex-wrap items-center justify-end gap-2">
          <div className="contents">
            {/* The day / night split is a guess until the times are saved: said in sight, with the fix one tap away. */}
            {timesSaved === false && (
              <button type="button" onClick={() => setShowTimes((v) => !v)} aria-expanded={showTimes} title="The day / night split is a guess until the shift times are saved"
                className={`${LINK} max-md:hidden !text-[var(--state-overdue-text)]`}>
                <Settings2 className="w-4 h-4" /> Set shift times
              </button>
            )}
            {showTimes && <div className="fixed inset-0 z-20" onClick={() => setShowTimes(false)} aria-hidden />}
            {showTimes && (
              <div className="ui-float ui-float-in absolute right-0 top-full mt-1 z-30 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-2 text-body w-[24rem] max-w-[calc(100vw-1.5rem)]">
                <div className="flex items-center gap-2">
                  <h3 className="flex-1 text-reading font-medium text-[var(--color-text)]">Shift change times <span className="font-normal text-[var(--color-text-muted)]">(plant time)</span></h3>
                  <button type="button" onClick={() => setShowTimes(false)} aria-label="Close" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
                </div>
                <label className="flex items-center justify-between gap-3 text-[var(--color-text)]"><span className="inline-flex items-center gap-1.5"><Sun className="w-4 h-4 text-[var(--color-text-muted)]" /> Day starts</span>
                  <input type="time" value={draft.dayStart} onChange={(e) => { setTimesMsg(null); setTimesDraft({ ...draft, dayStart: e.target.value || DEFAULT_SHIFT_TIMES.dayStart }); }} className={`${PICK} w-32`} />
                </label>
                <label className="flex items-center justify-between gap-3 text-[var(--color-text)]"><span className="inline-flex items-center gap-1.5"><Moon className="w-4 h-4 text-[var(--color-text-muted)]" /> Night starts</span>
                  <input type="time" value={draft.nightStart} onChange={(e) => { setTimesMsg(null); setTimesDraft({ ...draft, nightStart: e.target.value || DEFAULT_SHIFT_TIMES.nightStart }); }} className={`${PICK} w-32`} />
                </label>
                <label className="flex items-center justify-between gap-3 text-[var(--color-text)]"><span>Turnover meeting, minutes before</span>
                  <input type="number" inputMode="numeric" min={0} max={180} step={5} value={meetingLeadMin(draft)} onChange={(e) => { setTimesMsg(null); setTimesDraft({ ...draft, meetingBefore: Number(e.target.value) }); }} className={`${PICK} w-20 text-right tabular-nums`} />
                </label>
                <BreaksEditor breaks={draft.breaks ?? []} times={draft} onChange={(b) => { setTimesMsg(null); setTimesDraft({ ...draft, breaks: b }); }} />
                {!timesDraft && timesSaved === false && (
                  <div className="flex justify-end pt-1">
                    <Button size="sm" variant="secondary" loading={timesSave.loading} done={timesSave.done} doneLabel="Confirmed"
                      onClick={() => void timesSave.run(() => saveProjectShiftTimes(projectId, times)).then(() => setTimesMsg("Saved for everyone on this project."), (e: Error) => setTimesMsg(sayError(e)))}>These are right: confirm</Button>
                  </div>
                )}
                {timesDraft && (
                  <div className="flex justify-end gap-2 pt-1">
                    <Button size="sm" variant="ghost" onClick={() => { setTimesDraft(null); setTimesMsg(null); }}>Cancel</Button>
                    <Button size="sm" variant="secondary" loading={timesSave.loading} onClick={() => void timesSave.run(saveTimes)}>Save for the project</Button>
                  </div>
                )}
                {timesMsg && (/^Saved for everyone/.test(timesMsg)
                  ? <p role="status" className="leading-snug text-body text-[var(--color-text)] inline-flex items-center gap-1.5"><span aria-hidden className="w-[7px] h-[7px] rounded-full bg-[var(--state-released)]" />{timesMsg}</p>
                  : <ErrorNote compact title={timesMsg} next="" />)}
              </div>
            )}
          </div>
          {!inMeetingView && <div className="contents">
            {/* Sections left off are always said, never silently gone: under
                the report (each with Show), and in More, which opens this. */}
            {showSecs && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowSecs(false)} aria-hidden />
                <div className="ui-float ui-float-in absolute right-0 top-full mt-1 z-30 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-body">
                  <h3 className="text-reading font-medium text-[var(--color-text)]">Show on the report</h3>
                  <div className="mt-2 space-y-0.5">
                    {reportAll.map((x) => (
                      <label key={x.id} className="flex items-center gap-2.5 cursor-pointer select-none min-h-9 pointer-coarse:min-h-11">
                        <input type="checkbox" className="accent-[var(--color-current)] w-4 h-4" checked={!hiddenSecs.includes(x)} onChange={(e) => setHidden(x.id, !e.target.checked)} />
                        <span className="text-[var(--color-text)]">{x.short}</span>
                      </label>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
                    <span className="text-body text-[var(--color-text-muted)] leading-snug">On screen and in print. The email has its own list.</span>
                    {hiddenSecs.length > 0 && <button type="button" onClick={() => setHidden(null, false)} className={`${LINK} shrink-0`}>Show all</button>}
                  </div>
                </div>
              </>
            )}
          </div>}
          {presenting != null && (
            <Button size="sm" variant="secondary" onClick={() => setPresenting(null)} title="Back to the report (Esc)">
              <X className="w-4 h-4" /> Leave present
            </Button>
          )}
          {meeting === "turnover" && !onOpenReport && (
            <>
              <TimeLogButton busy={logBusy} msg={logMsg} onExport={(sc) => void exportTimeLog(sc)} shiftLabel={shiftTitle} />
              <HourlyLogExport formats={["pdf", "docx"]} what={`Hourly log - ${shiftTitle}`} letterhead={!!lh} onExport={exportHourly} label="Hourly log" />
            </>
          )}
          <CopyUpdate primary={!quietMain} doc={exportDoc} meeting={meeting} lh={lh} stamps={meeting === "turnover" ? { on: stamps, set: setStamps } : undefined} />
          {/* More, grouped by job: where to go, the meeting, the shift's
              other reports, what the report shows, then setup. */}
          <MoreMenu label="More" triggerClass={`${QUIET} max-sm:w-11 max-sm:px-0`} iconOnly={phone} items={[
            ...(phone && meeting === "turnover" && ownSel != null ? [{ icon: <Clock className="w-4 h-4" />, label: "Back to the current shift", onClick: () => setSel(null) }] : []),
            ...(presenting == null ? [{ icon: <Presentation className="w-4 h-4" />, label: "Present the meeting", onClick: () => setPresenting(0), line: phone && meeting === "turnover" && ownSel != null }] : []),
            { icon: <Printer className="w-4 h-4" />, label: "Print the full report", onClick: () => window.print() },
            ...(meeting === "turnover" && onOpenReport ? [
              // The shift sheet: entered for the shift ending, printed for the one starting.
              { icon: <FileText className="w-4 h-4" />, label: "Enter shift sheet", onClick: () => onOpenReport({ id: "sheet", shift: { dayKey: shift.dayKey, kind: shift.kind }, enter: true }), line: true },
              { icon: <FileText className="w-4 h-4" />, label: "Next shift's sheet", onClick: () => onOpenReport({ id: "sheet", shift: { dayKey: report.next.dayKey, kind: report.next.kind } }) },
              { icon: <FileText className="w-4 h-4" />, label: "Time log", onClick: () => onOpenReport({ id: "timelog", shift: { dayKey: shift.dayKey, kind: shift.kind }, scope: "shift" }) },
              { icon: <FileText className="w-4 h-4" />, label: "Hourly log", onClick: () => onOpenReport({ id: "hourly", shift: { dayKey: shift.dayKey, kind: shift.kind } }) },
            ] : []),
            ...(!inMeetingView ? [{ icon: <EyeOff className="w-4 h-4" />, label: hiddenSecs.length ? `Sections shown (${hiddenSecs.length} hidden)` : "Sections shown", onClick: () => setShowSecs(true), line: true }] : []),
            // The time each step was done, in Done (always in the time log).
            ...(meeting === "turnover" ? [{ icon: <Clock className="w-4 h-4" />, label: stamps ? "Done times: on" : "Done times: off", onClick: () => setStamps(!stamps), line: inMeetingView }] : []),
            { icon: <Settings2 className="w-4 h-4" />, label: timesSaved === false ? "Set shift times" : "Shift times", onClick: () => setShowTimes(true), line: true, ...(timesSaved === false ? { tone: "bad" as const } : {}) },
            // Which jobs run days and nights: what the next shift's list follows.
            ...(meeting === "turnover" && onOpenReport ? [{ icon: <Moon className="w-4 h-4" />, label: "Night shifts", onClick: () => { window.dispatchEvent(new CustomEvent(OPEN_SETUP_EVENT, { detail: "night" })); } }] : []),
          ]} />
        </div>
      </div>
      {notice && <div className="px-4 sm:px-5 border-b border-[var(--color-border)]">{notice}</div>}
      {meeting === "turnover" && planOpen && planBase && (
        <ShiftPlanPicker next={planFor === "after" ? afterWin : planFor === "this" ? shift : report.next} groups={planGroups} pool={planPool} byId={byId} plan={planFor === "after" ? afterPlan : planFor === "this" ? thisPlan : nextPlan}
          locked={!canShip || !!shippedAt} fmt={{ D: ctx.D, T: ctx.T, DTs: ctx.DTs }} by={userName ?? null}
          onSave={(p) => savePlan(p, planFor === "after" ? afterKey : planFor === "this" ? thisKey : nextKey)} onRemove={() => savePlan(undefined, planFor === "after" ? afterKey : planFor === "this" ? thisKey : nextKey)} onClose={() => setPlanFor(null)} />
      )}
      {meeting === "turnover" && pickerOpen && (
        <PullAheadPicker items={lookAhead} next={report.next} shiftHours={(report.next.end - report.next.start) / 3_600_000}
          onLists={[
            ...report.goals.all.map((row) => ({ row, where: `on the ${report.next.kind} shift's list` })),
            ...report.goals.otherShift.map((row) => ({ row, where: `carries to the ${report.next.kind === "day" ? "night" : "day"} shift` })),
            ...report.goals.movedOff.map((row) => ({ row, where: `carries to the ${report.next.kind === "day" ? "night" : "day"} shift` })),
            ...report.goals.paused.map((row) => ({ row, where: "under way - the other crew's" })),
          ]}
          picked={report.goals.pulled}
          counted={[...carried.filter((r) => r.leaf.id && decisions[r.leaf.id]?.tryIt && !report.goals.pulled.includes(r)), ...report.goals.pulled]}
          pull={pullShown} sizeSet={!!pullForReport} crews={allCrews} fmt={{ D: ctx.D, T: ctx.T }} locked={!!shippedAt || !canShip}
          onToggle={togglePull} onPull={hand.setPull}
          onSaveDefault={(p) => saveProjectShiftTimes(projectId, { ...times, helpers: p })}
          onClose={() => setPickerOpen(false)} />
      )}
      {recFail && (
        <div className="px-4 sm:px-5 py-2.5 border-b border-[var(--color-border)]">
          <ErrorNote compact title="Didn't save to the shift's record." next={recFail.msg} onRetry={recFail.retry} />
        </div>
      )}
      {head(false)}

      {/* ── Sections: a compact list that stays on screen ─────────────── */}
      {/* Narrow screens: one row that scrolls sideways (the next name shows
          in part) and stays at the top while the report scrolls, with step
          look-up at its end. Wide screens: a column beside the report. */}
      <div className="xl:hidden sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur pl-2 pr-2 sm:pl-3 py-1 flex items-center gap-2">
        <SectionNav sections={sections} current={presenting} folded={isFolded} onGo={goTo} />
        {meeting === "turnover" && <TaskSearch idx={qlIndex} fmt={ctx} onPick={openLook} compact />}
      </div>

      {/* ── Screen body ─────────────────────────────────────────────── */}
      {addAt != null && onDiscovery && (
        <AddWorkPicker day={toDateTimeInput(addAt, tz)} tz={tz} milestones={live}
          onPick={(t) => { const at = toDateTimeInput(addAt, tz); setAddAt(null); onDiscovery(t, at); }}
          onNew={onNewWorkOrder ? () => { const at = toDateTimeInput(addAt, tz); setAddAt(null); onNewWorkOrder(at); } : undefined}
          onClose={() => setAddAt(null)} />
      )}
      <div className="xl:grid xl:grid-cols-[11rem_minmax(0,1fr)]">
        <div className="hidden xl:block border-r border-[var(--color-border)]">
          <div className="sticky top-0 max-h-dvh overflow-y-auto px-2 py-3 space-y-2">
            {meeting === "turnover" && <TaskSearch idx={qlIndex} fmt={ctx} onPick={openLook} />}
            <SectionNav sections={sections} current={presenting} folded={isFolded} onGo={goTo} vertical />
          </div>
        </div>
        <div className="min-w-0">
      <QuickLookOpen.Provider value={openLook}>
      {presenting != null && sections[presenting] ? (
        <div className="px-6 py-5 min-h-[420px] text-body">
          <SectionHead n={presenting + 1} s={sections[presenting]} big />
          <div className="mt-3">{sections[presenting].body(false)}</div>
          <div className="mt-6 flex items-center justify-between no-print">
            <button disabled={presenting === 0} onClick={() => setPresenting(presenting - 1)} className={`${QUIET} disabled:opacity-30`}>
              <ChevronLeft className="w-4 h-4" /> {presenting > 0 ? sections[presenting - 1].short : "Back"}
            </button>
            <span className="text-caption text-[var(--color-text-muted)] tabular-nums">{presenting + 1} of {sections.length} · ← → to move · Esc to leave</span>
            <button disabled={presenting === sections.length - 1} onClick={() => setPresenting(presenting + 1)} className={`${QUIET} disabled:opacity-30`}>
              {presenting < sections.length - 1 ? sections[presenting + 1].short : "Done"} <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="px-3 sm:px-5 pt-4 pb-4 text-body text-[var(--color-text)]">
          {/* The report's sections in order, joined by one line down the
              left: a sequence reads as one path. A flagged one's number is
              in its colour. The empty ones are one line, where the first
              of them was. */}
          <ol>
          {(() => {
            const rows = sections.flatMap((x, i) => (isFolded(x) ? (i === firstFold ? [null] : []) : [x]));
            return rows.map((s, j) => {
              const last = j === rows.length - 1;
              const rail = !last && <span className="flex-1 w-0.5 mt-1 bg-[var(--color-border-strong)]" />;
              if (!s) return (
                <li key="fold" className="flex gap-2.5 sm:gap-4">
                  <div aria-hidden className="flex flex-col items-center shrink-0 w-6">
                    <span className="mt-1.5 w-2.5 h-2.5 rounded-full bg-[var(--color-surface)] ring-1 ring-inset ring-[var(--color-border-strong)]" />
                    {rail}
                  </div>
                  <div ref={(el) => { for (const f of folded) { if (el) refs.current.set(f.id, el); else refs.current.delete(f.id); } }}
                    className={`min-w-0 flex-1 scroll-mt-28 ${last ? "" : "pb-6"}`}>
                    {filterHost === "fold" && filterBar}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="text-body text-[var(--color-text-muted)]">{foldSentence(folded)}</span>
                      {foldActions.map((x) => (
                        <button key={x.key} type="button" onClick={x.open} className={SMALL}>
                          {x.icon === "jump" ? <FastForward aria-hidden className="w-3.5 h-3.5" /> : x.icon === "plan" ? <ListChecks aria-hidden className="w-3.5 h-3.5" /> : <Plus aria-hidden className="w-3.5 h-3.5" />} {x.label}
                        </button>
                      ))}
                      <button type="button" onClick={() => setUnfoldAll(true)} className={LINK} aria-label={`Show ${folded.map((f) => f.short).join(", ")}`}>Show</button>
                    </div>
                  </div>
                </li>
              );
              const isCollapsed = collapsed.has(s.id);
              const flagged = s.flag === "rose" || s.flag === "amber";
              // The number in a hairline ring; a flagged one's number and ring in its color (never a filled disc).
              const dot = s.flag === "rose" ? "bg-[var(--color-surface)] text-[var(--state-overdue-text)] ring-[1.5px] ring-inset ring-[var(--state-overdue)]" : s.flag === "amber" ? "bg-[var(--color-surface)] text-[var(--state-held-text)] ring-[1.5px] ring-inset ring-[var(--state-held)]" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] ring-1 ring-inset ring-[var(--color-border-strong)]";
              return (
                <li key={s.id} className="flex gap-2.5 sm:gap-4">
                  <div aria-hidden className="flex flex-col items-center shrink-0 w-6">
                    <span className={`w-6 h-6 rounded-full font-display tabular-nums text-body font-semibold flex items-center justify-center ${dot}`} title={flagged ? (s.flag === "rose" ? "Needs attention" : "Waiting") : undefined}>{numOf.get(s.id)}</span>
                    {rail}
                  </div>
                  <section ref={(el) => { if (el) refs.current.set(s.id, el); else refs.current.delete(s.id); }} className={`min-w-0 flex-1 scroll-mt-28 ${last ? "" : "pb-6"}`}>
                    <SectionHead n={numOf.get(s.id) ?? 0} s={s} collapsed={isCollapsed} onPath
                      onToggle={() => setCollapsed((c) => { const n = new Set(c); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
                    {!isCollapsed && <div className="mt-2.5">{stepTools(s.id)}{s.body(false)}</div>}
                  </section>
                </li>
              );
            });
          })()}
          </ol>
          {(unfoldAll || unfolded.size > 0) && sections.some((x) => x.fold) && (
            <button type="button" onClick={() => { setUnfoldAll(false); setUnfolded(new Set()); }} className={`${LINK} mt-1 print:hidden`}>Fold the empty sections into one line</button>
          )}
          {hiddenSecs.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--color-border)] pt-3 text-caption text-[var(--color-text-muted)] print:hidden">
              <EyeOff className="w-3.5 h-3.5" /> Hidden:
              {hiddenSecs.map((x) => (
                <button key={x.id} type="button" onClick={() => setHidden(x.id, false)} title="Show it again"
                  className="inline-flex items-center gap-1 h-8 pointer-coarse:h-11 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                  {x.short} <Eye className="inline w-3 h-3 -mt-px" />
                </button>
              ))}
              <button type="button" onClick={() => setHidden(null, false)} className="ml-auto text-body text-[var(--color-accent-text)] hover:underline">Show all</button>
            </div>
          )}
          <Footnote meeting={meeting} ctx={ctx} asOf={asOf} now={now} projectName={projectName} />
        </div>
      )}
      </QuickLookOpen.Provider>
        </div>
      </div>
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
            const safetyAt = sections.findIndex((s) => s.id === "topics");
            const body = (
              <>
                {head(true)}
                <div style={{ padding: "4px 0" }}>
                  {sections.map((s, i) => (i === safetyAt ? null : isFolded(s) ? (i === firstFold ? (
                    // The empty sections, as on screen: one line.
                    <p key="fold" style={{ marginTop: 10 }} className="text-[8pt] text-slate-600">{foldSentence(folded)}</p>
                  ) : null) : (
                    <section key={s.id} style={{ marginTop: 10 }}>
                      <div className="sec-head"><SectionHead n={numOf.get(s.id) ?? i + 1} s={s} print /></div>
                      <div style={{ marginTop: 4 }}>{s.body(true)}</div>
                    </section>
                  )))}
                  <Footnote meeting={meeting} ctx={ctx} asOf={asOf} now={now} projectName={projectName} />
                </div>
                {safetyAt >= 0 && (
                  <section style={{ breakBefore: "page" }}>
                    <div className="sec-head">
                      <div className="text-[8pt] text-slate-500">{projectName ?? "Schedule"} · shift turnover</div>
                      <div style={{ marginTop: 2 }}><SectionHead n={numOf.get(sections[safetyAt].id) ?? safetyAt + 1} s={sections[safetyAt]} print /></div>
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
  // Escape closes this sheet, not the screen under it.
  useEscapeClose(onClose);
  const step = milestones.find((m) => m.id === id);
  if (!step) return null;
  const parent = step.parentId ? milestones.find((m) => m.id === step.parentId) : undefined;
  const parents = new Set(milestones.map((m) => m.parentId).filter(Boolean));
  const others = parent ? milestones.filter((m) => m.parentId === parent.id && m.id !== id && m.id && !parents.has(m.id)) : [];
  const label = `${shift.kind === "day" ? "Day shift" : "Night shift"} ${fmtInTz(shift.start, tz, { weekday: "short", month: "short", day: "numeric" })}`;
  return (
    <div className="fixed inset-0 z-[180] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] print:hidden" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Update ${step.name}`} onClick={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-16 -translate-x-1/2 w-[440px] max-w-[94vw] max-h-[82dvh] overflow-y-auto rounded-2xl bg-[var(--color-surface)] text-[var(--color-text)] shadow-[var(--shadow-card)] max-sm:left-0 max-sm:right-0 max-sm:top-auto max-sm:bottom-0 max-sm:translate-x-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:max-h-[88dvh]">
        <CalendarQuickView key={id} task={parent ?? step} onDay={[step]} others={others} dayKey={shift.dayKey} band={shift.kind} dayLabel={label}
          tz={tz} times={times} progress={progress} planNow={planNow} canEdit={canEdit} onUpdate={onUpdate} onFixTimes={onFixTimes} marks={marks} onClose={onClose} />
      </div>
    </div>
  );
}

// ─── Copy ────────────────────────────────────────────────────────────

/** Rich copy: HTML for an email body, plain text alongside for anything
 *  that can't take HTML. Falls back to copying a selection where the
 *  clipboard API can't write HTML. */

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.cssText = "position:fixed;left:-10000px;top:0;";
  document.body.appendChild(ta); ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

/** A button that opens a report in Reports, set to what's on screen. */
function OpenReportButton({ label, onClick, title }: { label: string; onClick: () => void; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title ?? `Open the ${label.toLowerCase()} in Reports, set to this shift`}
      className="inline-flex items-center gap-1.5 text-caption font-medium px-3 py-1.5 pointer-coarse:min-h-11 rounded-lg border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
      <FileText className="w-3.5 h-3.5" /> {label}
    </button>
  );
}

/** Copy — the update as it will be sent, with a box per section to leave
 *  one out today (remembered for next time), then copy it for an email
 *  (tables and colors kept in Outlook, Gmail…) or as plain text. */
function CopyUpdate({ doc, meeting, lh, stamps, primary }: { primary?: boolean; doc: () => ExportDoc; meeting: MeetingKind; lh?: Letterhead | null;
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
  const [done, setDone] = useState<{ what: "email" | "text" | "word"; ok: boolean } | null>(null);
  const open = () => {
    // A section that's flagged today (blocked work, things behind) is always
    // ticked when the box opens: unticking it once must not hide tomorrow's
    // problems from management. So is Where we stand (lib/updatePrint).
    setOff(sectionsOff(doc(), meeting)); setDone(null); setIsOpen(true);
  };
  const toggle = (id: string) => setOff((cur) => {
    const n = new Set(cur);
    if (n.has(id)) n.delete(id); else n.add(id);
    const byDefault = new Set((d?.sections ?? []).filter((x) => x.offByDefault).map((x) => x.id ?? x.title));
    try {
      localStorage.setItem(scopedKey(key), JSON.stringify([...n].filter((x) => !byDefault.has(x))));
      // Keep a choice for a section that isn't in today's update (no safety focus today).
      const before = (JSON.parse(readRaw(onKey) ?? "[]") as string[]).filter((x) => !byDefault.has(x));
      localStorage.setItem(scopedKey(onKey), JSON.stringify([...before, ...[...byDefault].filter((x) => !n.has(x))]));
    } catch { /* ignore */ }
    return n;
  });
  const idOf = (s: ExportDoc["sections"][number]) => s.id ?? s.title;
  const picked = d ? { ...d, sections: d.sections.filter((s) => !off.has(idOf(s))) } : null;
  // The plant's required table (with the header pieces picked), or the
  // detailed update: remembered on this device, and Print, Copy and the
  // Word file all follow it.
  const [format, setFormatState] = useState<SendFormat>(() => (typeof window === "undefined" ? "form" : readFormat()));
  const [headerOff, setHeaderOff] = useState<Set<HeaderPart>>(() => (typeof window === "undefined" ? new Set() : readHeaderOff()));
  const [formOff, setFormOff] = useState<Set<FormRowId>>(() => (typeof window === "undefined" ? new Set() : readFormOff()));
  const setFormat = (f: SendFormat) => { setFormatState(f); saveChoice(FORMAT_KEY, f); };
  const flip = <T extends string>(set: (fn: (s: Set<T>) => Set<T>) => void, key: string, id: T) => set((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); saveList(key, n); return n; });
  const useForm = !!d?.form && format === "form";
  const out = picked ? sendParts(picked, { format, headerOff, formOff }) : null;
  // The ticks, folded: how many pieces go out, of how many.
  const [secsOpen, setSecsOpen] = useState(false);
  const html = out?.html ?? "";
  const subject = d ? updateSubject(d) : "";
  // The header pieces this update has.
  const hasStand = !!d?.sections.some((s) => s.id === "stand");
  const parts = HEADER_PARTS.filter((p) => (p.id === "status" ? !!d?.status : p.id === "headcount" ? !!d?.headcount : ["standLine", "complete", "plan", "gap", "steps", "bars"].includes(p.id) ? hasStand : true));
  const secsAll = useForm ? parts.length + FORM_ROWS.length : (d?.sections.length ?? 0);
  const secsOn = useForm ? parts.filter((p) => !headerOff.has(p.id)).length + FORM_ROWS.filter((r) => !formOff.has(r.id)).length
    : (d?.sections ?? []).filter((x) => !off.has(idOf(x))).length;

  // Print what goes in the email — the safety topics on a page of their
  // own at the end, on the company letterhead when there is one.
  const printIt = () => {
    if (!picked || !printHtml(useForm ? sendPrintDocument(picked, lh ?? null, { format, headerOff, formOff }) : updatePrintDocument(picked, lh ?? null))) setDone({ what: "text", ok: false });
  };

  const run = async (what: "email" | "text") => {
    if (!picked || !out) return;
    const ok = what === "email" ? await copyRich(out.html, out.text) : await copyText(out.text);
    setDone({ what, ok });
  };
  const [wordBusy, setWordBusy] = useState(false);
  const word = async () => {
    if (!picked) return;
    setWordBusy(true);
    try { saveFile(await updateDocx(picked, { headerOff, formOff }), updateFileName(picked)); setDone({ what: "word", ok: true }); }
    catch { setDone({ what: "word", ok: false }); }
    finally { setWordBusy(false); }
  };

  return (
    <>
      <Button size="sm" variant={primary ? "primary" : "secondary"} onClick={open} className={primary ? "!h-9 pointer-coarse:!h-11 !text-body" : "!h-9 pointer-coarse:!h-11 !text-body"}
        title="The short update: copy it into an email, or print it. You see it first.">
        <Mail className="w-4 h-4" /> Email / Print
      </Button>
      {d && picked && (
        <Modal onClose={() => setIsOpen(false)} size="xl">
          <ModalHeader icon={Mail} title="Email or print the update" subtitle="What you'll send or print. Pick what goes in under Sections: it's kept for next time." onClose={() => setIsOpen(false)} />
          <ModalBody className="space-y-3">
            {d.form && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body" role="radiogroup" aria-label="Format">
                <span className="text-body font-medium text-[var(--color-text-muted)]">Format</span>
                {([["form", "Required (shift table)"], ["detail", "Detailed"]] as const).map(([k, l]) => (
                  <label key={k} className={`inline-flex items-center gap-2 min-h-9 pointer-coarse:min-h-11 cursor-pointer select-none ${format === k ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                    <input type="radio" name="update-format" checked={format === k} onChange={() => setFormat(k)} className="w-4 h-4 accent-[var(--color-current)]" />{l}
                  </label>
                ))}
              </div>
            )}
            {/* What goes in: every piece still a tick away, folded behind one
                Sections line that says how many are on. Remembered on this
                device as before, for Print, Copy and the Word file alike. */}
            <div>
              <button type="button" onClick={() => setSecsOpen((v) => !v)} aria-expanded={secsOpen}
                className="inline-flex items-center gap-1.5 min-h-9 pointer-coarse:min-h-11 -ml-1 px-1 rounded-md text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                <ChevronRight aria-hidden className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${secsOpen ? "rotate-90" : ""}`} />
                Sections
                <span className="font-normal text-[var(--color-text-muted)]">· {secsOn} of {secsAll} on</span>
              </button>
              {secsOpen && (useForm ? (
                <div className="mt-2 space-y-2 ui-reveal">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-body">
                    <span className="font-medium text-[var(--color-text-muted)]">Header</span>
                    {parts.map((p) => (
                      <label key={p.id} className="inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer select-none">
                        <input type="checkbox" className="w-4 h-4 accent-[var(--color-main)]" checked={!headerOff.has(p.id)} onChange={() => flip(setHeaderOff, HEADER_OFF_KEY, p.id)} />
                        <span className="text-[var(--color-text)]">{p.word}</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-body">
                    <span className="font-medium text-[var(--color-text-muted)]">Table</span>
                    {FORM_ROWS.map((r) => (
                      <label key={r.id} className="inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer select-none">
                        <input type="checkbox" className="w-4 h-4 accent-[var(--color-main)]" checked={!formOff.has(r.id)} onChange={() => flip(setFormOff, FORM_OFF_KEY, r.id)} />
                        <span className="text-[var(--color-text)]">{d.form?.rows.find((x) => x.id === r.id)?.label ?? r.word}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-body ui-reveal">
                  {d.sections.map((s) => (
                    <label key={idOf(s)} className="inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer select-none">
                      <input type="checkbox" className="w-4 h-4 accent-[var(--color-main)]" checked={!off.has(idOf(s))} onChange={() => toggle(idOf(s))} />
                      <span className="text-[var(--color-text)]">{s.title.split(" - ")[0]}</span>
                    </label>
                  ))}
                  {stamps && (
                    <label className="inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer select-none border-l border-[var(--color-border)] pl-3" title="The time each step was done, in Done - the time log has them all">
                      <input type="checkbox" className="w-4 h-4 accent-[var(--color-main)]" checked={stamps.on} onChange={() => stamps.set(!stamps.on)} />
                      <span className="text-[var(--color-text)]">Times in Done</span>
                    </label>
                  )}
                </div>
              ))}
            </div>
            {useForm && (d.formCheck?.length ?? 0) > 0 && (
              <ul className="border-l-2 border-[var(--state-held)] py-0.5 text-caption font-medium text-[var(--state-held-text)] list-disc pl-7">
                {d.formCheck!.map((c) => <li key={c}>{c}</li>)}
              </ul>
            )}
            <div className="rounded-lg border border-[var(--color-border)] bg-white p-4 max-h-[58vh] overflow-y-auto">
              {/* The email body itself — escaped text in inline-styled tables. */}
              <div dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          </ModalBody>
          <ModalFooter className="flex-wrap">
            {done && (
              <span role="status" className="w-full sm:w-auto mr-auto text-body text-[var(--color-text)]">
                {!done.ok ? <ErrorNote compact title={done.what === "word" ? "Couldn't make the Word file." : "Your browser blocked the copy."} next="Try again." />
                  : done.what === "word" ? "Word file saved." : done.what === "email"
                  ? <>Paste it into your email (Ctrl+V). <a className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2" href={`mailto:?subject=${encodeURIComponent(subject)}`}>New email with the subject</a>
                    {/* New Outlook can be set to "merge formatting" for pastes from other apps, which drops the sizes and colors. */}
                    <span className="block text-caption text-[var(--color-text-muted)] mt-0.5">Sizes and colors gone in Outlook? Settings, Mail, Compose and reply: set Pasting from other apps to Keep source formatting.</span></>
                  : "Paste it anywhere (Ctrl+V)."}
              </span>
            )}
            <Button variant="secondary" onClick={printIt} className="flex-1 sm:flex-none min-w-[calc(50%-0.25rem)] sm:min-w-0">
              <Printer className="w-4 h-4" /> Print
            </Button>
            <Button variant="secondary" onClick={() => void run("text")} done={done?.what === "text" && done.ok} doneLabel="Copied" className="flex-1 sm:flex-none min-w-[calc(50%-0.25rem)] sm:min-w-0">
              <FileText className="w-4 h-4" /> Copy as text
            </Button>
            {useForm && (
              <Button variant="secondary" onClick={() => void word()} loading={wordBusy} done={done?.what === "word" && done.ok} doneLabel="Saved" className="flex-1 sm:flex-none min-w-[calc(50%-0.25rem)] sm:min-w-0">
                <FileText className="w-4 h-4" /> Export Word
              </Button>
            )}
            <Button onClick={() => void run("email")} done={done?.what === "email" && done.ok} doneLabel="Copied" className="flex-1 sm:flex-none min-w-[calc(50%-0.25rem)] sm:min-w-0">
              <Mail className="w-4 h-4" /> Copy for email
            </Button>
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
  /** What kind of project it is, in a sentence ("turnaround"; lib/projectType). */
  word: string;
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

function makeCtx(tz: string, byId: Map<string, Milestone>, progress?: Map<string, ProgressInfo>, planOf?: Map<string, number>, word = "turnaround"): Ctx {
  const D = (ms: number) => fmtInTz(ms, tz, { weekday: "short", month: "short", day: "numeric" });
  const DL = (ms: number) => fmtInTz(ms, tz, { weekday: "long", month: "long", day: "numeric" });
  const T = (ms: number) => clockLabel(ms, tz) || "12:00 AM";
  const DT = (ms: number) => `${D(ms)} ${T(ms)}`;
  const day = (ms: number) => fmtInTz(ms, tz, { year: "numeric", month: "numeric", day: "numeric" });
  const DS = (ms: number) => fmtInTz(ms, tz, { month: "short", day: "numeric" });
  const DTs = (ms: number) => `${DS(ms)} ${T(ms)}`;
  const span = (a: number, b: number) => (!Number.isFinite(a) || !Number.isFinite(b) ? "-" : day(a) === day(b) ? `${DS(a)} ${T(a)}–${T(b)}` : `${DTs(a)} → ${DTs(b)}`);
  return {
    tz, D, DL, T, DT, DTs, span, word,
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

/** Where the job stands, as one sentence with its one number. */
interface StandSay {
  /** The verdict's word ("BEHIND", "FINISHED LATE"). */
  label: string;
  tone: Tone;
  /** Its one number, said big: "43.5 h", "62%". */
  key: string;
  /** The sentence: "Phase 1 finished Sat, Nov 21 1:30 AM, 43.5 h late (1.8 days)." */
  text: string;
  /** Late or behind: someone has to act on it. */
  bad: boolean;
}
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The status in the page header's words (lib/phaseStanding): finished,
 *  and how late against the plan when it finished late; past its planned
 *  finish or behind by the work-hours; on plan by the hours but a late
 *  forecast; ahead; on track. One verdict, so the header, the sentence and
 *  the line under it never say two things. */
function standSay(o: { overall: ShiftReport["overall"]; gap: number; forecast?: { finish: number; slipH: number }; work: WorkSummary; scope: string; c: Ctx; now: number }): StandSay {
  const { overall: ov, c, scope, forecast: fc } = o;
  const pct = `${ov.actualPct}% done, plan by now ${ov.plannedPct}%`;
  const slip = fc ? round1(fc.slipH) : null;
  const fcText = fc ? ` Forecast finish ${c.DT(fc.finish)}, ${lateWords(fc.slipH)}.` : "";
  if (o.work.allDone) {
    // The schedule's own forecast of finished work is its real finish
    // (the same number the line under the header gives).
    const late = slip ?? o.work.hoursAfterPlan;
    const at = fc?.finish ?? o.work.finishedAt;
    const when = at != null ? ` ${c.DT(at)}` : "";
    if (late == null) return { label: "FINISHED", tone: "slate", key: "100%", text: `${scope} finished${when}.`, bad: false };
    if (late >= 0.5) return { label: "FINISHED LATE", tone: "rose", key: `${round1(late)} h`, text: `${scope} finished${when}, ${lateWords(late)}.`, bad: true };
    if (late <= -0.5) return { label: "FINISHED EARLY", tone: "emerald", key: `${round1(-late)} h`, text: `${scope} finished${when}, ${lateWords(late)}.`, bad: false };
    return { label: "FINISHED ON TIME", tone: "emerald", key: "On time", text: `${scope} finished${when}, on time.`, bad: false };
  }
  const gap = round1(Math.abs(o.gap));
  // Past its planned finish with work still open: behind, whatever the
  // percent says (as the page header says it).
  const pastPlan = ov.plannedFinish != null && o.now > ov.plannedFinish;
  if (ov.standing === "behind" || pastPlan) {
    const left = Math.max(0, ov.stepsTotal - ov.stepsDone);
    const leftWords = `${left} step${left === 1 ? "" : "s"} left`;
    const text = pastPlan
      ? `${scope} is past its planned finish (${c.DT(ov.plannedFinish!)}), ${leftWords}: ${pct}.`
      : `${scope} is ${pct}: ${c.hrs(gap)} of work behind.`;
    // Past its planned finish, the number is how late the finish will be;
    // otherwise the work behind. The number says which it is.
    const key = pastPlan && slip != null && slip >= 0.5 ? `${slip} h late` : ov.standing === "behind" && gap >= 0.5 ? `${gap} h behind` : slip != null && slip >= 0.5 ? `${slip} h late` : leftWords;
    return { label: "BEHIND", tone: "rose", key, text: text + fcText, bad: true };
  }
  if (fc && slip != null && slip >= 0.5) {
    return { label: "FORECAST LATE", tone: "rose", key: `${slip} h`, text: `${scope} is ${pct}, but the forecast finish is ${c.DT(fc.finish)}, ${lateWords(fc.slipH)}.`, bad: true };
  }
  if (ov.standing === "ahead") return { label: "AHEAD", tone: "emerald", key: `${gap} h`, text: `${scope} is ${pct}: ${c.hrs(gap)} of work ahead.${fcText}`, bad: false };
  return { label: "ON TRACK", tone: "slate", key: `${ov.actualPct}%`, text: `${scope} is ${pct}.${fcText}`, bad: false };
}

/** Breaks and lunch for each shift: blocked off in the notes by the hour.
 *  Picked, not typed: the shift, the time, how long, and what it is. */
function BreaksEditor({ breaks, onChange, times }: { breaks: ShiftBreak[]; onChange: (b: ShiftBreak[]) => void; times: ShiftTimes }) {
  const sel = "h-7 pointer-coarse:h-11 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-caption";
  const set = (i: number, v: Partial<ShiftBreak>) => onChange(breaks.map((b, j) => (j === i ? { ...b, ...v } : b)));
  // A break outside its shift never shows: said, with the shift's hours.
  const min = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const c12 = (hm: string) => { const h = Number(hm.slice(0, 2)); return `${h % 12 || 12}:${hm.slice(3, 5)} ${h < 12 ? "AM" : "PM"}`; };
  const ds = times.dayStart || "05:30", ns = times.nightStart || `${String((Number(ds.slice(0, 2)) + 12) % 24).padStart(2, "0")}:${ds.slice(3, 5)}`;
  const inDay = (hm: string) => { const t = min(hm), a = min(ds), b = min(ns); return a <= b ? t >= a && t < b : t >= a || t < b; };
  const outside = (b: ShiftBreak) => /^\d{2}:\d{2}/.test(b.start) && (b.shift === "day" ? !inDay(b.start) : inDay(b.start));
  return (
    <div className="border-t border-[var(--color-border)] pt-1.5 space-y-1">
      <div className="font-medium text-[var(--color-text)]">Breaks and lunch</div>
      {breaks.length === 0 && <div className="text-[var(--color-text-muted)]">None set.</div>}
      {breaks.map((b, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1">
          <select value={b.shift} onChange={(e) => set(i, { shift: e.target.value as ShiftBreak["shift"] })} aria-label="Shift" className={sel}>
            <option value="day">Day</option><option value="night">Night</option>
          </select>
          <select value={b.label} onChange={(e) => set(i, { label: e.target.value })} aria-label="What" className={sel}>
            {["Break", "Lunch", "Dinner"].map((x) => <option key={x}>{x}</option>)}
          </select>
          <input type="time" value={b.start} onChange={(e) => set(i, { start: e.target.value || b.start })} aria-label="Starts" className={`${sel} w-[6.2rem]`} />
          <select value={b.minutes} onChange={(e) => set(i, { minutes: Number(e.target.value) })} aria-label="How long" className={sel}>
            {[10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
          <button type="button" onClick={() => onChange(breaks.filter((_, j) => j !== i))} aria-label="Remove this break" className="ui-hit p-1 text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)]"><X className="w-3.5 h-3.5" /></button>
          {outside(b) && <span className="basis-full text-caption font-medium text-[var(--state-held-text)]">{c12(b.start)} isn&apos;t on the {b.shift} shift ({c12(b.shift === "day" ? ds : ns)} to {c12(b.shift === "day" ? ns : ds)}): it won&apos;t show. AM or PM, or the other shift?</span>}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...breaks, { shift: "day", start: breaks.length ? "12:00" : "09:00", minutes: breaks.length ? 30 : 15, label: breaks.length ? "Lunch" : "Break" }])}
        className="text-[var(--color-accent-text)] hover:underline">+ Add a break</button>
    </div>
  );
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
  /** On the meeting's agenda (Today › Meeting): only there, or there and
   *  on the report. */
  agenda?: "only" | "also";
  /** Nothing in it: it folds into one line with the other empty sections
   *  ("Nothing finished, waiting or added this shift."), from `what` and
   *  `scope`. Its `actions` stay on that line as small buttons; one with no
   *  `run` opens the section itself. */
  fold?: { what: string; scope: string; actions?: Array<{ label: string; run?: () => void; icon?: "add" | "plan" | "jump" }> };
  /** Why the section is there, behind a "?" by its title. */
  help?: string;
}

/** "Nothing finished, waiting or added this shift. Nothing scheduled for
 *  the night shift.": the folded sections, one sentence per time. */
function foldSentence(list: Sec[]): string {
  const by = new Map<string, string[]>();
  for (const x of list) if (x.fold) by.set(x.fold.scope, [...(by.get(x.fold.scope) ?? []), x.fold.what]);
  const or = (w: string[]) => (w.length < 2 ? w[0] ?? "" : `${w.slice(0, -1).join(", ")} or ${w[w.length - 1]}`);
  return [...by.entries()].map(([scope, w]) => `Nothing ${or(w)} ${scope}.`).join(" ");
}

/** The report's sections as a compact list that stays on screen: each
 *  name with its count and, on one that needs attention, a dot in its
 *  color; a tap goes to it. A row that scrolls sideways (the next name
 *  shows in part), or a column beside the report. An empty section is
 *  quiet: it sits folded in the one line with the others. */
function SectionNav({ sections, current, folded, onGo, vertical }: { sections: Sec[]; current: number | null; folded: (s: Sec) => boolean; onGo: (id: string) => void; vertical?: boolean }) {
  return (
    <nav aria-label="Sections" className={vertical ? "flex flex-col gap-0.5" : "min-w-0 flex-1 flex items-center gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"}>
      {sections.map((s, i) => {
        const active = current === i;
        const empty = folded(s);
        const flag = s.flag === "rose" ? "var(--state-overdue)" : s.flag === "amber" ? "var(--state-held)" : null;
        return (
          <button key={s.id} type="button" onClick={() => onGo(s.id)} aria-current={active ? "step" : undefined}
            className={`${vertical ? "w-full justify-between" : "shrink-0"} inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-2 rounded-md text-body hover:bg-[var(--color-surface-2)] ${active ? "bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent-text)]" : empty ? "text-[var(--color-text-muted)]" : "font-medium text-[var(--color-text)]"}`}>
            <span className="min-w-0 truncate">{s.short}</span>
            {((s.count ?? 0) > 0 || flag) && (
              <span className="shrink-0 inline-flex items-center gap-1">
                {(s.count ?? 0) > 0 && <span className={`ui-count ${s.flag === "rose" ? "is-bad" : s.flag === "amber" ? "is-warn" : active ? "is-solid" : ""}`}>{badgeText(s.count!)}</span>}
                {flag && <span aria-label={s.flag === "rose" ? "needs attention" : "waiting"} className="w-2 h-2 rounded-full" style={{ background: flag }} />}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
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
  // Listed under its work order (ShiftRow.unit), never a folder of them; a
  // work order of its own stands alone.
  const t = rowTask(r);
  const at = t ? r.path.lastIndexOf(t.name) : -1;
  return {
    id: r.leaf.id ?? r.leaf.name,
    group: c.group(t?.id ?? null, t?.name ?? null, at >= 0 ? r.path.slice(0, at) : r.path.slice(0, -1), r.leaf.name),
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
  /** The project, and this shift's key and the next one's ("2026-10-26:day"). */
  projectId: string; thisKey: string; nextKey: string;
  timeOf: (id: string) => number | undefined;
  whyOf: (id: string) => string | undefined;
  taskPct: (id: string) => { pct: number; plan?: number } | undefined;
  edit: boolean;
  crewsThis: Record<string, CrewCount>; crewsNext: Record<string, CrewCount>;
  setCrew: (which: "this" | "next", crew: string, v: Partial<CrewCount>) => void;
  /** This shift's record and the next one's (each holds the meeting that
   *  starts it), their meeting crews carried in when they have none. */
  recThis?: ShiftRecord; recNext?: ShiftRecord;
  /** A meeting's crews carried from the last same shift: which shift. */
  carriedThis?: { crews: Record<string, CrewCount>; label: string };
  carriedNext?: { crews: Record<string, CrewCount>; label: string };
  /** The report is locked: nothing on it can be changed. */
  locked: boolean;
  saveMeeting: (which: "this" | "next", change: (r: ShiftRecord) => ShiftRecord) => Promise<void>;
  /** Names entered at earlier meetings, by crew. */
  known: Record<string, string[]>;
  incidents?: ShiftRecord["incidents"];
  setNone: (none: boolean) => void;
  /** Each resolves true once saved; the box keeps what was typed if not. */
  addIncident: (x: Omit<Incident, "id" | "by">) => Promise<boolean>;
  removeIncident: (id: string) => void;
  editIncident: (id: string, x: { at: number; kind: IncidentKind; text: string }) => Promise<boolean>;
  restoreIncident: (x: Incident) => void;
  notes: Array<ShiftNote & { from?: string; shiftKey: string }>;
  addNote: (x: { at: number; text: string; followUp: boolean }) => Promise<boolean>;
  clearNote: (n: ShiftNote & { shiftKey: string }) => void;
  removeNote: (n: ShiftNote & { shiftKey: string }) => void;
  editNote: (n: ShiftNote & { shiftKey: string }, x: { at: number; text: string; followUp: boolean }) => Promise<boolean>;
  unclearNote: (n: ShiftNote & { shiftKey: string }) => void;
  restoreNote: (n: ShiftNote & { shiftKey: string }) => void;
  error: string | null;
  tz: string;
  /** Shift notes, hour by hour: the record's, how to write and save them. */
  hourly?: HourlyCtx;
  /** The tables' order as dragged; null puts a table back the usual way. */
  order?: TableOrder;
  setOrder: (table: keyof TableOrder, ids: string[] | null) => void;
}

// ── Waiting and ready: what the control meeting works from ──
const shiftsWord = (n: number) => `${n} shift${n === 1 ? "" : "s"}`;
const waitWhy = (j: WaitingReady["waiting"][number]) => `${CAUSE_WORD[j.cause]}${j.cause === "crew_elsewhere" && j.crewOn.length ? ` (crew on ${[...new Set(j.crewOn.map(orderWord))].slice(0, 3).join(", ")})` : ""}`;
const readyWhy = (j: WaitingReady["ready"][number]) => (j.crewOn.length ? `Crew was on ${[...new Set(j.crewOn.map(orderWord))].slice(0, 3).join(", ")}` : "No work logged by this crew this shift");
const WAIT_NONE = "Nothing sat this shift: every started job moved, and no ready job was left unstarted.";
const waitingTitle = (shift: ShiftWindow, c: Ctx) => `Waiting and ready - ${shiftName(shift)} ${c.D(shift.start)}`;
const WAIT_SUB = "started with nothing logged, or ready and not started";
const SERVICE_TITLE = "Out for service (a planned step, not waiting)";

/** The lists as the update's blocks (email, copy, Word). */
function waitingBlocks(w: WaitingReady, c: Ctx): ExportBlock[] {
  const out: ExportBlock[] = [];
  if (!w.waiting.length && !w.ready.length) out.push({ k: "empty", text: WAIT_NONE });
  if (w.waiting.length) out.push({ k: "lines", title: `Started, nothing logged this shift (${w.waiting.length})`, tone: "amber", items: w.waiting.map((j) => ({ lead: jobWord(j), text: waitWhy(j), aside: `${j.crew} · ${shiftsWord(j.shifts)}`, ...(j.said ? { note: `"${j.said}"` } : {}) })) });
  if (w.ready.length) out.push({ k: "lines", title: `Ready, not started (${w.ready.length})`, items: w.ready.map((j) => ({ lead: jobWord(j), text: `Ready since ${c.DT(j.readyAt)}`, aside: `${j.crew} · ${shiftsWord(j.shifts)}`, note: readyWhy(j) })) });
  if (w.service.length) out.push({ k: "lines", title: `${SERVICE_TITLE} (${w.service.length})`, items: w.service.map((j) => ({ lead: jobWord(j), text: "", aside: j.crew, ...(j.said ? { note: `"${j.said}"` } : {}) })) });
  return out;
}
function waitingExport(w: WaitingReady, shift: ShiftWindow, c: Ctx): ExportSection & { id: string } {
  return { id: "waiting", title: waitingTitle(shift, c), sub: WAIT_SUB, flag: w.waiting.length ? "amber" : null, blocks: waitingBlocks(w, c) };
}
/** The update with the waiting and ready lists after what the shift got done. */
function withWaiting<T extends ExportSection & { id: string }>(sections: T[], sec: (ExportSection & { id: string }) | null): Array<ExportSection & { id: string }> {
  if (!sec) return sections;
  const at = sections.findIndex((x) => x.id === "done");
  return at < 0 ? [...sections, sec] : [...sections.slice(0, at + 1), sec, ...sections.slice(at + 1)];
}
function waitingSection(w: WaitingReady, _shift: ShiftWindow, c: Ctx): Sec {
  const n = w.waiting.length + w.ready.length;
  const row = (key: string, lead: string, text: string, aside: string, note?: string | null) => (
    <li key={key} className="py-1.5 border-b last:border-b-0 border-[var(--color-border)]">
      <div className="flex items-baseline gap-x-2 flex-wrap"><b className="text-[var(--color-text)]">{lead}</b><span className="text-[var(--color-text)]">{text}</span><span className="ml-auto text-caption text-[var(--color-text-muted)] whitespace-nowrap">{aside}</span></div>
      {note && <div className="text-caption text-[var(--color-text-muted)]">{note}</div>}
    </li>
  );
  return {
    // The date is at the top of the report: the title says what and how many.
    id: "waiting", title: `Waiting · ${n}`, short: "Waiting", help: `${WAIT_SUB[0].toUpperCase()}${WAIT_SUB.slice(1)}.`,
    count: n || undefined, flag: w.waiting.length ? "amber" : null,
    ...(!n && !w.service.length ? { fold: { what: "waiting", scope: "this shift" } } : {}),
    body: () => (!n && !w.service.length ? <div className="text-body text-[var(--color-text-muted)]">{WAIT_NONE}</div> : (
      <div className="space-y-3 text-body" data-waiting-ready>
        {!n && <div className="text-[var(--color-text-muted)]">{WAIT_NONE}</div>}
        {w.waiting.length > 0 && <div><div className="text-caption font-medium text-[var(--state-held-text)]">Started, nothing logged this shift ({w.waiting.length})</div><ul>{w.waiting.map((j) => row(j.id, jobWord(j), waitWhy(j), `${j.crew} · ${shiftsWord(j.shifts)}`, j.said ? `"${j.said}"` : null))}</ul></div>}
        {w.ready.length > 0 && <div><div className="text-caption font-medium text-[var(--color-text-muted)]">Ready, not started ({w.ready.length})</div><ul>{w.ready.map((j) => row(j.id, jobWord(j), `Ready since ${c.DT(j.readyAt)}`, `${j.crew} · ${shiftsWord(j.shifts)}`, readyWhy(j)))}</ul></div>}
        {w.service.length > 0 && <div><div className="text-caption font-medium text-[var(--color-text-muted)]">{SERVICE_TITLE} ({w.service.length})</div><ul>{w.service.map((j) => row(j.id, jobWord(j), "", j.crew, j.said ? `"${j.said}"` : null))}</ul></div>}
        <div className="text-caption text-[var(--color-text-muted)]">A night shift counts only for work that ran on nights. The post-event review counts these the same way.</div>
      </div>
    )),
    data: () => waitingBlocks(w, c),
  };
}

function turnoverSections(report: ShiftReport, c: Ctx, o: { onJump?: () => void; jumpTarget: ShiftWindow | null; noteOf?: (id: string) => { body: string; at?: string | null } | undefined; times: ShiftTimes;
  /** The shift's notes and record (above). */
  sheet?: SheetCtx;
  /** Save the hour by hour as a file (on the letterhead). */
  hourlyExport?: React.ReactNode;
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
  /** The phase the standing is of, on a project split in phases with all picked. */
  standPhase?: string;
  /** The critical path's source, when it isn't the links and they'd say
   *  otherwise — with the switch. */
  pathSource?: { label: string; theirs: number; calculated: number; onUse?: () => void; msg?: string | null };
  /** Discovery work on the schedule, and the way to add it. */
  discovery?: Discovery[]; onDiscovery?: () => void;
  /** Why it's behind (lib/behindWhy). */
  why?: BehindWhy;
  /** A task's steps: how many are done, of how many. */
  taskSteps?: (taskId: string) => { done: number; total: number } | undefined;
  /** Change what the next shift does, in the schedule. */
  onPlanNext?: () => void;
  /** The next shift's plan, set by hand (lib/nightPlan), and the way to set it. */
  nightPlan?: { plan?: ShiftPlan; open?: () => void };
  /** The shift after that: its list (the schedule's, or its plan) and the way to plan it. */
  after?: { report: ShiftReport; plan?: ShiftPlan; open?: () => void };
  /** This shift's own plan (the work after its meeting) and the way to set it. */
  thisPlan?: { plan?: ShiftPlan; open?: () => void };
  /** Where it stands in one sentence (the email's too). */
  say?: StandSay }): Sec[] {
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
    // Hours of the step's work, not hours late: "25 of 48 h behind plan".
    const of = r.hours > 0 ? ` of ${c.hrs(Math.round(r.hours * 10) / 10)}` : "";
    return sh.side === "ahead" ? { t: `${h}${of} ahead of plan`, tone: "emerald" } : { t: `${h}${of} behind plan`, tone: sh.hours >= SEVERE_BEHIND_H ? "rose" : "amber" };
  };
  // ── Done: finished, and moved forward but on no list below.
  const doneIds = new Set(plan.done.map((r) => r.leaf.id ?? r.leaf.name));
  // One row per task: its steps done or moved this shift, in one cell.
  const doneTasks = doneByTask(report, plan, c, (id) => noteLine(o.noteOf?.(id), shift.start, c.D), { timeOf: o.sheet?.timeOf, taskPct: o.sheet?.taskPct, whyOf: o.sheet?.whyOf, taskSteps: o.taskSteps });
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
          return [vs, detail, kind === "next" || pulled ? waitTag(r) : null, scope ? { t: `${scope}'s scope: coordinate`, tone: "amber" as const } : null, ...pathTags(r)];
        })(),
      }),
      // The meeting's call on it (never printed): could the next crew try
      // it? One small button on the line; once marked, its crew and note.
      inline: !print && ho && r.leaf.id && kind === "carry" && !goals.byPlan ? (
        <button type="button" disabled={ho.locked} onClick={() => ho.set(r.leaf.id!, { ...ho.decisions[r.leaf.id!], tryIt: true, crew: ho.suggest(r)[0]?.crew ?? null })}
          className="whitespace-nowrap rounded-full border border-[var(--color-border-strong)] px-1.5 py-px text-caption font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-60 print:hidden">
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
  // The next shift's plan, set by hand: who set it, what it leaves off;
  // and this shift against the plan it was given.
  const np = o.nightPlan;
  const planSet = goals.byPlan ? planSetText(np?.plan, c) : null;
  const offText = offPlanText(report);
  const checkText = planCheckText(report);
  // Without a plan, steps can still be pulled forward one by one.
  const addButton = ho?.openPicker && !goals.byPlan ? (
    <button type="button" onClick={ho.openPicker}
      className="inline-flex items-center gap-1.5 h-10 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] print:hidden">
      <Zap className="w-3.5 h-3.5" /> Add work for the {next.kind} shift
    </button>
  ) : null;
  const planButton = np?.open ? (
    <button type="button" onClick={np.open}
      className="inline-flex items-center gap-1.5 h-10 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] print:hidden">
      <ListChecks className="w-3.5 h-3.5" /> {goals.byPlan ? `Change the ${next.kind} plan` : `Plan the ${next.kind} shift`}
    </button>
  ) : null;
  const asked = ho?.asked ?? [];
  const askedText = asked.length ? `Asked last turnover: ${askedLine(asked, askedResult)}` : null;
  const otherKind = next.kind === "day" ? "night" : "day";
  const tryLine = tryList.length
    ? `Could try if possible: ${tryList.length} step${tryList.length === 1 ? "" : "s"}, ${c.hrs(capa.used)}${capa.hours > 0 && ho?.pullSet ? ` of ${c.hrs(capa.hours)}${capa.over ? ", over" : ""} (${ho.pullSet.crew ? `${ho.pullSet.crew}, ` : ""}${ho.pullSet.hands} × ${Math.min(ho.pullSet.hours, shiftHrs)} h)` : ""}.`
    : null;
  const nextSub = [
    c.hrs(planHrs),
    tryList.length ? `${tryList.length} could try` : null,
  ].filter(Boolean).join(" · ");
  // Night shifts not decided: the list follows the schedule file's hours (said in Next).
  const nightUnset = next.kind === "night" && o.times.nightJobs === undefined && !goals.byPlan;
  // The shift after: its own list, numbered, read like the next shift's.
  const after = o.after;
  const afterNext = after?.report.next;
  const afterItems = after ? turnoverPlan(after.report, () => false).items.filter((x) => x.kind === "next" && (!o.crew || (x.r.leaf.actualParty?.trim() || x.r.leaf.responsibleParty?.trim()) === o.crew)) : [];
  const afterList = afterItems.map((x) => x.r);
  const afterHrs = afterList.reduce((a, r) => a + (r.hoursNext ?? 0), 0);
  const afterSet = after?.report.goals.byPlan ? planSetText(after.plan, c) : null;
  const afterRows = () => afterList.map((r, i) => {
    const x = nextOf(after!.report, r, "next", c, { pulled: false, crew: null });
    return rowFromShift(r, c, {
      when: x.label, n: { num: i + 1, tone: r.critical ? "rose" : r.carryOver ? "amber" : "slate" },
      right: standing(r, "next"), note: comment(r),
      extraTags: [x.detail ? { t: x.detail, tone: (x.tone === "rose" ? "amber" : x.tone ?? "muted") as TagTone } : null, ...pathTags(r)],
    });
  });
  const afterButton = after?.open && afterNext ? (
    <button type="button" onClick={after.open}
      className="inline-flex items-center gap-1.5 h-10 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] print:hidden">
      <ListChecks className="w-3.5 h-3.5" /> {after.report.goals.byPlan ? `Change the ${afterNext.kind} plan` : `Plan the ${afterNext.kind} shift`}
    </button>
  ) : null;
  // Past due across every crew, the held ones in the count and named: the
  // same count as the board's "8 overdue, 1 on hold".
  const pastDueRows = (o.whole ?? report).review.carryOver;
  const pastDueAll = pastDueRows.length;
  const pastDueHeld = pastDueRows.filter((r) => isHeld(r)).length;
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
    // "Overdue", the page header's word for it.
    { label: o.crew ? "Overdue · all crews" : "Overdue", value: `${pastDueAll}`, tone: (pastDueAll ? "amber" : "emerald") as "amber" | "emerald" },
  ];
  const nothingLast = review.scheduled.length === 0 && doneRows.length === 0;

  // Who was here, and who's coming — right after where we stand.
  const cr = crewsOf(report, plan, c.hrs);
  const sh = o.sheet;
  // The meetings in the notes, hour by hour: the one that started the
  // shift (its crews: the ones that worked it) and the one that starts the
  // next (its crews: the ones coming on). The report's safety topics for
  // the next shift are the ones to pick from at its meeting.
  const named = (list: Array<{ crew: string }>) => list.map((x) => x.crew).filter((x) => x !== "No crew named");
  const topicPicks = sh?.edit && hazardJobs.length
    ? safetyBrief(rankHazards(hazardJobs, { shift: next, T: c.T, max: RISKS_RANKED }), next, { project: projectFacts(o.safety?.project, next, hazardJobs.map((j) => j.name)), recentRisks: o.safety?.recent }).map((t) => t.title)
    : undefined;
  const meetings: { start?: MeetingCtx; end?: MeetingCtx } | undefined = sh ? {
    start: { crews: named(cr.worked), record: sh.recThis, shiftStart: shift.start, carried: sh.carriedThis, known: sh.known, save: (f) => sh.saveMeeting("this", f), projectId: sh.projectId, shiftKey: sh.thisKey },
    end: { crews: named(cr.coming), record: sh.recNext, shiftStart: next.start, carried: sh.carriedNext, known: sh.known, topics: topicPicks, save: (f) => sh.saveMeeting("next", f), projectId: sh.projectId, shiftKey: sh.nextKey },
  } : undefined;
  // Each table's rows drag into the order the meeting wants; the email follows.
  // The dragged order shows the same for everyone and in print (as the
  // email has it); only an editor gets the grips.
  const sortOf = (print: boolean, table: keyof TableOrder) => ({ onReorder: !print && sh?.edit ? (ids: string[]) => sh.setOrder(table, ids) : undefined, runs: !!sh?.order?.[table]?.length });
  const putBack = (print: boolean, table: keyof TableOrder) => (!print && sh?.edit && sh.order?.[table]?.length ? (
    <div className="flex justify-end -mb-1 print:hidden">
      <button type="button" onClick={() => sh.setOrder(table, null)} className="text-body hover:underline text-[var(--color-accent-text)]">Put back in the usual order</button>
    </div>
  ) : null);
  const editRow = o.onEdit;
  // The meeting's agenda (Today › Meeting): who's there and the head
  // count, then the safety topic, then what the next shift picks up.
  const endMeeting = meetings?.end;
  const agendaItems: Sec[] = [
    ...(endMeeting && sh ? [{
      id: "attend", title: "Attendance & head count", short: "Attendance", agenda: "only" as const,
      sub: meetingTitle(next.kind), help: "Who's here from each crew, and how many are on site.",
      body: (print: boolean) => <MeetingBox m={endMeeting} edit={sh.edit && !print} />,
    }] : []),
    ...(hazardJobs.length ? [{
      id: "topics", title: "Safety topic", short: "Safety topic", agenda: "only" as const,
      sub: endMeeting && sh?.edit ? "Pick one for the meeting, or present it full screen" : "Present one full screen",
      body: (print: boolean) => (
        <SafetyMomentBox jobs={hazardJobs} shift={next} T={c.T} print={print} project={o.safety?.project} recent={o.safety?.recent} label={`${shiftName(next)} ${c.D(next.start)}`}
          chosen={endMeeting?.record?.meeting?.safety}
          onUse={endMeeting && sh?.edit && !print ? (title) => { void endMeeting.save((r) => ({ ...r, meeting: { ...(r.meeting ?? {}), safety: title } })).catch((e) => appAlert({ title: "Safety topic not saved", message: `"${title}" didn't save to the meeting: ${sayError(e)}. Pick it again to try again.`, tone: "danger" })); } : undefined} />
      ),
    }] : []),
  ];
  return [
    ...agendaItems,
    {
      id: "stand", title: "Where we stand", short: "Status",
      sub: [o.standPhase ? `${o.standPhase} only` : null,
        overall.plannedFinish ? `Day ${overall.daysElapsed} of ${overall.daysTotal} · planned finish ${c.DT(overall.plannedFinish)}` : null,
        o.forecast ? forecastText(o.forecast, { D: c.D, T: c.T, hrs: c.hrs }) : null,
        overall.planBasis === "baseline" ? `vs baseline${overall.baselineSetAt ? ` of ${c.D(Date.parse(overall.baselineSetAt))}` : ""}` : "vs live dates (no baseline)",
        overall.unscheduled > 0 ? `${overall.unscheduled} step${overall.unscheduled === 1 ? "" : "s"} without dates not counted` : null].filter(Boolean).join(" · "),
      flag: overall.standing === "behind" ? "rose" : null,
      body: (print) => (
        <>
          <StandTiles print={print} actual={overall.actualPct} planned={overall.plannedPct} standing={overall.standing}
            gap={{ label: standStats[2].label, value: standStats[2].value }} done={overall.stepsDone} total={overall.stepsTotal}
            pastDue={pastDueAll} pastDueHeld={pastDueHeld} pastDueLabel={standStats[4].label} say={o.say}
            pastDueScope={`across ${o.standPhase ? "every phase" : "the work"}, all crews`} />
          {/* Only when the job is behind: on track or ahead, the order the work was done in is not reported. */}
          {o.why && o.why.total >= 0.5 && overall.standing === "behind" && <WhyBehind why={o.why} c={c} print={print} />}
          {!print && o.pathSource && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-[var(--color-text-muted)] print:hidden">
              <span>Critical path: <b className="text-[var(--color-text)]">{o.pathSource.label}</b> ({o.pathSource.theirs} step{o.pathSource.theirs === 1 ? "" : "s"}). From the schedule&apos;s links it&apos;s {o.pathSource.calculated}, recalculated as work moves - near-critical and float come with it.</span>
              {o.pathSource.onUse && <button type="button" onClick={o.pathSource.onUse} className="text-[var(--color-accent-text)] hover:underline">Use the calculated path</button>}
              {o.pathSource.msg && <span className="font-medium text-[var(--state-held-text)]">{o.pathSource.msg}</span>}
            </div>
          )}
        </>
      ),
      data: () => [
        { k: "stats", items: standStats },
      ],
    },
    {
      id: "safety", title: "Safety & people", short: "Safety",
      help: "Incidents since the last turnover, and what's open across the change. The safety topics are on the meeting's agenda.",
      body: (print) => (
        <div className="space-y-2">
          {sh ? (
            // The incidents line takes the place of its tick-box.
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 keep">
              <IncidentsLine incidents={sh.incidents} edit={sh.edit} print={print} shift={shift} tz={sh.tz} T={c.T} onNone={sh.setNone} onAdd={sh.addIncident} onRemove={sh.removeIncident} onEdit={sh.editIncident} onRestore={sh.restoreIncident} />
              <div className="sm:col-span-2"><Prompts print={print} items={["Permits and lock-outs open across the change", "Manpower and equipment - short, down, arriving"]} /></div>
            </div>
          ) : (
            <Prompts print={print} cols={3} items={[
              "Incidents, near misses, first aid since last turnover",
              "Permits and lock-outs open across the change",
              "Manpower and equipment - short, down, arriving",
            ]} />
          )}
        </div>
      ),
    },
    {
      // ── Done — what the shift finished, and what it moved forward.
      // The shift and its date are at the top: the title is what and how many.
      id: "done", title: `Done · ${plan.done.length}`, short: "Done",
      sub: plan.moved.length ? `${plan.moved.length} moved forward` : undefined,
      count: plan.done.length,
      flag: null,
      ...(doneRows.length === 0 && !checkText && !askedText ? { fold: { what: nothingLast ? "planned" : "finished", scope: `${forCrew ? `${forCrew} ` : ""}this shift`.trim(),
        actions: nothingLast && o.onJump && o.jumpTarget ? [{ label: `Jump to ${o.jumpTarget.kind} shift, ${c.D(o.jumpTarget.start)}`, run: o.onJump, icon: "jump" as const }] : [] } } : {}),
      data: () => [
        ...(checkText ? [{ k: "note", text: checkText } as ExportBlock] : []),
        ...(askedText ? [{ k: "note", text: askedText } as ExportBlock] : []),
        doneRows.length === 0 ? { k: "empty", text: `Nothing was ${nothingLast ? "planned" : "completed"}${forCrew} on this shift.` }
          : { k: "table", head: ["Task", "Done this shift", "Who", "What it means", "vs plan"], align: ["left", "left", "left", "left", "right"], nowrap: [4],
            rows: doneTasks.map((x) => [{ t: x.task, bold: true }, x.steps, { t: x.who, tone: "muted" }, { t: x.result.text, tone: x.result.tone === "amber" ? "amber" : "emerald", bold: true }, { t: x.vs.text, tone: x.vs.tone, bold: true }]) } as ExportBlock,
      ],
      body: (print) => (
        <div className="space-y-2">
          {!print && o.thisPlan?.open && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={o.thisPlan.open}
                className="inline-flex items-center gap-1.5 h-10 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] print:hidden">
                <ListChecks className="w-3.5 h-3.5" /> {o.thisPlan.plan ? "Change this shift's plan" : "Plan this shift"}
              </button>
              {o.thisPlan.plan
                ? <span className="text-caption text-[var(--color-text-muted)]">{planSetText(o.thisPlan.plan, c) ?? "Planned."}</span>
                : <span className="text-caption text-[var(--color-text-muted)]">Not set</span>}
              <HelpTooltip>{o.thisPlan.plan ? "The update's \"Plan\" row is this plan." : "This shift's plan is the work after its meeting. Not set: the update lists the schedule's work for the shift."}</HelpTooltip>
            </div>
          )}
          {checkText && <div className="text-caption font-medium text-[var(--color-text)]">{checkText}</div>}
          {askedText && <div className="text-caption font-medium text-[var(--color-text)]">{askedText}</div>}
          {doneRows.length > 0 && putBack(print, "done")}
          {doneRows.length > 0 ? (
            <DoneTasks rows={doneTasks} print={print} stamps={!!sh?.stamps} T={c.T} sort={sortOf(print, "done")} onEdit={print ? undefined : editRow} />
          ) : (
            <Empty>
              Nothing was {nothingLast ? "planned" : "completed"}{forCrew} on this shift.
              {nothingLast && o.onJump && o.jumpTarget && !print && (
                <button onClick={o.onJump} className="ml-2 inline-flex items-center gap-1 text-[var(--color-accent-text)] hover:underline">
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
      // Its shift and times are at the top of the report.
      id: "next", title: `Next shift · ${planList.length} step${planList.length === 1 ? "" : "s"}`, short: "Next shift",
      agenda: "also",
      sub: nextSub,
      count: planList.length,
      flag: null,
      ...(planList.length + tryList.length === 0 && !planSet && !nightUnset && !tryLine && !goals.pulledHeld.length && !offText ? { fold: {
        what: goals.byPlan ? "left open on the plan" : "scheduled", scope: `for the ${next.kind} shift`,
        actions: [
          ...(np?.open ? [{ label: goals.byPlan ? `Change the ${next.kind} plan` : `Plan the ${next.kind} shift`, run: np.open, icon: "plan" as const }] : []),
          ...(ho?.openPicker && !goals.byPlan ? [{ label: `Add work for the ${next.kind} shift`, run: ho.openPicker, icon: "add" as const }] : []),
        ] } } : {}),
      body: (print) => (
        <div className="space-y-2">
          {!print && planButton && <div className="flex flex-wrap items-center gap-2">{planButton}{!goals.byPlan && <><span className="text-caption text-[var(--color-text-muted)]">No plan set</span><HelpTooltip>This list is the schedule&apos;s. Tick the work you&apos;re giving the {next.kind} shift.</HelpTooltip></>}</div>}
          {planSet && <div className="text-caption font-medium text-[var(--color-text)]">{planSet} This list is the plan; nothing else is handed to the {next.kind} shift.</div>}
          {nightUnset && (
            // Not decided: the list follows the schedule file's hours.
            <div role="alert" className="border-l-2 border-[var(--state-overdue)] pl-3 py-1 text-caption text-[var(--color-text)]">
              <b className="text-[var(--state-overdue-text)]">Night shifts aren&apos;t set:</b> this list follows the schedule file&apos;s hours, which can hand day work to nights. Set them once in <b>Schedule setup → Night shifts</b>: which jobs run days and nights.
            </div>
          )}
          {planList.length + tryList.length > 0 && putBack(print, "next")}
          {planList.length + tryList.length === 0 ? <Empty>{goals.byPlan ? "Nothing left open on the plan." : "Nothing is scheduled for the next shift."}</Empty> : (
            <StepTable print={print} box whenHead="When" rightHead="Done → goal" rows={nextRows(print, true)} sort={sortOf(print, "next")} onEdit={print ? undefined : editRow} />
          )}
          {tryLine && <div className="text-caption font-medium text-[var(--state-held-text)]">{tryLine}</div>}
          {goals.pulledHeld.length > 0 && (
            <div className="text-caption font-medium text-[var(--state-overdue-text)]">
              Blocked since it was added, not on the list: {goals.pulledHeld.map((r) => `${r.leaf.name}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}.
            </div>
          )}
          {offText && <OffPlan text={offText} rows={goals.offPlan} print={print} c={c} />}
          {!print && addButton}
          {!print && o.onPlanNext && (
            <button type="button" onClick={o.onPlanNext}
              className={`${addButton ? "ml-2 " : ""}inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-caption font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] print:hidden`}>
              <CalendarClock className="w-3.5 h-3.5" /> Move schedule dates: swap, pull in, push out
            </button>
          )}
        </div>
      ),
      data: () => [
        ...(planSet ? [{ k: "note", text: planSet } as ExportBlock] : []),
        planList.length + tryList.length === 0 ? { k: "empty", text: goals.byPlan ? "Nothing left open on the plan." : "Nothing is scheduled for the next shift." } : stepsBlock(nextRows(true, true), "Done · goal", "When"),
        ...(offText ? [{ k: "note", text: offText } as ExportBlock] : []),
        ...(tryLine ? [{ k: "note", text: tryLine, tone: "amber" } as ExportBlock] : []),
      ],
    },
    // ── The shift after: the other crew's next shift, planned the same way
    // as the next one. Its list is the schedule's (with what this crew
    // leaves open) until a plan is set; then the plan.
    ...(after && afterNext ? [{
      // Not on the line at the top: its shift and times go beside the title.
      id: "after", title: `Shift after · ${afterList.length} step${afterList.length === 1 ? "" : "s"}`, short: "Shift after",
      agenda: "also",
      sub: [`${shiftName(afterNext)} ${c.D(afterNext.start)} ${c.win(afterNext)}`, c.hrs(afterHrs), plan.held.length ? `${plan.held.length} blocked or on hold` : null].filter(Boolean).join(" · "),
      count: afterList.length,
      flag: plan.held.some((r) => r.status === "blocked") ? "rose" : null,
      ...(afterList.length === 0 && !afterSet && !plan.held.length ? { fold: {
        what: after.report.goals.byPlan ? "left open on the plan" : "scheduled", scope: `for the ${afterNext.kind} shift after (${c.D(afterNext.start)})`,
        actions: after.open ? [{ label: after.report.goals.byPlan ? `Change the ${afterNext.kind} plan` : `Plan the ${afterNext.kind} shift`, run: after.open, icon: "plan" as const }] : [] } } : {}),
      body: (print: boolean) => (
        <div className="space-y-2">
          {!print && afterButton && <div className="flex flex-wrap items-center gap-2">{afterButton}{!after.report.goals.byPlan && <><span className="text-caption text-[var(--color-text-muted)]">No plan set</span><HelpTooltip>This list is the schedule&apos;s, with what the {next.kind === "day" ? "night" : "day"} crew leaves open. Tick the work you&apos;re giving the {afterNext.kind} shift.</HelpTooltip></>}</div>}
          {afterSet && <div className="text-caption font-medium text-[var(--color-text)]">{afterSet} This list is the plan; nothing else is handed to the {afterNext.kind} shift.</div>}
          {afterList.length === 0 ? <Empty>{after.report.goals.byPlan ? "Nothing left open on the plan." : `Nothing is scheduled for the ${afterNext.kind} shift.`}</Empty> : (
            <StepTable print={print} box whenHead="When" rightHead="Done → goal" rows={afterRows()} onEdit={print ? undefined : editRow} />
          )}
          {plan.held.length > 0 && (
            <div className="text-caption font-medium text-[var(--state-overdue-text)]">
              Blocked or on hold, on no shift&apos;s list: {plan.held.map((r) => `${r.leaf.name}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}.
            </div>
          )}
        </div>
      ),
      data: () => [
        ...(afterSet ? [{ k: "note", text: afterSet } as ExportBlock] : []),
        afterList.length === 0 ? { k: "empty", text: after.report.goals.byPlan ? "Nothing left open on the plan." : `Nothing is scheduled for the ${afterNext.kind} shift.` } as ExportBlock : stepsBlock(afterRows(), "Done · goal", "When"),
        ...(plan.held.length ? [{ k: "note", text: `Blocked or on hold, on no shift's list: ${plan.held.map((r) => `${r.leaf.name}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}.`, tone: "rose" } as ExportBlock] : []),
      ],
    } as Sec] : []),
    ...discoverySection(shift, c, o.discovery ?? [], o.onDiscovery),
    ...(sh?.hourly ? [hourlySection(sh, sh.hourly, meetings, o.hourlyExport)] : []),
    // ── Follow-up items: the update's own row, kept open from shift to
    // shift until someone marks each done.
    ...(sh ? [(() => {
      const open = sh.notes.filter((n) => n.followUp && !n.cleared);
      return {
        id: "followups", title: `Follow-ups · ${open.length}`, short: "Follow-ups", agenda: "also",
        help: "Each follow-up is on every update until someone marks it done.",
        count: open.length || undefined, flag: null,
        ...(!open.length ? { fold: { what: "open", scope: "in follow-ups", actions: sh.edit ? [{ label: "Add a follow-up", icon: "add" as const }] : [] } } : {}),
        body: (print: boolean) => <FollowUpsBox open={open} edit={sh.edit && !print} T={c.T} onAdd={(text) => sh.addNote({ at: Date.now(), text, followUp: true })} onDone={(n) => sh.clearNote(n)} />,
        data: () => [open.length ? { k: "bullets", items: open.map((n) => `${n.text}${n.from ? ` (from ${n.from})` : ""}`) } as ExportBlock : { k: "empty", text: "None." } as ExportBlock],
      } as Sec;
    })()] : []),
    closeSection("Close", ["Outgoing supervisor", "Incoming supervisor", "Crew lead"], undefined, sh ? (print) => (
      <ShiftNotesBox notes={sh.notes} edit={sh.edit} print={print} shift={shift} tz={sh.tz} T={c.T} D={c.D} onAdd={sh.addNote} onClear={sh.clearNote} onRemove={sh.removeNote} onEdit={sh.editNote} onUnclear={sh.unclearNote} onRestore={sh.restoreNote} />
    ) : undefined),
  ];
}

/** The update's follow-up items: each open one (from this shift or an
 *  earlier one), marked done here; a new one in a line. */
function FollowUpsBox({ open, edit, T, onAdd, onDone }: {
  open: Array<ShiftNote & { from?: string; shiftKey: string }>; edit: boolean; T: (ms: number) => string;
  onAdd: (text: string) => void; onDone: (n: ShiftNote & { shiftKey: string }) => void;
}) {
  const [text, setText] = useState("");
  const add = () => { const t = text.trim(); if (!t) return; onAdd(t); setText(""); };
  return (
    <div className="space-y-2">
      {open.length === 0 ? <Empty>No follow-up items open.</Empty> : (
        <ul className="space-y-1">
          {open.map((n) => (
            <li key={n.id} className="flex items-start gap-2 text-caption text-[var(--color-text)]">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[var(--state-held)] shrink-0" aria-hidden />
              <span className="flex-1 min-w-0 break-words">{n.text}<span className="ml-1.5 text-caption text-[var(--color-text-muted)]">{n.from ? `from ${n.from}` : `added ${T(n.at)}`}</span></span>
              {edit && <button type="button" onClick={() => onDone(n)} className="shrink-0 text-body hover:underline text-[var(--color-accent-text)]">Done</button>}
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <div className="flex gap-2">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder="Add a follow-up item"
            aria-label="Add a follow-up item" className="flex-1 min-w-0 h-9 pointer-coarse:h-11 px-2.5 rounded-lg border border-transparent bg-[var(--color-surface-2)] text-body text-[var(--color-text)] focus:bg-[var(--color-surface)]" />
          <button type="button" onClick={add} disabled={!text.trim()} className="h-9 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] text-body font-medium disabled:opacity-50">Add</button>
        </div>
      )}
    </div>
  );
}

/** Shift notes, hour by hour: the meeting that started the shift (who
 *  attended), the first hour (permitting), then each hour so far. */
function hourlySection(sh: SheetCtx, h: HourlyCtx, meetings?: { start?: MeetingCtx; end?: MeetingCtx }, exportButton?: React.ReactNode): Sec {
  const rows = hourlyRows(h.notes, h.slots, h.upTo, h.entries, sh.tz, { ...h.meet, closes: h.closes });
  const clocks = slotClocks(rows.map((r) => r.slot), sh.tz);
  const said = rows.filter((r) => r.slot.kind !== "meeting" && r.slot.kind !== "handover" && r.text).length;
  const meetingOf = (k: string) => (k === "meeting" ? h.meet?.start : k === "handover" ? h.meet?.end : undefined);
  return {
    id: "hourly", title: "Shift notes, hour by hour", short: "Hour by hour",
    sub: sh.edit && sh.carriedThis ? "The meeting's names and head counts aren't updated for this shift yet" : "The meeting, then what happened each hour",
    count: said || undefined,
    // Names and head counts still carried from the last shift: check them.
    flag: sh.edit && sh.carriedThis ? "amber" : null,
    body: (print) => (
      <>
        {!print && exportButton && <div className="flex justify-end mb-1.5 print:hidden">{exportButton}</div>}
        <ShiftHourlyBox h={h} edit={sh.edit} print={print} tz={sh.tz} meetings={meetings} />
      </>
    ),
    data: () => [{ k: "table", head: ["Time", "What happened"], align: ["left", "left"], textLabels: ["", ""], nowrap: [0], rows: rows.map((r, i) => {
      const m = meetingOf(r.slot.kind);
      return [
        { t: clocks[i], bold: true },
        r.slot.kind === "break" ? { t: breakLabel(r.slot), tone: "muted" }
          : m ? (m.lines.length ? { t: m.title, bold: true, lines: m.lines.map((t) => ({ t })) } : `${m.title} - No attendance entered`)
          : r.slot.kind === "permit" ? `Start of shift - permitting${r.text ? `. ${plainLine(r.text)}` : ""}`
            : plainLine(r.text) || { t: "-", tone: "muted" },
      ] as ExportCell[];
    }) }],
  };
}

/** Discovery work — found on the shift, what it added and did to the
 *  schedule; what's still open from earlier; and the way to add it. */
function discoverySection(shift: ShiftWindow, c: Ctx, list: Discovery[], onAdd?: () => void): Sec[] {
  const ds = discoverySummary(list, shift.start, shift.end);
  if (!ds.inShift.length && !ds.open.length && !onAdd) return [];
  return [{
    id: "discovery", title: `${addedTitle([...ds.inShift, ...ds.open].map((d) => kindOf(d.record)))} · ${ds.inShift.length}`, short: "Added work",
    sub: discoverySub(ds, c.hrs, c.word),
    count: ds.inShift.length,
    flag: ds.shift.critical ? "rose" : null,
    ...(!ds.inShift.length && !ds.open.length ? { fold: { what: "added", scope: "this shift",
      actions: onAdd ? [{ label: "Add discovery or added scope", run: onAdd, icon: "add" as const }] : [] } } : {}),
    body: (print) => (
      <div className="space-y-2">
        {ds.inShift.length === 0 ? <Empty>Nothing added this shift.</Empty> : <DiscoveryList list={ds.inShift} c={c} print={print} />}
        {ds.open.length > 0 && (
          <div className="text-caption font-medium text-[var(--state-held-text)]">
            Still open from earlier: {ds.open.map((d) => `${d.task?.name ?? ""}: ${d.record.what} (${d.steps.filter((x) => x.status !== "completed").length} of ${d.steps.length} steps open)`).join("; ")}.
          </div>
        )}
        {!print && onAdd && (
          <button type="button" onClick={onAdd}
            className="inline-flex items-center gap-1.5 h-10 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] print:hidden">
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
function DiscoveryList({ list, c, print, now = false }: { list: Discovery[]; c: Ctx; print: boolean;
  /** The close-out: the work as the schedule has it now (and the first estimate when it changed). */
  now?: boolean }) {
  const impactOf = (d: Discovery) => (now ? impactNowLine(d, c.hrs, c.word, c.tz) : impactLine(d.record.impact, c.hrs, c.word));
  const cell = print ? "px-1 py-[1px]" : "px-2 py-1.5";
  const impactCls = (d: Discovery) => (d.record.impact.critical ? "text-[var(--state-overdue-text)] font-medium" : "text-[var(--color-text)]");
  return (
    <>
      {!print && (
        <div className="sm:hidden rounded-md border border-[var(--color-border-strong)] divide-y divide-[var(--color-border)]">
          {list.map((d) => (
            <div key={d.record.id} className="px-3 py-2 text-caption space-y-0.5">
              <div className="flex items-start justify-between gap-2">
                <b className="break-words">{d.task?.name}{d.task?.workOrderRef && <span className="ml-1.5 ui-id text-caption">WO {d.task.workOrderRef}</span>}</b>
                <span className="shrink-0 font-display tabular-nums text-caption text-[var(--color-text-muted)]">{c.DTs(d.record.foundAt)}</span>
              </div>
              <div className="break-words"><b className="text-caption text-[var(--color-text-muted)] mr-1">{ADDED[kindOf(d.record)].word}</b>{d.record.what}</div>
              {d.steps.map((m) => <div key={m.id} className="text-caption text-[var(--color-text-muted)] break-words">{discoveryStepLine(m, c.hrs)}</div>)}
              <div className={`text-caption ${impactCls(d)}`}>{impactOf(d)}</div>
            </div>
          ))}
        </div>
      )}
      <div className={print ? "" : "hidden sm:block"}>
        <table className={`w-full border-collapse ${print ? "text-[8pt]" : "text-caption"}`}>
          <thead>
            <tr className="border-b border-[var(--color-border-strong)] text-caption font-medium text-[var(--color-text-muted)] text-left">
              <th className={`${cell} w-[92px]`}>When</th><th className={`${cell} w-[18%]`}>Task</th><th className={cell}>What</th><th className={`${cell} w-[30%]`}>Work it added</th><th className={`${cell} w-[22%]`}>What it did</th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.record.id} className="border-b border-[var(--color-border)] align-top">
                <td className={`${cell} font-display tabular-nums text-caption whitespace-nowrap`}>{c.DTs(d.record.foundAt)}</td>
                <td className={`${cell} font-medium break-words`}>{d.task?.name}{d.task?.workOrderRef && <div className="ui-id text-caption">WO {d.task.workOrderRef}</div>}</td>
                <td className={`${cell} break-words`}><div className="text-caption font-medium text-[var(--color-text-muted)]">{ADDED[kindOf(d.record)].word}</div>{d.record.what}{d.record.approvedBy && <div className="text-caption text-[var(--color-text-muted)]">Approved by {d.record.approvedBy}</div>}</td>
                <td className={`${cell} break-words`}>{d.steps.map((m) => <div key={m.id}>{discoveryStepLine(m, c.hrs)}</div>)}</td>
                <td className={`${cell} break-words ${impactCls(d)}`}>{impactOf(d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function kickoffSections(k: ReturnType<typeof buildKickoff>, c: Ctx, f?: FindingsCtx): Sec[] {
  const jobStats = [
    { label: "Days", value: `${k.daysTotal}`, tone: "slate" as const },
    { label: "Steps", value: `${k.steps}`, tone: "slate" as const },
    { label: "Work-hours", value: c.hrs(k.hours), tone: "slate" as const },
    { label: "Equipment / areas", value: `${k.groups.length}`, tone: "slate" as const },
    { label: "On critical path", value: `${k.critical.length}`, tone: (k.critical.length ? "rose" : "slate") as "rose" | "slate" },
  ];
  const unscheduledMsg = k.unscheduled > 0 ? `${k.unscheduled} step${k.unscheduled === 1 ? " has" : "s have"} no planned dates yet - not in the numbers above.` : null;
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
          {unscheduledMsg && <div className="text-caption font-medium text-[var(--state-held-text)]">{unscheduledMsg}</div>}
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
            "Job safety plan reviewed - hazards, permits, rescue plans, emergency muster",
            "Isolations, blinds and lock-out list agreed with operations",
            "Materials, tools, cranes and scaffold on site or dated",
            "Contacts - operations, safety, QA/QC, each contractor's lead",
          ]} />
          {k.notReady.length > 0 && <StepTable print={print} rightHead="Hours" ownerLine rows={notReadyRows} />}
        </div>
      ),
      data: () => [k.notReady.length ? stepsBlock(notReadyRows, "Hours") : { k: "empty", text: "Nothing blocked or on hold before day one." }],
    },
    {
      id: "equip", title: "Equipment & windows", short: "Equipment",
      sub: "Each piece of work, its window, and who does it - in start order",
      count: k.groups.length,
      body: (print) => k.groups.length === 0 ? <Empty>No dated work yet.</Empty> : (
        <SimpleTable print={print} head={["Equipment / area", "Window", "Steps", "Hours", "Who"]}
          rows={k.groups.map((g) => ({
            id: g.id,
            cells: [
              <span key="n"><b>{g.name}</b>{g.crumbs.length ? <span className="text-[var(--color-text-faint)]"> · {g.crumbs.join(" › ")}</span> : null}{g.critical ? <> <TagChip t={`${g.critical} critical`} tone="rose" /></> : null}</span>,
              c.span(g.start, g.finish), `${g.steps}`, c.hrs(g.hours), g.who.join(", ") || "-",
            ],
          }))} />
      ),
      data: () => [k.groups.length === 0 ? { k: "empty", text: "No dated work yet." } : {
        k: "table", head: ["Equipment / area", "Window", "Steps", "Hours", "Who"],
        rows: k.groups.map((g) => [`${g.name}${g.critical ? ` (${g.critical} critical)` : ""}`, c.span(g.start, g.finish), `${g.steps}`, c.hrs(g.hours), g.who.join(", ") || "-"]),
      }],
    },
    {
      id: "crit", title: "Critical path - what drives the finish date", short: "Critical path",
      sub: k.critical.length ? `${k.critical.length} steps · any slip here moves the end date` : "No critical chain computed",
      count: k.critical.length,
      body: (print) => k.critical.length === 0 ? <Empty>No critical chain - check the step links.</Empty> : (
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
    ...(f && f.past.length ? [pastJobsSection(f, c)] : []),
    closeSection("Close", [leadOf(c.word), "Operations", "Safety", "Each contractor lead"], "Attendance and sign-off"),
  ];
  return secs;
}

/** The project's findings for the close-out and kick-off. */
interface FindingsCtx {
  orgId: string; projectId: string; projectType: string; canEdit: boolean;
  /** Kept at the close-out review. */
  kept: Finding[];
  /** From past jobs (the kick-off). */
  past: PastJob[];
  live: Milestone[];
  /** The team's close-out lessons not reviewed yet. */
  team: Array<{ text: string; by: string | null }>;
}

/** Kick-off › From past jobs: what earlier jobs on this equipment and
 *  unit taught, each planned for or not relevant. */
function pastJobsSection(f: FindingsCtx, c: Ctx): Sec {
  const open = f.past.filter((x) => !x.ack).length;
  return {
    id: "pastjobs", title: "From past jobs", short: "Past jobs", count: f.past.length, flag: open ? "amber" : null,
    sub: open ? `${open} not planned for yet` : "Each one planned for or set aside",
    body: (print) => print ? (
      <ul className="space-y-1 text-[8.5pt]">
        {f.past.map((x) => (
          <li key={x.finding.id} className="keep"><b>{KIND_WORD[x.finding.kind]}</b> · {pastJobLines([x], c.tz)[0].text} <span className="text-[var(--color-text-muted)]">({pastJobLines([x], c.tz)[0].note})</span></li>
        ))}
      </ul>
    ) : <PastJobsPanel orgId={f.orgId} projectId={f.projectId} projectType={f.projectType} milestones={f.live} canEdit={f.canEdit} title="From past jobs on this equipment and unit" />,
    data: () => [{ k: "list", items: pastJobLines(f.past, c.tz) }],
  };
}

/** Close-out › Lessons & findings: the one review on screen (edit, keep,
 *  drop, add); what was kept in print and the email. */
function findingsSection(f: FindingsCtx, c: Ctx): Sec {
  const applies = (x: Finding) => (x.appliesTo === "equipment" ? x.assetTag ?? "Equipment" : APPLIES_WORD[x.appliesTo]);
  return {
    id: "findings", title: "Lessons & findings", short: "Lessons", count: f.kept.length || undefined, flag: null,
    sub: "What this job taught - kept for the next one",
    body: (print) => print ? (
      <div className="space-y-2">
      {f.kept.length === 0 && f.team.length === 0 ? <Empty>None kept yet.</Empty> : f.kept.length > 0 && (
        <ul className="space-y-1.5 text-[8.5pt]">
          {f.kept.map((x) => (
            <li key={x.id} className="keep flex items-start gap-2">
              <KindChip kind={x.kind} />
              <span className="min-w-0">
                <span className="text-[var(--color-text)]">{x.body}{x.hours ? ` (${x.hours} h)` : ""}</span>
                {x.nextTime && <span className="block"><b>Next time:</b> {x.nextTime}</span>}
                <span className="block text-[var(--color-text-muted)]">{applies(x)} · {x.topic}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {f.team.length > 0 && (
        <div className="keep text-[8.5pt]">
          <div className="text-caption font-medium text-[var(--color-text-muted)]">From the team - not reviewed yet</div>
          <ul className="list-disc pl-4">{f.team.map((l, i) => <li key={i}>{l.text}{l.by ? <span className="text-[var(--color-text-muted)]"> - {l.by}</span> : null}</li>)}</ul>
        </div>
      )}
      </div>
    ) : <FindingsReview orgId={f.orgId} projectId={f.projectId} projectType={f.projectType} canEdit={f.canEdit} timeZone={c.tz} />,
    data: () => [
      ...(f.kept.length === 0 && f.team.length === 0 ? [{ k: "empty", text: "None kept yet." } as ExportBlock] : []),
      ...(f.kept.length ? [{
        k: "table", head: ["Type", "What happened", "Next time", "Applies to"],
        rows: f.kept.map((x) => [KIND_WORD[x.kind], `${x.body}${x.hours ? ` (${x.hours} h)` : ""}`, x.nextTime || "", `${applies(x)} · ${x.topic}`]),
      } as ExportBlock] : []),
      ...(f.team.length ? [{ k: "label", text: "From the team - not reviewed yet" } as ExportBlock, { k: "list", items: f.team.map((l) => ({ text: l.text, ...(l.by ? { note: l.by } : {}) })) } as ExportBlock] : []),
    ],
  };
}

/** The close-out on screen in the order it prints and goes out (lib/
 *  phaseReport closeoutPrint, the one rule for all three): where the time
 *  went right under the opening tiles. */
function closeoutOrder(secs: Sec[]): Sec[] {
  const ids = closeoutPrint({ kind: "", project: "", when: "", asOf: "", sections: secs.map((x) => ({ id: x.id, title: x.title, blocks: [] })) }).sections.map((x) => x.id);
  const byId = new Map(secs.map((x) => [x.id, x]));
  return ids.map((id) => (id ? byId.get(id) : undefined)).filter((x): x is Sec => !!x);
}

function closeoutSections(co: ReturnType<typeof buildCloseout>, report: ShiftReport, c: Ctx, cancelled: CancelledJob[], found: Discovery[] = [], lookBack: LookBack | null = null, findings?: FindingsCtx, work?: WorkSummary,
  /** Phases with no schedule yet ("Phase 2: no schedule yet, ..."): the job isn't done. */
  unscheduled: string[] = []): Sec[] {
  const finalStats = [
    { label: unscheduled.length ? "Complete (scheduled)" : "Complete", value: `${co.actualPct}%`, tone: (co.actualPct >= 100 && !unscheduled.length ? "emerald" : "amber") as "emerald" | "amber" },
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
  // Worded as printed and sent (lib/phaseReport closeoutPrint): "Current
  // plan finish …", "791.4 h (33 days) after the original plan".
  const finalSub = [co.finish != null ? `Planned finish ${c.DT(co.finish)}` : null,
    work?.finishedAt != null ? `${unscheduled.length ? "scheduled work " : ""}finished ${c.DT(work.finishedAt)}${work.hoursAfterPlan != null ? ` (${vsPlanWords(work.hoursAfterPlan)})` : ""}` : null,
    ...unscheduled].filter(Boolean).join(" · ") || undefined;
  return [
    {
      id: "final", title: "Final standing", short: "Standing",
      sub: finalSub && closeoutPrint({ kind: "", project: "", when: "", asOf: "", sections: [{ id: "final", title: "", sub: finalSub, blocks: [] }] }).sections[0].sub,
      flag: co.done < co.steps || unscheduled.length ? "amber" : null,
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
      id: "lessons", title: "Hand-back", short: "Hand-back",
      // On paper, room to write what went well and what didn't (on screen
      // that's the Lessons & findings review).
      body: (print) => <Prompts print={print} lines={2} items={[
        "Equipment handed back to operations - isolations removed, blinds out, permits closed",
        "Punch list and turnover documents - what's outstanding and who owns it",
        ...(print ? ["What went well - keep doing", "What didn't - change next time"] : []),
      ]} />,
    },
    // Discovery over the whole job: what was found, the work it added, and
    // what it did to the finish.
    ...(found.length ? [{
      id: "discovery", title: addedTitle(found.map((d) => kindOf(d.record))), short: "Added work",
      // The work as the schedule has it now (estimates revised since count as revised).
      sub: `${found.length} added (${found.reduce((a, d) => a + d.steps.length, 0)} steps) · ${c.hrs(Math.round(found.reduce((a, d) => a + hoursNow(d, c.tz), 0) * 10) / 10)} of work added · ${found.filter((d) => d.record.impact.critical).length} on the critical path`,
      count: found.length,
      flag: null,
      body: (print: boolean) => <DiscoveryList list={found} c={c} print={print} now />,
      data: () => [discoveryBlock(found, c, true)],
    } as Sec] : []),
    // The look back: where the time went, what set the finish, what went
    // well, where to do better.
    ...(lookBack && lookBack.steps.length ? lookBackSections(lookBack, report, c) : []),
    // What went well and what didn't, the team's lessons, the problems in
    // the record: one review, kept for the next job.
    ...(findings ? [findingsSection(findings, c)] : []),
    closeSection("Sign-off", [leadOf(c.word), "Operations", "Safety"]),
  ];
}


/** What a step lost, and why, in words (lib/lookBack lostWords). */
const whyLost = (s: StepLook, c: Ctx): string[] => lostWords(s, c.hrs);

function lookBackSections(lb: LookBack, _report: ShiftReport, c: Ctx): Sec[] {
  const signed = (h: number) => `${h > 0 ? "+" : h < 0 ? "−" : ""}${c.hrs(Math.abs(h))}`;
  const f = lb.finish;
  const stats = [
    // The same words as print and email (lib/phaseReport closeoutPrint):
    // the original plan's finish, and a figure from a forecast says so.
    { label: "Original plan finish", value: c.DTs(f.baseline), tone: "slate" as const },
    { label: f.done ? "Finished" : "Forecast finish", value: c.DTs(f.actual), tone: "slate" as const },
    { label: `${f.done ? "" : "Forecast "}${f.slipH > 0 ? "late by" : "ahead by"}`.replace(/^l|^a/, (x) => x.toUpperCase()), value: withDays(c.hrs(Math.abs(f.slipH))), tone: (f.slipH >= 1 ? "rose" : f.slipH <= -1 ? "emerald" : "slate") as "rose" | "emerald" | "slate" },
    { label: "Steps that lost time", value: `${lb.setbacks.length}`, tone: (lb.setbacks.length ? "amber" : "emerald") as "amber" | "emerald" },
    { label: "Ahead of plan", value: `${lb.ahead.length}`, tone: (lb.ahead.length ? "emerald" : "slate") as "emerald" | "slate" },
  ];
  const max = Math.max(1, ...lb.byCause.map((x) => x.hours));
  // Which plan it is measured against: the baseline as saved, or the
  // schedule as planned when no baseline was saved (lib/lookBack).
  const against = f.basis.kind === "baseline"
    ? `Against the baseline${f.basis.savedAt != null ? ` of ${c.D(f.basis.savedAt)}` : ""}`
    : "Against the schedule as planned (no baseline saved)";
  const basis = `${against} · times as entered${f.done ? "" : " · work still open at its forecast"}`;
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
  const txt = (print: boolean) => (print ? "text-[8.5pt]" : "text-caption");
  const bullets = (items: string[], tone: "emerald" | "amber", print: boolean) => (
    <ul className={`space-y-1 ${txt(print)}`}>
      {items.map((x) => <li key={x} className="flex gap-2"><span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${tone === "emerald" ? "bg-[var(--state-released)]" : "bg-[var(--state-held)]"}`} /><span className="text-[var(--color-text)]">{x}</span></li>)}
    </ul>
  );
  return [
    {
      id: "lookback", title: "Look back - where the time went", short: "Look back",
      sub: basis,
      flag: f.slipH >= 1 ? "amber" : null,
      body: (print) => (
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 keep">
            {stats.map((x) => <Stat key={x.label} label={x.label} value={x.value} tone={x.tone} />)}
          </div>
          {lb.byCause.length > 0 && (
            <div className={`keep rounded-md border border-[var(--color-border)] px-2.5 py-2 space-y-1 ${txt(print)}`}>
              <div className="text-caption font-medium text-[var(--color-text-muted)]">Hours lost, by cause</div>
              {lb.byCause.map((x) => (
                <div key={x.cause} className="grid grid-cols-[minmax(0,15rem)_1fr_auto] items-center gap-2 max-sm:grid-cols-[1fr_auto]">
                  <span className="text-[var(--color-text)] break-words max-sm:col-span-2">{CAUSE_LABEL[x.cause]}</span>
                  <span className="h-2.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden"><span className="block h-full rounded-full bg-[var(--state-held)]" style={{ width: `${Math.round((x.hours / max) * 100)}%` }} /></span>
                  <span className="tabular-nums text-[var(--color-text-muted)]"><b className="text-[var(--color-text)]">{withDays(c.hrs(x.hours))}</b> · {x.steps} step{x.steps === 1 ? "" : "s"}</span>
                </div>
              ))}
              <div className="text-caption text-[var(--color-text-faint)]">Hours each step lost on its own, added up - work runs side by side, so this is more than the finish moved. What moved the finish is under The chain of events.</div>
            </div>
          )}
        </div>
      ),
      data: () => [{ k: "stats", items: stats }, ...(lb.byCause.length ? [{ k: "table", head: ["Cause", "Hours lost", "Steps"], align: ["left", "right", "right"], rows: lb.byCause.map((x) => [CAUSE_LABEL[x.cause], c.hrs(x.hours), `${x.steps}`]) } as ExportBlock] : [])],
    },
    {
      id: "setbacks", title: "What set us back", short: "Set back", count: lb.setbacks.length, flag: lb.setbacks.length ? "amber" : null,
      sub: "Steps that lost the most time on their own - time handed on from the work before isn't counted again",
      body: (print) => setbacks.length === 0 ? <Empty>No step lost an hour or more on its own.</Empty> : (
        <div className={`rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)] ${txt(print)}`}>
          {setbacks.map((s) => (
            <div key={s.id} className={`keep ${print ? "px-1.5 py-1" : "px-2.5 py-1.5"} grid grid-cols-[1fr_auto] gap-x-3`}>
              <div className="min-w-0">
                <b className="text-[var(--color-text)] break-words">{s.name}</b>
                <span className="text-[var(--color-text-muted)]"> · {[s.task, s.wo ? `WO ${s.wo}` : null, s.crew].filter(Boolean).join(" · ")}{s.done ? "" : " · forecast"}</span>
                <div className="text-[var(--color-text-muted)] break-words">{whyLost(s, c).join(" · ")}</div>
              </div>
              <div className="text-right tabular-nums font-medium text-[var(--state-overdue-text)] whitespace-nowrap">{withDays(signed(s.lostH))}</div>
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
      sub: lb.chain.length ? `The work that set the finish, first to last - ${first ? `the slip starts at ${name(first.step)}` : "no step on it lost time"}` : undefined,
      body: (print) => lb.chain.length === 0 ? <Empty>The schedule&apos;s links don&apos;t show a chain into the finish.</Empty> : (
        <ol className={`relative space-y-0 ${txt(print)}`}>
          {chainRows.map((r, k) => r.kind === "fold" ? (
            <li key={`f${k}`} className="pl-5 py-0.5 text-[var(--color-text-faint)] border-l-2 border-dashed border-[var(--color-border-strong)] ml-1.5">
              … {r.n} step{r.n === 1 ? "" : "s"} passed it on, adding nothing
            </li>
          ) : (() => {
            const l = lb.chain[r.i], s = l.step;
            const tone = l.addedH >= 1 ? "text-[var(--state-overdue-text)]" : l.addedH <= -1 ? "text-[var(--state-released-text)]" : "text-[var(--color-text-muted)]";
            return (
              <li key={s.id} className="keep pl-5 py-1 border-l-2 border-[var(--color-border-strong)] ml-1.5 relative">
                <span className={`absolute -left-[5px] top-[9px] h-2 w-2 rounded-full ${l.addedH >= 1 ? "bg-[var(--state-overdue)]" : l.addedH <= -1 ? "bg-[var(--state-released)]" : "bg-[var(--color-border-control)]"}`} />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <b className="text-[var(--color-text)] break-words">{name(s)}</b>
                  <span className={`font-medium tabular-nums ${tone}`}>{l.addedH >= 1 ? `added ${withDays(signed(l.addedH))}` : l.addedH <= -1 ? `made up ${withDays(c.hrs(-l.addedH))}` : "passed it on"}</span>
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
          { t: l.addedH >= 1 ? signed(l.addedH) : l.addedH <= -1 ? `made up ${c.hrs(-l.addedH)}` : "-", tone: l.addedH >= 1 ? "rose" : l.addedH <= -1 ? "emerald" : "muted", bold: true }, l.addedH >= 1 ? whyLost(l.step, c).join(" · ") : ""]),
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
              <div className="px-2.5 py-1 text-caption font-medium text-[var(--color-text-muted)]">Finished ahead of plan</div>
              {lb.ahead.slice(0, 8).map((s) => (
                <div key={s.id} className="px-2.5 py-1 grid grid-cols-[1fr_auto] gap-x-3">
                  <span className="min-w-0 break-words"><b className="text-[var(--color-text)]">{s.name}</b><span className="text-[var(--color-text-muted)]"> · {[s.task, s.crew].filter(Boolean).join(" · ")}</span></span>
                  <span className="tabular-nums font-medium text-[var(--state-released-text)] whitespace-nowrap">{c.hrs(-s.finishH)} early</span>
                </div>
              ))}
            </div>
          )}
          {lb.absorbed.length > 0 && <div className={`text-[var(--color-text)] ${txt(print)}`}>Discovery that fit in the float: {lb.absorbed.map((d) => `“${d.record.what}” (${c.hrs(d.record.impact.hours)})`).join("; ")}.</div>}
          {lb.crews.length > 0 && (
            <div className={`keep rounded-md border border-[var(--color-border)] ${txt(print)}`}>
              <div className="px-2.5 py-1 text-caption font-medium text-[var(--color-text-muted)]">Crews - steps done on plan</div>
              {lb.crews.map((x) => (
                <div key={x.crew} className="px-2.5 py-0.5 grid grid-cols-[1fr_auto_auto] gap-x-3 tabular-nums">
                  <span className="text-[var(--color-text)] truncate">{x.crew}</span>
                  <span className="text-[var(--color-text-muted)]">{x.onPlan} of {x.done} on plan</span>
                  <span className={`font-medium ${x.done && x.onPlan === x.done ? "text-[var(--state-released-text)]" : "text-[var(--color-text-muted)]"}`}>{Math.round((x.onPlan / x.done) * 100)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ),
      data: () => [
        ...(lb.keep.length ? [{ k: "list", items: lb.keep.map((t) => ({ text: t })) } as ExportBlock] : []),
        ...(lb.ahead.length ? [{ k: "table", head: ["Finished ahead of plan", "Crew", "Early"], align: ["left", "left", "right"], rows: lb.ahead.slice(0, 8).map((s) => [{ t: s.name, note: s.task || undefined }, s.crew, { t: c.hrs(-s.finishH), tone: "emerald", bold: true }]) } as ExportBlock] : []),
        ...(lb.crews.length ? [{ k: "table", head: ["Crew", "On plan", ""], align: ["left", "right", "right"], rows: lb.crews.map((x) => [x.crew, `${x.onPlan} of ${x.done}`, `${Math.round((x.onPlan / x.done) * 100)}%`]) } as ExportBlock] : []),
      ],
    },
    {
      id: "improve", title: "Where we can improve", short: "Improve", count: lb.improve.length || undefined, flag: lb.improve.length ? "amber" : null,
      sub: "What the record says to change next time",
      body: (print) => (
        <div className="space-y-2">
          {lb.improve.length ? bullets(lb.improve, "amber", print) : <Empty>Nothing in the record stands out.</Empty>}
        </div>
      ),
      data: () => [...(lb.improve.length ? [{ k: "list", items: lb.improve.map((t) => ({ text: t })) } as ExportBlock] : [{ k: "empty", text: "Nothing in the record stands out." } as ExportBlock])],
    },
  ];
}

/** Jobs taken off this schedule that still get done somewhere else —
 *  with the note and where they went, so none is forgotten. */
function cancelledSection(jobs: CancelledJob[], c: Ctx): Sec {
  const when = (j: CancelledJob) => [j.at != null && Number.isFinite(j.at) ? c.D(j.at) : null, j.m.cancelledByName].filter(Boolean).join(" · ");
  const title = (j: CancelledJob) => (j.crumbs.length ? `${j.crumbs[j.crumbs.length - 1]}: ${j.m.name}` : j.m.name);
  const byWay = new Map<string, CancelledJob[]>();
  for (const j of jobs) { const k = `${j.m.movedTo || "-"}\u0000${j.m.cancelNote || ""}`; byWay.set(k, [...(byWay.get(k) ?? []), j]); }
  const groups = [...byWay.values()];
  return {
    id: "cancelled", title: "Cancelled from this schedule", short: "Cancelled", count: jobs.length, flag: "amber",
    sub: "Still to be done: moved off this schedule",
    // Jobs cancelled the same way (moved to the same place, with the same
    // note) are one card that counts them and still names each, as they
    // print and go out (lib/phaseReport closeoutPrint).
    body: (print) => (
      <div className={`rounded-md border border-[var(--color-border)] border-l-2 border-l-amber-500 divide-y divide-[var(--color-border)] ${print ? "text-[8.5pt]" : "text-caption"}`}>
        {groups.map((g) => {
          const j = g[0];
          const names = new Map<string, number>();
          for (const x of g) names.set(title(x), (names.get(title(x)) ?? 0) + 1);
          return (
            <div key={j.m.id ?? j.m.name} className={`keep ${print ? "px-1.5 py-1" : "px-2.5 py-2"} flex flex-col gap-0.5`}>
              {g.length > 1 ? (
                <>
                  <b className="text-[var(--color-text)]">{g.length} jobs</b>
                  <div className="text-[var(--color-text)] break-words">{[...names].map(([n, k]) => (k > 1 ? `${n} (${k} times)` : n)).join("; ")}</div>
                </>
              ) : (
                <div className="flex items-baseline gap-x-2 flex-wrap">
                  <b className="text-[var(--color-text)]">{title(j)}</b>
                  {j.crumbs.length > 1 && <span className="text-caption text-[var(--color-text-faint)]">{j.crumbs.slice(0, -1).join(" › ")}</span>}
                  {j.steps > 1 && <span className="text-caption text-[var(--color-text-muted)]">{j.steps} steps</span>}
                </div>
              )}
              <div className="text-[var(--color-text)]">
                <span className="text-caption font-medium text-[var(--state-held-text)]">Moved to </span>
                {j.m.movedTo ? <b>{j.m.movedTo}</b> : <span className="text-[var(--color-text-faint)]">not said</span>}
              </div>
              {j.m.cancelNote && <div className="text-[var(--color-text-muted)] italic">“{j.m.cancelNote}”</div>}
              <div className="text-caption print:text-caption text-[var(--color-text-faint)]">Cancelled {[...new Set(g.map(when).filter(Boolean))].join("; ")}</div>
            </div>
          );
        })}
      </div>
    ),
    data: () => [{
      k: "table", head: ["Job", "Moved to", "Note", "Cancelled"],
      rows: jobs.map((j) => [title(j), j.m.movedTo || "-", j.m.cancelNote || "", when(j)]),
    }],
  };
}

function closeSection(title: string, signers: string[], sub = "Notes, actions and sign-off", notes?: (print: boolean) => React.ReactNode): Sec {
  return {
    id: "close", title, short: title, sub,
    body: (print) => (
      // On paper two framed boxes; on screen two plain columns on the card.
      <div className={`grid grid-cols-1 sm:grid-cols-2 keep ${print ? "gap-2" : "gap-x-6 gap-y-4"}`}>
        <div className={print ? "rounded-md border border-[var(--color-border)] px-2.5 py-1.5" : ""}>
          <div className={print ? "text-caption font-medium text-[var(--color-text-muted)]" : "mb-1 text-body font-medium text-[var(--color-text-muted)]"}>Notes &amp; actions</div>
          {notes ? notes(print) : Array.from({ length: print ? 4 : 3 }).map((_, i) => <div key={i} className="h-5 border-b border-dotted border-[var(--color-border-strong)]" />)}
        </div>
        <div className={print ? "rounded-md border border-[var(--color-border)] px-2.5 py-1.5 space-y-2" : "space-y-2"}>
          <div className={print ? "text-caption font-medium text-[var(--color-text-muted)]" : "text-body font-medium text-[var(--color-text-muted)]"}>Sign-off</div>
          {signers.map((who) => (
            <div key={who} className="flex items-end gap-2 text-caption text-[var(--color-text-muted)]">
              <span className="w-40 shrink-0">{who}</span>
              <span className="flex-1 border-b border-[var(--color-border-strong)]" />
              <span className="w-12 border-b border-[var(--color-border-strong)] text-center text-caption print:text-caption">time</span>
            </div>
          ))}
        </div>
      </div>
    ),
  };
}

// ─── Masthead & footnote ─────────────────────────────────────────────

function Masthead({ meeting, report, kickoff, closeout, ctx: c, asOf, now, rehearsal, historyNote, projectName, print, crew, addedOnly, criticalOnly, classOnly, kindShown = true, lock }: {
  meeting: MeetingKind; report: ShiftReport; kickoff: ReturnType<typeof buildKickoff>; closeout: ReturnType<typeof buildCloseout>;
  ctx: Ctx; asOf: number; now: number; rehearsal: boolean; historyNote: string | null; projectName?: string; print: boolean;
  /** The crew the report is narrowed to. */
  crew?: string | null;
  addedOnly?: boolean;
  criticalOnly?: boolean;
  /** Narrowed to a unit or equipment type: its name ("Exchangers"). */
  classOnly?: string | null;
  /** Say which meeting it is (off where the screen already says it). */
  kindShown?: boolean;
  /** On screen, at the line's end: the report's lock. */
  lock?: React.ReactNode;
}) {
  // No verdict badge here: Where we stand gives it (and the close-out's
  // tiles count what's open) - each number once.
  const { shift, next } = report;
  const title = meeting === "kickoff" ? "Kick-off meeting" : meeting === "closeout" ? "Close-out meeting" : "Shift turnover";
  const when = meeting === "turnover"
    ? <>{shiftName(shift)} {c.D(shift.start)} {c.win(shift)} <span className="opacity-60">→</span> <b>{shiftName(next)} {c.D(next.start)} {c.win(next)}</b></>
    : meeting === "kickoff"
      ? <>{kickoff.start != null ? <>Job starts <b>{c.DL(kickoff.start)} {c.T(kickoff.start)}</b> · {kickoff.daysTotal} days</> : "No dated work yet"}</>
      : <>{closeout.finish != null ? <>Planned finish <b>{c.DT(closeout.finish)}</b></> : null}</>;
  const chip = (text: React.ReactNode, tone: "plain" | "bad" = "plain") => (
    <span className={`ml-2 whitespace-nowrap px-1.5 py-0.5 rounded text-caption print:text-caption font-medium ${print
      ? tone === "bad" ? "border border-[var(--state-overdue)] text-[var(--state-overdue-text)]" : "border border-slate-700 text-slate-900"
      : tone === "bad" ? "bg-transparent text-[var(--state-overdue-text)]" : "border border-[var(--color-border-strong)] text-[var(--color-text)]"}`}>{text}</span>
  );
  const marks = meeting === "turnover" && (
    <>
      {crew && chip(<>{crew} only</>)}
      {criticalOnly && chip("Critical path only", "bad")}
      {addedOnly && chip(<>Discovery &amp; added only</>)}
      {classOnly && chip(<>{classOnly} only</>)}
      {rehearsal && (print
        ? <span className="ml-2 px-1.5 py-0.5 rounded text-caption print:text-caption font-medium border border-[var(--state-held)] text-[var(--state-held-text)]">Rehearsal: shift not started</span>
        : <span className="ml-2 inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-[var(--state-held-text)]"><span aria-hidden className="w-[7px] h-[7px] rounded-full bg-[var(--state-held)]" />Rehearsal: shift not started</span>)}
      {historyNote && (print
        ? <span className="ml-2 px-1.5 py-0.5 rounded text-caption print:text-caption font-medium border border-slate-500 text-slate-700">Earlier shift: {historyNote}</span>
        : <span className="ml-2 text-[var(--color-text)]"><span className="font-medium">Earlier shift:</span> {historyNote}</span>)}
    </>
  );
  // On screen: one line under the toolbar, the shifts and the time, the
  // report's lock at its end (the page header already names the project).
  if (!print) return (
    <header className="px-3 sm:px-4 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <div className="min-w-0 flex-1 text-body text-[var(--color-text)]">
        {kindShown && <span className="font-medium text-[var(--color-text-muted)]">{title}: </span>}
        {when}
        <span className="text-[var(--color-text-muted)]"> · as of {c.T(meeting === "turnover" ? asOf : now)} {tzAbbrev(c.tz, now)}</span>
        {marks}
      </div>
      {lock}
    </header>
  );
  // On paper: the project's name in a dark band.
  return (
    <header className="pb-1.5 border-b-2 border-slate-900">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-caption font-medium text-slate-500">{title}</span>
        <h2 className="text-[14pt] font-medium tracking-tight leading-tight truncate">{projectName ?? "Schedule"}</h2>
      </div>
      <div className="text-caption text-slate-700">
        {when} · as of {c.T(meeting === "turnover" ? asOf : now)} {tzAbbrev(c.tz, now)}
        {marks}
      </div>
    </header>
  );
}

function Footnote({ meeting, ctx: c, asOf, now, projectName }: { meeting: MeetingKind; ctx: Ctx; asOf: number; now: number; projectName?: string }) {
  return (
    <footer className="pt-2 mt-2 border-t border-[var(--color-border)] text-caption print:text-caption text-[var(--color-text-faint)] flex justify-between gap-3 flex-wrap">
      <span>
        {meeting === "turnover" ? `Plan % = work the schedule expected done by ${c.DT(asOf)}, hour-weighted; actual % = progress entered. Gap = the difference in planned work-hours. ` : ""}
        Critical = on the chain that drives the finish date. Hours are planned work-hours. Behind {SEVERE_BEHIND_H} h or more shows red; less, amber.
      </span>
      <span className="shrink-0">Printed {c.DT(now)}{projectName ? ` · ${projectName}` : ""}</span>
    </footer>
  );
}

// ─── Building blocks ─────────────────────────────────────────────────

function SectionHead({ n, s, collapsed, big, print, onPath, onToggle }: { n: number; s: Sec; collapsed?: boolean; big?: boolean; print?: boolean;
  /** On screen, on the report's path: the number is on the line, so here
   *  the name (which folds the section, its arrow beside it), the "?" with
   *  why it's there, and a short line. */
  onPath?: boolean; onToggle?: () => void }) {
  if (onPath && !print && !big) return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-h-6">
      <button type="button" onClick={onToggle} aria-expanded={!collapsed}
        className="min-w-0 inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 -ml-1 px-1 rounded-md text-left hover:bg-[var(--color-surface-2)]">
        <span className="min-w-0 font-display text-section font-semibold text-[var(--color-text)] leading-6">{s.title}</span>
        <ChevronDown aria-hidden className={`w-4 h-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${collapsed ? "-rotate-90" : ""}`} />
      </button>
      {s.help && <HelpTooltip>{s.help}</HelpTooltip>}
      {s.sub && <span className="min-w-0 text-body text-[var(--color-text-muted)]">{s.sub}</span>}
    </div>
  );
  return (
    <div className={`flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 ${print ? "pb-[2px] border-b-[1.5px] border-slate-900" : "pb-1.5 border-b-2 border-[var(--color-text)]"}`}>
      <span className={`${big ? "w-7 h-7 text-body" : print ? "w-4 h-4 text-[7.5pt]" : "w-5 h-5 text-caption"} self-center rounded-full bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900 font-medium flex items-center justify-center shrink-0`}>{n}</span>
      <span className={`${big ? "text-section" : print ? "text-[11pt]" : "text-body"} min-w-0 font-bold tracking-tight`}>{s.title}</span>
      {big && s.help && <span className="self-center"><HelpTooltip>{s.help}</HelpTooltip></span>}
      {s.sub && <span className={`min-w-0 ${big ? "text-body" : print ? "text-[8pt]" : "text-caption"} text-[var(--color-text-muted)]`}>{s.sub}</span>}
      {!print && !big && <ChevronDown className={`ml-auto self-center w-4 h-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${collapsed ? "-rotate-90" : ""}`} />}
    </div>
  );
}

/** Where the job stands. On screen: the one number that needs action
 *  big (steps overdue, with its scope said in the page header's words; with
 *  none overdue, the verdict's own number when it is bad), then the status
 *  sentence, then the rest small on one line. On paper: the sentence, then
 *  four tiles. Colour only on a number that's off. */
function StandTiles({ actual, planned, standing, gap, done, total, pastDue, pastDueHeld = 0, pastDueLabel, pastDueScope, say, print }: {
  actual: number; planned: number; standing: "ahead" | "on track" | "behind"; gap: { label: string; value: string };
  done: number; total: number; pastDue: number; pastDueHeld?: number; pastDueLabel: string; print: boolean;
  /** Where the overdue count is counted: "across the work, all crews". */
  pastDueScope?: string;
  /** The status in one sentence (the email's too). */
  say?: StandSay;
}) {
  const tile = `rounded-lg border border-[var(--color-border)] ${print ? "px-2 py-1" : "px-3 py-2"}`;
  const label = `font-medium text-[var(--color-text-muted)] ${print ? "text-[7.5pt]" : "text-caption"}`;
  const value = `font-bold tracking-tight tabular-nums leading-tight ${print ? "text-[14pt]" : "text-section"}`;
  const small = `font-medium text-[var(--color-text-muted)] ${print ? "text-[8pt]" : "text-body"}`;
  const sub = `text-[var(--color-text-muted)] ${print ? "text-[7pt]" : "text-caption"}`;
  const gapTone = standing === "behind" ? "text-[var(--state-overdue-text)]" : standing === "ahead" ? "text-[var(--state-released-text)]" : "";
  const sayWord = say ? say.label[0] + say.label.slice(1).toLowerCase() : "";
  const sayDot = say?.tone === "rose" ? "var(--state-overdue)" : say?.tone === "emerald" ? "var(--state-released)" : "var(--color-text-faint)";
  const pastDueSub = `steps past their finish${pastDueScope ? `, ${pastDueScope}` : ""}${pastDueHeld ? `; ${pastDueHeld} on hold or blocked` : ""}`;
  if (!print) {
    // The one big number: what needs someone now. Never a zero.
    const hero = pastDue > 0 ? { n: String(pastDue), words: `step${pastDue === 1 ? "" : "s"} overdue`, sub: pastDueSub, tone: "text-[var(--state-held-text)]" }
      : say?.bad ? { n: say.key, words: sayWord.toLowerCase(), sub: null, tone: "text-[var(--state-overdue-text)]" } : null;
    return (
      <div className="space-y-3 keep">
        {hero && (
          <div>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={`font-display text-title font-bold tabular-nums leading-none whitespace-nowrap ${hero.tone}`}>{hero.n}</span>
              <span className="text-reading font-medium text-[var(--color-text)]">{hero.words}</span>
            </div>
            {hero.sub && <div className="mt-1 text-body text-[var(--color-text-muted)]">{hero.sub[0].toUpperCase() + hero.sub.slice(1)}</div>}
          </div>
        )}
        {say && (
          <p className="flex items-start gap-2 text-reading text-[var(--color-text)]">
            <span aria-hidden className="mt-2 w-2 h-2 shrink-0 rounded-full" style={{ background: sayDot }} />
            <span><b className="font-semibold">{sayWord}.</b> {say.text}</span>
          </p>
        )}
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2">
          <div className="min-w-0">
            <dt className="text-body text-[var(--color-text-muted)]">Progress</dt>
            <dd className="text-body font-medium tabular-nums">{actual}% <span className="font-normal text-[var(--color-text-muted)]">of {planned}% planned</span></dd>
            <div className="relative mt-1.5 h-1.5 rounded-full bg-[var(--color-surface-2)]" aria-hidden>
              <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-main)]" style={{ width: `${Math.min(100, actual)}%` }} />
              <div className={`absolute -top-[3px] w-0.5 h-3 ${standing === "behind" ? "bg-[var(--state-overdue)]" : "bg-[var(--color-text-muted)]"}`} style={{ left: `calc(${Math.min(100, planned)}% - 1px)` }} />
            </div>
          </div>
          <div className="min-w-0">
            <dt className="text-body text-[var(--color-text-muted)]">{gap.label}</dt>
            <dd className={`text-body font-medium tabular-nums ${gapTone}`}>{gap.value}</dd>
            <dd className="text-caption text-[var(--color-text-muted)]">{standing === "behind" ? "planned work-hours not done" : standing === "ahead" ? "work-hours done early" : "planned work-hours, either way"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-body text-[var(--color-text-muted)]">Steps done</dt>
            <dd className="text-body font-medium tabular-nums">{done} <span className="font-normal text-[var(--color-text-muted)]">of {total}</span></dd>
            <dd className="text-caption text-[var(--color-text-muted)]">all crews, whole job</dd>
          </div>
          {pastDue === 0 && (
            <div className="min-w-0">
              <dt className="text-body text-[var(--color-text-muted)]">{pastDueLabel}</dt>
              <dd className="text-body font-medium">None</dd>
              <dd className="text-caption text-[var(--color-text-muted)]">{pastDueSub}</dd>
            </div>
          )}
        </dl>
      </div>
    );
  }
  return (
    <>
    {say && <div className="keep" style={{ marginBottom: 4 }}><b>{sayWord}.</b> {say.text}</div>}
    <div className={`grid grid-cols-2 sm:grid-cols-4 ${print ? "gap-1.5" : "gap-2"} keep`}>
      <div className={tile}>
        <div className={label}>Progress</div>
        <div className={value}>{actual}% <span className={small}>of {planned}% planned</span></div>
        <div className="relative mt-1.5 h-1.5 rounded-full bg-[var(--color-border)]" aria-hidden>
          <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-main)]" style={{ width: `${Math.min(100, actual)}%` }} />
          <div className={`absolute -top-[3px] w-0.5 h-3 ${standing === "behind" ? "bg-[var(--state-overdue)]" : "bg-[var(--color-text-muted)]"}`} style={{ left: `calc(${Math.min(100, planned)}% - 1px)` }} />
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
        <div className={`${value} ${pastDue ? "text-[var(--state-held-text)]" : ""}`}>{pastDue}</div>
        <div className={sub}>{pastDueSub}</div>
      </div>
    </div>
    </>
  );
}


/** Why it's behind: the hours of work behind by cause — found work, added
 *  scope, holds, or late / slow with nothing in the way — then what holds
 *  each chain up and the steps waiting on it (lib/behindWhy). */
function WhyBehind({ why, c, print }: { why: BehindWhy; c: Ctx; print: boolean }) {
  const [all, setAll] = useState(false);
  const h = (x: number) => c.hrs(Math.round(x * 10) / 10);
  // Every chain, biggest first: the top six on screen, the rest a tap away.
  const list = why.chains;
  const shown = !print && !all ? list.slice(0, 6) : list;
  const more = why.chains.length - shown.length;
  const text = print ? "text-[8pt]" : "text-caption";
  const small = print ? "text-[7.5pt]" : "text-caption";
  // A cause: a dot and its word; red only for the one that needs someone.
  const tag = (flag: boolean) => (flag ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text-muted)]");
  const dot = (flag: boolean) => <span aria-hidden className="w-1.5 h-1.5 rounded-full shrink-0 print:hidden" style={{ background: flag ? "var(--state-overdue)" : "var(--color-text-faint)" }} />;
  return (
    <div className={print ? "mt-2 rounded-lg border border-[var(--color-border)] px-2 py-1.5 keep" : "mt-4 pt-3 border-t border-[var(--color-border)] keep"}>
      <div className={`font-medium ${print ? "text-[9pt]" : "text-body"}`}>{whyTitle(why, c.hrs)}</div>
      {/* Hours behind by cause, as labelled figures. */}
      <dl className={`mt-1.5 flex flex-wrap gap-x-6 gap-y-1 ${print ? small : "text-body"}`}>
        {labelHours(why).map((x) => (
          <div key={x.short} className="inline-flex items-baseline gap-1.5">
            <dt className={`inline-flex items-center gap-1.5 self-center ${tag(x.flag)}`}>{dot(x.flag)}{x.short[0].toUpperCase() + x.short.slice(1)}</dt>
            <dd className={`font-display font-semibold tabular-nums ${x.flag ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"} ${print ? "" : "text-reading"}`}>{h(x.hours)}</dd>
          </div>
        ))}
      </dl>
      {shown.length > 0 && (
        <ul className={`mt-2 divide-y divide-[var(--color-border)] ${text}`}>
          {shown.map((ch) => {
            const t = chainText(ch, c);
            const l = chainLabel(ch);
            return (
              <li key={ch.head.id} className="py-1.5 flex items-start gap-2">
                <span className={`shrink-0 w-24 mt-px inline-flex items-center gap-1.5 font-medium ${small} ${tag(l.flag)}`}>{dot(l.flag)}{l.short[0].toUpperCase() + l.short.slice(1)}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-[var(--color-text)] break-words">{t.title} <span className="font-normal text-[var(--color-text-muted)]">- {t.state}</span></div>
                  {t.facts && <div className="text-[var(--color-text-muted)] break-words">{t.facts}</div>}
                  {t.waiting && <div className="text-[var(--color-text-muted)] break-words">{t.waiting}</div>}
                  {t.split && <div className={`${small} text-[var(--color-text-faint)]`}>{t.split}</div>}
                </div>
                <span className={`shrink-0 font-bold font-display tabular-nums ${l.flag ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text-muted)]"}`}>{h(ch.hours)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {!print && more > 0 && !all && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 h-8 px-2.5 -ml-2.5 rounded-lg text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] print:hidden">
          Show {more} more
        </button>
      )}
      {all && (
        <button type="button" onClick={() => setAll(false)} className="mt-1 text-body hover:underline print:hidden text-[var(--color-accent-text)]">Show fewer</button>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "emerald" | "rose" | "amber" | "slate" }) {
  const t = tone === "emerald" ? "text-[var(--state-released-text)]" : tone === "rose" ? "text-[var(--state-overdue-text)]" : tone === "amber" ? "text-[var(--state-held-text)]" : "text-[var(--color-text)]";
  return (
    // On screen a compact label and value (no big numbers); on paper the
    // framed tile it always was (print: classes).
    <div className="min-w-0 print:rounded-lg print:border print:border-slate-200 print:px-3 print:py-1.5">
      <div className="text-body font-medium text-[var(--color-text-muted)] print:normal-case print:tracking-normal print:font-medium print:text-slate-500">{label}</div>
      <div className={`mt-0.5 print:mt-0 text-body print:text-section font-bold leading-tight tabular-nums ${t}`}>{value}</div>
    </div>
  );
}

/** What the schedule had for the next shift that isn't on its plan: one
 *  line, the steps a tap away (in print, the line only). */
function OffPlan({ text, rows, print, c }: { text: string; rows: ShiftRow[]; print: boolean; c: Ctx }) {
  const [open, setOpen] = useState(false);
  if (print) return <div className="text-caption text-[var(--color-text-muted)]">{text}</div>;
  return (
    <div className="text-caption text-[var(--color-text-muted)]">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-start gap-1 text-left hover:text-[var(--color-text)]">
        <ChevronDown className={`w-3.5 h-3.5 mt-px shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} /> <span>{text}</span>
      </button>
      {open && (
        <ul className="mt-1 ml-5 space-y-0.5">
          {rows.map((r) => (
            <li key={r.leaf.id ?? r.leaf.name} className="break-words">
              <b className="text-[var(--color-text)]">{r.leaf.name}</b>
              {r.parentName ? ` · ${r.parentName}` : ""}{r.leaf.workOrderRef ? ` · WO ${r.leaf.workOrderRef}` : ""}
              {` · ${r.leaf.responsibleParty?.trim() || "no crew named"} · ${r.carryOver ? `was due ${c.DTs(r.dueAt)}` : `planned ${c.DTs(r.start)}`}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-1 text-caption text-[var(--color-text-muted)] italic">{children}</div>;
}

function Blank({ print }: { print: boolean }) {
  return <span className={`inline-block ${print ? "w-28" : "w-24"} border-b border-dotted border-[var(--color-border-strong)]`}>&nbsp;</span>;
}

/** Talking points the meeting covers, with a box to tick. */
function Prompts({ items, print, lines = 0, cols = 2 }: { items: string[]; print: boolean; lines?: number; cols?: 2 | 3 }) {
  return (
    <ul className={`grid ${lines ? "grid-cols-1" : cols === 3 ? "grid-cols-1 sm:grid-cols-3 print:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"} gap-x-4 gap-y-1 keep`}>
      {items.map((t) => (
        <li key={t} className="text-caption">
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
/** A step's kind or state, said as a dot and a word (never a filled box):
 *  the dot in the state's color, the word colored only when it needs
 *  someone. */
function TagChip({ t, tone }: TagT) {
  const dot = tone === "rose" ? "var(--state-overdue)" : tone === "amber" ? "var(--state-held)" : tone === "emerald" ? "var(--state-released)" : tone === "violet" ? "var(--color-current)" : "var(--color-text-faint)";
  const text = tone === "rose" ? "text-[var(--state-overdue-text)] font-medium" : tone === "amber" ? "text-[var(--state-held-text)] font-medium" : "text-[var(--color-text-muted)]";
  return (
    <span className={`inline-flex items-center gap-1 max-w-full whitespace-nowrap text-caption print:text-caption align-middle ${text}`}>
      <span aria-hidden className="w-1.5 h-1.5 rounded-full shrink-0 print:hidden" style={{ background: dot }} />{t.charAt(0).toUpperCase() + t.slice(1)}
    </span>
  );
}

/** Work on the chain that drives the finish: a red dot and the word. */
function CriticalTag({ print }: { print?: boolean }) {
  return <span className={`ml-2 inline-flex items-center gap-1 font-medium leading-snug text-[var(--state-overdue-text)] align-[1px] ${print ? "text-[7pt]" : "text-caption"}`}><span aria-hidden className="w-1.5 h-1.5 rounded-full bg-[var(--state-overdue)] print:hidden" />Critical</span>;
}

/** What's going on with a step, as one quiet line: how far behind (red only
 *  past most of a shift), late, what it waits on — the first word capitalised. */
const TONE_TEXT: Record<TagTone, string> = {
  rose: "text-[var(--state-overdue-text)] font-medium",
  amber: "text-[var(--state-held-text)] font-medium",
  emerald: "text-[var(--state-released-text)] font-medium",
  muted: "text-[var(--color-text-muted)]",
  wait: "text-[var(--color-text-muted)]",
  violet: "text-[var(--color-text)] font-medium",
};
function StatusLine({ tags, print }: { tags: TagT[]; print?: boolean }) {
  if (!tags.length) return null;
  return (
    <div className={`mt-0.5 leading-snug ${print ? "text-[7.5pt]" : "text-caption"}`}>
      {tags.map((t, i) => (
        <span key={`${t.t}${i}`} className={TONE_TEXT[t.tone]}>
          {i > 0 && <span className="mx-1.5 font-normal text-[var(--color-text-faint)]" aria-hidden>·</span>}
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
  return <span className="inline-block min-w-[14px] text-right font-display text-caption text-[var(--color-text-muted)] tabular-nums">{n}</span>;
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
    ? <><b className="font-medium text-[var(--color-text)]">{m[1]}</b> · {m[2]}</>
    : <b className="font-medium text-[var(--color-text)]">{title}</b>;
}

/** "25% · goal 100%": where it is, a thin bar, and the shift's goal marked. */
function Progress({ right, print }: { right: string; print?: boolean }) {
  const m = /^(\d+)%(?: · goal (\d+)%)?$/.exec(right.trim());
  if (!m) return <span className={`font-display tabular-nums font-semibold text-[var(--color-text)] ${print ? "text-[8pt]" : "text-caption"}`}>{right}</span>;
  const pct = Math.min(100, +m[1]), goal = m[2] != null ? Math.min(100, +m[2]) : null;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className={`font-display tabular-nums font-semibold text-[var(--color-text)] whitespace-nowrap ${print ? "text-[8pt]" : "text-caption"}`}>
        {pct}%{goal != null && <span className="font-normal text-[var(--color-text-muted)]"> → {goal}%</span>}
      </span>
      <span className={`relative block h-1 rounded-full bg-[var(--color-border)] ${print ? "w-16" : "w-20"}`} aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-main)]" style={{ width: `${pct}%` }} />
        {goal != null && <span className="absolute -top-[3px] w-0.5 h-2.5 bg-[var(--color-text-muted)]" style={{ left: `calc(${goal}% - 1px)` }} />}
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
      className={`text-left hover:underline decoration-dotted underline-offset-2 ${r.done ? "line-through text-[var(--color-text-faint)]" : cls}`}>{r.name}</button>
  ) : <span className={r.done ? "line-through text-[var(--color-text-faint)]" : cls}>{r.name}</span>;
  const cell = print ? "px-1 py-[3px]" : "px-2 py-2";
  const taskCls = `font-medium text-[var(--color-text)] ${print ? "text-[9pt]" : "text-body"}`;
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
              <div className="group/sort pb-1 border-b border-[var(--color-border-strong)] text-caption font-medium text-[var(--color-text)]">
                <Grip props={grip(list.map((x) => x.id), g.title)} />
                <GroupTitle title={g.title} />
                {g.meta && <div className="text-caption font-normal text-[var(--color-text-muted)]">{g.meta}</div>}
              </div>
            )}
            {list.map((r) => (
              <div key={r.id} data-sort-id={r.id} className={`group/sort py-2.5 border-b border-[var(--color-border)] ${moving(r.id) ? "opacity-40" : ""}`}>
                <div className="flex items-start gap-2">
                  <Grip props={grip([r.id], r.name)} className="mt-0.5 ml-0" />
                  {box && <span className="pt-1"><Box /></span>}
                  {r.n && <span className="pt-0.5"><Num n={r.n.num} /></span>}
                  <div className="flex-1 min-w-0">
                    <div className="text-body leading-snug">
                      {flat && r.group.title && <span className="text-[var(--color-text-muted)]">{r.group.title} › </span>}
                      {nameOf(r, "font-medium text-[var(--color-text)]")}{critical(r) && <CriticalTag />}{edit(r)}
                    </div>
                    <StatusLine tags={statusOf(r)} />
                    <div className="mt-1 text-caption text-[var(--color-text-muted)]">
                      {[!crew && r.who ? r.who : null, r.when, r.wo ? `WO ${r.wo}` : null].filter(Boolean).join(" · ")}
                    </div>
                    {r.note && <div className="text-caption italic text-[var(--color-text-muted)] mt-0.5">{r.note}</div>}
                    {r.why && <div className="text-caption italic font-medium text-[var(--state-held-text)] mt-0.5">Why behind: {r.why}</div>}
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
      <table className={`w-full border-collapse table-fixed ${print ? "text-[8pt]" : "text-caption"}`}>
        <thead>
          <tr className={`text-left font-medium text-[var(--color-text-muted)] border-b border-[var(--color-border-strong)] ${print ? "text-[7.5pt]" : "text-caption"}`}>
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
                <tr className="group/sort border-b border-[var(--color-border-strong)]">
                  <td colSpan={cols} className={`${print ? "px-1 pt-[7px] pb-[2px] text-[8pt]" : "px-2 pt-3.5 pb-1 text-caption"} font-medium text-[var(--color-text)]`}>
                    <Grip props={grip(list.map((x) => x.id), g.title)} />
                    <GroupTitle title={g.title} />
                    {g.meta && <span className={`float-right font-normal text-[var(--color-text-muted)] ${print ? "text-[7.5pt]" : "text-caption"}`}>{g.meta}</span>}
                  </td>
                </tr>
              )}
              {list.map((r) => (
                <React.Fragment key={r.id}>
                  <tr data-sort-id={r.id} className={`group/sort border-b border-[var(--color-border)] align-top ${moving(r.id) ? "opacity-40" : ""}`}>
                    {box && <td className={cell}><Box /></td>}
                    {hasN && <td className={`${cell} text-right`}>{r.n ? <Num n={r.n.num} /> : null}</td>}
                    <td className={cell}>
                      <div className="leading-snug">
                        {flat && r.group.title && <span className="text-[var(--color-text-muted)]">{r.group.title} › </span>}
                        <Grip props={grip([r.id], r.name)} />
                        {nameOf(r, taskCls)}{critical(r) && <CriticalTag print={print} />}{edit(r)}
                        {!print && r.inline && <span className="ml-2 align-middle">{r.inline}</span>}
                      </div>
                      <StatusLine tags={statusOf(r)} print={print} />
                      {r.note && <div className={`italic text-[var(--color-text-muted)] mt-0.5 ${print ? "text-[7.5pt]" : "text-caption"}`}>{r.note}</div>}
                      {r.why && <div className={`italic font-medium text-[var(--state-held-text)] mt-0.5 ${print ? "text-[7.5pt]" : "text-caption"}`}>Why behind: {r.why}</div>}
                      {ownerLine && <div className="text-caption print:text-caption text-slate-500 mt-0.5">Owner / decision: <span className="inline-block w-44 border-b border-dotted border-slate-400 align-baseline">&nbsp;</span></div>}
                    </td>
                    {hasWhen && <td className={`${cell} text-[var(--color-text)] break-words`}>{r.when}</td>}
                    {hasWho && <td className={`${cell} font-medium text-[var(--color-text)] truncate`} title={r.who}>{r.who}</td>}
                    {hasWo && <td className={`${cell} font-display tabular-nums text-[var(--color-text-muted)] truncate ${print ? "text-[7.5pt]" : "text-caption"}`}>{r.wo}</td>}
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
    <button type="button" onClick={onClick} aria-label={`Update ${label}`} title="Update this step - status, %, time, comment"
      className="ui-hit ml-1 inline-flex items-center justify-center w-5 h-5 align-middle rounded text-[var(--color-text-faint)] opacity-50 group-hover/sort:opacity-100 pointer-coarse:opacity-100 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus:opacity-100 print:hidden">
      <Pencil className="w-3 h-3" />
    </button>
  );
}

/** What got done, one row per work order: a table where there's room;
 *  on a phone, a short card each — nothing to scroll sideways for. */
type DoneTask = ReturnType<typeof doneByTask>[number];

/** What a task did this shift, in two labeled lines: the step done last and
 *  the one still going (each with its time when times are on, its WO when
 *  the task has several, and the comment typed with it). Phone and desktop alike. */
function DoneLines({ x, stamps, T, print, onEdit }: { x: DoneTask; stamps: boolean; T: (ms: number) => string; print: boolean; onEdit?: (id: string) => void }) {
  const small = print ? "text-[7pt]" : "text-caption";
  const line = (label: string, l: DoneLine, more: number, moreWord: string) => {
    const lead = [l.wo ? `WO ${l.wo}` : "", stamps && l.time != null ? T(l.time) : ""].filter(Boolean).join(" ");
    return (
      <div className="mt-0.5 first:mt-0">
        <span className={`mr-1.5 font-medium text-[var(--color-text-muted)] ${small}`}>{label}</span>
        {lead && <span className={`font-display tabular-nums text-[var(--color-text-muted)] mr-1.5 ${print ? "text-[7.5pt]" : "text-caption"}`}>{lead}</span>}
        <span>{l.name}</span>
        {l.critical && <span className={`ml-1.5 font-medium text-[var(--state-overdue-text)] ${small}`}>critical path</span>}
        {l.discovery && <span className={`ml-1.5 font-medium text-[var(--color-text)] ${small}`}>{l.discovery}</span>}
        {more > 0 && <span className={`ml-1.5 text-[var(--color-text-muted)] ${small}`}>+{more} more {moreWord}</span>}
        {!print && onEdit && <EditBtn label={l.name} onClick={() => onEdit(l.id)} />}
        {l.note && <div className={`italic text-[var(--color-text-muted)] ml-3 ${print ? "text-[7.5pt]" : "text-caption"}`}>“{l.note}”</div>}
      </div>
    );
  };
  return (
    <div>
      {x.lastDone && line("Last done", x.lastDone, x.moreDone, "done")}
      {x.going && line("In progress", x.going, x.moreGoing, "going")}
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
  const resultCls = (t: string) => (t === "amber" ? "text-[var(--state-held-text)]" : "text-[var(--state-released-text)]");
  const vsCls = (t?: string) => (t === "rose" ? "text-[var(--state-overdue-text)]" : "text-[var(--state-released-text)]");
  const cell = print ? "px-1 py-[1px]" : "px-2 py-1.5";
  const pctLine = (x: DoneTask) => [x.taskPct ? `${x.own ? "" : "task "}${x.taskPct.pct}% done${x.taskPct.plan != null ? ` · plan ${x.taskPct.plan}%` : ""}` : null, x.count ?? null].filter(Boolean).join(" · ") || null;
  const whyLine = (x: DoneTask) => x.why && <div className={`mt-0.5 italic font-medium text-[var(--state-held-text)] ${print ? "text-[7.5pt]" : "text-caption"}`}>Why behind: {x.why}</div>;
  return (
    <div ref={sortBox} className="relative">
      {sortLine}
      {!print && (
        <div className="sm:hidden rounded-md border border-[var(--color-border-strong)] divide-y divide-[var(--color-border)]">
          {rows.map((x) => (
            <div key={x.ids.join(",")} data-sort-id={x.key} className={`group/sort px-3 py-2 text-caption space-y-0.5 ${moving(x.key) ? "opacity-40" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <b className="text-[var(--color-text)] break-words"><Grip props={grip([x.key], x.task)} />{x.task}{x.critical && <CriticalTag />}{x.woShown && <span className="ml-1.5 font-display tabular-nums font-semibold text-caption text-[var(--color-text-muted)]">{/^\d+ WOs$/.test(x.woShown) ? x.woShown : `WO ${x.woShown}`}</span>}</b>
                {x.vs.text && <b className={`shrink-0 font-display tabular-nums text-caption ${vsCls(x.vs.tone)}`}>{x.vs.text}</b>}
              </div>
              {pctLine(x) && <div className="text-caption text-[var(--color-text-muted)]">{pctLine(x)}</div>}
              <div className="text-[var(--color-text)] break-words"><DoneLines x={x} stamps={stamps} T={T} print={false} onEdit={onEdit} /></div>
              <div className={`font-medium break-words ${resultCls(x.result.tone)}`}>{x.result.text}</div>
              {whyLine(x)}
              {x.who && <div className="text-caption text-[var(--color-text-muted)] break-words">{x.who}</div>}
            </div>
          ))}
        </div>
      )}
      <div className={print ? "" : "hidden sm:block"}>
        <table className={`w-full border-collapse ${print ? "text-[8pt]" : "text-caption"}`}>
          <thead>
            <tr className="border-b border-[var(--color-border-strong)] text-caption font-medium text-[var(--color-text-muted)] text-left">
              <th className={`${cell} w-[18%]`}>Task</th>{hasWo && <th className={`${cell} w-[62px]`}>WO</th>}<th className={cell}>Last done · In progress</th><th className={`${cell} w-[13%]`}>Who</th>
              <th className={`${cell} w-[20%]`}>What it means</th><th className={`${cell} w-[64px] text-right`}>vs plan</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.ids.join(",")} data-sort-id={x.key} className={`group/sort border-b border-[var(--color-border)] align-top ${moving(x.key) ? "opacity-40" : ""}`}>
                <td className={`${cell} font-medium break-words`}><Grip props={grip([x.key], x.task)} />{x.task}{x.critical && <CriticalTag print={print} />}{pctLine(x) && <div className={`font-normal text-[var(--color-text-muted)] ${print ? "text-[7.5pt]" : "text-caption"}`}>{pctLine(x)}</div>}</td>
                {hasWo && <td className={`${cell} font-display tabular-nums text-caption break-words`}>{x.woShown.split(/,\s*/).map((w, i) => <span key={i} className="block">{w}</span>)}</td>}
                <td className={`${cell} break-words`}><DoneLines x={x} stamps={stamps} T={T} print={print} onEdit={onEdit} /></td>
                <td className={`${cell} text-caption text-[var(--color-text-muted)] break-words`}>{x.who}</td>
                <td className={`${cell} font-medium break-words ${resultCls(x.result.tone)}`}>{x.result.text}{whyLine(x)}</td>
                <td className={`${cell} text-right font-display tabular-nums font-bold whitespace-nowrap ${vsCls(x.vs.tone)}`}>{x.vs.text}</td>
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
    <div className={`rounded-md border border-[var(--color-border-strong)] ${print ? "" : "overflow-x-auto"}`}>
      <table className={`w-full border-collapse ${print ? "text-[8.5pt]" : "text-caption"}`}>
        <thead>
          <tr className="border-b border-[var(--color-border-strong)] text-caption font-medium text-[var(--color-text-muted)] text-left">
            {head.map((h) => <th key={h} className={cell}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-[var(--color-border)] align-top">
              {r.cells.map((c, i) => <td key={i} className={`${cell} ${i === 0 ? "" : "whitespace-nowrap font-display tabular-nums text-caption print:text-caption"}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
