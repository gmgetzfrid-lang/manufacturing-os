// POST /api/admin/remove-member { orgId, memberId }
//
// Takes a person out of a workspace. When it was their last workspace, their
// sign-in account is deleted too (their profile goes with it): an account
// in no workspace is one nobody can use, and it used to land people on the
// "no workspace" screen. Adding them again makes a fresh account.
//
// Admin or Manager of the workspace; only an Admin removes an Admin; nobody
// removes themselves. Logged.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { deleteAccount, membershipsOf } from "@/lib/accountsServer";

export const runtime = "nodejs";

const isAdmin = (m: { role: string | null; roles: string[] | null }) => m.role === "Admin" || (m.roles ?? []).includes("Admin");
const isManager = (m: { role: string | null; roles: string[] | null }) => isAdmin(m) || m.role === "Manager" || (m.roles ?? []).includes("Manager");

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const { data: { user: caller }, error } = await supabaseAdmin.auth.getUser(auth.slice(7));
  if (error || !caller) return NextResponse.json({ error: "Sign in again." }, { status: 401 });

  const { orgId, memberId } = await req.json().catch(() => ({})) as { orgId?: string; memberId?: string };
  if (!orgId || !memberId) return NextResponse.json({ error: "Which person?" }, { status: 400 });

  const { data: me } = await supabaseAdmin.from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", caller.id).eq("status", "active").maybeSingle();
  if (!me || !isManager(me as { role: string | null; roles: string[] | null })) return NextResponse.json({ error: "Only an admin can remove people." }, { status: 403 });

  const { data: target, error: tErr } = await supabaseAdmin.from("org_members").select("id, uid, email, role, roles").eq("org_id", orgId).eq("id", memberId).maybeSingle();
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 503 });
  if (!target) return NextResponse.json({ error: "That person isn't in this workspace any more." }, { status: 404 });
  const t = target as { id: string; uid: string; email: string | null; role: string | null; roles: string[] | null };
  if (t.uid === caller.id) return NextResponse.json({ error: "You can't remove yourself." }, { status: 400 });
  if (isAdmin(t) && !isAdmin(me as { role: string | null; roles: string[] | null })) return NextResponse.json({ error: "Only an Admin can remove an Admin." }, { status: 403 });

  const { error: dErr } = await supabaseAdmin.from("org_members").delete().eq("id", t.id).eq("org_id", orgId);
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 });

  let accountDeleted = false;
  let note: string | null = null;
  try {
    if ((await membershipsOf(t.uid)).length === 0) {
      await deleteAccount(t.uid, "Removed from their last workspace.", { userId: caller.id, email: caller.email ?? null, orgId }, t.email);
      accountDeleted = true;
    }
  } catch (e) {
    // They're out of the workspace either way; the account goes the next time it signs in.
    note = (e as Error).message;
  }
  await supabaseAdmin.from("audit_logs").insert({
    action: "MEMBER_REMOVED", resource_type: "org_member", resource_id: t.id, org_id: orgId, user_id: caller.id, user_email: caller.email ?? null,
    details: { email: t.email, uid: t.uid, accountDeleted, note },
  }).then(() => undefined, () => undefined);
  return NextResponse.json({ removed: true, accountDeleted });
}
