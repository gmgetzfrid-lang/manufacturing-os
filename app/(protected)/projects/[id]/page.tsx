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
  Briefcase, ArrowLeft, Lock, Globe, Loader2, AlertTriangle, Pause, Play,
  CheckCircle2, XCircle, Archive as ArchiveIcon, Layers, Calendar, Send, Settings2,
  User as UserIcon, MessageSquare, Users, FileText, Activity as ActivityIcon,
  ExternalLink, Hash, Trash2, Plus, Flag, X, Download, Target, ShieldCheck, Pencil, CircleDollarSign, Package,
  UploadCloud, ClipboardList, Sun, FileBarChart, RotateCcw, ListChecks,
} from "lucide-react";
import { requestSetup } from "@/lib/scheduleSetup";
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
import { Spinner } from "@/components/ui/Spinner";
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
import CloseoutTab from "@/components/projects/CloseoutTab";
import { openReportNext } from "@/components/projects/ReportsView";
import type { ReportId } from "@/lib/reportLinks";
import { workState } from "@/lib/closeoutStatus";
import { phaseOnDay } from "@/lib/projectPhases";
import { dayKey } from "@/lib/scheduleTz";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { PhasesSetup, PhaseBar, usePhasePick } from "@/components/projects/PhasesSetup";
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
/** The tab a link asks for (older links' "schedule" opened the board: Work).
 *  None: decided by the project. */
const tabOf = (t: string | null | undefined): Tab | null => (t === "schedule" ? "work" : t && (TABS as readonly string[]).includes(t) ? t as Tab : null);

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

  const [showEdit, setShowEdit] = useState(false);
  const [showPhases, setShowPhases] = useState(false);

  // Status-transition state
  const [pendingStatus, setPendingStatus] = useState<ProjectStatus | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [transitionBusy, setTransitionBusy] = useState(false);
  // Closeout gates: loaded when the Complete confirm opens, so the modal
  // shows exactly what's still outstanding before the project closes.
  const [gates, setGates] = useState<ProjectStateSnapshot | null>(null);
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
    if (pendingStatus !== "completed" || !project?.orgId || !projectId) { setGates(null); return; }
    let cancelled = false;
    void gatherProjectSnapshot(project.orgId, projectId)
      .then((s) => { if (!cancelled) setGates(s); })
      .catch(() => undefined);
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
      setPendingStatus(null);
      setStatusReason("");
      await refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally { setTransitionBusy(false); }
  };

  if (loading) return (
    <div className="min-h-full flex items-center justify-center">
      <Spinner />
    </div>
  );

  if (error || !project) return (
    <div className="min-h-full p-4 sm:p-8">
      <div className="max-w-2xl mx-auto bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          {error || "Project not found"}
          <div className="mt-2"><Link href="/projects" className="text-red-600 underline">Back to projects</Link></div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="pb-20">
      {/* HEADER */}
      <div className="bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <button onClick={() => { if (window.history.length > 1) router.back(); else router.push("/projects"); }} className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] mb-3">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to projects
          </button>

          {actionError && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-rose-500/50 bg-rose-500/[0.08] px-3 py-2.5 text-xs font-bold text-rose-700 dark:text-rose-300 animate-in fade-in slide-in-from-top-1">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="flex-1">{actionError}</span>
              <button onClick={() => setActionError(null)} className="shrink-0 text-rose-400 hover:text-rose-600" aria-label="Dismiss">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1 basis-64">
              <div className="flex items-center gap-2 mb-1.5">
                <StatusBadge status={project.status} />
                {project.visibility === "private" ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
                    <Lock className="w-2.5 h-2.5" /> Private
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">
                    <Globe className="w-2.5 h-2.5" /> Public
                  </span>
                )}
              </div>
              <h1 className="text-2xl font-black text-[var(--color-text)] flex items-center gap-2">
                <Briefcase className="w-6 h-6 text-[var(--color-accent)]" /> {project.name}
              </h1>
              {project.description && (
                <p className="text-sm text-[var(--color-text-muted)] mt-2 max-w-3xl">{project.description}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-[var(--color-text-muted)]">
                <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3" /> {project.ownerUserName || "-"}</span>
                {project.startedAt && <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" /> Started {formatDate(project.startedAt)}</span>}
                {project.targetCompletionDate &&<span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" /> Target {formatDate(project.targetCompletionDate)}</span>}
                {project.mocReference && <span className="inline-flex items-center gap-1 font-mono"><Layers className="w-3 h-3" /> {project.mocReference}</span>}
                {project.cancelledReason && <span className="inline-flex items-center gap-1 text-red-600"><AlertTriangle className="w-3 h-3" /> Cancelled: {project.cancelledReason}</span>}
                {project.linkedTicketId && (
                  <Link href={`/requests/${project.linkedTicketId}`} className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline">
                    <Hash className="w-3 h-3" /> Linked ticket
                  </Link>
                )}
              </div>
            </div>

            {/* Edit and Phases in sight; the rest in one More menu. */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {canManage && (
                <ActionButton icon={<Pencil className="w-3.5 h-3.5" />} label="Edit" onClick={() => setShowEdit(true)} />
              )}
              {canManage && (
                <ActionButton icon={<Settings2 className="w-3.5 h-3.5" />} label="Setup" onClick={() => { if (!isScheduleTab(tab)) goTab("plan"); requestSetup(); }} />
              )}
              {canManage && (
                <ActionButton icon={<Layers className="w-3.5 h-3.5" />} label={phases.length ? "Phases" : "Split into phases"} onClick={() => setShowPhases(true)} />
              )}
              {project.id && project.orgId && uid && (
                <>
                  <WatchButton orgId={project.orgId} userId={uid} resourceType="project" resourceId={project.id} />
                  <PresenceIndicator resourceType="project" resourceId={project.id} userId={uid} userName={userEmail?.split("@")[0]} role={activeRole || undefined} />
                </>
              )}
              <MoreMenu items={[
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
            </div>
          </div>

          {/* TABS */}
          <div className="mt-5 flex items-center gap-1 border-b border-[var(--color-border)] -mb-px overflow-x-auto [scrollbar-width:none]">
            <TabButton active={tab === "plan"} onClick={() => setTab("plan")} main>
              <ClipboardList className="w-3.5 h-3.5" /> Plan
            </TabButton>
            <TabButton active={tab === "today"} onClick={() => setTab("today")} main>
              <Sun className="w-3.5 h-3.5" /> Shift
            </TabButton>
            <TabButton active={tab === "work"} onClick={() => setTab("work")} main>
              <Flag className="w-3.5 h-3.5" /> Work
            </TabButton>
            <TabButton active={tab === "reports"} onClick={() => setTab("reports")} main>
              <FileBarChart className="w-3.5 h-3.5" /> Reports
            </TabButton>
            <TabButton active={tab === "closeout"} onClick={() => setTab("closeout")} main>
              <ListChecks className="w-3.5 h-3.5" /> Close-out
              {workDone && <span className="w-2 h-2 rounded-full bg-emerald-500" aria-label="work done" />}
            </TabButton>
            <span className="shrink-0 self-center w-px h-5 mx-1 bg-[var(--color-border)]" aria-hidden />
            <TabButton active={tab === "materials"} onClick={() => setTab("materials")}>
              <Package className="w-3.5 h-3.5" /> Materials
            </TabButton>
            <TabButton active={tab === "documents"} onClick={() => setTab("documents")}>
              <FileText className="w-3.5 h-3.5" /> Documents <span className="text-[10px] text-[var(--color-text-faint)]">{checkouts.length}</span>
            </TabButton>
            <TabButton active={tab === "costs"} onClick={() => setTab("costs")}>
              <CircleDollarSign className="w-3.5 h-3.5" /> Costs
            </TabButton>
            <TabButton active={tab === "quality"} onClick={() => setTab("quality")}>
              <ShieldCheck className="w-3.5 h-3.5" /> Quality
            </TabButton>
            <TabButton active={tab === "intake"} onClick={() => setTab("intake")}>
              <UploadCloud className="w-3.5 h-3.5" /> Intake
            </TabButton>
            <TabButton active={tab === "activity"} onClick={() => setTab("activity")}>
              <ActivityIcon className="w-3.5 h-3.5" /> Activity <span className="text-[10px] text-[var(--color-text-faint)]">{activity.length}</span>
            </TabButton>
            <TabButton active={tab === "members"} onClick={() => setTab("members")}>
              <Users className="w-3.5 h-3.5" /> Members <span className="text-[10px] text-[var(--color-text-faint)]">{members.length}</span>
            </TabButton>
            <div className="ml-1 pb-2">
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
        </div>
      </div>

      {/* CONTENT — schedule tab needs full page width to render the
          execution canvas; everything else keeps the comfortable
          reading width. */}
      <div className={`${isScheduleTab(tab) || !tab ? "max-w-[1800px] mx-auto px-3 sm:px-4" : "max-w-6xl mx-auto px-6"} py-6`}>
        {/* Health + "what do I feed you" — the wizard for the rest of the
            project's life, visible from every tab. */}
        {project.id && project.orgId && tab && tab !== "closeout" && tab !== "materials" && (!isScheduleTab(tab) || tab === "plan") && (
          <ProjectCoach orgId={project.orgId} projectId={project.id} refreshKey={coachKey} />
        )}
        {(isScheduleTab(tab) || tab === "costs") && (
          <PhaseBar phases={phases} pick={phase} onPick={setPhase} onEdit={canManage ? () => setShowPhases(true) : undefined} />
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
        {(tab === "intake" || isScheduleTab(tab) || !tab) && !uid && (
          <div className="py-10 flex justify-center"><Spinner /></div>
        )}
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
          />
        )}
        {tab === "closeout" && !uid && <div className="py-10 flex justify-center"><Spinner /></div>}
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
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
            <ShieldCheck className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
            <div className="text-sm font-bold text-[var(--color-text)]">Intake is managed by the project owner and Document Control</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1">Contractor submissions land here for review - approved revisions show up under Documents automatically.</div>
          </div>
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
          <div className="mb-6">
            <EventOrganization projectId={project.id} canManage={!!canManage || access.canEdit} actor={{ email: userEmail ?? null }} people={[...new Set(members.map((m) => (m.userName || m.userEmail || "").trim()).filter(Boolean))]} />
          </div>
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
      </div>

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
        <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
          <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-6 py-4 border-b border-[var(--color-border)]">
              <div className="text-sm font-black text-[var(--color-text)]">
                {pendingStatus === "cancelled" ? "Cancel project" :
                 pendingStatus === "completed" ? "Mark project complete" :
                 pendingStatus === "archived" ? "Archive project" :
                 pendingStatus === "paused" ? "Pause project" :
                 canReopen(project.status) ? "Reopen project" :
                 "Resume project"}
              </div>
              <div className="text-xs text-[var(--color-text-muted)] mt-1">
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
                  <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">Closeout gates</div>
                  <ul className="space-y-1">
                    {gateLines.map((g, i) => (
                      <li key={i} className={`flex items-center gap-2 text-xs font-bold ${g.ok ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>
                        {g.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
                        {g.text}
                      </li>
                    ))}
                  </ul>
                  {failed > 0 && (
                    <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                      You can complete anyway - the open items stay on the record and in the report.
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="px-6 py-5">
              <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">
                Reason {pendingStatus === "cancelled" ? "*" : "(optional)"}
              </label>
              <textarea
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                rows={3}
                className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
                placeholder={pendingStatus === "cancelled" ? "Why is this project being cancelled?" : "Optional note for the audit log"}
              />
              {actionError && <div className="mt-2 text-xs text-red-600">{actionError}</div>}
            </div>
            <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
              <button onClick={() => { setPendingStatus(null); setStatusReason(""); setActionError(null); }} disabled={transitionBusy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Cancel</button>
              {pendingStatus === "completed" && (reviewLeft ?? 0) > 0 ? (
                <>
                  <button onClick={handleTransition} disabled={transitionBusy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-60">
                    {transitionBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Complete anyway
                  </button>
                  <button onClick={() => setReviewOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]">
                    Finish the review
                  </button>
                </>
              ) : (
                <button onClick={handleTransition} disabled={transitionBusy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
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

function StatusBadge({ status }: { status: ProjectStatus }) {
  const cls: Record<ProjectStatus, string> = {
    active: "bg-emerald-100 text-emerald-700 border-emerald-200",
    paused: "bg-amber-100 text-amber-700 border-amber-200",
    completed: "bg-blue-100 text-blue-700 border-blue-200",
    cancelled: "bg-red-100 text-red-700 border-red-200",
    archived: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border ${cls[status]}`}>
      {status.toUpperCase()}
    </span>
  );
}

function ActionButton({ icon, label, onClick, color }: { icon: React.ReactNode; label: string; onClick: () => void; color?: "red" | "emerald" }) {
  const cls = color === "red"
    ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
    : color === "emerald"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
    : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]";
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors ${cls}`}>
      {icon}{label}
    </button>
  );
}

function TabButton({ active, onClick, children, main }: { active: boolean; onClick: () => void; children: React.ReactNode;
  /** One of the four work tabs (Plan, Today, Work, Reports): darker when not picked. */
  main?: boolean }) {
  // The picked tab in sight: the bar scrolls sideways on a phone.
  const ref = React.useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = ref.current, bar = el?.parentElement;
    if (!active || !el || !bar) return;
    const r = el.getBoundingClientRect(), b = bar.getBoundingClientRect();
    if (r.left < b.left || r.right > b.right) bar.scrollLeft += r.left - b.left - 16;
  }, [active]);
  return (
    <button
      ref={ref}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`shrink-0 px-3 xl:px-3.5 py-2.5 text-xs font-bold inline-flex items-center gap-1.5 border-b-2 whitespace-nowrap transition-colors ${
        active ? "border-[var(--color-accent)] text-[var(--color-accent)]" : main ? "border-transparent text-[var(--color-text)] hover:text-[var(--color-accent)]" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {children}
    </button>
  );
}

function DocumentsTab({ checkouts }: { checkouts: CheckoutWithDoc[] }) {
  if (checkouts.length === 0) {
    return (
      <div className="bg-[var(--color-surface)] border border-dashed border-[var(--color-border-strong)] rounded-2xl p-10 text-center">
        <FileText className="w-10 h-10 mx-auto text-slate-300 mb-3" />
        <p className="text-sm text-[var(--color-text-muted)]">No documents checked out yet. Open a doc in a library and check it out to this project.</p>
      </div>
    );
  }
  const active = checkouts.filter((c) => c.status === "active");
  const released = checkouts.filter((c) => c.status !== "active");
  return (
    <div className="space-y-4">
      {active.length > 0 && (
        <Section title="Currently checked out" count={active.length} tone="active">
          <div className="divide-y divide-[var(--color-border)]">
            {active.map((c) => <CheckoutLine key={c.id} c={c} />)}
          </div>
        </Section>
      )}
      {released.length > 0 && (
        <Section title="Previously checked out" count={released.length} tone="muted">
          <div className="divide-y divide-[var(--color-border)]">
            {released.map((c) => <CheckoutLine key={c.id} c={c} historical />)}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, tone, children }: { title: string; count: number; tone: "active" | "muted"; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className={`px-4 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between text-xs font-bold ${tone === "active" ? "bg-emerald-50/40 text-emerald-800" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
        <span>{title}</span>
        <span className="text-[10px] font-mono bg-[var(--color-surface)] border border-[var(--color-border)] px-1.5 py-0.5 rounded-full">{count}</span>
      </div>
      {children}
    </div>
  );
}

function CheckoutLine({ c, historical }: { c: CheckoutWithDoc; historical?: boolean }) {
  return (
    <div className={`px-4 py-3 hover:bg-slate-50/60 transition-colors ${historical ? "opacity-70" : ""}`}>
      <div className="flex items-center gap-3">
        <FileText className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm font-bold text-[var(--color-text)] truncate">{c.docNumber || "-"}</span>
            <span className="text-xs text-[var(--color-text-muted)] truncate">{c.docTitle}</span>
            {c.libraryName && <span className="text-[10px] text-[var(--color-text-faint)]">in {c.libraryName}</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
            <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3" />{c.userName}</span>
            <span className="text-[10px] font-bold uppercase bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{c.mode}</span>
            <span>{historical ? `Released ${formatRelative(c.releasedAt ?? c.endedAt)}` : `Since ${formatRelative(c.startedAt)}`}</span>
            {c.releasedReason && <span className="text-[var(--color-text-faint)] italic">- {c.releasedReason}</span>}
          </div>
          {(c.purpose || c.note) && (
            <div className="mt-1 text-[11px] text-[var(--color-text-muted)] italic line-clamp-1">&ldquo;{c.purpose || c.note}&rdquo;</div>
          )}
        </div>
        <Link
          href={`/documents/${c.libraryId}?doc=${c.documentId}`}
          className="p-1.5 rounded-md text-[var(--color-text-faint)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors"
          title="Open document"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
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
  return (
    <div className="space-y-4">
      {canComment && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-4 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-[var(--color-accent-soft)] rounded-lg shrink-0">
              <MessageSquare className="w-4 h-4 text-[var(--color-accent)]" />
            </div>
            <div className="flex-1">
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Share an update, ask a question, or comment on someone's work…"
                rows={2}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm resize-y focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
              />
              <div className="mt-2 flex items-center justify-end">
                <button
                  onClick={onPost}
                  disabled={!commentDraft.trim() || posting}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                >
                  {posting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  Post comment
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <TimelineFeed
        events={timeline}
        showScope={false}
        emptyMessage="No activity yet - comments, checkouts, and document revisions will land here."
      />
    </div>
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
      const { data: userRows } = await supabase.from("users").select("id, email").eq("email", email).limit(2);
      const candidates = (userRows ?? []) as Array<{ id: string; email: string }>;
      if (candidates.length > 1) throw new Error("Multiple accounts share that email - contact your admin.");
      const candidate = candidates[0] ?? null;
      // The membership check is what actually scopes this to the org — the
      // users table is global, and the old lookup happily attached strangers.
      const { data: memberRow } = candidate
        ? await supabase.from("org_members").select("uid").eq("org_id", project.orgId).eq("uid", candidate.id).eq("status", "active").maybeSingle()
        : { data: null };
      const data = candidate && memberRow ? candidate : null;
      if (!data?.id) throw new Error("No user with that email found in this org");
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

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-4 shadow-sm">
          <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-2">Add member</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="user@example.com"
              className="flex-1 px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
            <Select value={addRole} onChange={(e) => setAddRole(e.target.value as ProjectMemberRole)} aria-label="Permission">
              {MEMBER_ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
            </Select>
          </div>
          <input value={addResp} onChange={(e) => setAddResp(e.target.value)} placeholder="Responsibility (what they own / will own) - optional"
            className="mt-2 w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
          <div className="mt-2 flex justify-end">
            <button onClick={addByEmail} disabled={busy || !addEmail.trim()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add member
            </button>
          </div>
          {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
        </div>
      )}

      {canTransfer && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setTransferTo(null)} title="Hand the project to someone else and choose what you become"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-[var(--color-border-strong)] text-[var(--color-text)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]">
            Transfer ownership
          </button>
          {transferNote && <span role="status" className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">{transferNote}</span>}
        </div>
      )}
      {transferTo !== undefined && (
        <TransferOwnershipModal project={project} members={members} preselect={transferTo} actorUserId={actorUserId} actorEmail={actorEmail}
          onClose={() => setTransferTo(undefined)}
          onDone={(note) => { setTransferTo(undefined); setTransferNote(note ?? "Ownership transferred."); onAdded(); }} />
      )}

      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
        <div className="divide-y divide-[var(--color-border)]">
          {members.map((m) => {
            const isOwner = m.role === "owner" || m.userId === project.ownerUserId;
            const canRemove = canManage && !isOwner;
            const respDraft = editingResp[m.userId];
            return (
              <div key={m.id} className="px-4 py-3 flex items-start gap-3 group">
                <div className="p-2 bg-[var(--color-accent-soft)] rounded-full text-[var(--color-accent)] mt-0.5"><UserIcon className="w-4 h-4" /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-[var(--color-text)] truncate">{m.userName || m.userEmail || m.userId.slice(0, 8)}</span>
                    {canManage && !isOwner ? (
                      <select value={m.role} disabled={roleBusy === m.userId} onChange={(e) => void setRole(m, e.target.value as ProjectMemberRole)}
                        aria-label={`Permission for ${m.userName || m.userEmail || "member"}`} title={MEMBER_ROLES.find((r) => r.role === m.role)?.help}
                        className="h-7 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[11.5px] font-bold text-[var(--color-text)] disabled:opacity-60">
                        {MEMBER_ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                      </select>
                    ) : (
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${isOwner || m.role === "co_owner" ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : m.role === "collaborator" ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>{roleLabel(isOwner ? "owner" : m.role)}</span>
                    )}
                  </div>
                  {m.userEmail && <div className="text-xs text-[var(--color-text-muted)] truncate">{m.userEmail}</div>}
                  {canManage ? (
                    respDraft !== undefined ? (
                      <div className="mt-1 flex items-center gap-1.5">
                        <input autoFocus value={respDraft}
                          onChange={(e) => setEditingResp((p) => ({ ...p, [m.userId]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === "Enter") void saveResp(m); if (e.key === "Escape") setEditingResp((p) => { const n = { ...p }; delete n[m.userId]; return n; }); }}
                          placeholder="What is this member responsible for?"
                          className="flex-1 px-2 py-1 border border-[var(--color-accent-ring)] rounded text-xs focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
                        <button onClick={() => void saveResp(m)} className="text-[11px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] px-1.5">Save</button>
                      </div>
                    ) : (
                      <button onClick={() => setEditingResp((p) => ({ ...p, [m.userId]: m.responsibility ?? "" }))}
                        className="mt-1 text-left text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors inline-flex items-center gap-1">
                        <Target className="w-3 h-3 text-[var(--color-text-faint)]" />
                        {m.responsibility ? <span className="italic">{m.responsibility}</span> : <span className="text-[var(--color-text-faint)]">Add responsibility…</span>}
                      </button>
                    )
                  ) : m.responsibility ? (
                    <div className="mt-1 text-xs text-[var(--color-text-muted)] inline-flex items-center gap-1"><Target className="w-3 h-3 text-[var(--color-text-faint)]" /><span className="italic">{m.responsibility}</span></div>
                  ) : null}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {canTransfer && !isOwner && (
                    <button onClick={() => setTransferTo(m.userId)} title="Hand the project to this member"
                      className="text-[11px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] px-1.5 py-1 rounded hover:bg-[var(--color-accent-soft)] whitespace-nowrap">
                      Make owner
                    </button>
                  )}
                  {canRemove && (
                    <button
                      onClick={async () => {
                        if (!(await appConfirm({ message: `Remove ${m.userEmail || m.userName || m.userId} from this project?`, tone: "danger", confirmLabel: "Remove" }))) return;
                        try {
                          await removeMember({ projectId: project.id!, orgId: project.orgId, userId: m.userId, userName: m.userName ?? undefined, userEmail: m.userEmail ?? undefined, actorUserId, actorEmail });
                          onAdded();
                        } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
                      }}
                      title="Remove from project"
                      // Shown on hover with a mouse; always there on a touch screen.
                      className="opacity-60 sm:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 transition-opacity p-1.5 pointer-coarse:p-2.5 rounded-md text-[var(--color-text-faint)] hover:text-red-600 hover:bg-red-50"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatDate(ts: Timestamp): string {
  if (!ts) return "";
  try { return new Date(ts as string).toLocaleDateString(); } catch { return String(ts); }
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
    return d.toLocaleDateString();
  } catch { return "-"; }
}
