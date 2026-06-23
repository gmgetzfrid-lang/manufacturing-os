// POST /api/admin/restore/apply?orgId=
// Body: { envelope, orgNameChoice?, confirm }
//
// Writes a backup's RECORDS into the current workspace, additively. Admin-only.
// Re-plans server-side (never trusts the client). Steps:
//   1. org-name choice (only if the admin picked the backup's name)
//   2. create inactive "restored" placeholders for unknown emails (no auth, no
//      seat) and build the full old→new uid map
//   3. insert every importable table in FK order, remapping org_id + uid,
//      preserving all other ids so foreign keys resolve; existing ids are
//      skipped (additive, re-runnable)
//   4. audit
//
// Binaries are NOT re-uploaded here — a referenced file that isn't in storage
// will simply prompt for its archive when opened (Machine A).

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import {
  planRestore, remapRow, orderTablesForRestore, mergeNewUserUids,
  type RestoreEnvelopeLike, type CurrentMember,
} from "@/lib/dataRestore";

export const runtime = "nodejs";

const RESTORE_ROLES = ["Admin"];

export async function POST(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeOrgRole(req, orgId, RESTORE_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const sb = actor.admin;

  let parsed: { envelope?: RestoreEnvelopeLike; orgNameChoice?: "backup" | "current"; confirm?: boolean };
  try { parsed = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const envelope = parsed.envelope;
  if (!envelope?.manifest || !envelope?.tables) {
    return NextResponse.json({ error: "Not a recognizable backup: missing manifest/tables." }, { status: 400 });
  }
  if (parsed.confirm !== true) {
    return NextResponse.json({ error: "Confirmation required: pass confirm:true to apply." }, { status: 400 });
  }

  // Current context → re-plan.
  const { data: orgRow } = await sb.from("orgs").select("name").eq("id", orgId).maybeSingle();
  const orgName = (orgRow as { name?: string } | null)?.name ?? "";
  const { data: memberRows } = await sb.from("org_members").select("uid, email").eq("org_id", orgId).eq("status", "active");
  const members: CurrentMember[] = ((memberRows as Array<{ uid: string; email: string | null }> | null) ?? [])
    .filter((m) => m.email).map((m) => ({ uid: m.uid, email: m.email as string }));
  const plan = planRestore(envelope, { orgId, orgName, members });

  // 1) Org-name choice.
  if (plan.orgNameCollision && parsed.orgNameChoice === "backup") {
    await sb.from("orgs").update({ name: plan.orgNameCollision.backupName }).eq("id", orgId);
  }

  // 2) Restored placeholders for unknown emails.
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

  // 3) Insert records in FK order.
  const importable = plan.counts.tables.filter((t) => t.willImport && t.rows > 0).map((t) => t.name);
  const order = orderTablesForRestore(importable);
  const results: Array<{ name: string; inserted: number; error?: string }> = [];
  let totalInserted = 0;
  for (const name of order) {
    const rows = (envelope.tables[name] as Record<string, unknown>[] | undefined) ?? [];
    if (!rows.length) continue;
    const mapped = rows.map((r) => remapRow(r, idRemap));
    let inserted = 0; let error: string | undefined;
    for (let i = 0; i < mapped.length; i += 500) {
      const chunk = mapped.slice(i, i + 500);
      // Prefer skip-on-conflict so a re-run is safe; fall back to plain insert
      // for tables without a single-column `id` primary key.
      const up = await sb.from(name).upsert(chunk, { onConflict: "id", ignoreDuplicates: true });
      if (up.error) {
        const ins = await sb.from(name).insert(chunk);
        if (ins.error) { error = ins.error.message; break; }
      }
      inserted += chunk.length;
    }
    results.push({ name, inserted: error ? 0 : inserted, error });
    if (!error) totalInserted += inserted;
  }

  // 4) Audit.
  try {
    await sb.from("audit_logs").insert({
      action: "DATA_RESTORE", resource_id: orgId, resource_type: "org", org_id: orgId,
      user_id: actor.userId, user_email: actor.email,
      details: {
        schemaVersion: plan.schemaVersion, createdUsers,
        linkedUsers: plan.counts.matchedUsers, totalInserted,
        tables: results.map((r) => ({ name: r.name, inserted: r.inserted, error: r.error })),
      },
    });
  } catch { /* best-effort */ }

  const failed = results.filter((r) => r.error);
  return NextResponse.json({
    ok: true,
    createdUsers,
    linkedUsers: plan.counts.matchedUsers,
    totalInserted,
    tables: results,
    failedTables: failed.map((f) => f.name),
    note:
      "Records restored additively (existing ids were skipped). File binaries are not re-uploaded here — " +
      "any referenced file that isn't in storage will prompt for its archive when opened. " +
      "Restored users are inactive placeholders; re-invite them to grant access.",
  });
}
