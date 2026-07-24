// POST /api/admin/restore/begin?orgId=
// Body: { manifest: { orgId, orgName? }, orgMembers: rows[], orgNameChoice? }
//
// Step 1 of the CHUNKED restore (the path that scales past serverless body
// limits — a real org's envelope JSON is tens of MB, far over the ~4.5MB
// request cap that broke the single-shot apply). This call carries ONLY the
// backup's membership list:
//   • links backup members to current members by email,
//   • creates inactive "restored" placeholders for unknown emails
//     (idempotent — an email that already exists is linked, not duplicated),
//   • applies the org-name choice,
// and returns the full old→new uid map + org map. The client then streams
// tables through /api/admin/restore/apply-table in FK order.
//
// Admin-only, same as apply.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { planRestore, mergeNewUserUids, type CurrentMember } from "@/lib/dataRestore";

export const runtime = "nodejs";

const RESTORE_ROLES = ["Admin"];

export async function POST(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeOrgRole(req, orgId, RESTORE_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const sb = actor.admin;

  let parsed: {
    manifest?: { orgId?: string; orgName?: string };
    orgMembers?: Array<Record<string, unknown>>;
    orgNameChoice?: "backup" | "current";
  };
  try { parsed = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!parsed.manifest?.orgId) {
    return NextResponse.json({ error: "Not a recognizable backup: missing manifest.orgId." }, { status: 400 });
  }
  const members = Array.isArray(parsed.orgMembers) ? parsed.orgMembers : [];
  if (members.length > 20_000) {
    return NextResponse.json({ error: "org_members list is implausibly large." }, { status: 413 });
  }

  // Current context → plan (reusing the pure planner for the user reconciliation).
  const { data: orgRow } = await sb.from("orgs").select("name").eq("id", orgId).maybeSingle();
  const orgName = (orgRow as { name?: string } | null)?.name ?? "";
  const { data: memberRows } = await sb.from("org_members").select("uid, email").eq("org_id", orgId).eq("status", "active");
  const current: CurrentMember[] = ((memberRows as Array<{ uid: string; email: string | null }> | null) ?? [])
    .filter((m) => m.email).map((m) => ({ uid: m.uid, email: m.email as string }));
  const plan = planRestore(
    { manifest: { orgId: parsed.manifest.orgId, orgName: parsed.manifest.orgName }, tables: { org_members: members } },
    { orgId, orgName, members: current },
  );

  // Org-name choice.
  if (plan.orgNameCollision && parsed.orgNameChoice === "backup") {
    await sb.from("orgs").update({ name: plan.orgNameCollision.backupName }).eq("id", orgId);
  }

  // Restored placeholders for unknown emails (inactive — no seat, no auth).
  const created: Record<string, string> = {};
  let createdUsers = 0;
  for (const u of plan.users.filter((x) => x.disposition === "new" && x.oldUid)) {
    const newUid = globalThis.crypto?.randomUUID?.() || `restored-${u.oldUid}`;
    const { error } = await sb.from("org_members").insert({
      org_id: orgId, uid: newUid, email: u.email, role: u.role || "Viewer",
      status: "inactive", display_name: u.displayName ?? null,
    });
    if (!error) {
      try { await sb.from("users").upsert({ id: newUid, email: u.email, display_name: u.displayName ?? null }); } catch { /* profile best-effort */ }
      created[u.oldUid] = newUid;
      createdUsers++;
    }
  }
  const idRemap = mergeNewUserUids(plan.idRemap, created);

  return NextResponse.json({
    ok: true,
    idRemap,
    createdUsers,
    linkedUsers: plan.counts.matchedUsers,
    warnings: plan.warnings,
  });
}
