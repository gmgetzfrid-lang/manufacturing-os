// /api/ai/connection — the ONLY door to ai_connections (BYO provider keys).
//
// PER-USER KEYS ONLY. There is no workspace/org key: every member brings
// their own API key, spends their own money, and is metered individually.
// The api_key column is service-role-only by design (RLS with zero client
// policies): a browser can never SELECT it, masked or not. This route:
//
//   GET    ?orgId=…            → { personal, effective } (masked: no keys)
//   POST   { orgId, provider, model, apiKey? }
//                              → save YOUR key. apiKey optional on update so
//                                the model can change without re-pasting.
//   POST   { action: "test" }  → live 1-line call so a bad key fails HERE,
//                                not on someone's first real question.
//   DELETE { orgId }           → remove your connection.
//
// Auth mirrors /api/storage/*: bearer session + active org membership.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callAiModel, AiCallError, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, PROVIDER_BLOCK_MESSAGE } from "@/lib/ai/pricing";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

// The ONLY providers a key may be saved or tested for. Providers that can
// train on submitted data never get in the door.
const providerBlocked = (provider: AiProviderId | undefined) =>
  !provider || !ALLOWED_PROVIDERS.includes(provider);

async function authMember(req: NextRequest, orgId: string) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return null;
  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, role, roles, display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member) return null;
  const roles = new Set<string>([member.role as string, ...((member.roles as string[]) ?? [])]);
  return {
    userId: user.id,
    name: (member.display_name as string) || (member.email as string) || "Member",
    isController: roles.has("Admin") || roles.has("DocCtrl"),
  };
}

type Row = { user_id: string | null; provider: string; model: string; key_last4: string | null; updated_at: string };
const mask = (r: Row | null) =>
  r ? { provider: r.provider, model: r.model, keyLast4: r.key_last4, updatedAt: r.updated_at } : null;

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);

  const { data, error } = await supabaseAdmin
    .from("ai_connections")
    .select("user_id, provider, model, key_last4, updated_at")
    .eq("org_id", orgId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (error) {
    // Never swallow this — an empty modal with no reason is undiagnosable.
    const missing = error.code === "42P01" || /does not exist/i.test(error.message);
    return bad(
      missing
        ? "The ai_connections table doesn't exist yet — run migration 20260911 in Supabase, then reopen this dialog."
        : `Couldn't load your connection: ${error.message}`,
      missing ? 424 : 500,
    );
  }
  const personal = mask((data as Row | null) ?? null);
  return NextResponse.json({
    org: null,                               // workspace keys are retired
    personal,
    effective: personal,
    canManageOrg: auth.isController,
  });
}

export async function POST(req: NextRequest) {
  let body: {
    orgId?: string; scope?: string; provider?: string; model?: string;
    apiKey?: string; action?: string;
  };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);

  if (body.scope === "org") {
    return bad("Workspace keys are retired — everyone uses their own personal API key.", 410);
  }

  // ── Test: run a real 1-line call on the saved (or provided) connection ──
  if (body.action === "test") {
    let provider = body.provider as AiProviderId | undefined;
    let model = body.model?.trim();
    let apiKey = body.apiKey?.trim();
    if (!apiKey) {
      const { data: row } = await supabaseAdmin
        .from("ai_connections").select("provider, model, api_key")
        .eq("org_id", orgId).eq("user_id", auth.userId).maybeSingle();
      if (!row) return bad("No key saved yet — enter one first.", 404);
      provider = row.provider as AiProviderId;
      model = (model || row.model) as string;
      apiKey = row.api_key as string;
    }
    if (!provider || !model || !apiKey) {
      return bad("provider, model and apiKey are required to test.");
    }
    if (providerBlocked(provider)) return bad(PROVIDER_BLOCK_MESSAGE, 403);
    try {
      const out = await callAiModel({
        provider, model, apiKey,
        system: "You are a connection test. Reply with exactly: OK",
        user: "Connection test.",
        maxTokens: 500,
      });
      return NextResponse.json({ ok: true, reply: out.text.slice(0, 80) });
    } catch (e) {
      const err = e as AiCallError;
      return bad(err.message, err.status >= 400 && err.status < 600 ? err.status : 502);
    }
  }

  // ── Save YOUR key ───────────────────────────────────────────────────────
  const provider = body.provider as AiProviderId;
  const model = String(body.model ?? "").trim();
  const apiKey = String(body.apiKey ?? "").trim();
  if (providerBlocked(provider)) return bad(PROVIDER_BLOCK_MESSAGE, 403);
  if (!model) return bad("model is required");

  const { data: existing } = await supabaseAdmin
    .from("ai_connections").select("id, api_key")
    .eq("org_id", orgId).eq("user_id", auth.userId).maybeSingle();

  if (!apiKey && !existing) return bad("An API key is required.");

  const fields = {
    provider, model,
    ...(apiKey ? { api_key: apiKey, key_last4: apiKey.slice(-4) } : {}),
    created_by: auth.userId,
    created_by_name: auth.name,
    updated_at: new Date().toISOString(),
  };
  const { error } = existing
    ? await supabaseAdmin.from("ai_connections").update(fields).eq("id", existing.id as string)
    : await supabaseAdmin.from("ai_connections").insert({ org_id: orgId, user_id: auth.userId, ...fields });
  if (error) return bad(`Couldn't save the connection: ${error.message}`, 500);

  await supabaseAdmin.from("audit_logs").insert({
    action: "AI_CONNECTION_SAVED",
    resource_type: "ai_connection", resource_id: orgId,
    org_id: orgId, user_id: auth.userId,
    details: { scope: "personal", provider, model, keyChanged: !!apiKey },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  let body: { orgId?: string; scope?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);
  if (body.scope === "org") {
    return bad("Workspace keys are retired — nothing to remove.", 410);
  }
  const { error } = await supabaseAdmin
    .from("ai_connections").delete()
    .eq("org_id", orgId).eq("user_id", auth.userId);
  if (error) return bad(`Couldn't remove the connection: ${error.message}`, 500);
  return NextResponse.json({ ok: true });
}
