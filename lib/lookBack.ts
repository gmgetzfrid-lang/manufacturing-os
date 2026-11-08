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
import { discoveryOf, kindOf, ADDED, type Discovery, type AddedKind } from "@/lib/discovery";
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
  /** The work before it (its link) whose finish let it start, when that
   *  held it up an hour or more. */
  waitedOn?: string;
  /** On hold / blocked: hours, and why. */
  holdH: number;
  holds: Array<{ reason: string; hours: number }>;
  /** Each hold, when: from going on hold to coming off it. */
  holdSpans: Array<{ reason: string; from: number; to: number }>;
  /** Its own late start, the window it waited in: from when it could have
   *  started (its plan, or the work before it) to when it did. */
  waitFrom: number;
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
  /** What kind of project it is, in a sentence ("turnaround"; lib/projectType). */
  word?: string;
}): LookBack {
  const { milestones, notes, now, tz } = input;
  const word = input.word ?? "turnaround";
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
      // It started before this let it (the work went in another order, as
      // when a find changes the sequence): this didn't hold it up.
      if (t > me.as + 30 * 60_000) continue;
      if (t > best) { best = t; by = p.id; }
    }
    return { at: best, by };
  };

  // Other work on the same equipment (the same task above it), for a wait
  // its links don't explain: work under way on it the whole time held it up.
  const siblings = new Map<string, Milestone[]>();
  for (const m of leaves) if (m.parentId) siblings.set(m.parentId, [...(siblings.get(m.parentId) ?? []), m]);
  const sameWork = (m: Milestone, from: number, to: number): { id: string; covered: number } | null => {
    if (to - from < ON_PLAN_H * H || !m.parentId) return null;
    let best: { id: string; covered: number } | null = null;
    const myWo = woOf(m) || parentWo(m);
    for (const o of siblings.get(m.parentId) ?? []) {
      if (o.id === m.id) continue;
      // A folder of separate jobs isn't one piece of equipment: the same work order only.
      if ((woOf(o) || parentWo(o)) !== myWo) continue;
      const q = at.get(o.id!);
      if (!q) continue;
      const covered = Math.max(0, Math.min(q.af, to) - Math.max(q.as, from));
      if (covered >= 0.75 * (to - from) && (!best || covered > best.covered)) best = { id: o.id!, covered };
    }
    return best;
  };

  const steps: StepLook[] = [];
  for (const m of leaves) {
    const t = at.get(m.id!);
    if (!t) continue;
    const mine = notesBy.get(m.id!) ?? [];
    const startH = (t.as - t.bs) / H, finishH = (t.af - t.bf) / H;
    const overrunH = ((t.af - t.as) - (t.bf - t.bs)) / H;
    const { at: allowed, by: linkedBy } = allowedAt(m.id!);
    let inheritedH = Math.max(0, Math.min(Math.max(0, startH), (allowed - t.bs) / H));
    let allowedBy = linkedBy;
    // The rest of its wait, if work on the same equipment was under way all through it.
    const waitStart = Math.max(t.bs, Number.isFinite(allowed) ? allowed : t.bs);
    const same = startH > 0 ? sameWork(m, waitStart, t.as) : null;
    if (same) {
      inheritedH = Math.min(Math.max(0, startH), inheritedH + same.covered / H);
      if (!allowedBy || same.covered / H >= inheritedH / 2) allowedBy = same.id;
    }
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
      ...(allowedBy && inheritedH >= ON_PLAN_H ? { waitedOn: allowedBy } : {}),
      holdH: r1([...holdTotal.values()].reduce((a, h) => a + h, 0)), holds: [...holdTotal].map(([reason, h]) => ({ reason, hours: r1(h) })),
      holdSpans: holds.map((h) => ({ reason: h.reason, from: h.from, to: h.to })),
      waitFrom: waitStart,
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
    improve.push(`“${g.g[0].name}” ran long on ${g.over.length} of ${g.g.length} (${g.avg > 0 ? "+" : ""}${g.avg} h on average) - plan more time for it next ${word}.`);
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
  if (finish.done && finish.slipH <= ON_PLAN_H) keep.push(`The ${word} finished ${finish.slipH < -ON_PLAN_H ? `${-finish.slipH} h ahead of` : "on"} plan.`);

  return { finish, steps, setbacks, byCause, chain, ahead, quicker, absorbed, crews, improve, keep };
}

/** Why a step lost time, in words, from what was recorded on it: its holds
 *  and the reason given, running long, a late start nothing recorded
 *  explains, a re-plan, what was found, what people said. The close-out
 *  report and the Close-out tab say it the same way. */
export function lostWords(s: StepLook, hrs: (h: number) => string = (h) => `${r1(h)} h`): string[] {
  const out: string[] = [];
  const said = s.holds.filter((h) => h.reason);
  if (s.lost.hold) out.push(said.length ? said.map((h) => `On hold${h.hours > 0 ? ` ${hrs(h.hours)}` : " now"} - \u201c${h.reason}\u201d`).join("; ") : `On hold / blocked ${hrs(s.lost.hold)}`);
  else if (said.length) out.push(`Put on hold - \u201c${said[said.length - 1].reason}\u201d`);
  if (s.lost.longer) out.push(`Ran ${hrs(s.lost.longer)} longer than planned`);
  if (s.lost["late-start"]) out.push(`Started ${hrs(s.lost["late-start"])} late - no hold or earlier work recorded`);
  if (s.lost.replanned) out.push(`Re-planned (${hrs(s.lost.replanned)})${s.replans[0] ? ` - \u201c${s.replans[0]}\u201d` : ""}`);
  if (s.discovery) out.push(`${ADDED[s.addedKind ?? "discovery"].word} - \u201c${s.discovery}\u201d`);
  for (const w of s.why.slice(-2)) out.push(`Said: \u201c${w}\u201d`);
  return out;
}

/** What a step was waiting on, back to where the delay started: the work
 *  before it (by its links) that held it up, then what held that up, and
 *  so on, nearest first. Empty: nothing before it held it up. */
export function waitChain(look: Map<string, StepLook>, id: string, max = 8): StepLook[] {
  const out: StepLook[] = [];
  const seen = new Set<string>([id]);
  for (let cur = look.get(id)?.waitedOn; cur && out.length < max && !seen.has(cur); ) {
    const p = look.get(cur);
    if (!p) break;
    out.push(p);
    seen.add(cur);
    cur = p.waitedOn;
  }
  return out;
}

/** Where a step's delay started: the last link of its wait chain, else itself. */
export const rootOf = (look: Map<string, StepLook>, id: string): StepLook | undefined => {
  const c = waitChain(look, id);
  return c.length ? c[c.length - 1] : look.get(id);
};

/** The root's own reasons, in words: what was found, holds, running long,
 *  a late start nothing explains. Said plainly when nothing was recorded. */
export function rootWords(s: StepLook, hrs: (h: number) => string = (h) => `${r1(h)} h`): string[] {
  const w = lostWords(s, hrs);
  if (w.length) return w;
  return s.finishH >= ON_PLAN_H ? [`Finished ${hrs(s.finishH)} late; nothing recorded on why`] : [];
}

/** What was going on while a step waited to start, when nothing it's
 *  linked to explains the wait: holds on the same equipment (with the
 *  reason given), other work on it, and what its crew was on instead.
 *  Context from the record, not a claimed cause; most overlap first. */
export function whileWaiting(look: Map<string, StepLook>, s: StepLook, max = 3): string[] {
  const from = s.waitFrom, to = s.as;
  if (to - from < ON_PLAN_H * H) return [];
  const overlap = (a: number, b: number) => Math.max(0, Math.min(b, to) - Math.max(a, from));
  const out: Array<{ w: number; text: string; key: string }> = [];
  for (const o of look.values()) {
    if (o.id === s.id) continue;
    const sameTask = !!s.task && o.task === s.task && o.wo === s.wo;
    for (const h of o.holdSpans) {
      const w = overlap(h.from, h.to);
      if (sameTask && w > 0 && h.reason) out.push({ w: w * 3, key: `h${o.id}`, text: `On ${o.task}, ${o.name} was on hold - \u201c${h.reason}\u201d` });
    }
    const w = overlap(o.as, o.af);
    if (w < 0.5 * H) continue;
    const held = o.holdSpans.find((h) => h.reason && overlap(h.from, h.to) > 0);
    const tag = held ? ` (on hold - \u201c${held.reason}\u201d)` : o.discovery ? ` (${ADDED[o.addedKind ?? "discovery"].lower})` : o.overrunH >= ON_PLAN_H ? ` (ran ${r1(o.overrunH)} h long)` : o.holds.some((h) => h.reason && h.hours >= ON_PLAN_H) ? ` (on hold ${r1(o.holdH)} h - \u201c${o.holds.find((h) => h.reason)!.reason}\u201d)` : "";
    if (sameTask) out.push({ w: w * 2, key: `t${o.id}`, text: `On ${o.task}, ${o.name} was under way${tag}` });
    else if (s.crew && o.crew === s.crew) out.push({ w, key: `c${o.id}`, text: `${s.crew} was on ${o.task ? `${o.task} \u203a ` : ""}${o.name}${tag}` });
  }
  const seen = new Set<string>();
  return out.sort((a, b) => b.w - a.w).filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true))).slice(0, max).map((x) => x.text);
}

/** Has time of its own lost (held, ran long, started late with nothing
 *  before it to blame, re-planned) or is added work. */
export const ownCause = (s: StepLook) => !!s.discovery || s.lostH >= ON_PLAN_H;

/** What set the finish: the last step done, back through what each waited
 *  on; earliest first. */
export function finishChain(lb: LookBack): StepLook[] {
  const look = new Map(lb.steps.map((s) => [s.id, s]));
  const last = lb.steps.reduce<StepLook | null>((a, s) => (!a || s.af > a.af ? s : a), null);
  return last ? [last, ...waitChain(look, last.id)].reverse() : [];
}

/** Where a late step's delay came from: along what it waited on, the
 *  furthest step with time of its own lost; itself when nothing before it
 *  held it up. */
export function causeOf(look: Map<string, StepLook>, id: string): StepLook | undefined {
  const chain = [look.get(id), ...waitChain(look, id)].filter((x): x is StepLook => !!x);
  for (let i = chain.length - 1; i >= 0; i--) if (ownCause(chain[i])) return chain[i];
  return chain[chain.length - 1];
}
