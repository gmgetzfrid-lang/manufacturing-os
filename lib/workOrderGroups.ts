// workOrderGroups - the job by work order: each step under its work
// order (its own WO #, else the nearest group above with one; added work
// on its equipment's card), with plan against actual, % and hours ahead
// or behind. The Work orders view and the Work order report read it, so
// they can't disagree.

import type { Milestone, MilestoneNote, MilestoneStatus } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { leafPercent } from "@/lib/scheduleProgress";
import { expectedFraction, workHours, type ShiftTimes } from "@/lib/shiftReport";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { discoveryOf, discoveryText, kindOf, ADDED, type AddedKind } from "@/lib/discovery";
import type { PathMarks } from "@/lib/criticalPath";
import { notesFor } from "@/lib/milestones";
import { loadProgressLog } from "@/lib/progressHistory";
import { buildTimeLog, type TimeLogRow } from "@/lib/timeLog";
import { letterheadDocument, type Letterhead } from "@/lib/letterhead";
import { workOrdersHtml, PRINT_CSS, type PrintOrder, type PrintFormat } from "@/lib/workOrdersPrint";
import { saidWithLatest } from "@/lib/stepComment";
import { searchFilter } from "@/lib/fuzzySearch";
import { woOf, taskWorkOrder } from "@/lib/workOrderCrew";

export const STEP_STATUS: Record<MilestoneStatus, string> = { planned: "Not started", in_progress: "In progress", completed: "Done", on_hold: "On hold", blocked: "Blocked", missed: "Missed" };
export const SHOW_WORD: Record<string, string> = { all: "All work orders", open: "Open work orders", critical: "Work orders on the critical path", behind: "Work orders behind plan", notStarted: "Work orders not started", held: "Held work orders", done: "Done work orders", added: "Work orders with discovery or added scope" };
const noteAt = (n: MilestoneNote) => ms(n.happenedAt ?? n.createdAt);

export type Standing = "not_started" | "in_progress" | "held" | "done";
export const STANDING: Record<Standing, { word: string; cls: string }> = {
  not_started: { word: "Not started", cls: "text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]" },
  in_progress: { word: "In progress", cls: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-900" },
  held: { word: "Held", cls: "text-amber-800 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-900" },
  done: { word: "Done", cls: "text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-900" },
};
export type Show = "all" | "open" | "critical" | "behind" | "notStarted" | "held" | "done" | "added";
/** Its description — not the schedule file's "Summary (rolls up children)". */
export const descOf = (m: Milestone) => { const d = m.description?.trim() ?? ""; return /^summary \(rolls up children\)$/i.test(d) ? "" : d; };
export const ms = (v: unknown) => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

export interface WorkOrder {
  key: string;
  wo: string | null;
  /** The task (or single step) the WO is on. */
  owner: Milestone;
  /** Other equipment on the same WO number. */
  also?: Milestone[];
  steps: Milestone[];
  crews: string[];
  planStart: number; planFinish: number;
  actStart: number; actFinish: number;
  pct: number; plan: number; hours: number;
  standing: Standing;
  done: number;
  /** Put in after the plan — discovery, added scope — steps and hours of each. */
  added: Array<{ kind: AddedKind; n: number; h: number }>;
  find: string;
}

/** Each step's work order: its own, else the nearest group above with
 *  one; with none, the task it's under. Keyed `${wo}:${owner id}`. */
export function workOrderGroupsOf(milestones: Milestone[], childrenByParent: Map<string, Milestone[]>): Map<string, { wo: string | null; owner: Milestone; steps: Milestone[]; also?: Milestone[] }> {
  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  const groups = new Map<string, { wo: string | null; owner: Milestone; steps: Milestone[] }>();
  for (const m of milestones) {
    if (!m.id || (childrenByParent.get(m.id)?.length ?? 0) > 0) continue;
    // Added work stays on its equipment's card, even with a WO # of its own.
    let x: Milestone | undefined = discoveryOf(m) && m.parentId ? byId.get(m.parentId) ?? m : m, wo = "", owner: Milestone | undefined;
    const seen = new Set<string>();
    while (x && x.id && !seen.has(x.id)) {
      seen.add(x.id);
      wo = woOf(x);
      if (wo) { owner = x; break; }
      x = x.parentId ? byId.get(x.parentId) : undefined;
    }
    // The task above carrying the same number - its own, or typed on each of
    // its steps (E-12) - is the work order, not the step.
    for (let up = owner?.parentId ? byId.get(owner.parentId) : undefined; wo && up?.id && !seen.has(up.id) && taskWorkOrder(up, (id) => childrenByParent.get(id) ?? []) === wo; up = up.parentId ? byId.get(up.parentId) : undefined) { seen.add(up.id); owner = up; }
    if (!owner) owner = (m.parentId ? byId.get(m.parentId) : undefined) ?? m;
    const key = `${wo || "-"}:${owner.id}`;
    const g = groups.get(key) ?? { wo: wo || null, owner, steps: [] };
    g.steps.push(m);
    groups.set(key, g);
  }
  return byNumber(groups, byId);
}

/** One work order per WO number. Steps with no WO under a task whose
 *  sub-tasks all carry one WO number are that work order's (the Pulsation
 *  Dampeners' welding steps belong with the re-installs on WO 304528); and
 *  one WO number on two pieces of equipment is one work order, both named. */
function byNumber(groups: Map<string, { wo: string | null; owner: Milestone; steps: Milestone[] }>, byId: Map<string, Milestone>): Map<string, { wo: string | null; owner: Milestone; steps: Milestone[]; also?: Milestone[] }> {
  const above = (m: Milestone): Set<string> => {
    const out = new Set<string>();
    for (let p = m.parentId ? byId.get(m.parentId) : undefined, g = 0; p?.id && g < 60 && !out.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined, g++) out.add(p.id);
    return out;
  };
  // Each no-WO task: the WO numbers found on the work orders under it.
  const under = new Map<string, Set<string>>();
  for (const g of groups.values()) {
    if (!g.wo) continue;
    for (const id of [...(g.owner.id ? [g.owner.id] : []), ...above(g.owner)]) under.set(id, (under.get(id) ?? new Set()).add(g.wo));
  }
  const out = new Map<string, { wo: string | null; owner: Milestone; steps: Milestone[]; also?: Milestone[] }>();
  for (const [key, g] of groups) {
    let wo = g.wo;
    if (!wo && g.owner.id) { const ws = under.get(g.owner.id); if (ws?.size === 1) wo = [...ws][0]; }
    const k = wo ? `wo:${wo}` : key;
    const cur = out.get(k);
    if (!cur) { out.set(k, { wo, owner: g.owner, steps: [...g.steps] }); continue; }
    cur.steps.push(...g.steps);
    // The work order is named for its top task (the one others sit under).
    const [top, other] = above(g.owner).has(cur.owner.id ?? "") ? [cur.owner, g.owner] : above(cur.owner).has(g.owner.id ?? "") ? [g.owner, cur.owner] : [cur.owner, g.owner];
    cur.owner = top;
    // Another piece of equipment on the same number: named as well.
    if (!above(other).has(top.id ?? "") && other.id !== top.id) cur.also = [...(cur.also ?? []), other];
  }
  return out;
}

/** The work orders, earliest planned first. */
export function groupWorkOrders(milestones: Milestone[], childrenByParent: Map<string, Milestone[]>, progress: Map<string, ProgressInfo> | undefined, tz: string, times: ShiftTimes, now: number): WorkOrder[] {
  const pctOf = (m: Milestone) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
  const groups = workOrderGroupsOf(milestones, childrenByParent);
  const out: WorkOrder[] = [];
  for (const [key, g] of groups) {
    const steps = [...g.steps].sort((a, b) => startMsOf(a) - startMsOf(b));
    let wSum = 0, pSum = 0, planSum = 0, hours = 0, done = 0, held = false, started = false;
    let planStart = Infinity, planFinish = -Infinity, actStart = Infinity, actFinish = -Infinity;
    for (const s of steps) {
      const w = Math.max(0.1, s.durationHours != null && s.durationHours > 0 ? s.durationHours : workHours(s, tz));
      const p = pctOf(s), e = Math.round(expectedFraction(s, now, tz, times) * 100);
      wSum += w; pSum += p * w; planSum += e * w; hours += ((p - e) / 100) * w;
      if (s.status === "completed") done++;
      if (s.status === "on_hold" || s.status === "blocked") held = true;
      if (s.status !== "planned" && s.status !== "missed") started = true;
      planStart = Math.min(planStart, startMsOf(s)); planFinish = Math.max(planFinish, finishMsOf(s));
      const a0 = ms(s.actualStartAt), a1 = s.status === "completed" ? ms(s.actualAt) : NaN;
      if (Number.isFinite(a0)) actStart = Math.min(actStart, a0);
      if (Number.isFinite(a1)) actFinish = Math.max(actFinish, a1);
    }
    const all = done === steps.length;
    const crews = [...new Set(steps.map((s) => s.responsibleParty?.trim()).filter((c): c is string => !!c))].sort();
    const added = (["discovery", "added"] as const).map((kind) => {
      const xs = steps.filter((s) => { const d = discoveryOf(s); return d && kindOf(d) === kind; });
      return { kind, n: xs.length, h: Math.round(xs.reduce((a, s) => a + (s.durationHours != null && s.durationHours > 0 ? s.durationHours : workHours(s, tz)), 0) * 10) / 10 };
    }).filter((x) => x.n > 0);
    out.push({
      key, wo: g.wo, owner: g.owner, ...(g.also?.length ? { also: g.also } : {}), steps, crews,
      planStart, planFinish, actStart, actFinish: all ? actFinish : NaN,
      pct: Math.round(pSum / wSum), plan: Math.round(planSum / wSum), hours: Math.round(hours * 10) / 10,
      standing: all ? "done" : held ? "held" : started ? "in_progress" : "not_started", done,
      added,
      find: [g.wo, g.owner.name, ...(g.also ?? []).map((x) => x.name), ...crews, ...steps.flatMap((s) => [s.name, s.description, woOf(s), discoveryText(s)]), ...added.map((x) => ADDED[x.kind].lower)].filter(Boolean).join(" ").toLowerCase(),
    });
  }
  return out.sort((a, b) => a.planStart - b.planStart || (a.wo ?? "~").localeCompare(b.wo ?? "~"));
}

/** Which work orders a filter keeps. */
export function showsOrder(o: WorkOrder, show: Show, marks?: PathMarks): boolean {
  switch (show) {
    case "open": return o.standing !== "done";
    case "critical": return o.standing !== "done" && o.steps.some((s) => !!s.id && !!marks?.ids.has(s.id));
    case "behind": return o.standing !== "done" && o.hours <= -0.5;
    case "notStarted": return o.standing === "not_started";
    case "held": return o.standing === "held";
    case "done": return o.standing === "done";
    case "added": return o.added.length > 0;
    default: return true;
  }
}

/** The work orders a search finds (every word somewhere on the card). */
export function findOrders(orders: WorkOrder[], query: string): WorkOrder[] {
  // V-1 is V-01; a typo still finds it; the best matches first (lib/fuzzySearch).
  return searchFilter(orders, query, (o) => o.find);
}

/** The work order report, ready to print: each work order opened up with
 *  all its steps (plan, actual, status, %, the latest comment; with
 *  history, every start, % update, hold and comment). */
export async function workOrdersPrintDocument(o: {
  shown: WorkOrder[]; milestones: Milestone[]; projectId?: string; projectName?: string;
  tz: string; times: ShiftTimes; progress?: Map<string, ProgressInfo>;
  format: PrintFormat; scope: string; lh: Letterhead | null;
  /** What kind of project it is, in a sentence ("turnaround"; lib/projectType). */
  word?: string;
}): Promise<string> {
  const { shown, milestones, projectId, tz, times, progress, format } = o;
  const history = format === "history";
  const ids = shown.flatMap((x) => x.steps.map((s) => s.id)).filter((id): id is string => !!id);
  const notes = await notesFor(ids);
  const latest = new Map<string, { at: number; text: string }>();
  // Only a comment typed with the step's last change, or after it: a
  // finished step doesn't carry the comment from an earlier update.
  const doneAt = new Map(milestones.filter((m) => m.id && m.status === "completed" && m.actualAt).map((m) => [m.id!, Date.parse(String(m.actualAt))]));
  for (const n of notes) {
    const text = n.body?.trim();
    // What people wrote: comments, why it's behind, and hold / block
    // reasons — not the app's own status lines ("Progress → 67%").
    const said = n.kind === "note" || n.kind === "field" || n.kind === "behind"
      || (n.kind === "status" && (n.statusAt === "on_hold" || n.statusAt === "blocked"));
    if (!text || !said) continue;
    const at = noteAt(n), cur = latest.get(n.milestoneId);
    if (Number.isFinite(at) && saidWithLatest(at, doneAt.get(n.milestoneId)) && (!cur || at >= cur.at)) latest.set(n.milestoneId, { at, text });
  }
  const hist = new Map<string, TimeLogRow[]>();
  if (history && projectId) {
    const log = await loadProgressLog(projectId);
    for (const r of buildTimeLog({ milestones, log: log ?? [], notes, tz, times, word: o.word })) {
      if (!r.id) continue;
      const list = hist.get(r.id);
      if (list) list.push(r); else hist.set(r.id, [r]);
    }
  }
  const pctOf = (m: Milestone) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
  const orders: PrintOrder[] = shown.map((w) => ({
    wo: w.wo, name: w.owner.name, desc: descOf(w.owner), crews: w.crews,
    standing: STANDING[w.standing].word, pct: w.pct, plan: w.plan, hours: w.hours,
    planStart: w.planStart, planFinish: w.planFinish, actStart: w.actStart, actFinish: w.actFinish,
    added: w.added.map((x) => `${x.n} ${ADDED[x.kind].lower} step${x.n === 1 ? "" : "s"} (${x.h} h)`),
    done: w.done,
    steps: w.steps.map((s) => {
      const d = discoveryOf(s);
      return {
        id: s.id ?? "", name: s.name, crew: s.responsibleParty?.trim() ?? "",
        planStart: startMsOf(s), planFinish: finishMsOf(s),
        actStart: ms(s.actualStartAt), actFinish: s.status === "completed" ? ms(s.actualAt) : NaN,
        status: STEP_STATUS[s.status] ?? s.status, done: s.status === "completed", pct: Math.round(pctOf(s)),
        added: d ? ADDED[kindOf(d)].word : undefined,
        latest: s.id ? latest.get(s.id) ?? null : null,
        history: s.id ? hist.get(s.id) : undefined,
      };
    }),
  }));
  const project = o.projectName?.trim() || "Schedule";
  const body = workOrdersHtml({ project, scope: o.scope, tz, orders, format });
  const title = `${project} - Work orders`;
  return o.lh ? letterheadDocument(o.lh, title, body, PRINT_CSS)
    : `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title><style>@page{size:landscape;margin:10mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}${PRINT_CSS}</style></head><body>${body}</body></html>`;
}
