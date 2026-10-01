// POST /api/admin/restore/preview?orgId=...
//
// Body: a backup envelope (the JSON export, or the manifest+tables of a ZIP).
// Returns a RestorePlan — the reconciliation preview the admin approves BEFORE
// anything is written. This endpoint NEVER mutates: it only reads the current
// workspace (org name + members of every RESTORE_LINK_MEMBER_STATUSES status,
// as /begin and /apply read them, so a re-run's placeholders are linked here
// too) to plan how a returning client's data would merge in (additive users
// by email, org-name collision, id remap). A read that fails answers 500 —
// never a plan made against an unread member list.
//
// Restore is the most sensitive action in the app, so it's Admin-only.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { planRestore, type RestoreEnvelopeLike, type CurrentMember, RESTORE_LINK_MEMBER_STATUSES } from "@/lib/dataRestore";

export const runtime = "nodejs";

const RESTORE_ROLES = ["Admin"];

export async function POST(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeOrgRole(req, orgId, RESTORE_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const sb = actor.admin;

  let envelope: RestoreEnvelopeLike;
  try {
    envelope = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body — upload a backup envelope." }, { status: 400 });
  }
  if (!envelope?.manifest || !envelope?.tables) {
    return NextResponse.json({ error: "Not a recognizable backup: missing manifest/tables." }, { status: 400 });
  }

  // Current workspace context — org name + members of every status (email is
  // the join key), exactly as /begin and /apply reconcile.
  const { data: orgRow, error: orgReadErr } = await sb.from("orgs").select("name").eq("id", orgId).maybeSingle();
  const orgName = (orgRow as { name?: string } | null)?.name ?? "";

  const { data: memberRows, error: memberReadErr } = await sb.from("org_members").select("uid, email, status").eq("org_id", orgId).in("status", [...RESTORE_LINK_MEMBER_STATUSES]);
  const readErr = memberReadErr ? { what: "members", e: memberReadErr } : orgReadErr ? { what: "name", e: orgReadErr } : null;
  if (readErr) {
    return NextResponse.json({ error: `Could not read this workspace's ${readErr.what} (${readErr.e.message}) — no plan was made.` }, { status: 500 });
  }
  const members: CurrentMember[] = ((memberRows as Array<{ uid: string; email: string | null; status: string | null }> | null) ?? [])
    .filter((m) => m.email)
    .map((m) => ({ uid: m.uid, email: m.email as string, status: m.status }));

  const plan = planRestore(envelope, { orgId, orgName, members });
  return NextResponse.json({ plan });
}
