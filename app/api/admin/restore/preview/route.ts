// POST /api/admin/restore/preview?orgId=...
//
// Body: a backup envelope (the JSON export, or the manifest+tables of a ZIP).
// Returns a RestorePlan — the reconciliation preview the admin approves BEFORE
// anything is written. This endpoint NEVER mutates: it only reads the current
// workspace (org name + active members) to plan how a returning client's data
// would merge in (additive users by email, org-name collision, id remap).
//
// Restore is the most sensitive action in the app, so it's Admin-only.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { planRestore, type RestoreEnvelopeLike, type CurrentMember } from "@/lib/dataRestore";

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

  // Current workspace context — org name + active members (email is the join key).
  const { data: orgRow } = await sb.from("orgs").select("name").eq("id", orgId).maybeSingle();
  const orgName = (orgRow as { name?: string } | null)?.name ?? "";

  const { data: memberRows } = await sb
    .from("org_members")
    .select("uid, email")
    .eq("org_id", orgId)
    .eq("status", "active");
  const members: CurrentMember[] = ((memberRows as Array<{ uid: string; email: string | null }> | null) ?? [])
    .filter((m) => m.email)
    .map((m) => ({ uid: m.uid, email: m.email as string }));

  const plan = planRestore(envelope, { orgId, orgName, members });
  return NextResponse.json({ plan });
}
