// /api/ai/agreement — the acceptable-use agreement EVERY user signs before
// their first AI question in a workspace.
//
//   GET  ?orgId=…  → { accepted, version, text } — text is flavored for the
//                    provider whose key will actually receive this user's
//                    prompts (Claude vs OpenAI paragraph).
//   POST { orgId } → record acceptance of the CURRENT version (name, scope
//                    'use', version, IP, timestamp) in ai_key_agreements.
//
// The ask route refuses to answer for anyone without a current-version
// acceptance on file, so this record is a precondition, not decoration.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { AGREEMENT_VERSION, buildAgreementText } from "@/lib/ai/pricing";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function authMember(req: NextRequest, orgId: string) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return null;
  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member) return null;
  return {
    userId: user.id,
    name: (member.display_name as string) || (member.email as string) || "Member",
  };
}

/** The provider whose key answers this user's questions right now —
 *  personal override first, else the org default. */
async function effectiveProvider(orgId: string, userId: string): Promise<string | undefined> {
  const { data } = await supabaseAdmin
    .from("ai_connections").select("user_id, provider")
    .eq("org_id", orgId)
    .or(`user_id.is.null,user_id.eq.${userId}`);
  const rows = data ?? [];
  return (rows.find((r) => r.user_id === userId) ?? rows.find((r) => r.user_id === null))
    ?.provider as string | undefined;
}

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);

  const { data } = await supabaseAdmin
    .from("ai_key_agreements").select("id")
    .eq("org_id", orgId).eq("user_id", auth.userId)
    .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION)
    .limit(1);
  return NextResponse.json({
    accepted: (data ?? []).length > 0,
    version: AGREEMENT_VERSION,
    text: buildAgreementText(await effectiveProvider(orgId, auth.userId)),
  });
}

export async function POST(req: NextRequest) {
  let body: { orgId?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const { error } = await supabaseAdmin.from("ai_key_agreements").insert({
    org_id: orgId,
    user_id: auth.userId,
    user_name: auth.name,
    scope: "use",
    provider: (await effectiveProvider(orgId, auth.userId)) ?? "none",
    key_last4: null,
    agreement_version: AGREEMENT_VERSION,
    ip,
  });
  if (error) {
    const missing = error.code === "42P01" || /does not exist/i.test(error.message);
    return bad(
      missing
        ? "The ai_key_agreements table doesn't exist yet — run migration 20260916 in Supabase first."
        : `Couldn't record the agreement: ${error.message}`,
      missing ? 424 : 500,
    );
  }
  return NextResponse.json({ ok: true, version: AGREEMENT_VERSION });
}
