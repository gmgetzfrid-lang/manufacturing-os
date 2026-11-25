// POST /api/admin/reset-password  { orgId, uid, expiresAt }
//
// An Admin or DocCtrl issues a new one-time password for a member who
// signs in with a password (a contractor, a vendor). The member must set
// their own the same day or the account is suspended again. Resetting
// also lifts a suspension from an expired one-time password. Company
// emails that sign in with Microsoft have no password to reset.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { mustUseMicrosoft } from "@/lib/signinPolicy";
import { generateTempPassword, getSigninPolicy, sanitizeExpiry, tempMeta } from "@/lib/signinPolicyServer";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user: caller }, error } = await supabaseAdmin.auth.getUser(auth.slice(7));
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { orgId, uid, expiresAt } = await req.json().catch(() => ({})) as { orgId?: string; uid?: string; expiresAt?: string };
  if (!orgId || !uid) return NextResponse.json({ error: "Missing workspace or member." }, { status: 400 });

  const { data: me } = await supabaseAdmin.from("org_members").select("role").eq("org_id", orgId).eq("uid", caller.id).eq("status", "active").maybeSingle();
  if (!me || !["Admin", "DocCtrl"].includes(String(me.role))) return NextResponse.json({ error: "Only an Admin or document controller can reset passwords." }, { status: 403 });

  const { data: target } = await supabaseAdmin.from("org_members").select("uid, role, status, email").eq("org_id", orgId).eq("uid", uid).maybeSingle();
  if (!target) return NextResponse.json({ error: "That person isn't in this workspace." }, { status: 404 });
  // Same guard as adding members: only an Admin may touch an Admin.
  if (String(target.role) === "Admin" && String(me.role) !== "Admin") return NextResponse.json({ error: "Only an Admin can reset an Admin's password." }, { status: 403 });

  const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(uid);
  const email = authUser?.user?.email ?? (target.email as string | null) ?? null;
  // A password is the person's own, for every workspace they're in: never set
  // by one workspace for someone who also belongs to another (that would let
  // this workspace's admin sign in as them there), nor for an account that
  // signs in with Microsoft. They change it themselves, on their Profile.
  if ((authUser?.user?.identities ?? []).some((i) => i.provider === "azure")) {
    return NextResponse.json({ error: "This person signs in with Microsoft, so there's no password to reset. Their IT account controls it." }, { status: 400 });
  }
  const { data: elsewhere, error: elseErr } = await supabaseAdmin.from("org_members").select("org_id").eq("uid", uid).neq("org_id", orgId).limit(1);
  if (elseErr) return NextResponse.json({ error: "Couldn't check this person's other workspaces. Try again." }, { status: 503 });
  if ((elsewhere ?? []).length > 0) {
    return NextResponse.json({ error: "This person also belongs to another workspace, so their password isn't this workspace's to reset. They can change it on their Profile page." }, { status: 409 });
  }
  const policy = await getSigninPolicy(orgId);
  if (mustUseMicrosoft(email, policy)) return NextResponse.json({ error: "This person signs in with Microsoft, so there's no password to reset. Their IT account controls it." }, { status: 400 });
  if (!policy.allowPasswords) return NextResponse.json({ error: "This workspace doesn't allow password accounts." }, { status: 400 });

  const tempPassword = generateTempPassword();
  const tempExpires = sanitizeExpiry(expiresAt);
  const { error: upErr } = await supabaseAdmin.auth.admin.updateUserById(uid, { password: tempPassword, app_metadata: tempMeta(caller.id, tempExpires) });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // A suspension from an expired one-time password ends with the reset.
  if (target.status === "suspended") {
    await supabaseAdmin.from("org_members").update({ status: "active" }).eq("org_id", orgId).eq("uid", uid);
  }
  await supabaseAdmin.from("audit_logs").insert({
    org_id: orgId, user_id: caller.id, user_email: caller.email ?? null, action: "PASSWORD_RESET",
    resource_type: "user", resource_id: uid, user_role: String(me.role), details: { reactivated: target.status === "suspended", expires_at: tempExpires },
    timestamp: new Date().toISOString(),
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ tempPassword, expiresAt: tempExpires });
}
