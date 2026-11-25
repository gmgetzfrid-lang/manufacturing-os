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
import { Plus, Search, Lock, ChevronDown, Download } from "lucide-react";
import { listedTypeOf, typePlural, typeOrder } from "@/lib/projectType";
import { loadProjectUnits, type UnitChoice } from "@/lib/projectEquipment";
import { useRole } from "@/components/providers/RoleContext";
import { appAlert } from "@/components/providers/DialogProvider";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet, type HeroFact } from "@/components/ui/PageHero";
import { bandInput, bandInputIcon, bandSelect } from "@/components/admin/band";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { CopyId } from "@/components/ui/CopyId";
import { SubTabs } from "@/components/projects/SubTabs";
import MoreMenu from "@/components/ui/MoreMenu";
import { badgeText } from "@/lib/badge";
import { listProjects, myProjectIds } from "@/lib/projects";
import { listMilestones } from "@/lib/milestones";
import { computeExecutionReport } from "@/lib/executionReport";
import { projectDue, type ProjectDue } from "@/lib/projectPhases";
import { dayKey } from "@/lib/scheduleTz";
import NewTurnaround from "@/components/projects/setup/NewTurnaround";
import { exportAllProjectsToCsv } from "@/lib/projectExport";
import StaleCheckoutBanner from "@/components/projects/StaleCheckoutBanner";
import type { Project, ProjectStatus, Timestamp } from "@/types/schema";
import { sayError } from "@/components/projects/sayError";
import PersonName from "@/components/ui/PersonName";

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
  const hasLoadedOnce = useRef(false);
  // The projects you own or are a member of: the page shows these unless
  // you switch to All projects (remembered on this device).
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [scope, setScopeState] = useState<"mine" | "all">("mine");
  useEffect(() => {
    try { if (localStorage.getItem("projects:scope") === "all") setScopeState("all"); } catch { /* private mode */ }
  }, []);
  const setScope = (v: "mine" | "all") => {
    setScopeState(v);
    try { localStorage.setItem("projects:scope", v); } catch { /* private mode */ }
  };

  const refresh = useCallback(async () => {
    if (!activeOrgId || !uid) return;
    // Only the very first load blanks the list — later refreshes update in
    // place so typing a search doesn't strobe a spinner.
    if (!hasLoadedOnce.current) setLoading(true);
    setError(null);
    try {
      const [rows, all, my] = await Promise.all([
        listProjects({
          orgId: activeOrgId,
          status: statusFilter,
          search: searchQ || undefined,
          visibleToUserId: isAdmin ? undefined : uid,
        }),
        listProjects({ orgId: activeOrgId, status: "all", visibleToUserId: isAdmin ? undefined : uid }),
        myProjectIds(activeOrgId, uid),
      ]);
      setProjects(rows);
      setAllProjects(all);
      setMine(my);
      hasLoadedOnce.current = true;
    } catch (e) {
      setError(sayError(e, "Failed to load projects"));
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, uid, statusFilter, searchQ, isAdmin]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Everything below follows the scope: yours, or every project you can see.
  const inScope = useCallback((p: Project) => scope === "all" || (!!p.id && mine.has(p.id)), [scope, mine]);
  const scopedProjects = useMemo(() => projects.filter(inScope), [projects, inScope]);
  const scopedAll = useMemo(() => allProjects.filter(inScope), [allProjects, inScope]);
  // Status counts from the all-statuses list, so the badges are right no
  // matter which status is picked.
  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of scopedAll) counts[p.status] = (counts[p.status] || 0) + 1;
    counts.all = scopedAll.length;
    return counts;
  }, [scopedAll]);
  const filterActive = statusFilter !== "active" || searchQ.length > 0;

  // How far each running project's work is: its schedule read the way the
  // project's own page reads it (effort-weighted %, steps, overdue steps).
  // A few at a time; each read once.
  const [progress, setProgress] = useState<Map<string, WorkProgress | null>>(new Map());
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!activeOrgId) return;
    const want = scopedAll
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
  }, [activeOrgId, scopedAll]);

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
    for (const p of scopedProjects) for (const c of units.byProject.get(p.id ?? "") ?? ["-"]) n.set(c, (n.get(c) ?? 0) + 1);
    return [...n.entries()].map(([code, k]) => ({ code, n: k, label: code === "-" ? "No unit set" : `${units.units.find((u) => u.code === code)?.label ?? `Unit ${code}`} (${code})` }))
      .sort((a, b) => (a.code === "-" ? 1 : b.code === "-" ? -1 : a.label.localeCompare(b.label)));
  }, [units, scopedProjects]);
  // The kinds of project on screen, each with its projects (most recent
  // activity first, as listed). A kind picked narrows the list to it.
  const groups = useMemo(() => {
    const onUnit = (p: Project) => !unitPick || (units?.byProject.get(p.id ?? "") ?? ["-"]).includes(unitPick);
    const m = new Map<string, { key: string; label: string; order: number; items: Project[] }>();
    for (const p of scopedProjects.filter(onUnit)) {
      const t = listedTypeOf(p);
      const key = typePlural(t).toLowerCase();
      const g = m.get(key) ?? { key, label: typePlural(t), order: typeOrder(t), items: [] };
      g.items.push(p);
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }, [scopedProjects, unitPick, units]);
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
  const nLate = useMemo(() => scopedAll.filter((p) => factsOf(p).late).length, [scopedAll, factsOf]);
  const yours = scope === "mine";
  // You on no active project: say so, and point at All projects.
  const noneOfYours = yours && !loading && allProjects.length > 0 && nActive === 0;
  const answer = loading ? "Projects"
    : allProjects.length === 0 ? "No projects yet."
      : yours
        ? (nActive === 0 ? "You're not on any active project."
          : nLate > 0 ? (nLate >= nActive ? (nActive === 1 ? "Your active project is late." : `All ${nActive} of your active projects are late.`) : `${nLate} of ${nActive} of your projects ${nLate === 1 ? "is" : "are"} late.`)
            : nActive === 1 ? "You're on 1 active project." : `Your ${nActive} active projects.`)
        : nLate > 0 ? (nLate >= nActive ? (nActive === 1 ? "The active project is late." : `All ${nActive} active projects are late.`) : `${nLate} of ${nActive} active projects ${nLate === 1 ? "is" : "are"} late.`)
          : `${nActive} active project${nActive === 1 ? "" : "s"}.`;
  // The title already says how many are running: the one number that
  // matters is how many are late (muted when none), the rest small.
  const facts: HeroFact[] | undefined = loading || (tabCounts.all ?? 0) === 0 || noneOfYours ? undefined : ([
    { label: "Late", value: nLate, tone: nLate > 0 ? "bad" : undefined, hero: nLate > 0 },
    { label: "Paused", value: nPaused, tone: nPaused > 0 ? "warn" : undefined },
    { label: "Completed", value: tabCounts.completed ?? 0 },
  // A zero is not news: only the counts that have something in them.
  ] as HeroFact[]).filter((f) => f.value !== 0);
  const shownCount = shownGroups.reduce((n, g) => n + g.items.length, 0);

  return (
    <PageShell width="work">
      <PageHero
        kicker={yours ? "Work · Your projects" : "Work · All projects"}
        title={answer}
        sub={noneOfYours ? "Switch to All projects to see the workspace." : undefined}
        facts={facts}
        factsHero={nLate > 0 ? "auto" : "none"}
        tools={activeOrgId && allProjects.length > 0 ? (
          <MoreMenu triggerClass={heroQuiet} items={[{ icon: <Download className="w-4 h-4" />, label: "Export all to CSV", onClick: async () => {
            try { await exportAllProjectsToCsv(activeOrgId); }
            catch (e) { await appAlert({ message: sayError(e), tone: "danger" }); }
          } }]} />
        ) : undefined}
        primary={<button type="button" onClick={() => setShowCreate(true)} className={heroPrimary}><Plus className="w-4 h-4" /> New project</button>}
      >
        {/* What steers the list: the status as underline tabs, then whose,
            search, unit and kind as quiet controls. */}
        <div className="space-y-3">
          <SubTabs label="Status" value={statusFilter} onChange={(v) => setStatusFilter(v)}
            className="border-b border-[var(--color-border)]"
            items={STATUS_TABS.map((t) => ({ id: t.value, label: t.label, count: tabCounts[t.value] }))} />
          <div className="flex flex-wrap items-center gap-2">
            {/* Whose projects: yours (the default), or every one you can see. */}
            <label className="max-sm:flex-1">
              <span className="sr-only">Whose projects</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as "mine" | "all")} className={`${bandSelect} max-sm:w-full`}>
                <option value="mine">Your projects</option>
                <option value="all">All projects</option>
              </select>
            </label>
            <div className="relative flex-1 min-w-[220px] max-w-md max-sm:basis-full max-sm:order-first">
              <Search className={bandInputIcon} />
              <input
                type="search" enterKeyHint="search"
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
            {/* Kinds of project */}
            {groups.length > 1 && (
              <label className="max-sm:flex-1">
                <span className="sr-only">Kind of project</span>
                <select value={typeFilter ?? ""} onChange={(e) => setTypeFilter(e.target.value || null)} className={`${bandSelect} max-sm:w-full`}>
                  <option value="">All kinds</option>
                  {groups.map((g) => <option key={g.key} value={g.key}>{g.label} ({badgeText(g.items.length)})</option>)}
                </select>
              </label>
            )}
          </div>
        </div>
      </PageHero>

      <PageBody>
        {/* RESULTS */}
        {loading ? (
          <SkeletonRows rows={6} cols={3} what="projects" />
        ) : error ? (
          <ErrorNote title="Couldn't load projects." next={error} onRetry={() => void refresh()} />
        ) : yours && allProjects.length > 0 && scopedAll.length === 0 ? (
          <p className="text-reading text-[var(--color-text)]">
            You&apos;re not on any project yet.{" "}
            <button type="button" onClick={() => setScope("all")} className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">See all projects</button>
          </p>
        ) : scopedProjects.length === 0 ? (
          filterActive && (tabCounts.all ?? 0) > 0 ? (
            <p className="text-reading text-[var(--color-text-muted)]">
              {searchQ ? <>No project named &ldquo;{searchQ}&rdquo;{statusFilter !== "all" ? ` in ${statusFilter}` : ""}.</> : `No ${statusFilter} projects.`}
              {" "}
              <button type="button" onClick={() => { setSearch(""); setStatusFilter("all"); }} className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">
                Clear filters
              </button>
            </p>
          ) : (
            <EmptyState onNew={() => setShowCreate(true)} />
          )
        ) : (
          <>
            {(searchQ || unitPick || typeFilter) && shownCount > 0 && (
              <p className="text-body text-[var(--color-text-muted)]">
                <span className="tabular-nums">{shownCount} of {tabCounts[statusFilter] ?? 0}</span> {statusFilter === "all" ? "" : `${statusFilter} `}projects{" "}
                <button type="button" onClick={() => { setSearch(""); setUnitPick(""); setTypeFilter(null); }} className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Clear</button>
              </p>
            )}
            {shownGroups.map((g) => {
              const open = !folded.has(g.key) || !!typeFilter;
              return (
                <Card key={g.key} as="section" pad={false} className="overflow-hidden"
                  label={<button type="button" onClick={() => toggleFold(g.key)} aria-expanded={open}
                    className="inline-flex items-center gap-2 -ml-1 pl-1 pr-2 pointer-coarse:min-h-11 rounded-lg hover:bg-[color-mix(in_srgb,var(--color-text)_6%,transparent)]">
                    <ChevronDown aria-hidden className={`ui-chevron w-4 h-4 text-[var(--color-text-muted)] ${open ? "" : "-rotate-90"}`} />
                    {g.label} <span className="text-reading font-normal tabular-nums text-[var(--color-text-muted)]">{g.items.length}</span>
                  </button>}>
                  {open ? <ProjectTable projects={g.items} factsOf={factsOf} /> : (
                    <button type="button" onClick={() => toggleFold(g.key)} className="w-full px-4 h-11 text-left text-body text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
                      {g.items.length} project{g.items.length === 1 ? "" : "s"} folded away. Show them.
                    </button>
                  )}
                </Card>
              );
            })}
            {shownCount === 0 && (
              <p className="text-reading text-[var(--color-text-muted)]">No projects on that unit.{" "}
                <button type="button" onClick={() => setUnitPick("")} className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Show all units</button>
              </p>
            )}
            {groups.some((g) => g.label === "Other projects") && (
              <p className="text-body text-[var(--color-text-muted)]">A project goes under its kind from its name, or from Setup › Project type.</p>
            )}
          </>
        )}
        <StaleCheckoutBanner userId={uid ?? undefined} />
      </PageBody>

      {showCreate && activeOrgId && uid && (
        <NewTurnaround
          orgId={activeOrgId}
          actorUserId={uid}
          actorEmail={userEmail ?? undefined}
          actorRole={activeRole}
          // It opens the new project itself.
          onClose={() => setShowCreate(false)}
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

const TAG: Record<ProjectStatus, { word: string; pill: string }> = {
  active:    { word: "Active",    pill: "" },
  paused:    { word: "Paused",    pill: "is-warn" },
  completed: { word: "Completed", pill: "is-good" },
  cancelled: { word: "Cancelled", pill: "is-muted" },
  archived:  { word: "Archived",  pill: "is-muted" },
};

/** Status as a soft pill: late red, paused amber, done green, running brand. */
function StatusTag({ status, late, workDone = false }: { status: ProjectStatus; late: boolean; workDone?: boolean }) {
  if (late) return <span className="ui-pill is-bad">Late</span>;
  if (status === "active" && workDone) return <span className="ui-pill is-good">Work done</span>;
  const t = TAG[status] ?? TAG.active;
  return <span className={`ui-pill ${t.pill}`}>{t.word}</span>;
}


/** A thin bar and the %: how far the work is. */
function ProgressBar({ f, className = "" }: { f: RowFacts; className?: string }) {
  const pr = f.progress;
  if (!pr) return null;
  const fill = f.late ? "var(--state-overdue)" : "var(--color-main)";
  return (
    <span className={`inline-flex items-center gap-2 ${className}`} title={`${pr.done} of ${pr.steps} steps done`}>
      <span className="relative h-2 w-24 rounded-full bg-[var(--color-accent-soft)] overflow-hidden" role="progressbar" aria-valuenow={pr.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Work done">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, Math.max(0, pr.pct))}%`, background: fill }} />
      </span>
      <span className="font-display text-reading font-semibold tabular-nums text-[var(--color-text)]">{pr.pct}%</span>
      {/* 99% reads as nearly done: say what is left, and that it is late. */}
      {pr.steps > pr.done && pr.pct >= 90 && (
        <span className={`text-body whitespace-nowrap ${f.late ? "font-medium text-[var(--state-overdue-text)]" : "text-[var(--color-text-muted)]"}`}>
          {pr.steps - pr.done} step{pr.steps - pr.done === 1 ? "" : "s"} left{f.late ? " · late" : ""}
        </span>
      )}
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
      <table className="max-sm:hidden w-full text-body">
        <thead className="bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)] text-left">
          <tr className="border-b border-[var(--color-border)]">
            <th scope="col" className="font-medium px-4 h-10">Project</th>
            <th scope="col" className="font-medium px-4 w-[120px]">Status</th>
            <th scope="col" className="font-medium px-4 w-[190px]">Phase / progress</th>
            <th scope="col" className="font-medium px-4 w-[150px]">Due</th>
            <th scope="col" className="font-medium px-4 w-[210px] hidden lg:table-cell">Owner</th>
            <th scope="col" className="font-medium px-4 w-[130px] hidden md:table-cell">Last activity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map(({ p, f, href }) => (
            <tr key={p.id} onClick={(e) => openRow(e, href)} className="hover:bg-[var(--color-surface-2)] cursor-pointer align-top">
              <td className="px-4 py-3 relative">
                {f.late && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
                <div className="flex items-baseline gap-2 min-w-0">
                  <Link href={href} className="min-w-0 font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{p.name}</Link>
                  {p.visibility === "private" && <span className="shrink-0 inline-flex items-center gap-1 text-body text-[var(--color-text-muted)]"><Lock className="w-3 h-3" /> Private</span>}
                  {p.mocReference && <CopyId value={p.mocReference} label="MOC number" className="shrink-0 text-body" />}
                </div>
                {p.description && <p className="mt-0.5 text-body text-[var(--color-text-muted)] line-clamp-1">{p.description}</p>}
              </td>
              <td className="px-4 py-3"><StatusTag status={p.status} late={f.late} workDone={!!f.progress && f.progress.pct >= 100} /></td>
              <td className="px-4 py-3">
                {f.progress ? <ProgressBar f={f} /> : f.progress === null ? <span className="text-body text-[var(--color-text-muted)]">No schedule yet</span> : null}
                {f.phaseNote && <div className="mt-0.5 text-body text-[var(--color-text-muted)]">{f.phaseNote}</div>}
              </td>
              <td className="px-4 py-3">
                {f.dueDay ? (
                  <>
                    <div className="font-display font-semibold tabular-nums text-[var(--color-text)]">{f.dueDay}</div>
                    {f.dueNote && <div className={`text-body ${f.late && (f.due?.kind === "past target" || f.due?.kind === "ended") ? "text-[var(--state-overdue-text)] font-medium" : "text-[var(--color-text-muted)]"}`}>{f.dueNote}</div>}
                  </>
                ) : null}
              </td>
              <td className="px-4 py-3 hidden lg:table-cell">
                <PersonName uid={p.ownerUserId} fallback={p.ownerUserName} className="block max-w-[200px] truncate text-body text-[var(--color-text)]" />
              </td>
              <td className="px-4 py-3 hidden md:table-cell text-body text-[var(--color-text-muted)] whitespace-nowrap">{formatRelative(p.lastActivityAt)}</td>
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
                <span className="min-w-0 flex-1 font-medium text-reading leading-snug text-[var(--color-text)]">
                  {p.name}
                  {p.visibility === "private" && <Lock className="inline w-3 h-3 ml-1.5 -mt-0.5 text-[var(--color-text-muted)]" aria-label="Private" />}
                </span>
                <StatusTag status={p.status} late={f.late} workDone={!!f.progress && f.progress.pct >= 100} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-[var(--color-text-muted)]">
                {f.progress && <ProgressBar f={f} />}
                {f.progress === null && <span>No schedule yet</span>}
                {f.phaseNote && <span>{f.phaseNote}</span>}
                {f.dueDay && <span className={f.late && (f.due?.kind === "past target" || f.due?.kind === "ended") ? "text-[var(--state-overdue-text)] font-medium" : ""}>{f.due?.kind === "starts" ? "Starts" : f.due?.kind === "ended" ? "Ended" : "Due"} {f.dueDay}</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

// One line and the one way in.
function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-8 flex flex-wrap items-center gap-x-4 gap-y-3">
      <p className="flex-1 min-w-[220px] text-reading text-[var(--color-text)]">A project holds a job&apos;s schedule, shift reports, costs and close-out.</p>
      <button type="button" onClick={onNew} className={heroQuiet}><Plus className="w-4 h-4" /> New project</button>
    </div>
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
