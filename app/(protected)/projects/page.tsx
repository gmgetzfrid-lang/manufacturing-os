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
  Calendar, User as UserIcon, Layers, Filter, ChevronRight, Download,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { listProjects, createProject } from "@/lib/projects";
import { exportAllProjectsToCsv } from "@/lib/projectExport";
import StaleCheckoutBanner from "@/components/projects/StaleCheckoutBanner";
import type { Project, ProjectStatus, ProjectVisibility } from "@/types/schema";

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
    <div className="min-h-screen bg-slate-50 p-8 pb-20">
      <div className="max-w-7xl mx-auto">
        <StaleCheckoutBanner userId={uid ?? undefined} />
        {/* HEADER */}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
              <Briefcase className="w-7 h-7 text-indigo-600" />
              Projects
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              Every project anyone in the org is working on. Click any to see who&apos;s on it and which files are checked out.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                if (!activeOrgId) return;
                try { await exportAllProjectsToCsv(activeOrgId); }
                catch (e) { alert((e as Error).message); }
              }}
              disabled={!activeOrgId || projects.length === 0}
              title="Download every project + associated documents + active checkouts as a CSV (Excel opens it natively)."
              className="inline-flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white hover:bg-slate-50 text-slate-700 text-sm font-bold border border-slate-200 disabled:opacity-40"
            >
              <Download className="w-4 h-4" /> Export All
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold shadow-lg shadow-indigo-900/20"
            >
              <Plus className="w-4 h-4" /> New Project
            </button>
          </div>
        </div>

        {/* STATUS TABS */}
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          {STATUS_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setStatusFilter(t.value)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                statusFilter === t.value
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-700 border border-slate-200 hover:bg-slate-100"
              }`}
            >
              {t.label}
              {typeof tabCounts[t.value] === "number" && tabCounts[t.value] > 0 && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
                  statusFilter === t.value ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600"
                }`}>{tabCounts[t.value]}</span>
              )}
            </button>
          ))}
        </div>

        {/* SEARCH */}
        <div className="mb-6 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects by name…"
            className="w-full pl-9 pr-3 py-2.5 bg-white rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
          />
        </div>

        {/* RESULTS */}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500 p-8">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading projects…
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
      </div>

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
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const statusColors: Record<ProjectStatus, string> = {
    active:    "bg-emerald-100 text-emerald-700 border-emerald-200",
    paused:    "bg-amber-100 text-amber-700 border-amber-200",
    completed: "bg-blue-100 text-blue-700 border-blue-200",
    cancelled: "bg-red-100 text-red-700 border-red-200",
    archived:  "bg-slate-100 text-slate-700 border-slate-200",
  };

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group block bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md hover:border-indigo-300 transition-all cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border ${statusColors[project.status]}`}>
              {project.status.toUpperCase()}
            </span>
            {project.visibility === "private" && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                <Lock className="w-2.5 h-2.5" /> Private
              </span>
            )}
            {project.visibility === "public" && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded">
                <Globe className="w-2.5 h-2.5" /> Public
              </span>
            )}
          </div>
          <h3 className="text-base font-black text-slate-900 truncate group-hover:text-indigo-600 transition-colors">
            {project.name}
          </h3>
          {project.description && (
            <p className="text-xs text-slate-600 mt-1 line-clamp-2">{project.description}</p>
          )}
        </div>
        <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-indigo-500 transition-colors shrink-0 mt-1" />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {project.ownerUserName && (
          <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3" /> {project.ownerUserName}</span>
        )}
        {project.targetCompletionDate && (
          <span className="inline-flex items-center gap-1">
            <Calendar className="w-3 h-3" /> Due {formatDate(project.targetCompletionDate)}
          </span>
        )}
        {project.mocReference && (
          <span className="inline-flex items-center gap-1 font-mono text-slate-700">
            <Layers className="w-3 h-3" /> {project.mocReference}
          </span>
        )}
      </div>

      <div className="mt-2 text-[10px] text-slate-400">
        Last activity {formatRelative(project.lastActivityAt)}
      </div>
    </Link>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-12 text-center">
      <Briefcase className="w-10 h-10 mx-auto text-slate-300 mb-3" />
      <h3 className="text-base font-black text-slate-800 mb-1">No projects to show</h3>
      <p className="text-xs text-slate-500 mb-4 max-w-md mx-auto">
        Projects collect related document checkouts so teammates can see who&apos;s working on what,
        coordinate, and request markups without stepping on each other.
      </p>
      <button onClick={onCreate} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold">
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
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className="p-2 bg-indigo-100 rounded-lg"><Briefcase className="w-5 h-5 text-indigo-700" /></div>
          <div className="flex-1">
            <div className="text-sm font-black text-slate-900">New Project</div>
            <div className="text-xs text-slate-500">Group your checkouts so the team knows what you&apos;re working on.</div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-900">
            ✕
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 Q1 Turnaround" className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Description *</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about? What will the team do with the attached documents?" rows={3} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-y focus:ring-2 focus:ring-indigo-500 outline-none" />
          </div>
          <div className="flex items-start gap-2 p-2.5 bg-blue-50 border border-blue-200 rounded-lg text-[11px] text-blue-800">
            <Briefcase className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              <b>After creating</b>, go to a library, select the documents this project needs, and click <b>Checkout to Project</b> on the bulk action bar. Or open a single doc and check it out via the project picker.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">MOC Reference</label>
              <input value={moc} onChange={(e) => setMoc(e.target.value)} placeholder="MOC-2026-0142" className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Target completion</label>
              <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Visibility</label>
            <div className="mt-1 flex bg-slate-100 p-1 rounded-lg">
              <button onClick={() => setVisibility("public")} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${visibility === "public" ? "bg-white shadow text-slate-900" : "text-slate-500"}`}>
                Public (everyone in org)
              </button>
              <button onClick={() => setVisibility("private")} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${visibility === "private" ? "bg-white shadow text-slate-900" : "text-slate-500"}`}>
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

        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {busy ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDate(ts: any): string {
  if (!ts) return "";
  try {
    const d = new Date(ts as string);
    return d.toLocaleDateString();
  } catch { return String(ts); }
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
