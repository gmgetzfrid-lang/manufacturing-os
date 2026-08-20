// lib/answerSkills.ts — client-side CRUD for Reasoning Skills.
//
// Reasoning Skills sit next to Connection Skills in the Skill Library: same
// enable/disable, same org-wide/private sharing, same "controllers manage
// org skills, authors manage their own" authority — but where a Connection
// Skill is patterns the ENGINE runs, a Reasoning Skill is an instruction
// pack the AI carries when it ANSWERS.

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
}

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist/i.test(e.message ?? ""));

/** Skills visible to this member. Returns null pre-migration. */
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

/** Idempotently create missing built-ins; harmless under concurrency
 *  thanks to the unique (org_id, builtin_key) index. */
export async function seedBuiltinAnswerSkills(orgId: string, userId: string): Promise<void> {
  const { data, error } = await supabase
    .from("answer_skills").select("builtin_key")
    .eq("org_id", orgId).not("builtin_key", "is", null);
  if (error) return;
  const have = new Set(((data as Array<{ builtin_key: string }>) ?? []).map((r) => r.builtin_key));
  const want = BUILTIN_ANSWER_SKILLS.filter((b) => !have.has(b.builtin_key));
  if (want.length === 0) return;
  // Plain insert of the missing rows — the unique (org_id, builtin_key)
  // index is PARTIAL, which ON CONFLICT can't infer through the API, so an
  // upsert here fails wholesale. A concurrent seeder makes this insert 23505;
  // the rows exist either way, which is the goal.
  await supabase.from("answer_skills").insert(
    want.map((b) => ({
      org_id: orgId,
      builtin_key: b.builtin_key,
      name: b.name,
      description: b.description,
      instructions: b.instructions,
      enabled: true,
      visibility: "org",
      created_by: userId,
    })),
  );
}

export async function createAnswerSkill(input: {
  orgId: string;
  name: string;
  description?: string;
  instructions: string;
  visibility: AnswerSkillVisibility;
  userId: string;
  userName?: string;
}): Promise<void> {
  const instructions = input.instructions.trim();
  if (instructions.length < 40) {
    throw new Error("Write the discipline out — a reasoning skill needs real instructions, including when it applies.");
  }
  const { error } = await supabase.from("answer_skills").insert({
    org_id: input.orgId,
    name: input.name.trim(),
    description: (input.description ?? "").trim() || null,
    instructions: instructions.slice(0, 4000),
    enabled: true,
    visibility: input.visibility,
    created_by: input.userId,
    created_by_name: input.userName ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function setAnswerSkillEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from("answer_skills")
    .update({ enabled, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function setAnswerSkillVisibility(id: string, visibility: AnswerSkillVisibility): Promise<void> {
  const { error } = await supabase.from("answer_skills")
    .update({ visibility, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteAnswerSkill(id: string): Promise<void> {
  const { error } = await supabase.from("answer_skills").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
