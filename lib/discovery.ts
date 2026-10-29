// discovery — work found when the equipment is opened, put into the
// schedule, and what it did to it.
//
// Discovery steps are ordinary steps (they show on the calendar, the shift
// report, the time log, the critical path) carrying a record in
// attributes.discovery: what was found, when, by whom, and the impact when
// it was added — the work added, the task's finish and the turnaround's
// forecast finish before and after, whether it landed on the critical
// path, and which planned steps it pushed.
//
// Placing it: the new steps run one after another, after the step they
// follow (never before now); the steps it holds up now wait on the last of
// them; and everything linked downstream is pushed by the same cascade the
// schedule uses for a move (lib/scheduleReflow). Pure.

import type { Milestone } from "@/types/schema";
import { cascadeDependents, type DateChange, type ReflowNode } from "@/lib/scheduleReflow";
import { computeCpm } from "@/lib/cpm";
import { resolveCriticalPath, type CriticalMode } from "@/lib/criticalPath";

export interface DiscoveryStepInput { name: string; crew?: string; hours: number }

/** Work put in after the plan: discovery — found when the equipment was
 *  opened — or added scope — known work that wasn't on the schedule. The
 *  words every view, report and email use for each (one place). */
export type AddedKind = "discovery" | "added";
export const ADDED: Record<AddedKind, { word: string; lower: string; found: string; what: string; tip: string }> = {
  discovery: { word: "Discovery", lower: "discovery", found: "found", what: "What was found", tip: "found when it was opened — not in the original schedule" },
  added: { word: "Added scope", lower: "added scope", found: "raised", what: "What's being added", tip: "known work that wasn't on the schedule — not in the original plan" },
};
/** Its kind; one saved before there were two is discovery. */
export const kindOf = (r?: { kind?: AddedKind | null } | null): AddedKind => (r?.kind === "added" ? "added" : "discovery");
/** What a list of them is called: "Discovery work", "Added scope", or both. */
export function addedTitle(kinds: AddedKind[]): string {
  const d = kinds.includes("discovery"), a = kinds.includes("added");
  return d && a ? "Discovery & added scope" : a ? "Added scope" : "Discovery work";
}
/** The comment it leaves on the step it follows: "Discovery: …". */
export const addedNote = (kind: AddedKind, what: string) => `${ADDED[kind].word}: ${what.trim()}`;

export interface DiscoveryDraft {
  /** The equipment / task it's under. */
  taskId: string;
  /** What was found. */
  what: string;
  foundAt: number;
  foundBy?: string;
  approvedBy?: string;
  steps: DiscoveryStepInput[];
  /** The step it follows — it can't start until that one's done. */
  afterId?: string | null;
  /** Steps that can't start until it's done. */
  holdsIds?: string[];
  /** When the work is planned to start; none — as soon as it can
   *  (earliestStart). */
  startAt?: number | null;
  kind?: AddedKind;
}

export interface DiscoveryImpact {
  /** Work added, hours. */
  hours: number;
  /** The task's planned finish, before → after. */
  taskFinish: [number, number];
  /** The turnaround's forecast finish (lib/cpm), before → after. */
  finish: [number, number];
  /** The new work is on the critical path. */
  critical: boolean;
  /** Planned steps it pushed later, and by how much. */
  pushed: Array<{ id: string; name: string; hours: number }>;
}

/** Kept on each step it added (attributes.discovery). */
export interface DiscoveryRecord {
  id: string;
  /** Discovery (the default) or added scope. */
  kind?: AddedKind;
  what: string;
  foundAt: number;
  foundBy?: string;
  approvedBy?: string;
  addedAt: number;
  addedBy?: string;
  /** Which of its steps this is (1-based), of how many. */
  seq: number; of: number;
  afterId?: string | null;
  holdsIds?: string[];
  impact: DiscoveryImpact;
}

export interface DiscoveryPlan {
  /** The new steps, in order (ids are placeholders until saved: "new:0"…). */
  steps: Array<{ tempId: string; name: string; crew?: string; hours: number; plannedStartAt: string; plannedAt: string; dependsOn: string[] }>;
  /** Steps that now wait on it: their new predecessor list. */
  links: Array<{ id: string; dependsOn: string[] }>;
  /** Planned dates the cascade moves (existing steps and their tasks). */
  moves: DateChange[];
  impact: DiscoveryImpact;
}

const H = 3_600_000;
const ms = (v: unknown): number => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));
const iso = (t: number) => new Date(t).toISOString();

function leavesUnder(milestones: Milestone[], id: string): Milestone[] {
  const kids = new Map<string, Milestone[]>();
  for (const m of milestones) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
  const out: Milestone[] = [], stack = [...(kids.get(id) ?? [])];
  while (stack.length) { const c = stack.pop()!; const k = c.id ? kids.get(c.id) : undefined; if (k?.length) stack.push(...k); else out.push(c); }
  return out;
}

const finishOf = (rows: Milestone[]) => rows.reduce((a, m) => Math.max(a, ms(m.plannedAt)), -Infinity);

/** The step new work most likely follows: the one under way, else the last
 *  one done, else the first not started. */
export function defaultAfter(milestones: Milestone[], taskId: string): string | null {
  const steps = leavesUnder(milestones, taskId).sort((a, b) => ms(a.plannedStartAt ?? a.plannedAt) - ms(b.plannedStartAt ?? b.plannedAt));
  const going = steps.find((m) => m.status === "in_progress" || m.status === "on_hold" || m.status === "blocked");
  if (going?.id) return going.id;
  const done = steps.filter((m) => m.status === "completed");
  if (done.length) return done[done.length - 1].id ?? null;
  return steps[0]?.id ?? null;
}

/** What waits on that step inside the task — what the new work holds up too. */
export function defaultHolds(milestones: Milestone[], taskId: string, afterId: string | null): string[] {
  if (!afterId) return [];
  return leavesUnder(milestones, taskId).filter((m) => m.id && m.id !== afterId && (m.dependsOn ?? []).includes(afterId) && m.status !== "completed").map((m) => m.id!);
}

/** As soon as the work can start: now, or when the step it follows is
 *  done (as planned, or when it was), whichever is later. */
export function earliestStart(milestones: Milestone[], afterId: string | null | undefined, now: number): number {
  const after = afterId ? milestones.find((m) => m.id === afterId) : undefined;
  const afterEnd = after ? (after.status === "completed" ? ms(after.actualAt ?? after.plannedAt) : ms(after.plannedAt)) : -Infinity;
  return Math.max(now, Number.isFinite(afterEnd) ? afterEnd : -Infinity);
}

/** When the step it follows is planned to be done (or was), if it follows one. */
export function followsUntil(milestones: Milestone[], afterId: string | null | undefined): number | null {
  const after = afterId ? milestones.find((m) => m.id === afterId) : undefined;
  if (!after) return null;
  const t = after.status === "completed" ? ms(after.actualAt ?? after.plannedAt) : ms(after.plannedAt);
  return Number.isFinite(t) ? t : null;
}

/** `mode`: the project's critical-path setting — "on the critical path"
 *  means what it means everywhere else (lib/criticalPath, hand marks too). */
export function planDiscovery(milestones: Milestone[], draft: DiscoveryDraft, o: { now: number; tz: string; mode?: CriticalMode | null }): DiscoveryPlan {
  const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const after = draft.afterId ? byId.get(draft.afterId) : undefined;
  // When it's planned to start, or as soon as it can.
  let t = draft.startAt != null && Number.isFinite(draft.startAt) ? draft.startAt : earliestStart(milestones, draft.afterId, o.now);
  const steps: DiscoveryPlan["steps"] = [];
  draft.steps.forEach((s, i) => {
    const hrs = Math.max(0.25, s.hours || 0);
    const tempId = `new:${i}`;
    steps.push({ tempId, name: s.name.trim(), crew: s.crew?.trim() || undefined, hours: hrs, plannedStartAt: iso(t), plannedAt: iso(t + hrs * H),
      dependsOn: i === 0 ? (after?.id ? [after.id] : []) : [`new:${i - 1}`] });
    t += hrs * H;
  });
  const lastId = steps[steps.length - 1]?.tempId;
  const links = (draft.holdsIds ?? []).filter((id) => byId.has(id) && lastId).map((id) => ({ id, dependsOn: [...new Set([...(byId.get(id)!.dependsOn ?? []), lastId!])] }));
  const linkOf = new Map(links.map((l) => [l.id, l.dependsOn]));

  // The schedule with it in, before the cascade.
  const nodes: ReflowNode[] = [
    ...milestones.filter((m) => m.id && m.plannedAt).map((m) => ({
      id: m.id!, parentId: m.parentId ?? null, plannedStartAt: (m.plannedStartAt as string | undefined) ?? null, plannedAt: m.plannedAt as string,
      status: m.status, dependsOn: linkOf.get(m.id!) ?? m.dependsOn ?? null, links: m.linkTypes ?? null,
    })),
    ...steps.map((s) => ({ id: s.tempId, parentId: draft.taskId, plannedStartAt: s.plannedStartAt, plannedAt: s.plannedAt, status: "planned", dependsOn: s.dependsOn, links: null })),
  ];
  const changes = cascadeDependents(nodes, steps.map((s) => s.tempId), o.tz);
  const moves = changes.filter((c) => !c.id.startsWith("new:"));
  const moved = new Map(moves.map((c) => [c.id, c]));

  // The schedule after: new steps, new links, moved dates.
  const asStep = (s: DiscoveryPlan["steps"][number]): Milestone => ({
    id: s.tempId, orgId: "", projectId: "", parentId: draft.taskId, name: s.name, weight: 1, status: "planned", source: "manual", createdBy: "",
    plannedStartAt: s.plannedStartAt, plannedAt: s.plannedAt, durationHours: s.hours, dependsOn: s.dependsOn, responsibleParty: s.crew ?? null,
  } as Milestone);
  const afterRows: Milestone[] = [
    ...milestones.map((m) => {
      const c = m.id ? moved.get(m.id) : undefined;
      const deps = m.id ? linkOf.get(m.id) : undefined;
      return c || deps ? { ...m, ...(c ? { plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt } : {}), ...(deps ? { dependsOn: deps } : {}) } : m;
    }),
    ...steps.map(asStep),
  ];
  const before = computeCpm(milestones, { now: o.now, tz: o.tz });
  const after2 = computeCpm(afterRows, { now: o.now, tz: o.tz });
  const taskBefore = finishOf(leavesUnder(milestones, draft.taskId));
  const taskAfter = finishOf(leavesUnder(afterRows, draft.taskId));
  const kids = new Set(milestones.map((m) => m.parentId).filter(Boolean));
  const pushed = moves
    .map((c) => { const m = byId.get(c.id); return m && !kids.has(c.id) ? { id: c.id, name: m.name, hours: Math.round(((ms(c.plannedAt) - ms(m.plannedAt)) / H) * 10) / 10 } : null; })
    .filter((x): x is { id: string; name: string; hours: number } => !!x && x.hours > 0)
    .sort((a, b) => b.hours - a.hours);
  return {
    steps, links, moves,
    impact: {
      hours: Math.round(steps.reduce((a, s) => a + s.hours, 0) * 10) / 10,
      taskFinish: [taskBefore, Math.max(taskBefore, taskAfter)],
      finish: [before.forecastFinish, after2.forecastFinish],
      critical: (() => { const ids = resolveCriticalPath(afterRows, o.mode ?? null, { now: o.now, tz: o.tz }).ids; return steps.some((s) => ids.has(s.tempId)); })(),
      pushed,
    },
  };
}

/** One piece of discovery, as the reports list it: its record and its steps. */
export interface Discovery { record: DiscoveryRecord; steps: Milestone[]; task: Milestone | undefined }

/** Its record (kept as JSON text in attributes.discovery). */
export const discoveryOf = (m: Milestone): DiscoveryRecord | undefined => {
  const raw = (m.attributes as Record<string, unknown> | null | undefined)?.discovery;
  let d: unknown = raw;
  if (typeof raw === "string") { try { d = JSON.parse(raw); } catch { return undefined; } }
  const r = d as DiscoveryRecord | undefined;
  return r && typeof r === "object" && r.id && r.what ? r : undefined;
};

/** The attribute value that keeps it. */
export const discoveryAttr = (r: DiscoveryRecord): string => JSON.stringify(r);

/** Every piece of discovery on the schedule, oldest first. */
export function discoveries(milestones: Milestone[]): Discovery[] {
  const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const groups = new Map<string, Discovery>();
  for (const m of milestones) {
    const d = discoveryOf(m);
    if (!d) continue;
    const g = groups.get(d.id) ?? { record: d, steps: [], task: m.parentId ? byId.get(m.parentId) : undefined };
    g.steps.push(m);
    if (d.seq === 1) g.record = d;
    groups.set(d.id, g);
  }
  for (const g of groups.values()) g.steps.sort((a, b) => (discoveryOf(a)?.seq ?? 0) - (discoveryOf(b)?.seq ?? 0));
  return [...groups.values()].sort((a, b) => a.record.foundAt - b.record.foundAt);
}

/** "+14 h to V-7 · finish +8 h · critical" — the impact in a line. */
export function impactLine(i: DiscoveryImpact, hrs: (h: number) => string): string {
  const task = (i.taskFinish[1] - i.taskFinish[0]) / H;
  const fin = (i.finish[1] - i.finish[0]) / H;
  return [
    `${hrs(i.hours)} of work`,
    task >= 0.1 ? `task finish +${hrs(Math.round(task * 10) / 10)}` : "task finish unchanged",
    fin >= 0.1 ? `turnaround finish +${hrs(Math.round(fin * 10) / 10)}` : "turnaround finish unchanged",
    i.critical ? "on the critical path" : null,
  ].filter(Boolean).join(" · ");
}

/** The report's account: found on the shift, and the whole job's so far. */
export function discoverySummary(ds: Discovery[], from: number, to: number) {
  const add = (xs: Discovery[]) => Math.round(xs.reduce((a, d) => a + d.record.impact.hours, 0) * 10) / 10;
  const later = (xs: Discovery[]) => Math.round(xs.reduce((a, d) => a + Math.max(0, d.record.impact.finish[1] - d.record.impact.finish[0]), 0) / H * 10) / 10;
  const inShift = ds.filter((d) => d.record.foundAt >= from && d.record.foundAt < to);
  const open = ds.filter((d) => d.record.foundAt < from && d.steps.some((s) => s.status !== "completed"));
  return {
    inShift, open, all: ds,
    shift: { count: inShift.length, hours: add(inShift), finishH: later(inShift), critical: inShift.filter((d) => d.record.impact.critical).length },
    job: { count: ds.length, hours: add(ds), finishH: later(ds) },
  };
}

/** "Weld repair tray 14 — Ancon, 8 h · done" — one of its steps, where it stands. */
export function discoveryStepLine(m: Milestone, hrs: (h: number) => string): string {
  const pct = m.status === "completed" ? 100 : Math.round(Number(m.percentComplete ?? 0));
  const state = m.status === "completed" ? "done" : m.status === "on_hold" ? "on hold" : m.status === "blocked" ? "blocked" : pct > 0 ? `${pct}%` : "not started";
  const h = Number(m.durationHours);
  return `${m.name} — ${[m.responsibleParty?.trim(), Number.isFinite(h) && h > 0 ? hrs(h) : null].filter(Boolean).join(", ")} · ${state}`;
}
