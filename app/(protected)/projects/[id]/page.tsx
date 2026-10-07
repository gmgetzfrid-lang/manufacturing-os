"use client";

// /projects/[id] — project detail with seven tabs:
//   Documents — the project's document register (checked-out, attached and
//               approved-intake documents, each a live reference marked
//               current or not) and, below it, the checkouts taken under
//               the project (active + released)
//   Costs · Quality · Intake — the controls program
//   Activity  — the project timeline: comments, status changes, the controls
//               program's milestones, and linked documents' history
//               (loaded when the tab is opened — PERF-8)
//   Schedule  — milestones / the execution board
//   Members   — who's on the project, with add/remove for the owner
//
// The owner / a controller gets the status strip: Pause / Resume / Complete
// / Cancel / Archive. Closing (complete / cancel / archive) revokes the
// project's contractor intake links and releases active checkouts per
// session — anything the actor may not release is named afterwards
// (lib/projects.ts). A closed project is reopened only by a controller, with
// a reason (audited). Each tab renders inside its own error boundary
// (REL-5): one tab crashing leaves the others usable.

import React, { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Briefcase, ArrowLeft, Lock, Globe, Loader2, AlertTriangle, Pause, Play,
  CheckCircle2, XCircle, Archive as ArchiveIcon, Layers, Calendar, Send,
  User as UserIcon, MessageSquare, Users, FileText, Activity as ActivityIcon,
  ExternalLink, Hash, Trash2, Plus, Flag, X, Download, Target, ShieldCheck, Pencil, CircleDollarSign,
  UploadCloud,
} from "lucide-react";
import ProjectDocumentsCard from "@/components/projects/ProjectDocumentsCard";
import TabErrorBoundary from "@/components/projects/TabErrorBoundary";
import EditProjectModal from "@/components/projects/EditProjectModal";
import ProjectCoach from "@/components/projects/ProjectCoach";
import CloseoutGatesPending, { CLOSEOUT_GATES_WAIT } from "@/components/projects/CloseoutGatesPending";
import { openProjectReport, draftLessonsLearned, saveLessonsLearned } from "@/lib/projectReport";
import { gatherProjectSnapshot, type SnapshotPreRead } from "@/lib/projectSnapshot";
import { CLOSEOUT_GATE_POLICY, type ProjectStateSnapshot } from "@/lib/projectHealth";
import { exportProjectToCsv } from "@/lib/projectExport";
import WatchButton from "@/components/ui/WatchButton";
import QuickNoteComposer from "@/components/notes/QuickNoteComposer";
import PresenceIndicator from "@/components/ui/PresenceIndicator";
import { useRole } from "@/components/providers/RoleContext";
import { appAlert, appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import { Select } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import {
  getProjectForPage, listMembers, listProjectCheckouts, activeOrgMemberIds,
  postComment, transitionProjectStatus, addMember, removeMember,
  deleteProject, transferOwnership, updateMember, reopenProject,
  countProjectRecords, describeProjectRecords, regulatedRecordTotal,
  closeoutGateLines, documentsTabCount, CLOSED_PROJECT_STATUSES,
  type ProjectDocumentRegister,
} from "@/lib/projects";
import { getProjectTimeline, type TimelineEvent } from "@/lib/timeline";
import { openProjectEvidencePack } from "@/lib/evidencePack";
import TimelineFeed from "@/components/documents/TimelineFeed";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { Modal, ModalHeader } from "@/components/ui/Modal";
import { supabase } from "@/lib/supabase";
import { userFacingCaughtError } from "@/lib/userFacingError";
import { applyEmailLookup } from "@/lib/identity";
import type {
  Project, ProjectMember, ProjectMemberRole, CheckoutSession, ProjectStatus, Timestamp,
} from "@/types/schema";

// PERF-9 (projects Round G J12): the four heavy tabs load when opened, not
// with the page — someone reading Documents never downloads the Costs,
// Quality, Intake or Schedule code (their libraries came with them: the
// quote/bid-tab panel, the checklist engine, the execution board). Each
// still renders inside its TabErrorBoundary, which also catches a failed
// chunk load.
const tabLoading = () => <div className="py-10 flex justify-center"><Spinner /></div>;
const IntakePanel = dynamic(() => import("@/components/projects/IntakePanel"), { ssr: false, loading: tabLoading });
const CostsTab = dynamic(() => import("@/components/projects/CostsTab"), { ssr: false, loading: tabLoading });
const QualityTab = dynamic(() => import("@/components/projects/QualityTab"), { ssr: false, loading: tabLoading });
const ScheduleTab = dynamic(() => import("@/components/projects/ScheduleTab"), { ssr: false, loading: tabLoading });

type Tab = "documents" | "intake" | "costs" | "quality" | "activity" | "schedule" | "members";

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
  // SEC-15: roster members who are ACTIVE in the org — ownership can only go
  // to one of them. null = not known (the button stays hidden).
  const [activeMemberIds, setActiveMemberIds] = useState<Set<string> | null>(null);
  // Phase 3 — unified project timeline (project_activity + the controls
  // program's audit rows + linked documents' history). Drives the Activity
  // tab AND its badge (the badge counts what the tab renders — SAF-6/UX-11).
  // PERF-8: loaded when the Activity tab is opened, not on every project
  // open; `timelineFresh` goes false after a write so the next view reloads.
  const [timeline, setTimeline] = useState<TimelineEvent[] | null>(null);
  const [timelineFresh, setTimelineFresh] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [checkouts, setCheckouts] = useState<CheckoutWithDoc[]>([]);
  // UX-11: the register the Documents card shows, for the tab badge.
  const [register, setRegister] = useState<ProjectDocumentRegister | null>(null);
  const [loading, setLoading] = useState(true);
  // Load errors (page can't render) vs action errors (page stays up, a
  // dismissible banner reports the failure). Sharing one state used to let a
  // failed COMMENT blank the entire project view.
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Tab lives in the URL (?tab=schedule) so views are linkable and refresh
  // keeps your place.
  const search = useSearchParams();
  const initialTab = ((): Tab => {
    const t = search?.get("tab");
    return t === "intake" || t === "costs" || t === "quality" || t === "activity" || t === "schedule" || t === "members" ? t : "documents";
  })();
  const [tab, setTabState] = useState<Tab>(initialTab);
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
    const t = search?.get("tab");
    if (t === "intake" || t === "costs" || t === "quality" || t === "activity" || t === "schedule" || t === "members" || t === "documents") {
      setTabState(t);
    }
  }, [search]);
  const [commentDraft, setCommentDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const [showEdit, setShowEdit] = useState(false);

  // Status-transition state
  const [pendingStatus, setPendingStatus] = useState<ProjectStatus | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [transitionBusy, setTransitionBusy] = useState(false);
  // Closeout gates: loaded when the Complete confirm opens, so the modal
  // shows exactly what's still outstanding before the project closes.
  const [gates, setGates] = useState<ProjectStateSnapshot | null>(null);
  // QUAL-8: a gather that failed is said, with a Retry — never a panel that
  // silently is not drawn while Confirm stays live.
  const [gatesError, setGatesError] = useState<string | null>(null);
  const [gatesTry, setGatesTry] = useState(0);
  // Wizard fields the typed Project doesn't carry — fetched tolerantly.
  const [jobKind, setJobKind] = useState<string | null>(null);
  // Lessons-learned editor
  const [lessonsDraft, setLessonsDraft] = useState<string | null>(null);
  // A11Y-4: what the editor opened with — every way out (Escape, the
  // backdrop, the header X, Cancel) asks before discarding edits, and closes
  // at once when nothing changed.
  const [lessonsSeed, setLessonsSeed] = useState<string | null>(null);
  const [lessonsBusy, setLessonsBusy] = useState(false);
  const discardLessons = async () => {
    if (lessonsBusy) return;
    if (lessonsDraft !== null && lessonsDraft !== lessonsSeed
      && !(await appConfirm({ title: "Discard your edits?", message: "The lessons-learned text you changed has not been saved.", confirmLabel: "Discard", tone: "danger" }))) return;
    setLessonsDraft(null);
  };
  // Coach re-gathers when page data changes.
  const [coachKey, setCoachKey] = useState(0);
  // PERF-8: the project row and roster this load already read, for the coach
  // (it mounts once they are here, so its gather never reads them again).
  const [coachPre, setCoachPre] = useState<SnapshotPreRead | null>(null);

  // Authority comes from projects.owner_user_id, never from a roster row's
  // role (PM-11: a roster 'owner' row is not the owner).
  const isOwner = project && uid && project.ownerUserId === uid;
  const myRosterRole = members.find((m) => m.userId === uid)?.role ?? null;
  const isMember = myRosterRole !== null;
  // PM-11 / UX-14: an observer is on the roster to SEE — no comment box
  // (the 20261102 insert policy refuses an observer's comment too).
  const canComment = isOwner || isAdmin || (isMember && myRosterRole !== "observer");
  const canManage = isOwner || isAdmin;
  const isClosed = !!project && CLOSED_PROJECT_STATUSES.has(project.status);

  // The header paints as soon as the project row lands (PERF-8); later
  // refreshes update in place instead of blanking the page to a spinner.
  const loadedOnce = React.useRef(false);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    if (!loadedOnce.current) setLoading(true);
    setError(null);
    try {
      const got = await getProjectForPage(projectId);
      if (!got) { setError("Project not found"); setLoading(false); return; }
      const proj = got.project;
      setProject(proj);
      setJobKind(got.jobKind);
      loadedOnce.current = true;
      setLoading(false);
      setTimelineFresh(false);

      const [m, ck] = await Promise.all([
        listMembers(projectId),
        listProjectCheckouts(projectId),
      ]);
      setMembers(m);
      // PERF-8: the coach mounts with what this load read, and gathers
      // beside the checkout hydration below rather than after it.
      setCoachPre({ project: got.row, members: m });
      activeOrgMemberIds(proj.orgId, m.map((x) => x.userId))
        .then(setActiveMemberIds)
        .catch(() => setActiveMemberIds(null));

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
      setCoachKey((k) => k + 1);
    } catch (e) {
      setError((e as Error)?.message ? userFacingCaughtError(e, { action: "read", context: "project page" }) : "Failed to load project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Closeout gates load when the Complete confirmation opens.
  useEffect(() => {
    if (pendingStatus !== "completed" || !project?.orgId || !projectId) { setGates(null); setGatesError(null); return; }
    let cancelled = false;
    setGates(null); setGatesError(null);
    void gatherProjectSnapshot(project.orgId, projectId)
      .then((s) => { if (!cancelled) setGates(s); })
      .catch((e) => { if (!cancelled) setGatesError(userFacingCaughtError(e, { action: "read", context: "closeout gates" })); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStatus, projectId, gatesTry]);

  useEffect(() => { void refresh(); }, [refresh]);

  // PERF-8: the timeline is fetched when the Activity tab is shown (and again
  // after a write marks it stale) — opening Documents never fetches it. A
  // newer request supersedes an older one still in flight.
  const timelineReq = React.useRef(0);
  useEffect(() => {
    if (tab !== "activity" || timelineFresh || !projectId) return;
    const mine = ++timelineReq.current;
    setTimelineError(null);
    setTimelineFresh(true);
    getProjectTimeline({ projectId, limit: 200 })
      .then((tl) => { if (mine === timelineReq.current) setTimeline(tl); })
      .catch((e) => { if (mine === timelineReq.current) setTimelineError((e as Error)?.message ? userFacingCaughtError(e, { action: "read", context: "project page" }) : "The timeline could not be loaded."); });
  }, [tab, timelineFresh, projectId]);

  // PM-1: a controller reopens a closed project — a distinct, audited action.
  const handleReopen = async () => {
    if (!project?.id || !uid) return;
    const reason = await appPrompt({
      title: "Reopen this project?",
      message: `It is ${project.status}. Reopening makes its cost, quality and schedule records writable again and clears the ${project.status === "cancelled" ? "cancellation" : "completion"} on the record. The reason is audited. Contractor intake links stay revoked — create new ones if the work continues.`,
      placeholder: "Why is this project being reopened?",
      confirmLabel: "Reopen",
    });
    if (reason === null) return;
    if (!reason.trim()) { setActionError("A reason is required to reopen a closed project."); return; }
    try {
      await reopenProject({ projectId: project.id, orgId: project.orgId, reason, actorUserId: uid, actorEmail: userEmail ?? undefined });
      await refresh();
    } catch (e) {
      setActionError(userFacingCaughtError(e, { context: "project page" }));
    }
  };

  // PM-6 / QUAL-3 / SEC-9: the delete confirm is driven by LIVE counts, and a
  // project carrying cost or quality records is archived, not deleted —
  // except by a controller, with a stated reason, audited with the counts.
  const handleDelete = async () => {
    if (!project?.id || !uid) return;
    let counts;
    try { counts = await countProjectRecords(project.id); }
    catch (e) { await appAlert({ message: `The project's records could not be counted, so nothing was deleted: ${userFacingCaughtError(e, { action: "read", context: "project page" })}`, tone: "danger" }); return; }
    const lines = describeProjectRecords(counts);
    const regulated = regulatedRecordTotal(counts);
    const list = lines.length ? `\n\nThis would permanently destroy:\n• ${lines.join("\n• ")}` : "\n\nNo cost, quality or schedule records are attached.";
    let reason: string | undefined;
    if (regulated === null || regulated > 0) {
      if (!isAdmin) {
        await appAlert({
          title: "This project can't be deleted",
          message: `It carries cost or quality records${regulated === null ? " (or they could not be counted)" : ""} — the project's financial and PSSR / turnover / punch record.${list}\n\n${isClosed ? "Archive it instead" : "Complete or cancel it, then archive it"} — the record stays intact and out of the active list.`,
          tone: "danger",
        });
        return;
      }
      if (!(await appConfirm({
        title: `Delete "${project.name}" and its record?`,
        message: `This project carries cost or quality records. Archiving keeps them; deleting destroys them and cannot be undone. The counts and a snapshot are written to the audit log.${list}`,
        tone: "danger", confirmLabel: "Continue to delete",
      }))) return;
      const typed = await appPrompt({
        title: "Reason for deleting a project with records",
        message: "Required — recorded in the PROJECT_DELETED audit row with the counts.",
        placeholder: "Why must this record be destroyed rather than archived?",
        confirmLabel: "Delete permanently",
      });
      if (typed === null) return;
      if (!typed.trim()) { await appAlert({ message: "A reason is required.", tone: "danger" }); return; }
      reason = typed.trim();
    } else if (!(await appConfirm({
      message: `Delete "${project.name}"? The project, its roster, feed and document links are removed and its contractor intake links are revoked. Document checkouts are kept (just unlinked). This cannot be undone.${list}`,
      tone: "danger", confirmLabel: "Delete",
    }))) return;
    try {
      await deleteProject({ projectId: project.id, actorUserId: uid, actorEmail: userEmail ?? undefined, actorRole: activeRole ?? undefined, reason });
      router.push("/projects");
    } catch (e) { await appAlert({ message: userFacingCaughtError(e, { context: "project page" }), tone: "danger" }); }
  };

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
      setActionError(userFacingCaughtError(e, { context: "project page" }));
    } finally { setPosting(false); }
  };

  /** A11Y-4: every way out of the status-transition confirm (Escape, the
   *  backdrop, the header X, Cancel) asks before discarding a typed reason —
   *  a cancellation's is mandatory — and closes at once when none was typed. */
  const discardTransition = async () => {
    if (transitionBusy) return;
    if (statusReason.trim()
      && !(await appConfirm({ title: "Discard your reason?", message: "The reason you typed has not been recorded, and the project's status is unchanged.", confirmLabel: "Discard", tone: "danger" }))) return;
    setPendingStatus(null); setStatusReason(""); setActionError(null);
  };

  const handleTransition = async () => {
    if (!project || !uid || !pendingStatus) return;
    // QUAL-8: a completion waits for its gates — the disabled Confirm is the
    // visible half; this keeps any other caller from recording none.
    if (pendingStatus === "completed" && !gates) return;
    if (pendingStatus === "cancelled" && !statusReason.trim()) {
      setActionError("Cancellation reason is required"); return;
    }
    setTransitionBusy(true);
    try {
      const { releaseError, activityError } = await transitionProjectStatus({
        projectId: project.id!,
        orgId: project.orgId,
        toStatus: pendingStatus,
        reason: statusReason || undefined,
        actorUserId: uid,
        actorEmail: userEmail ?? undefined,
        actorRole: activeRole,
        // SAF-14: the gates the actor was shown are what the audit row records.
        gateSnapshot: pendingStatus === "completed" ? gates : undefined,
      });
      setPendingStatus(null);
      setStatusReason("");
      await refresh();
      // DCK-9 / PM-4: the status DID change (refresh above shows it); what did
      // not happen — a checkout still held by someone — is shown against it.
      if (releaseError) setActionError(releaseError);
      else if (activityError) setActionError(`The project is ${pendingStatus}, but ${activityError.charAt(0).toLowerCase()}${activityError.slice(1)}`);
    } catch (e) {
      setActionError(userFacingCaughtError(e, { context: "project page" }));
      // The status may have changed before the throw; render the database's
      // state, never the pre-click one beside the message.
      await refresh().catch(() => undefined);
    } finally { setTransitionBusy(false); }
  };

  if (loading) return (
    <div className="min-h-full flex items-center justify-center">
      <Spinner />
    </div>
  );

  if (error || !project) return (
    <div className="min-h-full p-4 sm:p-8">
      <div role="alert" className="max-w-2xl mx-auto bg-rose-500/[0.08] border border-rose-500/40 rounded-xl p-4 text-sm text-rose-700 dark:text-rose-300 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          {error || "Project not found"}
          <div className="mt-2"><Link href="/projects" className="underline">Back to projects</Link></div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="pb-20">
      {/* HEADER */}
      <div className="bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5">
          <button onClick={() => { if (window.history.length > 1) router.back(); else router.push("/projects"); }} className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] mb-3">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to projects
          </button>

          {actionError && (
            <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-rose-500/50 bg-rose-500/[0.08] px-3 py-2.5 text-xs font-bold text-rose-700 dark:text-rose-300 animate-in fade-in slide-in-from-top-1">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="flex-1">{actionError}</span>
              <button onClick={() => setActionError(null)} className="shrink-0 text-rose-700 dark:text-rose-300 hover:opacity-80" aria-label="Dismiss">
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
                <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3" /> {project.ownerUserName || "—"}</span>
                {project.targetCompletionDate && <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" /> Target {formatDate(project.targetCompletionDate)}</span>}
                {project.mocReference && <span className="inline-flex items-center gap-1 font-mono"><Layers className="w-3 h-3" /> {project.mocReference}</span>}
                {project.cancelledReason && <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300"><AlertTriangle className="w-3 h-3" /> Cancelled: {project.cancelledReason}</span>}
                {project.linkedTicketId && (
                  <Link href={`/requests/${project.linkedTicketId}`} className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline">
                    <Hash className="w-3 h-3" /> Linked ticket
                  </Link>
                )}
              </div>
            </div>

            {canManage && project.status === "active" && (
              <div className="flex items-center gap-1">
                <ActionButton icon={<Pause className="w-3.5 h-3.5" />} label="Pause" onClick={() => setPendingStatus("paused")} />
                <ActionButton icon={<CheckCircle2 className="w-3.5 h-3.5" />} label="Complete" onClick={() => setPendingStatus("completed")} color="emerald" />
                <ActionButton icon={<XCircle className="w-3.5 h-3.5" />} label="Cancel" onClick={() => setPendingStatus("cancelled")} color="red" />
              </div>
            )}
            <ActionButton
              icon={<Download className="w-3.5 h-3.5" />}
              label="Export CSV"
              onClick={async () => {
                if (!project.id || !project.orgId) return;
                try { await exportProjectToCsv(project.id, project.orgId); }
                catch (e) { await appAlert({ message: userFacingCaughtError(e, { context: "project page" }), tone: "danger" }); }
              }}
            />
            {canManage && (
              <ActionButton
                icon={<Pencil className="w-3.5 h-3.5" />}
                label="Edit"
                onClick={() => setShowEdit(true)}
              />
            )}
            <ActionButton
              icon={<ShieldCheck className="w-3.5 h-3.5" />}
              label="Evidence pack"
              onClick={async () => {
                if (!project.id) return;
                try { await openProjectEvidencePack(project.id); }
                catch (e) { await appAlert({ message: userFacingCaughtError(e, { context: "project page" }), tone: "danger" }); }
              }}
            />
            <ActionButton
              icon={<FileText className="w-3.5 h-3.5" />}
              label="Report"
              onClick={async () => {
                if (!project.id || !project.orgId) return;
                try { await openProjectReport(project.orgId, project.id); }
                catch (e) { await appAlert({ message: userFacingCaughtError(e, { context: "project page" }), tone: "danger" }); }
              }}
            />
            {canManage && (project.status === "completed" || project.status === "active" || project.status === "paused") && (
              <ActionButton
                icon={<Target className="w-3.5 h-3.5" />}
                label="Lessons learned"
                onClick={async () => {
                  if (!project.id || !project.orgId) return;
                  setLessonsBusy(true);
                  try {
                    const existing = await supabase.from("projects").select("lessons_learned").eq("id", project.id).maybeSingle();
                    const stored = (existing.data as { lessons_learned?: string | null } | null)?.lessons_learned ?? null;
                    const seed = stored || await draftLessonsLearned(project.orgId, project.id);
                    setLessonsSeed(seed);
                    setLessonsDraft(seed);
                  } catch (e) {
                    await appAlert({ message: userFacingCaughtError(e, { context: "project page" }), tone: "danger" });
                  } finally { setLessonsBusy(false); }
                }}
              />
            )}
            {/* UX-15: the four exports, told apart where they sit. */}
            <HelpTooltip label="What each export contains" placement="bottom">
              <b>Export CSV</b> — a spreadsheet of this project&rsquo;s record, its documents and their checkouts, to open in Excel.
              <b className="block mt-1">Evidence pack</b> — a printable record for an auditor: the team, the schedule, formal document issues (transmittals) and the audit trail.
              <b className="block mt-1">Report</b> — a printable brief for management: money and forecast, schedule, quality and closeout, and the contractors on the job.
              {canManage && <><b className="block mt-1">Lessons learned</b> — drafted from this project&rsquo;s history for you to edit and save; the Report prints it.</>}
            </HelpTooltip>
            {project.id && project.orgId && uid && (
              <>
                <WatchButton
                  orgId={project.orgId}
                  userId={uid}
                  resourceType="project"
                  resourceId={project.id}
                />
                <PresenceIndicator
                  resourceType="project"
                  resourceId={project.id}
                  userId={uid}
                  userName={userEmail?.split("@")[0]}
                  role={activeRole || undefined}
                />
              </>
            )}
            {canManage && project.status === "paused" && (
              <div className="flex items-center gap-1">
                <ActionButton icon={<Play className="w-3.5 h-3.5" />} label="Resume" onClick={() => setPendingStatus("active")} color="emerald" />
                <ActionButton icon={<XCircle className="w-3.5 h-3.5" />} label="Cancel" onClick={() => setPendingStatus("cancelled")} color="red" />
              </div>
            )}
            {canManage && (project.status === "completed" || project.status === "cancelled") && (
              <ActionButton icon={<ArchiveIcon className="w-3.5 h-3.5" />} label="Archive" onClick={() => setPendingStatus("archived")} />
            )}
            {/* PM-1: reopening a closed project is a controller's audited act. */}
            {isAdmin && isClosed && (
              <ActionButton icon={<Play className="w-3.5 h-3.5" />} label="Reopen" onClick={() => void handleReopen()} />
            )}
            {canManage && (
              <ActionButton
                icon={<Trash2 className="w-3.5 h-3.5" />}
                label="Delete"
                color="red"
                onClick={() => void handleDelete()}
              />
            )}
          </div>

          {/* TABS */}
          <div className="mt-5 flex items-center gap-1 border-b border-[var(--color-border)] -mb-px overflow-x-auto [scrollbar-width:none]">
            {/* A11Y-7: a real tab strip — a screen reader hears which tab is selected. */}
            <div role="tablist" aria-label="Project sections" className="flex items-center gap-1">
            <TabButton active={tab === "documents"} onClick={() => setTab("documents")}>
              <FileText className="w-3.5 h-3.5" /> Documents <span className="text-[10px] text-[var(--color-text-faint)]">{documentsTabCount(register, checkouts.map((c) => c.documentId))}</span>
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
              <ActivityIcon className="w-3.5 h-3.5" /> Activity {timeline && <span className="text-[10px] text-[var(--color-text-faint)]">{timeline.length}</span>}
            </TabButton>
            <TabButton active={tab === "schedule"} onClick={() => setTab("schedule")}>
              <Flag className="w-3.5 h-3.5" /> Schedule
            </TabButton>
            <TabButton active={tab === "members"} onClick={() => setTab("members")}>
              <Users className="w-3.5 h-3.5" /> Members <span className="text-[10px] text-[var(--color-text-faint)]">{members.length}</span>
            </TabButton>
            </div>
            <div className="ml-1 pb-2">
              <HelpTooltip>
                <b>Documents</b> — the project&rsquo;s document register (checked-out, attached and approved contractor documents, each marked current or not), then every checkout taken under the project (active + released). The badge counts distinct documents.
                <b className="block mt-1">Activity</b> — the project&rsquo;s full timeline: comments, doc events, holds, tasks finished.
                <b className="block mt-1">Schedule</b> — tasks with planned/actual dates and an Earned-Value rollup. Import P6/MS Project as ghost overlay.
                <b className="block mt-1">Members</b> — who&rsquo;s on this project. Owner can add/remove.
              </HelpTooltip>
            </div>
          </div>
        </div>
      </div>

      {/* CONTENT — schedule tab needs full page width to render the
          execution canvas; everything else keeps the comfortable
          reading width. */}
      <div role="tabpanel" id="project-tabpanel" aria-label={`${TAB_LABEL[tab]} tab`}
        className={`${tab === "schedule" ? "max-w-[1800px] mx-auto px-4" : "max-w-6xl mx-auto px-4 sm:px-6"} py-6`}>
        {/* Health + "what do I feed you" — the wizard for the rest of the
            project's life, visible from every tab. */}
        {project.id && project.orgId && tab !== "schedule" && coachPre && (
          <TabErrorBoundary label="The project coach" resetKey={tab}>
            <ProjectCoach orgId={project.orgId} projectId={project.id} refreshKey={coachKey} preRead={coachPre} />
          </TabErrorBoundary>
        )}
        {/* REL-5: each tab renders inside its own boundary — one tab's crash
            leaves the header, the tab bar and the other tabs usable. */}
        <TabErrorBoundary label={`The ${TAB_LABEL[tab]} tab`} resetKey={tab}>
        {tab === "documents" && (
          <div className="space-y-4">
            {project.id && project.orgId && uid && (
              <ProjectDocumentsCard
                orgId={project.orgId}
                projectId={project.id}
                canManage={!!canManage}
                uid={uid}
                userEmail={userEmail}
                onLoaded={setRegister}
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
        {(tab === "intake" || tab === "schedule") && !uid && (
          <div className="py-10 flex justify-center"><Spinner /></div>
        )}
        {tab === "costs" && project.id && project.orgId && uid && (
          <CostsTab
            orgId={project.orgId}
            projectId={project.id}
            canManage={!!isAdmin || !!isOwner}
            uid={uid}
            userEmail={userEmail}
            onDataChanged={() => setCoachKey((k) => k + 1)}
          />
        )}
        {tab === "quality" && project.id && project.orgId && uid && (
          <QualityTab
            orgId={project.orgId}
            projectId={project.id}
            canManage={!!canManage}
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
            <div className="text-xs text-[var(--color-text-muted)] mt-1">Contractor submissions land here for review — approved revisions show up under Documents automatically.</div>
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
            timelineError={timelineError}
            canComment={!!canComment}
            commentDraft={commentDraft}
            setCommentDraft={setCommentDraft}
            posting={posting}
            onPost={handlePostComment}
          />
        )}
        {tab === "schedule" && uid && (
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
          />
        )}
        {tab === "members" && (
          <MembersTab
            project={project}
            members={members}
            activeMemberIds={activeMemberIds}
            canManage={!!canManage}
            onAdded={() => void refresh()}
            actorUserId={uid!}
            actorEmail={userEmail ?? undefined}
          />
        )}
        </TabErrorBoundary>
      </div>

      {/* Lessons-learned editor — auto-drafted from the project's exhaust
          (change orders by reason, slips, rejections), edited by a human. */}
      {lessonsDraft !== null && (
        <Modal size="lg" dismissable={!lessonsBusy} className="overflow-hidden" onClose={() => void discardLessons()}>
            {/* A11Y-4: every way out — Escape, the backdrop, the header X and
                Cancel — asks before discarding edited text. The middle
                scrolls (min-h-0) and the footer never shrinks, so Save stays
                on screen on a short viewport or after the textarea is
                dragged taller. */}
            <ModalHeader title="Lessons learned" onClose={lessonsBusy ? undefined : () => void discardLessons()}
              subtitle="Drafted from this project's own records — change orders, slips, rejections. Edit it into what the next job should know; it saves to the project and prints on the report." />
            <div className="px-6 py-4 overflow-y-auto min-h-0">
              <textarea value={lessonsDraft} onChange={(e) => setLessonsDraft(e.target.value)} rows={12} aria-label="Lessons learned"
                className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-xs font-mono resize-y focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
            </div>
            <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2 shrink-0">
              <button onClick={() => void discardLessons()} disabled={lessonsBusy}
                className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Cancel</button>
              <button
                onClick={async () => {
                  if (!project?.id || !project.orgId || !uid) return;
                  setLessonsBusy(true);
                  const res = await saveLessonsLearned({ orgId: project.orgId, projectId: project.id, text: lessonsDraft, actorId: uid, actorEmail: userEmail });
                  setLessonsBusy(false);
                  if (!res.ok) { setActionError(res.error ?? "Couldn't save lessons learned."); return; }
                  setLessonsDraft(null);
                }}
                disabled={lessonsBusy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
                {lessonsBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save to project
              </button>
            </div>
        </Modal>
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
        <Modal size="md" dismissable={!transitionBusy} className="overflow-hidden"
          onClose={() => void discardTransition()}>
            <ModalHeader
              title={pendingStatus === "cancelled" ? "Cancel project" :
                pendingStatus === "completed" ? "Mark project complete" :
                pendingStatus === "archived" ? "Archive project" :
                pendingStatus === "paused" ? "Pause project" :
                "Resume project"}
              subtitle={pendingStatus === "cancelled" || pendingStatus === "completed" || pendingStatus === "archived"
                ? "Active checkouts on this project will be released. A checkout you are not allowed to release stays with its holder, and you will be told who still holds what. The project's contractor intake links are revoked, and its cost, quality and schedule records become read-only until an Admin / Document Control reopens it."
                : "No checkouts will be affected."}
              onClose={transitionBusy ? undefined : () => void discardTransition()} />
            <div className="overflow-y-auto min-h-0">
            {/* Closeout gates — what a finished job should have closed out.
                Warnings, not walls: the owner can complete anyway, on the record.
                QUAL-8: until they are on screen — loading, or a gather that
                failed (said, with Retry) — Confirm waits. */}
            {pendingStatus === "completed" && !gates && (
              <CloseoutGatesPending error={gatesError} onRetry={() => setGatesTry((n) => n + 1)} />
            )}
            {pendingStatus === "completed" && gates && (() => {
              // SAF-14: the same lines lib/projects.ts records in the
              // completion's audit row — what the report prints as "open at
              // closeout". A gate whose read failed is unknown, not clear.
              const gateLines = closeoutGateLines(gates);
              const failed = gateLines.filter((g) => g.ok !== true).length;
              return (
                <div className="px-6 pt-4">
                  <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">Closeout gates</div>
                  <ul className="space-y-1">
                    {gateLines.map((g) => (
                      <li key={g.key} className={`flex items-center gap-2 text-xs font-bold ${g.ok === true ? "text-emerald-700 dark:text-emerald-300" : g.ok === false ? "text-amber-700 dark:text-amber-300" : "text-[var(--color-text-muted)]"}`}>
                        {g.ok === true ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
                        {g.text}
                      </li>
                    ))}
                  </ul>
                  {failed > 0 && (
                    <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                      {CLOSEOUT_GATE_POLICY.overrideNote} The gate state above is recorded with the completion.
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="px-6 py-5">
              <label htmlFor="transition-reason" className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">
                Reason {pendingStatus === "cancelled" ? "*" : "(optional)"}
              </label>
              <textarea
                id="transition-reason"
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                rows={3}
                className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
                placeholder={pendingStatus === "cancelled" ? "Why is this project being cancelled?" : "Optional note for the audit log"}
              />
              {actionError && <div role="alert" className="mt-2 text-xs font-bold text-rose-700 dark:text-rose-300">{actionError}</div>}
            </div>
            </div>
            <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2 shrink-0">
              <button onClick={() => void discardTransition()} disabled={transitionBusy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Cancel</button>
              <button onClick={handleTransition} disabled={transitionBusy || (pendingStatus === "completed" && !gates)}
                title={pendingStatus === "completed" && !gates ? CLOSEOUT_GATES_WAIT : undefined}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
                {transitionBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Confirm
              </button>
            </div>
        </Modal>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ProjectStatus }) {
  const cls: Record<ProjectStatus, string> = {
    active: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border-emerald-500/40",
    paused: "bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/40",
    completed: "bg-blue-500/10 text-blue-800 dark:text-blue-300 border-blue-500/40",
    cancelled: "bg-rose-500/10 text-rose-800 dark:text-rose-300 border-rose-500/40",
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
    ? "border-rose-500/40 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300 hover:bg-rose-500/15"
    : color === "emerald"
    ? "border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/15"
    : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]";
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors ${cls}`}>
      {icon}{label}
    </button>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      aria-controls={active ? "project-tabpanel" : undefined}
      className={`px-4 py-2.5 text-xs font-bold inline-flex items-center gap-1.5 border-b-2 transition-colors ${
        active ? "border-[var(--color-accent)] text-[var(--color-accent)]" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {children}
    </button>
  );
}

const TAB_LABEL: Record<Tab, string> = {
  documents: "Documents", intake: "Intake", costs: "Costs", quality: "Quality",
  activity: "Activity", schedule: "Schedule", members: "Members",
};

/** UX-11: the SECONDARY list under the register card — the checkout
 *  sessions taken under this project (one row per session). */
function DocumentsTab({ checkouts }: { checkouts: CheckoutWithDoc[] }) {
  if (checkouts.length === 0) {
    return (
      <div className="bg-[var(--color-surface)] border border-dashed border-[var(--color-border-strong)] rounded-2xl p-6 text-center">
        <FileText className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
        <p className="text-xs text-[var(--color-text-muted)]">No checkouts under this project yet. Open a document in a library and check it out to this project — it joins the register above.</p>
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
      <div className={`px-4 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between text-xs font-bold ${tone === "active" ? "bg-emerald-500/[0.08] text-emerald-800 dark:text-emerald-300" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
        <span>{title}</span>
        <span className="text-[10px] font-mono bg-[var(--color-surface)] border border-[var(--color-border)] px-1.5 py-0.5 rounded-full">{count}</span>
      </div>
      {children}
    </div>
  );
}

function CheckoutLine({ c, historical }: { c: CheckoutWithDoc; historical?: boolean }) {
  return (
    <div className={`px-4 py-3 hover:bg-[var(--color-surface-2)] transition-colors ${historical ? "opacity-70" : ""}`}>
      <div className="flex items-center gap-3">
        <FileText className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm font-bold text-[var(--color-text)] truncate">{c.docNumber || "—"}</span>
            <span className="text-xs text-[var(--color-text-muted)] truncate">{c.docTitle}</span>
            {c.libraryName && <span className="text-[10px] text-[var(--color-text-faint)]">in {c.libraryName}</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
            <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3" />{c.userName}</span>
            <span className="text-[10px] font-bold uppercase bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{c.mode}</span>
            <span>{historical ? `Released ${formatRelative(c.releasedAt ?? c.endedAt)}` : `Since ${formatRelative(c.startedAt)}`}</span>
            {c.releasedReason && <span className="text-[var(--color-text-faint)] italic">— {c.releasedReason}</span>}
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
  timeline, timelineError, canComment, commentDraft, setCommentDraft, posting, onPost,
}: {
  timeline: TimelineEvent[] | null;
  timelineError: string | null;
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

      {timelineError ? (
        <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/[0.06] px-4 py-3 text-xs font-bold text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> The timeline could not be loaded: {timelineError}
        </div>
      ) : timeline === null ? (
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : (
        <TimelineFeed
          events={timeline}
          showScope={false}
          emptyMessage="No activity yet — comments, status changes, awards, change orders, quality rulings and document revisions will land here."
        />
      )}
    </div>
  );
}

function MembersTab({
  project, members, activeMemberIds, canManage, onAdded, actorUserId, actorEmail,
}: {
  project: Project;
  members: ProjectMember[];
  /** SEC-15: roster members active in the org (null = unknown). */
  activeMemberIds: Set<string> | null;
  canManage: boolean;
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
      // Case-insensitive exact lookup (IDENT-3): a plain eq missed rows
      // stored before email normalization, and made the two-row collision
      // refusal below case-blind.
      const { data: userRows } = await applyEmailLookup(supabase.from("users").select("id, email"), "email", email).limit(2);
      const candidates = (userRows ?? []) as Array<{ id: string; email: string }>;
      if (candidates.length > 1) throw new Error("Multiple accounts share that email — contact your admin.");
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
      setError(userFacingCaughtError(e, { context: "project page" }));
    } finally { setBusy(false); }
  };

  const saveResp = async (m: ProjectMember) => {
    const next = editingResp[m.userId];
    if (next === undefined) return;
    try {
      await updateMember({ projectId: project.id!, userId: m.userId, responsibility: next, actorUserId });
      setEditingResp((p) => { const n = { ...p }; delete n[m.userId]; return n; });
      onAdded();
    } catch (e) { await appAlert({ message: userFacingCaughtError(e, { context: "project page" }), tone: "danger" }); }
  };

  const makeOwner = async (m: ProjectMember) => {
    if (!(await appConfirm(`Transfer ownership to ${m.userName || m.userEmail || m.userId}? You'll become a collaborator.`))) return;
    try {
      await transferOwnership({
        projectId: project.id!, newOwnerUserId: m.userId,
        newOwnerName: m.userName ?? undefined, newOwnerEmail: m.userEmail ?? undefined,
        actorUserId, actorEmail,
      });
      onAdded();
    } catch (e) { await appAlert({ message: userFacingCaughtError(e, { context: "project page" }), tone: "danger" }); }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-4 shadow-sm">
          <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-2">Add member</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="user@example.com"
              className="flex-1 px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
            {/* UX-14 / PM-11: the observer role is enforced — the database's
                can_manage_project excludes it (20261047) and the activity
                insert policy refuses an observer's comment (20261102). */}
            <Select value={addRole} onChange={(e) => setAddRole(e.target.value as ProjectMemberRole)} aria-label="Project role">
              <option value="collaborator">Collaborator — works on it, comments</option>
              <option value="observer">Observer — can see, cannot manage or comment</option>
            </Select>
          </div>
          <input value={addResp} onChange={(e) => setAddResp(e.target.value)} placeholder="Responsibility (what they own / will own) — optional"
            className="mt-2 w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
          <div className="mt-2 flex justify-end">
            <button onClick={addByEmail} disabled={busy || !addEmail.trim()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add member
            </button>
          </div>
          {error && <div role="alert" className="mt-2 text-xs font-bold text-rose-700 dark:text-rose-300">{error}</div>}
        </div>
      )}

      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
        <div className="divide-y divide-[var(--color-border)]">
          {members.map((m) => {
            // PM-11: authority is projects.owner_user_id — a roster row that
            // merely SAYS 'owner' is not the owner and gets no protection.
            const isOwner = m.userId === project.ownerUserId;
            const rosterOwnerOnly = !isOwner && m.role === "owner";
            const canRemove = canManage && !isOwner;
            // SEC-15: ownership can only go to an ACTIVE member of the org.
            const canReceiveOwnership = canManage && !isOwner && activeMemberIds !== null && activeMemberIds.has(m.userId);
            const respDraft = editingResp[m.userId];
            return (
              <div key={m.id} className="px-4 py-3 flex items-start gap-3 group">
                <div className="p-2 bg-[var(--color-accent-soft)] rounded-full text-[var(--color-accent)] mt-0.5"><UserIcon className="w-4 h-4" /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-[var(--color-text)] truncate">{m.userName || m.userEmail || m.userId.slice(0, 8)}</span>
                    <span
                      className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${isOwner ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : m.role === "collaborator" ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}
                      title={rosterOwnerOnly ? "Recorded as owner on the roster, but the project's owner is someone else — no owner authority." : m.role === "observer" ? "Can see this project; cannot manage it or comment." : undefined}
                    >{isOwner ? "owner" : rosterOwnerOnly ? "owner (roster only)" : m.role}</span>
                    {activeMemberIds !== null && !activeMemberIds.has(m.userId) && (
                      <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-700 dark:text-rose-300" title="No longer an active member of this workspace">inactive</span>
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
                  {canReceiveOwnership && (
                    <button onClick={() => void makeOwner(m)} title="Transfer ownership to this member"
                      className="opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity text-[11px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] px-1.5 py-1 rounded hover:bg-[var(--color-accent-soft)] whitespace-nowrap">
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
                        } catch (e) { await appAlert({ message: userFacingCaughtError(e, { context: "project page" }), tone: "danger" }); }
                      }}
                      title="Remove from project"
                      className="opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md text-[var(--color-text-faint)] hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-500/10"
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
  if (!ts) return "—";
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
  } catch { return "—"; }
}
