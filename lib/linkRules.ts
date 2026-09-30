// lib/linkRules.ts — Connection Skills: the org-owned rulebook for link
// discovery.
//
// Every detector the proposer engine runs is a row here, including the ones
// that used to be hardcoded. That is the whole point: the engine ships with
// industry-neutral MECHANICS (follow a cross-reference, notice shared
// equipment, notice questions answered from two documents together) and the
// org supplies the INDUSTRY KNOWLEDGE — which identifier conventions its
// paperwork actually uses — as skills it can author, share org-wide, keep
// private, or switch off. Authority (DEC-55, lib/skillAuthority): members
// author private drafts the engine does not run; a controller publishes
// org-wide; built-ins belong to nobody.

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
  updated_at?: string | null;
  /** The author asked a controller to share it org-wide (20261125). */
  share_requested?: boolean | null;
  shared_by?: string | null;
  shared_at?: string | null;
  /** LNK-6: why the engine switched it off (it overran its time budget). */
  disabled_reason?: string | null;
}

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist/i.test(e.message ?? ""));

const REFUSED = "That change was not made — this skill is not yours to change (org-wide and built-in skills are managed by document controllers).";

/** Skills visible to this member (org-wide plus their own; a controller
 *  reads every skill of the org). Returns null when the table is missing
 *  (the migration hasn't run) — an empty library is [] (IRLS-12 limb). */
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

/** Idempotently create any missing built-in skills for the org. HUB-2 /
 *  LNK-7: a built-in belongs to the org — it is written with no author and
 *  only a controller may write one (the Connection Skills list calls this
 *  for controllers only; the engine seeds on the service role on every
 *  run). The unique (org_id, builtin_key) index makes concurrent seeding
 *  harmless. */
export async function seedBuiltinRules(orgId: string): Promise<{ seeded: number; error: string | null }> {
  const { data, error } = await supabase
    .from("link_rules").select("builtin_key")
    .eq("org_id", orgId).not("builtin_key", "is", null);
  if (error) return { seeded: 0, error: missing(error) ? null : error.message };
  const have = new Set(((data as Array<{ builtin_key: string }>) ?? []).map((r) => r.builtin_key));
  const want = BUILTIN_SKILLS.filter((b) => !have.has(b.builtin_key));
  if (want.length === 0) return { seeded: 0, error: null };
  // Plain insert of the missing rows — the unique (org_id, builtin_key)
  // index is PARTIAL, which ON CONFLICT can't infer through the API, so an
  // upsert here fails wholesale. A concurrent seeder makes this insert 23505;
  // the rows exist either way, which is the goal.
  const { error: insErr } = await supabase.from("link_rules").insert(
    want.map((b) => ({
      org_id: orgId,
      builtin_key: b.builtin_key,
      name: b.name,
      description: b.description,
      kind: b.kind,
      config: b.config,
      enabled: true,
      visibility: "org",
      created_by: null,
    })),
  );
  if (insErr && insErr.code !== "23505") return { seeded: 0, error: insErr.message };
  return { seeded: insErr ? 0 : want.length, error: null };
}

export async function createLinkRule(input: {
  orgId: string;
  name: string;
  description?: string;
  patterns: string[];
  /** 'org' is a controller's choice; a member writes 'private', optionally
   *  asking a controller to share it (DEC-55). The database enforces both,
   *  and re-checks every pattern against the bounded subset (LNK-6). */
  visibility: LinkRuleVisibility;
  shareRequested?: boolean;
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
    share_requested: input.visibility === "private" && !!input.shareRequested,
    created_by: input.userId,
    created_by_name: input.userName ?? null,
  });
  if (error) {
    if (error.code === "42501") throw new Error("Only a document controller can publish a skill org-wide — save it as yours and ask for it to be shared.");
    throw new Error(error.message);
  }
}

async function checkedUpdate(id: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabase.from("link_rules")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (((data as unknown[] | null) ?? []).length === 0) throw new Error(REFUSED);
}

export async function setLinkRuleEnabled(id: string, enabled: boolean): Promise<void> {
  await checkedUpdate(id, enabled ? { enabled, disabled_reason: null } : { enabled });
}

/** 'org' is a controller act (publishing, or approving a share request);
 *  an author may always take their own skill back to 'private'. */
export async function setLinkRuleVisibility(id: string, visibility: LinkRuleVisibility): Promise<void> {
  await checkedUpdate(id, visibility === "org" ? { visibility, share_requested: false } : { visibility });
}

/** The author asks (or stops asking) a controller to share it; a controller
 *  declines a request with `false`. */
export async function setLinkRuleShareRequest(id: string, requested: boolean): Promise<void> {
  await checkedUpdate(id, { share_requested: requested });
}

export async function deleteLinkRule(id: string): Promise<void> {
  const { data, error } = await supabase.from("link_rules").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (((data as unknown[] | null) ?? []).length === 0) throw new Error(REFUSED);
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
