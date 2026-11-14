// The review laid out the way an event review is run:
//
//   1. The score: each target, plan against actual, with a verdict.
//   2. The seven areas (safety, organization, planning, contractors, costs,
//      logistics, execution): what went well, what did not, the root cause,
//      and the action it leads to.
//   3. The action plan: what we will do, how, the benefit, who, by what
//      date, and what it will cost.
//
// It is built on the review (lib/postEventReview) and adds nothing of its
// own to the facts. A line the records can't fill says "Not measured" and
// carries how to set it up for the next event. Only what a person accepted
// is an action.

import type { AsBuiltWork } from "@/lib/asBuiltWork";
import { manpowerSummary, shiftCounts, type ManpowerSettings } from "@/lib/manpower";
import type { ShiftRecord } from "@/lib/shiftRecord";
import { AREAS, AREA_OF, orderWord, pointOf, whenWord, type AreaId, type Conclusion, type Review, type ScoreEntry } from "@/lib/postEventReview";

// ─── How to set up what was not measured ───────────────────────────

export type GuideId = "quality" | "safety" | "manhours" | "cost" | "organization" | "materials";
export interface Guide { id: GuideId; title: string; what: string; steps: string[]; inApp: string }
export const GUIDES: Record<GuideId, Guide> = {
  quality: {
    id: "quality", title: "A quality plan",
    what: "It says what done right means for the work, who checks it, and what gets counted. It has two parts: checks before the event that what goes in is fit for the job (people, materials, equipment, services), and checks after each task that the work meets the standard.",
    steps: [
      "Name one person to lead quality for the event.",
      "Before the event, hold a quality review and set the standard for each kind of work: welds, pressure tests, joints, hand-backs.",
      "Set a target for each thing that gets counted: failed welds, failed pressure tests, failed joints, rejected hand-backs, leaks at start-up.",
      "Keep a control sheet for each critical item: critical joints, vessel inspections, relief valves, control valves, site modifications.",
      "Check every job before hand-back: correct gaskets fitted, supports on new pipework, valves repacked, instrument changes tested, blinds removed.",
      "Report quality at the daily meeting: the last 24 hours, problems, and what keeps coming back.",
      "After start-up, count the results against the targets.",
    ],
    inApp: "Enter the targets and the results on the score in this review.",
  },
  safety: {
    id: "safety", title: "A safety record",
    what: "Every incident with its cause, counted against a target set before the event.",
    steps: [
      "Set the target before the event, for example zero recordables.",
      "At every shift meeting, write each incident, or confirm there were none.",
      "For each incident, write the cause and what the inquiry recommended.",
      "Count recordables, first aids and near misses against the target.",
    ],
    inApp: "Each shift report has a \"Safety incidents this shift\" line. Answer it every shift.",
  },
  manhours: {
    id: "manhours", title: "Man-hours and labor cost",
    what: "Man-hours are heads on site times shift hours, by contractor. With each contractor's rate they give labor cost, shift by shift, against the bid.",
    steps: [
      "Before the event, get each contractor's bid manpower per shift and its rate sheet.",
      "Enter the bid manpower and the rate per man-hour for each contractor.",
      "At every shift meeting, take a head count for each contractor: direct (on the tools) and indirect (supervision, safety, fire and hole watch).",
      "Heads times shift hours times the rate gives man-hours and running labor cost against the bid, every shift.",
    ],
    inApp: "Bid manpower and rates go in Setup under Manpower. Head counts go in at each shift meeting on the Shift tab.",
  },
  cost: {
    id: "cost", title: "Cost against budget",
    what: "What is spent and committed, held against the budget line by line while there is still time to act.",
    steps: [
      "Split the budget by phase and by cost line: management, planning, inspection, materials, hired equipment, own labor, contract labor, specials.",
      "Post every commitment and invoice to its line as it happens.",
      "Add labor each shift from head counts at each contractor's rate.",
      "Look at spend against budget at the daily meeting.",
    ],
    inApp: "Cost controls holds the budget lines and the spend. Give each line its phase.",
  },
  organization: {
    id: "organization", title: "An event organization",
    what: "One person runs the event, and each part of it has a named person with written duties.",
    steps: [
      "Name who runs the event.",
      "Name a person for planning, for materials and logistics, for safety, for quality, and for each area.",
      "Write each person's duties and who they report to.",
      "Record it before the event, so the review can say how the organization worked.",
    ],
    inApp: "The Members tab holds the event organization: each role and who fills it.",
  },
  materials: {
    id: "materials", title: "A materials register",
    what: "One list of every part and off-site repair: what it is, which job it is for, who owns it, and when it is due.",
    steps: [
      "List every part and off-site repair with its full specification, its work order, an owner, a need-by date and a delivery date.",
      "Before the unit comes down, count each job's parts against what was ordered and close any shortfall.",
      "Give every open material question an owner, and answer it within 24 hours.",
    ],
    inApp: "The materials register is on the project.",
  },
};

// ─── The score ─────────────────────────────────────────────────────

export type Verdict = "met" | "missed" | "unmeasured" | "untargeted" | "open";
export const VERDICT_WORD: Record<Verdict, string> = { met: "Met", missed: "Missed", unmeasured: "Not measured", untargeted: "No target set", open: "Not finished" };
export interface ScoreRow {
  key: "duration" | "planned" | "added" | "manhours" | "cost" | "safety" | "quality";
  measure: string; plan: string; actual: string; verdict: Verdict;
  /** What it measures, in a line. */
  means: string;
  /** Targets to set with one tap (none where the plan itself is the target). */
  picks: string[];
  /** The result comes from the records; a person enters it only when it doesn't. */
  fromRecords: boolean;
  /** The result in a few words ("33.5 h late"). */
  result: string;
  /** How to set it up, when it could not be measured or has no target. */
  guide?: GuideId;
  /** A person can enter the plan and the actual (the records have neither). */
  entered: boolean;
}
export interface Score {
  rows: ScoreRow[];
  met: number; missed: number; unmeasured: number; untargeted: number;
  /** "2 of 3 targets met. 4 of 7 could not be measured." */
  line: string;
}

export interface ScoreInputs {
  /** Counted man-hours, the bid they are held to and their cost at the rates entered (lib/manpower). */
  manpower?: { totalMH: number; bidMH: number | null; cost: number | null } | null;
  /** Of the shifts worked, how many have the incident line answered, and what was written. */
  incidents?: { answered: number; recordable: number; firstAid: number; nearMiss: number } | null;
  /** The phase's budget, spend and commitments (cost controls). */
  costs?: { budget: number | null; spent: number; committed: number } | null;
  /** What a person entered on the score, and the targets set on the measures. */
  entries?: Record<string, ScoreEntry>;
  targets?: Record<string, string>;
}

/** Man-hours and incidents for the score, from the same shift records and
 *  manpower settings the rest of the app reads. */
export function scoreInputsFrom(x: { work: AsBuiltWork; records: Map<string, ShiftRecord>; manpower?: ManpowerSettings | null }): Pick<ScoreInputs, "manpower" | "incidents"> {
  const worked = new Set<string>();
  for (const c of x.work.crews) for (const [k, s] of Object.entries(c.byShift)) if (s.moved) worked.add(k);
  const windows = x.work.shifts.filter((w) => worked.has(`${w.dayKey}:${w.kind}`));
  const sum = manpowerSummary(shiftCounts(x.records, windows, x.manpower), x.records, x.manpower);
  const bids = sum.companies.map((c) => c.bidMH).filter((n): n is number => n != null);
  let answered = 0;
  for (const k of worked) { const i = x.records.get(k)?.incidents; if (i?.none || (i?.items?.length ?? 0) > 0) answered++; }
  return {
    manpower: sum.totalMH > 0 ? { totalMH: sum.totalMH, bidMH: bids.length ? Math.round(bids.reduce((a, n) => a + n, 0) * 10) / 10 : null, cost: sum.cost } : null,
    incidents: { answered, ...sum.incidents },
  };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const num = (t: string | undefined) => { const m = (t ?? "").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const MEANS: Record<ScoreRow["key"], string> = {
  duration: "When the work and start-up finished, against the baseline finish.",
  planned: "The activities on the saved plan, and how many got done.",
  added: "Work put in after the plan: added scope (known work that was not planned) and discovery (found when the equipment was opened).",
  manhours: "Heads on site times shift hours, from the head count at each shift meeting, against the contractors' bid.",
  cost: "Spend posted in Cost controls against this phase's budget.",
  safety: "Injuries written on the shift reports' incident line: recordables, first aids, near misses. The target is how many the event allows; most sites set zero recordables.",
  quality: "Work that failed its check and was done again: failed pressure tests, leaks at start-up, rework. The target is how many the event allows.",
};
const PICKS: Record<ScoreRow["key"], string[]> = {
  duration: [], planned: [],
  added: ["10% of the planned hours", "15% of the planned hours"],
  manhours: [], cost: [],
  safety: ["0 recordables", "0 recordables, 0 first aids"],
  quality: ["0 failed pressure tests", "0 failed tests, 0 start-up leaks"],
};

export function scoreOf(r: Pick<Review, "metrics"> & Partial<Pick<Review, "failedTests" | "standDowns" | "found">>, tz: string, x: ScoreInputs = {}): Score {
  const m = r.metrics, e = x.entries ?? {}, t = x.targets ?? {};
  const rows: ScoreRow[] = [];
  const v = m.varianceH;
  const row = (key: ScoreRow["key"], measure: string, o: Pick<ScoreRow, "plan" | "actual" | "verdict" | "result"> & Partial<ScoreRow>): ScoreRow =>
    ({ key, measure, means: MEANS[key], picks: PICKS[key], fromRecords: true, entered: false, ...o });
  /** A target in words judged against a count: "0 recordables" allows 0. */
  const allows = (target: string | undefined, count: number): Verdict => { const k = num(target); return k == null ? "untargeted" : count <= k ? "met" : "missed"; };

  // Duration: the baseline finish is the target unless a person set an allowance.
  const allowH = num(e.duration?.plan ?? t.variance);
  rows.push(row("duration", "Duration", {
    plan: m.baselineFinish != null ? `Finish ${whenWord(m.baselineFinish, tz)}${allowH ? `, up to ${allowH} h past it` : ""}` : "No baseline",
    actual: m.actualFinish != null ? `Finish ${whenWord(m.actualFinish, tz)}` : "Not finished",
    verdict: v == null ? "open" : v <= Math.max(0.99, allowH ?? 0) ? "met" : "missed",
    result: v == null ? "Open" : Math.abs(v) < 1 ? "On the baseline finish" : `${Math.abs(v)} h ${v > 0 ? "late" : "early"}`,
  }));

  rows.push(row("planned", "Planned work", {
    plan: `${plural(m.baselineSteps, "activity", "activities")}, ${m.baselineH} h`, actual: `${m.baselineDone} done`,
    verdict: !m.baselineSteps ? "unmeasured" : m.baselineDone === m.baselineSteps ? "met" : v == null ? "open" : "missed",
    result: m.baselineDone === m.baselineSteps ? "All done" : `${m.baselineSteps - m.baselineDone} not done`,
  }));

  // Added work, by the kind it was entered as; judged only against an allowance a person set.
  const found = r.found ?? [];
  const known = Math.round(found.filter((f) => f.kind === "added").reduce((n, f) => n + f.hours, 0) * 10) / 10;
  const disc = Math.round(found.filter((f) => f.kind !== "added").reduce((n, f) => n + f.hours, 0) * 10) / 10;
  const allowPct = num(e.added?.plan ?? t.growth);
  rows.push(row("added", "Added work", {
    plan: allowPct != null ? `Up to ${allowPct}% of the planned hours` : "Target not set",
    actual: !m.addedSteps ? "None" : found.length ? `${m.addedH} h: ${[known ? `${known} h added scope` : "", disc ? `${disc} h discovery` : ""].filter(Boolean).join(", ")}` : `${plural(m.addedSteps, "activity", "activities")}, ${m.addedH} h`,
    verdict: !m.addedSteps ? "met" : allowPct == null || m.addedPct == null ? "untargeted" : m.addedPct <= allowPct ? "met" : "missed",
    result: !m.addedSteps ? "None added" : m.addedPct != null ? `${m.addedPct}% more work` : `${m.addedH} h added`, entered: true,
  }));

  // Man-hours: only when head counts cover the event.
  const hc = m.headCounts, covered = hc.shiftsWorked > 0 && hc.shiftsCounted / hc.shiftsWorked >= 0.8, mp = x.manpower ?? null;
  const em = e.manhours;
  rows.push(em?.actual ? row("manhours", "Man-hours", { plan: em.plan || "No bid on file", actual: em.actual, verdict: em.verdict ?? "untargeted", result: em.verdict ? VERDICT_WORD[em.verdict] : "Entered by hand", fromRecords: false, entered: true })
    : covered && mp ? row("manhours", "Man-hours", {
      plan: mp.bidMH != null ? `${mp.bidMH.toLocaleString("en-US")} bid` : em?.plan || "No bid entered", actual: `${mp.totalMH.toLocaleString("en-US")} counted`,
      verdict: mp.bidMH != null ? (mp.totalMH <= mp.bidMH ? "met" : "missed") : "untargeted",
      result: mp.bidMH != null ? `${Math.abs(Math.round(mp.totalMH - mp.bidMH)).toLocaleString("en-US")} ${mp.totalMH <= mp.bidMH ? "under" : "over"} the bid` : "No bid to hold it to", guide: mp.bidMH == null ? "manhours" : undefined, entered: true,
    }) : row("manhours", "Man-hours", {
      plan: mp?.bidMH != null ? `${mp.bidMH.toLocaleString("en-US")} bid` : em?.plan || "No bid on file",
      actual: hc.shiftsWorked ? `Head count on ${hc.shiftsCounted} of ${plural(hc.shiftsWorked, "shift")}` : "No shifts worked", verdict: "unmeasured", result: "Not measured", guide: "manhours", fromRecords: false, entered: true,
    }));

  // Cost: spend posted against the phase's budget.
  const c = x.costs ?? null, ec = e.cost;
  rows.push(ec?.actual ? row("cost", "Cost", { plan: ec.plan || (c?.budget ? `${money(c.budget)} budget` : "No budget on file"), actual: ec.actual, verdict: ec.verdict ?? "untargeted", result: ec.verdict ? VERDICT_WORD[ec.verdict] : "Entered by hand", fromRecords: false, entered: true })
    : c && c.spent > 0 && c.budget ? row("cost", "Cost", {
      plan: `${money(c.budget)} budget`, actual: `${money(c.spent)} spent${c.committed ? `, ${money(c.committed)} committed` : ""}`,
      verdict: c.spent <= c.budget ? "met" : "missed", result: `${money(Math.abs(c.budget - c.spent))} ${c.spent <= c.budget ? "under" : "over"}`, entered: true,
    }) : row("cost", "Cost", {
      plan: c?.budget ? `${money(c.budget)} budget` : ec?.plan || "No budget on file",
      actual: c?.committed ? `No spend posted. ${money(c.committed)} committed.` : "No spend posted", verdict: "unmeasured", result: "Not measured", guide: "cost", fromRecords: false, entered: true,
    }));

  // Safety: the shift reports' incident line, and the stand-downs written on the work.
  const inc = x.incidents ?? null, es = e.safety, answeredAll = !!inc && hc.shiftsWorked > 0 && inc.answered / hc.shiftsWorked >= 0.8;
  const sd = r.standDowns ?? [];
  const sdLine = sd.length ? ` ${plural(sd.length, "stand-down")} on ${[...new Set(sd.map((h) => h.order.split(" - ")[0]))].join(", ")} (${Math.round(sd.reduce((n, h) => n + h.hours, 0) * 10) / 10} h).` : "";
  const counts = inc ? `${plural(inc.recordable, "recordable")}, ${plural(inc.firstAid, "first aid")}, ${plural(inc.nearMiss, "near miss", "near misses")}` : "";
  const target = es?.plan || "Target not set";
  rows.push(es?.actual ? row("safety", "Safety", { plan: target, actual: es.actual, verdict: es.verdict ?? "untargeted", result: es.verdict ? VERDICT_WORD[es.verdict] : "Entered by hand", guide: es.plan ? undefined : "safety", fromRecords: false, entered: true })
    : answeredAll && inc ? row("safety", "Safety", {
      plan: target, actual: `${counts}.${sdLine}`, verdict: allows(es?.plan, inc.recordable),
      result: es?.plan ? (allows(es.plan, inc.recordable) === "met" ? "Within target" : "Over target") : "No target set", guide: es?.plan ? undefined : "safety", entered: true,
    }) : row("safety", "Safety", {
      plan: target, actual: `${inc && inc.answered ? `Incident line answered on ${inc.answered} of ${plural(hc.shiftsWorked, "shift")}: ${counts}.` : "No incident line answered on the shift reports."}${sdLine}`,
      verdict: "unmeasured", result: "Not measured", guide: "safety", fromRecords: false, entered: true,
    }));

  // Quality: tests that failed and were done again, as written on the work.
  const ft = r.failedTests ?? [], eq = e.quality;
  const ftLine = ft.length ? `${plural(ft.length, "failed test")}, done again: ${ft.map((f) => `${f.order.split(" - ")[0]} ${f.step}`).join(", ")}` : "No failed test written on the work";
  rows.push(eq?.actual ? row("quality", "Quality", { plan: eq.plan || "Target not set", actual: eq.actual, verdict: eq.verdict ?? "untargeted", result: eq.verdict ? VERDICT_WORD[eq.verdict] : "No target set", guide: eq.plan ? undefined : "quality", fromRecords: false, entered: true })
    : row("quality", "Quality", {
      plan: eq?.plan || "Target not set", actual: ftLine, verdict: allows(eq?.plan, ft.length),
      result: eq?.plan ? (allows(eq.plan, ft.length) === "met" ? "Within target" : "Over target") : "No target set", guide: eq?.plan ? undefined : "quality", entered: true,
    }));

  const n = (k: Verdict) => rows.filter((row) => row.verdict === k).length;
  const met = n("met"), missed = n("missed"), unmeasured = n("unmeasured"), untargeted = n("untargeted");
  const judged = met + missed;
  const line = [judged ? `${met} of ${plural(judged, "target")} met.` : "", unmeasured ? `${unmeasured} of ${rows.length} could not be measured.` : "", untargeted ? `${untargeted} had no target.` : ""].filter(Boolean).join(" ");
  return { rows, met, missed, unmeasured, untargeted, line };
}

// ─── The seven areas, and the action plan ──────────────────────────

export interface Action {
  n: number; key: string; area: AreaId; areaName: string;
  /** A rule for every event of this kind, or for this unit's next one. */
  applies: "all" | "unit";
  /** What we will do, how it will be done, and the benefit (from this event). */
  what: string; how: string; benefit: string;
  /** Who will do it, by what date, what it will cost. Blank until a person sets it. */
  who: string; by: string; cost: string;
  done: boolean;
}
// ─── What a review measures ────────────────────────────────────────

/** The categories an event is reviewed by: the event itself, then the seven areas. */
export type CategoryKey = "event" | AreaId;
export const REVIEW_CATEGORIES: Array<{ key: CategoryKey; name: string; measures: string }> = [
  { key: "event", name: "The event", measures: "Finish against the baseline, planned work done, and where the late hours went." },
  { key: "safety", name: "Safety", measures: "Incidents against the target, and work stood down for gas, alarms or plant upsets." },
  { key: "organization", name: "Organization", measures: "Who ran the event, and whether each role had a named person." },
  { key: "planning", name: "Planning", measures: "Scope against the plan (added scope and discovery), schedule logic, and steps missing from the plan." },
  { key: "contractors", name: "Contractors", measures: "Each crew against the work handed to it: jobs open at once, waits, man-hours against the bid." },
  { key: "costs", name: "Costs", measures: "Spend against the budget, and labor cost from head counts and rates." },
  { key: "logistics", name: "Logistics", measures: "Materials and parts against what each job needed, and repairs sent off site." },
  { key: "execution", name: "Execution", measures: "Control of the work: start-up, jobs that sat, ready work not started, quality of the work, and progress written as it happened." },
];
export const categoryName = (k: CategoryKey) => REVIEW_CATEGORIES.find((c) => c.key === k)!.name;
/** The category each line of the score answers to. */
export const SCORE_CATEGORY: Record<ScoreRow["key"], CategoryKey> = { duration: "event", planned: "event", added: "planning", manhours: "contractors", cost: "costs", safety: "safety", quality: "execution" };

export type AreaState = "finish" | "time" | "improve" | "pending" | "well" | "none";
export const AREA_STATE_WORD: Record<AreaState, string> = { finish: "Set the finish", time: "Cost time", improve: "To improve", pending: "Needs your call", well: "Went well", none: "Nothing recorded" };
export interface AreaRow {
  id: AreaId; name: string; state: AreaState;
  /** Hours of the late finish this area's accepted findings explain, and on which work. */
  hours: number; parts: Array<{ order: string; hours: number }>;
  /** The word on its tag: "24 h of the finish", else its state. */
  tag: string;
  /** What the records measure for it that no finding says (start-up overrun, jobs that sat, repairs back late). */
  measured: string[];
  well: string[];
  /** What did not go well, where it was written, its own root cause (blank:
   *  no one wrote one), and the action it leads to: one per accepted finding. */
  items: Array<{ key: string; didNot: string; where?: string; rootCause: string; action: number }>;
  /** Findings in this area a person has not ruled on. */
  pending: number;
  /** How to set this area up, when nothing was recorded for it. */
  guide?: GuideId;
}
export interface Book {
  headline: string; span: string;
  /** Each category, what it measures, and where this review addresses it. */
  categories: Array<{ key: CategoryKey; name: string; measures: string; where: string }>;
  /** Where the late hours went, in a line, and each piece in a sentence. */
  delay: string; delayLines: string[];
  score: Score; areas: AreaRow[]; actions: Action[]; pending: number;
}
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The text names the work order's tag as a word ("E-12", not "E-120"). */
const names = (text: string | undefined, tag: string) => !!text && new RegExp(`(^|[^A-Za-z0-9-])${esc(tag)}(?![A-Za-z0-9])`).test(text);

const AREA_GUIDE: Partial<Record<AreaId, GuideId>> = { safety: "safety", organization: "organization", costs: "cost", logistics: "materials" };
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3));
/** How it will be done, less any sentence that only says the action again. */
export function howOf(next: string, what: string): string {
  const said = words(what);
  const keep = (next.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? []).map((x) => x.trim()).filter(Boolean).filter((sn) => { const w = [...words(sn)]; return !w.length || w.filter((x) => said.has(x)).length / w.length < 0.75; });
  return keep.join(" ");
}

export function bookOf(r: Review, name: string, tz: string, x: ScoreInputs = {}): Book {
  const pt = pointOf(r, name, tz);
  const areaName = (id: AreaId) => AREAS.find((a) => a.id === id)!.name;
  const actions: Action[] = pt.conclusions.map((c: Conclusion, i) => {
    const area = AREA_OF[c.categoryId];
    // A finding about several areas says each.
    const all = [...new Set([area, ...(c.areas ?? [])])];
    return { n: i + 1, key: c.key, area, areaName: all.map(areaName).join(", "), applies: c.applies, what: c.ask, how: howOf(c.change, c.ask), benefit: c.because, who: c.owner, by: c.due, cost: c.cost, done: c.done };
  });
  // Each piece of the late finish goes to the area of the accepted finding
  // that explains it: the one that names its work order in its headline (else
  // in what happened), and that moved the finish most.
  const byKey = new Map(r.findings.map((f) => [f.key, f]));
  const owner = new Map<AreaId, Array<{ order: string; hours: number }>>();
  for (const d of r.finish?.delay ?? []) {
    // The start-up running long, or starting after the work was done: how the event was run.
    if (d.kind !== "work") { if (d.hours > 0) owner.set("execution", [...(owner.get("execution") ?? []), { order: d.order, hours: d.hours }]); continue; }
    const tag = orderWord(d.order);
    const hits = pt.conclusions.map((c) => ({ c, head: names(c.source === "job" ? c.didNot : `${c.title} ${c.because} ${c.why}`, tag), any: names(byKey.get(c.key)?.observation, tag) }))
      .filter((h) => h.head || h.any).sort((x2, y2) => Number(y2.head) - Number(x2.head) || (y2.c.moved ?? 0) - (x2.c.moved ?? 0));
    if (!hits.length) continue;
    const area = AREA_OF[hits[0].c.categoryId];
    owner.set(area, [...(owner.get(area) ?? []), { order: d.order, hours: d.hours }]);
  }
  const top = r.finish?.delay.find((d) => d.kind === "work")?.order ?? null;
  // Measured from the records for each area, said once: what no finding on the slide already says.
  const delayed = new Set((r.finish?.delay ?? []).filter((d) => d.kind === "work").map((d) => d.order));
  const held = (orders: string[]) => orders.some((o) => delayed.has(o));
  const told = pt.conclusions.map((c) => `${c.title} ${c.didNot}`).join(" ");
  const measured: Partial<Record<AreaId, string[]>> = {};
  const add = (a: AreaId, line: string) => { measured[a] = [...(measured[a] ?? []), line]; };
  const m = r.metrics, cl = r.finish?.closing;
  if (cl?.longerH != null && cl.longerH >= 0.5) add("execution", `Start-up ran ${cl.longerH} h longer than planned.`);
  if (m.stuckJobs || m.readyJobs) {
    const orders = [...r.stuck.map((j) => j.order), ...r.ready.map((j) => j.order)];
    add("execution", `${[m.stuckJobs ? `${plural(m.stuckJobs, "started job")} sat a shift${m.noReasonShifts ? ` (${m.noReasonShifts} with no reason written)` : ""}` : "", m.readyJobs ? `${plural(m.readyJobs, "ready job")} waited ${plural(m.readyShifts, "shift")} to start` : ""].filter(Boolean).join("; ")}.${held(orders) ? "" : " None of them held up the finish."}`);
  }
  const late = r.service.filter((j) => j.stillOut);
  if (late.length && !late.every((j) => told.includes(orderWord(j.order)))) add("logistics", `${plural(late.length, "repair")} sent off site came back after the time quoted: ${late.map((j) => orderWord(j.order)).join(", ")}.${held(late.map((j) => j.order)) ? "" : ` ${late.length === 1 ? "It" : "None"} held up the finish.`.replace("It held", "It did not hold")}`);
  const areas: AreaRow[] = AREAS.map((a) => {
    const mine = pt.conclusions.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => AREA_OF[c.categoryId] === a.id || !!c.areas?.includes(a.id));
    const parts = owner.get(a.id) ?? [], hours = Math.round(parts.reduce((n, p2) => n + p2.hours, 0) * 10) / 10;
    const pending = pt.pending.filter((c) => AREA_OF[c.categoryId] === a.id).length;
    const well = r.wins.filter((w) => AREA_OF[w.category] === a.id).map((w) => w.text);
    const facts = measured[a.id] ?? [];
    const state: AreaState = parts.some((p2) => p2.order === top) || mine.some(({ c }) => c.first) ? "finish" : hours > 0 || mine.some(({ c }) => (c.moved ?? 0) >= 2) ? "time" : mine.length || facts.length ? "improve" : pending ? "pending" : well.length ? "well" : "none";
    return {
      id: a.id, name: a.name, state, well, pending, hours, parts, measured: facts, tag: hours > 0 ? `${hours} h of the finish` : AREA_STATE_WORD[state],
      items: mine.map(({ c, n }) => ({ key: c.key, didNot: c.didNot, where: c.where, rootCause: c.gap, action: n })),
      guide: state === "none" ? AREA_GUIDE[a.id] : undefined,
    };
  });
  const score = scoreOf(r, tz, x);
  const categories = REVIEW_CATEGORIES.map((c) => {
    const rows = score.rows.filter((row) => SCORE_CATEGORY[row.key] === c.key).map((row) => row.measure);
    const acts = actions.filter((a) => a.area === c.key || !!pt.conclusions.find((x) => x.key === a.key)?.areas?.includes(c.key as AreaId)).map((a) => a.n);
    const where = [rows.length ? `Score (${rows.join(", ")})` : "", c.key !== "event" ? "Areas" : "", acts.length ? `${acts.length === 1 ? "Action" : "Actions"} ${acts.join(", ")}` : ""].filter(Boolean).join("; ");
    return { ...c, where };
  });
  return { headline: pt.headline, span: pt.span, categories, delay: pt.delay, delayLines: (r.finish?.delay ?? []).map((d) => d.line), score, areas, actions, pending: pt.pending.length };
}

/** The guides a book points to, each once, in the order they come up. */
export function guidesOf(b: Book): Guide[] {
  const ids: GuideId[] = [];
  for (const row of b.score.rows) if (row.guide && !ids.includes(row.guide)) ids.push(row.guide);
  for (const a of b.areas) if (a.guide && !ids.includes(a.guide)) ids.push(a.guide);
  return ids.map((id) => GUIDES[id]);
}
