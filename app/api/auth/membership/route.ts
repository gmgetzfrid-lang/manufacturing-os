// GET /api/auth/membership - the signed-in account's workspaces, read on
// the server. The app opens with this instead of reading org_members in the
// browser: there, a sign-in that isn't ready yet reads as "no rows" through
// the access rules, which looked exactly like "not in any workspace" and
// sent people to the no-workspace screen, or opened the app as a Viewer.
// Here a bad or expired sign-in is a 401 (sign in again) and a failed read,
// or a sign-in the auth server couldn't check, is a 503 (try again); only a
// real answer says "none".
//
// A member whose profile row is missing gets it made here: they were added
// on purpose, so the row belongs to them (lib/accountsServer).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { membershipsOf, normEmail } from "@/lib/accountsServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(auth.slice(7));
  // Only a sign-in the auth server turned down is "sign in again". One it
  // couldn't check (busy, timed out, down) is "try again": answering 401
  // then would sign the person out for the server's trouble.
  if (error && error.status !== 401 && error.status !== 403) {
    return NextResponse.json({ error: "The server is busy. Try again in a minute." }, { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
  }
  if (error || !user) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  try {
    const memberships = await membershipsOf(user.id);
    const { data: profile, error: pErr } = await supabaseAdmin.from("users").select("id, default_org_id").eq("id", user.id).maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!profile && memberships.some((m) => m.status === "active")) {
      await supabaseAdmin.from("users").insert({ id: user.id, email: normEmail(user.email), updated_at: new Date().toISOString() }).then(() => undefined, () => undefined);
    }
    return NextResponse.json(
      { memberships, defaultOrgId: (profile as { default_org_id?: string | null } | null)?.default_org_id ?? null },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
