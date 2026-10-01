// POST /api/admin/restore/apply-table?orgId=
// Body: { table, rows, idRemap }
//
// Step 2 of the CHUNKED restore: one bounded slice of one table. The client
// walks tables in FK order (orderTablesForRestore) posting ≤500 rows per call,
// so restores of any size fit under serverless request limits.
//
// Security model: the caller is an org Admin who fully controls the row
// content anyway — the hard boundary enforced here is that every row lands in
// THEIR org: org_id is overwritten server-side with the authorized org after
// remapping, the table must be on the export contract (no arbitrary table
// writes), skip-set tables are refused, and a row of a table with no org_id
// lands only under a parent of this workspace. All of it lives in ONE shared
// function, lib/dataRestore.ts applyRestoreChunk, which the single-shot
// /apply route calls too (ORG-1 / BKP-3).

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { applyRestoreChunk, restoreTableRefusal, type RestorePlan } from "@/lib/dataRestore";

export const runtime = "nodejs";

const RESTORE_ROLES = ["Admin"];
const MAX_ROWS_PER_CALL = 1000;

export async function POST(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeOrgRole(req, orgId, RESTORE_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const sb = actor.admin;

  let parsed: { table?: string; rows?: Array<Record<string, unknown>>; idRemap?: RestorePlan["idRemap"]; manifest?: { orgId?: string; orgName?: string } };
  try { parsed = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const table = (parsed.table || "").trim();
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const idRemap = parsed.idRemap;
  // Off-contract, append-only (SURF-8) and reconciled tables are refused
  // before anything is read or written.
  const tableRefusal = restoreTableRefusal(table);
  if (tableRefusal) return NextResponse.json({ error: tableRefusal }, { status: 400 });
  if (rows.length === 0) return NextResponse.json({ ok: true, inserted: 0 });
  if (rows.length > MAX_ROWS_PER_CALL) {
    return NextResponse.json({ error: `Send at most ${MAX_ROWS_PER_CALL} rows per call.` }, { status: 413 });
  }
  if (!idRemap || typeof idRemap !== "object" || !idRemap.orgId || !idRemap.uid) {
    return NextResponse.json({ error: "idRemap missing — call /api/admin/restore/begin first." }, { status: 400 });
  }

  // Remap, FORCE the org boundary, filter, bound org-less rows by their
  // parent, write — the shared function both restore routes call.
  const result = await applyRestoreChunk(sb, { orgId, table, rows, idRemap });
  const { inserted, refused } = result;
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, inserted, ...(refused.length ? { refused } : {}) },
      { status: result.status ?? 500 },
    );
  }

  // SURF-8 done-when 2: every restore chunk leaves an audit row naming the
  // table, the row count and the backup it came from. Checked write — a
  // restore whose trail cannot be written must not look complete.
  const { error: auditErr } = await sb.from("audit_logs").insert({
    action: "RESTORE_CHUNK", resource_type: "org", resource_id: orgId, org_id: orgId,
    user_id: actor.userId, user_email: actor.email,
    details: {
      table, rowsReceived: rows.length, rowsAfterFilters: result.rowsAfterFilters, inserted,
      ...(refused.length ? { refused } : {}),
      backupOrgId: parsed.manifest?.orgId ?? Object.keys(idRemap.orgId ?? {})[0] ?? null,
      backupOrgName: parsed.manifest?.orgName ?? null,
    },
  });
  if (auditErr) {
    return NextResponse.json({ error: `Rows were written but the restore audit row failed: ${auditErr.message}`, inserted }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted, ...(refused.length ? { refused } : {}) });
}
