// lib/ai/governedCall.ts — one governed door to the model for feature routes.
//
// Every AI feature outside the ask pipeline needs the same five things in
// the same order: the caller's OWN key (no workspace fallback), the provider
// allowlist, the signed acceptable-use agreement, the monthly cap, and
// metered spend afterward. Duplicating that stack per route is how one of
// them eventually forgets the cap. The stack itself lives in lib/ai/aiGates
// (shared with the routes that call the model directly); this helper is the
// stack plus ONE call: the call's worst case is reserved before it is made
// (GOV-13) and settled to the provider's own counts after.
//
// Server-only: touches ai_connections via the service role.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callAiModel, type AiProviderId, type AiCallResult, type AiCallImage } from "@/lib/ai/providerCall";
import { assertAiGates } from "@/lib/ai/aiGates";
import { loadOrgInstructionsBlock } from "@/lib/aiInstructionsServer";
import { GovernedCallError } from "@/lib/ai/gateError";

// The refusal class lives in lib/ai/gateError (the ledger throws it too);
// re-exported here under the name every caller imports.
export { GovernedCallError };

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

  // Own key → allowlist → agreement → cap (every op) — or a refusal.
  const gate = await assertAiGates({ orgId, userId, op: input.op });

  const instructions = input.instructionScope
    ? await loadOrgInstructionsBlock(supabaseAdmin, orgId, input.instructionScope)
    : "";

  const { provider, model, apiKey } = gate.connection;
  const system = input.system + instructions;
  const maxTokens = input.maxTokens ?? 2000;
  // The worst case of THIS call, written before it is made: refused (402)
  // when it does not fit, and visible to every concurrent call.
  const reservation = await gate.reserve({
    inputChars: system.length + input.user.length,
    images: input.images?.length ?? 0,
    maxTokens,
  });
  try {
    const out = await callAiModel({
      provider: provider as AiProviderId, model,
      apiKey,
      system,
      user: input.user,
      images: input.images,
      maxTokens,
      timeoutMs: input.timeoutMs ?? 45_000,
    });
    await reservation.settle({ usage: out.usage, ok: true });
    return out;
  } catch (e) {
    // settle never throws: a metering failure must not mask the real error.
    await reservation.settle({ usage: { inputTokens: 0, outputTokens: 0 }, ok: false });
    throw e;
  }
}
