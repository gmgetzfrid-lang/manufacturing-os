"use client";

// /projects — org-wide list of every project anyone can see.
//
// Public projects are visible to every user in the org; private projects
// surface only for members + owners. Admin / DocCtrl always see everything.
// Default sort is most-recent-activity. Filters across status / owner / text.
// Grouped by the kind of project (Turnarounds, Capital projects…: Setup ›
// Project type, else read from the name), with a chip per kind to narrow
// the list to one.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Plus, Search, Lock,
  User as UserIcon, Layers, ChevronRight, ChevronDown, Download,
} from "lucide-react";
import { listedTypeOf, typePlural, typeOrder } from "@/lib/projectType";
import { loadProjectUnits, type UnitChoice } from "@/lib/projectEquipment";
import { useRole } from "@/components/providers/RoleContext";
import { appAlert } from "@/components/providers/DialogProvider";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import LoadingBlock from "@/components/ui/LoadingBlock";
import MoreMenu from "@/components/ui/MoreMenu";
import { badgeText } from "@/lib/badge";
import { listProjects } from "@/lib/projects";
import { projectDue, projectDueWords } from "@/lib/projectPhases";
import { dayKey } from "@/lib/scheduleTz";
import ProjectWizard from "@/components/projects/ProjectWizard";
import { exportAllProjectsToCsv } from "@/lib/projectExport";
import StaleCheckoutBanner from "@/components/projects/StaleCheckoutBanner";
import type { Project, ProjectStatus, Timestamp } from "@/types/schema";

const STATUS_TABS: { value: ProjectStatus | "all"; label: string }[] = [
  { value: "active",    label: "Active" },
  { value: "paused",    label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "archived",  label: "Archived" },
  { value: "all",       label: "All" },
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
      setError((e as Error).message || "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, uid, statusFilter, searchQ, isAdmin]);

  useEffect(() => { void refresh(); }, [refresh]);
  const filterActive = statusFilter !== "active" || searchQ.length > 0;

  // The kinds of project on screen, each with its projects (most recent
  // activity first, as listed). A kind picked narrows the list to it.
  // The units each project is on (Setup › Units & equipment): one picked
  // narrows the list to the projects on it.
  const [units, setUnits] = useState<{ byProject: Map<string, string[]>; units: UnitChoice[] } | null>(null);
  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    loadProjectUnits(activeOrgId).then((u) => { if (alive) setUnits(u); }).catch(() => undefined);
    return () => { alive = false; };
  }, [activeOrgId]);
  const [unitPick, setUnitPick] = useState<string>("");
  const unitChoices = useMemo(() => {
    if (!units) return [];
    const n = new Map<string, number>();
    for (const p of projects) for (const c of units.byProject.get(p.id ?? "") ?? ["-"]) n.set(c, (n.get(c) ?? 0) + 1);
    return [...n.entries()].map(([code, k]) => ({ code, n: k, label: code === "-" ? "No unit set" : `${units.units.find((u) => u.code === code)?.label ?? `Unit ${code}`} (${code})` }))
      .sort((a, b) => (a.code === "-" ? 1 : b.code === "-" ? -1 : a.label.localeCompare(b.label)));
  }, [units, projects]);
  const onUnit = (p: Project) => !unitPick || (units?.byProject.get(p.id ?? "") ?? ["-"]).includes(unitPick);
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string; order: number; items: Project[] }>();
    for (const p of projects.filter(onUnit)) {
      const t = listedTypeOf(p);
      const key = typePlural(t).toLowerCase();
      const g = m.get(key) ?? { key, label: typePlural(t), order: typeOrder(t), items: [] };
      g.items.push(p);
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onUnit reads unitPick and units
  }, [projects, unitPick, units]);
  const [typePick, setTypeFilter] = useState<string | null>(null);
  // A kind with nothing left on screen (another status, a search) lets go.
  const typeFilter = typePick && groups.some((g) => g.key === typePick) ? typePick : null;
  const shownGroups = typeFilter ? groups.filter((g) => g.key === typeFilter) : groups;
  // Groups folded away on this device.
  const foldKey = `projects.folded:${activeOrgId ?? ""}`;
  const [folded, setFolded] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { setFolded(new Set(JSON.parse(localStorage.getItem(foldKey) ?? "[]") as string[])); } catch { /* private mode */ }
  }, [foldKey]);
  const toggleFold = (key: string) => setFolded((f) => {
    const n = new Set(f);
    if (n.has(key)) n.delete(key); else n.add(key);
    try { localStorage.setItem(foldKey, JSON.stringify([...n])); } catch { /* private mode */ }
    return n;
  });

  // The answer: how many projects are running, in plain words.
  const nActive = tabCounts.active ?? 0, nPaused = tabCounts.paused ?? 0;
  const answer = loading ? "Projects"
    : (tabCounts.all ?? 0) === 0 ? "No projects yet."
      : <>{nActive} active project{nActive === 1 ? "" : "s"}.{nPaused > 0 && <span className="text-[var(--color-ink-muted)]"> {nPaused} paused.</span>}</>;
  const shownCount = shownGroups.reduce((n, g) => n + g.items.length, 0);
  const chip = (on: boolean) => `shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-semibold transition-colors ${on ? "bg-[var(--color-ink-fg)] text-[var(--color-ink)]" : "text-[var(--color-ink-muted)] hover:text-white"}`;
  const count = (on: boolean) => `text-[11px] tabular-nums ${on ? "text-[var(--color-ink)]/60" : "text-[var(--color-ink-muted)]"}`;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Work · Projects"
        title={answer}
        tools={activeOrgId && (tabCounts.all ?? 0) > 0 ? (
          <MoreMenu triggerClass={heroQuiet} items={[{ icon: <Download className="w-4 h-4" />, label: "Export all to CSV", onClick: async () => {
            try { await exportAllProjectsToCsv(activeOrgId); }
            catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
          } }]} />
        ) : undefined}
        primary={<button type="button" onClick={() => setShowCreate(true)} className={heroPrimary}><Plus className="w-4 h-4" /> New project</button>}
      >
        {/* What steers the list: status, search, unit and kind. */}
        <div className="space-y-3">
          <div role="group" aria-label="Status" className="inline-flex max-w-full items-center gap-1 p-1 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {STATUS_TABS.map((t) => (
              <button key={t.value} type="button" onClick={() => setStatusFilter(t.value)} aria-pressed={statusFilter === t.value} className={chip(statusFilter === t.value)}>
                {t.label}
                {typeof tabCounts[t.value] === "number" && tabCounts[t.value] > 0 && <span className={count(statusFilter === t.value)}>{badgeText(tabCounts[t.value])}</span>}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px] max-w-xl">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-ink-muted)] pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search projects by name…"
                aria-label="Search projects"
                className="w-full h-11 pl-10 pr-3 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-white text-[15px] placeholder:text-[var(--color-ink-muted)] outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]"
              />
            </div>
            {unitChoices.some((u) => u.code !== "-") && (
              <select value={unitPick} onChange={(e) => setUnitPick(e.target.value)} aria-label="Unit"
                className="h-11 px-3 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-[var(--color-ink-fg)] text-[13px] font-semibold outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)] [&_option]:bg-[var(--color-surface)] [&_option]:text-[var(--color-text)]">
                <option value="">All units</option>
                {unitChoices.map((u) => <option key={u.code} value={u.code}>{u.label} · {u.n}</option>)}
              </select>
            )}
          </div>
          {/* Kinds of project */}
          {groups.length > 1 && (
            <div role="group" aria-label="Kind of project" className="flex flex-wrap items-center gap-1">
              <button type="button" onClick={() => setTypeFilter(null)} aria-pressed={!typeFilter} className={chip(!typeFilter)}>All kinds</button>
              {groups.map((g) => (
                <button key={g.key} type="button" onClick={() => setTypeFilter(typeFilter === g.key ? null : g.key)} aria-pressed={typeFilter === g.key} className={chip(typeFilter === g.key)}>
                  {g.label} <span className={count(typeFilter === g.key)}>{badgeText(g.items.length)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </PageHero>

      <PageBody>
        {/* RESULTS */}
        {loading ? (
          <Card><LoadingBlock what="projects" rows={6} className="border-0 p-0" /></Card>
        ) : error ? (
          <Card>
            <div role="alert" className="text-[14px] text-rose-700 dark:text-rose-300 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Couldn&apos;t load projects: {error}</span>
              <button onClick={() => void refresh()} className="text-[13px] font-bold text-[var(--color-accent-text)] hover:underline">Try again</button>
            </div>
          </Card>
        ) : projects.length === 0 ? (
          filterActive && (tabCounts.all ?? 0) > 0 ? (
            <Card label="No projects match">
              <p className="text-[14px] text-[var(--color-text-muted)]">
                {searchQ ? <>Nothing named &ldquo;{searchQ}&rdquo; {statusFilter !== "all" ? `in ${statusFilter}` : ""}.</> : `Nothing in ${statusFilter}.`}
              </p>
              <button onClick={() => { setSearch(""); setStatusFilter("all"); }} className="mt-2 text-[13px] font-bold text-[var(--color-accent-text)] hover:underline">
                Clear filters
              </button>
            </Card>
          ) : (
            <EmptyState />
          )
        ) : (
          <>
            {shownGroups.map((g) => {
              const open = !folded.has(g.key) || !!typeFilter;
              return (
                <Card key={g.key} as="section" pad={false} className="overflow-hidden" label={`${g.label} · ${g.items.length}`}
                  action={
                    <button type="button" onClick={() => toggleFold(g.key)} aria-expanded={open} aria-label={open ? `Fold ${g.label}` : `Show ${g.label}`}
                      className="w-8 h-8 -my-1 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                      {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                  }>
                  {open && (
                    <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
                      {g.items.map((p) => <ProjectCard key={p.id} project={p} />)}
                    </ul>
                  )}
                </Card>
              );
            })}
            {shownCount === 0 && (
              <Card><p className="text-[14px] text-[var(--color-text-muted)]">No projects on that unit.</p></Card>
            )}
            {groups.some((g) => g.label === "Other projects") && (
              <p className="px-1 text-[12px] text-[var(--color-text-muted)]">A project goes under its kind from its name, or from Setup › Project type on the project.</p>
            )}
          </>
        )}
        <StaleCheckoutBanner userId={uid ?? undefined} />
      </PageBody>

      {showCreate && activeOrgId && uid && (
        <ProjectWizard
          orgId={activeOrgId}
          actorUserId={uid}
          actorEmail={userEmail ?? undefined}
          actorRole={activeRole}
          onClose={() => setShowCreate(false)}
          // The wizard opens the new project itself.
          onCreated={() => { setShowCreate(false); }}
        />
      )}
    </PageShell>
  );
}

function ProjectCard({ project }: { project: Project }) {
  // Today, read once when the row is first drawn.
  const [nowMs] = useState(() => Date.now());
  // In phases: the phase running now and its end, never the typed target.
  const due = project.phases?.length ? projectDue(project.phases, null, dayKey(nowMs, project.timezone || "America/Los_Angeles")) : null;
  const dueWords = project.phases?.length ? (due ? projectDueWords(due) : null) : project.targetCompletionDate ? `due ${formatDate(project.targetCompletionDate)}` : null;
  const statusWord = project.status[0].toUpperCase() + project.status.slice(1);
  // Where it stands, in one line: its status, then what's due.
  const state = [statusWord, dueWords ? dueWords[0].toUpperCase() + dueWords.slice(1) : null, project.phases?.length ? `${project.phases.length} phases` : null].filter(Boolean).join(" · ");
  const late = due?.kind === "past target";

  return (
    <li>
      <Link
        href={`/projects/${project.id}`}
        className="group flex items-start gap-3 px-4 sm:px-5 py-3.5 hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 min-w-0">
            <h3 className="min-w-0 truncate text-[15px] font-bold text-[var(--color-text)]">{project.name}</h3>
            {project.visibility === "private" && (
              <span className="shrink-0 inline-flex items-center gap-1 text-[12px] text-[var(--color-text-muted)]"><Lock className="w-3 h-3" /> Private</span>
            )}
          </div>
          <div className={`mt-0.5 text-[13px] font-semibold ${late ? "text-rose-700 dark:text-rose-400" : project.status === "paused" ? "text-amber-800 dark:text-amber-300" : "text-[var(--color-text)]"}`}>{state}</div>
          {project.description && (
            <p className="text-[13px] text-[var(--color-text-muted)] mt-0.5 line-clamp-1">{project.description}</p>
          )}
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[var(--color-text-muted)]">
            {project.ownerUserName && (
              <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3" /> {project.ownerUserName}</span>
            )}
            {project.mocReference && (
              <span className="inline-flex items-center gap-1 font-mono text-[var(--color-text)]">
                <Layers className="w-3 h-3" /> {project.mocReference}
              </span>
            )}
            <span>Last activity {formatRelative(project.lastActivityAt)}</span>
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] group-hover:text-[var(--color-text-muted)] transition-colors shrink-0 mt-1" />
      </Link>
    </li>
  );
}

// The one way in is New project, up top.
function EmptyState() {
  return (
    <Card label="Projects">
      <p className="text-[14px] text-[var(--color-text)]">Start one with New project.</p>
      <p className="text-[13px] text-[var(--color-text-muted)] mt-1">Its schedule, reports, costs and checkouts live there.</p>
    </Card>
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
