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
//   not_added      the account is in no workspace: nobody added it (a
//                  Microsoft sign-in made it), or it was removed from its
//                  last one. It is deleted, with its profile; accounts are
//                  only made on purpose (lib/accountsServer)
//   ok             nothing to do
// The client signs out on the first three. The suspension stands on its own:
// every table's access rule requires an active membership.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { mustUseMicrosoft, tempState, type TempPasswordMeta } from "@/lib/signinPolicy";
import { policiesForUser, sanitizeExpiry, signInMethod, suspendMemberships, tempMeta } from "@/lib/signinPolicyServer";
import { deleteAccount, isStray, membershipsOf } from "@/lib/accountsServer";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const token = auth.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // In a workspace at all? Asked first, so an account nobody added is never
  // asked to set a password. A failed read is a failed check, never "no".
  let inAny: boolean;
  try { inAny = (await membershipsOf(user.id)).length > 0; }
  catch { return NextResponse.json({ error: "Couldn't check the account." }, { status: 503 }); }
  if (!inAny) {
    try {
      if (await isStray(user.id)) await deleteAccount(user.id, "Signed in, but no workspace has this account.", { userId: null, email: user.email ?? null, orgId: null }, user.email ?? null);
    } catch { /* refused all the same; the next sign-in tries again */ }
    return NextResponse.json({ action: "not_added" });
  }

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
