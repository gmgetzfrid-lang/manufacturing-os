// findings - what a job taught, kept for the next one.
//
// A finding is a problem, a lesson, a material shortfall or missed scope.
// It is written during the job (+ Finding on a step, a work order, the
// hour by hour) or found in the record at the close-out: added scope and
// discoveries, comments that say something went wrong, hold reasons, the
// team's close-out lessons, the old "Lessons learned" box. Each one says
// what it applies to: a piece of equipment, the unit, this project, or
// every job. Only the ones kept at the close-out review reach the
// Intelligence graph, Ask and the next project's plan ("From past jobs").
//
// The suggestion builder and the matching are pure; load and save talk to
// project_findings / finding_acks (20261115_project_findings.sql) and say
// plainly when that hasn't been run.

import { supabase } from "@/lib/supabase";
import type { Milestone, MilestoneNote } from "@/types/schema";
import { ADDED, discoveries, kindOf } from "@/lib/discovery";
import { noEmDash } from "@/lib/noEmDash";
import { fetchAllRows } from "@/lib/fetchAllRows";
import type { Lesson } from "@/lib/shiftRecord";

export const FINDINGS_SQL = "20261115_project_findings.sql";

export type FindingKind = "problem" | "lesson" | "material" | "missed_scope";
export type AppliesTo = "equipment" | "unit" | "project" | "all";
export const TOPICS = ["Materials", "Planning", "Contractors", "Permits", "Staffing", "Safety", "Scheduling", "Other"] as const;
export type Topic = (typeof TOPICS)[number];
export type FindingSource = "manual" | "discovery" | "note" | "hold" | "lesson" | "lessons_learned" | "record" | "review";
export type FindingStatus = "open" | "kept" | "dropped";

export const KINDS: FindingKind[] = ["problem", "lesson", "material", "missed_scope"];
export const KIND_WORD: Record<FindingKind, string> = { problem: "Problem", lesson: "Lesson", material: "Material", missed_scope: "Missed scope" };
export const APPLIES: AppliesTo[] = ["equipment", "unit", "project", "all"];
export const APPLIES_WORD: Record<AppliesTo, string> = { equipment: "Equipment", unit: "Unit", project: "This project", all: "All jobs" };
/** Where a suggestion came from, as the review says it. */
export const SOURCE_WORD: Record<FindingSource, string> = {
  manual: "+ Finding", discovery: "Added to the schedule", note: "Comment", hold: "On hold", lesson: "Close-out lesson", lessons_learned: "Lessons learned", record: "Project records", review: "Post-event review",
};

/** What the project's records say (cost, change orders, late work,
 *  rejected turnover items, missing evidence; lib/projectReport). */
export interface RecordLesson { ref: string; kind: FindingKind; topic: Topic; text: string; nextTime: string }

export interface FindingFields {
  kind: FindingKind;
  appliesTo: AppliesTo;
  topic: Topic;
  /** What happened. */
  body: string;
  /** What to do next time. */
  nextTime: string;
  assetId: string | null;
  assetTag: string | null;
  unitCode: string | null;
}

export interface Finding extends FindingFields {
  id: string;
  orgId: string;
  projectId: string;
  projectType: string | null;
  milestoneId: string | null;
  workOrderRef: string | null;
  hours: number | null;
  source: FindingSource;
  sourceRef: string | null;
  status: FindingStatus;
  foundAt: number;
  createdBy: string | null;
  createdByName: string | null;
  reviewedByName: string | null;
  reviewedAt: number | null;
}

/** A suggestion from the record, before it's reviewed. */
export interface FindingDraft extends FindingFields {
  /** `${source}:${sourceRef}` - one review each. */
  key: string;
  source: FindingSource;
  sourceRef: string;
  milestoneId: string | null;
  workOrderRef: string | null;
  hours: number | null;
  foundAt: number;
  by: string | null;
  /** The step or work order it's on ("V-7 - Transmix Fractionator"). */
  on: string | null;
  /** Where it came from, as the review says it ("Discovery", "Comment"). */
  from: string;
}

export const draftKey = (source: string, ref: string | null | undefined) => `${source}:${ref ?? ""}`;

// ─── Equipment ─────────────────────────────────────────────────────

/** A tag as the registry matches it: letters and digits, lower case
 *  ("V-7", "v 7" and "V7" are one tag). */
export const tagKey = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** The registry's tag "X-31 (2030.31)" is X-31. */
export const registryTagKey = (tag: string) => tagKey(tag.replace(/\s*\(.*$/, ""));

const TAG_AT_START = /^\s*([A-Z]{1,4})\s?-\s?(\d{1,5}[A-Z]{0,2})\b/;
const TAG_ANYWHERE = /\b([A-Z]{1,4})-(\d{1,5}[A-Z]{0,2})\b/g;
const tidyTag = (p: string, n: string) => `${p}-${n}`;

/** The tag a name starts with: "E-12 - Transmix Feed…" is E-12. */
export function leadTag(name: string | null | undefined): string | null {
  const m = (name ?? "").match(TAG_AT_START);
  return m ? tidyTag(m[1], m[2]) : null;
}

/** Every tag written in a text, in order, once each. */
export function tagsIn(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(TAG_ANYWHERE)) {
    const t = tidyTag(m[1], m[2]);
    if (!out.some((x) => tagKey(x) === tagKey(t))) out.push(t);
  }
  return out;
}

/** Kept on a work order's task (milestones.attributes): the registry
 *  equipment it's on, picked in Setup › Unit & equipment. */
export const EQUIP_ID = "equipment_asset_id";
export const EQUIP_TAG = "equipment_tag";
/** Kept on a work order's task when it's on no equipment (decided, not
 *  forgotten). */
export const EQUIP_NONE = "equipment_none";

export interface Equipment { assetId: string | null; tag: string }

/** The equipment a step is on: the one picked for its work order (or a
 *  task above it), else the tag its task's name starts with, else a tag in
 *  its own name, location or description. */
export function equipmentOf(m: Milestone, byId: Map<string, Milestone>): Equipment | null {
  const seen = new Set<string>();
  let x: Milestone | undefined = m;
  while (x && !(x.id && seen.has(x.id))) {
    if (x.id) seen.add(x.id);
    const a = x.attributes ?? {};
    if (a[EQUIP_NONE] === true) return null;
    const tag = typeof a[EQUIP_TAG] === "string" ? (a[EQUIP_TAG] as string).trim() : "";
    if (tag) return { assetId: typeof a[EQUIP_ID] === "string" && a[EQUIP_ID] ? (a[EQUIP_ID] as string) : null, tag };
    const lead = leadTag(x.name);
    if (lead) return { assetId: null, tag: lead };
    x = x.parentId ? byId.get(x.parentId) : undefined;
  }
  // No task starts with one: a tag written in the step, else in the task
  // above it ("Clean fuel gas supply header to H-1").
  const t = tagsIn([m.name, m.location, m.description].filter(Boolean).join(" "))[0]
    ?? (m.parentId ? tagsIn(byId.get(m.parentId)?.name)[0] : undefined);
  return t ? { assetId: null, tag: t } : null;
}

// ─── Guessing type and topic from the words ────────────────────────

const RX: Array<[Topic, RegExp]> = [
  ["Safety", /\b(safety|injur\w*|near[\s-]?miss|incident|LEL'?s?|H2S|gas test|PPE|fire|spill|stand(?:ing)? down|evacuat\w*)\b/i],
  ["Permits", /\b(permits?|lock[\s-]?out|LOTO|isolations?|blinds?|hot[\s-]?work|confined[\s-]?space|sign(?:ed)?[\s-]?off)\b/i],
  ["Materials", /\b(order(?:ed|s)?|seal rings?|gaskets?|parts?|materials?|spares?|stock|bolts?|studs?|backorder\w*|on hand|shortage|not enough|short of)\b/i],
  ["Contractors", /\b(contractors?|vendors?|cranes?|scaffold\w*|subcontract\w*|picked up|return(?:ed)? from service|calibrat\w*|expected back)\b/i],
  ["Staffing", /\b(crews?|staff\w*|manpower|head ?count|short[\s-]?handed|overtime|orientation|operators?)\b/i],
  ["Planning", /\b(plan(?:ned|ning)?|scope|didn'?t know|did not know|unplanned|missed|forgot|by hand|discover\w*|found|rebuilt)\b/i],
  ["Scheduling", /\b(schedul\w*|delay\w*|late|waiting|wait(?:ed)? (?:on|for)|sequence|behind|held up)\b/i],
];

export function guessTopic(text: string): Topic {
  return RX.find(([, re]) => re.test(text))?.[0] ?? "Other";
}

const MATERIAL = /\b(order(?:ed)?|seal rings?|gaskets?|spares?|parts|materials?|shortage|not enough|short of|backorder\w*|re-?used|improvi[sz]\w*)\b/i;

export function guessKind(text: string, source: FindingSource): FindingKind {
  if (source === "discovery") return "missed_scope";
  if (source === "lesson" || source === "lessons_learned") return "lesson";
  return MATERIAL.test(text) && /\b(order|seal|gasket|spare|part|material|short|enough|backorder|re-?used|improvi)/i.test(text) ? "material" : "problem";
}

// ─── Suggestions from the record ───────────────────────────────────

/** A comment that says something went wrong, was missing or held the work
 *  up - the kind worth remembering - not a progress line. */
const SIGNAL = /\b(discover\w*|plug\w*|leak\w*|lack of|waiting|wait(?:ed)? for|expected back|stand(?:ing)? down|improvi[sz]\w*|fight\w*|only a month|shortage|short of|not enough|missing|wrong|didn'?t|did not|couldn'?t|could not|can'?t|cannot|unable|corrod\w*|damag\w*|crack\w*|broke\w*|fail\w*|orientation|remaining material|order(?:ed)?|delay\w*|re-?used|LEL'?s?|by hand|unplanned)\b/i;
const NOISE = /^(progress\s*[→>-]|actual times corrected|discovery:|added scope:|\*\*overtime\*\*)/i;
/** A line saying a problem is over ("Ancon cleared pluggin"), with nothing
 *  else wrong in it. */
const RESOLVED = /\b(cleared|resolved|fixed|repaired|completed?|finished|returned|is back|came back)\b/i;
const STILL_WRONG = /\b(discover\w*|leak\w*|shortage|short of|not enough|missing|wrong|fail\w*|stand(?:ing)? down|LEL'?s?|order(?:ed)?|wait\w*|improvi[sz]\w*|re-?used)\b/i;

const STOP = new Set(["the", "and", "for", "was", "were", "with", "that", "this", "from", "are", "has", "had", "have", "but", "not", "all", "its", "into", "out", "off", "our", "get", "got"]);
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
/** The same thing said again (a note copied to the next shift): most of
 *  the shorter one's words, at least three, in the other. */
function alike(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both >= 3 && both / Math.min(x.size, y.size) >= 0.7;
}

/** A short, stable id for a text (FNV-1a). */
export function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

const tms = (v: unknown) => (v == null ? NaN : typeof v === "number" ? v : Date.parse(String(v)));
const clean = (s: string | null | undefined) => noEmDash((s ?? "").replace(/\s+/g, " ").trim());
const HOLD = new Set(["on_hold", "blocked"]);

/** The old "Lessons learned" box as lines, each with the ref it's
 *  reviewed under (headings and scraps left out). */
export function lessonsLearnedLines(text: string | null | undefined): Array<{ ref: string; text: string }> {
  const out: Array<{ ref: string; text: string }> = [];
  for (const raw of (text ?? "").split(/\n+/)) {
    const t = clean(raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""));
    if (t.length < 12 || /:$/.test(t)) continue;
    out.push({ ref: hashOf(t.toLowerCase()), text: t });
  }
  return out;
}

export interface SuggestInput {
  milestones: Milestone[];
  notes: MilestoneNote[];
  /** The team's close-out lessons (Keep doing / Do better). */
  lessons?: Lesson[];
  /** The old "Lessons learned" box (projects.lessons_learned). */
  lessonsLearned?: string | null;
  /** What the project's records say (lib/projectReport recordLessons). */
  records?: RecordLesson[];
  /** The project's unit (Setup › Unit & equipment). */
  unitCode?: string | null;
}

/** What the record suggests keeping, oldest first, one per thing. */
export function suggestFindings(input: SuggestInput): FindingDraft[] {
  const byId = new Map<string, Milestone>();
  for (const m of input.milestones) if (m.id) byId.set(m.id, m);
  const unit = input.unitCode ?? null;
  const out: FindingDraft[] = [];
  const onOf = (m: Milestone | undefined) => {
    if (!m) return null;
    const p = m.parentId ? byId.get(m.parentId) : undefined;
    return p && leadTag(p.name) ? `${p.name} › ${m.name}` : m.name;
  };
  const base = (m: Milestone | undefined, text: string, source: FindingSource, ref: string, at: number, by: string | null, hours: number | null = null): FindingDraft => {
    const eq = m ? equipmentOf(m, byId) : null;
    const t = tagsIn(text)[0];
    const tag = eq?.tag ?? t ?? null;
    return {
      key: draftKey(source, ref), source, sourceRef: ref,
      kind: guessKind(text, source), topic: guessTopic(text),
      appliesTo: tag ? "equipment" : source === "lesson" || source === "lessons_learned" ? "all" : "project",
      body: text, nextTime: "",
      assetId: eq && eq.tag === tag ? eq.assetId : null, assetTag: tag, unitCode: unit,
      milestoneId: m?.id ?? null, workOrderRef: m?.workOrderRef?.trim() || null,
      hours, foundAt: Number.isFinite(at) ? at : Date.now(), by, on: onOf(m), from: SOURCE_WORD[source],
    };
  };

  // 1. Added scope and discoveries: missed scope, with the hours it added.
  for (const d of discoveries(input.milestones)) {
    const m = d.steps[0];
    const what = clean(d.record.what);
    if (!what) continue;
    const x = base(d.task ?? m, what, "discovery", d.record.id, d.record.foundAt, d.record.foundBy ?? null, Math.round(d.record.impact.hours * 10) / 10);
    x.topic = "Planning";
    x.on = d.task?.name ?? onOf(m);
    x.milestoneId = m?.id ?? null;
    x.workOrderRef = m?.workOrderRef?.trim() || d.task?.workOrderRef?.trim() || null;
    x.from = ADDED[kindOf(d.record)].word;
    out.push(x);
  }

  // 2. Comments and why-it's-behind notes that say something went wrong;
  //    3. hold reasons, with the hours it sat.
  const byStep = new Map<string, MilestoneNote[]>();
  for (const n of input.notes) byStep.set(n.milestoneId, [...(byStep.get(n.milestoneId) ?? []), n]);
  const said: FindingDraft[] = [];
  for (const [stepId, ns] of byStep) {
    const m = byId.get(stepId);
    if (!m || m.cancelledAt) continue;
    const seq = [...ns].sort((a, b) => tms(a.happenedAt ?? a.createdAt) - tms(b.happenedAt ?? b.createdAt));
    seq.forEach((n, i) => {
      const text = clean(n.body);
      if (!text || text.length < 8 || NOISE.test(text)) return;
      const at = tms(n.happenedAt ?? n.createdAt);
      if (n.kind === "status") {
        if (!n.statusAt || !HOLD.has(n.statusAt)) return;
        const off = seq.slice(i + 1).find((x) => x.kind === "status" && x.statusAt && !HOLD.has(x.statusAt));
        const until = off ? tms(off.happenedAt ?? off.createdAt) : NaN;
        const h = Number.isFinite(until) && until > at ? Math.round(((until - at) / 3_600_000) * 10) / 10 : null;
        said.push(base(m, text, "hold", `${stepId}:${hashOf(text.toLowerCase())}`, at, n.createdByName ?? null, h));
        return;
      }
      if ((n.kind === "note" || n.kind === "behind") && SIGNAL.test(text) && !(RESOLVED.test(text) && !STILL_WRONG.test(text))) {
        said.push(base(m, text, "note", `${stepId}:${hashOf(text.toLowerCase())}`, at, n.createdByName ?? null));
      }
    });
  }
  // The same thing said twice on the same equipment (a note copied to the
  // next shift): once, the fuller wording.
  for (const x of said.sort((a, b) => a.foundAt - b.foundAt)) {
    // The very same words on the same step (one key), or nearly the same on
    // the same equipment: one suggestion; time on hold adds up.
    const same = out.find((y) => y.key === x.key)
      ?? out.find((y) => (y.source === "note" || y.source === "hold") && tagKey(y.assetTag) === tagKey(x.assetTag) && alike(y.body, x.body));
    if (same) {
      if (x.body.length > same.body.length) same.body = x.body;
      if (x.hours) same.hours = same.source === "hold" && x.source === "hold" && same.hours ? Math.round((same.hours + x.hours) * 10) / 10 : same.hours ?? x.hours;
      continue;
    }
    out.push(x);
  }

  // 4. The team's close-out lessons.
  for (const l of input.lessons ?? []) {
    const text = clean(l.text);
    if (!text) continue;
    const x = base(undefined, text, "lesson", l.id, l.at, l.by ?? null);
    if (l.kind === "keep") x.nextTime = text;
    out.push(x);
  }

  // 5. The old "Lessons learned" box: a line each, headings left out.
  for (const l of lessonsLearnedLines(input.lessonsLearned)) out.push(base(undefined, l.text, "lessons_learned", l.ref, Date.now(), null));

  // 6. The project's records: cost, change orders, late work, rejected
  //    turnover items, missing evidence (what the old box drafted).
  for (const r of input.records ?? []) {
    const text = clean(r.text);
    if (!text) continue;
    const x = base(undefined, text, "record", r.ref, Date.now(), null);
    out.push({ ...x, kind: r.kind, topic: r.topic, appliesTo: "project", assetTag: null, assetId: null, nextTime: clean(r.nextTime) });
  }

  return out.sort((a, b) => a.foundAt - b.foundAt);
}

// ─── The review ────────────────────────────────────────────────────

export interface ReviewState {
  /** Suggestions not reviewed yet, and findings written during the job. */
  toReview: Array<{ draft: FindingDraft; row: Finding | null }>;
  kept: Finding[];
  dropped: Finding[];
}

/** Where the review stands: every suggestion and every finding written
 *  during the job is reviewed once; a suggestion kept or dropped doesn't
 *  come back. */
export function reviewState(drafts: FindingDraft[], rows: Finding[]): ReviewState {
  const seen = new Set(rows.filter((r) => r.sourceRef).map((r) => draftKey(r.source, r.sourceRef)));
  const toReview: ReviewState["toReview"] = [
    ...drafts.filter((d) => !seen.has(d.key)).map((draft) => ({ draft, row: null })),
    ...rows.filter((r) => r.status === "open").map((row) => ({ draft: draftOf(row), row })),
  ].sort((a, b) => a.draft.foundAt - b.draft.foundAt);
  return {
    toReview,
    kept: rows.filter((r) => r.status === "kept").sort((a, b) => a.foundAt - b.foundAt),
    dropped: rows.filter((r) => r.status === "dropped").sort((a, b) => a.foundAt - b.foundAt),
  };
}

/** A saved finding as an editable draft. */
export function draftOf(r: Finding): FindingDraft {
  return {
    key: r.sourceRef ? draftKey(r.source, r.sourceRef) : `row:${r.id}`, source: r.source, sourceRef: r.sourceRef ?? "",
    kind: r.kind, appliesTo: r.appliesTo, topic: r.topic, body: r.body, nextTime: r.nextTime,
    assetId: r.assetId, assetTag: r.assetTag, unitCode: r.unitCode,
    milestoneId: r.milestoneId, workOrderRef: r.workOrderRef, hours: r.hours, foundAt: r.foundAt,
    by: r.createdByName, on: null, from: SOURCE_WORD[r.source] ?? "+ Finding",
  };
}

/** Is it ready to keep: something said, and the equipment named when
 *  it's about equipment. */
export function fieldsProblem(f: FindingFields): string | null {
  if (!f.body.trim()) return "Say what happened.";
  if (f.appliesTo === "equipment" && !f.assetTag?.trim()) return "Pick the equipment.";
  if (f.appliesTo === "unit" && !f.unitCode) return "Pick the project's unit in Setup first, or choose another Applies to.";
  return null;
}

// ─── From past jobs ────────────────────────────────────────────────

export interface PastJobsContext {
  projectId: string;
  unitCode: string | null;
  /** The equipment on this project's work orders. */
  equipment: Equipment[];
  /** "Turnaround" (lib/projectType). */
  projectType: string;
}

const sameType = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Kept findings from other projects that bear on this one: its
 *  equipment, its unit, and every-job lessons from projects of its kind. */
export function pastJobsFor(findings: Finding[], ctx: PastJobsContext): Finding[] {
  const ids = new Set(ctx.equipment.map((e) => e.assetId).filter(Boolean) as string[]);
  const tags = new Set(ctx.equipment.map((e) => tagKey(e.tag)));
  return findings.filter((f) => {
    // "This project": about that project only.
    if (f.status !== "kept" || f.projectId === ctx.projectId || f.appliesTo === "project") return false;
    if (f.assetId && ids.has(f.assetId)) return true;
    // By tag alone only within the unit: V-7 on another unit is another V-7.
    if (f.assetTag && tags.has(tagKey(f.assetTag)) && (!f.unitCode || !ctx.unitCode || f.unitCode === ctx.unitCode)) return true;
    if (f.appliesTo === "unit" && f.unitCode && f.unitCode === ctx.unitCode) return true;
    if (f.appliesTo === "all" && sameType(f.projectType, ctx.projectType)) return true;
    return false;
  }).sort((a, b) => b.foundAt - a.foundAt);
}

/** One line for a finding, the way Ask, the plan and the graph say it:
 *  "E-12 · Material · Only 20 of 24 seal rings ordered (6 h) · Next time:
 *  order 24". */
export function findingLine(f: Pick<Finding, "kind" | "assetTag" | "body" | "nextTime" | "hours" | "source">): string {
  const h = f.hours != null && f.hours > 0 ? ` (${f.hours} h${f.source === "discovery" ? " of work added" : f.source === "hold" ? " on hold" : ""})` : "";
  return [f.assetTag, KIND_WORD[f.kind], `${f.body}${h}`, f.nextTime?.trim() ? `Next time: ${f.nextTime.trim()}` : null].filter(Boolean).join(" · ");
}

// ─── Database ──────────────────────────────────────────────────────

const missingTable = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache|could not find the table/i.test(e.message ?? ""));

export class FindingsMissing extends Error {
  constructor() { super(`Findings need the database update (${FINDINGS_SQL}) run first.`); }
}

interface Row {
  id: string; org_id: string; project_id: string; kind: FindingKind; applies_to: AppliesTo; topic: string;
  body: string; next_time: string | null; asset_id: string | null; asset_tag: string | null; unit_code: string | null;
  project_type: string | null; milestone_id: string | null; work_order_ref: string | null; hours: number | string | null;
  source: FindingSource; source_ref: string | null; status: FindingStatus; found_at: string;
  created_by: string | null; created_by_name: string | null; reviewed_by_name: string | null; reviewed_at: string | null;
}

export function findingFromRow(r: Row): Finding {
  const topic = (TOPICS as readonly string[]).includes(r.topic) ? (r.topic as Topic) : "Other";
  return {
    id: r.id, orgId: r.org_id, projectId: r.project_id, kind: KINDS.includes(r.kind) ? r.kind : "problem",
    appliesTo: APPLIES.includes(r.applies_to) ? r.applies_to : "project", topic,
    body: r.body ?? "", nextTime: r.next_time ?? "", assetId: r.asset_id, assetTag: r.asset_tag, unitCode: r.unit_code,
    projectType: r.project_type, milestoneId: r.milestone_id, workOrderRef: r.work_order_ref,
    hours: r.hours == null ? null : Number(r.hours), source: r.source, sourceRef: r.source_ref, status: r.status,
    foundAt: Date.parse(r.found_at), createdBy: r.created_by, createdByName: r.created_by_name,
    reviewedByName: r.reviewed_by_name, reviewedAt: r.reviewed_at ? Date.parse(r.reviewed_at) : null,
  };
}

/** This project's findings, every status. `missing`: the table isn't there yet. */
type Page = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
const missingMsg = (e: string) => missingTable({ message: e });

export async function listFindings(projectId: string): Promise<{ rows: Finding[]; missing: boolean }> {
  const { rows, error } = await fetchAllRows<Row>((from, to) => supabase.from("project_findings").select("*").eq("project_id", projectId).order("found_at").order("id").range(from, to) as unknown as Page);
  if (error) { if (missingMsg(error)) return { rows: [], missing: true }; throw new Error(error); }
  return { rows: rows.map(findingFromRow), missing: false };
}

/** Kept findings across the organization (From past jobs, the graph): one
 *  read shared by everything that asks within a few seconds. */
const keptInflight = new Map<string, { at: number; p: Promise<{ rows: Finding[]; missing: boolean }> }>();
export function listKeptFindings(orgId: string): Promise<{ rows: Finding[]; missing: boolean }> {
  const had = keptInflight.get(orgId);
  if (had && Date.now() - had.at < 5_000) return had.p;
  const p = readKeptFindings(orgId);
  keptInflight.set(orgId, { at: Date.now(), p });
  p.catch(() => keptInflight.delete(orgId));
  return p;
}
async function readKeptFindings(orgId: string): Promise<{ rows: Finding[]; missing: boolean }> {
  const { rows, error } = await fetchAllRows<Row>((from, to) => supabase.from("project_findings").select("*").eq("org_id", orgId).eq("status", "kept").order("found_at", { ascending: false }).order("id").range(from, to) as unknown as Page);
  if (error) { if (missingMsg(error)) return { rows: [], missing: true }; throw new Error(error); }
  return { rows: rows.map(findingFromRow), missing: false };
}

export interface SaveFinding extends FindingFields {
  id?: string;
  orgId: string;
  projectId: string;
  projectType: string | null;
  milestoneId?: string | null;
  workOrderRef?: string | null;
  hours?: number | null;
  source: FindingSource;
  sourceRef?: string | null;
  status: FindingStatus;
  foundAt?: number;
  actor: { id: string | null; name: string | null };
}

/** Write a finding: a new one, a suggestion kept or dropped (once: its
 *  source ref), or a change to one saved. */
export async function saveFinding(f: SaveFinding): Promise<Finding> {
  const reviewed = f.status !== "open";
  const row: Record<string, unknown> = {
    org_id: f.orgId, project_id: f.projectId, kind: f.kind, applies_to: f.appliesTo, topic: f.topic,
    body: noEmDash(f.body.trim()), next_time: noEmDash(f.nextTime.trim()) || null,
    asset_id: f.appliesTo === "equipment" ? f.assetId : null,
    // The equipment only when it's about the equipment: "This project" or
    // "All jobs" isn't carried to that equipment's next job.
    asset_tag: f.appliesTo === "equipment" ? f.assetTag?.trim() || null : null,
    unit_code: f.unitCode, project_type: f.projectType,
    milestone_id: f.milestoneId ?? null, work_order_ref: f.workOrderRef ?? null, hours: f.hours ?? null,
    source: f.source, source_ref: f.sourceRef || null, status: f.status,
    updated_at: new Date().toISOString(),
    ...(reviewed ? { reviewed_by: f.actor.id, reviewed_by_name: f.actor.name, reviewed_at: new Date().toISOString() } : { reviewed_by: null, reviewed_by_name: null, reviewed_at: null }),
  };
  if (f.foundAt != null && Number.isFinite(f.foundAt)) row.found_at = new Date(f.foundAt).toISOString();
  const q = f.id
    ? supabase.from("project_findings").update(row).eq("id", f.id).select("*").single()
    : f.sourceRef
      ? supabase.from("project_findings").upsert({ ...row, created_by: f.actor.id, created_by_name: f.actor.name }, { onConflict: "project_id,source,source_ref" }).select("*").single()
      : supabase.from("project_findings").insert({ ...row, created_by: f.actor.id, created_by_name: f.actor.name }).select("*").single();
  const { data, error } = await q;
  if (error) { if (missingTable(error)) throw new FindingsMissing(); throw new Error(error.message); }
  keptInflight.delete(f.orgId);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("findings:changed", { detail: { projectId: f.projectId } }));
  return findingFromRow(data as Row);
}

export async function deleteFinding(id: string, projectId: string): Promise<void> {
  const { error } = await supabase.from("project_findings").delete().eq("id", id);
  if (error) { if (missingTable(error)) throw new FindingsMissing(); throw new Error(error.message); }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("findings:changed", { detail: { projectId } }));
}

export type AckStatus = "planned" | "not_relevant";
export const ACK_WORD: Record<AckStatus, string> = { planned: "Planned for", not_relevant: "Not relevant" };

export async function listAcks(projectId: string): Promise<Map<string, { status: AckStatus; by: string | null; at: number }>> {
  const { data, error } = await supabase.from("finding_acks").select("finding_id, status, by_name, at").eq("project_id", projectId);
  if (error) { if (missingTable(error)) return new Map(); throw new Error(error.message); }
  return new Map(((data ?? []) as Array<{ finding_id: string; status: AckStatus; by_name: string | null; at: string }>).map((r) => [r.finding_id, { status: r.status, by: r.by_name, at: Date.parse(r.at) }]));
}

/** A project's answer to a past finding; null takes it back. */
export async function setAck(input: { orgId: string; projectId: string; findingId: string; status: AckStatus | null; actor: { id: string | null; name: string | null } }): Promise<void> {
  const { error } = input.status
    ? await supabase.from("finding_acks").upsert({
      finding_id: input.findingId, project_id: input.projectId, org_id: input.orgId, status: input.status,
      by_user: input.actor.id, by_name: input.actor.name, at: new Date().toISOString(),
    }, { onConflict: "finding_id,project_id" })
    : await supabase.from("finding_acks").delete().eq("finding_id", input.findingId).eq("project_id", input.projectId);
  if (error) { if (missingTable(error)) throw new FindingsMissing(); throw new Error(error.message); }
  // Every list of past jobs open for this project shows the answer.
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("findings:acks", { detail: { projectId: input.projectId } }));
}
