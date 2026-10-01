// POST /api/admin/restore/apply?orgId=
// Body: { envelope, orgNameChoice?, confirm }
//
// Writes a backup's RECORDS into the current workspace, additively. Admin-only.
// Re-plans server-side (never trusts the client). Steps:
//   1. org-name choice (only if the admin picked the backup's name)
//   2. create inactive "restored" placeholders for unknown emails (no auth, no
//      seat) and build the full old→new uid map
//   3. insert every importable table in FK order through the SAME shared
//      function the chunked /apply-table uses (lib/dataRestore.ts
//      applyRestoreChunk): uids remapped, org_id FORCED to this workspace,
//      only export-contract tables, org-less rows bounded by their parent,
//      all other ids preserved so foreign keys resolve; existing ids are
//      skipped (additive, re-runnable)
//   4. audit (checked — a restore whose trail cannot be written must not
//      look complete)
//
// ORG-1 / BKP-3: an envelope carrying rows for a table that is not on the
// backup contract is refused with 400 before anything is written.
//
// Binaries are NOT re-uploaded here — a referenced file that isn't in storage
// will simply prompt for its archive when opened (Machine A).

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { planRestore, orderTablesForRestore, mergeNewUserUids, applyRestoreChunk, type RestoreEnvelopeLike, type CurrentMember, type RestoreRowRefusal, restoredMemberRoles, restoredMemberHeadline } from "@/lib/dataRestore";

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

  // ORG-1: no arbitrary table writes. Refused before ANY write (org name,
  // placeholders, rows) so a hostile envelope changes nothing.
  const offContract = plan.counts.tables.filter((t) => t.offContract && t.rows > 0).map((t) => t.name);
  if (offContract.length > 0) {
    return NextResponse.json(
      { error: `Not part of the backup contract, never restored: ${offContract.join(", ")}. Nothing was written.`, offContract },
      { status: 400 },
    );
  }

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
      // SURF-8: never mint a privileged row from a backup; the role collection
      // is seeded too (ADD-5) so the placeholder is not born with roles = {}.
      org_id: orgId, uid: newUid, email: u.email, role: restoredMemberHeadline(restoredMemberRoles(u.role, u.roles)), roles: restoredMemberRoles(u.role, u.roles),
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
  const results: Array<{ name: string; inserted: number; existing?: number; uncounted?: number; filtered?: number; error?: string; refused?: RestoreRowRefusal[] }> = [];
  let totalInserted = 0;
  let totalExisting = 0;
  for (const name of order) {
    const raw = envelope.tables[name];
    const rows = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
    if (!rows.length) continue;
    let inserted = 0; let existing = 0; let uncounted = 0; let filtered = 0; let error: string | undefined; const refused: RestoreRowRefusal[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      const r = await applyRestoreChunk(sb, { orgId, table: name, rows: rows.slice(i, i + 500), idRemap });
      inserted += r.inserted;
      existing += r.existing;
      uncounted += r.uncounted;
      filtered += r.filtered;
      refused.push(...r.refused);
      if (!r.ok) { error = r.error ?? "restore write failed"; break; }
    }
    // Report what actually landed — earlier chunks committed even on failure.
    // BKP-5: and what did not — rows whose key already exists were skipped.
    results.push({ name, inserted, ...(existing ? { existing } : {}), ...(uncounted ? { uncounted } : {}), ...(filtered ? { filtered } : {}), error, ...(refused.length ? { refused } : {}) });
    totalInserted += inserted;
    totalExisting += existing;
    if (error) {
      // STOP. Tables are FK-ordered parents-before-children: continuing after
      // a parent failure inserts children referencing rows that never landed
      // (orphans) while the response says ok. Remaining tables are reported
      // as skipped so the admin sees exactly where the restore stopped.
      const idx = order.indexOf(name);
      for (const remaining of order.slice(idx + 1)) {
        results.push({ name: remaining, inserted: 0, error: `skipped: aborted after ${name} failed` });
      }
      break;
    }
  }

  // 4) Audit — checked (ALOG-8): the DATA_RESTORE row is the only record of
  // what this restore wrote, so a failure to write it is surfaced, never
  // swallowed.
  const { error: auditErr } = await sb.from("audit_logs").insert({
    action: "DATA_RESTORE", resource_id: orgId, resource_type: "org", org_id: orgId,
    user_id: actor.userId, user_email: actor.email,
    details: {
      schemaVersion: plan.schemaVersion, createdUsers,
      linkedUsers: plan.counts.matchedUsers, totalInserted, totalExisting,
      backupOrgId: envelope.manifest.orgId ?? null,
      tables: results.map((r) => ({ name: r.name, inserted: r.inserted, existing: r.existing ?? 0, error: r.error, ...(r.refused ? { refused: r.refused.length } : {}) })),
    },
  });
  if (auditErr) {
    return NextResponse.json(
      { error: `Records were written but the restore audit row failed: ${auditErr.message}`, totalInserted, tables: results },
      { status: 500 },
    );
  }

  const failed = results.filter((r) => r.error);
  return NextResponse.json({
    ok: failed.length === 0,
    createdUsers,
    linkedUsers: plan.counts.matchedUsers,
    totalInserted,
    totalExisting,
    tables: results,
    failedTables: failed.map((f) => f.name),
    note:
      "Records restored additively: a row whose key already exists in this workspace was skipped and kept exactly as it is — " +
      "a restore never overwrites or repairs an existing row. File binaries are not re-uploaded here — " +
      "any referenced file that isn't in storage will prompt for its archive when opened. " +
      "Restored users are inactive placeholders; re-invite them to grant access.",
  });
}
