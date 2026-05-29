"use client";

// /projects/[id] — project detail with three tabs:
//   1. Documents — every checkout attached to this project (released + active)
//   2. Activity  — chronological feed of comments + system events
//   3. Members   — who's on the project, with add/remove for owner
//
// Project owner gets a settings strip up top with status-transition buttons:
// Pause / Resume / Complete / Cancel / Archive. Status changes auto-release
// every active checkout (handled in lib/projects.ts).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Briefcase, ArrowLeft, Lock, Globe, Loader2, AlertTriangle, Pause, Play,
  CheckCircle2, XCircle, Archive as ArchiveIcon, Layers, Calendar, Send,
  User as UserIcon, MessageSquare, Users, FileText, Settings, Activity as ActivityIcon,
  ExternalLink, Hash, Trash2, Plus, Flag, X, Download,
} from "lucide-react";
import { exportProjectToCsv } from "@/lib/projectExport";
import WatchButton from "@/components/ui/WatchButton";
import QuickNoteComposer from "@/components/notes/QuickNoteComposer";
import PresenceIndicator from "@/components/ui/PresenceIndicator";
import { useRole } from "@/components/providers/RoleContext";
import {
  getProject, listMembers, listActivity, listProjectCheckouts,
  postComment, transitionProjectStatus, addMember, removeMember,
} from "@/lib/projects";
import { getProjectTimeline, type TimelineEvent } from "@/lib/timeline";
import TimelineFeed from "@/components/documents/TimelineFeed";
import ScheduleTab from "@/components/projects/ScheduleTab";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { supabase } from "@/lib/supabase";
import type {
  Project, ProjectMember, ProjectActivity, CheckoutSession, ProjectStatus,
} from "@/types/schema";

type Tab = "documents" | "activity" | "schedule" | "members";

type CheckoutWithDoc = CheckoutSession & {
  docNumber?: string;
  docTitle?: string;
  libraryName?: string;
};

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const isAdmin = activeRole === "Admin" || activeRole === "DocCtrl";

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
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("documents");
  const [commentDraft, setCommentDraft] = useState("");
  const [posting, setPosting] = useState(false);

  // Status-transition state
  const [pendingStatus, setPendingStatus] = useState<ProjectStatus | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [transitionBusy, setTransitionBusy] = useState(false);

  const isOwner = project && uid && project.ownerUserId === uid;
  const isMember = members.some((m) => m.userId === uid);
  const canComment = isOwner || isMember || isAdmin;
  const canManage = isOwner || isAdmin;

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
    } catch (e) {
      setError((e as Error).message || "Failed to load project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

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
      setError((e as Error).message);
    } finally { setPosting(false); }
  };

  const handleTransition = async () => {
    if (!project || !uid || !pendingStatus) return;
    if (pendingStatus === "cancelled" && !statusReason.trim()) {
      setError("Cancellation reason is required"); return;
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
      setError((e as Error).message);
    } finally { setTransitionBusy(false); }
  };

  if (loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
    </div>
  );

  if (error || !project) return (
    <div className="min-h-screen bg-slate-50 p-8">
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
    <div className="min-h-screen bg-slate-50 pb-20">
      {/* HEADER */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <button onClick={() => router.push("/projects")} className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-900 mb-3">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to projects
          </button>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1.5">
                <StatusBadge status={project.status} />
                {project.visibility === "private" ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                    <Lock className="w-2.5 h-2.5" /> Private
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded">
                    <Globe className="w-2.5 h-2.5" /> Public
                  </span>
                )}
              </div>
              <h1 className="text-2xl font-black text-slate-900 flex items-center gap-2">
                <Briefcase className="w-6 h-6 text-indigo-600" /> {project.name}
              </h1>
              {project.description && (
                <p className="text-sm text-slate-600 mt-2 max-w-3xl">{project.description}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3" /> {project.ownerUserName || "—"}</span>
                {project.targetCompletionDate && <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" /> Target {formatDate(project.targetCompletionDate)}</span>}
                {project.mocReference && <span className="inline-flex items-center gap-1 font-mono"><Layers className="w-3 h-3" /> {project.mocReference}</span>}
                {project.cancelledReason && <span className="inline-flex items-center gap-1 text-red-600"><AlertTriangle className="w-3 h-3" /> Cancelled: {project.cancelledReason}</span>}
                {project.linkedTicketId && (
                  <Link href={`/requests/${project.linkedTicketId}`} className="inline-flex items-center gap-1 text-indigo-700 hover:underline">
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
                catch (e) { alert((e as Error).message); }
              }}
            />
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
          </div>

          {/* TABS */}
          <div className="mt-5 flex items-center gap-1 border-b border-slate-200 -mb-px">
            <TabButton active={tab === "documents"} onClick={() => setTab("documents")}>
              <FileText className="w-3.5 h-3.5" /> Documents <span className="text-[10px] text-slate-400">{checkouts.length}</span>
            </TabButton>
            <TabButton active={tab === "activity"} onClick={() => setTab("activity")}>
              <ActivityIcon className="w-3.5 h-3.5" /> Activity <span className="text-[10px] text-slate-400">{activity.length}</span>
            </TabButton>
            <TabButton active={tab === "schedule"} onClick={() => setTab("schedule")}>
              <Flag className="w-3.5 h-3.5" /> Schedule
            </TabButton>
            <TabButton active={tab === "members"} onClick={() => setTab("members")}>
              <Users className="w-3.5 h-3.5" /> Members <span className="text-[10px] text-slate-400">{members.length}</span>
            </TabButton>
            <div className="ml-1 pb-2">
              <HelpTooltip>
                <b>Documents</b> — every checkout attached to this project (active + released).
                <b className="block mt-1">Activity</b> — the project's full timeline: comments, doc events, holds, milestone hits.
                <b className="block mt-1">Schedule</b> — milestones with planned/actual dates and an Earned-Value rollup. Import P6/MS Project as ghost overlay.
                <b className="block mt-1">Members</b> — who's on this project. Owner can add/remove.
              </HelpTooltip>
            </div>
          </div>
        </div>
      </div>

      {/* CONTENT */}
      <div className="max-w-6xl mx-auto px-6 py-6">
        {tab === "documents" && (
          <div className="space-y-4">
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
          />
        )}
        {tab === "members" && (
          <MembersTab
            project={project}
            members={members}
            canManage={!!canManage}
            onAdded={() => void refresh()}
            actorUserId={uid!}
            actorEmail={userEmail ?? undefined}
          />
        )}
      </div>

      {/* TRANSITION CONFIRM */}
      {pendingStatus && (
        <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200">
              <div className="text-sm font-black text-slate-900">
                {pendingStatus === "cancelled" ? "Cancel project" :
                 pendingStatus === "completed" ? "Mark project complete" :
                 pendingStatus === "archived" ? "Archive project" :
                 pendingStatus === "paused" ? "Pause project" :
                 "Resume project"}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {pendingStatus === "cancelled" || pendingStatus === "completed" || pendingStatus === "archived"
                  ? "Every active checkout on this project will be released."
                  : "No checkouts will be affected."}
              </div>
            </div>
            <div className="px-6 py-5">
              <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">
                Reason {pendingStatus === "cancelled" ? "*" : "(optional)"}
              </label>
              <textarea
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                rows={3}
                className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-y focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder={pendingStatus === "cancelled" ? "Why is this project being cancelled?" : "Optional note for the audit log"}
              />
              {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button onClick={() => { setPendingStatus(null); setStatusReason(""); setError(null); }} disabled={transitionBusy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
              <button onClick={handleTransition} disabled={transitionBusy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60">
                {transitionBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Confirm
              </button>
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
    archived: "bg-slate-100 text-slate-700 border-slate-200",
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
    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100";
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
      className={`px-4 py-2.5 text-xs font-bold inline-flex items-center gap-1.5 border-b-2 transition-colors ${
        active ? "border-indigo-600 text-indigo-600" : "border-transparent text-slate-500 hover:text-slate-900"
      }`}
    >
      {children}
    </button>
  );
}

function DocumentsTab({ checkouts }: { checkouts: CheckoutWithDoc[] }) {
  if (checkouts.length === 0) {
    return (
      <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-10 text-center">
        <FileText className="w-10 h-10 mx-auto text-slate-300 mb-3" />
        <p className="text-sm text-slate-500">No documents checked out yet. Open a doc in a library and check it out to this project.</p>
      </div>
    );
  }
  const active = checkouts.filter((c) => c.status === "active");
  const released = checkouts.filter((c) => c.status !== "active");
  return (
    <div className="space-y-4">
      {active.length > 0 && (
        <Section title="Currently checked out" count={active.length} tone="active">
          <div className="divide-y divide-slate-100">
            {active.map((c) => <CheckoutLine key={c.id} c={c} />)}
          </div>
        </Section>
      )}
      {released.length > 0 && (
        <Section title="Previously checked out" count={released.length} tone="muted">
          <div className="divide-y divide-slate-100">
            {released.map((c) => <CheckoutLine key={c.id} c={c} historical />)}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, tone, children }: { title: string; count: number; tone: "active" | "muted"; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
      <div className={`px-4 py-2.5 border-b border-slate-200 flex items-center justify-between text-xs font-bold ${tone === "active" ? "bg-emerald-50/40 text-emerald-800" : "bg-slate-50 text-slate-600"}`}>
        <span>{title}</span>
        <span className="text-[10px] font-mono bg-white border border-slate-200 px-1.5 py-0.5 rounded-full">{count}</span>
      </div>
      {children}
    </div>
  );
}

function CheckoutLine({ c, historical }: { c: CheckoutWithDoc; historical?: boolean }) {
  return (
    <div className={`px-4 py-3 hover:bg-slate-50/60 ${historical ? "opacity-70" : ""}`}>
      <div className="flex items-center gap-3">
        <FileText className="w-4 h-4 text-slate-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm font-bold text-slate-900 truncate">{c.docNumber || "—"}</span>
            <span className="text-xs text-slate-600 truncate">{c.docTitle}</span>
            {c.libraryName && <span className="text-[10px] text-slate-400">in {c.libraryName}</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3" />{c.userName}</span>
            <span className="text-[10px] font-bold uppercase bg-slate-100 px-1.5 py-0.5 rounded">{c.mode}</span>
            <span>{historical ? `Released ${formatRelative(c.releasedAt ?? c.endedAt)}` : `Since ${formatRelative(c.startedAt)}`}</span>
            {c.releasedReason && <span className="text-slate-400 italic">— {c.releasedReason}</span>}
          </div>
          {(c.purpose || c.note) && (
            <div className="mt-1 text-[11px] text-slate-600 italic line-clamp-1">&ldquo;{c.purpose || c.note}&rdquo;</div>
          )}
        </div>
        <Link
          href={`/documents/${c.libraryId}?doc=${c.documentId}`}
          className="p-1.5 rounded-md text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"
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
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-indigo-100 rounded-lg shrink-0">
              <MessageSquare className="w-4 h-4 text-indigo-700" />
            </div>
            <div className="flex-1">
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Share an update, ask a question, or comment on someone's work…"
                rows={2}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-y focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="mt-2 flex items-center justify-end">
                <button
                  onClick={onPost}
                  disabled={!commentDraft.trim() || posting}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50"
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
        emptyMessage="No activity yet — comments, checkouts, and document revisions will land here."
      />
    </div>
  );
}

function MembersTab({
  project, members, canManage, onAdded, actorUserId, actorEmail,
}: {
  project: Project;
  members: ProjectMember[];
  canManage: boolean;
  onAdded: () => void;
  actorUserId: string;
  actorEmail?: string;
}) {
  const [addEmail, setAddEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addByEmail = async () => {
    const email = addEmail.trim().toLowerCase();
    if (!email) return;
    setBusy(true); setError(null);
    try {
      // Resolve email → user via the users table (best-effort; if not found,
      // we still add a placeholder member-by-email)
      const { data } = await supabase.from("users").select("id, email").eq("email", email).maybeSingle();
      if (!data?.id) throw new Error("No user with that email found in this org");
      await addMember({
        projectId: project.id!,
        orgId: project.orgId,
        userId: data.id as string,
        userEmail: email,
        userName: email.split("@")[0],
        actorUserId,
        actorEmail,
      });
      setAddEmail("");
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest mb-2">Add member</div>
          <div className="flex gap-2">
            <input
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              placeholder="user@example.com"
              className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
            />
            <button onClick={addByEmail} disabled={busy || !addEmail.trim()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Add
            </button>
          </div>
          {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="divide-y divide-slate-100">
          {members.map((m) => {
            const isOwner = m.role === "owner" || m.userId === project.ownerUserId;
            const canRemove = canManage && !isOwner;
            return (
              <div key={m.id} className="px-4 py-3 flex items-center gap-3 group">
                <div className="p-2 bg-indigo-100 rounded-full text-indigo-700">
                  <UserIcon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-slate-900 truncate">{m.userName || m.userEmail || m.userId.slice(0, 8)}</div>
                  {m.userEmail && <div className="text-xs text-slate-500 truncate">{m.userEmail}</div>}
                </div>
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                  isOwner ? "bg-indigo-100 text-indigo-700"
                  : m.role === "collaborator" ? "bg-slate-100 text-slate-700"
                  : "bg-slate-50 text-slate-500"
                }`}>{isOwner ? "owner" : m.role}</span>
                {canRemove && (
                  <button
                    onClick={async () => {
                      if (!confirm(`Remove ${m.userEmail || m.userName || m.userId} from this project?`)) return;
                      try {
                        await removeMember({
                          projectId: project.id!,
                          orgId: project.orgId,
                          userId: m.userId,
                          userName: m.userName ?? undefined,
                          userEmail: m.userEmail ?? undefined,
                          actorUserId,
                          actorEmail,
                        });
                        onAdded();
                      } catch (e) {
                        alert((e as Error).message);
                      }
                    }}
                    title="Remove from project"
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatDate(ts: any): string {
  if (!ts) return "";
  try { return new Date(ts as string).toLocaleDateString(); } catch { return String(ts); }
}
function formatRelative(ts: any): string {
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
