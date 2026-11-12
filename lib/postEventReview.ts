// postEventReview - the look back at a finished event, drafted from its own
// records and read against how turnarounds are run well.
//
// Everything here is counted from what was entered: the schedule and its
// baseline, progress by shift, comments and hold reasons, added work and
// who approved it, the shift meetings' head counts. Nothing is assumed: a
// number the records can't give is left out and said so, and where a reason
// was never written the review asks for it (the questions) instead of
// guessing.
//
//   - A job is "stuck" in a shift when it had started, wasn't finished, and
//     nothing was logged on it for that whole shift. "Ready, not started":
//     everything before it was done and it still didn't start that shift.
//     Night shifts count only for work that ran on nights (lib/asBuiltWork).
//   - Why it sat is read shift by shift: the latest comment or hold reason
//     on the job by the end of that shift; failing that, what was written
//     when it picked back up; failing that, where its crew was.
//   - The eight categories are the ones a turnaround is assessed on. Each
//     gives what the event showed, the leading practice, the gap, and how it
//     closes: by the next event, and within 12 months.
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

// ─── What it's sorted by ───────────────────────────────────────────

export type Rating = "strength" | "opportunity" | "gap" | "none";
export const RATING_WORD: Record<Rating, string> = { strength: "Strength", opportunity: "Opportunity", gap: "Gap", none: "No finding" };
export const RATING_MEANS = "Strength: keep as is. Opportunity: improve within the existing process. Gap: a process is missing or not working.";

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
}
export const emptySaved = (): ReviewSaved => ({ items: {}, added: [], answers: {} });

// ─── What comes out ────────────────────────────────────────────────

export interface StuckShift { key: string; cause: CauseId; said: string | null; crewOn: string[]; answered: boolean }
export interface StuckJob { id: string; name: string; order: string; crew: string; added: boolean; shifts: StuckShift[] }
export interface ReadyJob { id: string; name: string; order: string; crew: string; added: boolean; shifts: string[]; busyOn: string[]; crewLogged: boolean; said: string | null }
export interface FoundWork {
  id: string; what: string; kind: "discovery" | "added"; on: string; steps: number; done: number;
  /** Hours of work estimated when it was approved. */
  hours: number; critical: boolean; foundAt: number; approvedBy: string | null;
}
export interface HoldFact { id: string; name: string; order: string; reason: string; hours: number; cause: CauseId | null }

export interface ReviewMetrics {
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
  stuck: StuckJob[];
  ready: ReadyJob[];
  byShift: ShiftCount[];
  found: FoundWork[];
  holds: HoldFact[];
  findings: Finding[];
  questions: Question[];
  answeredCount: number;
  strengths: string[];
  qa: QA[];
  /** How each number is counted, and where to see it. */
  definitions: Array<{ measure: string; means: string; where: string }>;
}

// ─── Words ─────────────────────────────────────────────────────────

const r1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[], max = 4) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);
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
const short = (s: string, max = 64) => { const t = s.replace(/\s+/g, " ").trim().replace(/[.;,]+$/, ""); return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t; };
/** A work order as a few words: its equipment tag, else its name cut short. */
export function orderWord(order: string): string {
  const tag = tagOf(order);
  return TAG.test(tag) ? tag.match(TAG)![0] : short(order.replace(/\s*\([^)]*\)/g, ""), 30);
}
/** A job as the tables name it: its equipment tag and what is done, without
 *  the bracketed detail ("E-12 Install Bundle", "PSV-021 - E-13 Overhead"). */
export function jobWord(j: { name: string; order: string }): string {
  const name = short(j.name.replace(/\s*\([^)]*\)/g, ""));
  const tag = tagOf(j.order);
  if (TAG.test(name) || name.toLowerCase().startsWith(tag.toLowerCase())) return name;
  return TAG.test(tag) ? `${tag} ${name}` : `${name}, ${short(j.order, 40)}`;
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
}

const toMs = (v: unknown): number | null => { const t = v == null || v === "" ? NaN : typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? t : null; };

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

  // Comments and hold reasons on each step, oldest first, at the time they
  // are about. An entry typed with no time of its own, right after one that
  // has a time (a day's updates entered in one sitting), belongs with it:
  // otherwise a hold typed in the afternoon lands after the morning's
  // comment that it was cleared.
  const said = new Map<string, Array<{ at: number; body: string }>>();
  const typed = new Map<string, MilestoneNote[]>();
  for (const n of input.notes) {
    if (!stepOf.has(n.milestoneId) || toMs(n.createdAt) == null) continue;
    if (!typed.has(n.milestoneId)) typed.set(n.milestoneId, []);
    typed.get(n.milestoneId)!.push(n);
  }
  for (const [id, ns] of typed) {
    ns.sort((a, b) => toMs(a.createdAt)! - toMs(b.createdAt)!);
    let last: { typedAt: number; about: number } | null = null;
    const rows: Array<{ at: number; body: string }> = [];
    for (const n of ns) {
      const typedAt = toMs(n.createdAt)!, own = toMs(n.happenedAt);
      const at: number = own ?? (last && typedAt - last.typedAt <= 5 * 60_000 ? last.about + 1 : typedAt);
      if (own != null) last = { typedAt, about: own }; else if (last && typedAt - last.typedAt <= 5 * 60_000) last = { typedAt, about: at };
      const body = (n.body ?? "").trim();
      if (body) rows.push({ at, body });
    }
    said.set(id, rows.sort((a, b) => a.at - b.at));
  }

  // ── Stuck: started, then a whole shift with nothing logged ──
  const stuck: StuckJob[] = [];
  for (const w of work.steps.values()) {
    const x = stepOf.get(w.id); if (!x || !w.waits.length) continue;
    const mine = said.get(w.id) ?? [];
    const out: StuckShift[] = [];
    for (const run of w.waits) {
      const after = w.worked.find((k) => (idx.get(k) ?? -1) > (idx.get(run.to) ?? 1e9));
      const resumeEnd = after ? work.shifts[idx.get(after)!].end : null;
      for (const k of run.keys) {
        const end = work.shifts[idx.get(k)!].end;
        const ans = saved.answers[`stuck:${w.id}:${k}`];
        const elsewhere = [...(crewOn.get(w.crew)?.get(k) ?? [])].filter((n) => n !== x.order.name);
        let cause: CauseId | null = null, quote: string | null = null;
        // The latest comment by the end of the shift that gives a reason.
        for (const n of [...mine].reverse()) {
          if (n.at > end) continue;
          const c = causeOfText(n.body);
          if (!c) continue;
          if (c !== "other_crew" && RESOLVED.test(n.body)) break;
          cause = c; quote = n.body; break;
        }
        // Else what was written when it picked back up.
        if (!cause && resumeEnd != null) {
          for (const n of mine) {
            if (n.at <= end || n.at > resumeEnd) continue;
            const c = causeOfText(n.body);
            if (c) { cause = c; quote = n.body; break; }
          }
        }
        if (ans?.cause) out.push({ key: k, cause: ans.cause, said: ans.note?.trim() || quote, crewOn: elsewhere, answered: true });
        else out.push({ key: k, cause: cause ?? (elsewhere.length ? "crew_elsewhere" : "none"), said: quote, crewOn: elsewhere, answered: false });
      }
    }
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
    baselineFinish: built.planFinish, actualFinish: built.finish,
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
      const where = s.crewOn.length ? ` Its crew (${j.crew}) was on ${list(s.crewOn.map(orderWord), 3)}.` : ` ${j.crew} logged no work that shift.`;
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
    questions.push({ key: `approver:${f.id}`, kind: "approver", answer: "text", findingKey: "scope", ask: `"${short(f.what, 80)}" (${tagOf(f.on)}) has no approver recorded. Who approved it?` });
  }

  // ── The findings ──
  const drafts = draftFindings({ metrics, stuck, ready, found, holds, built, work, tz, materials: input.materials ?? null });
  const findings: Finding[] = drafts.map((d) => overlay(d, saved.items[d.key]));
  for (const a of saved.added) {
    const it = saved.items[`added:${a.id}`];
    findings.push({
      key: `added:${a.id}`, category: a.category, source: "person", rating: a.rating ?? "opportunity",
      title: a.title?.trim() || "Finding", observation: a.observation?.trim() ?? "", evidence: [],
      practice: a.practice?.trim() || PRACTICE[a.category].practice, gap: a.gap?.trim() ?? "", next: a.next?.trim() ?? "", year: a.year?.trim() ?? "", owner: a.owner?.trim() ?? "",
      info: it?.info ?? [], status: it?.status === "discarded" ? "discarded" : "kept", edited: false, stale: false,
      drafted: { title: a.title?.trim() || "Finding", observation: a.observation?.trim() ?? "", rating: a.rating ?? "opportunity" }, by: a.by, at: a.at,
    });
  }
  const order = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  const weight: Record<Rating, number> = { gap: 0, opportunity: 1, strength: 2, none: 3 };
  findings.sort((a, b) => weight[a.rating] - weight[b.rating] || order.get(a.category)! - order.get(b.category)!);

  const live = findings.filter((f) => f.status !== "discarded");
  const strengths = strengthsOf(metrics, found, holds, live);
  return {
    metrics, stuck, ready, byShift, found, holds, findings, questions, answeredCount, strengths,
    qa: qaOf(metrics, found, stuck, tz),
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
    practice: pick(e.practice, d.practice), gap: pick(e.gap, d.gap), next: pick(e.next, d.next), year: pick(e.year, d.year), owner: pick(e.owner, d.owner),
    info: it?.info ?? [], status: it?.status ?? "draft", edited,
    stale: !!it?.basis && it.basis !== basis && (edited || it.status === "kept"),
    drafted: { title: d.title, observation: d.observation, rating: d.rating }, by: it?.by ?? null, at: it?.at ?? null,
  };
}
/** The mark a keep or a change carries, to notice the records moving after. */
export const basisOf = (f: Pick<Finding, "drafted">) => hash(`${f.drafted.title}|${f.drafted.observation}|${f.drafted.rating}`);

// ─── The categories: leading practice, the gap, how it closes ──────

interface Draft {
  key: CategoryId; category: CategoryId; rating: Rating; title: string; observation: string; evidence: string[];
  practice: string; gap: string; next: string; year: string; owner: string;
}

export const PRACTICE: Record<CategoryId, { practice: string; gap: string; next: string; year: string; owner: string }> = {
  organization: {
    practice: "The organization is designed for the event: a turnaround manager, coordinators for preparation, planning and logistics, an area coordinator per unit and discipline supervisors, each with written responsibilities, briefed face to face.",
    gap: "The organization formed around available people. No single role owned materials and off-site repairs.",
    next: "Name the turnaround manager, the logistics coordinator and the area coordinators six months before the event, with written roles and responsibilities.",
    year: "An organization design standard for every event, with training and succession for each key role.",
    owner: "Steering group",
  },
  scope: {
    practice: "Scope is built from inspection history, operating data and prior findings, then validated (check, challenge, analyse, clarify) and frozen on a set date. Work found later goes through one approval routine.",
    gap: "No pre-event condition assessment (piping thickness, internals) fed the work list, and found work had no planned allowance in the schedule or the budget.",
    next: "On-stream thickness survey and an internals review on the equipment in scope, before scope freeze. Carry a found-work allowance in schedule and budget, sized from this event.",
    year: "A findings register and inspection data feed each unit's work list.",
    owner: "Planning; Inspection",
  },
  planning: {
    practice: "The shutdown network carries decontamination and gas-free testing at real durations. Each task is screened for known contingencies, with resources arranged in advance.",
    gap: "Decontamination and known contingencies were assumed, not scheduled. Resources were arranged after the need appeared.",
    next: "Steam-out, air stripping and gas test as scheduled activities with an owner. A contingency list per task (plugged lines, failed tests) with resources on call.",
    year: "Standard task templates (vessel entry, exchanger, relief valve, control valve) with contingency steps built in.",
    owner: "Planning; Operations",
  },
  materials: {
    practice: "One materials register: every item fully specified, owned and dated. Items at risk go to one expediter. Off-site repairs run to agreed return dates under one coordinator.",
    gap: "No consolidated materials register, no kit check against the task sheets, and vendor return dates managed by estimate, not commitment.",
    next: "Materials register (specification, owner, status, need-by date) from scope freeze. Open questions answered within 24 hours. Kit check two weeks before the start. One coordinator for everything sent off site.",
    year: "The register built into the turnaround system, with material readiness reported at every gate.",
    owner: "Logistics coordinator",
  },
  contractors: {
    practice: "Mobilization (orientation, badging, tool checks) completes before the event. Crew loading is leveled against the critical path, with surge capacity agreed in the contract.",
    gap: "Crew capacity by craft was not matched to the work running at the same time.",
    next: "Level the crew loading by craft before the event. Agree a surge crew or an extra shift as a contract option. Schedule support crafts (E/I, inspection) for each tie-in.",
    year: "A contracting strategy per work package, with performance measures and surge terms.",
    owner: "Turnaround manager; Contracts",
  },
  execution: {
    practice: "A daily control meeting reviews every waiting and ready job against the critical path. Every delay gets a reason when it occurs.",
    gap: "No standard delay reasons, and ready work was not re-sequenced each day against the critical path.",
    next: "Waiting and ready lists as the first item of the daily control meeting. A reason required on every hold and every job that sits a shift.",
    year: "Delay reasons trended across events, with waiting time reported as a standard measure.",
    owner: "Area coordinators",
  },
  safety: {
    practice: "A safe system of work: permits, isolation and gas testing control every entry, and anyone stops the job when conditions change.",
    gap: "",
    next: "Keep the stand-down practice. Record each stand-down with its duration so the plan can carry realistic entry times.",
    year: "Safety observations and stand-downs trended across events.",
    owner: "HSE lead",
  },
  records: {
    practice: "The event is recorded as it runs (progress, delays with reasons, added work with approval, head counts) and closed with a post-event review that feeds the next plan.",
    gap: "Some records were not kept during the event, which limits what the review can measure.",
    next: "Head count at every shift meeting, an approver on every added job, a reason on every hold. Post-event review within two weeks of completion.",
    year: "A lessons register that carries each kept finding into the next event's plan.",
    owner: "Turnaround manager",
  },
};

function draftFindings(x: { metrics: ReviewMetrics; stuck: StuckJob[]; ready: ReadyJob[]; found: FoundWork[]; holds: HoldFact[]; built: AsBuilt; work: AsBuiltWork; tz: string; materials: ReviewInput["materials"] }): Draft[] {
  const { metrics: m, stuck, ready, found, holds } = x;
  const P = PRACTICE;
  const make = (key: CategoryId, rating: Rating, title: string, observation: string, evidence: string[], over: Partial<Draft> = {}): Draft => ({
    key, category: key, rating, title, observation, evidence, ...P[key], ...(rating === "strength" || rating === "none" ? { gap: "" } : {}), ...over,
  });
  const shiftsOf = (c: CauseId) => stuck.flatMap((j) => j.shifts.filter((s) => s.cause === c).map((s) => ({ j, s })));
  const jobLines = (c: CauseId) => {
    const by = new Map<string, { j: StuckJob; ks: string[]; said: string | null }>();
    for (const { j, s } of shiftsOf(c)) { const e = by.get(j.id) ?? { j, ks: [], said: null }; e.ks.push(s.key); e.said = e.said ?? s.said; by.set(j.id, e); }
    return [...by.values()].map((e) => `${jobWord(e.j)} (${e.j.crew}): sat ${plural(e.ks.length, "shift")} (${shiftsWord(e.ks)})${e.said ? `. Recorded: "${e.said}"` : ""}`);
  };
  const out: Draft[] = [];

  // Scope definition.
  {
    const crit = found.filter((f) => f.critical), rest = found.filter((f) => !f.critical);
    const ev = found.map((f) => `${f.what} (${tagOf(f.on)}): ${plural(f.steps, "activity", "activities")}, about ${f.hours} h of work when approved${f.critical ? ", on the critical path" : ""}${f.approvedBy ? `, approved by ${f.approvedBy}` : ", no approver recorded"}`);
    if (!found.length) out.push(make("scope", m.steps ? "strength" : "none", "Scope held through the event", m.steps ? `All ${m.baselineSteps} planned activities; no work was added during the event.` : "No schedule to read.", []));
    else {
      const growth = m.addedPct != null ? ` That is ${m.addedH} h of work on top of a ${m.baselineH} h plan (${m.addedPct}% more), by the schedule's own estimates.` : "";
      const critWords = crit.length ? ` On the critical path: ${list(crit.map((f) => `${short(f.what, 60)} (${tagOf(f.on)}, about ${f.hours} h)`), 3)}.` : "";
      const restWords = rest.length ? ` ${crit.length ? "Off the critical path" : "Largest"}: ${list(rest.slice(0, 3).map((f) => `${short(f.what, 60)} (${tagOf(f.on)}, about ${f.hours} h)`), 3)}.` : "";
      const rating: Rating = crit.length || (m.addedPct ?? 0) >= 10 ? "gap" : "opportunity";
      out.push(make("scope", rating, "Scope did not fully reflect equipment condition",
        `${plural(m.addedSteps, "activity was", "activities were")} added from ${plural(found.length, "finding")}.${growth}${critWords}${restWords}`, ev));
    }
  }

  // Planning and scheduling.
  {
    const gas = holds.filter((h) => h.cause === "permit");
    const gasH = r1(gas.reduce((n, h) => n + h.hours, 0));
    const clean = shiftsOf("cleaning"), test = shiftsOf("test");
    const parts: string[] = [], ev: string[] = [];
    if (gas.length) {
      const where = [...new Set(gas.map((h) => tagOf(h.order)))];
      parts.push(`Work on ${list(where, 3)} was held ${gasH} h in all for gas testing and decontamination.`);
      for (const h of gas) ev.push(`${jobWord(h)}: held ${h.hours} h. Recorded: "${h.reason}"`);
    }
    if (clean.length) { parts.push(`${list([...new Set(clean.map((c) => jobWord(c.j)))], 3)} sat ${plural(clean.length, "shift")} until a line was cleaned.`); ev.push(...jobLines("cleaning")); }
    if (test.length) { parts.push(`${list([...new Set(test.map((c) => jobWord(c.j)))], 3)} stopped ${plural(test.length, "shift")} on a leak or a failed test.`); ev.push(...jobLines("test")); }
    if (parts.length) out.push(make("planning", gasH >= 24 || clean.length + test.length >= 4 ? "gap" : "opportunity", "Decontamination and contingency time was not in the plan", parts.join(" "), ev));
    else out.push(make("planning", "none", "No planning finding in the records", "No holds for gas testing or decontamination, and no job sat waiting on cleaning or a failed test.", []));
  }

  // Materials and logistics.
  {
    const off = shiftsOf("offsite"), mat = shiftsOf("material");
    const parts: string[] = [], ev: string[] = [];
    if (off.length) {
      const jobs = new Map<string, number>(); for (const { j } of off) jobs.set(jobWord(j), (jobs.get(jobWord(j)) ?? 0) + 1);
      parts.push(`${list([...jobs.entries()].map(([n, c]) => `${n} (${plural(c, "shift")})`), 4)} sat waiting on off-site repair or calibration.`);
      ev.push(...jobLines("offsite"));
    }
    if (mat.length) { parts.push(`${list([...new Set(mat.map((c) => jobWord(c.j)))], 3)} sat ${plural(mat.length, "shift")} waiting on materials.`); ev.push(...jobLines("material")); }
    const r = x.materials;
    if (r && r.lines > 0) {
      parts.push(`Materials register: ${plural(r.lines, "line")}, ${r.specIncomplete} with an incomplete specification, ${r.late} short or late, ${plural(r.openQuestions, "question")} open more than 24 h.`);
      const over: Partial<Draft> = { gap: "Items on the register reached the event incomplete, late or with open questions.", next: "Every register line specified, owned and dated at scope freeze. Open questions answered within 24 hours. Kit check two weeks before the start. One coordinator for everything sent off site." };
      const bad = r.specIncomplete + r.late + r.openQuestions;
      out.push(make("materials", off.length + mat.length >= 2 || bad >= 3 ? "gap" : off.length + mat.length + bad > 0 ? "opportunity" : "strength", bad + off.length + mat.length ? "Material readiness was not complete at the start" : "Materials were ready when the work needed them", parts.join(" "), ev, bad + off.length + mat.length ? over : {}));
    } else if (parts.length) {
      parts.push("No materials register was kept for this event.");
      out.push(make("materials", off.length + mat.length >= 2 ? "gap" : "opportunity", "Material readiness was not tracked to an owner and a date", parts.join(" "), ev));
    } else out.push(make("materials", "none", "No materials finding in the records", "No job is recorded as waiting on materials or an off-site repair. No materials register was kept for this event, so material readiness can't be measured.", []));
  }

  // Contractors and resourcing.
  {
    const other = shiftsOf("other_crew");
    const byCrew = new Map<string, { shifts: number; jobs: string[]; on: Set<string>; silent: boolean }>();
    for (const j of ready) {
      const e = byCrew.get(j.crew) ?? { shifts: 0, jobs: [], on: new Set<string>(), silent: false };
      e.shifts += j.shifts.length; e.jobs.push(`${jobWord(j)} (${plural(j.shifts.length, "shift")})`); for (const b of j.busyOn) e.on.add(orderWord(b)); if (!j.crewLogged) e.silent = true;
      byCrew.set(j.crew, e);
    }
    const parts: string[] = [], ev: string[] = [];
    const crews = [...byCrew.entries()].sort((a, b) => b[1].shifts - a[1].shifts);
    for (const [crew, e] of crews) {
      parts.push(`Ready work waited for ${crew}: ${list(e.jobs, 3)}${e.on.size ? `, while the crew was on ${list([...e.on], 3)}` : e.silent ? ", with no work logged by that crew" : ""}.`);
    }
    for (const j of ready) ev.push(`${jobWord(j)} (${j.crew}): ready ${whenWord(x.work.steps.get(j.id)!.ready!.at, x.tz)}, not started for ${plural(j.shifts.length, "shift")} (${shiftsWord(j.shifts)})${j.busyOn.length ? `. Crew was on ${list(j.busyOn.map(orderWord), 3)}` : j.crewLogged ? "" : ". Crew logged no work then"}${j.said ? `. Answer: "${j.said}"` : ""}`);
    if (other.length) { parts.push(`${list([...new Set(other.map((c) => jobWord(c.j)))], 3)} sat ${plural(other.length, "shift")} waiting on another crew.`); ev.push(...jobLines("other_crew")); }
    const n = m.readyShifts + other.length;
    if (n) out.push(make("contractors", n >= 8 ? "gap" : "opportunity", "Crew capacity did not match the work running at the same time", parts.join(" "), ev));
    else out.push(make("contractors", m.steps ? "strength" : "none", "Crews picked up ready work without delay", "No job sat a full shift ready and not started, and none waited on another crew.", []));
  }

  // Execution control.
  {
    const ev = [...stuck.map((j) => `${jobWord(j)} (${j.crew}): ${j.shifts.map((s) => `${shiftWord(s.key)}, ${CAUSE_WORD[s.cause].toLowerCase()}`).join("; ")}`)];
    if (m.stuckShifts + m.readyShifts === 0) out.push(make("execution", m.steps ? "strength" : "none", "Started work kept moving", "No started job sat a full shift, and no ready job waited a full shift to start.", []));
    else {
      const causes = m.byCause.map((c) => `${CAUSE_WORD[c.cause].toLowerCase()} ${c.shifts}`).join(", ");
      const stuckWords = m.stuckJobs ? `${plural(m.stuckJobs, "started job")} sat still for ${plural(m.stuckShifts, "shift")} in all (${causes}).` : "";
      const none = m.noReasonShifts ? ` ${m.noReasonShifts} of those ${m.stuckShifts} had no reason written down.` : m.stuckShifts ? " Every one has a recorded reason." : "";
      const readyWords = m.readyJobs ? ` ${plural(m.readyJobs, "ready job")} waited ${plural(m.readyShifts, "shift")} in all to start.` : "";
      const at = ` It happened on ${m.shiftsWithStuck} of the ${m.shifts} shifts, ${m.leastAtOnce === m.mostAtOnce ? `${m.mostAtOnce}` : `${m.leastAtOnce} to ${m.mostAtOnce}`} jobs at a time.`;
      const n = m.stuckShifts + m.readyShifts;
      out.push(make("execution", n >= 20 || (m.stuckShifts >= 6 && m.noReasonShifts / m.stuckShifts >= 0.5) ? "gap" : "opportunity", "Waiting time was recorded but not managed to closure", `${stuckWords}${none}${readyWords}${at}`.trim(), ev));
    }
  }

  // Organization and roles: follows from the others.
  {
    const mat = out.find((d) => d.key === "materials")!, con = out.find((d) => d.key === "contractors")!;
    const crews = x.work.crews.map((c) => c.crew).filter((c) => c !== "Not set");
    const who = crews.length ? `Work ran across ${plural(crews.length, "crew")}: ${list(crews, 6)}.` : "";
    const lacks: string[] = [];
    if (mat.rating === "gap" || mat.rating === "opportunity") lacks.push("materials and off-site repairs");
    if (con.rating === "gap" || con.rating === "opportunity") lacks.push("day-to-day balancing of crews");
    if (lacks.length) out.push(make("organization", "opportunity", "Key coordination roles were not assigned", `${who} The records show no single owner for ${lacks.join(" or ")}.`.trim(), [],
      lacks.length === 1 && lacks[0].startsWith("day") ? { gap: "The organization formed around available people. No role balanced crews across areas each day.", next: "Name the turnaround manager and an area coordinator per unit six months before the event, with written roles and responsibilities." } : {}));
    else out.push(make("organization", "none", "No organization finding in the records", `${who} Nothing in the records points to a missing role.`.trim(), []));
  }

  // Safety.
  {
    const gas = holds.filter((h) => h.cause === "permit");
    if (gas.length) {
      const where = [...new Set(gas.map((h) => tagOf(h.order)))];
      out.push(make("safety", "strength", "Crews stood down when conditions were not safe", `Work on ${list(where, 3)} was stopped ${plural(gas.length, "time")} (${r1(gas.reduce((n, h) => n + h.hours, 0))} h in all) until gas tests cleared.`, gas.map((h) => `${jobWord(h)}: ${h.hours} h. Recorded: "${h.reason}"`)));
    } else out.push(make("safety", "none", "No safety finding in the schedule records", "No stand-down for gas testing or permits is recorded on the schedule. Incidents and observations are kept in the shift meetings; add any that belong here.", []));
  }

  // Records and close-out.
  {
    const noApprover = found.filter((f) => !f.approvedBy).length;
    const hc = m.headCounts;
    const lacks: string[] = [], has: string[] = [];
    if (hc.of) (hc.counted / hc.of >= 0.8 ? has : lacks).push(`head counts for ${hc.counted} of the ${hc.of} crew-shifts that moved work`);
    if (found.length) (noApprover ? lacks : has).push(noApprover ? `${noApprover} of ${plural(found.length, "finding")} with no approver recorded` : `an approver on all ${plural(found.length, "finding")}`);
    if (m.stuckShifts) (m.noReasonShifts ? lacks : has).push(m.noReasonShifts ? `no reason written for ${m.noReasonShifts} of ${plural(m.stuckShifts, "stuck shift")}` : "a reason on every stuck shift");
    if (x.built.startsNotRecorded) lacks.push(`${plural(x.built.startsNotRecorded, "activity", "activities")} with no start time recorded`);
    const obs = `${has.length ? `Recorded: ${has.join("; ")}.` : ""}${lacks.length ? ` Missing: ${lacks.join("; ")}.` : ""}${hc.of && hc.counted / hc.of < 0.8 ? " Without head counts, labor hours can't be estimated." : ""}`.trim();
    if (!m.steps) out.push(make("records", "none", "No records to read", "No schedule to read.", []));
    else if (lacks.length) out.push(make("records", "opportunity", "Some records were not kept during the event", obs, []));
    else out.push(make("records", "strength", "Event records support a fact-based review", obs || "Progress, delays and added work were recorded as the event ran.", []));
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
function qaOf(m: ReviewMetrics, found: FoundWork[], stuck: StuckJob[], tz: string): QA[] {
  const out: QA[] = [];
  if (m.steps) out.push({ q: `Were all ${m.steps} activities planned?`, a: `${m.baselineSteps} were on the baseline schedule${m.addedSteps ? `; ${m.addedSteps} were added during the event from ${plural(found.length, "finding")}` : "; none were added"}. ${m.stepsDone} of ${m.steps} are done.` });
  if (m.varianceH != null && m.baselineFinish != null && m.actualFinish != null) {
    const crit = found.filter((f) => f.critical);
    out.push({ q: `What drove the ${Math.abs(m.varianceH)} h ${m.varianceH >= 0 ? "past" : "ahead of"} the baseline finish?`, a: `${crit.length ? `Added work on the critical path: ${list(crit.map((f) => `${short(f.what, 60)} (about ${f.hours} h)`), 3)}. ` : ""}Baseline finish ${whenWord(m.baselineFinish, tz)}; actual ${whenWord(m.actualFinish, tz)}. The full trace is in Reports, As-built schedule.` });
  }
  if (found.length) out.push({ q: "Is found work unusual?", a: "No. The practice is to reduce it with condition data before scope freeze and to carry an allowance for what remains." });
  if (m.addedPct != null && m.addedSteps) out.push({ q: `How firm is the ${m.addedPct}% scope growth?`, a: `It compares planned hours on the schedule: ${m.addedH} h estimated for the added activities against ${m.baselineH} h on the baseline. ${m.labor ? `Head counts put ${m.labor.pct}% of labor hours on added work.` : "Actual labor hours can't be confirmed: head counts were not recorded on most shifts."}` });
  if (m.stuckShifts + m.readyShifts) out.push({ q: "How is a stuck job counted?", a: "A job that had started and went a whole shift with nothing logged, or was ready and did not start for a whole shift. Night shifts count only for work that ran on nights. Several jobs can sit in the same shift, so the counts are not hours of delay to the finish." });
  if (stuck.length) out.push({ q: "Where can I see each stuck job?", a: "Reports, As-built schedule: gray hatched cells are started jobs with nothing logged; light blue cells are ready jobs not started. The appendix lists each one with its shift and reason." });
  out.push({ q: "What will the changes cost?", a: "Most are changes to how the event is prepared and controlled, carried by existing staff. Items that need funding (a condition survey, a surge crew option) come back with quotes before approval." });
  out.push({ q: "Who owns the actions?", a: "Each closure names a role. Names are assigned when the event organization is set, six months ahead." });
  out.push({ q: "How reliable is the data?", a: "It is the event's own record: the baseline schedule, progress logged by shift, comments and hold reasons, added-work approvals and shift head counts. Anything estimated is labelled." });
  return out;
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

// ─── The plan every event closes with ──────────────────────────────

export const ORGANIZATION: Array<{ tier: string; who: string; does: string }> = [
  { tier: "Steering group", who: "Plant, Maintenance, Operations, Engineering", does: "Sets objectives, funding and scope policy; approves late scope." },
  { tier: "Turnaround manager", who: "One person, full time from six months ahead", does: "Single point of responsibility for preparation, execution and close-out." },
  { tier: "Preparation and planning coordinator", who: "Reports to the turnaround manager", does: "Scope validation and freeze, task packages, the schedule and the shutdown network." },
  { tier: "Logistics and materials coordinator", who: "Reports to the turnaround manager", does: "Materials register, expediting, off-site repairs, laydown and deliveries." },
  { tier: "Area coordinator, one per unit", who: "Reports to the turnaround manager", does: "Daily control against the critical path; balances crews across the area." },
  { tier: "Support leads", who: "HSE; Inspection and QA/QC; Operations liaison", does: "Permits and gas testing; inspection and acceptance; decontamination and start-up." },
  { tier: "Discipline supervisors", who: "Under each area coordinator", does: "Mechanical (exchangers, vessels, piping); cleaning; valves and instruments; bulk services (scaffold, insulation, cranes)." },
];

export const GATES: Array<{ when: string; what: string; owner: string }> = [
  { when: "6 months before", what: "Organization named; steering group set; prior findings loaded to the work list", owner: "Steering group" },
  { when: "4 months before", what: "Condition survey; operations input on fouling; scope validation", owner: "Planning; Inspection" },
  { when: "3 months before", what: "Scope freeze; later additions need plant manager cost acceptance", owner: "Turnaround manager" },
  { when: "8 weeks before", what: "Materials register complete; all items ordered; shop return dates agreed", owner: "Logistics coordinator" },
  { when: "4 weeks before", what: "Items at risk to the expediter; decontamination and gas-free in the shutdown network", owner: "Logistics; Planning" },
  { when: "2 weeks before", what: "Readiness review: kits checked; contractor mobilization complete", owner: "Turnaround manager" },
  { when: "Every day of the event", what: "Control meeting: critical path, waiting and ready lists, added work", owner: "Area coordinators" },
  { when: "2 weeks after", what: "Post-event review; kept findings to the lessons register; final report", owner: "Turnaround manager" },
];

export const ROADMAP: Array<{ when: string; theme: string; what: string }> = [
  { when: "Quarter 1", theme: "Standards", what: "Written procedures: work request and material specification, scope freeze and change control, added work, materials and expediting, off-site repair control, delay reasons." },
  { when: "Quarter 2", theme: "Systems", what: "Materials register, delay reasons and lessons register in the turnaround system; condition data and prior findings feed each unit's work list." },
  { when: "Quarter 3", theme: "People", what: "Organization design standard; training for coordinators and planners; succession for key roles." },
  { when: "Quarter 4", theme: "Assurance", what: "Self-assessment across all eight categories; an action plan on the weakest; targets reset." },
];

/** The measures the next event is held to, with this event's results. */
export function measuresOf(m: ReviewMetrics): Array<{ measure: string; result: string; target: string }> {
  return [
    { measure: "Schedule variance at the last activity", result: m.varianceH == null ? "Not finished" : `${m.varianceH > 0 ? "+" : ""}${m.varianceH} h`, target: "To agree" },
    { measure: "Added activities, share of baseline", result: m.baselineSteps ? `${Math.round((m.addedSteps / m.baselineSteps) * 100)}% (${m.addedSteps} on ${m.baselineSteps})` : "None", target: "Within allowance" },
    { measure: "Scope growth in planned hours", result: m.addedPct == null ? "Not known" : `${m.addedPct}% (${m.addedH} h on ${m.baselineH} h)`, target: "Within allowance" },
    { measure: "Shifts started jobs sat still (all jobs)", result: String(m.stuckShifts), target: "To agree" },
    { measure: "Shifts ready jobs waited to start (all jobs)", result: String(m.readyShifts), target: "To agree" },
    { measure: "Stuck shifts with no reason recorded", result: m.stuckShifts ? `${m.noReasonShifts} of ${m.stuckShifts}` : "None", target: "0" },
    { measure: "Crew-shifts with a head count", result: m.headCounts.of ? `${m.headCounts.counted} of ${m.headCounts.of}` : "None", target: "All" },
    { measure: "Materials not ordered 8 weeks before", result: "Not tracked", target: "0" },
  ];
}

/** What management is asked to decide, from the findings that stand. */
export function decisionsOf(findings: Finding[]): string[] {
  const has = (c: CategoryId) => findings.some((f) => f.category === c && f.status !== "discarded" && (f.rating === "gap" || f.rating === "opportunity"));
  const out: string[] = [];
  if (has("scope")) out.push("Scope freeze with change control: additions after the freeze need plant manager cost acceptance.", "A found-work allowance in schedule and budget, sized from this event.", "A pre-event condition survey funded for the equipment in scope.");
  if (has("organization") || has("materials")) out.push("The event organization named six months ahead, including a logistics and materials coordinator.");
  if (has("materials") || has("execution")) out.push("The materials register and delay reasons adopted as standard for every event.");
  if (has("contractors")) out.push("A surge crew or extra shift carried as a contract option for the busiest craft.");
  return out;
}

/** The finding as one line for the lessons register (what happened; next time). */
export function lessonOf(f: Finding): { body: string; nextTime: string } {
  const extra = f.info.length ? ` ${f.info.join(" ")}` : "";
  return { body: `${f.title}. ${f.observation}${extra}${f.gap ? ` Gap: ${f.gap}` : ""}`.trim(), nextTime: [f.next, f.year ? `Within 12 months: ${f.year}` : ""].filter(Boolean).join(" ") };
}
