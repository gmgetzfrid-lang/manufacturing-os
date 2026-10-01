"use client";

// /projects — org-wide list of every project anyone can see.
//
// Public projects are visible to every user in the org; private projects
// surface only for members + owners. Admin / DocCtrl always see everything.
// Default sort is most-recent-activity. Filters across status / owner / text.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { userFacingCaughtError } from "@/lib/userFacingError";
import Link from "next/link";
import {
  Briefcase, Plus, Search, Lock, Globe, AlertTriangle,
  Calendar, User as UserIcon, Layers, ChevronRight, Download,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { appAlert } from "@/components/providers/DialogProvider";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { listProjects } from "@/lib/projects";
import ProjectWizard from "@/components/projects/ProjectWizard";
import { exportAllProjectsToCsv, ExportCancelledError, type ExportProgress } from "@/lib/projectExport";
import StaleCheckoutBanner from "@/components/projects/StaleCheckoutBanner";
import type { Project, ProjectStatus, Timestamp } from "@/types/schema";

const STATUS_TABS: { value: ProjectStatus | "all"; label: string; color: string }[] = [
  { value: "active",    label: "Active",    color: "emerald" },
  { value: "paused",    label: "Paused",    color: "amber"   },
  { value: "completed", label: "Completed", color: "blue"    },
  { value: "cancelled", label: "Cancelled", color: "red"     },
  { value: "archived",  label: "Archived",  color: "slate"   },
  { value: "all",       label: "All",       color: "slate"   },
];

export default function ProjectsPage() {
  const { activeOrgId, uid, userEmail, activeRole, hasAnyRole } = useRole();
  const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);

  const [projects, setProjects] = useState<Project[]>([]);
  // `loading` starts true so the pre-org-resolve frame shows a spinner
  // instead of flashing the "create your first project" empty state.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "all">("active");
  const [search, setSearch] = useState("");
  // Debounced copy that actually drives the fetch — one query per pause,
  // not one per keystroke.
  const [searchQ, setSearchQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearchQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const [showCreate, setShowCreate] = useState(false);
  // PERF-2: one export at a time, with progress and a way out. The button
  // is disabled while a run is in flight, so an impatient second click
  // cannot start a second sweep on top of the first.
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const exportAbort = useRef<AbortController | null>(null);
  const runExportAll = async () => {
    if (!activeOrgId || exportAbort.current) return;
    const ctrl = new AbortController();
    exportAbort.current = ctrl;
    setExportProgress({ done: 0, total: 0 });
    try {
      await exportAllProjectsToCsv(activeOrgId, { signal: ctrl.signal, onProgress: (p) => setExportProgress(p) });
    } catch (e) {
      if (!(e instanceof ExportCancelledError)) await appAlert({ message: userFacingCaughtError(e, { context: "projects list" }), tone: "danger" });
    } finally {
      exportAbort.current = null;
      setExportProgress(null);
    }
  };
  // Status counts come from a separate all-statuses query so the badges are
  // right no matter which tab is selected (they used to be derived from the
  // already-filtered list, i.e. wrong on every tab but "All").
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});
  const hasLoadedOnce = useRef(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId || !uid) return;
    // Only the very first load blanks the grid — later refreshes update in
    // place so typing a search doesn't strobe a spinner.
    if (!hasLoadedOnce.current) setLoading(true);
    setError(null);
    try {
      const [rows, all] = await Promise.all([
        listProjects({
          orgId: activeOrgId,
          status: statusFilter,
          search: searchQ || undefined,
          visibleToUserId: isAdmin ? undefined : uid,
        }),
        listProjects({ orgId: activeOrgId, status: "all", visibleToUserId: isAdmin ? undefined : uid }),
      ]);
      setProjects(rows);
      const counts: Record<string, number> = {};
      for (const p of all) counts[p.status] = (counts[p.status] || 0) + 1;
      counts.all = all.length;
      setTabCounts(counts);
      hasLoadedOnce.current = true;
    } catch (e) {
      setError((e as Error)?.message ? userFacingCaughtError(e, { action: "read", context: "projects list" }) : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, uid, statusFilter, searchQ, isAdmin]);

  useEffect(() => { void refresh(); }, [refresh]);
  const filterActive = statusFilter !== "active" || searchQ.length > 0;

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
                onClick={() => void runExportAll()}
                disabled={!activeOrgId || projects.length === 0 || exportProgress !== null}
                loading={exportProgress !== null}
                title="Download every project + associated documents + active checkouts as a CSV (Excel opens it natively)."
              >
                <Download className="w-4 h-4" />
                {exportProgress
                  ? (exportProgress.total > 0 ? `Exporting ${exportProgress.done}/${exportProgress.total}…` : "Exporting…")
                  : "Export All"}
              </Button>
              {exportProgress && (
                <Button variant="secondary" onClick={() => exportAbort.current?.abort()} title="Stop the export — nothing is downloaded.">
                  Cancel export
                </Button>
              )}
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="w-4 h-4" /> New Project
              </Button>
            </>
          }
        />

        {/* STATUS TABS — A11Y-7: the selected pill wears the accent ring on
            the accent tint (a slate the dark bridge collapses to the canvas
            was invisible in dark mode) with text-token text that clears
            4.5:1 in both themes, and says it is pressed. */}
        <div role="group" aria-label="Filter projects by status" className="flex flex-wrap items-center gap-1.5 mb-4">
          {STATUS_TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-pressed={statusFilter === t.value}
              onClick={() => setStatusFilter(t.value)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors border ${
                statusFilter === t.value
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-text)] border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]"
                  : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              {t.label}
              {typeof tabCounts[t.value] === "number" && tabCounts[t.value] > 0 && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
                  statusFilter === t.value ? "bg-[var(--color-surface)] text-[var(--color-text)]" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"
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
          <div role="alert" className="bg-rose-500/[0.08] border border-rose-500/40 rounded-xl p-4 text-sm text-rose-700 dark:text-rose-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        ) : projects.length === 0 ? (
          filterActive && (tabCounts.all ?? 0) > 0 ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center animate-in fade-in">
              <Search className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
              <div className="text-sm font-bold text-[var(--color-text)]">No projects match</div>
              <div className="text-xs text-[var(--color-text-muted)] mt-1">
                {searchQ ? <>Nothing named &ldquo;{searchQ}&rdquo; {statusFilter !== "all" ? `in ${statusFilter}` : ""}.</> : `Nothing in ${statusFilter}.`}
              </div>
              <button onClick={() => { setSearch(""); setStatusFilter("all"); }} className="mt-3 text-xs font-bold text-[var(--color-accent)] hover:underline">
                Clear filters
              </button>
            </div>
          ) : (
            <EmptyState onCreate={() => setShowCreate(true)} />
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {projects.map((p) => <ProjectCard key={p.id} project={p} />)}
          </div>
        )}

      {showCreate && activeOrgId && uid && (
        <ProjectWizard
          orgId={activeOrgId}
          actorUserId={uid}
          actorEmail={userEmail ?? undefined}
          actorRole={activeRole}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); void refresh(); }}
        />
      )}
    </PageShell>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const statusColors: Record<ProjectStatus, string> = {
    active:    "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border-emerald-500/40",
    paused:    "bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/40",
    completed: "bg-blue-500/10 text-blue-800 dark:text-blue-300 border-blue-500/40",
    cancelled: "bg-rose-500/10 text-rose-800 dark:text-rose-300 border-rose-500/40",
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
        <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] group-hover:text-[var(--color-accent)] transition-colors shrink-0 mt-1" />
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
      <Briefcase className="w-10 h-10 mx-auto text-[var(--color-text-faint)] mb-3" />
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
