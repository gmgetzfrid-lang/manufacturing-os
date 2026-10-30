// Why the job is behind: each step's hours behind plan traced back through
// what it waits on to the thing actually holding it up — added scope (the
// planner's call), discovery (found work), a hold, or the work itself
// running late or slow with nothing in its way.
//
// A step that can't start because the step before it isn't done is behind
// because of that step: its hours go with the step at the head of the
// chain. A head that started late because what it waited on finished late
// carries that delay's cause for the share of its slip it explains (the
// rest is its own).

import type { Milestone } from "@/types/schema";
import type { GapDriver } from "@/lib/shiftReport";
import { discoveryOf, kindOf } from "@/lib/discovery";
import type { ExportBlock, Tone } from "@/lib/reportExport";

const H = 3_600_000;

export type BehindCause = "added" | "discovery" | "held" | "own";

export const CAUSE_WORD: Record<BehindCause, { word: string; short: string }> = {
  added: { word: "Added scope (your call)", short: "added scope" },
  discovery: { word: "Discovery (found work)", short: "discovery" },
  held: { word: "On hold / blocked", short: "on hold" },
  own: { word: "Late or slow - nothing in the way", short: "late or slow" },
};
export const CAUSE_ORDER: BehindCause[] = ["discovery", "added", "held", "own"];

export interface BehindChain {
  /** The step holding the chain up — working, waiting to start, or held. */
  head: { id: string; name: string; parentName: string | null; percent: number; status: string; started: number | null; planStart: number | null; reason: string | null; added: BehindCause | null };
  /** The cause with the most hours in this chain. */
  cause: BehindCause;
  hours: number;
  split: Partial<Record<BehindCause, number>>;
  /** The behind steps in it (the head first when it's one), hours each. */
  steps: Array<{ id: string; name: string; hours: number }>;
  /** What the head waited for: the step it couldn't start before, when that
   *  finished, how long after the head's planned start — and, when that step
   *  was itself held up, what held it up. */
  pushed?: { by: string; byCause: BehindCause; ready: number; lateH: number; root?: { name: string; cause: BehindCause } };
}

export interface BehindWhy {
  /** Hours of work behind, all steps (adds up to the chains). */
  total: number;
  /** Hours of work ahead elsewhere: total − ahead = the gap. */
  ahead: number;
  byCause: Record<BehindCause, number>;
  chains: BehindChain[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const ms = (v: unknown): number => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

export function behindWhy(input: {
  behind: GapDriver[];
  ahead: number;
  milestones: Milestone[];
  now: number;
  /** The % the report uses (its live progress), else the step's own. */
  pctOf?: (m: Milestone) => number;
}): BehindWhy {
  const { now } = input;
  const live = input.milestones.filter((m) => m.id && !m.cancelledAt);
  const byId = new Map(live.map((m) => [m.id!, m]));
  const kids = new Map<string, Milestone[]>();
  for (const m of live) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
  const leavesUnder = (m: Milestone, seen = new Set<string>()): Milestone[] => {
    if (seen.has(m.id!)) return [];
    seen.add(m.id!);
    const k = kids.get(m.id!);
    return k?.length ? k.flatMap((c) => leavesUnder(c, seen)) : [m];
  };
  // A link to a whole task waits on all of its steps.
  const preds = (m: Milestone): Milestone[] =>
    (m.dependsOn ?? []).map((id) => byId.get(id)).filter((p): p is Milestone => !!p && p.id !== m.id).flatMap((p) => leavesUnder(p));
  const pct = (m: Milestone) => input.pctOf?.(m) ?? (m.status === "completed" ? 100 : Number(m.percentComplete ?? 0));
  const done = (m: Milestone) => m.status === "completed" || pct(m) >= 100;
  const held = (m: Milestone) => m.status === "on_hold" || m.status === "blocked";
  const started = (m: Milestone) => done(m) || m.status === "in_progress" || held(m) || pct(m) > 0 || Number.isFinite(ms(m.actualStartAt));
  // The plan it's measured against: the baseline when there is one.
  const planStart = (m: Milestone) => { const b = ms(m.baselineStartAt ?? m.baselineFinishAt); return Number.isFinite(b) ? b : ms(m.plannedStartAt ?? m.plannedAt); };
  const planFinish = (m: Milestone) => { const b = ms(m.baselineFinishAt); return Number.isFinite(b) ? b : ms(m.plannedAt); };
  const hoursOf = (m: Milestone) => {
    const d = Number(m.durationHours);
    if (Number.isFinite(d) && d > 0) return d;
    const s = planStart(m), f = planFinish(m);
    return Number.isFinite(s) && Number.isFinite(f) && f > s ? (f - s) / H : 0;
  };
  const doneAt = (m: Milestone) => { const a = ms(m.actualAt); return Number.isFinite(a) ? a : planFinish(m); };
  // When it should be done at the pace planned from here (held: never).
  const forecast = (m: Milestone): number => (done(m) ? doneAt(m) : held(m) ? Infinity
    : started(m) ? now + hoursOf(m) * (1 - pct(m) / 100) * H : now + hoursOf(m) * H);
  const ownCause = (m: Milestone): BehindCause | null => {
    const d = discoveryOf(m);
    if (d) return kindOf(d) === "added" ? "added" : "discovery";
    return held(m) ? "held" : null;
  };
  // The finished step it waited for last.
  const gateOf = (m: Milestone): Milestone | null => {
    let g: Milestone | null = null;
    for (const p of preds(m)) if (done(p) && Number.isFinite(doneAt(p)) && (!g || doneAt(p) > doneAt(g))) g = p;
    return g;
  };
  // Why a finished step was late: found or added work, else what it waited
  // on when that explains most of its slip, else itself.
  const rootOf = (p: Milestone, seen = new Set<string>()): { m: Milestone; cause: BehindCause } => {
    const c = ownCause(p);
    if (c) return { m: p, cause: c };
    if (seen.has(p.id!)) return { m: p, cause: "own" };
    seen.add(p.id!);
    const g = gateOf(p);
    const push = g ? (doneAt(g) - planStart(p)) / H : 0;
    const slip = (doneAt(p) - planFinish(p)) / H;
    return g && push >= 0.5 && push >= slip - push ? rootOf(g, seen) : { m: p, cause: "own" };
  };
  // The step holding a waiting step up: through steps that haven't started
  // and are waiting themselves, to the one that will finish last.
  const headOf = (s: Milestone): Milestone => {
    let cur = s;
    const seen = new Set<string>([s.id!]);
    for (;;) {
      if (started(cur) || held(cur)) return cur;
      const open = preds(cur).filter((p) => !done(p) && !seen.has(p.id!));
      if (!open.length) return cur;
      cur = open.reduce((a, b) => (forecast(b) > forecast(a) ? b : a));
      seen.add(cur.id!);
    }
  };

  // Per head: its chain, and the share of its slip its late start explains.
  const chains = new Map<string, { ch: BehindChain; base: BehindCause; share: number; pushCause: BehindCause | null }>();
  const byCause: Record<BehindCause, number> = { added: 0, discovery: 0, held: 0, own: 0 };
  let total = 0;
  for (const d of input.behind) {
    if (!(d.hours > 0)) continue;
    total += d.hours;
    const s = d.id ? byId.get(d.id) : undefined;
    const head = s ? headOf(s) : undefined;
    const key = head?.id ?? `name:${d.name}`;
    let w = chains.get(key);
    if (!w) {
      if (!head) {
        w = { ch: { head: { id: d.id ?? key, name: d.name, parentName: d.parentName, percent: d.percent, status: "", started: null, planStart: Number.isFinite(d.start) ? d.start : null, reason: null, added: null }, cause: "own", hours: 0, split: {}, steps: [] }, base: "own", share: 0, pushCause: null };
      } else {
        const parent = head.parentId ? byId.get(head.parentId) : undefined;
        const base: BehindCause = ownCause(head) ?? "own";
        const g = base === "own" ? gateOf(head) : null;
        const lateH = g ? (doneAt(g) - planStart(head)) / H : 0;
        let pushed: BehindChain["pushed"];
        let share = 0, pushCause: BehindCause | null = null;
        if (g && lateH >= 0.5) {
          const root = rootOf(g);
          const slip = (forecast(head) - planFinish(head)) / H;
          share = slip > 0 ? Math.min(1, lateH / slip) : 0;
          pushCause = root.cause;
          pushed = { by: g.name, byCause: ownCause(g) ?? "own", ready: doneAt(g), lateH: r1(lateH), ...(root.m !== g ? { root: { name: root.m.name, cause: root.cause } } : {}) };
        }
        const a = ms(head.actualStartAt);
        w = {
          ch: {
            head: { id: head.id!, name: head.name, parentName: parent?.name ?? null, percent: Math.round(pct(head)), status: head.status,
              started: Number.isFinite(a) ? a : null, planStart: Number.isFinite(planStart(head)) ? planStart(head) : null,
              reason: held(head) ? head.statusReason ?? null : null, added: ownCause(head) === "held" ? null : ownCause(head) },
            cause: base, hours: 0, split: {}, steps: [], ...(pushed ? { pushed } : {}),
          },
          base, share, pushCause,
        };
      }
      chains.set(key, w);
    }
    const viaPush = w.pushCause ? d.hours * w.share : 0;
    if (w.pushCause && viaPush > 0) { w.ch.split[w.pushCause] = (w.ch.split[w.pushCause] ?? 0) + viaPush; byCause[w.pushCause] += viaPush; }
    w.ch.split[w.base] = (w.ch.split[w.base] ?? 0) + d.hours - viaPush; byCause[w.base] += d.hours - viaPush;
    w.ch.hours += d.hours;
    w.ch.steps.push({ id: d.id ?? key, name: d.name, hours: d.hours });
  }
  const out = [...chains.values()].map(({ ch: c }) => {
    const split: BehindChain["split"] = {};
    for (const k of CAUSE_ORDER) if ((c.split[k] ?? 0) >= 0.05) split[k] = r1(c.split[k]!);
    const cause = CAUSE_ORDER.reduce((a, k) => ((c.split[k] ?? 0) > (c.split[a] ?? 0) ? k : a), c.cause);
    // The head first, then the steps waiting on it, biggest first.
    const steps = [...c.steps].sort((a, b) => (a.id === c.head.id ? -1 : b.id === c.head.id ? 1 : b.hours - a.hours)).map((x) => ({ ...x, hours: r1(x.hours) }));
    return { ...c, cause, hours: r1(c.hours), split, steps };
  }).sort((a, b) => b.hours - a.hours);
  return {
    total: r1(total), ahead: r1(input.ahead),
    byCause: { added: r1(byCause.added), discovery: r1(byCause.discovery), held: r1(byCause.held), own: r1(byCause.own) },
    chains: out,
  };
}

/** A chain in words, for the screen and the email alike. */
export function chainText(ch: BehindChain, f: { DTs: (ms: number) => string; hrs: (h: number) => string }): {
  title: string; state: string; facts: string; waiting: string | null; split: string | null;
} {
  const h = (x: number) => f.hrs(r1(x));
  const hd = ch.head;
  const state = hd.status === "on_hold" || hd.status === "blocked" ? (hd.status === "blocked" ? "blocked" : "on hold")
    : hd.percent > 0 || hd.started != null ? `${hd.percent}%` : "not started";
  const facts: string[] = [];
  if (hd.reason) facts.push(`On hold - ${hd.reason}.`);
  if (hd.added) facts.push(`${hd.added === "added" ? "Added scope" : "Discovery work"} - its own work is behind its plan.`);
  if (ch.pushed) {
    const p = ch.pushed;
    facts.push(`Couldn't start until ${p.by}${p.byCause !== "own" ? ` (${CAUSE_WORD[p.byCause].short})` : ""} was done ${f.DTs(p.ready)} - ${h(p.lateH)} after its planned start${p.root ? `; that waited on ${p.root.name} (${CAUSE_WORD[p.root.cause].short})` : ""}.`);
  }
  if (hd.started != null && !hd.reason) {
    const late = hd.planStart != null ? (hd.started - hd.planStart) / H : 0;
    facts.push(ch.pushed || late < 0.5 ? `Started ${f.DTs(hd.started)}.` : `Started ${f.DTs(hd.started)} - ${h(late)} after its planned start, nothing in its way.`);
  } else if (hd.started == null && !hd.reason && !hd.added) {
    facts.push(ch.pushed ? "Not started yet." : "Not started - nothing it waits on is open.");
  }
  const rest = ch.steps.filter((x) => x.id !== hd.id);
  const waiting = rest.length
    ? `Waiting on it: ${rest.slice(0, 4).map((x) => `${x.name} ${h(x.hours)}`).join(" · ")}${rest.length > 4 ? ` + ${rest.length - 4} more` : ""}`
    : null;
  const parts = CAUSE_ORDER.filter((k) => (ch.split[k] ?? 0) >= 0.05);
  const split = parts.length > 1 ? parts.map((k) => `${CAUSE_WORD[k].short} ${h(ch.split[k]!)}`).join(" · ") : null;
  return { title: `${hd.parentName ? `${hd.parentName}: ` : ""}${hd.name}`, state, facts: facts.join(" "), waiting, split };
}

const CAUSE_EXPORT_TONE: Record<BehindCause, Tone> = { discovery: "slate", added: "amber", held: "rose", own: "slate" };

/** The same, as blocks for the emailed update: the causes, then a table of
 *  what holds each chain up (the eight biggest, and how much more). */
export function behindWhyBlocks(why: BehindWhy, f: { DTs: (ms: number) => string; hrs: (h: number) => string }, max = 8): ExportBlock[] {
  const h = (x: number) => f.hrs(r1(x));
  const top = why.chains.slice(0, max), rest = why.chains.slice(max);
  return [
    { k: "label", text: `Why we're behind - ${h(why.total)} of work behind plan${why.ahead >= 0.5 ? `, ${h(why.ahead)} ahead elsewhere` : ""}` },
    { k: "stats", items: CAUSE_ORDER.filter((k) => why.byCause[k] >= 0.05).map((k) => ({ label: CAUSE_WORD[k].word, value: h(why.byCause[k]), tone: CAUSE_EXPORT_TONE[k] })) },
    {
      k: "table", head: ["Holding it up", "Cause", "Work behind"], align: ["left", "left", "right"], textLabels: ["", "", "behind"], nowrap: [2],
      rows: [
        ...top.map((ch) => {
          const t = chainText(ch, f);
          return [
            { t: `${t.title} - ${t.state}`, bold: true, sub: [t.facts, t.waiting, t.split].filter((x): x is string => !!x).map((x) => ({ t: x })) },
            { t: CAUSE_WORD[ch.cause].short, tone: CAUSE_EXPORT_TONE[ch.cause] },
            { t: h(ch.hours), bold: true, tone: "rose" as const },
          ];
        }),
        ...(rest.length ? [[{ t: `+ ${rest.length} more`, tone: "muted" as const }, "", h(rest.reduce((a, x) => a + x.hours, 0))]] : []),
      ],
    },
  ];
}
