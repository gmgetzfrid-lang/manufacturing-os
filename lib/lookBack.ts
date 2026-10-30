// lookBack — the close-out's look back: where the time went and why, the
// chain of events that set the finish, what went well, and where to do
// better next time.
//
// Measured against the baseline (the plan as signed off; a step added
// after it is measured against its own plan), with times as entered.
// Work not finished yet counts at its forecast (lib/cpm), so the look back
// can be read before the job is done.
//
// A step's lost time is what it lost ON ITS OWN — a late start the work
// before it doesn't explain, plus running long — split by cause: on hold
// or blocked (its status history and the reason given), re-planned (a
// decision, with its reason), started late with nothing holding it, took
// longer than planned, discovery work. Time passed on from the work before
// it isn't counted again; the chain of events shows how it travelled.
// Pure.

import type { Milestone, MilestoneNote } from "@/types/schema";
import { computeCpm, linkGraph } from "@/lib/cpm";
import { earliestStart } from "@/lib/scheduleLinks";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { discoveryOf, kindOf, type Discovery, type AddedKind } from "@/lib/discovery";
import { woOf } from "@/lib/workOrderCrew";

const H = 3_600_000;
/** Within this of the plan counts as on plan — times are as entered. */
export const ON_PLAN_H = 1;
const r1 = (h: number) => Math.round(h * 10) / 10;
const ms = (v: unknown): number => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

export type Cause = "hold" | "replanned" | "late-start" | "longer" | "discovery";
export const CAUSE_LABEL: Record<Cause, string> = {
  hold: "On hold / blocked",
  replanned: "Re-planned",
  "late-start": "Started late - no hold or earlier work recorded",
  longer: "Took longer than planned",
  discovery: "Discovery & added scope",
};
const CAUSES: Cause[] = ["hold", "longer", "late-start", "replanned", "discovery"];

export interface StepLook {
  id: string;
  name: string;
  /** The task (equipment) it's under. */
  task: string;
  wo: string;
  crew: string;
  /** Baseline (else planned) start / finish. */
  bs: number; bf: number;
  /** Actual start / finish — or the forecast, not done yet. */
  as: number; af: number;
  done: boolean;
  /** Hours late (+) or early (−): finish and start against the plan; how
   *  much longer (+) or shorter it ran. */
  finishH: number; startH: number; overrunH: number;
  /** Of its late start, the hours the work before it finished late. */
  inheritedH: number;
  /** On hold / blocked: hours, and why. */
  holdH: number;
  holds: Array<{ reason: string; hours: number }>;
  /** "Why it's behind", as people said it. */
  why: string[];
  /** Re-planned — the reason given. */
  replans: string[];
  /** Discovery work: what was found. */
  discovery?: string;
  /** Discovery or added scope (lib/discovery). */
  addedKind?: AddedKind;
  /** Hours it lost on its own, by cause. */
  lost: Partial<Record<Cause, number>>;
  lostH: number;
}

export interface ChainLink {
  step: StepLook;
  /** The finish's slip after this step (hours, + late). */
  slipH: number;
  /** What this step added to it (− made time up). */
  addedH: number;
}

export interface LookBack {
  /** The turnaround: baseline finish, actual (or forecast) finish. */
  finish: { baseline: number; actual: number; slipH: number; done: boolean };
  steps: StepLook[];
  /** Steps that lost the most time on their own, worst first. */
  setbacks: StepLook[];
  /** Hours lost on their own, by cause, across every step (work-hours —
   *  steps run side by side, so this isn't the finish's slip). */
  byCause: Array<{ cause: Cause; hours: number; steps: number }>;
  /** The chain of work that set the finish, first to last. */
  chain: ChainLink[];
  /** Done ahead of plan, most first. */
  ahead: StepLook[];
  /** Ran shorter than planned, most first. */
  quicker: StepLook[];
  /** Discovery that fit in the float — found, done, finish unmoved. */
  absorbed: Discovery[];
  /** Each crew: steps done, on plan, hours lost on its own. */
  crews: Array<{ crew: string; done: number; onPlan: number; lostH: number }>;
  /** Plain-language takeaways from the record. */
  improve: string[];
  /** Plain-language keep-doing points from the record. */
  keep: string[];
}

const HOLD = new Set(["on_hold", "blocked"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Each step's holds from its status history: from going on hold or
 *  blocked to coming off it (or `end`), with the reason given. */
function holdsOf(notes: MilestoneNote[], end: number, current?: { status: string; reason?: string | null }): Array<{ reason: string; from: number; to: number }> {
  const seq = notes.filter((n) => n.kind === "status" && n.statusAt).map((n) => ({ at: ms(n.happenedAt ?? n.createdAt), st: n.statusAt as string, body: n.body?.trim() ?? "" }))
    .filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);
  const out: Array<{ reason: string; from: number; to: number }> = [];
  let open: { reason: string; from: number } | null = null;
  for (const x of seq) {
    if (HOLD.has(x.st)) { if (!open) open = { reason: x.body, from: x.at }; else if (!open.reason && x.body) open.reason = x.body; }
    else if (open) { out.push({ ...open, to: x.at }); open = null; }
  }
  if (open) out.push({ ...open, reason: open.reason || current?.reason?.trim() || "", to: Math.max(open.from, end) });
  return out;
}

export function buildLookBack(input: {
  milestones: Milestone[];
  notes: MilestoneNote[];
  discoveries?: Discovery[];
  now: number;
  tz: string;
}): LookBack {
  const { milestones, notes, now, tz } = input;
  const { byId, leaves, preds } = linkGraph(milestones);
  const cpm = computeCpm(milestones, { now, tz });
  const notesBy = new Map<string, MilestoneNote[]>();
  for (const n of notes) notesBy.set(n.milestoneId, [...(notesBy.get(n.milestoneId) ?? []), n]);
  const parentWo = (m: Milestone) => { for (let p = m.parentId ? byId.get(m.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) { const w = woOf(p); if (w) return w; } return ""; };

  // Where each step was meant to be, and where it really was (or will be).
  const at = new Map<string, { bs: number; bf: number; as: number; af: number; done: boolean }>();
  for (const m of leaves) {
    const bs0 = ms(m.baselineStartAt), bf0 = ms(m.baselineFinishAt);
    const bs = Number.isFinite(bs0) ? bs0 : startMsOf(m), bf = Number.isFinite(bf0) ? bf0 : finishMsOf(m);
    const c = cpm.steps.get(m.id!);
    const done = m.status === "completed";
    const as = Number.isFinite(ms(m.actualStartAt)) ? ms(m.actualStartAt) : c?.es ?? NaN;
    const af = done && Number.isFinite(ms(m.actualAt)) ? ms(m.actualAt) : c?.ef ?? NaN;
    if (!Number.isFinite(bs) || !Number.isFinite(bf) || !Number.isFinite(as) || !Number.isFinite(af)) continue;
    at.set(m.id!, { bs, bf, as: Math.min(as, af), af, done });
  }
  // When the work before a step let it start (its links).
  const allowedAt = (id: string): { at: number; by: string | null } => {
    const me = at.get(id)!;
    let best = -Infinity, by: string | null = null;
    for (const p of preds.get(id) ?? []) {
      const q = at.get(p.id);
      if (!q) continue;
      const t = earliestStart(p.link, { start: q.as, end: q.af }, me.af - me.as);
      if (t > best) { best = t; by = p.id; }
    }
    return { at: best, by };
  };

  const steps: StepLook[] = [];
  for (const m of leaves) {
    const t = at.get(m.id!);
    if (!t) continue;
    const mine = notesBy.get(m.id!) ?? [];
    const startH = (t.as - t.bs) / H, finishH = (t.af - t.bf) / H;
    const overrunH = ((t.af - t.as) - (t.bf - t.bs)) / H;
    const allowed = allowedAt(m.id!).at;
    const inheritedH = Math.max(0, Math.min(Math.max(0, startH), (allowed - t.bs) / H));
    const holds = holdsOf(mine, t.done ? t.af : now, { status: m.status, reason: m.statusReason });
    // Held before it started counts against its start; while under way,
    // against its run.
    let holdStart = 0, holdRun = 0;
    for (const h of holds) {
      holdStart += Math.max(0, Math.min(h.to, t.as) - Math.max(h.from, t.bs)) / H;
      holdRun += Math.max(0, Math.min(h.to, t.af) - Math.max(h.from, t.as)) / H;
    }
    const why = mine.filter((n) => n.kind === "behind" && n.body?.trim()).map((n) => n.body!.trim());
    const replans = mine.filter((n) => n.kind === "reschedule" && /^Re-planned/.test(n.body ?? "")).map((n) => n.body!.replace(/^Re-planned to .*?(?: [-—] .*? done first)? [-—] /, "").trim());
    const disc = discoveryOf(m);
    const lost: Partial<Record<Cause, number>> = {};
    const add = (c: Cause, h: number) => { if (h > 0.05) lost[c] = r1((lost[c] ?? 0) + h); };
    if (disc) add("discovery", (t.af - t.as) / H);
    else {
      // What it lost on its own can't be more than it finished late less
      // what it was handed: started early and ran long, it lost nothing.
      let left = Math.max(0, finishH - inheritedH);
      const take = (c: Cause, h: number) => { const x = Math.min(left, Math.max(0, h)); add(c, x); left -= x; };
      const ownStart = Math.max(0, startH - inheritedH);
      const run = Math.max(0, overrunH);
      // Still on hold with no history of it: its slip is the hold's.
      const heldNow = HOLD.has(m.status) && holds.length === 0;
      const hs = heldNow ? ownStart : Math.min(ownStart, holdStart), hr = heldNow ? run : Math.min(run, holdRun);
      take("hold", hs + hr);
      take("longer", run - hr);
      take(replans.length ? "replanned" : "late-start", ownStart - hs);
    }
    // Under an hour isn't counted — times are as entered.
    for (const c of CAUSES) if ((lost[c] ?? 0) < ON_PLAN_H && c !== "discovery") delete lost[c];
    const lostH = r1(CAUSES.reduce((a, c) => a + (lost[c] ?? 0), 0));
    const parent = m.parentId ? byId.get(m.parentId) : undefined;
    const holdTotal = new Map<string, number>();
    for (const h of holds) holdTotal.set(h.reason, (holdTotal.get(h.reason) ?? 0) + (h.to - h.from) / H);
    // On hold now, from before the history was kept: the reason, hours not known.
    if (HOLD.has(m.status) && holds.length === 0 && m.statusReason?.trim()) holdTotal.set(m.statusReason.trim(), 0);
    steps.push({
      id: m.id!, name: m.name, task: parent?.name ?? "", wo: woOf(m) || parentWo(m), crew: m.responsibleParty?.trim() ?? "",
      bs: t.bs, bf: t.bf, as: t.as, af: t.af, done: t.done,
      finishH: r1(finishH), startH: r1(startH), overrunH: r1(overrunH), inheritedH: r1(inheritedH),
      holdH: r1([...holdTotal.values()].reduce((a, h) => a + h, 0)), holds: [...holdTotal].map(([reason, h]) => ({ reason, hours: r1(h) })),
      why, replans, ...(disc ? { discovery: disc.what, addedKind: kindOf(disc) } : {}), lost, lostH,
    });
  }
  const look = new Map(steps.map((s) => [s.id, s]));

  // The finish: the plan's last finish, and where the work landed it.
  const finishB = Math.max(...steps.map((s) => s.bf)), finishA = Math.max(...steps.map((s) => s.af));
  const finish = { baseline: finishB, actual: finishA, slipH: r1((finishA - finishB) / H), done: steps.every((s) => s.done) };

  // The chain of events: from the step that finished last, back through
  // the work whose finish let each one start — first to last.
  const chainIds: string[] = [];
  const last = steps.reduce<StepLook | null>((a, s) => (!a || s.af > a.af || (s.af === a.af && s.bf > a.bf) ? s : a), null);
  for (let cur = last?.id ?? null, g = 0; cur && g < 200 && !chainIds.includes(cur); g++) {
    chainIds.push(cur);
    const { at: allowed, by } = allowedAt(cur);
    cur = by && allowed >= at.get(cur)!.as - 30 * 60_000 ? by : null;
  }
  chainIds.reverse();
  const chain: ChainLink[] = chainIds.map((id, i) => {
    const s = look.get(id)!;
    const prev = i > 0 ? look.get(chainIds[i - 1])!.finishH : 0;
    return { step: s, slipH: s.finishH, addedH: r1(s.finishH - (i > 0 ? prev : 0)) };
  });

  const byCause = CAUSES.map((cause) => ({ cause, hours: r1(steps.reduce((a, s) => a + (s.lost[cause] ?? 0), 0)), steps: steps.filter((s) => (s.lost[cause] ?? 0) > 0).length }))
    .filter((x) => x.hours > 0).sort((a, b) => b.hours - a.hours);
  const setbacks = steps.filter((s) => s.lostH >= ON_PLAN_H).sort((a, b) => b.lostH - a.lostH);
  const ahead = steps.filter((s) => s.done && s.finishH <= -ON_PLAN_H && !s.discovery).sort((a, b) => a.finishH - b.finishH);
  const quicker = steps.filter((s) => s.done && s.overrunH <= -ON_PLAN_H && !s.discovery).sort((a, b) => a.overrunH - b.overrunH);
  const absorbed = (input.discoveries ?? []).filter((d) => d.record.impact.finish[1] - d.record.impact.finish[0] <= 6 * 60_000);

  const crewMap = new Map<string, { crew: string; done: number; onPlan: number; lostH: number }>();
  for (const s of steps) {
    if (!s.crew) continue;
    const c = crewMap.get(s.crew) ?? { crew: s.crew, done: 0, onPlan: 0, lostH: 0 };
    if (s.done && !s.discovery) { c.done++; if (s.finishH <= ON_PLAN_H) c.onPlan++; }
    c.lostH = r1(c.lostH + s.lostH - (s.lost.discovery ?? 0));
    crewMap.set(s.crew, c);
  }
  const crews = [...crewMap.values()].filter((c) => c.done > 0).sort((a, b) => b.done - a.done);

  // ── Takeaways: what repeats, said plainly.
  const improve: string[] = [], keep: string[] = [];
  // The same step on several pieces of equipment, running long (or short)
  // most times: plan it differently next time.
  const byName = new Map<string, StepLook[]>();
  for (const s of steps) if (s.done && !s.discovery) byName.set(norm(s.name), [...(byName.get(norm(s.name)) ?? []), s]);
  const repeats = [...byName.values()].filter((g) => g.length >= 2);
  for (const g of repeats.map((g) => ({ g, over: g.filter((s) => s.overrunH >= ON_PLAN_H), avg: r1(g.reduce((a, s) => a + s.overrunH, 0) / g.length) })).filter((x) => x.over.length * 2 >= x.g.length && x.avg >= 2).sort((a, b) => b.avg - a.avg).slice(0, 4)) {
    improve.push(`“${g.g[0].name}” ran long on ${g.over.length} of ${g.g.length} (${g.avg > 0 ? "+" : ""}${g.avg} h on average) - plan more time for it next turnaround.`);
  }
  for (const g of repeats.map((g) => ({ g, under: g.filter((s) => s.overrunH <= -ON_PLAN_H), avg: r1(g.reduce((a, s) => a + s.overrunH, 0) / g.length) })).filter((x) => x.under.length * 2 >= x.g.length && x.avg <= -2).sort((a, b) => a.avg - b.avg).slice(0, 3)) {
    keep.push(`“${g.g[0].name}” took less than planned on ${g.under.length} of ${g.g.length} (${g.avg} h on average) - it can be planned tighter.`);
  }
  // Holds for the same reason, again and again.
  const holdBy = new Map<string, { reason: string; hours: number; n: number }>();
  for (const s of steps) for (const h of s.holds) { if (!h.reason) continue; const k = norm(h.reason); const x = holdBy.get(k) ?? { reason: h.reason, hours: 0, n: 0 }; x.hours = r1(x.hours + h.hours); x.n++; holdBy.set(k, x); }
  for (const x of [...holdBy.values()].sort((a, b) => b.hours - a.hours).slice(0, 3)) if (x.hours >= ON_PLAN_H) improve.push(`On hold ${x.n === 1 ? "once" : `${x.n} times`} for “${x.reason}” - ${x.hours} h in all.`);
  // Late starts with nothing holding them, by crew.
  const lateBy = new Map<string, { h: number; n: number }>();
  for (const s of steps) if ((s.lost["late-start"] ?? 0) > 0 && s.crew) { const x = lateBy.get(s.crew) ?? { h: 0, n: 0 }; x.h = r1(x.h + s.lost["late-start"]!); x.n++; lateBy.set(s.crew, x); }
  for (const [crew, x] of [...lateBy].sort((a, b) => b[1].h - a[1].h).slice(0, 2)) if (x.n >= 2 && x.h >= 4) improve.push(`${crew} started ${x.n} steps late with no hold or earlier work recorded to explain it (${x.h} h) - check crew availability and hand-offs, or put the reason on the steps.`);
  // What set the finish.
  const drove = new Map<string, number>();
  for (const l of chain) if (l.addedH > 0) drove.set(l.step.task || l.step.name, r1((drove.get(l.step.task || l.step.name) ?? 0) + l.addedH));
  const top = [...drove].sort((a, b) => b[1] - a[1])[0];
  if (top && finish.slipH >= ON_PLAN_H) improve.push(`The finish ${finish.done ? "slipped" : "is forecast to slip"} ${finish.slipH} h; it traces back to ${top[0]}, which lost ${top[1]} h on the chain into the finish.`);
  const disc = input.discoveries ?? [];
  if (disc.length) {
    const hrs = r1(disc.reduce((a, d) => a + d.record.impact.hours, 0));
    const moved = disc.filter((d) => d.record.impact.finish[1] - d.record.impact.finish[0] > 6 * 60_000).length;
    (moved ? improve : keep).push(`Discovery added ${hrs} h of work (${disc.length} found)${moved ? ` - ${moved} moved the finish` : " - all of it fit in the float"}.`);
  }
  if (ahead.length) keep.push(`${ahead.length} step${ahead.length === 1 ? "" : "s"} finished ahead of plan${ahead.length > 1 ? ` (up to ${-ahead[0].finishH} h early)` : ` (${-ahead[0].finishH} h early)`}.`);
  for (const c of crews.filter((c) => c.done >= 3 && c.onPlan === c.done).slice(0, 3)) keep.push(`${c.crew} finished all ${c.done} of their steps on plan.`);
  if (finish.done && finish.slipH <= ON_PLAN_H) keep.push(`The turnaround finished ${finish.slipH < -ON_PLAN_H ? `${-finish.slipH} h ahead of` : "on"} plan.`);

  return { finish, steps, setbacks, byCause, chain, ahead, quicker, absorbed, crews, improve, keep };
}
