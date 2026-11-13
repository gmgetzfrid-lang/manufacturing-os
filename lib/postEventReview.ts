// postEventReview - the look back at a finished event, drafted from its own
// records. It leads with the point: what set the finish, which work order,
// which step and crew, and what was written on it. Everything else is told
// by whether it moved the finish.
//
// Everything here is counted from what was entered: the schedule and its
// baseline, progress by shift, comments and hold reasons, added work and
// who approved it, the shift meetings' head counts. Nothing is assumed: a
// number the records can't give is left out and said so, and where a reason
// was never written the review asks for it (the questions) instead of
// guessing.
//
//   - What set the finish is the last work order done (before start-up),
//     with its steps that ran long. A finding is named as the cause only
//     when that work's own comments give it as the reason.
//   - A job is "stuck" in a shift when it had started, wasn't finished, and
//     nothing was logged on it for that whole shift. "Ready, not started":
//     everything before it was done and it still didn't start that shift.
//     Night shifts count only for work that ran on nights (lib/asBuiltWork).
//   - Equipment out for repair or calibration is a planned step, not stuck
//     work. It is a finding only when it stays out past the time quoted.
//   - Why a job sat is read shift by shift: the latest comment or hold reason
//     on the job by the end of that shift; failing that, what was written
//     when it picked back up; failing that, where its crew was.
//   - Each of the eight categories gives what happened, what it cost, and
//     what to do differently, said about this event. An owner is named only
//     from the organization recorded on the project.
//   - What a person kept, changed, added or threw out is laid over the
//     draft and is never overwritten by a new read of the records.
//
// Pure: no database here.

import type { MilestoneNote } from "@/types/schema";
import type { AsBuilt } from "@/lib/asBuiltSchedule";
import type { AsBuiltWork } from "@/lib/asBuiltWork";
import type { Discovery } from "@/lib/discovery";
import type { LookBack } from "@/lib/lookBack";
import { fmtInTz } from "@/lib/scheduleTz";
import { crewFlows, overloaded, type CrewFlow } from "@/lib/crewFlow";

// ─── What it's sorted by ───────────────────────────────────────────

export type Rating = "strength" | "opportunity" | "gap" | "none";
export const RATING_WORD: Record<Rating, string> = { strength: "Strength", opportunity: "Opportunity", gap: "Gap", none: "No finding" };
export const RATING_MEANS = "Gap: it cost the event the most. Opportunity: do it differently next time. Strength: it worked; keep it.";

export type CategoryId = "organization" | "scope" | "planning" | "materials" | "contractors" | "execution" | "safety" | "records";
export const CATEGORIES: Array<{ id: CategoryId; name: string; stage: string }> = [
  { id: "organization", name: "Organization and roles", stage: "Initiation" },
  { id: "scope", name: "Scope definition", stage: "Preparation" },
  { id: "planning", name: "Planning and scheduling", stage: "Preparation" },
  { id: "materials", name: "Materials and logistics", stage: "Preparation" },
  { id: "contractors", name: "Contractors and resourcing", stage: "Preparation" },
  { id: "execution", name: "Execution control", stage: "Execution" },
  { id: "safety", name: "Safety", stage: "All phases" },
  { id: "records", name: "Records and close-out", stage: "Close-out" },
];
export const categoryOf = (id: string) => CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[0];

export type CauseId = "offsite" | "material" | "cleaning" | "other_crew" | "test" | "permit" | "engineering" | "equipment" | "scope" | "weather" | "crew_moved" | "crew_elsewhere" | "none";
export const CAUSE_WORD: Record<CauseId, string> = {
  offsite: "Off-site repair or calibration", material: "Materials", cleaning: "Line or equipment cleaning first", other_crew: "Waiting on another crew",
  test: "Leak or failed test", permit: "Permit, gas test or decontamination", engineering: "Engineering answer", equipment: "Tools or equipment",
  scope: "Scope change", weather: "Weather", crew_moved: "Crew put on other work", crew_elsewhere: "Crew on other work, no reason logged", none: "Nothing logged",
};
/** The reasons a person picks from (a delay code). */
export const CAUSE_CHOICES: CauseId[] = ["material", "offsite", "cleaning", "other_crew", "test", "permit", "engineering", "equipment", "scope", "weather", "crew_moved"];
/** No reason was written for it. */
export const unexplained = (c: CauseId) => c === "crew_elsewhere" || c === "none";

const RULES: Array<[CauseId, RegExp]> = [
  ["other_crew", /\b(ready for|waiting (on|for)|needs?|needed|hold(ing)? for)\s+(the\s+)?(e\s?\/\s?i|electric\w*|instrument\w*|inspect\w*|operations|ops|scaffold\w*|insulat\w*|crane|qc|welders?|x-?ray|nde)\b/i],
  ["offsite", /\b(picked up|pick up|sent out|off[- ]?site|at the shop|machine shop|vendor|calibrat\w*|expected back|back from|return(ed)? from|waiting (for|on)\b.*\b(return|back)\b)/i],
  ["cleaning", /\b(plug\w*|to clean|clean(ed|ing)? (the |out )?line|hydroblast\w*|fouled|fouling|blockage)/i],
  ["test", /\b(leak\w*|failed (the )?(hydro|test)|re-?test\w*|did ?n[o']t hold|won'?t hold)/i],
  ["permit", /\b(permit\w*|lel|gas test\w*|gas free|air strip\w*|steam(ing|ed)? out|purg\w+|decon\w*|not cleared)/i],
  ["material", /\b(materials?|parts?|gaskets?|bolts?|studs?|seal rings?|on order|back.?order\w*|not ordered|deliver\w*|eta|short(age)?|wrong (part|size|gasket)|warehouse|expedit\w*)\b/i],
  ["engineering", /\b(drawings?|engineer\w*|moc|rfi|design (question|change))\b/i],
  ["weather", /\b(rain\w*|wind|weather|lightning|fog)\b/i],
];
/** The note says the thing it waited on is over. */
const RESOLVED = /\b(cleared|returned|back on site|arrived|received|dropped off?|complete[d]?)\b/i;

/** The reason a comment gives for a job sitting, if it gives one. */
export function causeOfText(text: string | null | undefined): CauseId | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const [id, re] of RULES) if (re.test(t)) return id;
  return null;
}

// ─── What a person said (kept with the project) ────────────────────

export interface FindingEdit {
  title?: string; observation?: string; practice?: string; gap?: string; next?: string; year?: string; owner?: string; rating?: Rating;
  /** What it cost, in a person's words ("$700 to expedite"). */
  effect?: string;
  /** What justifies the change, in a sentence or two with the numbers. */
  why?: string;
}
export interface SavedItem {
  status?: "kept" | "discarded";
  edits?: FindingEdit;
  /** Lines a person added to what the records say. */
  info?: string[];
  /** The draft's observation when it was kept or changed, to say when the
   *  records have moved since. */
  basis?: string;
  at?: number; by?: string | null;
}
export interface AddedFinding extends FindingEdit {
  id: string; category: CategoryId; at: number; by: string | null;
}
export interface Answer { cause?: CauseId; note?: string; at?: number; by?: string | null }
export interface ReviewSaved {
  items: Record<string, SavedItem>;
  added: AddedFinding[];
  answers: Record<string, Answer>;
  /** The target a person set for each measure (by its key). */
  targets: Record<string, string>;
}
export const emptySaved = (): ReviewSaved => ({ items: {}, added: [], answers: {}, targets: {} });

// ─── What comes out ────────────────────────────────────────────────

export interface StuckShift { key: string; cause: CauseId; said: string | null; crewOn: string[]; answered: boolean }
export interface StuckJob { id: string; name: string; order: string; crew: string; added: boolean; shifts: StuckShift[] }
/** Equipment sent out for repair or calibration: a planned step, not stuck
 *  work. It is a finding only when it stays out past the time quoted. */
export interface ServiceJob {
  id: string; name: string; order: string; crew: string;
  /** Shifts it was away. */
  shifts: string[];
  /** What was written when it went ("picked up, expected back in 72 hrs"). */
  said: string; sentAt: number;
  /** When it was due back, when the note gives hours. */
  dueAt: number | null;
  /** Still out after that, as written. */
  stillOut: { at: number; said: string } | null;
}
/** What set the finish: the last work done, and why it ran long. */
export interface FinishStory {
  lateH: number;
  /** The last work orders to finish (before the closing work), latest first. */
  last: Array<{ order: string; finish: number; planFinish: number | null; lateH: number | null }>;
  /** Hours the latest finished after the one before it. */
  aheadH: number | null;
  /** The work that closes the event (start-up), when it began late because the rest wasn't done. */
  closing: { order: string; planStart: number; start: number; lateH: number; longerH: number | null } | null;
  /** In the latest: the steps that ran longest against their plan, and what was written on them. */
  steps: Array<{ name: string; crew: string; plannedH: number; tookH: number; said: string[] }>;
  /** What its comments say it waited on, first. */
  cause: CauseId | null;
  /** That first comment: the step and crew it was written on. */
  because: { step: string; crew: string; said: string; at: number } | null;
}
export interface ReadyJob { id: string; name: string; order: string; crew: string; added: boolean; shifts: string[]; busyOn: string[]; crewLogged: boolean; said: string | null }
export interface FoundWork {
  id: string; what: string; kind: "discovery" | "added"; on: string; steps: number; done: number;
  /** Hours of work estimated when it was approved. */
  hours: number; critical: boolean; foundAt: number; approvedBy: string | null;
}
export interface HoldFact { id: string; name: string; order: string; reason: string; hours: number; cause: CauseId | null }

export interface ReviewMetrics {
  /** The first activity's start (recorded, else planned). */
  start: number | null;
  baselineFinish: number | null; actualFinish: number | null; varianceH: number | null; done: boolean;
  steps: number; stepsDone: number; baselineSteps: number; baselineDone: number; addedSteps: number; addedDone: number;
  findings: number;
  /** Planned hours of the work, from the schedule: the baseline's, and what was added. */
  baselineH: number; addedH: number; addedPct: number | null;
  shifts: number; dayShifts: number;
  /** Shifts with at least one job stuck or ready and not started. */
  shiftsWithStuck: number; leastAtOnce: number; mostAtOnce: number;
  stuckJobs: number; stuckShifts: number; readyJobs: number; readyShifts: number;
  byCause: Array<{ cause: CauseId; shifts: number; jobs: string[] }>;
  noReasonShifts: number;
  /** Labor hours, only when the shift meetings counted enough crews. */
  labor: { totalMH: number; addedMH: number; pct: number } | null;
  headCounts: { counted: number; of: number };
}

export type Moved = 0 | 1 | 2 | 3;
export interface Finding {
  key: string;
  category: CategoryId;
  source: "records" | "person";
  rating: Rating;
  title: string;
  observation: string;
  /** Each fact behind the observation, one per line, as the records have it. */
  evidence: string[];
  practice: string; gap: string; next: string; year: string; owner: string;
  /** What it cost: whether it moved the finish. */
  effect: string;
  /** 3: the records name it as what set the finish. 2: it is on the last
   *  work to finish. 1: it is on work that finished late, but not last.
   *  0: it did not move the finish. null: the records can't say. */
  moved: Moved | null;
  /** The one fact that best shows it. */
  proof: string;
  /** What justifies the change: a sentence or two, with the numbers. */
  why: string;
  /** The hours it is about (what puts one finding ahead of another). */
  hours: number | null;
  info: string[];
  status: "draft" | "kept" | "discarded";
  edited: boolean;
  /** Kept or changed before the records last moved: the fresh draft differs. */
  stale: boolean;
  /** What the records alone say now. */
  drafted: { title: string; observation: string; rating: Rating };
  by: string | null; at: number | null;
}

export interface Question {
  key: string;
  kind: "stuck" | "ready" | "approver";
  ask: string;
  /** "cause": pick a reason (and say more); "text": one line. */
  answer: "cause" | "text";
  findingKey: string;
}

export interface QA { q: string; a: string }
export interface ShiftCount { key: string; stuck: number; ready: number }

export interface Review {
  metrics: ReviewMetrics;
  /** What set the finish (when the event is finished and has a baseline). */
  finish: FinishStory | null;
  /** Equipment that went out for service: planned, listed apart from stuck work. */
  service: ServiceJob[];
  stuck: StuckJob[];
  ready: ReadyJob[];
  byShift: ShiftCount[];
  found: FoundWork[];
  holds: HoldFact[];
  findings: Finding[];
  /** Where work waited between crews (lib/crewFlow), most waiting first. */
  flows: CrewFlow[];
  questions: Question[];
  answeredCount: number;
  strengths: string[];
  qa: QA[];
  /** This event's result on each measure, and the target a person set. */
  measures: Measure[];
  /** The event organization as recorded, when it is. */
  organization: OrgStanding | null;
  /** How each number is counted, and where to see it. */
  definitions: Array<{ measure: string; means: string; where: string }>;
}
export interface Measure {
  key: string; measure: string; result: string; target: string; set: boolean;
  /** What a target for it means, in a line. */
  hint: string;
  /** Targets to pick from, read off this event's result. */
  picks: string[];
}
export const TARGET_NOT_SET = "Not set";

// ─── Words ─────────────────────────────────────────────────────────

const r1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Every item, in full: a list is never cut to "and 3 more". */
const list = (xs: string[]) => xs.join(", ");
const tagOf = (order: string) => order.split(" - ")[0].trim() || order;
/** "10/27 day": a shift, as the tables say it. */
export function shiftWord(key: string): string {
  const [d, kind] = key.split(":");
  const [, m, day] = d.split("-");
  return `${Number(m)}/${Number(day)} ${kind}`;
}
/** A run of shifts: "10/27 day, 10/28 day". */
export const shiftsWord = (keys: string[]) => keys.map(shiftWord).join(", ");
export const whenWord = (t: number, tz: string) => `${fmtInTz(t, tz, { weekday: "short", month: "numeric", day: "numeric" })} ${fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true })}`;
const TAG = /^[A-Z]{1,4}-?\d{1,5}[A-Z]{0,2}\b/;
/** Tidied, never shortened: a sentence someone wrote is kept whole. */
const short = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.;,]+$/, "");
/** A work order as a few words: its equipment tag, else its name cut short. */
export function orderWord(order: string): string {
  const tag = tagOf(order);
  return TAG.test(tag) ? tag.match(TAG)![0] : short(order.replace(/\s*\([^)]*\)/g, ""));
}
/** A job as the tables name it: its equipment tag and what is done, without
 *  the bracketed detail ("E-12 Install Bundle", "PSV-021 - E-13 Overhead"). */
export function jobWord(j: { name: string; order: string }): string {
  // Bracketed detail comes off; a bracket left open or closed alone goes with it.
  const name = short(j.name.replace(/\s*\([^)]*\)/g, "").replace(/[()]/g, "").trim());
  const tag = tagOf(j.order);
  if (TAG.test(name) || name.toLowerCase().startsWith(tag.toLowerCase())) return name;
  return TAG.test(tag) ? `${tag} ${name}` : `${name}, ${short(j.order)}`;
}
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };

// ─── The read ──────────────────────────────────────────────────────

export interface ReviewInput {
  built: AsBuilt;
  work: AsBuiltWork;
  notes: MilestoneNote[];
  look: LookBack | null;
  discoveries: Discovery[];
  tz: string;
  saved?: ReviewSaved | null;
  /** The materials register, when it is in use. */
  materials?: { lines: number; specIncomplete: number; openQuestions: number; late: number } | null;
  /** The event organization recorded on the project (lib/eventOrganization). */
  organization?: OrgStanding | null;
  /** Each step's predecessors, from the schedule's links (for lib/crewFlow). */
  dependsOn?: Map<string, string[]>;
}
/** The roles the event calls for, and who is named for each. */
export interface OrgStanding {
  /** One was saved for this project (else it is only the starting list). */
  recorded: boolean;
  required: number; filled: number;
  /** Required roles with no one named. */
  missing: string[];
  roles: Array<{ role: string; person: string; does: string; required: boolean }>;
}

const toMs = (v: unknown): number | null => { const t = v == null || v === "" ? NaN : typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? t : null; };

export interface Comment { at: number; body: string }
/** Comments and hold reasons on each step, oldest first, at the time they
 *  are about. An entry typed with no time of its own, right after one that
 *  has a time (a day's updates entered in one sitting), belongs with it:
 *  otherwise a hold typed in the afternoon lands after the morning's comment
 *  that it was cleared. */
export function commentsByStep(notes: MilestoneNote[], has: (id: string) => boolean): Map<string, Comment[]> {
  const typed = new Map<string, MilestoneNote[]>();
  for (const n of notes) {
    if (!has(n.milestoneId) || toMs(n.createdAt) == null) continue;
    if (!typed.has(n.milestoneId)) typed.set(n.milestoneId, []);
    typed.get(n.milestoneId)!.push(n);
  }
  const out = new Map<string, Comment[]>();
  for (const [id, ns] of typed) {
    ns.sort((a, b) => toMs(a.createdAt)! - toMs(b.createdAt)!);
    let last: { typedAt: number; about: number } | null = null;
    const rows: Comment[] = [];
    for (const n of ns) {
      const typedAt = toMs(n.createdAt)!, own = toMs(n.happenedAt);
      const at: number = own ?? (last && typedAt - last.typedAt <= 5 * 60_000 ? last.about + 1 : typedAt);
      if (own != null) last = { typedAt, about: own }; else if (last && typedAt - last.typedAt <= 5 * 60_000) last = { typedAt, about: at };
      const body = (n.body ?? "").trim();
      if (body) rows.push({ at, body });
    }
    out.set(id, rows.sort((a, b) => a.at - b.at));
  }
  return out;
}
/** Why a job sat, as its comments have it by `end`: the latest one that
 *  gives a reason, unless it says the thing it waited on is over. */
export function reasonBy(rows: Comment[], end: number): { cause: CauseId; said: string; at: number } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const n = rows[i];
    if (n.at > end) continue;
    const c = causeOfText(n.body);
    if (!c) continue;
    if (c !== "other_crew" && RESOLVED.test(n.body)) return null;
    return { cause: c, said: n.body, at: n.at };
  }
  return null;
}

export function buildReview(input: ReviewInput): Review {
  const { built, work, tz } = input;
  const saved = input.saved ?? emptySaved();
  const keys = work.shifts.map((w) => `${w.dayKey}:${w.kind}`);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const steps = built.orders.flatMap((o) => o.steps.map((s) => ({ s, order: o })));
  const stepOf = new Map(steps.map((x) => [x.s.id, x]));

  // What each crew moved, shift by shift (work order names).
  const crewOn = new Map<string, Map<string, Set<string>>>();
  for (const w of work.steps.values()) {
    const order = stepOf.get(w.id)?.order.name ?? "";
    for (const k of w.worked) {
      if (!crewOn.has(w.crew)) crewOn.set(w.crew, new Map());
      const m = crewOn.get(w.crew)!;
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)!.add(order);
    }
  }

  const said = commentsByStep(input.notes, (id) => stepOf.has(id));

  // ── Stuck: started, then a whole shift with nothing logged. Equipment
  // out for repair or calibration is a planned step and is listed apart. ──
  const stuck: StuckJob[] = [], service: ServiceJob[] = [];
  for (const w of work.steps.values()) {
    const x = stepOf.get(w.id); if (!x || !w.waits.length) continue;
    const mine = said.get(w.id) ?? [];
    const out: StuckShift[] = [];
    let away: ServiceJob | null = null;
    for (const run of w.waits) {
      const after = w.worked.find((k) => (idx.get(k) ?? -1) > (idx.get(run.to) ?? 1e9));
      const resumeEnd = after ? work.shifts[idx.get(after)!].end : null;
      for (const k of run.keys) {
        const end = work.shifts[idx.get(k)!].end;
        const ans = saved.answers[`stuck:${w.id}:${k}`];
        const elsewhere = [...(crewOn.get(w.crew)?.get(k) ?? [])].filter((n) => n !== x.order.name);
        // The latest comment by the end of the shift that gives a reason.
        const by = reasonBy(mine, end);
        let cause: CauseId | null = by?.cause ?? null, quote: string | null = by?.said ?? null;
        // Else what was written when it picked back up.
        if (!cause && resumeEnd != null) {
          for (const n of mine) {
            if (n.at <= end || n.at > resumeEnd) continue;
            const c = causeOfText(n.body);
            if (c) { cause = c; quote = n.body; break; }
          }
        }
        if (!ans?.cause && cause === "offsite" && by) {
          if (!away) {
            const hrs = /(\d+(?:\.\d+)?)\s*-?\s*(?:hrs?|hours?)\b/i.exec(by.said);
            const dueAt = hrs ? by.at + Number(hrs[1]) * 3_600_000 : null;
            const late = dueAt == null ? undefined : mine.find((n) => n.at > dueAt && causeOfText(n.body) === "offsite" && !RESOLVED.test(n.body));
            away = { id: w.id, name: x.s.name, order: x.order.name, crew: w.crew, shifts: [], said: by.said, sentAt: by.at, dueAt, stillOut: late ? { at: late.at, said: late.body } : null };
          }
          away.shifts.push(k);
          continue;
        }
        if (ans?.cause) out.push({ key: k, cause: ans.cause, said: ans.note?.trim() || quote, crewOn: elsewhere, answered: true });
        else out.push({ key: k, cause: cause ?? (elsewhere.length ? "crew_elsewhere" : "none"), said: quote, crewOn: elsewhere, answered: false });
      }
    }
    if (away) service.push(away);
    if (out.length) stuck.push({ id: w.id, name: x.s.name, order: x.order.name, crew: w.crew, added: w.found, shifts: out });
  }
  stuck.sort((a, b) => b.shifts.length - a.shifts.length || (idx.get(a.shifts[0].key)! - idx.get(b.shifts[0].key)!) || a.name.localeCompare(b.name));

  // ── Ready, not started ──
  const ready: ReadyJob[] = [];
  for (const w of work.steps.values()) {
    const x = stepOf.get(w.id); if (!x || !w.ready?.shifts.length) continue;
    ready.push({ id: w.id, name: x.s.name, order: x.order.name, crew: w.crew, added: w.found, shifts: w.ready.shifts, busyOn: w.ready.busyOn, crewLogged: w.ready.crewLogged, said: saved.answers[`ready:${w.id}`]?.note?.trim() || null });
  }
  ready.sort((a, b) => b.shifts.length - a.shifts.length || (idx.get(a.shifts[0])! - idx.get(b.shifts[0])!) || a.name.localeCompare(b.name));

  const byShiftMap = new Map<string, ShiftCount>();
  const bump = (k: string, f: "stuck" | "ready") => { const c = byShiftMap.get(k) ?? { key: k, stuck: 0, ready: 0 }; c[f]++; byShiftMap.set(k, c); };
  for (const j of stuck) for (const s of j.shifts) bump(s.key, "stuck");
  for (const j of ready) for (const k of j.shifts) bump(k, "ready");
  const byShift = [...byShiftMap.values()].sort((a, b) => idx.get(a.key)! - idx.get(b.key)!);

  // ── Found work ──
  const inScope = new Set(steps.map((x) => x.s.id));
  const found: FoundWork[] = [];
  for (const d of input.discoveries) {
    const mine = d.steps.filter((m) => m.id && inScope.has(m.id));
    if (!mine.length) continue;
    const on = stepOf.get(mine[0].id!)?.order.name ?? d.task?.name ?? "";
    const approver = d.record.approvedBy?.trim() || saved.answers[`approver:${d.record.id}`]?.note?.trim() || null;
    found.push({
      id: d.record.id, what: d.record.what.trim(), kind: d.record.kind === "added" ? "added" : "discovery", on,
      steps: mine.length, done: mine.filter((m) => stepOf.get(m.id!)?.s.status === "done").length,
      hours: r1(Number(d.record.impact?.hours ?? 0)), critical: !!d.record.impact?.critical, foundAt: d.record.foundAt, approvedBy: approver,
    });
  }
  found.sort((a, b) => Number(b.critical) - Number(a.critical) || b.hours - a.hours);

  // ── Holds, as recorded ──
  const holds: HoldFact[] = [];
  for (const s of input.look?.steps ?? []) {
    const x = stepOf.get(s.id); if (!x) continue;
    for (const h of s.holds) if (h.hours >= 0.5) holds.push({ id: s.id, name: x.s.name, order: x.order.name, reason: h.reason.trim(), hours: r1(h.hours), cause: causeOfText(h.reason) });
  }
  holds.sort((a, b) => b.hours - a.hours);

  // ── The numbers ──
  const all = steps.map((x) => x.s);
  const base = all.filter((s) => s.inPlan), add = all.filter((s) => !s.inPlan);
  const baselineH = r1(base.reduce((n, s) => n + s.plannedH, 0)), addedH = r1(add.reduce((n, s) => n + s.plannedH, 0));
  const causeMap = new Map<CauseId, { shifts: number; jobs: Set<string> }>();
  for (const j of stuck) for (const s of j.shifts) {
    const c = causeMap.get(s.cause) ?? { shifts: 0, jobs: new Set<string>() };
    c.shifts++; c.jobs.add(jobWord(j)); causeMap.set(s.cause, c);
  }
  const byCause = [...causeMap.entries()].map(([cause, v]) => ({ cause, shifts: v.shifts, jobs: [...v.jobs] })).sort((a, b) => Number(unexplained(a.cause)) - Number(unexplained(b.cause)) || b.shifts - a.shifts);
  const stuckShifts = stuck.reduce((n, j) => n + j.shifts.length, 0), readyShifts = ready.reduce((n, j) => n + j.shifts.length, 0);

  // Labor hours: counted (or the contractor's planned) hands times tool
  // hours, shared across what each crew moved. Only when most crew-shifts
  // that moved work have hands to go by.
  let withHands = 0, moving = 0, totalMH = 0, addedMH = 0;
  for (const c of work.crews) {
    for (const [k, x] of Object.entries(c.byShift)) {
      if (!x.moved) continue;
      moving++;
      const hands = x.counted?.direct ?? x.counted?.total ?? x.planned?.direct ?? null;
      if (!hands) continue;
      withHands++;
      const mh = hands * (k.endsWith(":night") ? work.toolHours.night : work.toolHours.day);
      totalMH += mh;
      const mine = [...work.steps.values()].filter((w) => w.crew === c.crew && w.worked.includes(k));
      const earned = mine.reduce((n, w) => n + (w.earned[k] ?? 0), 0);
      for (const w of mine) if (w.found) addedMH += earned > 0 ? mh * ((w.earned[k] ?? 0) / earned) : mh / mine.length;
    }
  }
  const labor = moving > 0 && withHands / moving >= 0.8 && totalMH > 0 ? { totalMH: Math.round(totalMH), addedMH: Math.round(addedMH), pct: Math.round((addedMH / totalMH) * 100) } : null;

  const atOnce = byShift.map((c) => c.stuck + c.ready);
  const metrics: ReviewMetrics = {
    start: built.start ?? built.planStart, baselineFinish: built.planFinish, actualFinish: built.finish,
    varianceH: built.finish != null && built.planFinish != null ? r1((built.finish - built.planFinish) / 3_600_000) : null,
    done: built.steps > 0 && built.done === built.steps,
    steps: all.length, stepsDone: all.filter((s) => s.status === "done").length,
    baselineSteps: base.length, baselineDone: base.filter((s) => s.status === "done").length,
    addedSteps: add.length, addedDone: add.filter((s) => s.status === "done").length,
    findings: found.length, baselineH, addedH, addedPct: baselineH > 0 ? Math.round((addedH / baselineH) * 100) : null,
    shifts: keys.length, dayShifts: keys.filter((k) => k.endsWith(":day")).length,
    shiftsWithStuck: byShift.length, leastAtOnce: atOnce.length ? Math.min(...atOnce) : 0, mostAtOnce: atOnce.length ? Math.max(...atOnce) : 0,
    stuckJobs: stuck.length, stuckShifts, readyJobs: ready.length, readyShifts,
    byCause, noReasonShifts: byCause.filter((c) => unexplained(c.cause)).reduce((n, c) => n + c.shifts, 0),
    labor, headCounts: { counted: withHands, of: moving },
  };

  // ── Questions: what the records don't say ──
  const questions: Question[] = [];
  let answeredCount = 0;
  for (const j of stuck) {
    for (const s of j.shifts) {
      if (s.answered) { answeredCount++; continue; }
      if (!unexplained(s.cause)) continue;
      const where = s.crewOn.length ? ` Its crew (${j.crew}) was on ${list(s.crewOn.map(orderWord))}.` : ` ${j.crew} logged no work that shift.`;
      questions.push({ key: `stuck:${j.id}:${s.key}`, kind: "stuck", answer: "cause", findingKey: "execution", ask: `${jobWord(j)} had started and sat the ${shiftWord(s.key)} shift with no reason logged.${where} Why did it sit?` });
    }
  }
  for (const j of ready) {
    if (j.said) { answeredCount++; continue; }
    if (j.crewLogged) continue;
    questions.push({ key: `ready:${j.id}`, kind: "ready", answer: "text", findingKey: "contractors", ask: `${jobWord(j)} was ready for ${plural(j.shifts.length, "shift")} (${shiftsWord(j.shifts)}) and ${j.crew} logged no work then. What happened?` });
  }
  for (const f of found) {
    if (f.approvedBy) { if (saved.answers[`approver:${f.id}`]?.note) answeredCount++; continue; }
    questions.push({ key: `approver:${f.id}`, kind: "approver", answer: "text", findingKey: "scope", ask: `"${short(f.what)}" (${tagOf(f.on)}) has no approver recorded. Who approved it?` });
  }

  // ── The findings ──
  const finish = finishStory(built, said, (id) => work.steps.get(id)?.crew ?? "");
  const flows = crewFlows(built, work, input.dependsOn);
  const drafts = draftFindings({ metrics, stuck, ready, found, holds, built, work, tz, finish, service, flows, materials: input.materials ?? null, organization: input.organization ?? null });
  const findings: Finding[] = drafts.map((d) => overlay(d, saved.items[d.key]));
  for (const a of saved.added) {
    const it = saved.items[`added:${a.id}`];
    findings.push({
      key: `added:${a.id}`, category: a.category, source: "person", rating: a.rating ?? "opportunity",
      title: a.title?.trim() || "Finding", observation: a.observation?.trim() ?? "", evidence: [],
      practice: a.practice?.trim() || PRACTICE_OF[a.category], gap: a.gap?.trim() ?? "", next: a.next?.trim() ?? "", year: a.year?.trim() ?? "", owner: a.owner?.trim() ?? "", effect: a.effect?.trim() ?? "", moved: null, proof: (a.observation ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "",
      why: a.why?.trim() || [a.effect?.trim(), (a.observation ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0]].filter(Boolean).join(". ").replace(/\.\.$/, "."), hours: null,
      info: it?.info ?? [], status: it?.status === "discarded" ? "discarded" : "kept", edited: false, stale: false,
      drafted: { title: a.title?.trim() || "Finding", observation: a.observation?.trim() ?? "", rating: a.rating ?? "opportunity" }, by: a.by, at: a.at,
    });
  }
  const order = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  const weight: Record<Rating, number> = { gap: 0, opportunity: 1, strength: 2, none: 3 };
  const moved = (f: Finding) => 3 - (f.moved ?? 0);
  findings.sort((a, b) => weight[a.rating] - weight[b.rating] || moved(a) - moved(b) || (b.hours ?? 0) - (a.hours ?? 0) || order.get(a.category)! - order.get(b.category)!);

  const live = findings.filter((f) => f.status !== "discarded");
  const strengths = strengthsOf(metrics, found, holds, live);
  return {
    metrics, finish, service, stuck, ready, byShift, found, holds, findings, flows, questions, answeredCount, strengths,
    qa: qaOf(metrics, found, stuck, tz, finish, flows.filter(overloaded)),
    measures: measuresOf(metrics, saved.targets),
    organization: input.organization?.recorded ? input.organization : null,
    definitions: DEFINITIONS,
  };
}

/** A person's keep, change or throw-out laid over the draft. */
function overlay(d: Draft, it: SavedItem | undefined): Finding {
  const e = it?.edits ?? {};
  const pick = (v: string | undefined, was: string) => (v != null && v.trim() ? v.trim() : was);
  const edited = Object.values(e).some((v) => v != null && String(v).trim() !== "");
  const basis = hash(`${d.title}|${d.observation}|${d.rating}`);
  return {
    key: d.key, category: d.category, source: "records",
    rating: e.rating ?? d.rating, title: pick(e.title, d.title), observation: pick(e.observation, d.observation), evidence: d.evidence,
    practice: pick(e.practice, d.practice), gap: pick(e.gap, d.gap), next: pick(e.next, d.next), year: pick(e.year, d.year), owner: pick(e.owner, d.owner), effect: pick(e.effect, d.effect), moved: d.moved, proof: d.proof, why: pick(e.why, d.why || [d.proof, d.effect].filter(Boolean).join(" ")), hours: d.hours,
    info: it?.info ?? [], status: it?.status ?? "draft", edited,
    stale: !!it?.basis && it.basis !== basis && (edited || it.status === "kept"),
    drafted: { title: d.title, observation: d.observation, rating: d.rating }, by: it?.by ?? null, at: it?.at ?? null,
  };
}
/** The mark a keep or a change carries, to notice the records moving after. */
export const basisOf = (f: Pick<Finding, "drafted">) => hash(`${f.drafted.title}|${f.drafted.observation}|${f.drafted.rating}`);

// ─── The categories: leading practice, the gap, how it closes ──────

interface Draft {
  /** The category's own finding carries the category's id; one split out of
   *  it (another work order, another cause) adds what it is: "planning:cleaning". */
  key: string; category: CategoryId; rating: Rating; title: string; observation: string; evidence: string[];
  practice: string; gap: string; next: string; year: string; owner: string; effect: string; moved: Moved | null; proof: string; why: string; hours: number | null;
}

/** How each category is done well: what a finding is held against. */
export const PRACTICE_OF: Record<CategoryId, string> = {
  organization: "One person runs the event, and each part of it (planning, materials, each area) has a named person with written duties.",
  scope: "Scope is built from inspection history and operating data, checked and frozen on a set date. Work found later goes through one approval, with time and money carried for it.",
  planning: "The schedule carries every step at the time it really takes, gas-freeing and cleaning included, and each job's known risks have a plan and resources arranged ahead.",
  materials: "Every part and off-site repair is specified, ordered, owned and dated on one list, and checked against each job before the unit comes down.",
  contractors: "Each contractor's crew is sized to the most work the schedule hands it at once, with extra crew agreed ahead for the days it peaks.",
  execution: "A daily control meeting goes through every job that is waiting or ready, and every delay gets its reason written when it happens.",
  safety: "Permits, isolation and gas testing control every entry, and anyone stops the job when conditions change.",
  records: "The event is recorded as it runs (progress, delays with reasons, added work with approval, head counts) so the review rests on facts.",
};

/** Who owns each category's follow-up: the person named in that role on
 *  the project's event organization. None recorded, none named. */
const OWNER_ROLE: Record<CategoryId, RegExp> = {
  organization: /steering|turnaround manager/i, scope: /planning|preparation/i, planning: /planning|preparation/i, materials: /logistic|material/i,
  contractors: /area coordinator/i, execution: /area coordinator/i, safety: /hse|safety/i, records: /turnaround manager/i,
};
function ownerOf(key: CategoryId, org: OrgStanding | null): string {
  const r = org?.recorded ? org.roles.find((x) => x.person.trim() && OWNER_ROLE[key].test(x.role)) : undefined;
  return r ? `${r.person.trim()} (${r.role})` : "";
}

const HOUR = 3_600_000;
const CHATTER = /^(progress\b|actual times corrected)/i;

/** What set the finish: the last work done, how far behind its plan and the
 *  rest it was, and the steps in it that ran long, with what was written. */
function finishStory(built: AsBuilt, said: Map<string, Comment[]>, crewOf: (id: string) => string): FinishStory | null {
  if (built.finish == null || built.planFinish == null || built.done < built.steps) return null;
  const done = built.orders.filter((o) => o.finish != null && o.steps.length).sort((a, b) => b.finish! - a.finish!);
  if (!done.length) return null;
  let closing: FinishStory["closing"] = null, rest = done;
  // The work that closes the event (start-up) began late because the rest wasn't done.
  const L = done[0], lStart = L.start ?? L.barStart;
  if (done.length > 1 && L.planStart != null && lStart != null && lStart - L.planStart >= HOUR && done[1].finish! > L.planStart) {
    const planned = L.planFinish != null ? (L.planFinish - L.planStart) / HOUR : null;
    closing = { order: L.name, planStart: L.planStart, start: lStart, lateH: r1((lStart - L.planStart) / HOUR), longerH: planned == null ? null : r1((L.finish! - lStart) / HOUR - planned) };
    rest = done.slice(1);
  }
  const top = rest[0];
  const steps = top.steps.filter((x) => x.elapsedH != null && x.elapsedH - x.plannedH >= 2).sort((a, b) => (b.elapsedH! - b.plannedH) - (a.elapsedH! - a.plannedH)).slice(0, 3)
    .map((x) => ({ name: x.name, crew: crewOf(x.id), plannedH: r1(x.plannedH), tookH: r1(x.elapsedH!), said: (said.get(x.id) ?? []).filter((c) => !CHATTER.test(c.body) && causeOfText(c.body)).map((c) => c.body).slice(0, 2) }));
  let cause: CauseId | null = null, because: FinishStory["because"] = null;
  for (const st of top.steps) for (const c of said.get(st.id) ?? []) { const k = causeOfText(c.body); if (k && !CHATTER.test(c.body) && c.at < (because?.at ?? Infinity)) { cause = k; because = { step: st.name, crew: crewOf(st.id), said: c.body, at: c.at }; } }
  return {
    lateH: r1((built.finish - built.planFinish) / HOUR),
    last: rest.slice(0, 3).map((o) => ({ order: o.name, finish: o.finish!, planFinish: o.planFinish, lateH: o.varianceH })),
    aheadH: rest.length > 1 ? r1((rest[0].finish! - rest[1].finish!) / HOUR) : null, closing, steps, cause, because,
  };
}
/** The last work to finish, and by how much. */
export function lastLine(f: FinishStory, tz: string): string {
  const [top, next] = f.last;
  return `${orderWord(top.order)} was the last work to finish: ${whenWord(top.finish, tz)}${top.lateH != null ? `, ${top.lateH} h after its plan` : ""}${next && f.aheadH != null ? ` and ${f.aheadH} h after ${orderWord(next.order)}, the work before it` : ""}.`;
}
/** What was written on it first that gives a reason, with the step and crew. */
export const becauseLine = (f: FinishStory): string => (f.because ? `Recorded on ${f.because.step}${f.because.crew ? ` (${f.because.crew})` : ""}: "${f.because.said}"` : "");
/** The work that closes the event (start-up), when it began late. */
export const closingLine = (f: FinishStory): string => { const c = f.closing; return c ? `${orderWord(c.order)} began ${c.lateH} h after its planned start${c.longerH != null && Math.abs(c.longerH) >= 1 ? ` and ran ${Math.abs(c.longerH)} h ${c.longerH > 0 ? "longer" : "shorter"} than planned` : ""}.` : ""; };
/** The finish story as lines: what was last, what was written, and the steps that ran long. */
export function finishLines(f: FinishStory, tz: string): string[] {
  const out = [lastLine(f, tz), becauseLine(f)];
  for (const st of f.steps) {
    const more = st.said.filter((t) => t !== f.because?.said);
    out.push(`${st.name}${st.crew ? ` (${st.crew})` : ""}: planned ${st.plannedH} h, took ${st.tookH} h.${more.length ? ` Recorded: ${more.map((t) => `"${t}"`).join(" Then: ")}` : ""}`);
  }
  return out.filter(Boolean);
}
/** What a set of work orders cost the finish. 3: the records name this as
 *  what set it (`named`). 2: it is on the last work to finish. 1: it is on
 *  work that finished late but not last. 0: nothing. */
function effectOf(orders: string[], f: FinishStory | null, named = false): { level: Moved; text: string } {
  if (!f || !f.last.length) return { level: 0, text: "" };
  const [top, next] = f.last;
  if (orders.includes(top.order)) {
    const last = `${orderWord(top.order)} was the last work done${next && f.aheadH != null ? `, ${f.aheadH} h after ${orderWord(next.order)}` : ""}.`;
    return named ? { level: 3, text: `Set the finish: ${last}` } : { level: 2, text: `On ${orderWord(top.order)}, the last work to finish.` };
  }
  const hit = f.last.slice(1).find((o) => orders.includes(o.order) && (o.lateH ?? 0) >= 1);
  if (hit) return { level: 1, text: `${orderWord(hit.order)} finished ${hit.lateH} h after its plan. ${orderWord(top.order)} finished later, so ${orderWord(hit.order)} did not set the finish.` };
  return { level: 0, text: "Did not move the finish." };
}

function draftFindings(x: { metrics: ReviewMetrics; stuck: StuckJob[]; ready: ReadyJob[]; found: FoundWork[]; holds: HoldFact[]; built: AsBuilt; work: AsBuiltWork; tz: string; finish: FinishStory | null; service: ServiceJob[]; flows: CrewFlow[]; materials: ReviewInput["materials"]; organization: OrgStanding | null }): Draft[] {
  const { metrics: m, stuck, ready, found, holds, finish: fin, service } = x;
  // The observation is a list of facts, one a line, each a whole sentence.
  // The gap and what to do next time are said about this event, not in general.
  // One finding is one thing: a work order (or the jobs that share one cause),
  // what it cost, and what to do about that. Different work orders with
  // different causes are never folded into one finding.
  const make = (key: string, rating: Rating, title: string, lines: string[], evidence: string[], over: Partial<Draft> = {}): Draft => ({
    key, category: key.split(":")[0] as CategoryId, rating, title, observation: lines.map((l) => l.trim()).filter(Boolean).join("\n"), evidence,
    practice: PRACTICE_OF[key.split(":")[0] as CategoryId], owner: ownerOf(key.split(":")[0] as CategoryId, x.organization), gap: "", next: "", year: "", effect: "", moved: null, proof: lines.map((l) => l.trim()).filter(Boolean)[0] ?? "", why: "", hours: null, ...over,
  });
  /** "V-7 finished 8 h after its plan." for the first of these work orders that finished late. */
  const lateLine = (orders: string[]): string => { const hit = fin?.last.find((o) => orders.includes(o.order) && (o.lateH ?? 0) >= 1); return hit ? `${orderWord(hit.order)} finished ${hit.lateH} h after its plan.` : ""; };
  const day = (t: number) => fmtInTz(t, x.tz, { month: "numeric", day: "numeric" });
  const rated = (level: Moved, floor: Rating = "none"): Rating => (level === 3 ? "gap" : level ? "opportunity" : floor);
  const shiftsOf = (c: CauseId) => stuck.flatMap((j) => j.shifts.filter((s) => s.cause === c).map((s) => ({ j, s })));
  const byJob = (c: CauseId) => {
    const by = new Map<string, { j: StuckJob; ks: string[]; said: string | null }>();
    for (const { j, s } of shiftsOf(c)) { const e = by.get(j.id) ?? { j, ks: [], said: null }; e.ks.push(s.key); e.said = e.said ?? s.said; by.set(j.id, e); }
    return [...by.values()];
  };
  const sat = (c: CauseId, why: string) => byJob(c).map((e) => `${jobWord(e.j)} (${e.j.crew}): sat ${plural(e.ks.length, "shift")} (${shiftsWord(e.ks)}) ${why}.${e.said ? ` Recorded: "${e.said}"` : ""}`);
  const ordersOf = (c: CauseId) => byJob(c).map((e) => e.j.order);
  const tags = (orders: string[]) => list([...new Set(orders.map(orderWord))]);
  const top = fin?.last[0] ?? null;
  const out: Draft[] = [];

  const names = (jobs: Array<{ name: string; order: string }>) => list([...new Set(jobs.map((j) => jobWord(j)))]);
  const NONE = "Did not move the finish.";

  // Materials and logistics. A shortfall is one finding; equipment still out
  // for service past the time quoted is another (different work orders).
  {
    const overdue = service.filter((j) => j.stillOut);
    const short = !!(fin && top && fin.cause === "material");
    const waited = byJob("material");
    const r = x.materials;
    const reg = r && r.lines > 0 ? `Materials register: ${plural(r.lines, "line")}; ${r.specIncomplete} with an incomplete specification; ${r.late} short or late; ${plural(r.openQuestions, "question")} open more than 24 h.` : "";
    const bad = r ? r.specIncomplete + r.late + r.openQuestions : 0;
    if (!short && !waited.length && !bad) out.push(make("materials", reg ? "strength" : "none", reg ? "Materials were ready when the work needed them" : "No job waited on materials", ["No job is recorded as waiting on materials.", reg], []));
    else {
      const e = effectOf([...(short ? [top!.order] : []), ...waited.map((w) => w.j.order)], fin, short);
      const lines = [...(short ? finishLines(fin!, x.tz) : []), ...sat("material", "waiting on materials"), reg || "No materials register was kept for this event."];
      out.push(make("materials", rated(e.level, "opportunity"), short ? `A material shortfall on ${orderWord(top!.order)} set the finish` : waited.length ? `${names(waited.map((w) => w.j))} waited on materials` : "The materials register has open items", lines, [], {
        effect: short || waited.length ? e.text : "", moved: short || waited.length ? e.level : null, ...(short && becauseLine(fin!) ? { proof: becauseLine(fin!) } : {}),
        ...(short ? { hours: fin!.lateH, why: `${orderWord(top!.order)} set the finish, ${fin!.lateH} h past the baseline.${fin!.steps[0] ? ` ${fin!.steps[0].name} took ${fin!.steps[0].tookH} h against ${fin!.steps[0].plannedH} h planned.` : ""}` } : {}),
        gap: short ? `What ${orderWord(top!.order)} needed was not counted against what was ordered before the event.` : waited.length ? "Material was not all in hand when the job needed it." : "",
        next: "Before the unit comes down, count the parts each job needs against what was ordered, and close any shortfall.",
      }));
    }
    if (overdue.length) {
      const lateBack = !!(fin && top && fin.cause === "offsite" && overdue.some((j) => j.order === top.order));
      const e = effectOf(overdue.map((j) => j.order), fin, lateBack);
      const lines = [...(lateBack ? finishLines(fin!, x.tz) : []), ...overdue.map((j) => `${jobWord(j)}: went out for service as planned ("${j.said}"). It was still out past the time quoted: "${j.stillOut!.said}" (${whenWord(j.stillOut!.at, x.tz)}).`)];
      const svc = list(overdue.map((j) => (TAG.test(tagOf(j.order)) ? orderWord(j.order) : jobWord(j))));
      out.push(make("materials:service", rated(e.level), lateBack ? `Equipment back late from service set the finish on ${orderWord(top!.order)}` : `${svc}: still out for service past the time quoted`, lines, [], {
        effect: e.text, moved: fin ? e.level : null,
        ...(e.level ? { gap: "The quoted return time passed with the equipment still out." } : {}),
        next: "When equipment goes out for service, get the return date in writing and check on it the day before it is due.",
      }));
    }
  }

  // Planning and scheduling: time the plan did not carry. Gas-freeing, a
  // line that had to be cleaned, and a failed test are each their own finding.
  {
    const gas = holds.filter((h) => h.cause === "permit");
    const gasH = r1(gas.reduce((n, h) => n + h.hours, 0));
    const named = (c: CauseId) => !!(fin && top && fin.cause === c);
    const before = out.length;
    if (gas.length || named("permit")) {
      const drove = named("permit");
      const e = effectOf([...(drove ? [top!.order] : []), ...gas.map((h) => h.order)], fin, drove);
      const lines = [...(drove ? finishLines(fin!, x.tz) : []), ...gas.map((h) => `${jobWord(h)}: held ${h.hours} h. Recorded: "${h.reason}"`)];
      const where = gas.length ? tags(gas.map((h) => h.order)) : orderWord(top!.order);
      out.push(make("planning", rated(e.level, gasH >= 12 ? "opportunity" : "none"), drove ? `${orderWord(top!.order)} set the finish: gas-freeing` : `Gas-freeing ${where} took ${gasH} h the plan did not carry`, lines, [], {
        effect: e.text, moved: fin ? e.level : null, ...(drove && becauseLine(fin!) ? { proof: becauseLine(fin!) } : {}),
        hours: gasH || null, ...(gas.length ? { why: [`${where} was held ${gasH} h for gas-freeing that was not in the schedule.`, lateLine(gas.map((h) => h.order))].filter(Boolean).join(" ") } : {}),
        gap: "The schedule had no time for gas testing and air stripping before entry.",
        next: gas.length ? `Schedule gas-freeing as its own activity before entry, at the time it took here (${gasH} h on ${where}).` : `Schedule gas-freeing as its own activity before entry on ${where}.`,
      }));
    }
    const waits: Array<[CauseId, string, string, string, (where: string) => string, (where: string) => string]> = [
      ["cleaning", "planning:cleaning", "until a line was cleaned", "a line had to be cleaned first", () => "The plugged line was found after the job had started.", (w) => `Plan line cleaning into the job on ${w}: the line was found plugged this event.`],
      ["test", "planning:test", "on a leak or a failed test", "a leak or failed test", () => "The plan had no time for a failed test and the rework after it.", (w) => `Put a re-test and its rework in the plan for ${w}.`],
    ];
    for (const [cause, key, why, word, gap, next] of waits) {
      const jobs = byJob(cause), drove = named(cause);
      if (!jobs.length && !drove) continue;
      const orders = [...(drove ? [top!.order] : []), ...jobs.map((w) => w.j.order)];
      const e = effectOf(orders, fin, drove);
      const lines = [...(drove ? finishLines(fin!, x.tz) : []), ...sat(cause, why)];
      const shifts = jobs.reduce((n, w) => n + w.ks.length, 0);
      out.push(make(key, rated(e.level), drove ? `${orderWord(top!.order)} set the finish: ${word}` : `${names(jobs.map((w) => w.j))} sat ${shifts === 1 ? "a shift" : `${shifts} shifts`} ${why}`, lines, [], {
        effect: e.text, moved: fin ? e.level : null, ...(drove && becauseLine(fin!) ? { proof: becauseLine(fin!) } : {}),
        ...(e.level ? { gap: gap(tags(orders)) } : {}), next: next(tags(orders)),
      }));
    }
    if (out.length === before) out.push(make("planning", "none", "No planning finding in the records", ["No holds for gas testing or decontamination, and no job sat waiting on cleaning or a failed test."], []));
  }

  // Scope definition: work found during the event.
  {
    const ev = found.map((f) => `${f.what} (${tagOf(f.on)}): ${plural(f.steps, "activity", "activities")}, about ${f.hours} h of work when approved${f.critical ? ", on the critical path" : ""}${f.approvedBy ? `, approved by ${f.approvedBy}` : ", no approver recorded"}`);
    if (!found.length) out.push(make("scope", m.steps ? "strength" : "none", "Scope held through the event", [m.steps ? `All ${m.baselineSteps} planned activities; no work was added during the event.` : "No schedule to read."], []));
    else {
      const crit = found.filter((f) => f.critical);
      const total = `${plural(m.addedSteps, "activity was", "activities were")} added from ${plural(found.length, "finding")}${m.addedPct != null ? `: ${m.addedH} h of work on a ${m.baselineH} h plan (${m.addedPct}% more), by the schedule's estimates` : ""}.`;
      const lines = [...crit.map((f) => `On the critical path, ${tagOf(f.on)}: ${short(f.what)}. About ${f.hours} h.`), total, ...found.filter((f) => !f.critical).map((f) => `${tagOf(f.on)}: ${short(f.what)}. About ${f.hours} h.`)];
      const e = effectOf(crit.map((f) => f.on), fin);
      // What to check is the equipment the critical-path work was found on.
      const where = tags((crit.length ? crit : found).map((f) => f.on));
      out.push(make("scope", rated(e.level, (m.addedPct ?? 0) >= 10 ? "opportunity" : "none"), crit.length ? `Found work on the critical path of ${tags(crit.map((f) => f.on))}: ${plural(crit.reduce((n, f) => n + f.steps, 0), "activity", "activities")}, ${r1(crit.reduce((n, f) => n + f.hours, 0))} h (${m.addedSteps} added in all, ${m.addedH} h)` : `Found work added ${plural(m.addedSteps, "activity", "activities")}, ${m.addedH} h, none on the critical path`, lines, ev, {
        effect: crit.length ? e.text : NONE, moved: crit.length ? e.level : 0, hours: m.addedH,
        why: [`Found work added ${m.addedH} h to a ${m.baselineH} h plan${m.addedPct != null ? ` (${m.addedPct}%)` : ""}${crit.length ? `; ${r1(crit.reduce((n, f) => n + f.hours, 0))} h of it on the critical path of ${tags(crit.map((f) => f.on))}` : ""}.`, lateLine(crit.map((f) => f.on))].filter(Boolean).join(" "),
        gap: "These conditions were not known when the scope was set.",
        next: `Before scope freeze, check the condition of ${where}: inspection history, thickness readings, and what operations sees fouling. Carry time for found work: this event added ${m.addedH} h.`,
      }));
    }
  }

  // Contractors and resourcing. Ready work that waited for a crew is one
  // finding; a job that waited on another crew is another. Nothing is said
  // about head count the records don't show.
  {
    const late = (o: string) => !!fin && fin.last.some((l, i) => l.order === o && (i === 0 || (l.lateH ?? 0) >= 1));
    const hand = byJob("other_crew");
    const handNamed = !!(fin && top && fin.cause === "other_crew");
    // A crew that could not keep up with what was handed to it.
    const jams = x.flows.filter(overloaded).slice(0, 2);
    const jammed = new Set(jams.map((f) => f.crew));
    for (const f of jams) {
      const early = f.waited.filter((j) => (j.openedEarlyH ?? 0) >= 8);
      const back = x.flows.find((g) => g.crew === f.feeder)?.waited.filter((j) => j.from === f.crew && j.waitH >= 12) ?? [];
      const touched = [...f.waited, ...f.together.flat()];
      const e = effectOf([...new Set(touched.map((j) => j.order))], fin);
      const slow = top ? f.together.find((g) => g.some((j) => j.order === top.order)) : undefined;
      const mine = slow?.find((j) => j.order === top!.order);
      const lines = [
        `At ${whenWord(f.peak.at, x.tz)}, ${plural(f.peak.open, "job")} ${f.peak.open === 1 ? "was" : "were"} open for ${f.crew} at once${f.plannedPeak ? `; the plan gave it ${f.plannedPeak} at most` : ""}. ${f.peak.working.length ? `It was working ${tags(f.peak.working.map((j) => j.order))}` : "It had started none of them"}${f.peak.waiting.length ? `; ${tags(f.peak.waiting.map((j) => j.order))} waited` : ""}.`,
        f.burst.jobs.length >= 3 ? `${f.burst.jobs.length} of them opened within ${f.burst.hours} h on ${day(f.burst.jobs[0].openedAt)}.` : "",
        `In all, ${plural(f.jobs.length, "job")} ${f.jobs.length === 1 ? "was" : "were"} handed to ${f.crew}. They sat open ${f.waitH} h before it started them: ${f.waited.map((j) => `${jobWord(j)} ${j.waitH} h`).join("; ")}.`,
        ...f.together.map((g) => `${f.crew} worked ${names(g)} at the same time: ${g.map((j) => `${j.tookH} h`).join(" and ")} against ${g.map((j) => `${j.plannedH} h`).join(" and ")} planned.`),
        early.length ? `${names(early)} ${early.length === 1 ? "was" : "were"} opened ${early.map((j) => j.openedEarlyH).join(" and ")} h ahead of plan and sat until ${f.crew} was free.` : "",
        `The same ${plural(f.jobs.length, "job")}, taken in the order they opened at the hours each took: one crew working without a break leaves ${f.queue.one} h of waiting; two crews leave ${f.queue.two} h.`,
        back.length ? `Once ${f.crew} was done, ${back.map((j) => `${jobWord(j)} waited ${j.waitH} h`).join("; ")} for ${f.feeder} to start.` : "",
        f.feederOutput.length >= 3 ? `${f.feeder} finished ${f.feederOutput.map((o) => `${o.earned} (${shiftWord(o.key).replace(" day", "")})`).join(", ")} planned hours of work on those day shifts.` : "",
      ];
      const span = [...new Set([day(f.burst.jobs[0]?.openedAt ?? f.peak.at), day(Math.max(...f.waited.map((j) => j.startedAt)))])].join(" to ");
      out.push(make(`contractors:crew:${f.crew.toLowerCase().replace(/[^a-z0-9]+/g, "")}`, rated(e.level, "opportunity"), `Not enough ${f.crew} for the equipment that was open: ${plural(f.peak.open, "job")} at once, ${f.waitH} h of waiting`, lines, f.waited.map((j) => `${jobWord(j)}: open ${whenWord(j.openedAt, x.tz)}, started ${whenWord(j.startedAt, x.tz)}, sat ${j.waitH} h${j.crewOn.length ? `; ${f.crew} was on ${tags(j.crewOn)}` : ""}`), {
        effect: mine ? `Slowed ${orderWord(top!.order)}, the last work to finish: its ${f.crew} step took ${mine.tookH} h against ${mine.plannedH} h planned, worked alongside ${tags(slow!.filter((j) => j !== mine).map((j) => j.order))}.` : e.text,
        moved: fin ? (mine ? 2 : e.level) : null, hours: f.waitH,
        why: `${plural(f.peak.open, "job")} ${f.peak.open === 1 ? "was" : "were"} open for ${f.crew} at once${f.plannedPeak ? ` against ${f.plannedPeak} in the plan` : ""}, and equipment sat open ${f.waitH} h waiting. One crew working without a break still leaves ${f.queue.one} h of waiting; two leave ${f.queue.two} h.`,
        gap: `${f.crew} was planned for ${f.plannedPeak || "fewer"} jobs at once and had ${f.peak.open}.`,
        next: `Bring another ${f.crew} crew for the days equipment opens (${span}), or open equipment only as fast as ${f.crew} can take it.${early.length ? " Opening ahead of plan gained nothing here." : ""}`,
      }));
    }
    // Ready work that waited, other than what a crew above already tells.
    const idle = ready.filter((j) => !jammed.has(j.crew));
    if (!idle.length && !hand.length && !handNamed && !jams.length) out.push(make("contractors", m.steps ? "strength" : "none", "Crews picked up ready work without delay", ["No job sat a full shift ready and not started, and none waited on another crew."], []));
    if (idle.length) {
      const lines: string[] = [], ev: string[] = [];
      for (const j of idle) {
        const on = [...new Set(j.busyOn.map(orderWord))];
        lines.push(`${jobWord(j)}: ready and not started for ${plural(j.shifts.length, "shift")} (${shiftsWord(j.shifts)}). ${on.length ? `${j.crew} was on ${list(on)}` : j.crewLogged ? `${j.crew} was on other work` : `${j.crew} logged no work then`}.`);
        ev.push(`${jobWord(j)} (${j.crew}): ready ${whenWord(x.work.steps.get(j.id)!.ready!.at, x.tz)}, not started for ${plural(j.shifts.length, "shift")} (${shiftsWord(j.shifts)})${j.said ? `. Answer: "${j.said}"` : ""}`);
      }
      const e = effectOf(idle.map((j) => j.order), fin);
      const jobs = idle.filter((j) => late(j.order));
      if (e.level > 0 && jobs.length) {
        const crews = list([...new Set(jobs.map((j) => j.crew))]);
        out.push(make("contractors", rated(e.level), `Ready work on ${tags(jobs.map((j) => j.order))} waited for a crew`, lines, ev, {
          effect: e.text, moved: e.level, proof: lines.find((l) => jobs.some((j) => l.startsWith(jobWord(j)))) ?? lines[0],
          gap: `${names(jobs)} was ready and ${crews} was on other work.`,
          next: `Put ${crews}'s jobs in the order the finish needs, so work on ${tags(jobs.map((j) => j.order))} starts when it is ready.`,
        }));
      } else out.push(make("contractors", "none", "Ready work waited for a crew", lines, ev, { effect: fin ? NONE : "", moved: fin ? 0 : null }));
    }
    if (hand.length || handNamed) {
      const orders = [...(handNamed ? [top!.order] : []), ...hand.map((h) => h.j.order)];
      const e = effectOf(orders, fin, handNamed);
      const lines = [...(handNamed ? finishLines(fin!, x.tz) : []), ...sat("other_crew", "waiting on another crew")];
      const shifts = hand.reduce((n, h) => n + h.ks.length, 0);
      out.push(make("contractors:handoff", rated(e.level), handNamed ? `${orderWord(top!.order)} set the finish waiting on another crew` : `${names(hand.map((h) => h.j))} waited ${shifts === 1 ? "a shift" : `${shifts} shifts`} on another crew`, lines, [], {
        effect: e.text, moved: fin ? e.level : null, ...(handNamed && becauseLine(fin!) ? { proof: becauseLine(fin!) } : {}),
        ...(e.level ? { gap: "The next crew was not lined up for when the job was ready for it." } : {}),
        next: hand.length ? `At the shift meeting, name the jobs that will be ready for another crew that day and when (here: ${names(hand.map((h) => h.j))}).` : "At the shift meeting, name the jobs that will be ready for another crew that day and when.",
      }));
    }
  }

  // Execution control: started jobs that sat and are not told by their
  // reason in a finding of their own (no reason written, or another reason).
  {
    const told = new Set<CauseId>(["material", "cleaning", "test", "other_crew"]);
    const mine = stuck.map((j) => ({ j, shifts: j.shifts.filter((sh) => !told.has(sh.cause)) })).filter((e) => e.shifts.length);
    if (m.stuckShifts === 0) out.push(make("execution", m.steps ? "strength" : "none", "Started work kept moving", ["No started job sat a full shift with nothing logged."], []));
    else if (!mine.length) out.push(make("execution", "none", "Every job that sat has its reason on record", [`${plural(m.stuckJobs, "started job")} sat a shift. Each has a reason on record and is told in its own finding.`], []));
    else {
      const e = effectOf(mine.map((x2) => x2.j.order), fin);
      const count = mine.reduce((n, x2) => n + x2.shifts.length, 0);
      const blank = mine.every((x2) => x2.shifts.every((sh) => unexplained(sh.cause)));
      const lines = mine.map(({ j, shifts }) => `${jobWord(j)} (${j.crew}): sat ${plural(shifts.length, "shift")} (${shiftsWord(shifts.map((sh) => sh.key))}). ${[...new Set(shifts.map((sh) => `${CAUSE_WORD[sh.cause]}${sh.said ? `: "${sh.said}"` : sh.crewOn.length ? ` (crew on ${list([...new Set(sh.crewOn.map(orderWord))])})` : ""}`))].join(" Then: ")}.`);
      const ev = mine.map(({ j, shifts }) => `${jobWord(j)} (${j.crew}): ${shifts.map((sh) => `${shiftWord(sh.key)}, ${CAUSE_WORD[sh.cause].toLowerCase()}`).join("; ")}`);
      const act = e.level > 0 || m.noReasonShifts >= 3;
      out.push(make("execution", rated(e.level, m.noReasonShifts >= 3 ? "opportunity" : "none"), `${mine.length <= 2 ? names(mine.map((x2) => x2.j)) : plural(mine.length, "started job")} sat ${count === 1 ? "a shift" : `${count} shifts`}${blank ? " with no reason written" : ""}`, lines, ev, {
        effect: !fin ? "" : e.level === 2 ? `On ${orderWord(top!.order)}, the last work to finish.` : e.text, moved: fin ? e.level : null,
        ...(act ? { gap: "No reason was written the shift the job sat.", next: "Go through the jobs that sat at each shift meeting and write the reason on each." } : { next: "Nothing to change beyond writing the reason on each job that sits." }),
      }));
    }
  }

  // Organization and roles: what is recorded on the project, else what the
  // other categories point to.
  {
    const crews = x.work.crews.map((c) => c.crew).filter((c) => c !== "Not set");
    const who = crews.length ? `Work ran across ${plural(crews.length, "crew")}: ${list(crews)}.` : "";
    const org = x.organization?.recorded ? x.organization : null;
    if (org && org.required > 0) {
      const named = org.roles.filter((r) => r.required && r.person).map((r) => `${r.role}: ${r.person}`);
      const head = `${org.filled} of ${org.required} required roles are named on the project.`;
      if (!org.missing.length) out.push(make("organization", "strength", "Every required role has a named person", [head, who], named));
      else out.push(make("organization", "opportunity", "Required roles without a named person", [head, `Not named: ${list(org.missing)}.`, who], named,
        { gap: "Some required roles had no named person.", next: `Name a person for: ${list(org.missing)}.` }));
    } else {
      out.push(make("organization", "none", "No event organization is recorded on the project", [who, "Name the roles and who fills each in Members, Event organization, and the review will read it."], []));
    }
  }

  // Safety.
  {
    const gas = holds.filter((h) => h.cause === "permit");
    if (gas.length) out.push(make("safety", "strength", "Crews stood down when conditions were not safe", gas.map((h) => `${jobWord(h)}: work stopped ${h.hours} h until gas tests cleared.`), gas.map((h) => `${jobWord(h)}: ${h.hours} h. Recorded: "${h.reason}"`)));
    else out.push(make("safety", "none", "No safety finding in the schedule records", ["No stand-down for gas testing or permits is recorded on the schedule.", "Incidents and observations are kept in the shift meetings; add any that belong here."], []));
  }

  // Records and close-out.
  {
    const noApprover = found.filter((f) => !f.approvedBy);
    const hc = m.headCounts;
    const lacks: string[] = [], has: string[] = [], todo: string[] = [];
    if (hc.of) { if (hc.counted / hc.of >= 0.8) has.push(`Head counts for ${hc.counted} of the ${hc.of} crew-shifts that moved work`); else { lacks.push(`Head counts for only ${hc.counted} of the ${hc.of} crew-shifts that moved work, so labor hours can't be worked out`); todo.push("Take a head count at every shift meeting."); } }
    if (found.length) { if (noApprover.length) { lacks.push(`No approver recorded for: ${list(noApprover.map((f) => short(f.what)))}`); todo.push("Write who approved each added job when it is added."); } else has.push(`An approver on all ${plural(found.length, "finding")}`); }
    if (m.stuckShifts) { if (m.noReasonShifts) { lacks.push(`No reason written for ${m.noReasonShifts} of ${plural(m.stuckShifts, "shift")} a started job sat`); todo.push("Write the reason on each job that sits a shift."); } else has.push("A reason on every job that sat"); }
    if (x.built.startsNotRecorded) { lacks.push(`${plural(x.built.startsNotRecorded, "activity", "activities")} with no start time recorded`); todo.push("Record the start time when a job starts."); }
    const lines = [...lacks.map((t) => `Missing: ${t}.`), ...has.map((t) => `Recorded: ${t}.`)];
    if (!m.steps) out.push(make("records", "none", "No records to read", ["No schedule to read."], []));
    else if (lacks.length) out.push(make("records", "opportunity", "Some records were not kept during the event", lines, [], { effect: hc.of && hc.counted / hc.of < 0.8 ? "Labor hours can't be worked out for this event." : "", why: hc.of && hc.counted / hc.of < 0.8 ? `Head counts were taken on ${hc.counted} of ${hc.of} crew-shifts, so labor hours can't be shown for this event.` : `Not recorded: ${lacks.join("; ")}.`, gap: "These were not written down as the event ran.", next: todo.join(" ") }));
    else out.push(make("records", "strength", "Event records support a fact-based review", lines.length ? lines : ["Progress, delays and added work were recorded as the event ran."], []));
  }
  return out;
}

/** What performed well, as the records have it. */
function strengthsOf(m: ReviewMetrics, found: FoundWork[], holds: HoldFact[], live: Finding[]): string[] {
  const out: string[] = [];
  if (m.baselineSteps && m.baselineDone === m.baselineSteps) out.push(`Baseline scope closed: all ${m.baselineSteps} planned activities completed${m.addedSteps && m.addedDone === m.addedSteps ? `, plus all ${m.addedSteps} added` : ""}.`);
  if (m.varianceH != null && m.varianceH <= 0.5) out.push("Finished on or ahead of the baseline finish.");
  const approved = found.filter((f) => f.approvedBy).length;
  if (found.length && approved) out.push(`Added work was approved before it ran: ${approved} of ${plural(found.length, "finding")} carry a recorded approver.`);
  if (holds.some((h) => h.cause === "permit")) out.push("Crews stood down on gas detection until the equipment was cleared.");
  for (const f of live) if (f.rating === "strength" && f.category !== "safety" && f.category !== "scope") out.push(`${f.title}.`);
  return out;
}

/** The questions the numbers will draw, with their answers from the records. */
function qaOf(m: ReviewMetrics, found: FoundWork[], stuck: StuckJob[], tz: string, fin: FinishStory | null, jams: CrewFlow[] = []): QA[] {
  const out: QA[] = [];
  if (fin && m.varianceH != null && Math.abs(m.varianceH) >= 1) out.push({ q: `What caused the ${Math.abs(m.varianceH)} h ${m.varianceH >= 0 ? "past" : "ahead of"} the baseline finish?`, a: [lastLine(fin, tz), becauseLine(fin), closingLine(fin)].filter(Boolean).join(" ") });
  if (fin?.steps.length) out.push({ q: `Which steps on ${orderWord(fin.last[0].order)} ran long, and whose were they?`, a: fin.steps.map((st) => `${st.name}${st.crew ? ` (${st.crew})` : ""}: planned ${st.plannedH} h, took ${st.tookH} h.`).join(" ") });
  for (const f of jams) {
    out.push({ q: `What was open and waiting for ${f.crew}?`, a: `${f.waited.map((j) => `${jobWord(j)}, ${j.waitH} h (open ${whenWord(j.openedAt, tz)}, started ${whenWord(j.startedAt, tz)})`).join("; ")}. ${f.waitH} h in all across ${plural(f.jobs.length, "job")}.` });
    out.push({ q: `Would another ${f.crew} crew have changed the finish?`, a: `${fin?.last[0] ? `Not by itself this event: ${orderWord(fin.last[0].order)} set the finish. ` : ""}It cuts the time equipment sits open. Taking the same ${plural(f.jobs.length, "job")} in the order they opened at the hours each took, one crew working without a break leaves ${f.queue.one} h of waiting and two crews leave ${f.queue.two} h.` });
  }
  if (m.steps) out.push({ q: `Were all ${m.steps} activities planned?`, a: `${m.baselineSteps} were on the baseline schedule${m.addedSteps ? `; ${m.addedSteps} were added during the event from ${plural(found.length, "finding")}` : "; none were added"}. ${m.stepsDone} of ${m.steps} are done.` });
  if (found.length) out.push({ q: "Is found work unusual?", a: "No. The practice is to reduce it with condition data before scope freeze and to carry time for what remains." });
  if (m.addedPct != null && m.addedSteps) out.push({ q: `How firm is the ${m.addedPct}% scope growth?`, a: `It compares planned hours on the schedule: ${m.addedH} h estimated for the added activities against ${m.baselineH} h on the baseline. ${m.labor ? `Head counts put ${m.labor.pct}% of labor hours on added work.` : "Actual labor hours can't be confirmed: head counts were not recorded on most shifts."}` });
  if (stuck.length || m.readyShifts) out.push({ q: "Did the jobs that waited cost us time?", a: "Only where the finding says so. A job that waits and still finishes before the last work is done does not move the finish. Equipment out for repair or calibration is a planned step and is not counted as waiting." });
  out.push({ q: "How reliable is the data?", a: "It is the event's own record: the baseline schedule, progress logged by shift, comments and hold reasons, and added-work approvals. Where a record was not kept, the review says so." });
  return out;
}

/** The point of the review, the same words on the screen and in both files:
 *  the headline, then what the event showed (most costly first), each with
 *  what justifies a change and the change itself. The records behind each
 *  are backup, not the message. */
export interface Conclusion {
  key: string;
  /** The category it falls under, and how that is done well. */
  category: string; practice: string;
  /** What the event showed, in a line. */
  title: string;
  /** What justifies the change: a sentence or two with the numbers. */
  why: string;
  /** What to do differently. */
  change: string;
  owner: string;
  /** It set the finish. */
  first: boolean;
}
export interface Point {
  headline: string;
  /** Baseline finish and actual finish. */
  span: string;
  conclusions: Conclusion[];
  /** What happened that did not move the finish. */
  quiet: string[];
  /** The work order that set the finish, and its steps that ran long. */
  order: string | null;
  steps: FinishStory["steps"];
  /** What set the finish: the last work, what was written on it, the start-up. */
  lines: string[];
}
export function pointOf(r: Pick<Review, "metrics" | "finish" | "findings" | "service">, name: string, tz: string): Point {
  const m = r.metrics, fin = r.finish;
  const late = m.varianceH != null && m.varianceH >= 1;
  const top = fin?.last[0] ?? null;
  const headline = !m.steps ? `${name}: no schedule to review`
    : m.varianceH == null ? `${name}: ${plural(m.steps - m.stepsDone, "activity", "activities")} of ${m.steps} still open`
      : `${name} finished ${Math.abs(m.varianceH) < 1 ? "on the baseline finish" : `${Math.abs(m.varianceH)} h ${m.varianceH > 0 ? "late" : "early"}`}.${late && top ? ` ${orderWord(top.order)} set the finish.` : ""}`;
  const lines = !m.steps ? [] : m.varianceH == null ? ["The numbers here are to date."] : late && fin ? [lastLine(fin, tz), becauseLine(fin), closingLine(fin)].filter(Boolean) : [];
  const live = r.findings.filter((f) => f.status !== "discarded");
  const conclusions: Conclusion[] = live.filter((f) => f.rating === "gap" || f.rating === "opportunity").map((f) => ({
    key: f.key, category: categoryOf(f.category).name, practice: f.practice, title: f.title, why: f.why || f.effect || f.proof, change: f.next, owner: f.owner, first: f.moved === 3,
  }));
  const quiet = live.filter((f) => f.moved === 0 && f.source === "records" && f.rating === "none").map((f) => f.title);
  const fine = r.service.filter((j) => !j.stillOut);
  const svc = (j: ServiceJob) => (TAG.test(tagOf(j.order)) ? orderWord(j.order) : jobWord(j));
  if (fine.length) quiet.push(`${list(fine.map(svc))}: out for service, back as planned`);
  return {
    headline, lines, order: late && top ? top.order : null, steps: late && fin ? fin.steps : [],
    span: m.baselineFinish != null && m.actualFinish != null ? `Baseline finish ${whenWord(m.baselineFinish, tz)}; actual ${whenWord(m.actualFinish, tz)}.` : "",
    conclusions, quiet,
  };
}

const DEFINITIONS: Review["definitions"] = [
  { measure: "Schedule variance", means: "Last activity finished, minus the baseline finish", where: "Reports, As-built schedule" },
  { measure: "Baseline activities", means: "Activities on the schedule when the plan was saved", where: "Plan tab" },
  { measure: "Added activities", means: "Activities added during the event from a finding, with who approved it", where: "Work tab, Added filter" },
  { measure: "Scope growth", means: "Planned hours of the added activities over planned hours of the baseline", where: "Schedule estimates" },
  { measure: "Started job that sat still", means: "Already started, not finished, nothing logged for a whole shift", where: "As-built schedule, gray hatched cells" },
  { measure: "Ready job not started", means: "Everything before it done, and it did not start that shift", where: "As-built schedule, light blue cells" },
  { measure: "Night shifts", means: "Counted only for work that ran on nights (its crew worked that work order two or more nights)", where: "As-built schedule" },
  { measure: "Reason", means: "The comment or hold reason on the job for that shift, or the answer given in this review", where: "The job's comments" },
];

// ─── Targets and the lessons register ──────────────────────────────

/** The measures the next event is held to, with this event's results. A
 *  target is whatever a person set for it: none is assumed. */
export function measuresOf(m: ReviewMetrics, targets: Record<string, string> = {}): Measure[] {
  const half = (n: number) => Math.max(1, Math.floor(n / 2));
  const count = (n: number) => (n > 1 ? ["0", `${half(n)} (half of this event)`, `${n} (no worse than this event)`] : n === 1 ? ["0", "1 (no worse than this event)"] : ["0"]);
  const pct = (p: number | null) => (p == null ? ["5%", "10%"] : [...new Set(["5%", "10%", `${p}% (no worse than this event)`])]);
  const v = m.varianceH;
  const added = m.baselineSteps ? Math.round((m.addedSteps / m.baselineSteps) * 100) : null;
  const rows: Array<[string, string, string, string, string[]]> = [
    ["variance", "Schedule variance at the last activity", v == null ? "Not finished" : `${v > 0 ? "+" : ""}${v} h`, "How many hours past the baseline finish is acceptable.", ["0 h (on the baseline finish)", "12 h (one shift)", ...(v != null && v > 12 ? [`${v} h (no worse than this event)`] : [])]],
    ["added", "Added activities, share of baseline", m.baselineSteps ? `${added}% (${m.addedSteps} on ${m.baselineSteps})` : "None", "How much added work the plan should expect: the found-work allowance, as a share of planned activities.", pct(added)],
    ["growth", "Scope growth in planned hours", m.addedPct == null ? "Not known" : `${m.addedPct}% (${m.addedH} h on ${m.baselineH} h)`, "The same allowance in hours of work: what the schedule and budget carry for found work.", pct(m.addedPct)],
    ["stuck", "Shifts started jobs sat still (all jobs)", String(m.stuckShifts), "Started jobs that go a whole shift with nothing logged. Fewer is better; zero is the aim.", count(m.stuckShifts)],
    ["ready", "Shifts ready jobs waited to start (all jobs)", String(m.readyShifts), "Ready jobs nobody started for a whole shift. Fewer is better; zero is the aim.", count(m.readyShifts)],
    ["no_reason", "Stuck shifts with no reason recorded", m.stuckShifts ? `${m.noReasonShifts} of ${m.stuckShifts}` : "None", "Every job that sits should have its reason written the same shift.", ["0"]],
    ["head_counts", "Crew-shifts with a head count", m.headCounts.of ? `${m.headCounts.counted} of ${m.headCounts.of}` : "None", "Head counts at the shift meeting are what labor hours are worked out from.", ["Every crew, every shift"]],
    ["materials", "Materials not ordered 8 weeks before", "Not tracked", "Counted from the materials register once it is in use.", ["0"]],
  ];
  return rows.map(([key, measure, result, hint, picks]) => { const t = (targets[key] ?? "").trim(); return { key, measure, result, target: t || TARGET_NOT_SET, set: !!t, hint, picks }; });
}

/** The finding as one line for the lessons register (what happened; next time). */
export function lessonOf(f: Finding): { body: string; nextTime: string } {
  const extra = f.info.length ? ` ${f.info.join(" ")}` : "";
  return { body: `${f.title}. ${f.observation}${extra}${f.effect ? ` What it cost: ${f.effect}` : ""}${f.gap ? ` What was missing: ${f.gap}` : ""}`.trim(), nextTime: [f.next, f.year ? `Longer term: ${f.year}` : ""].filter(Boolean).join(" ") };
}
