"use client";

// /projects — org-wide list of every project anyone can see.
//
// Public projects are visible to every user in the org; private projects
// surface only for members + owners. Admin / DocCtrl always see everything.
// Default sort is most-recent-activity. Filters across status / owner / text.
// Grouped by the kind of project (Turnarounds, Capital projects…: Setup ›
// Project type, else read from the name), with a toggle per kind to narrow
// the list to one. Each kind is one ruled table: the project, its status,
// the phase and how far the work is, what's due, the owner, last activity.
// A late project's row carries a red edge.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, Lock, ChevronRight, ChevronDown, Download } from "lucide-react";
import { listedTypeOf, typePlural, typeOrder } from "@/lib/projectType";
import { loadProjectUnits, type UnitChoice } from "@/lib/projectEquipment";
import { useRole } from "@/components/providers/RoleContext";
import { appAlert } from "@/components/providers/DialogProvider";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet, type HeroFact } from "@/components/ui/PageHero";
import { bandInput, bandInputIcon, bandSelect, bandSeg, bandSegItem } from "@/components/admin/band";
import LoadingBlock from "@/components/ui/LoadingBlock";
import MoreMenu from "@/components/ui/MoreMenu";
import { badgeText } from "@/lib/badge";
import { listProjects } from "@/lib/projects";
import { listMilestones } from "@/lib/milestones";
import { computeExecutionReport } from "@/lib/executionReport";
import { projectDue, type ProjectDue } from "@/lib/projectPhases";
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

/** How far a project's work is, read from its schedule (null: no schedule). */
interface WorkProgress { pct: number; done: number; steps: number; overdue: number }

/** Read the schedules of at most this many running projects. */
const PROGRESS_CAP = 30;

export default function ProjectsPage() {
  const { activeOrgId, uid, userEmail, activeRole, hasAnyRole } = useRole();
  const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);

  const [projects, setProjects] = useState<Project[]>([]);
  // Every project of every status: the header's counts and late projects.
  const [allProjects, setAllProjects] = useState<Project[]>([]);
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
  // right no matter which status is picked.
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});
  const hasLoadedOnce = useRef(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId || !uid) return;
    // Only the very first load blanks the list — later refreshes update in
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
      setAllProjects(all);
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

  // How far each running project's work is: its schedule read the way the
  // project's own page reads it (effort-weighted %, steps, overdue steps).
  // A few at a time; each read once.
  const [progress, setProgress] = useState<Map<string, WorkProgress | null>>(new Map());
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!activeOrgId) return;
    const want = allProjects
      .filter((p) => p.id && (p.status === "active" || p.status === "paused") && !asked.current.has(`${activeOrgId}:${p.id}`))
      .slice(0, Math.max(0, PROGRESS_CAP - asked.current.size));
    if (!want.length) return;
    for (const p of want) asked.current.add(`${activeOrgId}:${p.id}`);
    const queue = [...want];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const id = p.id!;
        const tz = p.timezone || "America/Los_Angeles";
        const read = await listMilestones({ orgId: activeOrgId, projectId: id, includeGhost: true })
          .then((ms) => computeExecutionReport(ms.filter((m) => !m.cancelledAt), { tz, now: new Date() }))
          .catch(() => undefined);
        if (read === undefined) continue;
        const v: WorkProgress | null = read.totalLeaves ? { pct: read.pctComplete, done: read.done, steps: read.totalLeaves, overdue: read.overdue } : null;
        setProgress((m) => new Map(m).set(id, v));
      }
    };
    void Promise.all([worker(), worker(), worker()]);
  }, [activeOrgId, allProjects]);

  // Today, read once.
  const [nowMs] = useState(() => Date.now());
  const factsOf = useCallback((p: Project) => rowFacts(p, nowMs, p.id ? progress.get(p.id) : undefined), [nowMs, progress]);

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
  // The kinds of project on screen, each with its projects (most recent
  // activity first, as listed). A kind picked narrows the list to it.
  const groups = useMemo(() => {
    const onUnit = (p: Project) => !unitPick || (units?.byProject.get(p.id ?? "") ?? ["-"]).includes(unitPick);
    const m = new Map<string, { key: string; label: string; order: number; items: Project[] }>();
    for (const p of projects.filter(onUnit)) {
      const t = listedTypeOf(p);
      const key = typePlural(t).toLowerCase();
      const g = m.get(key) ?? { key, label: typePlural(t), order: typeOrder(t), items: [] };
      g.items.push(p);
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
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

  // The answer: how many projects are running, and how many of them are late.
  const nActive = tabCounts.active ?? 0, nPaused = tabCounts.paused ?? 0;
  const nLate = useMemo(() => allProjects.filter((p) => factsOf(p).late).length, [allProjects, factsOf]);
  const answer = loading ? "Projects"
    : (tabCounts.all ?? 0) === 0 ? "No projects yet."
      : nLate > 0 ? (nLate >= nActive ? (nActive === 1 ? "The active project is late." : `All ${nActive} active projects are late.`) : `${nLate} of ${nActive} active projects ${nLate === 1 ? "is" : "are"} late.`)
        : `${nActive} active project${nActive === 1 ? "" : "s"}.`;
  const facts: HeroFact[] | undefined = loading || (tabCounts.all ?? 0) === 0 ? undefined : [
    { label: "Active", value: nActive },
    { label: "Late", value: nLate, tone: nLate > 0 ? "bad" : undefined },
    { label: "Paused", value: nPaused, tone: nPaused > 0 ? "warn" : undefined },
  ];
  const shownCount = shownGroups.reduce((n, g) => n + g.items.length, 0);

  return (
    <PageShell width="work">
      <PageHero
        kicker="Work · Projects"
        title={answer}
        facts={facts}
        tools={activeOrgId && (tabCounts.all ?? 0) > 0 ? (
          <MoreMenu triggerClass={heroQuiet} items={[{ icon: <Download className="w-4 h-4" />, label: "Export all to CSV", onClick: async () => {
            try { await exportAllProjectsToCsv(activeOrgId); }
            catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
          } }]} />
        ) : undefined}
        primary={<button type="button" onClick={() => setShowCreate(true)} className={heroPrimary}><Plus className="w-4 h-4" /> New project</button>}
      >
        {/* What steers the list: status, search, unit and kind. */}
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Status" className={bandSeg}>
              {STATUS_TABS.map((t) => {
                const on = statusFilter === t.value;
                const n = tabCounts[t.value];
                return (
                  <button key={t.value} type="button" onClick={() => setStatusFilter(t.value)} aria-pressed={on} className={bandSegItem(on)}>
                    {t.label}
                    {typeof n === "number" && n > 0 && <span className="text-[12px] font-medium tabular-nums text-[var(--color-text-muted)]">{badgeText(n)}</span>}
                  </button>
                );
              })}
            </div>
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <Search className={bandInputIcon} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search projects by name"
                aria-label="Search projects"
                className={bandInput}
              />
            </div>
            {unitChoices.some((u) => u.code !== "-") && (
              <select value={unitPick} onChange={(e) => setUnitPick(e.target.value)} aria-label="Unit" className={`${bandSelect} max-sm:flex-1`}>
                <option value="">All units</option>
                {unitChoices.map((u) => <option key={u.code} value={u.code}>{u.label} ({u.n})</option>)}
              </select>
            )}
          </div>
          {/* Kinds of project */}
          {groups.length > 1 && (
            <div role="group" aria-label="Kind of project" className={bandSeg}>
              <button type="button" onClick={() => setTypeFilter(null)} aria-pressed={!typeFilter} className={bandSegItem(!typeFilter)}>All kinds</button>
              {groups.map((g) => (
                <button key={g.key} type="button" onClick={() => setTypeFilter(typeFilter === g.key ? null : g.key)} aria-pressed={typeFilter === g.key} className={bandSegItem(typeFilter === g.key)}>
                  {g.label} <span className="text-[12px] font-medium tabular-nums text-[var(--color-text-muted)]">{badgeText(g.items.length)}</span>
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
            <div role="alert" className="text-[15px] text-[var(--color-text)] flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Couldn&apos;t load projects: {error}</span>
              <button type="button" onClick={() => void refresh()} className="text-[var(--color-accent-text)] hover:underline">Try again</button>
            </div>
          </Card>
        ) : projects.length === 0 ? (
          filterActive && (tabCounts.all ?? 0) > 0 ? (
            <Card label="No projects match">
              <p className="text-[15px] text-[var(--color-text-muted)]">
                {searchQ ? <>Nothing named &ldquo;{searchQ}&rdquo;{statusFilter !== "all" ? ` in ${statusFilter}` : ""}.</> : `Nothing in ${statusFilter}.`}
                {" "}
                <button type="button" onClick={() => { setSearch(""); setStatusFilter("all"); }} className="text-[var(--color-accent-text)] hover:underline">
                  Clear filters
                </button>
              </p>
            </Card>
          ) : (
            <EmptyState />
          )
        ) : (
          <>
            {shownGroups.map((g) => {
              const open = !folded.has(g.key) || !!typeFilter;
              return (
                <Card key={g.key} as="section" pad={false} className="overflow-hidden"
                  label={<>{g.label} <span className="text-[var(--color-text-muted)] font-medium tabular-nums">{g.items.length}</span></>}
                  action={
                    <button type="button" onClick={() => toggleFold(g.key)} aria-expanded={open} aria-label={open ? `Fold ${g.label}` : `Show ${g.label}`}
                      className="w-8 h-8 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]">
                      {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                  }>
                  {open ? <ProjectTable projects={g.items} factsOf={factsOf} /> : (
                    <button type="button" onClick={() => toggleFold(g.key)} className="w-full px-4 h-11 text-left text-[14px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
                      {g.items.length} project{g.items.length === 1 ? "" : "s"} folded away. Show them.
                    </button>
                  )}
                </Card>
              );
            })}
            {shownCount === 0 && (
              <Card><p className="text-[15px] text-[var(--color-text-muted)]">No projects on that unit.</p></Card>
            )}
            {groups.some((g) => g.label === "Other projects") && (
              <p className="text-[13px] text-[var(--color-text-muted)]">A project goes under its kind from its name, or from Setup › Project type.</p>
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

// ── One project's row: what it reads from the project and its schedule ──

interface RowFacts {
  due: ProjectDue | null;
  /** What's due, the date ("Nov 15") and in words ("ended 5d ago"). */
  dueDay: string | null;
  dueNote: string | null;
  /** The phase that matters now ("Phase 2", "Phase 2 next"). */
  phaseNote: string | null;
  progress: WorkProgress | null | undefined;
  late: boolean;
}

function rowFacts(p: Project, nowMs: number, progress: WorkProgress | null | undefined): RowFacts {
  const today = dayKey(nowMs, p.timezone || "America/Los_Angeles");
  // In phases: the phase running now and its end, never the typed target.
  const due = p.phases?.length ? projectDue(p.phases, null, today) : projectDue([], dayOf(p.targetCompletionDate), today);
  const n = due ? (due.days === 0 ? "today" : `${due.days}d`) : "";
  const dueNote = !due ? null
    : due.kind === "ends" ? (due.days === 0 ? "ends today" : `ends in ${n}`)
      : due.kind === "starts" ? (due.days === 0 ? "starts today" : `starts in ${n}`)
        : due.kind === "ended" ? (due.days === 0 ? "ended today" : `ended ${n} ago`)
          : due.kind === "target" ? (due.days === 0 ? "due today" : `in ${n}`)
            : `${n} late`;
  const phaseNote = due?.phase ? (due.kind === "starts" ? `${due.phase} next` : due.phase) : null;
  const running = p.status === "active";
  const late = running && (due?.kind === "past target" || (!!progress && progress.pct < 100 && (progress.overdue > 0 || due?.kind === "ended")));
  return { due, dueDay: due ? humanDay(due.day) : null, dueNote, phaseNote, progress, late };
}

const TAG: Record<ProjectStatus, { word: string; dot: string; text: string }> = {
  active:    { word: "Active",    dot: "var(--color-text-faint)", text: "text-[var(--color-text)]" },
  paused:    { word: "Paused",    dot: "var(--state-held)",       text: "text-[var(--state-held)]" },
  completed: { word: "Completed", dot: "var(--state-released)",   text: "text-[var(--color-text)]" },
  cancelled: { word: "Cancelled", dot: "var(--color-border-strong)", text: "text-[var(--color-text-muted)]" },
  archived:  { word: "Archived",  dot: "var(--color-border-strong)", text: "text-[var(--color-text-muted)]" },
};

/** Status, quietly: a dot in the status color and the word. */
function StatusTag({ status, late }: { status: ProjectStatus; late: boolean }) {
  const t = late ? { word: "Late", dot: "var(--state-overdue)", text: "text-[var(--state-overdue)]" } : TAG[status] ?? TAG.active;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] font-semibold whitespace-nowrap ${t.text}`}>
      <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: t.dot }} />
      {t.word}
    </span>
  );
}

/** A thin bar and the %: how far the work is. */
function ProgressBar({ f, className = "" }: { f: RowFacts; className?: string }) {
  const pr = f.progress;
  if (!pr) return null;
  const fill = f.late ? "var(--state-overdue)" : pr.pct >= 100 ? "var(--state-released)" : "var(--color-text)";
  return (
    <span className={`inline-flex items-center gap-2 ${className}`} title={`${pr.done} of ${pr.steps} steps done`}>
      <span className="relative h-1.5 w-24 rounded-full bg-[var(--color-border)] overflow-hidden" role="progressbar" aria-valuenow={pr.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Work done">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, Math.max(0, pr.pct))}%`, background: fill }} />
      </span>
      <span className="font-display text-[15px] font-semibold tabular-nums text-[var(--color-text)]">{pr.pct}%</span>
    </span>
  );
}

function ProjectTable({ projects, factsOf }: { projects: Project[]; factsOf: (p: Project) => RowFacts }) {
  const router = useRouter();
  // The whole row opens the project; the name is the real link.
  const openRow = (e: React.MouseEvent, href: string) => {
    if ((e.target as HTMLElement).closest("a, button, input, select")) return;
    router.push(href);
  };
  const rows = projects.map((p) => ({ p, f: factsOf(p), href: `/projects/${p.id}` }));
  return (
    <>
      {/* Desk: a ruled table. */}
      <table className="max-sm:hidden w-full text-[15px]">
        <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
          <tr className="border-b border-[var(--color-border)]">
            <th scope="col" className="font-semibold px-4 h-10">Project</th>
            <th scope="col" className="font-semibold px-4 w-[120px]">Status</th>
            <th scope="col" className="font-semibold px-4 w-[190px]">Phase / progress</th>
            <th scope="col" className="font-semibold px-4 w-[150px]">Due</th>
            <th scope="col" className="font-semibold px-4 w-[210px] hidden lg:table-cell">Owner</th>
            <th scope="col" className="font-semibold px-4 w-[130px] hidden md:table-cell">Last activity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map(({ p, f, href }) => (
            <tr key={p.id} onClick={(e) => openRow(e, href)} className="hover:bg-[var(--color-surface-2)] cursor-pointer align-top">
              <td className="px-4 py-3 relative">
                {f.late && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
                <div className="flex items-baseline gap-2 min-w-0">
                  <Link href={href} className="min-w-0 font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{p.name}</Link>
                  {p.visibility === "private" && <span className="shrink-0 inline-flex items-center gap-1 text-[13px] text-[var(--color-text-muted)]"><Lock className="w-3 h-3" /> Private</span>}
                  {p.mocReference && <span className="shrink-0 font-display tabular-nums text-[14px] text-[var(--color-text-muted)]">{p.mocReference}</span>}
                </div>
                {p.description && <p className="mt-0.5 text-[13px] text-[var(--color-text-muted)] line-clamp-1">{p.description}</p>}
              </td>
              <td className="px-4 py-3"><StatusTag status={p.status} late={f.late} /></td>
              <td className="px-4 py-3">
                {f.progress ? <ProgressBar f={f} /> : f.progress === null ? <span className="text-[14px] text-[var(--color-text-muted)]">No schedule yet</span> : !f.phaseNote ? <span className="text-[var(--color-text-faint)]">-</span> : null}
                {f.phaseNote && <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">{f.phaseNote}</div>}
              </td>
              <td className="px-4 py-3">
                {f.dueDay ? (
                  <>
                    <div className="font-display font-semibold tabular-nums text-[var(--color-text)]">{f.dueDay}</div>
                    {f.dueNote && <div className={`text-[13px] ${f.late && (f.due?.kind === "past target" || f.due?.kind === "ended") ? "text-[var(--state-overdue)] font-semibold" : "text-[var(--color-text-muted)]"}`}>{f.dueNote}</div>}
                  </>
                ) : <span className="text-[var(--color-text-faint)]">-</span>}
              </td>
              <td className="px-4 py-3 hidden lg:table-cell">
                <span className="block max-w-[200px] truncate text-[14px] text-[var(--color-text)]" title={p.ownerUserName}>{p.ownerUserName || "-"}</span>
              </td>
              <td className="px-4 py-3 hidden md:table-cell text-[14px] text-[var(--color-text-muted)] whitespace-nowrap">{formatRelative(p.lastActivityAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Phone: one stacked row a project. */}
      <ul className="sm:hidden divide-y divide-[var(--color-border)]">
        {rows.map(({ p, f, href }) => (
          <li key={p.id} className="relative">
            {f.late && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
            <Link href={href} className="block px-4 py-3 active:bg-[var(--color-surface-2)]">
              <div className="flex items-start gap-3">
                <span className="min-w-0 flex-1 font-semibold text-[15px] leading-snug text-[var(--color-text)]">
                  {p.name}
                  {p.visibility === "private" && <Lock className="inline w-3 h-3 ml-1.5 -mt-0.5 text-[var(--color-text-muted)]" aria-label="Private" />}
                </span>
                <StatusTag status={p.status} late={f.late} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[var(--color-text-muted)]">
                {f.progress && <ProgressBar f={f} />}
                {f.progress === null && <span>No schedule yet</span>}
                {f.phaseNote && <span>{f.phaseNote}</span>}
                {f.dueDay && <span className={f.late && (f.due?.kind === "past target" || f.due?.kind === "ended") ? "text-[var(--state-overdue)] font-semibold" : ""}>{f.due?.kind === "starts" ? "Starts" : f.due?.kind === "ended" ? "Ended" : "Due"} {f.dueDay}</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

// The one way in is New project, up top.
function EmptyState() {
  return (
    <Card label="Projects">
      <p className="text-[15px] text-[var(--color-text)]">Start one with New project.</p>
      <p className="text-[13px] text-[var(--color-text-muted)] mt-1">Its schedule, reports, costs and checkouts live there.</p>
    </Card>
  );
}

/** "2026-11-15" from a stored date or timestamp. */
function dayOf(ts: Timestamp | undefined): string | null {
  if (ts == null || ts === "") return null;
  if (typeof ts === "string" && /^\d{4}-\d{2}-\d{2}/.test(ts)) return ts.slice(0, 10);
  const d = new Date(ts as string | number | Date);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

/** "Nov 15" (with the year when it isn't this year). */
function humanDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const thisYear = new Date().getFullYear() === y;
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(thisYear ? {} : { year: "numeric" }), timeZone: "UTC" });
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
