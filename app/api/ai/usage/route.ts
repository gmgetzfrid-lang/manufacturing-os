// /api/ai/usage — the spend meter behind the AI settings dialog.
//
//   GET  ?orgId=…   → your current-month usage vs your cap:
//                     { spentUsd, capUsd, locked, percent, inputTokens,
//                       outputTokens, asks, calls, byOp, avgPromptTokens,
//                       monthLabel, canManageCaps }
//                     Controllers and cap managers additionally get
//                     { team: [...] } — every member's month spend — and
//                     { orgCapUsd } for the editor.
//   POST { orgId, capUsd } (ai.manage_caps) → set the org-default monthly cap.
//
// ONE meter (GOV-1): the figures are every op the member's calls wrote —
// questions, vision indexing, the meaning index, the assistant, locate,
// flow reading, drafting, imports, connection tests — with `byOp` naming
// which feature spent what. A ledger that cannot be read answers 503, never
// "$0.00" (GOV-4). A $0 cap is LOCKED (GOV-3): `locked: true`, 100%.
// Who may set caps is the `ai.manage_caps` capability (GOV-10, default
// Admin) read from the org's capability policy — never a role list — and
// nobody raises their OWN cap; every change is audited and notifies the
// other holders and the person whose cap moved.
//
// Reads are service-role only: ai_usage_events and ai_usage_limits have RLS
// with zero client policies, so this route is the only window into them.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getMonthUsage, getMonthUsageByUser, getCapUsd, DEFAULT_MONTHLY_CAP_USD, capIsLocked, displayCapUsd,
  type MonthUsage,
} from "@/lib/ai/usageServer";
import { GovernedCallError } from "@/lib/ai/gateError";
import { loadCapabilityPolicyStrict, policyAllows, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { isControllerPrincipal } from "@/lib/permissions";
import type { Role } from "@/types/schema";

export const runtime = "nodejs";

/** GOV-10: the capability that sets monthly AI caps. */
const AI_MANAGE_CAPS = "ai.manage_caps" as const;

function bad(msg: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: msg, ...extra }, { status });
}

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
  const role = member.role as Role;
  const roles = ((member.roles as Role[] | null) ?? []);
  return {
    userId: user.id,
    role,
    roles,
    name: (member.display_name as string) || (member.email as string) || "Member",
    // The controller tier by the held collection (DEC-35: through the helper).
    isController: isControllerPrincipal({ role, roles }),
  };
}
type Auth = NonNullable<Awaited<ReturnType<typeof authMember>>>;

/** The capability decision, fail CLOSED: a policy that cannot be read denies. */
async function capsAuthority(orgId: string, auth: Auth): Promise<{ ok: true; allowed: boolean; policy: CapabilityPolicy } | { ok: false; error: string }> {
  const loaded = await loadCapabilityPolicyStrict(orgId, supabaseAdmin);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, policy: loaded.policy, allowed: policyAllows(loaded.policy, AI_MANAGE_CAPS, auth.role, auth.roles, auth.userId) };
}

const monthLabel = () =>
  new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** GOV-3: a locked cap reads 100%; otherwise spend over cap, clamped. */
function usagePercent(spentUsd: number, capUsd: number): number {
  if (capIsLocked(capUsd)) return 100;
  return Math.min(100, Math.round((spentUsd / capUsd) * 100));
}

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);

  let mine: MonthUsage;
  let capUsd: number;
  try {
    [mine, capUsd] = await Promise.all([
      getMonthUsage(orgId, auth.userId),
      getCapUsd(orgId, auth.userId),
    ]);
  } catch (e) {
    // GOV-4: say it — an unreadable ledger is not "$0.00 spent".
    if (e instanceof GovernedCallError) return bad(e.message, e.status, { usageUnavailable: true });
    throw e;
  }
  const caps = await capsAuthority(orgId, auth);
  const canManageCaps = caps.ok && caps.allowed;

  const payload: Record<string, unknown> = {
    ...mine,
    capUsd: displayCapUsd(capUsd),
    locked: capIsLocked(capUsd),
    percent: usagePercent(mine.spentUsd, capUsd),
    monthLabel: monthLabel(),
    canManageCaps,
  };

  if (auth.isController || canManageCaps) {
    let byUser: Map<string, MonthUsage>;
    try {
      byUser = await getMonthUsageByUser(orgId);
    } catch (e) {
      if (e instanceof GovernedCallError) return bad(e.message, e.status, { usageUnavailable: true });
      throw e;
    }
    const [membersRes, limitsRes] = await Promise.all([
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
    const orgCapUsd = Number.isFinite(orgCapRaw) && orgCapRaw >= 0 ? orgCapRaw : DEFAULT_MONTHLY_CAP_USD;
    const overrideByUser = new Map(
      limits.filter((l) => l.user_id !== null).map((l) => [l.user_id as string, Number(l.monthly_cap_usd)]),
    );
    payload.orgCapUsd = orgCapUsd;
    payload.team = members
      .map((m) => {
        const u = byUser.get(m.uid);
        const override = overrideByUser.get(m.uid);
        const cap = Number.isFinite(override) ? (override as number) : orgCapUsd;
        return {
          userId: m.uid,
          name: m.display_name || m.email || "Member",
          spentUsd: u?.spentUsd ?? 0,
          asks: u?.asks ?? 0,
          calls: u?.calls ?? 0,
          byOp: u?.byOp ?? {},
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          capUsd: cap,
          locked: cap === 0,
          hasOverride: Number.isFinite(override),
        };
      })
      .sort((a, b) => b.spentUsd - a.spentUsd);
  }

  return NextResponse.json(payload);
}

/** Bell notice to every OTHER holder of ai.manage_caps, and to the person
 *  whose own cap moved (GOV-10 done-when 4). Best-effort: the change and its
 *  audit row are already written. */
async function notifyCapChange(orgId: string, auth: Auth, policy: CapabilityPolicy, change: {
  targetUserId: string | null; capUsd: number | null; previousCapUsd: number | null;
}) {
  const { data: members } = await supabaseAdmin
    .from("org_members").select("uid, role, roles")
    .eq("org_id", orgId).eq("status", "active");
  const holders = ((members ?? []) as Array<{ uid: string; role: string | null; roles: string[] | null }>)
    .filter((m) => policyAllows(policy, AI_MANAGE_CAPS, m.role, m.roles ?? [], m.uid))
    .map((m) => m.uid);
  const recipients = new Set(holders);
  if (change.targetUserId) recipients.add(change.targetUserId);
  recipients.delete(auth.userId);
  if (recipients.size === 0) return;
  const what = change.targetUserId ? "a person's monthly AI cap" : "the workspace's default monthly AI cap";
  const fmt = (v: number | null) => (v === null ? "the workspace default" : v === 0 ? "$0 (locked)" : `$${v}`);
  await supabaseAdmin.from("notifications").insert([...recipients].map((uid) => ({
    org_id: orgId,
    user_id: uid,
    kind: "ai_cap_changed",
    title: uid === change.targetUserId ? "Your monthly AI cap changed" : "A monthly AI cap changed",
    body: `${auth.name} changed ${what} from ${fmt(change.previousCapUsd)} to ${fmt(change.capUsd)}.`,
    link: "/intelligence/setup",
    resource_type: "ai_usage_limit",
    resource_id: orgId,
    actor_user_id: auth.userId,
    actor_name: auth.name,
    metadata: { targetUserId: change.targetUserId, capUsd: change.capUsd, previousCapUsd: change.previousCapUsd },
  }))).then(() => undefined, () => undefined);
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
  const caps = await capsAuthority(orgId, auth);
  if (!caps.ok) return bad(`Couldn't read the capability policy, so no cap was changed: ${caps.error}`, 503);
  if (!caps.allowed) {
    return bad("Setting monthly AI caps takes the “Manage AI spend caps” permission (Admin by default — it can be granted in Permissions).", 403);
  }

  const targetUserId = String(body.userId ?? "").trim() || null;
  if (targetUserId) {
    const { data: target } = await supabaseAdmin
      .from("org_members").select("uid")
      .eq("org_id", orgId).eq("uid", targetUserId).eq("status", "active")
      .maybeSingle();
    if (!target) return bad("That person isn't an active member of this workspace.", 404);
  }

  // The cap that applies to the target before this change (display figure:
  // 0 = locked) — the self-raise test and the notice both read it.
  let previousCapUsd: number | null = null;
  if (targetUserId) {
    try { previousCapUsd = displayCapUsd(await getCapUsd(orgId, targetUserId)); }
    catch (e) {
      if (e instanceof GovernedCallError) return bad(e.message, e.status);
      throw e;
    }
  } else {
    const { data: orgRow } = await supabaseAdmin.from("ai_usage_limits")
      .select("monthly_cap_usd").eq("org_id", orgId).is("user_id", null).maybeSingle();
    const raw = Number((orgRow as { monthly_cap_usd?: number | string } | null)?.monthly_cap_usd);
    previousCapUsd = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MONTHLY_CAP_USD;
  }
  // GOV-10: nobody raises their OWN cap — not by an override, not by
  // clearing one onto a higher default. Lowering it is always allowed.
  // (Display figures compare directly: 0 = locked is the lowest.)
  const selfRaise = (next: number) =>
    targetUserId === auth.userId && previousCapUsd !== null && next > previousCapUsd;
  const SELF_RAISE = "You can't raise your own monthly AI cap — another person with the “Manage AI spend caps” permission has to.";

  // Clearing a per-user override — the person falls back to the org default.
  if (targetUserId && body.capUsd === null) {
    const { data: orgRow } = await supabaseAdmin.from("ai_usage_limits")
      .select("monthly_cap_usd").eq("org_id", orgId).is("user_id", null).maybeSingle();
    const rawDefault = Number((orgRow as { monthly_cap_usd?: number | string } | null)?.monthly_cap_usd);
    const fallback = Number.isFinite(rawDefault) && rawDefault >= 0 ? rawDefault : DEFAULT_MONTHLY_CAP_USD;
    if (selfRaise(fallback)) return bad(SELF_RAISE, 403);
    const { error } = await supabaseAdmin
      .from("ai_usage_limits").delete()
      .eq("org_id", orgId).eq("user_id", targetUserId);
    if (error) return bad(`Couldn't clear the cap override: ${error.message}`, 500);
    await supabaseAdmin.from("audit_logs").insert({
      action: "AI_CAP_CHANGED",
      resource_type: "ai_usage_limit", resource_id: orgId,
      org_id: orgId, user_id: auth.userId,
      details: { targetUserId, cleared: true, previousCapUsd },
    }).then(() => undefined, () => undefined);
    await notifyCapChange(orgId, auth, caps.policy, { targetUserId, capUsd: null, previousCapUsd });
    return NextResponse.json({ ok: true, cleared: true });
  }

  const capUsd = Number(body.capUsd);
  if (body.capUsd === null || body.capUsd === undefined || !Number.isFinite(capUsd) || capUsd < 0 || capUsd > 10000) {
    return bad("capUsd must be a number between 0 and 10000 (0 locks AI for that person until it is raised).");
  }
  if (selfRaise(capUsd)) return bad(SELF_RAISE, 403);

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
    details: targetUserId ? { targetUserId, capUsd, previousCapUsd } : { capUsd, previousCapUsd },
  }).then(() => undefined, () => undefined);
  await notifyCapChange(orgId, auth, caps.policy, { targetUserId, capUsd, previousCapUsd });

  return NextResponse.json({ ok: true, capUsd, locked: capUsd === 0 });
}
