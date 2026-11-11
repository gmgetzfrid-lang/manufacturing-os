// projectPhases - one project split into phases (Transmix 1 and 2: one
// AFE, two turnarounds). Each phase has its name, its dates and its share
// of the AFE, set with a slider; each has its own schedule, tracked on its
// own and rolled up for the whole project.
//
//   - Which phase a step is in: its own tag (attributes.project_phase), else
//     the tag on the task above it, else the first phase. So the schedule
//     there before phases were set up is phase 1 with nothing rewritten, and
//     a schedule imported into a phase is tagged as it lands.
//   - The split: shares in % that always add up to 100. Dragging the line
//     between two phases moves only those two; typing one phase's % or $
//     takes it from (or gives it to) the phase after it.
//
// Pure: no database. The phases are kept on projects.phases (PHASES_SQL).

import type { Milestone } from "@/types/schema";

export interface ProjectPhase {
  id: string;
  name: string;
  /** "YYYY-MM-DD", plant days. Finish may be open. */
  start: string | null;
  end: string | null;
  /** % of the AFE, 0-100; the phases' shares add up to 100. */
  share: number;
}

/** Where a step's phase is kept (on the step, or on a task above it). */
export const PHASE_ATTR = "project_phase";

/** The database change phases need (run once in Supabase). */
export const PHASES_SQL = `alter table public.projects add column if not exists phases jsonb not null default '[]'::jsonb;
alter table public.cost_accounts add column if not exists phase_id text;
alter table public.cost_entries add column if not exists phase_id text;
notify pgrst, 'reload schema';`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** A project's phases as saved: in its settings (projects.shift_times,
 *  where every project setting saves for whoever can change the project),
 *  else the phases column. Saved in settings, even empty, settings win. */
export function phasesOfRow(r: { phases?: unknown; shift_times?: unknown }): ProjectPhase[] {
  const st = r.shift_times && typeof r.shift_times === "object" ? (r.shift_times as Record<string, unknown>) : null;
  return normalizePhases(st && "phases" in st ? st.phases : r.phases);
}

/** The phases as saved, cleaned: named, dated, shares adding to 100. */
export function normalizePhases(raw: unknown): ProjectPhase[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectPhase[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const id = typeof r.id === "string" && r.id ? r.id : null;
    if (!id || out.some((p) => p.id === id)) continue;
    out.push({
      id,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : `Phase ${out.length + 1}`,
      start: typeof r.start === "string" && DAY.test(r.start) ? r.start : null,
      end: typeof r.end === "string" && DAY.test(r.end) ? r.end : null,
      share: Number.isFinite(Number(r.share)) ? Math.max(0, Number(r.share)) : 0,
    });
  }
  return out.length ? withShares(out, fitShares(out.map((p) => p.share))) : [];
}

const withShares = (ps: ProjectPhase[], shares: number[]) => ps.map((p, i) => ({ ...p, share: shares[i] }));

/** Shares that add up to exactly 100 (to a tenth of a percent): scaled, and
 *  the rounding left over goes on the largest. All zero: even. */
export function fitShares(shares: number[]): number[] {
  if (!shares.length) return [];
  const clean = shares.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  const scaled = sum > 0 ? clean.map((s) => round1((s / sum) * 100)) : evenShares(clean.length);
  const left = round1(100 - scaled.reduce((a, b) => a + b, 0));
  if (left !== 0) {
    const big = scaled.indexOf(Math.max(...scaled));
    scaled[big] = round1(scaled[big] + left);
  }
  return scaled;
}

/** n phases, even: 50/50, 33.4/33.3/33.3. */
export function evenShares(n: number): number[] {
  if (n <= 0) return [];
  const each = Math.floor((1000 / n)) / 10;
  const out = Array.from({ length: n }, () => each);
  out[0] = round1(100 - each * (n - 1));
  return out;
}

/** The line between phase i and i+1 moved to `at` % along the bar: only
 *  those two change; neither goes below 0. */
export function moveDivider(shares: number[], i: number, at: number): number[] {
  if (i < 0 || i >= shares.length - 1) return shares;
  const before = shares.slice(0, i).reduce((a, b) => a + b, 0);
  const pair = shares[i] + shares[i + 1];
  const a = round1(Math.max(0, Math.min(pair, at - before)));
  const out = [...shares];
  out[i] = a;
  out[i + 1] = round1(pair - a);
  return out;
}

/** Phase i's share typed in: the phase after it (the one before, for the
 *  last) takes up the difference, as far as it can. */
export function setShare(shares: number[], i: number, value: number): number[] {
  if (i < 0 || i >= shares.length || shares.length < 2) return shares.length ? [100] : [];
  const j = i < shares.length - 1 ? i + 1 : i - 1;
  const pair = shares[i] + shares[j];
  const v = round1(Math.max(0, Math.min(pair, value)));
  const out = [...shares];
  out[i] = v;
  out[j] = round1(pair - v);
  return out;
}

/** A phase's share of an amount, to the dollar. */
export const phaseAmount = (total: number | null | undefined, share: number) => Math.round(((total ?? 0) * share) / 100);

/** A dollar amount typed for a phase, as its share of the total. */
export const shareOfAmount = (total: number | null | undefined, amount: number) => (total && total > 0 ? round1((amount / total) * 100) : 0);

/** A new phase's id. */
export const newPhaseId = () => `ph_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

/** Split a project into its first two phases: the schedule already on it is
 *  phase 1 (its own dates), the second starts empty; the AFE split even. */
export function startPhases(name: string, first: { start: string | null; end: string | null }): ProjectPhase[] {
  const [a, b] = evenShares(2);
  return [
    { id: newPhaseId(), name: `${name.trim() || "Phase"} 1`, start: first.start, end: first.end, share: a },
    { id: newPhaseId(), name: `${name.trim() || "Phase"} 2`, start: null, end: null, share: b },
  ];
}

/** Each step's phase: its own tag, else a task above it, else the first
 *  phase (the schedule there before phases). A tag naming a phase since
 *  removed counts as the first phase too. No phases: empty. */
export function phaseIndex(ms: Milestone[], phases: ProjectPhase[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!phases.length) return out;
  const known = new Set(phases.map((p) => p.id));
  const first = phases[0].id;
  const byId = new Map(ms.filter((m) => m.id).map((m) => [m.id!, m]));
  const own = (m: Milestone) => { const v = (m.attributes as Record<string, unknown> | undefined)?.[PHASE_ATTR]; return typeof v === "string" && known.has(v) ? v : null; };
  const find = (m: Milestone): string => {
    if (m.id && out.has(m.id)) return out.get(m.id)!;
    const seen = new Set<string>();
    let cur: Milestone | undefined = m, got: string | null = null;
    while (cur && !got) {
      got = own(cur);
      if (got || !cur.parentId || seen.has(cur.parentId)) break;
      seen.add(cur.parentId);
      cur = byId.get(cur.parentId);
    }
    const ph = got ?? first;
    if (m.id) out.set(m.id, ph);
    return ph;
  };
  for (const m of ms) find(m);
  return out;
}

/** The steps in one phase (null: every phase, the whole project). */
export function inPhase(ms: Milestone[], phases: ProjectPhase[], phaseId: string | null): Milestone[] {
  if (!phaseId || !phases.length) return ms;
  const idx = phaseIndex(ms, phases);
  return ms.filter((m) => !m.id || idx.get(m.id) === phaseId);
}

/** The phase a day falls in, by the phases' dates (the latest to have
 *  started, when they overlap). Null: before the first, or no dates. */
export function phaseOnDay(day: string, phases: ProjectPhase[]): ProjectPhase | null {
  let hit: ProjectPhase | null = null;
  for (const p of phases) {
    if (p.start && p.start <= day && (!p.end || day <= p.end)) {
      if (!hit || (hit.start ?? "") <= p.start) hit = p;
    }
  }
  return hit;
}

/** What a list of projects says about a project's dates. Split in phases:
 *  the phase running today and when it ends; between phases, the next one
 *  and when it starts; after the last, when it ended. A project with no
 *  phases: the target date typed on it. The typed target is never held
 *  against a project in phases (Transmix's "Oct 30" was phase 1's end; the
 *  job runs through phase 2). `days` is whole plant days from today, never
 *  negative. Whether the work is late is the schedule's to say, not this. */
export interface ProjectDue { phase: string | null; kind: "ends" | "starts" | "ended" | "target" | "past target"; day: string; days: number }
export function projectDue(phases: ProjectPhase[], target: string | null | undefined, today: string): ProjectDue | null {
  const gap = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  const dated = phases.filter((p) => p.start || p.end);
  if (dated.length) {
    const running = phaseOnDay(today, phases);
    if (running) return running.end ? { phase: running.name, kind: "ends", day: running.end, days: gap(today, running.end) } : null;
    const next = dated.filter((p) => p.start && p.start > today).sort((a, b) => (a.start! < b.start! ? -1 : 1))[0];
    if (next) return { phase: next.name, kind: "starts", day: next.start!, days: gap(today, next.start!) };
    const last = dated.filter((p) => p.end && p.end < today).sort((a, b) => (a.end! < b.end! ? 1 : -1))[0];
    return last ? { phase: last.name, kind: "ended", day: last.end!, days: gap(last.end!, today) } : null;
  }
  const t = typeof target === "string" && DAY.test(target.slice(0, 10)) ? target.slice(0, 10) : null;
  if (!t) return null;
  return t >= today ? { phase: null, kind: "target", day: t, days: gap(today, t) } : { phase: null, kind: "past target", day: t, days: gap(t, today) };
}

/** "Phase 2 ends in 5d", "Phase 2 starts in 3d", "Phase 2 ended 2d ago",
 *  "due in 5d", "11d past target". */
export function projectDueWords(d: ProjectDue): string {
  const n = d.days === 0 ? "today" : `${d.days}d`;
  if (d.kind === "ends") return `${d.phase} ends ${d.days === 0 ? "today" : `in ${n}`}`;
  if (d.kind === "starts") return `${d.phase} starts ${d.days === 0 ? "today" : `in ${n}`}`;
  if (d.kind === "ended") return `${d.phase} ended ${d.days === 0 ? "today" : `${n} ago`}`;
  if (d.kind === "target") return d.days === 0 ? "due today" : `due in ${n}`;
  return `${n} past target`;
}

/** The import key for a phase's rows, so two phases' schedule files (both
 *  numbering their tasks from 1) never match each other's rows. */
export const phaseRef = (phaseId: string, ref: string | null | undefined) => (ref ? `${phaseId}:${ref}` : ref ?? undefined);

/** "Oct 31 – Nov 7", "from Nov 8", "no dates". */
export function phaseDates(p: ProjectPhase): string {
  const d = (s: string) => { const [y, m, dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); };
  if (p.start && p.end) return `${d(p.start)} – ${d(p.end)}`;
  if (p.start) return `from ${d(p.start)}`;
  if (p.end) return `to ${d(p.end)}`;
  return "no dates";
}

/** What's wrong with the phases before saving (none: empty). */
export function phaseProblems(phases: ProjectPhase[]): string[] {
  const out: string[] = [];
  phases.forEach((p, i) => {
    if (!p.name.trim()) out.push(`Phase ${i + 1} needs a name.`);
    if (p.start && p.end && p.end < p.start) out.push(`${p.name || `Phase ${i + 1}`} finishes before it starts.`);
  });
  const names = phases.map((p) => p.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) out.push("Two phases have the same name.");
  const sum = round1(phases.reduce((a, p) => a + p.share, 0));
  if (phases.length && sum !== 100) out.push(`The shares add up to ${sum}%, not 100%.`);
  return out;
}

/** A schedule file's rows, for a phase: each tagged with the phase, and,
 *  but for the phase there first (its rows were imported before phases),
 *  every import key, parent and link made the phase's own. */
export function rowsForPhase<R extends {
  externalRef?: string | null; parentExternalRef?: string | null; dependsOnExternalRefs?: string[];
  linksByRef?: Record<string, unknown>; attributes?: Record<string, unknown> | null;
}>(rows: R[], phaseId: string, ownKeys: boolean): R[] {
  const k = (ref: string | null | undefined) => (ownKeys ? phaseRef(phaseId, ref) : ref ?? undefined);
  return rows.map((r) => ({
    ...r,
    externalRef: k(r.externalRef),
    parentExternalRef: k(r.parentExternalRef) ?? null,
    ...(r.dependsOnExternalRefs ? { dependsOnExternalRefs: r.dependsOnExternalRefs.map((x) => k(x)!).filter(Boolean) } : {}),
    ...(r.linksByRef ? { linksByRef: Object.fromEntries(Object.entries(r.linksByRef).map(([ref, v]) => [k(ref)!, v])) } : {}),
    attributes: { ...(r.attributes ?? {}), [PHASE_ATTR]: phaseId },
  }));
}

// The phase new work lands in: the phase picked on the project (or the
// one running today), set by the schedule screen, read when a task is
// added with nothing above it (lib/milestones createMilestone). A task
// added under another takes that one's phase.
const newWorkPhase = new Map<string, string>();
export function setNewWorkPhase(projectId: string, phaseId: string | null): void {
  if (phaseId) newWorkPhase.set(projectId, phaseId); else newWorkPhase.delete(projectId);
}
export const newWorkPhaseOf = (projectId: string | null | undefined): string | null => (projectId ? newWorkPhase.get(projectId) ?? null : null);
