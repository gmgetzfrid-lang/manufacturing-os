// lib/ai/governedCall.ts — one governed door to the model for feature routes.
//
// Every AI feature outside the ask pipeline needs the same five things in
// the same order: the caller's OWN key (no workspace fallback), the provider
// allowlist, the signed acceptable-use agreement, the monthly cap, and
// metered spend afterward. Duplicating that stack per route is how one of
// them eventually forgets the cap. This helper is the stack, once.
//
// Server-only: touches ai_connections via the service role.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callAiModel, type AiProviderId, type AiCallResult, type AiCallImage } from "@/lib/ai/providerCall";
import { openAiKey } from "@/lib/ai/keyVault";
import { ALLOWED_PROVIDERS, AGREEMENT_VERSION } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { loadOrgInstructionsBlock } from "@/lib/aiInstructionsServer";

export class GovernedCallError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Run one governed model call on the member's own key. Throws
 *  GovernedCallError with an HTTP status when a gate refuses — routes map
 *  it straight onto the response. */
export async function governedAiCall(input: {
  orgId: string;
  userId: string;
  /** Usage-meter line ("graphShape", "skillAssist", …). */
  op: string;
  /** Org Playbook scope whose standing instructions ride along; omit for none. */
  instructionScope?: "knowledge" | "codebook" | "equipment";
  system: string;
  user: string;
  /** Page images attached to the user turn — quote PDFs, checklists,
   *  quality manuals read as printed. Same gates apply either way. */
  images?: AiCallImage[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<AiCallResult> {
  const { orgId, userId } = input;

  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  if (!conn || !ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
    throw new GovernedCallError(
      "Add your Claude or OpenAI key in AI settings first — AI features run on your own key.", 412);
  }

  {
    const { data: agree, error: agreeError } = await supabaseAdmin
      .from("ai_key_agreements").select("id")
      .eq("org_id", orgId).eq("user_id", userId)
      .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION).limit(1);
    const tableMissing = !!agreeError &&
      (agreeError.code === "42P01" || /does not exist/i.test(agreeError.message));
    if (!tableMissing && (agree ?? []).length === 0) {
      throw new GovernedCallError(
        "Accept the AI acceptable-use agreement first (ask any question in Knowledge to be prompted).", 428);
    }
  }

  const [monthSoFar, capUsd] = await Promise.all([
    getMonthUsage(orgId, userId), getCapUsd(orgId, userId),
  ]);
  if (capUsd > 0 && monthSoFar.spentUsd >= capUsd) {
    throw new GovernedCallError(
      `Monthly AI budget reached ($${monthSoFar.spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}).`, 402);
  }

  const instructions = input.instructionScope
    ? await loadOrgInstructionsBlock(supabaseAdmin, orgId, input.instructionScope)
    : "";

  const provider = conn.provider as AiProviderId;
  const model = String(conn.model);
  try {
    const out = await callAiModel({
      provider, model,
      apiKey: openAiKey(String(conn.api_key)),
      system: input.system + instructions,
      user: input.user,
      images: input.images,
      maxTokens: input.maxTokens ?? 2000,
      timeoutMs: input.timeoutMs ?? 45_000,
    });
    await recordAskUsage({ orgId, userId, provider, model, usage: out.usage, ok: true, op: input.op });
    return out;
  } catch (e) {
    await recordAskUsage({
      orgId, userId, provider, model,
      usage: { inputTokens: 0, outputTokens: 0 }, ok: false, op: input.op,
    }).catch(() => { /* metering failure must not mask the real error */ });
    throw e;
  }
}
