// lib/answerSkillsServer.ts — Reasoning Skills, server side.
//
// Builds the prompt block the answer pipeline carries: every enabled
// org-visible skill, plus the ASKER'S OWN private skills — a private
// reasoning skill changes only its author's answers, never a teammate's.
// Seeds missing built-ins on the way through (service role), so the packs
// work even for an org that has never opened the Skill Library.
//
// A pre-migration database contributes an empty block — questions keep
// answering, just without the disciplines.

import type { SupabaseClient } from "@supabase/supabase-js";
import { BUILTIN_ANSWER_SKILLS } from "@/lib/answerSkillsData";

export interface SkillRow {
  id?: string;
  builtin_key: string | null;
  name: string;
  instructions: string;
  enabled: boolean;
  visibility: string;
  created_by: string | null;
}

/** Bound the whole block so a pile of enthusiastic custom skills can't
 *  crowd out the retrieval context that actually answers the question. */
const BLOCK_BUDGET_CHARS = 9000;

/** Pure assembly, unit-testable: rows in, prompt block out. */
export function buildAnswerSkillsBlock(rows: SkillRow[], askerId: string | null, only?: string[] | null): string {
  const applicable = skillsInPlay(rows, askerId, only);
  if (applicable.length === 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (const r of applicable) {
    // SEARCH: lines are for the query writer, not the answer.
    const body = r.instructions.split("\n").filter((l) => !/^\s*SEARCH:/i.test(l)).join("\n").trim();
    const chunk = `### Skill: ${r.name}\n${body}`;
    if (used + chunk.length > BLOCK_BUDGET_CHARS) break;
    parts.push(chunk);
    used += chunk.length;
  }
  if (parts.length === 0) return "";
  return (
    "\n\nREASONING SKILLS — disciplines this workspace has switched on. Each names when it " +
    "applies; apply the ones the question triggers and ignore the rest. They shape HOW you reason " +
    "and report — they never override the citation and safety rules above.\n\n" +
    parts.join("\n\n")
  );
}

/** The skills that ride on one question: the workspace's enabled ones the
 *  asker may see — or, when the asker picked skills for this question
 *  (`only`: skill ids), exactly those of the ones they may see. */
export function skillsInPlay(rows: SkillRow[], askerId: string | null, only?: string[] | null): SkillRow[] {
  const visible = rows.filter((r) => r.visibility === "org" || (askerId !== null && r.created_by === askerId));
  if (only) return visible.filter((r) => !!r.id && only.includes(r.id));
  return visible.filter((r) => r.enabled);
}

/** Load (seeding built-ins if absent) and assemble the block for one asker. */
export async function loadAnswerSkillsBlock(
  admin: SupabaseClient,
  orgId: string,
  askerId: string | null,
  only?: string[] | null,
): Promise<string> {
  return buildAnswerSkillsBlock(await loadAnswerSkillRows(admin, orgId), askerId, only);
}

/** Every skill row in the workspace, built-ins seeded when missing. */
export async function loadAnswerSkillRows(admin: SupabaseClient, orgId: string): Promise<SkillRow[]> {
  const res = await admin
    .from("answer_skills")
    .select("id, builtin_key, name, instructions, enabled, visibility, created_by")
    .eq("org_id", orgId)
    .limit(200);
  if (res.error) return []; // pre-migration — degrade silently
  const rows = (res.data as SkillRow[]) ?? [];

  const have = new Set(rows.filter((r) => r.builtin_key).map((r) => r.builtin_key));
  const toSeed = BUILTIN_ANSWER_SKILLS.filter((b) => !have.has(b.builtin_key));
  if (toSeed.length > 0) {
    // Plain insert: the unique (org_id, builtin_key) index is PARTIAL, which
    // ON CONFLICT can't infer through the API. A concurrent seeder turns
    // this into a duplicate-key error; either way the rows exist.
    const { data, error } = await admin.from("answer_skills").insert(
      toSeed.map((b) => ({
        org_id: orgId,
        builtin_key: b.builtin_key,
        name: b.name,
        description: b.description,
        instructions: b.instructions,
        enabled: true,
        visibility: "org",
      })),
    ).select("id, builtin_key, name, instructions, enabled, visibility, created_by");
    if (!error) rows.push(...((data as SkillRow[]) ?? []));
  }
  return rows;
}
