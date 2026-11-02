// findingsAsk - SERVER-ONLY. What past jobs say about a question, for Ask.
//
// "Warn me about the next Transmix TA", "what about E-12": the findings
// kept at earlier close-out reviews (project_findings) on the equipment,
// the unit or the kind of project the question names, each with the
// project and the date it came from; and, for equipment named, how its
// work ran against the plan on each of those projects. Read-only, scoped to
// the asker's organization. Nothing before 20261115_project_findings.sql.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { fmtInTz, normalizeTimeZone } from "@/lib/scheduleTz";
import { KIND_WORD, findingLine, tagKey, leadTag, EQUIP_TAG, EQUIP_NONE, type FindingKind } from "@/lib/findings";

export interface PastJobHit {
  /** 1-based, for the [J1] marker. */
  n: number;
  projectId: string;
  projectName: string;
  /** When it was found (ms), or the work's planned start for a plan line. */
  at: number;
  /** One line, as Ask quotes it. */
  line: string;
  kind: FindingKind | "work";
  tag: string | null;
}

export interface PastJobs {
  hits: PastJobHit[];
  /** For the answer prompt: one numbered line each. */
  block: string;
}

/** The question is about what happened before, or what to watch for. */
const CUE = /\b(warn\w*|watch(?:\s+out)?|look out|lessons?|learn(?:ed|t)|findings?|past (?:jobs?|turnarounds?|projects?|outages?)|last (?:time|turnaround|TA|outage|shutdown|job|one)|next (?:turnaround|TA|outage|shutdown|job)|went wrong|problems?|issues?|history|before|happened|missed|short|ran (?:long|over)|what about|heads[- ]up|prepare|plan for|expect)\b/i;
const TYPE_RX: Array<[string, RegExp]> = [
  ["Turnaround", /\b(turn[\s-]*arounds?|TA|TAR|T\/A)\b/i],
  ["Outage", /\boutages?\b/i],
  ["Shutdown", /\b(shut[\s-]*downs?|S\/D)\b/i],
];
const GENERIC = new Set(["unit", "units", "turnaround", "project", "october", "november", "december", "january", "february", "march", "april", "june", "july", "august", "september", "plant", "area", "system", "outage", "shutdown", "maintenance", "the", "and", "old"]);
/** Tags as people type them: "E-12", "E12", "e-12"; not "unit 55" or "WO 311388". */
const NOT_TAG = new Set(["api", "asme", "astm", "ansi", "nfpa", "osha", "iso", "nace", "unit", "wo", "no", "ta", "tar", "rev", "page", "pg", "oct", "nov", "dec", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "day", "days", "hour", "shift", "step", "week"]);
export function questionTags(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/\b([A-Za-z]{1,4})(\s?-\s?|\s|)(\d{1,5}[A-Za-z]{0,2})\b/g)) {
    const [, pre, sep, num] = m;
    if (NOT_TAG.has(pre.toLowerCase())) continue;
    // Not equipment: a code section (B31.3), a gas (H2S, CO2), a quarter (Q4).
    if (/^\.\d/.test(q.slice((m.index ?? 0) + m[0].length))) continue;
    if (!sep && /^(H2S?|CO2?|SO2|NH3|O2|N2|Q[1-4])$/i.test(`${pre}${num}`)) continue;
    // "e-12" is a tag; "a 5" and "e12" in lower case may not be.
    if (!sep.includes("-") && pre !== pre.toUpperCase()) continue;
    const t = `${pre.toUpperCase()}-${num.toUpperCase()}`;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
const wordsOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w));

interface Row {
  id: string; project_id: string; kind: FindingKind; applies_to: string; body: string; next_time: string | null;
  asset_tag: string | null; unit_code: string | null; project_type: string | null; hours: number | string | null;
  source: string; found_at: string;
}

const H = 3_600_000;
type Page = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
const ms = (v: unknown) => (v == null ? NaN : Date.parse(String(v)));

/** The past-job findings (and plan-against-actual lines) a question bears
 *  on; null when there are none, or the question isn't about them. */
export async function pastJobsForQuestion(orgId: string, question: string, opts: { limit?: number; always?: boolean } = {}): Promise<PastJobs | null> {
  const limit = opts.limit ?? 14;
  const qTags = questionTags(question);
  const cue = CUE.test(question);
  const type = TYPE_RX.find(([, re]) => re.test(question))?.[0] ?? null;
  // Nothing to go on: no tag, nothing looking ahead or back, no kind of job.
  if (!qTags.length && !cue && !type && !opts.always) return null;
  const { rows, error } = await fetchAllRows<Row>((from, to) => supabaseAdmin.from("project_findings")
    .select("id, project_id, kind, applies_to, body, next_time, asset_tag, unit_code, project_type, hours, source, found_at")
    .eq("org_id", orgId).eq("status", "kept").order("found_at", { ascending: false }).order("id").range(from, to) as unknown as Page);
  if (error || !rows.length) return null;

  const [{ data: units }, { data: projects }] = await Promise.all([
    supabaseAdmin.from("codebook_entries").select("code, label").eq("org_id", orgId).eq("kind", "unit"),
    supabaseAdmin.from("projects").select("id, name, timezone").in("id", [...new Set(rows.map((r) => r.project_id))]),
  ]);
  const projName = new Map(((projects ?? []) as Array<{ id: string; name: string; timezone: string | null }>).map((p) => [p.id, p]));

  const q = question;
  const qWords = new Set(wordsOf(q));
  const tags = new Set(qTags.map(tagKey));
  const unitCodes = new Set<string>();
  for (const u of (units ?? []) as Array<{ code: string; label: string }>) {
    if (wordsOf(u.label).some((w) => qWords.has(w)) || new RegExp(`\\bunit\\s*${u.code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(q)) unitCodes.add(u.code);
  }
  const projHit = new Set<string>();
  for (const p of projName.values()) if (wordsOf(p.name).some((w) => qWords.has(w))) projHit.add(p.id);
  if (!tags.size && !unitCodes.size && !projHit.size && !(cue && type) && !opts.always) return null;

  const sameType = (r: Row) => !!type && (r.project_type ?? "").toLowerCase() === type.toLowerCase();
  // Every-job lessons: for the kind of project asked about, or with the
  // unit or project named and the question looking ahead or back.
  const general = (r: Row) => r.applies_to === "all" && (type ? sameType(r) || !r.project_type : cue && (unitCodes.size > 0 || projHit.size > 0));
  const picked = rows.filter((r) =>
    (r.asset_tag && tags.has(tagKey(r.asset_tag)))
    || (r.unit_code && unitCodes.has(r.unit_code) && cue)
    || (projHit.has(r.project_id) && (cue || !tags.size))
    || general(r)
    || (opts.always && !tags.size && !unitCodes.size && !projHit.size && (!type || sameType(r))));
  // Equipment named first, then the unit, then the rest; newest first within.
  const rank = (r: Row) => (r.asset_tag && tags.has(tagKey(r.asset_tag)) ? 0 : r.unit_code && unitCodes.has(r.unit_code) ? 1 : r.applies_to === "all" ? 3 : 2);
  const chosen = picked.sort((a, b) => rank(a) - rank(b) || ms(b.found_at) - ms(a.found_at)).slice(0, limit);

  const hits: PastJobHit[] = [];
  const dayOf = (t: number, tz: string) => fmtInTz(t, tz, { month: "short", day: "numeric", year: "numeric" });
  for (const r of chosen) {
    const p = projName.get(r.project_id);
    const tz = normalizeTimeZone(p?.timezone);
    hits.push({
      n: hits.length + 1, projectId: r.project_id, projectName: p?.name ?? "A past project", at: ms(r.found_at),
      line: `${p?.name ?? "A past project"} · ${dayOf(ms(r.found_at), tz)} · ${findingLine({ kind: r.kind, assetTag: r.asset_tag, body: r.body, nextTime: r.next_time ?? "", hours: r.hours == null ? null : Number(r.hours), source: r.source as never })}`,
      kind: r.kind, tag: r.asset_tag,
    });
  }

  // How the named equipment's work ran against the plan on each project
  // that had it (the work order's steps: planned span, actual span).
  if (tags.size) {
    const projIds = [...new Set(chosen.filter((r) => r.asset_tag && tags.has(tagKey(r.asset_tag))).map((r) => r.project_id))].slice(0, 4);
    for (const pid of projIds) {
      const { rows: ms_ } = await fetchAllRows<Record<string, unknown>>((from, to) => supabaseAdmin.from("milestones")
        .select("id, name, parent_id, planned_start_at, planned_at, actual_start_at, actual_at, status, attributes, cancelled_at")
        .eq("project_id", pid).order("id").range(from, to) as unknown as Page);
      const list = ms_ as unknown as Array<{ id: string; name: string; parent_id: string | null; planned_start_at: string | null; planned_at: string | null; actual_start_at: string | null; actual_at: string | null; status: string; attributes: Record<string, unknown> | null; cancelled_at: string | null }>;
      const byId = new Map(list.map((m) => [m.id, m]));
      const kids = new Set(list.map((m) => m.parent_id).filter(Boolean) as string[]);
      const tagOf = (m: (typeof list)[number]): string | null => {
        const seen = new Set<string>();
        for (let x: (typeof list)[number] | undefined = m; x && !seen.has(x.id); x = x.parent_id ? byId.get(x.parent_id) : undefined) {
          seen.add(x.id);
          if (x.attributes?.[EQUIP_NONE] === true) return null;
          const t = typeof x.attributes?.[EQUIP_TAG] === "string" ? (x.attributes[EQUIP_TAG] as string) : leadTag(x.name);
          if (t) return t;
        }
        return null;
      };
      const p = projName.get(pid);
      const tz = normalizeTimeZone(p?.timezone);
      const when = (t: number) => fmtInTz(t, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
      for (const k of tags) {
        const steps = list.filter((m) => !kids.has(m.id) && !m.cancelled_at && tagKey(tagOf(m)) === k);
        if (!steps.length) continue;
        const ps = Math.min(...steps.map((s) => ms(s.planned_start_at ?? s.planned_at)).filter(Number.isFinite));
        const pf = Math.max(...steps.map((s) => ms(s.planned_at)).filter(Number.isFinite));
        const as = Math.min(...steps.map((s) => ms(s.actual_start_at)).filter(Number.isFinite));
        const done = steps.every((s) => s.status === "completed");
        const af = done ? Math.max(...steps.map((s) => ms(s.actual_at)).filter(Number.isFinite)) : NaN;
        if (!Number.isFinite(ps) || !Number.isFinite(pf)) continue;
        const tag = tagOf(steps[0]) ?? k.toUpperCase();
        const planned = `planned ${when(ps)} to ${when(pf)} (${Math.round((pf - ps) / H)} h)`;
        const actual = Number.isFinite(as) && Number.isFinite(af) ? `done ${when(as)} to ${when(af)} (${Math.round((af - as) / H)} h)`
          : Number.isFinite(as) ? `started ${when(as)}, not finished` : "not started";
        hits.push({
          n: hits.length + 1, projectId: pid, projectName: p?.name ?? "A past project", at: ps,
          line: `${p?.name ?? "A past project"} · ${tag} work (${steps.length} step${steps.length === 1 ? "" : "s"}): ${planned}; ${actual}`,
          kind: "work", tag,
        });
      }
    }
  }
  if (!hits.length) return null;
  return {
    hits,
    block: "PAST JOBS - findings kept at the close-out reviews of earlier projects in this organization, and how named equipment's work ran against its plan. Cite each as [J1], [J2]… exactly as numbered:\n"
      + hits.map((h) => `[J${h.n}] ${h.line}`).join("\n"),
  };
}

/** The answer when the documents have nothing and past jobs do: their
 *  lines, each cited, newest first. */
export function pastJobsAnswer(p: PastJobs, cite: (h: PastJobHit) => number): string {
  const findings = p.hits.filter((h) => h.kind !== "work");
  const work = p.hits.filter((h) => h.kind === "work");
  const lines = [
    `**Answer:** Past jobs flag ${findings.length} thing${findings.length === 1 ? "" : "s"} for this${work.length ? `, and how the work ran against the plan` : ""}.`,
    ...findings.map((h) => `- ${h.line} [${cite(h)}]`),
    ...(work.length ? ["**Hours against the plan:**", ...work.map((h) => `- ${h.line} [${cite(h)}]`)] : []),
    "! None of this is in the library's documents: it comes from the close-out reviews of past projects.",
  ];
  return lines.join("\n");
}

export const pastJobKindWord = (k: PastJobHit["kind"]) => (k === "work" ? "Plan against actual" : KIND_WORD[k]);
