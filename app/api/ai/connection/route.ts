// /api/ai/connection — the ONLY door to ai_connections (BYO provider keys).
//
// The api_key column is service-role-only by design (RLS with zero client
// policies): a browser can never SELECT it, masked or not. This route:
//
//   GET    ?orgId=…            → { org, personal, effective } (masked: no keys)
//   POST   { orgId, scope, provider, model, apiKey? }
//                              → save org default (controllers) or personal
//                                override (any member). apiKey optional on
//                                update so model can change without re-pasting.
//   POST   { action: "test" }  → live 1-line call so a bad key fails HERE,
//                                not on someone's first real question.
//   DELETE { orgId, scope }    → remove the connection.
//
// Auth mirrors /api/storage/*: bearer session + active org membership.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callAiModel, AiCallError, type AiProviderId } from "@/lib/ai/providerCall";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

const PROVIDERS: AiProviderId[] = ["anthropic", "openai", "gemini"];

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
    .or(`user_id.is.null,user_id.eq.${auth.userId}`);
  if (error) {
    // Never swallow this — an empty modal with no reason is undiagnosable.
    const missing = error.code === "42P01" || /does not exist/i.test(error.message);
    return bad(
      missing
        ? "The ai_connections table doesn't exist yet — run migration 20260911 in Supabase, then reopen this dialog."
        : `Couldn't load connections: ${error.message}`,
      missing ? 424 : 500,
    );
  }
  const rows = (data ?? []) as Row[];
  const org = rows.find((r) => r.user_id === null) ?? null;
  const personal = rows.find((r) => r.user_id === auth.userId) ?? null;
  return NextResponse.json({
    org: mask(org),
    personal: mask(personal),
    effective: mask(personal ?? org),
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

  const scope = body.scope === "personal" ? "personal" : "org";
  if (scope === "org" && !auth.isController) {
    return bad("Only Admin or Doc Control can set the workspace AI connection.", 403);
  }

  // ── Test: run a real 1-line call on the saved (or provided) connection ──
  if (body.action === "test") {
    let provider = body.provider as AiProviderId | undefined;
    let model = body.model?.trim();
    let apiKey = body.apiKey?.trim();
    if (!apiKey) {
      const q = supabaseAdmin.from("ai_connections").select("provider, model, api_key").eq("org_id", orgId);
      const { data: row } = scope === "personal"
        ? await q.eq("user_id", auth.userId).maybeSingle()
        : await q.is("user_id", null).maybeSingle();
      if (!row) return bad("No connection saved yet — enter a key first.", 404);
      provider = row.provider as AiProviderId;
      model = (model || row.model) as string;
      apiKey = row.api_key as string;
    }
    if (!provider || !PROVIDERS.includes(provider) || !model || !apiKey) {
      return bad("provider, model and apiKey are required to test.");
    }
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

  // ── Save ────────────────────────────────────────────────────────────────
  const provider = body.provider as AiProviderId;
  const model = String(body.model ?? "").trim();
  const apiKey = String(body.apiKey ?? "").trim();
  if (!PROVIDERS.includes(provider)) return bad("provider must be anthropic, openai or gemini");
  if (!model) return bad("model is required");

  const userIdValue = scope === "personal" ? auth.userId : null;
  const existingQ = supabaseAdmin.from("ai_connections").select("id, api_key").eq("org_id", orgId);
  const { data: existing } = userIdValue
    ? await existingQ.eq("user_id", userIdValue).maybeSingle()
    : await existingQ.is("user_id", null).maybeSingle();

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
    : await supabaseAdmin.from("ai_connections").insert({ org_id: orgId, user_id: userIdValue, ...fields });
  if (error) return bad(`Couldn't save the connection: ${error.message}`, 500);

  await supabaseAdmin.from("audit_logs").insert({
    action: "AI_CONNECTION_SAVED",
    resource_type: "ai_connection", resource_id: orgId,
    org_id: orgId, user_id: auth.userId,
    details: { scope, provider, model, keyChanged: !!apiKey },
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

  const scope = body.scope === "personal" ? "personal" : "org";
  if (scope === "org" && !auth.isController) {
    return bad("Only Admin or Doc Control can remove the workspace AI connection.", 403);
  }
  const q = supabaseAdmin.from("ai_connections").delete().eq("org_id", orgId);
  const { error } = scope === "personal"
    ? await q.eq("user_id", auth.userId)
    : await q.is("user_id", null);
  if (error) return bad(`Couldn't remove the connection: ${error.message}`, 500);
  return NextResponse.json({ ok: true });
}
