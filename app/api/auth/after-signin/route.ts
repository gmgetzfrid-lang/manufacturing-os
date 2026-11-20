// POST /api/auth/after-signin
//
// Called right after a sign-in (and once per visit for a remembered one).
// Applies the workspace's sign-in rules to this session:
//   use_microsoft  a company email signed in with a password: refused
//   expired        a one-time password ran past its day: the account is
//                  suspended now (an admin must reset it)
//   set_password   a one-time password still in its day (or a password
//                  from before this rule, which an admin typed): the person
//                  must set their own before going on
//   ok             nothing to do
// The client signs out on the first two. The suspension stands on its own:
// every table's access rule requires an active membership.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { mustUseMicrosoft, tempState, type TempPasswordMeta } from "@/lib/signinPolicy";
import { policiesForUser, sanitizeExpiry, signInMethod, suspendMemberships, tempMeta } from "@/lib/signinPolicyServer";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const token = auth.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const method = signInMethod(token);
  const policies = await policiesForUser(user.id);

  if (method === "password" && policies.some((p) => mustUseMicrosoft(user.email, p.policy))) {
    return NextResponse.json({ action: "use_microsoft" });
  }

  const meta = (user.app_metadata ?? {}) as TempPasswordMeta;
  const state = tempState(meta);
  if (state === "expired") {
    await suspendMemberships(user.id);
    return NextResponse.json({ action: "expired", expiredAt: meta.temp_expires_at ?? null });
  }
  if (state === "active") return NextResponse.json({ action: "set_password", expiresAt: meta.temp_expires_at });

  // A password nobody but the person should know: accounts from before
  // this rule had theirs typed by an admin. Treat it as a one-time
  // password now: set your own today, or the account is suspended.
  if (method === "password" && !meta.password_owned) {
    const { expiresAt } = await req.json().catch(() => ({})) as { expiresAt?: string };
    const exp = sanitizeExpiry(expiresAt);
    await supabaseAdmin.auth.admin.updateUserById(user.id, { app_metadata: tempMeta("policy", exp) });
    return NextResponse.json({ action: "set_password", expiresAt: exp });
  }
  return NextResponse.json({ action: "ok" });
}
