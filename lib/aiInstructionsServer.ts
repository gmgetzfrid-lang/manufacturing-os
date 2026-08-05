// lib/aiInstructionsServer.ts — SERVER-ONLY loader for Org Playbooks.
//
// Called by every governed AI route before it builds its prompt: load the
// org's enabled standing instructions for the feature's scope (plus global
// ones) and render them as a bounded system-prompt block. An org with no
// instructions gets an empty string — zero cost, zero behavior change.

import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_BLOCK_CHARS = 4_000; // instructions ride on every call — keep bounded

/** Load and render the org's standing instructions for a feature scope.
 *  Returns "" when none exist (or on a pre-migration DB). Never throws —
 *  a playbook lookup failure must not take an AI feature down with it. */
export async function loadOrgInstructionsBlock(
  admin: SupabaseClient,
  orgId: string,
  scope: "knowledge" | "codebook" | "equipment",
): Promise<string> {
  try {
    const { data, error } = await admin
      .from("org_ai_instructions")
      .select("scope, title, body")
      .eq("org_id", orgId).eq("enabled", true)
      .in("scope", ["global", scope])
      .order("sort").order("created_at")
      .limit(50);
    if (error || !data || data.length === 0) return "";
    let out = "\n\nSTANDING INSTRUCTIONS from this organization (follow them; they reflect this site's own conventions and override generic assumptions):\n";
    for (const r of data as Array<{ title: string; body: string }>) {
      const line = `- ${String(r.title).trim()}: ${String(r.body).trim()}\n`;
      if (out.length + line.length > MAX_BLOCK_CHARS) break;
      out += line;
    }
    return out;
  } catch {
    return "";
  }
}
