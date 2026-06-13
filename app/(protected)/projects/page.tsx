"use client";

// /projects — org-wide list of every project anyone can see.
//
// Public projects are visible to every user in the org; private projects
// surface only for members + owners. Admin / DocCtrl always see everything.
// Default sort is most-recent-activity. Filters across status / owner / text.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Briefcase, Plus, Search, Lock, Globe, Loader2, AlertTriangle,
  Calendar, User as UserIcon, Layers, ChevronRight, Download,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { appAlert } from "@/components/providers/DialogProvider";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { listProjects, createProject } from "@/lib/projects";
import { exportAllProjectsToCsv } from "@/lib/projectExport";
import StaleCheckoutBanner from "@/components/projects/StaleCheckoutBanner";
import type { Project, ProjectStatus, ProjectVisibility, Timestamp } from "@/types/schema";

const STATUS_TABS: { value: ProjectStatus | "all"; label: string; color: string }[] = [
  { value: "active",    label: "Active",    color: "emerald" },
  { value: "paused",    label: "Paused",    color: "amber"   },
  { value: "completed", label: "Completed", color: "blue"    },
  { value: "cancelled", label: "Cancelled", color: "red"     },
  { value: "archived",  label: "Archived",  color: "slate"   },
  { value: "all",       label: "All",       color: "slate"   },
];

export default function ProjectsPage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const isAdmin = activeRole === "Admin" || activeRole === "DocCtrl";

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "all">("active");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId || !uid) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await listProjects({
        orgId: activeOrgId,
        status: statusFilter,
        search: search.trim() || undefined,
        // Admins see everything; non-admins see public + their private memberships
        visibleToUserId: isAdmin ? undefined : uid,
      });
      setProjects(rows);
    } catch (e) {
      setError((e as Error).message || "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, uid, statusFilter, search, isAdmin]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Counts per status for the tab badges
  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of projects) counts[p.status] = (counts[p.status] || 0) + 1;
    counts.all = projects.length;
    return counts;
  }, [projects]);

  return (
    <PageShell width="work">
        <StaleCheckoutBanner userId={uid ?? undefined} />
        {/* HEADER */}
        <PageHeaderBar
          icon={Briefcase}
          title="Projects"
          subtitle={<>Every project anyone in the org is working on. Click any to see who&apos;s on it and which files are checked out.</>}
          actions={
            <>
              <Button
                variant="secondary"
                onClick={async () => {
                  if (!activeOrgId) return;
                  try { await exportAllProjectsToCsv(activeOrgId); }
                  catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
                }}
                disabled={!activeOrgId || projects.length === 0}
                title="Download every project + associated documents + active checkouts as a CSV (Excel opens it natively)."
              >
                <Download className="w-4 h-4" /> Export All
              </Button>
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="w-4 h-4" /> New Project
              </Button>
            </>
          }
        />

        {/* STATUS TABS */}
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          {STATUS_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setStatusFilter(t.value)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                statusFilter === t.value
                  ? "bg-slate-900 text-white"
                  : "bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              {t.label}
              {typeof tabCounts[t.value] === "number" && tabCounts[t.value] > 0 && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
                  statusFilter === t.value ? "bg-white/20 text-white" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"
                }`}>{tabCounts[t.value]}</span>
              )}
            </button>
          ))}
        </div>

        {/* SEARCH */}
        <div className="mb-6 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects by name…"
            className="w-full pl-9 pr-3 py-2.5 bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
          />
        </div>

        {/* RESULTS */}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] p-8">
            <Spinner size="sm" /> Loading projects…
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState onCreate={() => setShowCreate(true)} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {projects.map((p) => <ProjectCard key={p.id} project={p} />)}
          </div>
        )}

      {showCreate && activeOrgId && uid && (
        <CreateProjectModal
          isOpen={showCreate}
          onClose={() => setShowCreate(false)}
          orgId={activeOrgId}
          actorUserId={uid}
          actorEmail={userEmail ?? undefined}
          actorRole={activeRole}
          onCreated={() => { setShowCreate(false); void refresh(); }}
        />
      )}
    </PageShell>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const statusColors: Record<ProjectStatus, string> = {
    active:    "bg-emerald-100 text-emerald-700 border-emerald-200",
    paused:    "bg-amber-100 text-amber-700 border-amber-200",
    completed: "bg-blue-100 text-blue-700 border-blue-200",
    cancelled: "bg-red-100 text-red-700 border-red-200",
    archived:  "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
  };

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group block bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-5 shadow-sm hover-lift hover:border-[var(--color-accent-ring)] cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border ${statusColors[project.status]}`}>
              {project.status.toUpperCase()}
            </span>
            {project.visibility === "private" && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
                <Lock className="w-2.5 h-2.5" /> Private
              </span>
            )}
            {project.visibility === "public" && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">
                <Globe className="w-2.5 h-2.5" /> Public
              </span>
            )}
          </div>
          <h3 className="text-base font-black text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">
            {project.name}
          </h3>
          {project.description && (
            <p className="text-xs text-[var(--color-text-muted)] mt-1 line-clamp-2">{project.description}</p>
          )}
        </div>
        <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-[var(--color-accent)] transition-colors shrink-0 mt-1" />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
        {project.ownerUserName && (
          <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3" /> {project.ownerUserName}</span>
        )}
        {project.targetCompletionDate && (
          <span className="inline-flex items-center gap-1">
            <Calendar className="w-3 h-3" /> Due {formatDate(project.targetCompletionDate)}
          </span>
        )}
        {project.mocReference && (
          <span className="inline-flex items-center gap-1 font-mono text-[var(--color-text)]">
            <Layers className="w-3 h-3" /> {project.mocReference}
          </span>
        )}
      </div>

      <div className="mt-2 text-[10px] text-[var(--color-text-faint)]">
        Last activity {formatRelative(project.lastActivityAt)}
      </div>
    </Link>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="bg-[var(--color-surface)] border border-dashed border-[var(--color-border-strong)] rounded-2xl p-12 text-center">
      <Briefcase className="w-10 h-10 mx-auto text-slate-300 mb-3" />
      <h3 className="text-base font-black text-[var(--color-text)] mb-1">No projects to show</h3>
      <p className="text-xs text-[var(--color-text-muted)] mb-4 max-w-md mx-auto">
        Projects collect related document checkouts so teammates can see who&apos;s working on what,
        coordinate, and request markups without stepping on each other.
      </p>
      <button onClick={onCreate} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-sm font-bold">
        <Plus className="w-4 h-4" /> Create your first project
      </button>
    </div>
  );
}

function CreateProjectModal({
  isOpen, onClose, orgId, actorUserId, actorEmail, actorRole, onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [moc, setMoc] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [visibility, setVisibility] = useState<ProjectVisibility>("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const submit = async () => {
    if (!name.trim()) return setError("Project name is required");
    if (!description.trim()) return setError("Description is required — explain what the team will be doing");
    setBusy(true); setError(null);
    try {
      await createProject({
        orgId, name, description, mocReference: moc, visibility,
        targetCompletionDate: targetDate ? new Date(targetDate).toISOString() : undefined,
        actorUserId, actorEmail, actorRole,
      });
      setName(""); setDescription(""); setMoc(""); setTargetDate("");
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 bg-[var(--color-accent-soft)] rounded-lg"><Briefcase className="w-5 h-5 text-[var(--color-accent)]" /></div>
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">New Project</div>
            <div className="text-xs text-[var(--color-text-muted)]">Group your checkouts so the team knows what you&apos;re working on.</div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            ✕
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 Q1 Turnaround" className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
          </div>
          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Description *</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about? What will the team do with the attached documents?" rows={3} className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
          </div>
          <div className="flex items-start gap-2 p-2.5 bg-blue-50 border border-blue-200 rounded-lg text-[11px] text-blue-800">
            <Briefcase className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              <b>After creating</b>, go to a library, select the documents this project needs, and click <b>Checkout to Project</b> on the bulk action bar. Or open a single doc and check it out via the project picker.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">MOC Reference</label>
              <input value={moc} onChange={(e) => setMoc(e.target.value)} placeholder="MOC-2026-0142" className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Target completion</label>
              <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm" />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Visibility</label>
            <div className="mt-1 flex bg-[var(--color-surface-2)] p-1 rounded-lg">
              <button onClick={() => setVisibility("public")} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${visibility === "public" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                Public (everyone in org)
              </button>
              <button onClick={() => setVisibility("private")} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${visibility === "private" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                Private (members only)
              </button>
            </div>
          </div>
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Cancel</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {busy ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDate(ts: Timestamp): string {
  if (!ts) return "";
  try {
    const d = new Date(ts as string);
    return d.toLocaleDateString();
  } catch { return String(ts); }
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
