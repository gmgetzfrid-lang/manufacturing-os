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

interface SkillRow {
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
export function buildAnswerSkillsBlock(rows: SkillRow[], askerId: string | null): string {
  const applicable = rows.filter((r) =>
    r.enabled && (r.visibility === "org" || (askerId !== null && r.created_by === askerId)));
  if (applicable.length === 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (const r of applicable) {
    const chunk = `### Skill: ${r.name}\n${r.instructions.trim()}`;
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

/** Load (seeding built-ins if absent) and assemble the block for one asker. */
export async function loadAnswerSkillsBlock(
  admin: SupabaseClient,
  orgId: string,
  askerId: string | null,
): Promise<string> {
  const res = await admin
    .from("answer_skills")
    .select("builtin_key, name, instructions, enabled, visibility, created_by")
    .eq("org_id", orgId)
    .limit(200);
  if (res.error) return ""; // pre-migration — degrade silently
  const rows = (res.data as SkillRow[]) ?? [];

  const have = new Set(rows.filter((r) => r.builtin_key).map((r) => r.builtin_key));
  const toSeed = BUILTIN_ANSWER_SKILLS.filter((b) => !have.has(b.builtin_key));
  if (toSeed.length > 0) {
    const { error } = await admin.from("answer_skills").upsert(
      toSeed.map((b) => ({
        org_id: orgId,
        builtin_key: b.builtin_key,
        name: b.name,
        description: b.description,
        instructions: b.instructions,
        enabled: true,
        visibility: "org",
      })),
      { onConflict: "org_id,builtin_key", ignoreDuplicates: true },
    );
    if (!error) {
      for (const b of toSeed) {
        rows.push({
          builtin_key: b.builtin_key, name: b.name, instructions: b.instructions,
          enabled: true, visibility: "org", created_by: null,
        });
      }
    }
  }
  return buildAnswerSkillsBlock(rows, askerId);
}
