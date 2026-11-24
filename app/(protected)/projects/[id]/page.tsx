"use client";

// /projects/[id] — project detail. Its tabs, the work first:
//   Plan     — what this project needs (every requirement, from setup to
//              close-out, changed in place), then the schedule as a list
//   Shift    — the shift's screen: meetings, hour by hour, turnover, Lock report
//   Work     — the timeline, calendar and work orders
//   Reports  — every report, one name each, and the field forms
//   Close-out — what's left to close the job, and how it did
// then the records used every week, in sight: Documents, Costs, Quality,
// Materials and Members; the rare ones (Intake, Activity) under More.
// A project opens on Plan until work starts, then on Shift, and on
// Close-out once every step is done.
//
// The header carries Setup (opened in place, on any tab, at any part); the
// Project menu holds only the rare things: phases, edit details, follow,
// the exports, and Pause / Complete / Cancel / Archive / Reopen / Delete.
// Status changes auto-release every active checkout (lib/projects.ts).

import React, { useCallback, useEffect, useState } from "react";
import { readAsk } from "@/lib/asks";
import ProjectAsk from "@/components/projects/ProjectAsk";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Pause, Play,
  CheckCircle2, XCircle, Archive as ArchiveIcon, Layers, Send, Settings2,
  Users, FileText, Activity as ActivityIcon,
  Hash, Trash2, Plus, Flag, X, Download, Target, ShieldCheck, Pencil, CircleDollarSign, Package, Lock,
  UploadCloud, ClipboardList, Sun, FileBarChart, RotateCcw, ListChecks, Bell, BellOff,
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
import ProjectNeeds from "@/components/projects/ProjectNeeds";
import ScopeList from "@/components/projects/setup/ScopeList";
import SetupHost from "@/components/projects/SetupHost";
import { isWatching, watch, unwatch } from "@/lib/subscriptions";
import { openProjectReport } from "@/lib/projectReport";
import { FindingsReviewModal, FindingsGate } from "@/components/projects/Findings";
import { gatherProjectSnapshot } from "@/lib/projectSnapshot";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";
import { exportProjectToCsv } from "@/lib/projectExport";
import QuickNoteComposer from "@/components/notes/QuickNoteComposer";
import PresenceIndicator from "@/components/ui/PresenceIndicator";
import { useRole } from "@/components/providers/RoleContext";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";
import { Select } from "@/components/ui/Field";
import { SkeletonRows, SkeletonText } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Button, useActionFeedback } from "@/components/ui/Button";
import { CopyId } from "@/components/ui/CopyId";
import { label as fieldLabel, field as fieldCls } from "@/components/admin/kit";
import { withViewTransition } from "@/lib/viewTransition";
import { flushSync } from "react-dom";
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
import { sayError } from "@/components/projects/sayError";

type Tab = "plan" | "today" | "work" | "reports" | "closeout" | "materials" | "documents" | "intake" | "costs" | "quality" | "activity" | "members";
const SCHEDULE_TABS = ["plan", "today", "work", "reports"] as const;
type ScheduleTabId = (typeof SCHEDULE_TABS)[number];
const isScheduleTab = (t: Tab | null): t is ScheduleTabId => !!t && (SCHEDULE_TABS as readonly string[]).includes(t);
const TABS: readonly Tab[] = ["plan", "today", "work", "reports", "closeout", "materials", "documents", "intake", "costs", "quality", "activity", "members"];
/** The tabs for running the job, from the plan to the close-out. */
const MAIN_TABS: Array<{ id: Tab; label: string; icon: typeof Sun }> = [
  { id: "plan", label: "Plan", icon: ClipboardList }, { id: "today", label: "Shift", icon: Sun }, { id: "work", label: "Work", icon: Flag },
  { id: "reports", label: "Reports", icon: FileBarChart }, { id: "closeout", label: "Close-out", icon: ListChecks },
];
/** The project's records used every week, in sight beside them: the
 *  documents, the costs (contractors, staffing plans, invoices, change
 *  orders), quality (punch list, checklists, turnover package), materials
 *  and who's on the job. Close-out and the review send people to these. */
const RECORD_TABS: Array<{ id: Tab; label: string; icon: typeof Sun }> = [
  { id: "documents", label: "Documents", icon: FileText }, { id: "costs", label: "Costs", icon: CircleDollarSign }, { id: "quality", label: "Quality", icon: ShieldCheck },
  { id: "materials", label: "Materials", icon: Package }, { id: "members", label: "Members", icon: Users },
];
/** The rare ones, under More: contractor upload links and the full history. */
const MORE_TABS: Array<{ id: Tab; label: string; icon: typeof Sun }> = [
  { id: "intake", label: "Intake", icon: UploadCloud }, { id: "activity", label: "Activity", icon: ActivityIcon },
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
  // A tab picked by hand: the content cross-fades (instant under reduced motion).
  const switchTab = useCallback((t: Tab) => withViewTransition(() => flushSync(() => setTab(t))), [setTab]);
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
  // Following the project (bell notifications): set once, so it's in the Project menu.
  const [watching, setWatching] = useState<boolean | null>(null);

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
  // Read for the Complete dialog too, so it lists the same steps (the PSSR with them).
  const closeRead = useCloseOpen(project?.orgId, project?.id, phases, closing || pendingStatus === "completed", coachKey);
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
      setError(sayError(e, "Failed to load project"));
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
  useEffect(() => {
    if (!projectId || !uid) return;
    let live = true;
    void isWatching("project", projectId, uid).then((v) => { if (live) setWatching(v); }).catch(() => { if (live) setWatching(null); });
    return () => { live = false; };
  }, [projectId, uid]);

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

  const handlePostComment = async (): Promise<boolean> => {
    if (!commentDraft.trim() || !uid || !project) return false;
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
      return true;
    } catch (e) {
      setActionError(sayError(e));
      return false;
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
      setActionError(sayError(e));
    } finally { setTransitionBusy(false); }
  };

  const goBack = () => { if (window.history.length > 1) router.back(); else router.push("/projects"); };

  if (loading) return (
    <div className={FRAME}>
      <PageHero back={{ onClick: goBack, label: "Back to projects" }} kicker="Projects" title="Project" />
      <PageBody><SkeletonRows rows={6} what="the project" /></PageBody>
    </div>
  );

  if (error || !project) return (
    <div className={FRAME}>
      <PageHero back={{ onClick: goBack, label: "Back to projects" }} kicker="Projects"
        title={error === "Project not found" || !error ? "Project not found." : "Couldn't open the project."} />
      <PageBody>
        {error === "Project not found" || !error ? (
          <p className="text-reading text-[var(--color-text)]">
            It may have been deleted, or you&apos;re not on it.{" "}
            <Link href="/projects" className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">All projects</Link>
          </p>
        ) : (
          <ErrorNote title="Couldn't load the project." next={error} onRetry={() => void refresh()} />
        )}
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
  // How the finish went against the plan. `hero` when it's the number
  // that matters now (the work is over and nothing is left to close).
  const finishFact = (hero = false): HeroFact | null => {
    const l = lastDone?.lateHours;
    if (l == null) return null;
    return l >= 0.5 ? { label: "Hours late", value: h1(l), tone: "bad", hero } : l <= -0.5 ? { label: "Hours early", value: h1(l), tone: "good", hero } : { label: "Finish", value: "On time", tone: "good", hero };
  };
  // The steps, said once and small: the line of phases already shows them.
  const stepsFact: HeroFact | null = stepsAll ? { label: "Steps done", value: `${stepsDone} of ${stepsAll}` } : null;
  let answer: React.ReactNode = project.name;
  let sub: React.ReactNode = project.status === "cancelled" && project.cancelledReason ? `Cancelled: ${project.cancelledReason}` : null;
  let facts: Array<HeroFact | null> = [];
  // ONE large number, picked by the stage the project is at: while the
  // work runs, how far off the plan it is (or the steps left when it's on
  // plan); once the work is done, what's left to close (or how late it
  // finished when nothing is). Never "235/235".
  if (project.status === "cancelled") answer = "Cancelled.";
  else if (project.status === "archived") answer = "Archived.";
  else if (project.status === "completed") { answer = workDone ? "Project complete." : "Marked complete."; facts = [finishFact(true), stepsFact]; }
  else if (!standings || !stepRows) answer = project.name;
  else if (noSchedule) { answer = "No schedule yet."; sub = "Import it on Plan to track the work."; }
  else if (workDone) {
    const left = close ? close.open.length : null;
    answer = left === 0 ? "Work done. Ready to close." : "Work done.";
    if (left) sub = `Next to close: ${close!.open[0].name}.`;
    facts = left ? [{ label: "Left to close", value: left, tone: "warn", hero: true }, finishFact(), stepsFact]
      : [finishFact(true), stepsFact];
  } else if (state?.scheduledDone && unscheduled.length) {
    answer = `${joinWords(st.filter((s) => s.state === "finished").map((s) => s.name))} done.`;
    sub = `${joinWords(unscheduled.map((p) => p.name))} ${unscheduled.length === 1 ? "has" : "have"} no schedule yet.`;
    facts = [finishFact(true), stepsFact];
  } else if (running && running.plannedFinish && Date.now() > Date.parse(running.plannedFinish)) {
    // Past its planned finish with work still open: say that, with what is
    // left, not a percent that reads as nearly done.
    const left = Math.max(0, running.steps - running.done);
    answer = `${who(running)} is past its planned finish, ${left} step${left === 1 ? "" : "s"} left.`;
    const late = lateWords(running.lateHours);
    // Each number says what it is measured against: the last step's date in
    // the current plan, and the forecast against the original plan.
    sub = `Its last step is planned for ${when(running.plannedFinish)}.${running.forecastFinish ? ` Forecast end ${when(running.forecastFinish)}${late ? `, ${late} against the original plan` : ""}.` : ""}`;
    facts = [
      { label: "Steps left", value: left, tone: "bad", hero: true },
      { label: "Overdue", value: running.overdue, tone: running.overdue ? "bad" : undefined },
      { label: "Done", value: `${running.pct}%` },
    ];
  } else if (running) {
    answer = `${who(running)} is ${running.pct}% done.`;
    const late = lateWords(running.lateHours);
    sub = running.forecastFinish ? `Forecast end ${when(running.forecastFinish)}${late ? `, ${late}` : ""}.` : null;
    const stepsLeft: HeroFact = { label: "Steps left", value: Math.max(0, running.steps - running.done), hero: running.standing !== "behind" && running.standing !== "ahead" };
    facts = [
      running.standing === "behind" ? { label: "Hours behind", value: h1(running.gapHours), tone: "bad", hero: true }
        : running.standing === "ahead" ? { label: "Hours ahead", value: h1(running.gapHours), tone: "good", hero: true } : null,
      stepsLeft,
      { label: "Plan by now", value: `${running.planPct}%` },
      { label: "Overdue", value: running.overdue, tone: running.overdue ? "bad" : undefined },
    ];
  } else if (upcoming) {
    answer = `${who(upcoming)} starts ${upcoming.plannedStart ? when(upcoming.plannedStart).split(",").slice(0, 2).join(",") : "soon"}.`;
    facts = [{ label: "Steps planned", value: upcoming.steps }];
  }
  else if (st.length && st.every((s) => s.state === "finished")) { answer = "Work done."; facts = [finishFact(true), stepsFact]; }
  if (project.status === "paused" && !sub) sub = "Paused.";
  const heroFacts = facts.filter((f): f is HeroFact => !!f);

  // The phases, joined by one line: each with how it finished (or where it
  // stands), then the close-out.
  const bandSteps = (standings ?? []).map((s) => {
    const ph = phases.find((p) => p.id === s.id);
    const late = lateWords(s.lateHours);
    const bad = (s.state === "finished" && (s.lateHours ?? 0) >= 0.5) || (s.state === "running" && s.standing === "behind");
    const red = "font-medium text-[var(--state-overdue-text)]";
    // Two short lines: the dates, then where it stands (when it finished
    // and how late, in one line; the exact time is in its tooltip).
    const day = (iso: string) => fmtInTz(Date.parse(iso), tz, { month: "short", day: "numeric" });
    const where = s.state === "finished" ? (
        <span className="block truncate" title={s.finishedAt ? `Done ${when(s.finishedAt)}` : undefined}>
          {s.finishedAt && <span className="max-sm:hidden">Done {day(s.finishedAt)}{late ? ", " : ""}</span>}
          {late ? <span className={bad ? red : ""}>{late}</span> : !s.finishedAt ? "Done" : null}
        </span>
      )
      : s.state === "running" ? (
        <span className="block truncate">{s.pct}% done{(s.lateHours ?? 0) >= 0.5 ? <span className={`max-sm:hidden ${red}`}>, forecast {late}</span> : s.standing === "behind" && <span className={`max-sm:hidden ${red}`}>, {h1(s.gapHours)} h behind</span>}</span>
      )
        : s.state === "not started" ? <span className="block">Not started</span> : <span className="block">No schedule yet</span>;
    return {
      label: s.id === "all" ? "Work" : s.name,
      state: (s.state === "finished" ? "done" : s.state === "running" ? "now" : "next") as "done" | "now" | "next",
      tone: bad ? "bad" as const : undefined,
      short: s.state === "finished" ? (late ?? "Done") : s.state === "running" ? `${s.pct}% done${(s.lateHours ?? 0) >= 0.5 ? `, forecast ${late}` : s.standing === "behind" ? `, ${h1(s.gapHours)} h behind` : ""}` : s.state === "not started" ? "Not started" : "No schedule yet",
      note: <>
        {ph && <span className="block max-sm:hidden">{phaseDates(ph).replace(" – ", " to ")}</span>}
        {where}
      </>,
    };
  });
  const closeNote = project.status === "completed" ? "Complete" : close ? (close.open.length ? <><span className="max-sm:hidden">{close.open[0].name}</span><span className="sm:hidden">{close.open.length} left</span></> : "Ready to close") : workDone ? "Next" : "After the work";
  const lineSteps = standings ? [...bandSteps, { label: "Close-out", state: (project.status === "completed" ? "done" : workDone ? "now" : "next") as "done" | "now" | "next", note: closeNote, short: closeNote }] : null;

  // The one orange action: what's next for the project, unless the tab
  // that does it is the one open (its own button is the orange one there).
  const next: { label: string; tab: Tab; run: () => void } | null =
    !canManage || project.status === "completed" || project.status === "cancelled" || project.status === "archived" ? null
      // Paused: putting it back to work is the next thing, in sight (not in a menu).
      : project.status === "paused" ? { label: "Resume project", tab: "closeout", run: () => setPendingStatus("active") }
      : !standings ? null
      : noSchedule ? { label: "Import the schedule", tab: "plan", run: () => goTab("plan") }
        : workDone ? (close && close.open.length === 0 ? { label: "Mark complete", tab: "closeout", run: () => setPendingStatus("completed") } : { label: "Finish close-out", tab: "closeout", run: () => goTab("closeout") })
          : state?.scheduledDone && unscheduled.length ? { label: `Import ${unscheduled[0].name}'s schedule`, tab: "plan", run: () => { setPhase(unscheduled[0].id); goTab("plan"); } }
            : null;
  // Shown over the plan and the work; Shift, Reports and the records each
  // have their own main button (Email, Print, Add), which is the orange one there.
  // Sent here for one late or due step (?ask=late|due&m=<id>, from the
  // Inbox): that step goes first, with its buttons, on the schedule tabs.
  const askStep = (() => {
    const a = readAsk(search?.get("ask"));
    const m = search?.get("m");
    return (a === "late" || a === "due") && m && isScheduleTab(tab) ? m : null;
  })();
  const primary = next && tab !== next.tab && (tab === "plan" || tab === "work" || !tab) && !askStep
    ? <button type="button" onClick={next.run} className={heroPrimary}>{next.label}</button> : undefined;

  // Setup opens in place, on whichever tab is open (SetupHost below).
  const openSetup = () => requestSetup();
  // What this project needs: the Plan tab's list of every requirement.
  const needsPanel = project.id && project.orgId && uid ? (
    <ProjectNeeds orgId={project.orgId} project={project} jobKind={jobKind} phases={phases} steps={allSteps} members={members}
      canManage={!!canManage} uid={uid} userEmail={userEmail ?? null} refreshKey={coachKey}
      onPhases={() => setShowPhases(true)} onEdit={() => setShowEdit(true)} onTab={goTab} onLessons={() => setReviewOpen(true)}
      onJobKind={setJobKind} />
  ) : null;
  // A person's name from their id (who added a turnover document).
  const nameOf = (id: string | null | undefined) => {
    if (!id) return null;
    const m = members.find((x) => x.userId === id);
    return m?.userName || m?.userEmail || (id === project.ownerUserId ? project.ownerUserName ?? null : null);
  };
  const toggleFollow = async () => {
    if (!project.id || !uid || watching == null) return;
    try {
      if (watching) await unwatch({ userId: uid, resourceType: "project", resourceId: project.id });
      else await watch({ orgId: project.orgId, userId: uid, resourceType: "project", resourceId: project.id });
      setWatching(!watching);
    } catch (e) { await appAlert({ message: sayError(e), tone: "danger" }); }
  };
  // The rare things only: Setup is in sight on the header (and on Plan);
  // a phone's narrow header keeps it here too.
  const projectMenu = (
              <MoreMenu label="Project" iconOnly={narrow} triggerClass={narrow ? BAND_ICON : heroQuiet} items={[
                ...(canManage && narrow ? [{ icon: <Settings2 className="w-4 h-4" />, label: "Setup", onClick: openSetup }] : []),
                ...(canManage ? [{ icon: <Layers className="w-4 h-4" />, label: phases.length ? "Phases" : "Split into phases", onClick: () => setShowPhases(true) }] : []),
                ...(canManage ? [{ icon: <Pencil className="w-4 h-4" />, label: "Edit name, dates and details", onClick: () => setShowEdit(true) }] : []),
                ...(project.linkedTicketId ? [{ icon: <Hash className="w-4 h-4" />, label: "Linked drafting request", onClick: () => router.push(`/requests/${project.linkedTicketId}`) }] : []),
                ...(watching != null ? [{ icon: watching ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />, label: watching ? "Stop following" : "Follow this project", onClick: toggleFollow }] : []),
                // What the job taught: the close-out's one review (also a step on Close-out).
                ...(canManage && (project.status === "completed" || project.status === "active" || project.status === "paused")
                  ? [{ icon: <Target className="w-4 h-4" />, label: "Lessons & findings", onClick: () => setReviewOpen(true) }] : []),
                { icon: <FileText className="w-4 h-4" />, label: "Project report", line: true, onClick: async () => {
                  if (!project.id || !project.orgId) return;
                  try { await openProjectReport(project.orgId, project.id); }
                  catch (e) { await appAlert({ message: sayError(e), tone: "danger" }); }
                } },
                { icon: <Download className="w-4 h-4" />, label: "Export CSV", onClick: async () => {
                  if (!project.id || !project.orgId) return;
                  try { await exportProjectToCsv(project.id, project.orgId); }
                  catch (e) { await appAlert({ message: sayError(e), tone: "danger" }); }
                } },
                { icon: <ShieldCheck className="w-4 h-4" />, label: "Evidence pack", onClick: async () => {
                  if (!project.id) return;
                  try { await openProjectEvidencePack(project.id); }
                  catch (e) { await appAlert({ message: sayError(e), tone: "danger" }); }
                } },
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
                  if (!(await appConfirm({ title: `Delete "${project.name}"?`, message: "The project and its schedule are removed for good. Document checkouts are kept, just unlinked. You can't undo this.", tone: "danger", confirmLabel: "Delete project" }))) return;
                  try {
                    await deleteProject({ projectId: project.id, actorUserId: uid!, actorEmail: userEmail ?? undefined, actorRole: activeRole ?? undefined });
                    router.push("/projects");
                  } catch (e) { await appAlert({ message: sayError(e), tone: "danger" }); }
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
          <span className="shrink-0 inline-flex items-center gap-1.5 text-body font-medium text-[var(--color-text)]">
            <span aria-hidden className="w-2 h-2 rounded-full" style={{ background: project.status === "paused" ? "var(--state-held)" : project.status === "completed" ? "var(--state-released)" : project.status === "active" ? "var(--color-text-faint)" : "var(--color-border-strong)" }} />
            {statusWord}
          </span>
          {project.visibility === "private" && <span className="shrink-0 max-sm:hidden inline-flex items-center gap-1 text-body"><Lock className="w-3 h-3" /> Private</span>}
        </span>}
        title={answer}
        sub={sub}
        facts={heroFacts}
        slim={tab !== "plan"}
        primary={primary}
        tools={<>
          {project.id && project.orgId && uid && (
            <span className="max-md:hidden inline-flex items-center gap-2">
              <PresenceIndicator resourceType="project" resourceId={project.id} userId={uid} userName={userEmail?.split("@")[0]} role={activeRole || undefined} />
            </span>
          )}
          {/* Paused: Resume in sight on every tab (the band's orange carries it on Plan and Work). */}
          {canManage && project.status === "paused" && !primary && (
            <button type="button" onClick={() => setPendingStatus("active")} aria-label="Resume project" title="Resume project" className={narrow ? BAND_ICON : heroQuiet}>
              <Play className="w-4 h-4" />{!narrow && " Resume"}
            </button>
          )}
          {/* Setup in sight: opens in place, on any tab. */}
          {canManage && !narrow && (
            <button type="button" onClick={openSetup} className={heroQuiet} data-header-setup>
              <Settings2 className="w-4 h-4" /> Setup
            </button>
          )}
          {projectMenu}
        </>}
      >
        {actionError && (
          <div className="mb-4 flex items-start gap-2">
            <ErrorNote compact className="flex-1" title={actionError} next="" />
            <button type="button" onClick={() => setActionError(null)} className="shrink-0 w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 -mt-1 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]" aria-label="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {lineSteps && lineSteps.length > 1 && (
          <div className="max-w-[860px]" aria-label="Phases">
            <StepLine onDark compact={tab !== "plan"} steps={lineSteps} />
          </div>
        )}
        {/* Sent here for one step (from the Inbox): what is asked comes
            first, above the tabs, with its buttons. */}
        {askStep && project.id && (
          <div className="mt-4">
            <ProjectAsk stepId={askStep} projectId={project.id} onWorkTab={tab === "work"} />
          </div>
        )}
        {/* TABS: the five for running the job, then the records used every
            week, all in sight (a phone scrolls the strip sideways). The two
            rare ones sit under More, with the one open in sight. Switching
            cross-fades where the browser can. */}
        <div className="mt-5 sm:mt-6 flex items-end border-b border-[var(--color-border)]">
          <TabStrip>
            {MAIN_TABS.map((t) => (
              <TabButton key={t.id} active={tab === t.id} onClick={() => switchTab(t.id)}>{t.label}</TabButton>
            ))}
            <span aria-hidden className="shrink-0 self-center w-px h-5 bg-[var(--color-border-strong)]" />
            {RECORD_TABS.map((t) => (
              <TabButton key={t.id} active={tab === t.id} onClick={() => switchTab(t.id)}>
                {t.label}{t.id === "documents" && checkouts.length > 0 && <span className="text-body font-normal tabular-nums text-[var(--color-text-muted)]">{checkouts.length}</span>}
              </TabButton>
            ))}
            {MORE_TABS.filter((t) => t.id === tab).map((t) => (
              <TabButton key={t.id} active onClick={() => switchTab(t.id)}>{t.label}</TabButton>
            ))}
          </TabStrip>
          <span className="shrink-0 self-center ml-3 sm:ml-5">
            <MoreMenu label="More" triggerClass="inline-flex items-center justify-center gap-1 h-10 pointer-coarse:h-11 px-2 -mx-2 rounded-lg text-reading font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              items={MORE_TABS.map((t) => ({ icon: <t.icon className="w-4 h-4" />, label: t.label, current: tab === t.id, onClick: () => switchTab(t.id) }))} />
          </span>
          <div className="ml-auto pl-2 self-center shrink-0 max-sm:hidden">
              <HelpTooltip>
                <b>Plan</b> - what this project needs, from setup to close-out, changed right there; then the schedule as a list: import it (P6, MS Project), add to it.
                <b className="block mt-1">Shift</b> - the shift ending and the next one: meetings, hour by hour, overtime, the turnover, the night plan, Lock report. Any date.
                <b className="block mt-1">Work</b> - the timeline, calendar and work orders.
                <b className="block mt-1">Reports</b> - every report, and the field forms.
                <b className="block mt-1">Close-out</b> - what&rsquo;s left to close the job, and how it did. A finished job opens here.
                <b className="block mt-1">Documents</b> - the project&rsquo;s documents, its scope, and every checkout attached to it.
                <b className="block mt-1">Costs</b> - contractors (staffing plans, rate sheets), the budget, quotes, invoices and change orders.
                <b className="block mt-1">Quality</b> - checklists (PSSR, QA/QC), the turnover package and the punch list.
                <b className="block mt-1">Materials</b> - the materials register: every material and off-site repair, with its spec, owner, status and need-by date.
                <b className="block mt-1">Members</b> - who&rsquo;s on this project, and the event organization: the roles it requires and who fills each.
                <b className="block mt-1">More</b> - Intake (contractor upload links) and Activity (the project&rsquo;s full timeline).
              </HelpTooltip>
          </div>
        </div>
      </PageHero>

      {/* CONTENT: white cards on the paper, over the band's bottom edge. The
          schedule's tabs use the full width; the rest a reading width. */}
      <PageBody>
        {/* Which phase this tab shows, in sight right above what it filters,
            with each phase's step count; the chosen one is marked. */}
        {phases.length > 0 && (isScheduleTab(tab) || tab === "costs") && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Phase shown">
            <span className="text-body font-medium text-[var(--color-text-muted)] mr-1">Showing</span>
            {[{ id: null as string | null, name: "All phases", steps: (standings ?? []).reduce((n, s) => n + s.steps, 0) },
              ...phases.map((ph) => ({ id: ph.id as string | null, name: ph.name, steps: standings?.find((s) => s.id === ph.id)?.steps ?? 0 }))].map((o) => (
              <button key={o.id ?? "all"} type="button" aria-pressed={(phase ?? null) === o.id} onClick={() => setPhase(o.id)} className="ui-chip">
                {o.name}
                {standings && <span className="tabular-nums font-normal text-[var(--color-text-muted)]">{o.steps} steps</span>}
              </button>
            ))}
          </div>
        )}
        {/* The work is done: what's left to close, as one path. */}
        {tab === "plan" && closing && (
          <ClosePath close={close} standings={standings} when={when} />
        )}
        {/* The scope, as the work order list says it (components/projects/setup). */}
        {tab === "plan" && project.id && (
          <ScopeList projectId={project.id} canManage={!!canManage} noSchedule={!!noSchedule} actorEmail={userEmail ?? undefined} />
        )}
        {/* Everything this project asks for, from day one, each changed in
            place. With no schedule yet, importing it comes first (below). */}
        {tab === "plan" && !noSchedule && needsPanel}
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
        {(tab === "intake" || isScheduleTab(tab) || !tab) && !uid && <SkeletonRows rows={5} what="your access" />}
        {/* Where to open is decided by the schedule: until it's read, say so. */}
        {!tab && uid && <SkeletonRows rows={6} what="the schedule" />}
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
            madeAt={project.createdAt ? String(project.createdAt) : null}
            nameOf={nameOf}
            onJobKind={setJobKind}
          />
        )}
        {tab === "closeout" && !uid && <SkeletonRows rows={5} what="close-out" />}
        {tab === "materials" && project.id && project.orgId && uid && (
          <MaterialsRegister orgId={project.orgId} projectId={project.id} phases={phases} canManage={!!canManage || access.canEdit} actor={{ uid, email: userEmail }} />
        )}
        {tab === "quality" && project.id && project.orgId && uid && (
          <ScheduleTzProvider timeZone={project.timezone}>
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
          </ScheduleTzProvider>
        )}
        {tab === "intake" && !canManage && (
          <Card label="Intake">
            <p className="text-reading text-[var(--color-text)]">The project owner and Document Control run intake.</p>
            <p className="text-body text-[var(--color-text-muted)] mt-1">Approved contractor revisions show up under Documents.</p>
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
        {tab === "plan" && noSchedule && needsPanel}
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

      {/* Setup, on every tab: opened at the part asked for, in place. */}
      {uid && project.id && project.orgId && allSteps && (
        <SetupHost orgId={project.orgId} projectId={project.id} projectName={project.name} timezone={project.timezone} steps={allSteps}
          canManage={!!canManage} canEdit={access.canEdit} userId={uid} userEmail={userEmail} userRole={activeRole}
          onProjectChanged={() => void refresh()} />
      )}

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
        <div role="dialog" aria-modal="true" aria-label="Change project status" className="fixed inset-0 z-[200] bg-[var(--color-ink)]/55 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
          {/* The reason being typed is kept on this device until it's saved. */}
          <ReasonDraft key={pendingStatus} draftKey={`project-status:${project.id}:${pendingStatus}`} value={statusReason} set={setStatusReason}
            onEscape={() => { if (!transitionBusy && !reviewOpen) { setPendingStatus(null); setStatusReason(""); setActionError(null); } }} />
          <div className="ui-float ui-float-in w-full max-w-md bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden">
            <div className="px-6 py-4 border-b border-[var(--color-border)] relative pr-12">
              <button onClick={() => { setPendingStatus(null); setStatusReason(""); setActionError(null); }} disabled={transitionBusy} aria-label="Close"
                className="ui-hit absolute top-3 right-3 p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                <X className="w-4 h-4" />
              </button>
              <h2 className="font-display text-section font-semibold text-[var(--color-text)]">
                {pendingStatus === "cancelled" ? "Cancel project" :
                 pendingStatus === "completed" ? "Mark project complete" :
                 pendingStatus === "archived" ? "Archive project" :
                 pendingStatus === "paused" ? "Pause project" :
                 canReopen(project.status) ? "Reopen project" :
                 "Resume project"}
              </h2>
              <div className="text-body text-[var(--color-text-muted)] mt-1">
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
              <div className="px-6 pt-4">
                {gatesFailed
                  ? <p className="text-body font-medium text-[var(--state-held-text)]">Couldn&apos;t check what&apos;s still open. You can still complete it.</p>
                  : <SkeletonText lines={3} />}
              </div>
            )}
            {pendingStatus === "completed" && gates && (() => {
              // The same steps Close-out lists (the PSSR with them), then the checklists.
              const cr = closeLive ?? closeRead;
              const pssr = cr ? [...cr.open.map((c) => ({ ...c, ok: false })), ...cr.clear.map((c) => ({ ...c, ok: true }))].find((c) => c.id === "pssr") : undefined;
              const gateLines: Array<{ ok: boolean; text: string }> = [
                ...(pssr ? [{ ok: pssr.ok, text: `${pssr.name}: ${pssr.detail}` }] : []),
                { ok: gates.turnoverRequired === 0 || gates.turnoverAccepted >= gates.turnoverRequired, text: gates.turnoverRequired === 0 ? "No turnover documents needed (none were added)" : gates.turnoverAccepted >= gates.turnoverRequired ? "Turnover documents all accepted" : `Turnover documents: ${gates.turnoverAccepted} of ${gates.turnoverRequired} accepted` },
                { ok: gates.punchOpen === 0, text: gates.punchOpen === 0 ? "Punch list clear" : `${gates.punchOpen} punch item${gates.punchOpen === 1 ? "" : "s"} still open` },
                { ok: gates.openChangeOrders === 0, text: gates.openChangeOrders === 0 ? "No change orders waiting on a decision" : `${gates.openChangeOrders} change order${gates.openChangeOrders === 1 ? "" : "s"} waiting on a decision` },
                { ok: gates.checklistOpenItems + gates.checklistNeedsEvidence === 0, text: gates.checklistOpenItems + gates.checklistNeedsEvidence === 0 ? "Checklists clear" : `${gates.checklistOpenItems + gates.checklistNeedsEvidence} checklist item${gates.checklistOpenItems + gates.checklistNeedsEvidence === 1 ? "" : "s"} unresolved` },
              ];
              const failed = gateLines.filter((g) => !g.ok).length;
              return (
                <div className="px-6 pt-4">
                  <h3 className="text-body font-medium text-[var(--color-text)] mb-1">Left to close</h3>
                  <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                    {gateLines.map((g, i) => (
                      <li key={i} className="flex items-center gap-2.5 py-2 text-body text-[var(--color-text)]">
                        <span aria-label={g.ok ? "Clear" : "Open"} className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: g.ok ? "var(--state-released)" : "var(--state-held)" }} />
                        {g.text}
                      </li>
                    ))}
                  </ul>
                  {failed > 0 && (
                    <p className="mt-2 text-body text-[var(--color-text-muted)]">
                      You can complete anyway. The open items stay on the record and in the report.
                    </p>
                  )}
                </div>
              );
            })()}
            <div className="px-6 py-5">
              <label htmlFor="status-reason" className={fieldLabel}>
                {pendingStatus === "cancelled" ? "Why is it being cancelled?" : <>Note <span className="font-normal text-[var(--color-text-muted)]">(optional, kept in Activity)</span></>}
              </label>
              <textarea
                id="status-reason"
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                autoFocus
                rows={3}
                aria-invalid={pendingStatus === "cancelled" && !!actionError && !statusReason.trim() ? true : undefined}
                aria-describedby={actionError ? "status-reason-err" : undefined}
                className={`${fieldCls} !h-auto min-h-[5.5rem] py-2 resize-y`}
                placeholder={pendingStatus === "cancelled" ? "e.g. Moved to the spring outage" : "e.g. Waiting on the vendor"}
              />
              {actionError && <ErrorNote compact className="mt-2" title={actionError} next="" />}
            </div>
            <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex flex-wrap items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => { setPendingStatus(null); setStatusReason(""); setActionError(null); }} disabled={transitionBusy}>Keep as is</Button>
              {pendingStatus === "completed" && (reviewLeft ?? 0) > 0 ? (
                <>
                  <Button variant="secondary" onClick={handleTransition} loading={transitionBusy}>Complete anyway</Button>
                  <Button onClick={() => setReviewOpen(true)}>Finish the review</Button>
                </>
              ) : (
                <Button variant={pendingStatus === "cancelled" ? "danger" : "primary"} onClick={handleTransition} loading={transitionBusy}
                  disabled={pendingStatus === "cancelled" && !statusReason.trim()}
                  title={pendingStatus === "cancelled" && !statusReason.trim() ? "Say why it's being cancelled first" : undefined}>
                  {pendingStatus === "cancelled" ? "Cancel project" : pendingStatus === "completed" ? "Mark complete" : pendingStatus === "archived" ? "Archive" : pendingStatus === "paused" ? "Pause project" : canReopen(project.status) ? "Reopen" : "Resume"}
                </Button>
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

/** The tab strip: every tab in it, scrolling sideways on a phone; its far
 *  edge fades while more tabs are past it, so it's plain there are more. */
function TabStrip({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLElement | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    check();
    el.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => { el.removeEventListener("scroll", check); window.removeEventListener("resize", check); };
  }, []);
  return (
    <nav ref={ref} aria-label="Project"
      className={`min-w-0 flex items-end gap-5 sm:gap-7 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${more ? "[mask-image:linear-gradient(to_right,black_82%,transparent)]" : ""}`}>
      {children}
    </nav>
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
      className={`shrink-0 h-11 text-reading font-semibold inline-flex items-center gap-1.5 border-b-2 whitespace-nowrap transition-colors ${
        active ? "border-[var(--color-current)] text-[var(--color-text)]" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]"
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
        <p className="text-reading text-[var(--color-text-muted)]">Nothing checked out to this project. Check a document out from its library.{" "}
          <Link href="/documents" className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Open Documents</Link>
        </p>
      </Card>
    );
  }
  const active = checkouts.filter((c) => c.status === "active");
  const released = checkouts.filter((c) => c.status !== "active");
  return (
    <>
      {active.length > 0 && (
        <Card label={<>Checked out now <span className="ml-1 text-reading font-normal tabular-nums text-[var(--color-text-muted)]">{active.length}</span></>} pad={false} className="overflow-hidden">
          <CheckoutTable rows={active} />
        </Card>
      )}
      {released.length > 0 && (
        <Card label={<>Checked out before <span className="ml-1 text-reading font-normal tabular-nums text-[var(--color-text-muted)]">{released.length}</span></>} pad={false} className="overflow-hidden">
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
    <table className="w-full text-body">
      <thead className="max-sm:hidden bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)] text-left">
        <tr className="border-b border-[var(--color-border)]">
          <th scope="col" className="font-medium px-4 h-10">Document</th>
          <th scope="col" className="font-medium px-4 hidden lg:table-cell">Library</th>
          <th scope="col" className="font-medium px-4">Who</th>
          <th scope="col" className="font-medium px-4 hidden md:table-cell">Mode</th>
          <th scope="col" className="font-medium px-4 whitespace-nowrap">{historical ? "Released" : "Since"}</th>
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
                {c.docNumber ? <CopyId value={c.docNumber} label="document number" /> : null}
                <Link href={href} className={`block line-clamp-1 hover:text-[var(--color-accent-text)] hover:underline underline-offset-2 ${c.docNumber ? "text-body text-[var(--color-text-muted)]" : "font-medium text-[var(--color-text)]"}`}>{c.docTitle || c.docNumber || "Open the document"}</Link>
                {note && <div className="text-body text-[var(--color-text-muted)] line-clamp-1 md:hidden">{note}</div>}
              </td>
              <td className="px-4 py-3 hidden lg:table-cell">{c.libraryName ? <Link href={`/documents/${c.libraryId}`} className="text-[var(--color-text)] hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">{c.libraryName}</Link> : null}</td>
              <td className="sm:px-4 sm:py-3 text-body text-[var(--color-text)] max-sm:text-body max-sm:text-[var(--color-text-muted)]">
                {c.userName || "-"}
                {note && <div className="max-md:hidden text-body text-[var(--color-text-muted)] line-clamp-1">{note}</div>}
              </td>
              <td className="px-4 py-3 hidden md:table-cell text-[var(--color-text-muted)]">{(() => { const w = String(c.mode ?? "").replace(/_/g, " "); return w ? w[0].toUpperCase() + w.slice(1) : null; })()}</td>
              <td className="sm:px-4 sm:py-3 text-body text-[var(--color-text-muted)] whitespace-nowrap max-sm:text-body">{formatRelative(historical ? (c.releasedAt ?? c.endedAt) : c.startedAt)}</td>
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
  onPost: () => Promise<boolean>;
}) {
  // A long timeline shows its newest, and says how many more there are.
  const [shown, setShown] = useState(40);
  const post = useActionFeedback();
  const send = () => void post.run(async () => { if (!(await onPost())) throw new Error("not posted"); }).catch(() => { /* said above the tabs */ });
  return (
    <>
      {canComment && (
        <Card label="Comment">
          <label htmlFor="project-comment" className={fieldLabel}>An update or a question for everyone on the project</label>
          <textarea
            id="project-comment"
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder="e.g. Scaffold on E-22 moved to Thursday"
            rows={2}
            className={`${fieldCls} !h-auto min-h-[4.5rem] py-2 resize-y`}
          />
          <div className="mt-3 flex items-center justify-end">
            {/* The accent once there's something to post. */}
            <Button variant={commentDraft.trim() ? "primary" : "secondary"} onClick={send} disabled={!commentDraft.trim() || posting}
              loading={posting || post.loading} done={post.done} doneLabel="Posted">
              <Send className="w-4 h-4" /> Post comment
            </Button>
          </div>
        </Card>
      )}

      <Card label={timeline.length ? <>Activity <span className="ml-1 text-reading font-normal tabular-nums text-[var(--color-text-muted)]">{timeline.length}</span></> : "Activity"}>
        {/* Empty: one plain line on the sheet, not a box inside it. */}
        {timeline.length === 0 ? <p className="text-reading text-[var(--color-text-muted)]">No activity yet. Comments, checkouts and revisions show up here.</p> : <TimelineFeed
          events={timeline.slice(0, shown)}
          showScope={false}
          emptyMessage="No activity yet. Comments, checkouts and revisions show up here."
        />}
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
      if (lookErr) throw new Error(`Couldn't look up that email. ${sayError(lookErr)}`);
      const candidates = (userRows ?? []) as Array<{ id: string; email: string }>;
      if (candidates.length > 1) throw new Error("More than one account has that email. Ask your admin to sort it out.");
      const candidate = candidates[0] ?? null;
      // The membership check is what actually scopes this to the org — the
      // users table is global, and the old lookup happily attached strangers.
      const { data: memberRow, error: orgErr } = candidate
        ? await supabase.from("org_members").select("uid").eq("org_id", project.orgId).eq("uid", candidate.id).eq("status", "active").maybeSingle()
        : { data: null, error: null };
      if (orgErr) throw new Error(`Couldn't check that person is in this workspace. ${sayError(orgErr)}`);
      const data = candidate && memberRow ? candidate : null;
      if (!data?.id) throw new Error("No one with that email is in this workspace. Check the spelling, or ask an admin to invite them first.");
      await addMember({
        projectId: project.id!, orgId: project.orgId,
        userId: data.id as string, userEmail: email, userName: email.split("@")[0],
        role: addRole, responsibility: addResp.trim() || undefined,
        actorUserId, actorEmail,
      });
      setAddEmail(""); setAddResp(""); setAddRole("collaborator");
      onAdded();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      setError(needsCoOwnerSql(msg) ? COOWNER_SQL_NOTE : sayError(e));
      return false;
    } finally { setBusy(false); }
  };
  const adding = useActionFeedback();
  const add = () => void adding.run(async () => { if (!(await addByEmail())) throw new Error("not added"); }).catch(() => { /* said under the form */ });

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
      setError(needsCoOwnerSql(msg) ? COOWNER_SQL_NOTE : sayError(e));
    } finally { setRoleBusy(null); }
  };

  const saveResp = async (m: ProjectMember) => {
    const next = editingResp[m.userId];
    if (next === undefined) return;
    try {
      await updateMember({ projectId: project.id!, userId: m.userId, responsibility: next, actorUserId });
      setEditingResp((p) => { const n = { ...p }; delete n[m.userId]; return n; });
      onAdded();
    } catch (e) { await appAlert({ message: sayError(e), tone: "danger" }); }
  };

  // Transfer ownership: to a member (preselected from their row) or
  // anyone in the org, and what the current owner becomes.
  const [transferTo, setTransferTo] = useState<string | null | undefined>(undefined);
  const [transferNote, setTransferNote] = useState<string | null>(null);

  const addCard = canManage && (
    <Card label="Add a member">
      <form onSubmit={(e) => { e.preventDefault(); if (addEmail.trim() && !busy) add(); }}
        className="grid gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.6fr)_minmax(0,1.4fr)_auto] items-end">
        <div className="min-w-0">
          <label htmlFor="member-email" className={fieldLabel}>Email</label>
          <input id="member-email" type="email" autoComplete="email" inputMode="email" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="name@company.com"
            className={fieldCls} />
        </div>
        <div className="min-w-0">
          <label htmlFor="member-role" className={fieldLabel}>Permission</label>
          <Select id="member-role" value={addRole} onChange={(e) => setAddRole(e.target.value as ProjectMemberRole)}>
            {MEMBER_ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
          </Select>
        </div>
        <div className="min-w-0 sm:col-span-2 lg:col-span-1">
          <label htmlFor="member-resp" className={fieldLabel}>Responsible for <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></label>
          <input id="member-resp" value={addResp} onChange={(e) => setAddResp(e.target.value)} placeholder="e.g. Exchanger bundles, nights"
            className={fieldCls} />
        </div>
        {/* The accent once there's someone to add. */}
        <Button type="submit" variant={addEmail.trim() ? "primary" : "secondary"} disabled={!addEmail.trim()} loading={busy} done={adding.done} doneLabel="Added"
          title={!addEmail.trim() ? "Type their email first" : undefined} className="sm:col-span-2 lg:col-span-1 justify-self-end">
          <Plus className="w-4 h-4" /> Add member
        </Button>
      </form>
      {error && <ErrorNote compact className="mt-3" title={error} next="" />}
    </Card>
  );

  return (
    <>
      {transferTo !== undefined && (
        <TransferOwnershipModal project={project} members={members} preselect={transferTo} actorUserId={actorUserId} actorEmail={actorEmail}
          onClose={() => setTransferTo(undefined)}
          onDone={(note) => { setTransferTo(undefined); setTransferNote(note ?? "Ownership transferred."); onAdded(); }} />
      )}

      <Card label={<>Members <span className="ml-1 text-reading font-normal tabular-nums text-[var(--color-text-muted)]">{members.length}</span></>} pad={false} className="overflow-hidden"
        action={canTransfer ? (
          <span className="flex items-center gap-3">
            {transferNote && <span role="status" className="inline-flex items-center gap-1.5 text-body font-medium text-[var(--color-text)]"><span aria-hidden className="w-[7px] h-[7px] rounded-full bg-[var(--state-released)]" />{transferNote}</span>}
            <button type="button" onClick={() => setTransferTo(null)} title="Hand the project to someone else and choose what you become" className={heroQuiet}>
              Transfer ownership
            </button>
          </span>
        ) : undefined}>
        {members.length === 0 ? (
          <p className="px-4 sm:px-5 py-4 text-reading text-[var(--color-text-muted)]">
            Only the owner{project.ownerUserName ? ` (${project.ownerUserName})` : ""} so far.{canManage ? " Add people below to let them edit or view it." : ""}
          </p>
        ) : (
        <table className="w-full text-body">
          <thead className="max-sm:hidden bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)] text-left">
            <tr className="border-b border-[var(--color-border)]">
              <th scope="col" className="font-medium px-4 h-10">Member</th>
              <th scope="col" className="font-medium px-4 w-[170px]">Permission</th>
              <th scope="col" className="font-medium px-4 hidden md:table-cell">Responsible for</th>
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
                      placeholder="e.g. Exchanger bundles, nights"
                      className={`${fieldCls} flex-1 min-w-0 !h-9 pointer-coarse:!h-11 text-body max-sm:text-reading`} />
                    <Button size="sm" variant="secondary" onClick={() => void saveResp(m)}>Save</Button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setEditingResp((p) => ({ ...p, [m.userId]: m.responsibility ?? "" }))}
                    className="text-left text-body text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                    {m.responsibility ? m.responsibility : <span className="text-[var(--color-accent-text)] hover:underline underline-offset-2">Add what they&apos;re responsible for</span>}
                  </button>
                )
              ) : m.responsibility ? <span className="text-body text-[var(--color-text)]">{m.responsibility}</span> : null;
              // Their row's rare actions, in one menu.
              const rowMenu = [
                ...(canTransfer && !isOwner ? [{ icon: <ShieldCheck className="w-4 h-4" />, label: "Make owner", onClick: () => setTransferTo(m.userId) }] : []),
                ...(canRemove ? [{ icon: <X className="w-4 h-4" />, label: "Remove from project", tone: "bad" as const, line: !!canTransfer && !isOwner, onClick: async () => {
                  if (!(await appConfirm({ title: `Remove ${m.userEmail || m.userName || m.userId} from this project?`, message: "They keep their account. If the project is private, they stop seeing it.", tone: "danger", confirmLabel: "Remove member" }))) return;
                  try {
                    await removeMember({ projectId: project.id!, orgId: project.orgId, userId: m.userId, userName: m.userName ?? undefined, userEmail: m.userEmail ?? undefined, actorUserId, actorEmail });
                    onAdded();
                  } catch (e) { await appAlert({ message: sayError(e), tone: "danger" }); }
                } }] : []),
              ];
              return (
                <tr key={m.id} className="group align-top max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:px-4 max-sm:py-3">
                  <td className="sm:px-4 sm:py-3 max-sm:flex-1 max-sm:min-w-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <span aria-hidden className="w-8 h-8 shrink-0 rounded-full grid place-items-center bg-[var(--color-surface-2)] border border-[var(--color-border)] font-display text-caption font-semibold text-[var(--color-text-muted)]">{initials(who)}</span>
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--color-text)] truncate">{who}</div>
                        {m.userEmail && m.userEmail !== who && <div className="text-body text-[var(--color-text-muted)] truncate">{m.userEmail}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="sm:px-4 sm:py-3 max-sm:order-2">
                    {canManage && !isOwner ? (
                      <select value={m.role} disabled={roleBusy === m.userId} onChange={(e) => void setRole(m, e.target.value as ProjectMemberRole)}
                        aria-label={`Permission for ${who}`} title={MEMBER_ROLES.find((r) => r.role === m.role)?.help}
                        className="h-9 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] px-2 text-body max-sm:text-reading text-[var(--color-text)] disabled:opacity-60">
                        {MEMBER_ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                      </select>
                    ) : (
                      <span className="inline-flex h-9 items-center text-body text-[var(--color-text)]">{roleLabel(isOwner ? "owner" : m.role)}</span>
                    )}
                  </td>
                  <td className="hidden max-sm:block max-sm:order-3 max-sm:basis-full max-sm:pt-1.5 md:table-cell md:px-4 md:py-3">{resp}</td>
                  <td className="sm:px-4 sm:py-3 w-[1%] whitespace-nowrap sm:text-right max-sm:order-1">
                    {rowMenu.length > 0 && (
                      <MoreMenu label={`Actions for ${who}`} iconOnly items={rowMenu}
                        triggerClass="inline-flex items-center justify-center w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
      </Card>
      {addCard}
    </>
  );
}

/** "Gary Getzfrid" → "GG"; an email's name part when there's no name. */
function initials(who: string): string {
  const base = who.includes("@") ? who.split("@")[0].replace(/[._-]+/g, " ") : who;
  const parts = base.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? "")).toUpperCase() || "?";
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
