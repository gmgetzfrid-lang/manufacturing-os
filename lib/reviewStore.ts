// reviewStore - what a person said on the post-event review (kept, changed,
// added, thrown out, and the answers to its questions), kept with the
// project's settings (projects.shift_times.review), one per phase.
//
// A kept finding is also written to the lessons register (project_findings,
// source "review"), so it reaches Intelligence and the next project's plan
// ("From past jobs"); thrown out or un-kept, it leaves it.

import { supabase } from "@/lib/supabase";
import { saveFinding, FindingsMissing, type FindingKind, type Topic } from "@/lib/findings";
import { CATEGORIES, emptySaved, lessonOf, type AddedFinding, type Answer, type CategoryId, type Finding, type ReviewSaved, type SavedItem } from "@/lib/postEventReview";
import { noEmDash } from "@/lib/noEmDash";

/** The whole project, or one phase. */
export const reviewScope = (phaseId: string | null | undefined) => phaseId || "all";

const str = (v: unknown, max = 4000) => (typeof v === "string" ? noEmDash(v).slice(0, max) : undefined);
const CATS = new Set(CATEGORIES.map((c) => c.id as string));
const RATINGS = new Set(["strength", "opportunity", "gap", "none"]);

function cleanEdit(v: unknown): SavedItem["edits"] {
  if (!v || typeof v !== "object") return undefined;
  const e = v as Record<string, unknown>;
  const out: NonNullable<SavedItem["edits"]> = {};
  for (const k of ["title", "observation", "practice", "gap", "next", "year", "owner", "effect", "why", "ask", "because", "due", "cost"] as const) { const t = str(e[k]); if (t != null && t.trim()) out[k] = t; }
  if (typeof e.rating === "string" && RATINGS.has(e.rating)) out.rating = e.rating as NonNullable<SavedItem["edits"]>["rating"];
  return Object.keys(out).length ? out : undefined;
}

/** A saved review as it is read back: only what belongs in one. */
export function cleanSaved(v: unknown): ReviewSaved {
  const out = emptySaved();
  if (!v || typeof v !== "object") return out;
  const r = v as Record<string, unknown>;
  if (r.items && typeof r.items === "object") {
    for (const [k, x] of Object.entries(r.items as Record<string, unknown>)) {
      if (!x || typeof x !== "object") continue;
      const i = x as Record<string, unknown>;
      const item: SavedItem = {};
      if (i.status === "kept" || i.status === "discarded") item.status = i.status;
      if (i.done === true) item.done = true;
      const e = cleanEdit(i.edits); if (e) item.edits = e;
      if (Array.isArray(i.info)) { const lines = i.info.map((t) => str(t, 1000)?.trim()).filter(Boolean) as string[]; if (lines.length) item.info = lines; }
      if (typeof i.basis === "string") item.basis = i.basis;
      if (typeof i.at === "number") item.at = i.at;
      if (typeof i.by === "string") item.by = i.by;
      if (Object.keys(item).length) out.items[k] = item;
    }
  }
  if (Array.isArray(r.added)) {
    for (const x of r.added) {
      if (!x || typeof x !== "object") continue;
      const a = x as Record<string, unknown>;
      if (typeof a.id !== "string" || typeof a.category !== "string" || !CATS.has(a.category)) continue;
      out.added.push({ ...(cleanEdit(a) ?? {}), id: a.id, category: a.category as CategoryId, at: typeof a.at === "number" ? a.at : 0, by: typeof a.by === "string" ? a.by : null });
    }
  }
  if (r.answers && typeof r.answers === "object") {
    for (const [k, x] of Object.entries(r.answers as Record<string, unknown>)) {
      if (!x || typeof x !== "object") continue;
      const a = x as Record<string, unknown>;
      const ans: Answer = {};
      if (typeof a.cause === "string") ans.cause = a.cause as Answer["cause"];
      const note = str(a.note, 1000)?.trim(); if (note) ans.note = note;
      if (typeof a.at === "number") ans.at = a.at;
      if (typeof a.by === "string") ans.by = a.by;
      if (a.known === "drawing" || a.known === "operations" || a.known === "inspection" || a.known === "no") ans.known = a.known;
      if (ans.cause || ans.note || ans.known) out.answers[k] = ans;
    }
  }
  if (r.readyAfter && typeof r.readyAfter === "object") {
    for (const [k, x] of Object.entries(r.readyAfter as Record<string, unknown>)) if (typeof x === "string" && x) out.readyAfter[k] = x;
  }
  if (r.score && typeof r.score === "object") {
    for (const [k, x] of Object.entries(r.score as Record<string, unknown>)) {
      if (!x || typeof x !== "object") continue;
      const e = x as Record<string, unknown>, plan = str(e.plan, 300)?.trim(), actual = str(e.actual, 300)?.trim();
      const entry = { ...(plan ? { plan } : {}), ...(actual ? { actual } : {}), ...(e.verdict === "met" || e.verdict === "missed" ? { verdict: e.verdict as "met" | "missed" } : {}) };
      if (Object.keys(entry).length) out.score[k] = entry;
    }
  }
  if (r.targets && typeof r.targets === "object") {
    for (const [k, x] of Object.entries(r.targets as Record<string, unknown>)) { const t = str(x, 200)?.trim(); if (t) out.targets[k] = t; }
  }
  return out;
}

export async function loadReview(projectId: string, scope: string): Promise<ReviewSaved> {
  const { data, error } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (error) throw new Error(error.message);
  const st = (data as { shift_times?: Record<string, unknown> | null } | null)?.shift_times;
  const all = st && typeof st.review === "object" && st.review ? (st.review as Record<string, unknown>) : {};
  return cleanSaved(all[scope]);
}

/** Change one phase's review: read it fresh, apply the change, write it
 *  back (every other setting is left alone). Returns what is now saved. */
export async function changeReview(projectId: string, scope: string, change: (s: ReviewSaved) => void): Promise<ReviewSaved> {
  const { data: cur, error: readErr } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  const st = { ...(((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times) ?? {}) };
  const all = { ...((st.review as Record<string, unknown> | undefined) ?? {}) };
  const next = cleanSaved(all[scope]);
  change(next);
  all[scope] = cleanSaved(next);
  st.review = all;
  const { data, error } = await supabase.from("projects").update({ shift_times: st }).eq("id", projectId).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Not saved - only the project's owner, a co-owner, an editor or an admin can change this.");
  return all[scope] as ReviewSaved;
}

const TOPIC: Record<CategoryId, Topic> = { organization: "Staffing", scope: "Planning", planning: "Scheduling", materials: "Materials", contractors: "Contractors", execution: "Scheduling", safety: "Safety", records: "Other", costs: "Other" };
const KIND: Record<CategoryId, FindingKind> = { organization: "lesson", scope: "missed_scope", planning: "lesson", materials: "material", contractors: "lesson", execution: "lesson", safety: "lesson", records: "lesson", costs: "lesson" };

/** Put a finding in the lessons register (kept) or take it out (not kept).
 *  `false`: the register isn't set up in the database yet. */
export async function syncLesson(input: { orgId: string; projectId: string; projectType: string | null; scope: string; finding: Finding; kept: boolean; actor: { id: string | null; name: string | null } }): Promise<boolean> {
  const { finding: f } = input;
  const l = lessonOf(f);
  if (!l.body.trim()) return true;
  try {
    await saveFinding({
      orgId: input.orgId, projectId: input.projectId, projectType: input.projectType,
      kind: KIND[f.category], appliesTo: "all", topic: TOPIC[f.category], body: l.body, nextTime: l.nextTime,
      assetId: null, assetTag: null, unitCode: null,
      source: "review", sourceRef: `${input.scope}:${f.key}`, status: input.kept ? "kept" : "dropped", actor: input.actor,
    });
    return true;
  } catch (e) {
    if (e instanceof FindingsMissing) return false;
    throw e;
  }
}

export type { AddedFinding };
