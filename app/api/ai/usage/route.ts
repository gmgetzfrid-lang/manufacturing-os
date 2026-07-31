// /api/ai/usage — the spend meter behind the AI settings dialog.
//
//   GET  ?orgId=…   → your current-month usage vs your cap:
//                     { spentUsd, capUsd, percent, inputTokens, outputTokens,
//                       asks, avgPromptTokens, monthLabel }
//                     Controllers additionally get { team: [...] } — every
//                     member's month spend — and { orgCapUsd } for the editor.
//   POST { orgId, capUsd } (controllers) → set the org-default monthly cap.
//
// Reads are service-role only: ai_usage_events and ai_usage_limits have RLS
// with zero client policies, so this route is the only window into them.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getMonthUsage, getMonthUsageByUser, getCapUsd, DEFAULT_MONTHLY_CAP_USD,
} from "@/lib/ai/usageServer";

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
    .from("org_members").select("uid, role, roles")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member) return null;
  const roles = new Set<string>([member.role as string, ...((member.roles as string[]) ?? [])]);
  return { userId: user.id, isController: roles.has("Admin") || roles.has("DocCtrl") };
}

const monthLabel = () =>
  new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);

  const [mine, capUsd] = await Promise.all([
    getMonthUsage(orgId, auth.userId),
    getCapUsd(orgId, auth.userId),
  ]);
  const percent = capUsd > 0 ? Math.min(100, Math.round((mine.spentUsd / capUsd) * 100)) : 100;

  const payload: Record<string, unknown> = {
    ...mine, capUsd, percent, monthLabel: monthLabel(),
  };

  if (auth.isController) {
    const [byUser, membersRes, limitsRes] = await Promise.all([
      getMonthUsageByUser(orgId),
      supabaseAdmin.from("org_members")
        .select("uid, display_name, email")
        .eq("org_id", orgId).eq("status", "active"),
      supabaseAdmin.from("ai_usage_limits")
        .select("user_id, monthly_cap_usd")
        .eq("org_id", orgId),
    ]);
    const members = (membersRes.data ?? []) as Array<{ uid: string; display_name: string | null; email: string | null }>;
    const limits = (limitsRes.data ?? []) as Array<{ user_id: string | null; monthly_cap_usd: number | string }>;
    const orgCapRaw = Number(limits.find((l) => l.user_id === null)?.monthly_cap_usd);
    const orgCapUsd = Number.isFinite(orgCapRaw) ? orgCapRaw : DEFAULT_MONTHLY_CAP_USD;
    const overrideByUser = new Map(
      limits.filter((l) => l.user_id !== null).map((l) => [l.user_id as string, Number(l.monthly_cap_usd)]),
    );
    payload.orgCapUsd = orgCapUsd;
    payload.team = members
      .map((m) => {
        const u = byUser.get(m.uid);
        const override = overrideByUser.get(m.uid);
        return {
          userId: m.uid,
          name: m.display_name || m.email || "Member",
          spentUsd: u?.spentUsd ?? 0,
          asks: u?.asks ?? 0,
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          capUsd: Number.isFinite(override) ? (override as number) : orgCapUsd,
          hasOverride: Number.isFinite(override),
        };
      })
      .sort((a, b) => b.spentUsd - a.spentUsd);
  }

  return NextResponse.json(payload);
}

export async function POST(req: NextRequest) {
  // { orgId, capUsd }                → set the org-default cap
  // { orgId, capUsd, userId }        → set THAT person's cap (override)
  // { orgId, capUsd: null, userId }  → clear the override (back to default)
  let body: { orgId?: string; capUsd?: number | null; userId?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);
  if (!auth.isController) return bad("Only Admin or Doc Control can set monthly caps.", 403);

  const targetUserId = String(body.userId ?? "").trim() || null;
  if (targetUserId) {
    const { data: target } = await supabaseAdmin
      .from("org_members").select("uid")
      .eq("org_id", orgId).eq("uid", targetUserId).eq("status", "active")
      .maybeSingle();
    if (!target) return bad("That person isn't an active member of this workspace.", 404);
  }

  // Clearing a per-user override — the person falls back to the org default.
  if (targetUserId && body.capUsd === null) {
    const { error } = await supabaseAdmin
      .from("ai_usage_limits").delete()
      .eq("org_id", orgId).eq("user_id", targetUserId);
    if (error) return bad(`Couldn't clear the cap override: ${error.message}`, 500);
    await supabaseAdmin.from("audit_logs").insert({
      action: "AI_CAP_CHANGED",
      resource_type: "ai_usage_limit", resource_id: orgId,
      org_id: orgId, user_id: auth.userId,
      details: { targetUserId, cleared: true },
    }).then(() => undefined, () => undefined);
    return NextResponse.json({ ok: true, cleared: true });
  }

  const capUsd = Number(body.capUsd);
  if (!Number.isFinite(capUsd) || capUsd < 0 || capUsd > 10000) {
    return bad("capUsd must be a number between 0 and 10000.");
  }

  const readQ = supabaseAdmin.from("ai_usage_limits").select("id").eq("org_id", orgId);
  const { data: existing, error: readError } = targetUserId
    ? await readQ.eq("user_id", targetUserId).maybeSingle()
    : await readQ.is("user_id", null).maybeSingle();
  if (readError) {
    const missing = readError.code === "42P01" || /does not exist/i.test(readError.message);
    return bad(
      missing
        ? "The ai_usage_limits table doesn't exist yet — run migration 20260916 in Supabase first."
        : `Couldn't read the current cap: ${readError.message}`,
      missing ? 424 : 500,
    );
  }
  const fields = { monthly_cap_usd: capUsd, updated_by: auth.userId, updated_at: new Date().toISOString() };
  const { error } = existing
    ? await supabaseAdmin.from("ai_usage_limits").update(fields).eq("id", existing.id as string)
    : await supabaseAdmin.from("ai_usage_limits").insert({ org_id: orgId, user_id: targetUserId, ...fields });
  if (error) return bad(`Couldn't save the cap: ${error.message}`, 500);

  await supabaseAdmin.from("audit_logs").insert({
    action: "AI_CAP_CHANGED",
    resource_type: "ai_usage_limit", resource_id: orgId,
    org_id: orgId, user_id: auth.userId,
    details: targetUserId ? { targetUserId, capUsd } : { capUsd },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, capUsd });
}
