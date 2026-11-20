// POST /api/auth/password-set  { password, current? }
//
// A person sets their own password: replacing a one-time password (no
// current password needed, but only while it's still in its day), or
// changing their password later from Profile (the current one is checked).
// Done here, not in the browser, so the new password and clearing the
// one-time flag happen together and the password rules can't be skipped.
// Company emails that must use Microsoft can't get a password at all.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createClient } from "@supabase/supabase-js";
import { mustUseMicrosoft, passwordProblem, tempState, type TempPasswordMeta } from "@/lib/signinPolicy";
import { CLEAR_TEMP, policiesForUser, suspendMemberships } from "@/lib/signinPolicyServer";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(auth.slice(7));
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { password, current } = await req.json().catch(() => ({})) as { password?: string; current?: string };
  if (typeof password !== "string") return NextResponse.json({ error: "Enter a new password." }, { status: 400 });

  if ((await policiesForUser(user.id)).some((p) => mustUseMicrosoft(user.email, p.policy))) {
    return NextResponse.json({ error: "Your account signs in with Microsoft, so it has no password here." }, { status: 403 });
  }

  const meta = (user.app_metadata ?? {}) as TempPasswordMeta;
  const state = tempState(meta);
  if (state === "none") {
    // Changing a password they already own: prove the current one.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    if (!current || !user.email || !url || !anon) return NextResponse.json({ error: "Enter your current password." }, { status: 400 });
    const check = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: wrong } = await check.auth.signInWithPassword({ email: user.email, password: current });
    if (wrong) return NextResponse.json({ error: "Your current password isn't right." }, { status: 403 });
    await check.auth.signOut().catch(() => undefined);
    if (current === password) return NextResponse.json({ error: "Pick a password different from your current one." }, { status: 400 });
  }
  if (state === "expired") {
    await suspendMemberships(user.id);
    return NextResponse.json({ error: "Your one-time password has expired. Ask your admin to reset it." }, { status: 403 });
  }
  const problem = passwordProblem(password, user.email);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const { error: upErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password, app_metadata: { ...CLEAR_TEMP, password_owned: true } });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
