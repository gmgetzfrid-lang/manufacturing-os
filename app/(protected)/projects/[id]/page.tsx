"use client";

// /projects/[id] — project detail. Its tabs, the work first:
//   Plan     — the schedule as a list: import it, set it up, add to it
//   Today    — the shift's screen: meetings, hour by hour, turnover, Lock report
//   Work     — the timeline, calendar and work orders
//   Reports  — every report, one name each, and the field forms
//   Close-out — what's left to close the job, and how it did
// then Documents, Costs, Quality, Intake, Activity and Members.
// A project opens on Plan until work starts, then on Shift, and on
// Close-out once every step is done.
//
// Project owner gets a settings strip up top with status-transition buttons:
// Pause / Resume / Complete / Cancel / Archive, and Reopen on a completed,
// cancelled or archived project. Status changes auto-release every active
// checkout (handled in lib/projects.ts).

import React, { useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Loader2, AlertTriangle, Pause, Play,
  CheckCircle2, XCircle, Archive as ArchiveIcon, Layers, Send, Settings2,
  Users, FileText, Activity as ActivityIcon,
  Hash, Trash2, Plus, Flag, X, Download, Target, ShieldCheck, Pencil, CircleDollarSign, Package, Lock,
  UploadCloud, ClipboardList, Sun, FileBarChart, RotateCcw, ListChecks,
} from "lucide-react";
import { PageHero, PageBody, Card, StepLine, heroPrimary, heroQuiet, type HeroFact } from "@/components/ui/PageHero";
import { listMilestones } from "@/lib/milestones";
import { phaseStandings, standingOf, lateWords, type PhaseStanding } from "@/lib/phaseStanding";
import { phaseDates } from "@/lib/projectPhases";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import { useCriticalMode } from "@/lib/criticalModeStore";
import { clockLabel, fmtInTz } from "@/lib/scheduleTz";
import type { Milestone } from "@/types/schema";
import { requestSetup } from "@/lib/scheduleSetup";
import { useIsMobile } from "@/hooks/useIsMobile";
import { canReopen } from "@/lib/projectStatus";
import IntakePanel from "@/components/projects/IntakePanel";
import ProjectDocumentsCard from "@/components/projects/ProjectDocumentsCard";
import ProjectScopePanel from "@/components/projects/ProjectScopePanel";
import EditProjectModal from "@/components/projects/EditProjectModal";
import { ScheduleTzProvider } from "@/components/projects/ScheduleTzContext";
import { TransferOwnershipModal } from "@/components/projects/TransferOwnership";
import CostsTab from "@/components/projects/CostsTab";
import QualityTab from "@/components/projects/QualityTab";
import MaterialsRegister from "@/components/projects/MaterialsRegister";
import EventOrganization from "@/components/projects/EventOrganization";
import ProjectCoach from "@/components/projects/ProjectCoach";
import { openProjectReport } from "@/lib/projectReport";
import { FindingsReviewModal, FindingsGate } from "@/components/projects/Findings";
import { gatherProjectSnapshot } from "@/lib/projectSnapshot";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";
import { exportProjectToCsv } from "@/lib/projectExport";
import WatchButton from "@/components/ui/WatchButton";
import QuickNoteComposer from "@/components/notes/QuickNoteComposer";
import PresenceIndicator from "@/components/ui/PresenceIndicator";
import { useRole } from "@/components/providers/RoleContext";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";
import { Select } from "@/components/ui/Field";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useDraft, clearDraft } from "@/hooks/useDraft";
import {
  getProject, listMembers, listActivity, listProjectCheckouts,
  postComment, transitionProjectStatus, addMember, removeMember,
  deleteProject, updateMember,
} from "@/lib/projects";
import { getProjectTimeline, type TimelineEvent } from "@/lib/timeline";
import { openProjectEvidencePack } from "@/lib/evidencePack";
import TimelineFeed from "@/components/documents/TimelineFeed";
import ScheduleTab from "@/components/projects/ScheduleTab";
import MoreMenu from "@/components/ui/MoreMenu";
import CloseoutTab, { useCloseOpen, PathSteps, type CloseOpen, type PathRow } from "@/components/projects/CloseoutTab";
import { openReportNext } from "@/components/projects/ReportsView";
import type { ReportId } from "@/lib/reportLinks";
import { workState } from "@/lib/closeoutStatus";
import { phaseOnDay } from "@/lib/projectPhases";
import { dayKey } from "@/lib/scheduleTz";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { PhasesSetup, usePhasePick } from "@/components/projects/PhasesSetup";
import { MEMBER_ROLES, projectAccess, roleLabel, needsCoOwnerSql } from "@/lib/projectAccess";

const COOWNER_SQL_NOTE = "Co-owner needs a database change first: run supabase/migrations/20261113_project_co_owners.sql in the Supabase SQL editor. Editor and Viewer work now.";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { supabase } from "@/lib/supabase";
import type {
  Project, ProjectMember, ProjectMemberRole, ProjectActivity, CheckoutSession, ProjectStatus, Timestamp,
} from "@/types/schema";

type Tab = "plan" | "today" | "work" | "reports" | "closeout" | "materials" | "documents" | "intake" | "costs" | "quality" | "activity" | "members";
const SCHEDULE_TABS = ["plan", "today", "work", "reports"] as const;
type ScheduleTabId = (typeof SCHEDULE_TABS)[number];
const isScheduleTab = (t: Tab | null): t is ScheduleTabId => !!t && (SCHEDULE_TABS as readonly string[]).includes(t);
const TABS: readonly Tab[] = ["plan", "today", "work", "reports", "closeout", "materials", "documents", "intake", "costs", "quality", "activity", "members"];
/** The tabs for running the job, and the project's records. */
const MAIN_TABS: Array<{ id: Tab; label: string; icon: typeof Sun }> = [
  { id: "plan", label: "Plan", icon: ClipboardList }, { id: "today", label: "Shift", icon: Sun }, { id: "work", label: "Work", icon: Flag },
  { id: "reports", label: "Reports", icon: FileBarChart }, { id: "closeout", label: "Close-out", icon: ListChecks },
];
const RECORD_TABS: Array<{ id: Tab; label: string; icon: typeof Sun }> = [
  { id: "materials", label: "Materials", icon: Package }, { id: "costs", label: "Costs", icon: CircleDollarSign }, { id: "quality", label: "Quality", icon: ShieldCheck },
  { id: "documents", label: "Documents", icon: FileText }, { id: "members", label: "Members", icon: Users }, { id: "intake", label: "Intake", icon: UploadCloud },
  { id: "activity", label: "Activity", icon: ActivityIcon },
];
/** The tab a link asks for (older links' "schedule" opened the board: Work).
 *  None: decided by the project. */
const tabOf = (t: string | null | undefined): Tab | null => (t === "schedule" ? "work" : t && (TABS as readonly string[]).includes(t) ? t as Tab : null);

/** The page's frame: wide enough for the schedule; room at the bottom for
 *  a phone's action bar. */
const FRAME = "mx-auto w-full max-w-[1800px] px-2 sm:px-4 lg:px-5 pt-2 sm:pt-4 pb-24";
/** The Project menu's dots on a phone's band. */
const BAND_ICON = "inline-flex items-center justify-center w-10 h-10 -mr-2 rounded-md text-[var(--color-text)] hover:bg-[var(--color-surface)]";
/** "Phase 1", "Phase 1 and Phase 2", "A, B and C". */
const joinWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

type CheckoutWithDoc = CheckoutSession & {
  docNumber?: string;
  docTitle?: string;
  libraryName?: string;
};

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { uid, userEmail, activeRole, hasAnyRole } = useRole();
  // roles[] aware: a user holding Admin/DocCtrl additively gets admin powers
  // here even if their headline role is something else.
  const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);

  const projectId = params.id;

  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [activity, setActivity] = useState<ProjectActivity[]>([]);
  // Phase 3 — unified project timeline (project_activity + linked
  // document audit_logs + linked document_versions). Drives the
  // Activity tab; `activity` is still kept for the count badge.
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [checkouts, setCheckouts] = useState<CheckoutWithDoc[]>([]);
  const [loading, setLoading] = useState(true);
  // Load errors (page can't render) vs action errors (page stays up, a
  // dismissible banner reports the failure). Sharing one state used to let a
  // failed COMMENT blank the entire project view.
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Tab lives in the URL (?tab=today) so views are linkable and refresh
  // keeps your place.
  const search = useSearchParams();
  // null until the project says where to open: Plan until work starts, then Today.
  const [asked, setTabState] = useState<Tab | null>(() => tabOf(search?.get("tab")));
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("tab", t);
      window.history.replaceState(null, "", u.toString());
    } catch { /* URL sync is best-effort */ }
  }, []);
  // Same-page ?tab= navigations (the coach's deep links live on THIS page)
  // must switch the tab too — the state initializer only runs on mount.
  useEffect(() => {
    const t = tabOf(search?.get("tab"));
    if (t) setTabState(t);
  }, [search]);
  // Where the work stands (the Close-out tab's dot), and, no tab asked
  // for, where to open: Plan until work starts (a step started or any
  // progress), then Shift, then Close-out once every step is done (or the
  // project is complete).
  type StepRow = { id: string; parent_id: string | null; status: string; percent_complete: number | null; is_summary: boolean | null; cancelled_at: string | null; actual_start_at: string | null; attributes: unknown };
  const [stepRows, setStepRows] = useState<StepRow[] | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void fetchAllRows<StepRow>((from, to) => supabase.from("milestones")
      .select("id, parent_id, status, percent_complete, is_summary, cancelled_at, actual_start_at, attributes")
      .eq("project_id", projectId).order("id").range(from, to))
      .then(({ rows, error }) => { if (live) setStepRows(error ? [] : rows); });
    return () => { live = false; };
  }, [projectId]);
  // Where the work stands, phase by phase: done means every phase has a
  // schedule and all of it is done.
  const state = React.useMemo(() => (stepRows ? workState(stepRows, project?.phases ?? []) : null), [stepRows, project?.phases]);
  const workDone = !!project && !!state && (project.status === "completed" || state.allDone);
  const started = !!stepRows && stepRows.some((r) => r.actual_start_at || Number(r.percent_complete ?? 0) > 0 || r.status === "in_progress" || r.status === "completed");
  // Done with what's scheduled, a phase still to schedule: Plan, to import it.
  const nextToSchedule = !!state && state.scheduledDone && state.unscheduled.length > 0;
  const tab: Tab | null = asked ?? (project && stepRows ? (workDone ? "closeout" : nextToSchedule ? "plan" : started ? "today" : "plan") : null);
  const [commentDraft, setCommentDraft] = useState("");
  const [posting, setPosting] = useState(false);
  // A comment being written comes back after a reload.
  useDraft<string>(projectId ? `project-comment:${projectId}` : null, commentDraft, setCommentDraft, (v) => !v.trim());

  const [showEdit, setShowEdit] = useState(false);
  const [showPhases, setShowPhases] = useState(false);
  // A phone keeps the band to the name and the Project menu's dots.
  const narrow = useIsMobile();
  // The schedule's tabs use the full width; the rest a reading width.
  const wideTab = isScheduleTab(tab) || !tab;

  // Status-transition state
  const [pendingStatus, setPendingStatus] = useState<ProjectStatus | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [transitionBusy, setTransitionBusy] = useState(false);
  // Closeout gates: loaded when the Complete confirm opens, so the modal
  // shows exactly what's still outstanding before the project closes.
  const [gates, setGates] = useState<ProjectStateSnapshot | null>(null);
  const [gatesFailed, setGatesFailed] = useState(false);
  // Wizard fields the typed Project doesn't carry — fetched tolerantly.
  const [jobKind, setJobKind] = useState<string | null>(null);
  // Lessons-learned editor
  // Lessons & findings (the close-out review), and how many are left to review.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewLeft, setReviewLeft] = useState<number | null>(null);
  // Coach re-gathers when page data changes.
  const [coachKey, setCoachKey] = useState(0);

  const isOwner = project && uid && project.ownerUserId === uid;
  const isMember = members.some((m) => m.userId === uid);
  const canComment = isOwner || isMember || isAdmin;
  // Their permission on this project (Members: Co-owner, Editor, Viewer)
  // and their org role decide what they may do (lib/projectAccess).
  const myMemberRole = members.find((m) => m.userId === uid)?.role ?? null;
  const access = projectAccess({ isOwner: !!isOwner, memberRole: myMemberRole, orgRoles: [activeRole, ...(["Admin", "DocCtrl", "Manager", "Supervisor"] as const).filter((r) => hasAnyRole([r]))] });
  const canManage = access.canManage;
  // Deleting the project and handing over ownership: the owner (or an admin), not a co-owner.
  const isOwnerOrAdmin = !!isOwner || isAdmin;
  // The project's phases (Transmix 1 and 2), and the one picked: the
  // schedule, reports and costs follow it; null is the whole project.
  const phases = React.useMemo(() => project?.phases ?? [], [project?.phases]);
  // Unless one was picked: the phase running today (else the next to schedule).
  const todays = React.useMemo(() => {
    if (!phases.length || !project) return null;
    const running = phaseOnDay(dayKey(Date.now(), project.timezone || "America/Los_Angeles"), phases);
    return running?.id ?? null;
  }, [phases, project]);
  const [phase, setPhase] = usePhasePick(project?.id, phases, todays);

  // THE BAND: where each phase stands, read from the whole schedule the
  // same way the schedule's own screens read it (lib/phaseStanding), and
  // what's left to close once the work is done.
  const tz = project?.timezone || "America/Los_Angeles";
  const [allSteps, setAllSteps] = useState<Milestone[] | null>(null);
  const [stepsKey, setStepsKey] = useState(0);
  useEffect(() => {
    const on = () => setStepsKey((k) => k + 1);
    window.addEventListener("schedule:changed", on);
    return () => window.removeEventListener("schedule:changed", on);
  }, []);
  useEffect(() => {
    if (!project?.orgId || !projectId) return;
    let live = true;
    const t = setTimeout(() => {
      listMilestones({ orgId: project.orgId, projectId, includeGhost: true })
        .then((m) => { if (live) setAllSteps(m.filter((x) => !x.cancelledAt)); })
        .catch(() => { if (live) setAllSteps([]); });
    }, stepsKey ? 600 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [project?.orgId, projectId, stepsKey]);
  const shiftTimes = useShiftTimes(projectId);
  const criticalMode = useCriticalMode(projectId);
  const [nowMs] = useState(() => Date.now());
  const standings = React.useMemo<PhaseStanding[] | null>(() => {
    if (!allSteps) return null;
    const o = { now: nowMs, tz, shiftTimes, criticalMode };
    return phases.length ? phaseStandings(allSteps, phases, o) : [{ id: "all", name: "Work", ...standingOf(allSteps, o) }];
  }, [allSteps, phases, nowMs, tz, shiftTimes, criticalMode]);
  // What's left to close: read here once the work is done; the Close-out
  // tab says it again each time it reads (so the band keeps up with it).
  const closing = !!project && workDone && project.status !== "completed" && project.status !== "cancelled" && project.status !== "archived";
  const closeRead = useCloseOpen(project?.orgId, project?.id, phases, closing, coachKey);
  const [closeLive, setCloseLive] = useState<CloseOpen | null>(null);
  const close = closing ? closeLive ?? closeRead : null;

  // ?edit=1 (the coach's "write the purpose", "attach a Summary of Work")
  // opens Edit project, then drops out of the URL.
  const wantsEdit = search?.get("edit") === "1";
  const editAsked = React.useRef(false);
  useEffect(() => {
    if (!wantsEdit) { editAsked.current = false; return; }
    if (!project || !canManage || editAsked.current) return;
    editAsked.current = true;
    setShowEdit(true);
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("edit");
      window.history.replaceState(null, "", u.toString());
    } catch { /* URL sync is best-effort */ }
  }, [wantsEdit, project, canManage]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const proj = await getProject(projectId);
      if (!proj) { setError("Project not found"); setLoading(false); return; }
      setProject(proj);

      const [m, act, ck, tl] = await Promise.all([
        listMembers(projectId),
        listActivity(projectId, 200),
        listProjectCheckouts(projectId),
        getProjectTimeline({ projectId, limit: 200 }),
      ]);
      setMembers(m);
      setActivity(act);
      setTimeline(tl);

      // Hydrate doc + library context for checkouts
      if (ck.length > 0) {
        const docIds = Array.from(new Set(ck.map((s) => s.documentId).filter(Boolean)));
        const libIds = Array.from(new Set(ck.map((s) => s.libraryId).filter(Boolean)));
        const [docsRes, libsRes] = await Promise.all([
          docIds.length ? supabase.from("documents").select("id, document_number, title, name").in("id", docIds) : Promise.resolve({ data: [] }),
          libIds.length ? supabase.from("libraries").select("id, name").in("id", libIds) : Promise.resolve({ data: [] }),
        ]);
        const docMap = new Map<string, { docNumber?: string; docTitle?: string }>();
        (docsRes.data as Array<{ id: string; document_number?: string; title?: string; name?: string }> || [])
          .forEach((d) => docMap.set(d.id, { docNumber: d.document_number, docTitle: d.title || d.name }));
        const libMap = new Map<string, string>();
        (libsRes.data as Array<{ id: string; name?: string }> || [])
          .forEach((l) => libMap.set(l.id, l.name ?? ""));
        setCheckouts(ck.map((c) => ({
          ...c,
          docNumber: docMap.get(c.documentId)?.docNumber,
          docTitle: docMap.get(c.documentId)?.docTitle,
          libraryName: c.libraryId ? libMap.get(c.libraryId) : undefined,
        })));
      } else {
        setCheckouts([]);
      }

      // Wizard fields (tolerant — pre-migration DBs simply report null).
      const { data: ext, error: extErr } = await supabase
        .from("projects").select("job_kind").eq("id", projectId).maybeSingle();
      setJobKind(!extErr && ext ? ((ext as { job_kind?: string | null }).job_kind ?? null) : null);
      setCoachKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message || "Failed to load project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Closeout gates load when the Complete confirmation opens.
  useEffect(() => {
    if (pendingStatus !== "completed" || !project?.orgId || !projectId) { setGates(null); setGatesFailed(false); return; }
    let cancelled = false;
    void gatherProjectSnapshot(project.orgId, projectId)
      .then((s) => { if (!cancelled) setGates(s); })
      .catch(() => { if (!cancelled) setGatesFailed(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStatus, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Go to a tab by name; "reports:<report>" opens that report.
  const goTab = useCallback((name: string) => {
    if (name.startsWith("reports:") && projectId) {
      // A phase picked with no schedule has no reports: show all phases.
      if (phase && state?.unscheduled.some((p) => p.id === phase)) setPhase(null);
      openReportNext(projectId, name.slice(8) as ReportId); setTab("reports");
    }
    else { const t = tabOf(name); if (!t) return; setTab(t); }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [projectId, setTab, phase, state, setPhase]);

  // Other screens ask to go to a tab ("project:tab", e.g. Reports' "Open
  // Close-out") or to open Complete ("project:complete").
  useEffect(() => {
    const toTab = (e: Event) => goTab(String((e as CustomEvent).detail ?? ""));
    const complete = () => setPendingStatus("completed");
    window.addEventListener("project:tab", toTab);
    window.addEventListener("project:complete", complete);
    return () => { window.removeEventListener("project:tab", toTab); window.removeEventListener("project:complete", complete); };
  }, [goTab]);

  const handlePostComment = async () => {
    if (!commentDraft.trim() || !uid || !project) return;
    setPosting(true);
    try {
      await postComment({
        projectId: project.id!,
        orgId: project.orgId,
        body: commentDraft,
        actorUserId: uid,
        actorEmail: userEmail ?? undefined,
      });
      setCommentDraft("");
      await refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally { setPosting(false); }
  };

  const handleTransition = async () => {
    if (!project || !uid || !pendingStatus) return;
    if (pendingStatus === "cancelled" && !statusReason.trim()) {
      setActionError("Cancellation reason is required"); return;
    }
    setTransitionBusy(true);
    try {
      await transitionProjectStatus({
        projectId: project.id!,
        orgId: project.orgId,
        toStatus: pendingStatus,
        reason: statusReason || undefined,
        actorUserId: uid,
        actorEmail: userEmail ?? undefined,
        actorRole: activeRole,
      });
      clearDraft(`project-status:${project.id}:${pendingStatus}`);
      setPendingStatus(null);
      setStatusReason("");
      await refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally { setTransitionBusy(false); }
  };

  const goBack = () => { if (window.history.length > 1) router.back(); else router.push("/projects"); };

  if (loading) return (
    <div className={FRAME}>
      <PageHero back={{ onClick: goBack, label: "Back to projects" }} kicker="Projects" title="Project" />
      <PageBody><Card><LoadingBlock what="the project" className="border-0 p-0" /></Card></PageBody>
    </div>
  );

  if (error || !project) return (
    <div className={FRAME}>
      <PageHero back={{ onClick: goBack, label: "Back to projects" }} kicker="Projects"
        title={error === "Project not found" || !error ? "Project not found." : "Couldn't open the project."} />
      <PageBody>
        <Card>
          <p role="alert" className="text-[14px] text-[var(--color-text)]">
            {error === "Project not found" || !error ? "This project wasn't found. It may have been deleted, or you're not on it." : `Couldn't load the project: ${error}`}
          </p>
          <div className="mt-3 flex gap-4 text-[15px]">
            {error && error !== "Project not found" && <button onClick={() => void refresh()} className="text-[var(--color-accent-text)] hover:underline">Try again</button>}
            <Link href="/projects" className="text-[var(--color-accent-text)] hover:underline">All projects</Link>
          </div>
        </Card>
      </PageBody>
    </div>
  );

  // ── The band's answer: what matters about this project right now ──
  const when = (iso: string | number) => { const t = typeof iso === "number" ? iso : Date.parse(iso); return `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${clockLabel(t, tz)}`; };
  const statusWord = project.status[0].toUpperCase() + project.status.slice(1);
  const running = standings?.find((s) => s.state === "running") ?? null;
  const upcoming = standings?.find((s) => s.state === "not started") ?? null;
  const noSchedule = !!stepRows && !!standings && standings.every((s) => s.state === "no schedule");
  const unscheduled = state?.unscheduled ?? [];
  // A phase or the whole job, in words: "Phase 2 is 45% done."
  const who = (s: PhaseStanding) => (s.id === "all" ? "The work" : s.name);
  const h1 = (n: number) => Math.round(Math.abs(n) * 10) / 10;
  // The answer is one statement; the numbers behind it are facts beside it.
  const st = standings ?? [];
  const stepsDone = st.reduce((a, s) => a + s.done, 0), stepsAll = st.reduce((a, s) => a + s.steps, 0);
  // How the finish went against the plan: the phase that finished last.
  const lastDone = st.filter((s) => s.state === "finished" && s.finishedAt).sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))[0];
  const finishFact = (): HeroFact | null => {
    const l = lastDone?.lateHours;
    if (l == null) return null;
    return l >= 0.5 ? { label: "Hours late", value: h1(l), tone: "bad" } : l <= -0.5 ? { label: "Hours early", value: h1(l), tone: "good" } : { label: "Finish", value: "On time", tone: "good" };
  };
  const stepsFact: HeroFact | null = stepsAll ? { label: "Steps", value: `${stepsDone}/${stepsAll}` } : null;
  let answer: React.ReactNode = project.name;
  let sub: React.ReactNode = project.status === "cancelled" && project.cancelledReason ? `Cancelled: ${project.cancelledReason}` : null;
  let facts: Array<HeroFact | null> = [];
  if (project.status === "cancelled") answer = "Cancelled.";
  else if (project.status === "archived") answer = "Archived.";
  else if (project.status === "completed") { answer = workDone ? "Project complete." : "Marked complete."; facts = [stepsFact, finishFact()]; }
  else if (!standings || !stepRows) answer = project.name;
  else if (noSchedule) { answer = "No schedule yet."; sub = "Import it on Plan to track the work."; }
  else if (workDone) {
    answer = "Work done.";
    facts = [stepsFact, finishFact(), close ? { label: "Left to close", value: close.open.length, tone: close.open.length ? "warn" : "good" } : null];
  } else if (state?.scheduledDone && unscheduled.length) {
    answer = `${joinWords(st.filter((s) => s.state === "finished").map((s) => s.name))} done.`;
    sub = `${joinWords(unscheduled.map((p) => p.name))} ${unscheduled.length === 1 ? "has" : "have"} no schedule yet.`;
    facts = [stepsFact, finishFact()];
  } else if (running) {
    answer = `${who(running)} is ${running.pct}% done.`;
    const late = lateWords(running.lateHours);
    sub = running.forecastFinish ? `Forecast end ${when(running.forecastFinish)}${late ? `, ${late}` : ""}.` : null;
    facts = [
      { label: "Plan by now", value: `${running.planPct}%` },
      running.standing === "behind" ? { label: "Hours behind", value: h1(running.gapHours), tone: "bad" }
        : running.standing === "ahead" ? { label: "Hours ahead", value: h1(running.gapHours), tone: "good" } : { label: "Pace", value: "On plan" },
      { label: "Overdue", value: running.overdue, tone: running.overdue ? "bad" : undefined },
      { label: "Steps", value: `${running.done}/${running.steps}` },
    ];
  } else if (upcoming) {
    answer = `${who(upcoming)} starts ${upcoming.plannedStart ? when(upcoming.plannedStart).split(",").slice(0, 2).join(",") : "soon"}.`;
    facts = [{ label: "Steps planned", value: upcoming.steps }];
  }
  else if (st.length && st.every((s) => s.state === "finished")) { answer = "Work done."; facts = [stepsFact, finishFact()]; }
  if (project.status === "paused" && !sub) sub = canManage ? "Paused. Resume it from the Project menu." : "Paused.";
  const heroFacts = facts.filter((f): f is HeroFact => !!f);

  // The phases, joined by one line: each with how it finished (or where it
  // stands), then the close-out.
  const bandSteps = (standings ?? []).map((s) => {
    const ph = phases.find((p) => p.id === s.id);
    const late = lateWords(s.lateHours);
    const bad = (s.state === "finished" && (s.lateHours ?? 0) >= 0.5) || (s.state === "running" && s.standing === "behind");
    const red = "font-semibold text-[var(--state-overdue)]";
    // One fact a line: the dates, when it finished (or where it stands), how late.
    const where = s.state === "finished" ? <>
        {s.finishedAt && <span className="block max-sm:hidden">Done {when(s.finishedAt)}</span>}
        <span className={`block ${bad ? red : ""}`}>{late ?? "Done"}</span>
      </>
      : s.state === "running" ? <>
        <span className="block">{s.pct}% done</span>
        {s.standing === "behind" && <span className={`block max-sm:hidden ${red}`}>{h1(s.gapHours)} h behind</span>}
      </>
        : s.state === "not started" ? <span className="block">Not started</span> : <span className="block">No schedule yet</span>;
    return {
      label: s.id === "all" ? "Work" : s.name,
      state: (s.state === "finished" ? "done" : s.state === "running" ? "now" : "next") as "done" | "now" | "next",
      note: <>
        {ph && <span className="block max-sm:hidden">{phaseDates(ph).replace(" – ", " to ")}</span>}
        {where}
      </>,
    };
  });
  const closeNote = project.status === "completed" ? "Complete" : close ? (close.open.length ? <><span className="max-sm:hidden">{close.open[0].name}</span><span className="sm:hidden">{close.open.length} left</span></> : "Ready to close") : workDone ? "Next" : "After the work";
  const lineSteps = standings ? [...bandSteps, { label: "Close-out", state: (project.status === "completed" ? "done" : workDone ? "now" : "next") as "done" | "now" | "next", note: closeNote }] : null;

  // The one orange action: what's next for the project, unless the tab
  // that does it is the one open (its own button is the orange one there).
  const next: { label: string; tab: Tab; run: () => void } | null =
    !canManage || project.status === "completed" || project.status === "cancelled" || project.status === "archived" || !standings ? null
      : noSchedule ? { label: "Import the schedule", tab: "plan", run: () => goTab("plan") }
        : workDone ? (close && close.open.length === 0 ? { label: "Mark complete", tab: "closeout", run: () => setPendingStatus("completed") } : { label: "Finish close-out", tab: "closeout", run: () => goTab("closeout") })
          : state?.scheduledDone && unscheduled.length ? { label: `Import ${unscheduled[0].name}'s schedule`, tab: "plan", run: () => { setPhase(unscheduled[0].id); goTab("plan"); } }
            : null;
  // Shown over the plan and the work; Shift, Reports and the records each
  // have their own main button (Email, Print, Add), which is the orange one there.
  const primary = next && tab !== next.tab && (tab === "plan" || tab === "work" || !tab)
    ? <button type="button" onClick={next.run} className={heroPrimary}>{next.label}</button> : undefined;

  const projectMenu = (
              <MoreMenu label="Project" iconOnly={narrow} triggerClass={narrow ? BAND_ICON : heroQuiet} items={[
                ...(canManage ? [{ icon: <Settings2 className="w-4 h-4" />, label: "Setup", onClick: () => { if (!isScheduleTab(tab)) goTab("plan"); requestSetup(); } }] : []),
                ...(canManage ? [{ icon: <Layers className="w-4 h-4" />, label: phases.length ? "Phases" : "Split into phases", onClick: () => setShowPhases(true) }] : []),
                ...(canManage ? [{ icon: <Pencil className="w-4 h-4" />, label: "Edit name, dates and details", onClick: () => setShowEdit(true) }] : []),
                ...(project.linkedTicketId ? [{ icon: <Hash className="w-4 h-4" />, label: "Linked drafting request", onClick: () => router.push(`/requests/${project.linkedTicketId}`) }] : []),
                { icon: <FileText className="w-4 h-4" />, label: "Report", onClick: async () => {
                  if (!project.id || !project.orgId) return;
                  try { await openProjectReport(project.orgId, project.id); }
                  catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
                } },
                { icon: <Download className="w-4 h-4" />, label: "Export CSV", onClick: async () => {
                  if (!project.id || !project.orgId) return;
                  try { await exportProjectToCsv(project.id, project.orgId); }
                  catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
                } },
                { icon: <ShieldCheck className="w-4 h-4" />, label: "Evidence pack", onClick: async () => {
                  if (!project.id) return;
                  try { await openProjectEvidencePack(project.id); }
                  catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
                } },
                // What the job taught: the close-out's one review.
                ...(canManage && (project.status === "completed" || project.status === "active" || project.status === "paused")
                  ? [{ icon: <Target className="w-4 h-4" />, label: "Lessons & findings", onClick: () => setReviewOpen(true) }] : []),
                ...(canManage && project.status === "active" ? [
                  { icon: <Pause className="w-4 h-4" />, label: "Pause project", onClick: () => setPendingStatus("paused"), line: true },
                  { icon: <CheckCircle2 className="w-4 h-4" />, label: "Mark complete", onClick: () => setPendingStatus("completed"), tone: "good" as const },
                  { icon: <XCircle className="w-4 h-4" />, label: "Cancel project", onClick: () => setPendingStatus("cancelled"), tone: "bad" as const },
                ] : []),
                ...(canManage && project.status === "paused" ? [
                  { icon: <Play className="w-4 h-4" />, label: "Resume", onClick: () => setPendingStatus("active"), tone: "good" as const, line: true },
                  { icon: <XCircle className="w-4 h-4" />, label: "Cancel project", onClick: () => setPendingStatus("cancelled"), tone: "bad" as const },
                ] : []),
                ...(canManage && (project.status === "completed" || project.status === "cancelled")
                  ? [{ icon: <ArchiveIcon className="w-4 h-4" />, label: "Archive", onClick: () => setPendingStatus("archived"), line: true }] : []),
                // Closed by mistake, or the work came back: active again.
                ...(canManage && canReopen(project.status)
                  ? [{ icon: <RotateCcw className="w-4 h-4" />, label: "Reopen", onClick: () => setPendingStatus("active"), tone: "good" as const }] : []),
                ...(isOwnerOrAdmin ? [{ icon: <Trash2 className="w-4 h-4" />, label: "Delete project", tone: "bad" as const, line: true, onClick: async () => {
                  if (!project.id) return;
                  if (!(await appConfirm({ message: `Delete "${project.name}"? This permanently removes the project and its schedule. Document checkouts are kept (just unlinked). This cannot be undone.`, tone: "danger", confirmLabel: "Delete" }))) return;
                  try {
                    await deleteProject({ projectId: project.id, actorUserId: uid!, actorEmail: userEmail ?? undefined, actorRole: activeRole ?? undefined });
                    router.push("/projects");
                  } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
                } }] : []),
              ]} />
  );

  return (
    <div className={FRAME}>
      {/* THE BAND: where the project stands, in big type; its phases joined
          by one line; the phase picker and the Project menu; the tabs. */}
      <PageHero
        back={{ onClick: goBack, label: "Back to projects" }}
        kicker={<span className="flex items-center gap-3 min-w-0" title={project.name}>
          <span className="truncate">{project.name}</span>
          <span className="shrink-0 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)]">
            <span aria-hidden className="w-2 h-2 rounded-full" style={{ background: project.status === "paused" ? "var(--state-held)" : project.status === "completed" ? "var(--state-released)" : project.status === "active" ? "var(--color-text-faint)" : "var(--color-border-strong)" }} />
            {statusWord}
          </span>
          {project.visibility === "private" && <span className="shrink-0 max-sm:hidden inline-flex items-center gap-1 text-[13px]"><Lock className="w-3 h-3" /> Private</span>}
        </span>}
        title={answer}
        sub={sub}
        facts={heroFacts}
        primary={primary}
        tools={<>
          {phases.length > 0 && (isScheduleTab(tab) || tab === "costs") && (
            <label className="inline-flex items-center">
              <span className="sr-only">Phase</span>
              <select value={phase ?? ""} onChange={(e) => setPhase(e.target.value || null)}
                className={`${heroQuiet} max-sm:max-w-[8.5rem] pr-7 cursor-pointer [&_option]:bg-[var(--color-surface)] [&_option]:text-[var(--color-text)]`}>
                <option value="">All phases</option>
                {phases.map((ph) => <option key={ph.id} value={ph.id}>{ph.name}</option>)}
              </select>
            </label>
          )}
          {project.id && project.orgId && uid && (
            <span className="max-md:hidden inline-flex items-center gap-2">
              <PresenceIndicator resourceType="project" resourceId={project.id} userId={uid} userName={userEmail?.split("@")[0]} role={activeRole || undefined} />
              <WatchButton orgId={project.orgId} userId={uid} resourceType="project" resourceId={project.id}
                className="!h-9 !px-3 !rounded-md !text-[14px] !font-semibold !border-[var(--color-border-strong)] !bg-[var(--color-surface)] !text-[var(--color-text)] hover:!bg-[var(--color-surface-2)]" />
            </span>
          )}
          {projectMenu}
        </>}
      >
        {actionError && (
          <div role="alert" className="mb-4 flex items-start gap-2 text-[14px] font-semibold text-[var(--state-overdue)]">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="flex-1">{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]" aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {lineSteps && lineSteps.length > 1 && (
          <div className="max-w-[860px]" aria-label="Phases">
            <StepLine onDark steps={lineSteps} />
          </div>
        )}
        {/* TABS: the five for running the job, then the project's records.
            The records sit under More, with the one open in sight. */}
        <div className="mt-6 sm:mt-7 flex items-end border-b border-[var(--color-border-strong)]">
          <nav aria-label="Project" className="min-w-0 flex items-end gap-5 sm:gap-7 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {MAIN_TABS.map((t) => (
              <TabButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</TabButton>
            ))}
            {RECORD_TABS.filter((t) => t.id === tab).map((t) => (
              <TabButton key={t.id} active onClick={() => setTab(t.id)}>
                {t.label}{t.id === "documents" && checkouts.length > 0 && <span className="text-[13px] font-medium tabular-nums text-[var(--color-text-muted)]">{checkouts.length}</span>}
              </TabButton>
            ))}
          </nav>
          <span className="shrink-0 self-center ml-4 sm:ml-6">
            <MoreMenu label="More" triggerClass="inline-flex items-center justify-center gap-1 h-10 px-2 -mx-2 rounded-md text-[15px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"
              items={RECORD_TABS.map((t) => ({ icon: <t.icon className="w-4 h-4" />, label: t.label, current: tab === t.id, onClick: () => setTab(t.id) }))} />
          </span>
          <div className="ml-auto pl-2 self-center shrink-0 max-sm:hidden">
              <HelpTooltip>
                <b>Plan</b> - the schedule as a list: import it (P6, MS Project), set it up, add to it.
                <b className="block mt-1">Shift</b> - the shift ending and the next one: meetings, hour by hour, overtime, the turnover, the night plan, Lock report. Any date.
                <b className="block mt-1">Work</b> - the timeline, calendar and work orders.
                <b className="block mt-1">Reports</b> - every report, and the field forms.
                <b className="block mt-1">Close-out</b> - what&rsquo;s left to close the job, and how it did. A finished job opens here.
                <b className="block mt-1">Materials</b> - the materials register: every material and off-site repair, with its spec, owner, status and need-by date. Open it at scope freeze.
                <b className="block mt-1">Documents</b> - every checkout attached to this project (active + released).
                <b className="block mt-1">Activity</b> - the project&rsquo;s full timeline: comments, doc events, holds, milestone hits.
                <b className="block mt-1">Members</b> - who&rsquo;s on this project, and the event organization: the roles it requires and who fills each.
              </HelpTooltip>
          </div>
        </div>
      </PageHero>

      {/* CONTENT: white cards on the paper, over the band's bottom edge. The
          schedule's tabs use the full width; the rest a reading width. */}
      <PageBody className={wideTab ? "" : "max-w-6xl mx-auto"}>
        {/* The work is done: what's left to close, as one path. */}
        {tab === "plan" && closing && (
          <ClosePath close={close} standings={standings} when={when} />
        )}
        {/* Health + "what do I feed you": the wizard for the rest of the
            project's life. */}
        {project.id && project.orgId && tab === "plan" && (
          <ProjectCoach orgId={project.orgId} projectId={project.id} refreshKey={coachKey} />
        )}
        {tab === "documents" && (
          <div className="space-y-4">
            {project.id && project.orgId && (
              <ProjectScopePanel orgId={project.orgId} projectId={project.id} projectName={project.name} canManage={!!canManage} />
            )}
            {project.id && project.orgId && uid && (
              <ProjectDocumentsCard
                orgId={project.orgId}
                projectId={project.id}
                canManage={!!canManage}
                uid={uid}
                userEmail={userEmail}
              />
            )}
            <DocumentsTab checkouts={checkouts} />
            {project.id && project.orgId && uid && (
              <QuickNoteComposer
                orgId={project.orgId}
                userId={uid}
                userEmail={userEmail || undefined}
                userName={userEmail?.split("@")[0]}
                scope={{ projectId: project.id }}
              />
            )}
          </div>
        )}
        {(tab === "intake" || isScheduleTab(tab) || !tab) && !uid && <Card><LoadingBlock what="your access" className="border-0 p-0" /></Card>}
        {/* Where to open is decided by the schedule: until it's read, say so. */}
        {!tab && uid && <Card><LoadingBlock what="the schedule" className="border-0 p-0" /></Card>}
        {tab === "costs" && project.id && project.orgId && uid && (
          <CostsTab
            orgId={project.orgId}
            projectId={project.id}
            // The owner, a co-owner or an org Admin / Document Control (the
            // database lets co-owners in after 20261116_cost_controls.sql).
            canManage={!!isAdmin || !!access.canManage}
            uid={uid}
            userEmail={userEmail}
            onDataChanged={() => setCoachKey((k) => k + 1)}
            phases={phases}
            phase={phase}
            tz={project.timezone || "America/Los_Angeles"}
          />
        )}
        {tab === "closeout" && project.id && project.orgId && uid && (
          <CloseoutTab
            orgId={project.orgId}
            projectId={project.id}
            projectName={project.name}
            projectStatus={project.status}
            jobKind={jobKind}
            tz={project.timezone || "America/Los_Angeles"}
            phases={phases}
            uid={uid}
            userEmail={userEmail}
            canManage={!!canManage}
            onTab={goTab}
            onPickPhase={setPhase}
            onLessons={() => setReviewOpen(true)}
            onComplete={() => setPendingStatus("completed")}
            onOpen={setCloseLive}
          />
        )}
        {tab === "closeout" && !uid && <Card><LoadingBlock what="close-out" className="border-0 p-0" /></Card>}
        {tab === "materials" && project.id && project.orgId && uid && (
          <MaterialsRegister orgId={project.orgId} projectId={project.id} phases={phases} canManage={!!canManage || access.canEdit} actor={{ uid, email: userEmail }} />
        )}
        {tab === "quality" && project.id && project.orgId && uid && (
          <QualityTab
            orgId={project.orgId}
            projectId={project.id}
            canManage={!!canManage}
            // The punch list is the crew's: editors and org roles that work
            // schedules write it too (20261117_boxed_in.sql opens the database).
            canEditPunch={!!canManage || access.canEdit}
            uid={uid}
            userEmail={userEmail}
            jobKind={jobKind}
            onDataChanged={() => setCoachKey((k) => k + 1)}
          />
        )}
        {tab === "intake" && !canManage && (
          <Card label="Intake">
            <p className="text-[15px] text-[var(--color-text)]">The project owner and Document Control run intake.</p>
            <p className="text-[13px] text-[var(--color-text-muted)] mt-1">Approved contractor revisions show up under Documents.</p>
          </Card>
        )}
        {tab === "intake" && canManage && project.id && project.orgId && uid && (
          <IntakePanel
            orgId={project.orgId}
            projectId={project.id}
            canManage={!!canManage}
            uid={uid}
            userEmail={userEmail}
          />
        )}
        {tab === "activity" && (
          <ActivityTab
            timeline={timeline}
            canComment={!!canComment}
            commentDraft={commentDraft}
            setCommentDraft={setCommentDraft}
            posting={posting}
            onPost={handlePostComment}
          />
        )}
        {isScheduleTab(tab) && uid && (
          <ScheduleTzProvider timeZone={project.timezone}>
            <ScheduleTab
              orgId={project.orgId}
              projectId={project.id!}
              projectName={project.name}
              projectStatus={project.status}
              userId={uid}
              userName={userEmail ?? undefined}
              userEmail={userEmail ?? undefined}
              userRole={activeRole ?? undefined}
              isProjectOwner={!!isOwner}
              canEditSchedule={access.canEdit}
              timezone={project.timezone}
              canManage={!!canManage}
              onProjectChanged={() => void refresh()}
              mode={tab}
              onMode={setTab}
              phases={phases}
              phase={phase}
              onPickPhase={setPhase}
            />
          </ScheduleTzProvider>
        )}
        {tab === "members" && project.id && (
          <EventOrganization projectId={project.id} canManage={!!canManage || access.canEdit} actor={{ email: userEmail ?? null }} people={[...new Set(members.map((m) => (m.userName || m.userEmail || "").trim()).filter(Boolean))]} />
        )}
        {tab === "members" && (
          <MembersTab
            project={project}
            members={members}
            canManage={!!canManage}
            canTransfer={isOwnerOrAdmin}
            onAdded={() => void refresh()}
            actorUserId={uid!}
            actorEmail={userEmail ?? undefined}
          />
        )}
      </PageBody>

      {/* Lessons & findings: the close-out review, from the header or the Complete step. */}
      {reviewOpen && project.id && project.orgId && (
        <FindingsReviewModal orgId={project.orgId} projectId={project.id} projectName={project.name} canEdit={!!canManage || !!access.canEdit} timeZone={project.timezone} onClose={() => setReviewOpen(false)} />
      )}

      {showPhases && uid && project.id && project.orgId && (
        <PhasesSetup orgId={project.orgId} projectId={project.id} projectName={project.name} phases={phases}
          uid={uid} userEmail={userEmail} onClose={() => setShowPhases(false)} onSaved={() => void refresh()} />
      )}

      {showEdit && uid && (
        <EditProjectModal
          project={project}
          actorUserId={uid}
          actorEmail={userEmail ?? undefined}
          actorRole={activeRole ?? undefined}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); void refresh(); }}
        />
      )}

      {/* TRANSITION CONFIRM */}
      {pendingStatus && (
        <div role="dialog" aria-modal="true" aria-label="Change project status" className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
          {/* The reason being typed is kept on this device until it's saved. */}
          <ReasonDraft key={pendingStatus} draftKey={`project-status:${project.id}:${pendingStatus}`} value={statusReason} set={setStatusReason}
            onEscape={() => { if (!transitionBusy && !reviewOpen) { setPendingStatus(null); setStatusReason(""); setActionError(null); } }} />
          <div className="w-full max-w-md bg-[var(--color-surface)] rounded-lg shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-6 py-4 border-b border-[var(--color-border)] relative pr-12">
              <button onClick={() => { setPendingStatus(null); setStatusReason(""); setActionError(null); }} disabled={transitionBusy} aria-label="Close"
                className="absolute top-3 right-3 p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                <X className="w-4 h-4" />
              </button>
              <h2 className="font-display text-[19px] font-semibold text-[var(--color-text)]">
                {pendingStatus === "cancelled" ? "Cancel project" :
                 pendingStatus === "completed" ? "Mark project complete" :
                 pendingStatus === "archived" ? "Archive project" :
                 pendingStatus === "paused" ? "Pause project" :
                 canReopen(project.status) ? "Reopen project" :
                 "Resume project"}
              </h2>
              <div className="text-[14px] text-[var(--color-text-muted)] mt-1">
                {pendingStatus === "cancelled" || pendingStatus === "completed" || pendingStatus === "archived"
                  ? "Every active checkout on this project will be released."
                  : pendingStatus === "active" && canReopen(project.status)
                  ? `It goes back to active. The ${project.cancelledReason ? "cancel date and reason are" : "completed date is"} cleared; that it was ${project.status} stays in Activity. Released checkouts aren't taken out again.`
                  : "No checkouts will be affected."}
              </div>
            </div>
            {/* Lessons & findings first: what the job taught, reviewed before it closes. */}
            {pendingStatus === "completed" && project.id && project.orgId && (
              <FindingsGate orgId={project.orgId} projectId={project.id} onCount={setReviewLeft} onOpen={() => setReviewOpen(true)} />
            )}
            {/* Closeout gates — what a finished job should have closed out.
                Warnings, not walls: the owner can complete anyway, on the record. */}
            {pendingStatus === "completed" && !gates && (
              <div className="px-6 pt-4 text-[14px] text-[var(--color-text-muted)]">
                {gatesFailed ? <span className="font-semibold text-[var(--state-held)]">Couldn&apos;t check what&apos;s still open. You can still complete it.</span> : <><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />Checking what&apos;s still open…</>}
              </div>
            )}
            {pendingStatus === "completed" && gates && (() => {
              const gateLines: Array<{ ok: boolean; text: string }> = [
                { ok: gates.punchOpen === 0, text: gates.punchOpen === 0 ? "Punch list clear" : `${gates.punchOpen} punch item${gates.punchOpen === 1 ? "" : "s"} still open` },
                { ok: gates.turnoverRequired === 0 || gates.turnoverAccepted >= gates.turnoverRequired, text: gates.turnoverRequired === 0 ? "No turnover requirements set" : gates.turnoverAccepted >= gates.turnoverRequired ? "Turnover package fully accepted" : `Turnover ${gates.turnoverAccepted}/${gates.turnoverRequired} accepted` },
                { ok: gates.checklistOpenItems + gates.checklistNeedsEvidence === 0, text: gates.checklistOpenItems + gates.checklistNeedsEvidence === 0 ? "Checklists clear" : `${gates.checklistOpenItems + gates.checklistNeedsEvidence} checklist item${gates.checklistOpenItems + gates.checklistNeedsEvidence === 1 ? "" : "s"} unresolved` },
                { ok: gates.openChangeOrders === 0, text: gates.openChangeOrders === 0 ? "No change orders awaiting decision" : `${gates.openChangeOrders} change order${gates.openChangeOrders === 1 ? "" : "s"} awaiting decision` },
              ];
              const failed = gateLines.filter((g) => !g.ok).length;
              return (
                <div className="px-6 pt-4">
                  <div className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Closeout gates</div>
                  <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                    {gateLines.map((g, i) => (
                      <li key={i} className="flex items-center gap-2 py-1.5 text-[14px] text-[var(--color-text)]">
                        {g.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 text-[var(--state-released)]" /> : <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--state-held)]" />}
                        {g.text}
                      </li>
                    ))}
                  </ul>
                  {failed > 0 && (
                    <div className="mt-2 text-[13px] text-[var(--color-text-muted)]">
                      You can complete anyway. The open items stay on the record and in the report.
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="px-6 py-5">
              <label className="text-[13px] font-semibold text-[var(--color-text)] ">
                Reason {pendingStatus === "cancelled" ? "*" : "(optional)"}
              </label>
              <textarea
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                autoFocus
                rows={3}
                className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md text-[15px] bg-[var(--color-surface)] resize-y focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 outline-none"
                placeholder={pendingStatus === "cancelled" ? "Why is this project being cancelled?" : "Optional note for the audit log"}
              />
              {actionError && <div className="mt-2 text-[14px] font-semibold text-[var(--state-overdue)]">{actionError}</div>}
            </div>
            <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
              <button onClick={() => { setPendingStatus(null); setStatusReason(""); setActionError(null); }} disabled={transitionBusy} className="h-9 px-3.5 rounded-md text-[14px] font-semibold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Cancel</button>
              {pendingStatus === "completed" && (reviewLeft ?? 0) > 0 ? (
                <>
                  <button onClick={handleTransition} disabled={transitionBusy} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md text-[14px] font-semibold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] disabled:opacity-60">
                    {transitionBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Complete anyway
                  </button>
                  <button onClick={() => setReviewOpen(true)} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-[14px] font-semibold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]">
                    Finish the review
                  </button>
                </>
              ) : (
                <button onClick={handleTransition} disabled={transitionBusy} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-[14px] font-semibold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
                  {transitionBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Confirm
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Autosaves the status reason while its dialog is open; Escape closes it. */
function ReasonDraft({ draftKey, value, set, onEscape }: { draftKey: string; value: string; set: (v: string) => void; onEscape: () => void }) {
  useDraft<string>(draftKey, value, set, (v) => !v.trim());
  const esc = React.useRef(onEscape);
  useEffect(() => { esc.current = onEscape; });
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") esc.current(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  return null;
}

/** The work is done (Plan tab): what's left to close, as one path. */
function ClosePath({ close, standings, when }: {
  close: CloseOpen | null; standings: PhaseStanding[] | null; when: (iso: string) => string;
}) {
  const st = standings ?? [];
  const done = st.reduce((a, s) => a + s.done, 0), total = st.reduce((a, s) => a + s.steps, 0);
  const last = st.filter((s) => s.finishedAt).sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))[0];
  const lc = (s: string) => (/^[A-Z]{2}/.test(s) ? s : s[0].toLowerCase() + s.slice(1));
  const rows: PathRow[] = [
    { state: "done", title: "Work done", detail: `${done} of ${total} steps.${last?.finishedAt ? ` ${last.id === "all" ? "Finished" : `${last.name} finished`} ${when(last.finishedAt)}.` : ""}` },
    ...(close && close.clear.length ? [{ state: "done" as const, title: [close.clear[0].name, ...close.clear.slice(1).map((c) => lc(c.name))].reduce((a, n, i, xs) => (i === 0 ? n : `${a}${i === xs.length - 1 ? " and " : ", "}${n}`), ""), detail: close.clear.length > 1 ? "Nothing open in any of them." : close.clear[0].detail }] : []),
    ...(close ? close.open.map((c, i) => ({ state: (i === 0 ? "next" : "todo") as PathRow["state"], title: c.name, detail: c.detail })) : [{ state: "todo" as const, title: "Checking what's left to close…" }]),
    { state: close && close.open.length === 0 ? "next" : "todo", title: "Mark the project complete" },
  ];
  return (
    <Card label="To close the project">
      <PathSteps rows={rows} />
    </Card>
  );
}

/** One tab on the band. */
function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  // The picked tab in sight: the bar scrolls sideways on a phone.
  const ref = React.useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = ref.current, bar = el?.closest("nav");
    if (!active || !el || !bar) return;
    const r = el.getBoundingClientRect(), b = bar.getBoundingClientRect();
    if (r.left < b.left || r.right > b.right) bar.scrollLeft += r.left - b.left - 16;
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`shrink-0 h-11 text-[15px] font-semibold inline-flex items-center gap-1.5 border-b-[3px] whitespace-nowrap transition-colors ${
        active ? "border-[var(--color-accent)] text-[var(--color-text)]" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]"
      }`}
    >
      {children}
    </button>
  );
}

function DocumentsTab({ checkouts }: { checkouts: CheckoutWithDoc[] }) {
  if (checkouts.length === 0) {
    return (
      <Card label="Checked out to this project">
        <p className="text-[15px] text-[var(--color-text-muted)]">None yet. Check a document out from its library.</p>
      </Card>
    );
  }
  const active = checkouts.filter((c) => c.status === "active");
  const released = checkouts.filter((c) => c.status !== "active");
  return (
    <>
      {active.length > 0 && (
        <Card label={<>Checked out now <span className="text-[var(--color-text-muted)] font-medium tabular-nums">{active.length}</span></>} pad={false} className="overflow-hidden">
          <CheckoutTable rows={active} />
        </Card>
      )}
      {released.length > 0 && (
        <Card label={<>Checked out before <span className="text-[var(--color-text-muted)] font-medium tabular-nums">{released.length}</span></>} pad={false} className="overflow-hidden">
          <CheckoutTable rows={released} historical />
        </Card>
      )}
    </>
  );
}

/** Checkouts as a ruled table: the drawing, who has it, how, since when. */
function CheckoutTable({ rows, historical }: { rows: CheckoutWithDoc[]; historical?: boolean }) {
  const router = useRouter();
  return (
    <table className="w-full text-[15px]">
      <thead className="max-sm:hidden bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
        <tr className="border-b border-[var(--color-border)]">
          <th scope="col" className="font-semibold px-4 h-10">Document</th>
          <th scope="col" className="font-semibold px-4 hidden lg:table-cell">Library</th>
          <th scope="col" className="font-semibold px-4">Who</th>
          <th scope="col" className="font-semibold px-4 hidden md:table-cell">Mode</th>
          <th scope="col" className="font-semibold px-4 whitespace-nowrap">{historical ? "Released" : "Since"}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--color-border)]">
        {rows.map((c) => {
          const href = `/documents/${c.libraryId}?doc=${c.documentId}`;
          const note = c.purpose || c.note || (historical ? c.releasedReason : null);
          return (
            <tr key={c.id} className="hover:bg-[var(--color-surface-2)] cursor-pointer align-top max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:px-4 max-sm:py-3"
              onClick={(e) => { if (!(e.target as HTMLElement).closest("a, button")) router.push(href); }}>
              <td className="sm:px-4 sm:py-3 max-sm:basis-full min-w-0">
                <Link href={href} className="font-display font-semibold tabular-nums text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{c.docNumber || "-"}</Link>
                {c.docTitle && <div className="text-[13px] text-[var(--color-text-muted)] line-clamp-1">{c.docTitle}</div>}
                {note && <div className="text-[13px] text-[var(--color-text-muted)] line-clamp-1 md:hidden">{note}</div>}
              </td>
              <td className="px-4 py-3 hidden lg:table-cell text-[14px] text-[var(--color-text)]">{c.libraryName || "-"}</td>
              <td className="sm:px-4 sm:py-3 text-[14px] text-[var(--color-text)] max-sm:text-[13px] max-sm:text-[var(--color-text-muted)]">
                {c.userName || "-"}
                {note && <div className="max-md:hidden text-[13px] text-[var(--color-text-muted)] line-clamp-1">{note}</div>}
              </td>
              <td className="px-4 py-3 hidden md:table-cell text-[14px] text-[var(--color-text)] capitalize">{c.mode}</td>
              <td className="sm:px-4 sm:py-3 text-[14px] text-[var(--color-text-muted)] whitespace-nowrap max-sm:text-[13px]">{formatRelative(historical ? (c.releasedAt ?? c.endedAt) : c.startedAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ActivityTab({
  timeline, canComment, commentDraft, setCommentDraft, posting, onPost,
}: {
  timeline: TimelineEvent[];
  canComment: boolean;
  commentDraft: string;
  setCommentDraft: (v: string) => void;
  posting: boolean;
  onPost: () => void;
}) {
  // A long timeline shows its newest, and says how many more there are.
  const [shown, setShown] = useState(40);
  return (
    <>
      {canComment && (
        <Card label="Comment">
          <textarea
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder="Share an update or ask a question…"
            aria-label="Comment"
            rows={2}
            className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md text-[15px] bg-[var(--color-surface)] resize-y focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 outline-none"
          />
          <div className="mt-2 flex items-center justify-end">
            {/* Orange once there's something to post. */}
            <button
              onClick={onPost}
              disabled={!commentDraft.trim() || posting}
              className={`inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md text-[14px] font-semibold disabled:opacity-50 ${commentDraft.trim() ? "text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]" : "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)]"}`}
            >
              {posting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Post comment
            </button>
          </div>
        </Card>
      )}

      <Card label={timeline.length ? `Activity · ${timeline.length}` : "Activity"}>
        <TimelineFeed
          events={timeline.slice(0, shown)}
          showScope={false}
          emptyMessage="No activity yet. Comments, checkouts and revisions show up here."
        />
        {timeline.length > shown && (
          <button type="button" onClick={() => setShown((n) => n + 40)}
            className={`mt-3 ${heroQuiet}`}>
            Show {Math.min(40, timeline.length - shown)} more of {timeline.length - shown}
          </button>
        )}
      </Card>
    </>
  );
}

function MembersTab({
  project, members, canManage, canTransfer, onAdded, actorUserId, actorEmail,
}: {
  project: Project;
  members: ProjectMember[];
  canManage: boolean;
  /** Hand over ownership: the owner or an admin only. */
  canTransfer?: boolean;
  onAdded: () => void;
  actorUserId: string;
  actorEmail?: string;
}) {
  const [addEmail, setAddEmail] = useState("");
  const [addResp, setAddResp] = useState("");
  const [addRole, setAddRole] = useState<ProjectMemberRole>("collaborator");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingResp, setEditingResp] = useState<Record<string, string>>({});

  const addByEmail = async () => {
    const email = addEmail.trim().toLowerCase();
    if (!email) return;
    setBusy(true); setError(null);
    try {
      const { data: userRows, error: lookErr } = await supabase.from("users").select("id, email").eq("email", email).limit(2);
      if (lookErr) throw new Error(`Couldn't look up that email: ${lookErr.message}`);
      const candidates = (userRows ?? []) as Array<{ id: string; email: string }>;
      if (candidates.length > 1) throw new Error("More than one account has that email. Ask your admin to sort it out.");
      const candidate = candidates[0] ?? null;
      // The membership check is what actually scopes this to the org — the
      // users table is global, and the old lookup happily attached strangers.
      const { data: memberRow, error: orgErr } = candidate
        ? await supabase.from("org_members").select("uid").eq("org_id", project.orgId).eq("uid", candidate.id).eq("status", "active").maybeSingle()
        : { data: null, error: null };
      if (orgErr) throw new Error(`Couldn't check that person is in this org: ${orgErr.message}`);
      const data = candidate && memberRow ? candidate : null;
      if (!data?.id) throw new Error("No one with that email is in this org.");
      await addMember({
        projectId: project.id!, orgId: project.orgId,
        userId: data.id as string, userEmail: email, userName: email.split("@")[0],
        role: addRole, responsibility: addResp.trim() || undefined,
        actorUserId, actorEmail,
      });
      setAddEmail(""); setAddResp(""); setAddRole("collaborator");
      onAdded();
    } catch (e) {
      const msg = (e as Error).message;
      setError(needsCoOwnerSql(msg) ? COOWNER_SQL_NOTE : msg);
    } finally { setBusy(false); }
  };

  // A member's permission on the project: Co-owner, Editor or Viewer.
  const [roleBusy, setRoleBusy] = useState<string | null>(null);
  const setRole = async (m: ProjectMember, role: ProjectMemberRole) => {
    if (role === m.role) return;
    setRoleBusy(m.userId); setError(null);
    try {
      await updateMember({ projectId: project.id!, userId: m.userId, role, actorUserId });
      onAdded();
    } catch (e) {
      const msg = (e as Error).message;
      setError(needsCoOwnerSql(msg) ? COOWNER_SQL_NOTE : msg);
    } finally { setRoleBusy(null); }
  };

  const saveResp = async (m: ProjectMember) => {
    const next = editingResp[m.userId];
    if (next === undefined) return;
    try {
      await updateMember({ projectId: project.id!, userId: m.userId, responsibility: next, actorUserId });
      setEditingResp((p) => { const n = { ...p }; delete n[m.userId]; return n; });
      onAdded();
    } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
  };

  // Transfer ownership: to a member (preselected from their row) or
  // anyone in the org, and what the current owner becomes.
  const [transferTo, setTransferTo] = useState<string | null | undefined>(undefined);
  const [transferNote, setTransferNote] = useState<string | null>(null);

  const addCard = canManage && (
    <Card label="Add member">
      <div className="flex flex-col sm:flex-row gap-2">
        <input value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="user@example.com" aria-label="Email"
          className="flex-1 h-10 px-3 border border-[var(--color-border-strong)] rounded-md text-[15px] bg-[var(--color-surface)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 outline-none" />
        <Select value={addRole} onChange={(e) => setAddRole(e.target.value as ProjectMemberRole)} aria-label="Permission">
          {MEMBER_ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
        </Select>
      </div>
      <input value={addResp} onChange={(e) => setAddResp(e.target.value)} placeholder="What they're responsible for (optional)" aria-label="Responsibility"
        className="mt-2 w-full h-10 px-3 border border-[var(--color-border-strong)] rounded-md text-[15px] bg-[var(--color-surface)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 outline-none" />
      <div className="mt-2 flex justify-end">
        {/* Orange once there's someone to add: the event organization's Save may be the orange one until then. */}
        <button onClick={addByEmail} disabled={busy || !addEmail.trim()} className={`inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md text-[14px] font-semibold disabled:opacity-50 ${addEmail.trim() ? "text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]" : "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)]"}`}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add member
        </button>
      </div>
      {error && <div role="alert" className="mt-2 text-[14px] font-semibold text-[var(--state-overdue)]">{error}</div>}
    </Card>
  );

  return (
    <>
      {transferTo !== undefined && (
        <TransferOwnershipModal project={project} members={members} preselect={transferTo} actorUserId={actorUserId} actorEmail={actorEmail}
          onClose={() => setTransferTo(undefined)}
          onDone={(note) => { setTransferTo(undefined); setTransferNote(note ?? "Ownership transferred."); onAdded(); }} />
      )}

      <Card label={<>Members <span className="text-[var(--color-text-muted)] font-medium tabular-nums">{members.length}</span></>} pad={false} className="overflow-hidden"
        action={canTransfer ? (
          <span className="flex items-center gap-3">
            {transferNote && <span role="status" className="text-[13px] font-semibold text-[var(--state-released)]">{transferNote}</span>}
            <button type="button" onClick={() => setTransferTo(null)} title="Hand the project to someone else and choose what you become" className={heroQuiet}>
              Transfer ownership
            </button>
          </span>
        ) : undefined}>
        <table className="w-full text-[15px]">
          <thead className="max-sm:hidden bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
            <tr className="border-b border-[var(--color-border)]">
              <th scope="col" className="font-semibold px-4 h-10">Member</th>
              <th scope="col" className="font-semibold px-4 w-[150px]">Permission</th>
              <th scope="col" className="font-semibold px-4 hidden md:table-cell">Responsible for</th>
              <th scope="col" className="px-4 w-[1%]"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {members.map((m) => {
              const isOwner = m.role === "owner" || m.userId === project.ownerUserId;
              const canRemove = canManage && !isOwner;
              const respDraft = editingResp[m.userId];
              const who = m.userName || m.userEmail || m.userId.slice(0, 8);
              const resp = canManage ? (
                respDraft !== undefined ? (
                  <div className="flex items-center gap-2">
                    <input autoFocus value={respDraft} aria-label={`What ${who} is responsible for`}
                      onChange={(e) => setEditingResp((p) => ({ ...p, [m.userId]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") void saveResp(m); if (e.key === "Escape") setEditingResp((p) => { const n = { ...p }; delete n[m.userId]; return n; }); }}
                      placeholder="What is this member responsible for?"
                      className="flex-1 min-w-0 h-9 px-3 border border-[var(--color-border-strong)] rounded-md text-[14px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40" />
                    <button type="button" onClick={() => void saveResp(m)} className="h-9 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Save</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setEditingResp((p) => ({ ...p, [m.userId]: m.responsibility ?? "" }))}
                    className="text-left text-[14px] text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                    {m.responsibility ? m.responsibility : <span className="text-[var(--color-accent-text)] hover:underline">Add responsibility</span>}
                  </button>
                )
              ) : m.responsibility ? <span className="text-[14px] text-[var(--color-text)]">{m.responsibility}</span> : <span className="text-[var(--color-text-faint)]">-</span>;
              return (
                <tr key={m.id} className="group align-top max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:px-4 max-sm:py-3">
                  <td className="sm:px-4 sm:py-3 max-sm:flex-1 max-sm:min-w-0">
                    <div className="font-semibold text-[var(--color-text)] truncate">{who}</div>
                    {m.userEmail && m.userEmail !== who && <div className="text-[13px] text-[var(--color-text-muted)] truncate">{m.userEmail}</div>}
                  </td>
                  <td className="sm:px-4 sm:py-3">
                    {canManage && !isOwner ? (
                      <select value={m.role} disabled={roleBusy === m.userId} onChange={(e) => void setRole(m, e.target.value as ProjectMemberRole)}
                        aria-label={`Permission for ${who}`} title={MEMBER_ROLES.find((r) => r.role === m.role)?.help}
                        className="h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[14px] font-semibold text-[var(--color-text)] disabled:opacity-60">
                        {MEMBER_ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                      </select>
                    ) : (
                      <span className="inline-flex h-9 items-center text-[14px] font-semibold text-[var(--color-text)]">{roleLabel(isOwner ? "owner" : m.role)}</span>
                    )}
                  </td>
                  <td className="hidden max-sm:block max-sm:basis-full max-sm:pt-1.5 md:table-cell md:px-4 md:py-3">{resp}</td>
                  <td className="sm:px-4 sm:py-3 whitespace-nowrap sm:text-right max-sm:basis-full">
                    <span className="inline-flex items-center gap-2">
                      {canTransfer && !isOwner && (
                        <button type="button" onClick={() => setTransferTo(m.userId)} title="Hand the project to this member" className="text-[14px] text-[var(--color-accent-text)] hover:underline">
                          Make owner
                        </button>
                      )}
                      {canRemove && (
                        <button type="button"
                          onClick={async () => {
                            if (!(await appConfirm({ message: `Remove ${m.userEmail || m.userName || m.userId} from this project?`, tone: "danger", confirmLabel: "Remove" }))) return;
                            try {
                              await removeMember({ projectId: project.id!, orgId: project.orgId, userId: m.userId, userName: m.userName ?? undefined, userEmail: m.userEmail ?? undefined, actorUserId, actorEmail });
                              onAdded();
                            } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
                          }}
                          title="Remove from project"
                          aria-label={`Remove ${who}`}
                          className="w-9 h-9 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)]">
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      {addCard}
    </>
  );
}

function formatRelative(ts: Timestamp | undefined): string {
  if (!ts) return "-";
  try {
    const d = new Date(ts as string);
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
  } catch { return "-"; }
}
