// lib/answerSkills.ts — client-side CRUD for Reasoning Skills.
//
// Reasoning Skills sit next to Connection Skills in the Skill Library: same
// enable/disable, same sharing, same authority (DEC-55, lib/skillAuthority):
// a member authors private skills and may ask for one to be shared; only a
// controller publishes org-wide; built-ins belong to nobody. Where a
// Connection Skill is patterns the ENGINE runs, a Reasoning Skill is an
// instruction pack the AI carries when it ANSWERS — org-wide, it rides every
// colleague's prompt, which is why publishing it is a controller act.

import { supabase } from "@/lib/supabase";
import { BUILTIN_ANSWER_SKILLS } from "@/lib/answerSkillsData";

export type AnswerSkillVisibility = "org" | "private";

export interface AnswerSkill {
  id: string;
  org_id: string;
  builtin_key: string | null;
  name: string;
  description: string | null;
  instructions: string;
  enabled: boolean;
  visibility: AnswerSkillVisibility;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at?: string | null;
  /** The author asked a controller to share it org-wide (20261125). */
  share_requested?: boolean | null;
  /** Who shared it org-wide, and when — stamped by the database. */
  shared_by?: string | null;
  shared_at?: string | null;
}

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist/i.test(e.message ?? ""));

/** A write RLS refuses affects zero rows WITHOUT an error — say so instead
 *  of reporting a change that never happened (checked writes). */
const REFUSED = "That change was not made — this skill is not yours to change (org-wide and built-in skills are managed by document controllers).";

/** A column this database does not have yet (20261125 adds share_requested,
 *  shared_by, shared_at): PostgREST answers PGRST204 (Postgres 42703) for a
 *  write that names one. A write names a new column only when it carries
 *  information the database cannot supply itself — sharing is stamped by
 *  20261125's guard, not sent by the client (lib/linkRules does the same). */
const missingColumn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST204" || e.code === "42703");

const SHARE_NEEDS_MIGRATION = "Share requests arrive with the skills-authority migration (20261125), which this database does not have yet.";

/** Skills visible to this member. Returns null when the table is missing
 *  (the migration hasn't run) — an empty library is [] (IRLS-12 limb). */
export async function listAnswerSkills(orgId: string): Promise<AnswerSkill[] | null> {
  const { data, error } = await supabase
    .from("answer_skills").select("*")
    .eq("org_id", orgId)
    .order("builtin_key", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    if (missing(error)) return null;
    throw new Error(error.message);
  }
  return (data as AnswerSkill[]) ?? [];
}

/** Idempotently create missing built-ins. HUB-2: a built-in belongs to the
 *  org, not to whoever opened the page first — it is written with no author,
 *  and only a controller may write one (the Skill Library calls this for
 *  controllers only; the answer pipeline seeds on the service role for
 *  everyone else). Harmless under concurrency: the unique (org_id,
 *  builtin_key) index turns a racing seeder into a duplicate. */
export async function seedBuiltinAnswerSkills(orgId: string): Promise<{ seeded: number; error: string | null }> {
  const { data, error } = await supabase
    .from("answer_skills").select("builtin_key")
    .eq("org_id", orgId).not("builtin_key", "is", null);
  if (error) return { seeded: 0, error: missing(error) ? null : error.message };
  const have = new Set(((data as Array<{ builtin_key: string }>) ?? []).map((r) => r.builtin_key));
  const want = BUILTIN_ANSWER_SKILLS.filter((b) => !have.has(b.builtin_key));
  if (want.length === 0) return { seeded: 0, error: null };
  // Plain insert of the missing rows — the unique (org_id, builtin_key)
  // index is PARTIAL, which ON CONFLICT can't infer through the API, so an
  // upsert here fails wholesale. A concurrent seeder makes this insert 23505;
  // the rows exist either way, which is the goal.
  const { error: insErr } = await supabase.from("answer_skills").insert(
    want.map((b) => ({
      org_id: orgId,
      builtin_key: b.builtin_key,
      name: b.name,
      description: b.description,
      instructions: b.instructions,
      enabled: true,
      visibility: "org",
      created_by: null,
    })),
  );
  // 42501: the database does not admit this person's unowned built-in —
  // before 20261125 the insert policy requires created_by = auth.uid(), and
  // after it the person is not a controller to the database. Nothing is
  // wrong for the viewer either way: the answer pipeline seeds the missing
  // built-ins on the service role. Never fall back to an owned seed (HUB-2).
  if (insErr && (insErr.code === "23505" || insErr.code === "42501")) return { seeded: 0, error: null };
  if (insErr) return { seeded: 0, error: insErr.message };
  return { seeded: want.length, error: null };
}

/** The rules every pack is held to, here and at the database (20261125
 *  answer_skills_guard): 40–4000 characters, and it says when it applies —
 *  the pack rides every question and must gate itself (IEDGE-3). */
export function answerSkillIssue(instructions: string): string | null {
  const t = instructions.trim();
  if (t.length < 40) return "Write the discipline out — a reasoning skill needs real instructions, including when it applies.";
  if (instructions.length > 4000) return `A reasoning skill is at most 4,000 characters (this one is ${instructions.length.toLocaleString("en-US")}).`;
  if (!/applies when/i.test(t)) return "Start the pack with “APPLIES WHEN …” — it rides every question and must say when it applies.";
  return null;
}

export async function createAnswerSkill(input: {
  orgId: string;
  name: string;
  description?: string;
  instructions: string;
  /** 'org' is a controller's choice; a member writes 'private', optionally
   *  asking a controller to share it (DEC-55). The database enforces both. */
  visibility: AnswerSkillVisibility;
  shareRequested?: boolean;
  userId: string;
  userName?: string;
}): Promise<{ note: string | null }> {
  const instructions = input.instructions.trim();
  const issue = answerSkillIssue(instructions);
  if (issue) throw new Error(issue);
  const row: Record<string, unknown> = {
    org_id: input.orgId,
    name: input.name.trim(),
    description: (input.description ?? "").trim() || null,
    instructions,
    enabled: true,
    visibility: input.visibility,
    created_by: input.userId,
    created_by_name: input.userName ?? null,
  };
  // The column defaults to false: it is named only for a request.
  if (input.visibility === "private" && input.shareRequested) row.share_requested = true;
  let { error } = await supabase.from("answer_skills").insert(row);
  let note: string | null = null;
  if (error && missingColumn(error) && "share_requested" in row) {
    // Before 20261125: the skill is saved as the author's own; the request
    // cannot be recorded, and the author is told so.
    delete row.share_requested;
    ({ error } = await supabase.from("answer_skills").insert(row));
    if (!error) note = `Saved as your private skill. ${SHARE_NEEDS_MIGRATION} Ask again once it is applied.`;
  }
  if (error) {
    if (error.code === "42501") throw new Error("Only a document controller can publish a skill org-wide — save it as yours and ask for it to be shared.");
    throw new Error(error.message);
  }
  return { note };
}

async function checkedUpdate(id: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabase.from("answer_skills")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("id");
  if (error) throw new Error(missingColumn(error) && "share_requested" in patch ? SHARE_NEEDS_MIGRATION : error.message);
  if (((data as unknown[] | null) ?? []).length === 0) throw new Error(REFUSED);
}

export async function setAnswerSkillEnabled(id: string, enabled: boolean): Promise<void> {
  await checkedUpdate(id, { enabled });
}

/** 'org' is a controller act (publishing, or approving a share request);
 *  an author may always take their own skill back to 'private'. Publishing
 *  clears the share request — 20261125's guard does it on the flip. */
export async function setAnswerSkillVisibility(id: string, visibility: AnswerSkillVisibility): Promise<void> {
  await checkedUpdate(id, { visibility });
}

/** The author asks (or stops asking) a controller to share it; a controller
 *  declines a request with `false`. */
export async function setAnswerSkillShareRequest(id: string, requested: boolean): Promise<void> {
  await checkedUpdate(id, { share_requested: requested });
}

export async function deleteAnswerSkill(id: string): Promise<void> {
  const { data, error } = await supabase.from("answer_skills").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (((data as unknown[] | null) ?? []).length === 0) throw new Error(REFUSED);
}
