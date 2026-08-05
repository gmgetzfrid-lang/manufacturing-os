// lib/aiInstructions.ts — Org Playbooks (client side).
//
// Teachable standing instructions for the org's AI: "our transmittals cite
// the PO number", "vendor X drawings put the tag in the lower-right block".
// Taught once, appended to every governed AI call in scope. The idea comes
// from agent skill systems (teach the agent a procedure it keeps); rebuilt
// here as org data — multi-user, RLS-guarded, auditable, deletable.
//
// Scopes:
//   global    — every AI feature
//   knowledge — library asks
//   codebook  — codebook document imports
//   equipment — drawing transcription / equipment extraction

import { supabase } from "@/lib/supabase";

export type AiInstructionScope = "global" | "knowledge" | "codebook" | "equipment";

export const SCOPE_LABELS: Record<AiInstructionScope, string> = {
  global: "Everywhere",
  knowledge: "Knowledge asks",
  codebook: "Codebook imports",
  equipment: "Drawing reading",
};

export interface AiInstruction {
  id: string;
  org_id: string;
  scope: AiInstructionScope;
  title: string;
  body: string;
  enabled: boolean;
  sort: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export async function listAiInstructions(orgId: string): Promise<AiInstruction[]> {
  const { data, error } = await supabase
    .from("org_ai_instructions").select("*")
    .eq("org_id", orgId)
    .order("scope").order("sort").order("created_at");
  if (error) {
    // Pre-migration DB: the feature just isn't set up yet.
    if (error.code === "42P01" || /does not exist/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data as AiInstruction[]) ?? [];
}

export async function saveAiInstruction(
  orgId: string,
  input: {
    id?: string;
    scope: AiInstructionScope;
    title: string;
    body: string;
    enabled?: boolean;
    sort?: number;
  },
  userId: string,
  userName?: string,
): Promise<void> {
  const row = {
    org_id: orgId,
    scope: input.scope,
    title: input.title.trim(),
    body: input.body.trim(),
    enabled: input.enabled ?? true,
    sort: input.sort ?? 0,
    updated_at: new Date().toISOString(),
  };
  const { error } = input.id
    ? await supabase.from("org_ai_instructions").update(row).eq("id", input.id)
    : await supabase.from("org_ai_instructions").insert({
        ...row, created_by: userId, created_by_name: userName ?? null,
      });
  if (error) throw new Error(error.message);
}

export async function deleteAiInstruction(id: string): Promise<void> {
  const { error } = await supabase.from("org_ai_instructions").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Count of instructions active for a scope (its own + global) — the number
 *  behind "N standing instructions apply" chips on AI surfaces. */
export async function countActiveInstructions(
  orgId: string,
  scope: AiInstructionScope,
): Promise<number> {
  const { count, error } = await supabase
    .from("org_ai_instructions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("enabled", true)
    .in("scope", scope === "global" ? ["global"] : ["global", scope]);
  if (error) return 0;
  return count ?? 0;
}
