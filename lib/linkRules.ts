// lib/linkRules.ts — Connection Skills: the org-owned rulebook for link
// discovery.
//
// Every detector the proposer engine runs is a row here, including the ones
// that used to be hardcoded. That is the whole point: the engine ships with
// industry-neutral MECHANICS (follow a cross-reference, notice shared
// equipment, notice questions answered from two documents together) and the
// org supplies the INDUSTRY KNOWLEDGE — which identifier conventions its
// paperwork actually uses — as skills it can author, share org-wide, keep
// private, or switch off.

import { supabase } from "@/lib/supabase";
import { compileSkillPatterns, BUILTIN_SKILLS } from "@/lib/linkProposalLogic";

export { BUILTIN_SKILLS };

export type LinkRuleKind = "reference" | "shared_entity" | "co_citation";
export type LinkRuleVisibility = "org" | "private";

export interface LinkRule {
  id: string;
  org_id: string;
  builtin_key: string | null;
  name: string;
  description: string | null;
  kind: LinkRuleKind;
  config: { patterns?: string[]; minCoCitations?: number };
  enabled: boolean;
  visibility: LinkRuleVisibility;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist/i.test(e.message ?? ""));

/** Skills visible to this member (org-wide plus their own private ones).
 *  Returns null when the migration hasn't run, so callers can say so. */
export async function listLinkRules(orgId: string): Promise<LinkRule[] | null> {
  const { data, error } = await supabase
    .from("link_rules").select("*")
    .eq("org_id", orgId)
    .order("builtin_key", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    if (missing(error)) return null;
    throw new Error(error.message);
  }
  return (data as LinkRule[]) ?? [];
}

/** Idempotently create any missing built-in skills for the org. Runs from
 *  the skills page on load; the unique (org_id, builtin_key) index makes
 *  concurrent seeding harmless. */
export async function seedBuiltinRules(orgId: string, userId: string): Promise<void> {
  const { data, error } = await supabase
    .from("link_rules").select("builtin_key")
    .eq("org_id", orgId).not("builtin_key", "is", null);
  if (error) return; // pre-migration — the caller surfaces that separately
  const have = new Set(((data as Array<{ builtin_key: string }>) ?? []).map((r) => r.builtin_key));
  const want = BUILTIN_SKILLS.filter((b) => !have.has(b.builtin_key));
  if (want.length === 0) return;
  await supabase.from("link_rules").upsert(
    want.map((b) => ({
      org_id: orgId,
      builtin_key: b.builtin_key,
      name: b.name,
      description: b.description,
      kind: b.kind,
      config: b.config,
      enabled: true,
      visibility: "org",
      created_by: userId,
    })),
    { onConflict: "org_id,builtin_key", ignoreDuplicates: true },
  );
}

export async function createLinkRule(input: {
  orgId: string;
  name: string;
  description?: string;
  patterns: string[];
  visibility: LinkRuleVisibility;
  userId: string;
  userName?: string;
}): Promise<void> {
  const { errors } = compileSkillPatterns(input.patterns);
  if (errors.length > 0) throw new Error(errors[0]);
  const patterns = input.patterns.map((p) => p.trim()).filter(Boolean);
  if (patterns.length === 0) throw new Error("Add at least one pattern.");
  const { error } = await supabase.from("link_rules").insert({
    org_id: input.orgId,
    name: input.name.trim(),
    description: (input.description ?? "").trim() || null,
    kind: "reference",
    config: { patterns },
    enabled: true,
    visibility: input.visibility,
    created_by: input.userId,
    created_by_name: input.userName ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function setLinkRuleEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from("link_rules")
    .update({ enabled, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function setLinkRuleVisibility(id: string, visibility: LinkRuleVisibility): Promise<void> {
  const { error } = await supabase.from("link_rules")
    .update({ visibility, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteLinkRule(id: string): Promise<void> {
  const { error } = await supabase.from("link_rules").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Live tester for the wizard: run draft patterns over sample text and show
 *  exactly what would match. Same compiler the engine uses — what the
 *  tester shows is what the run will do. */
export function testSkillPatterns(patterns: string[], sample: string): {
  matches: string[]; errors: string[];
} {
  const { regexes, errors } = compileSkillPatterns(patterns);
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const re of regexes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(sample)) !== null && count < 50) {
      count += 1;
      if (m.index === re.lastIndex) re.lastIndex += 1;
      if (!seen.has(m[0])) { seen.add(m[0]); matches.push(m[0]); }
    }
  }
  return { matches, errors };
}
