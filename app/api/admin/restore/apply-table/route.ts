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
// writes), and skip-set tables are refused.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { remapRow, conflictTargetFor, isSkippedTable, type RestorePlan, isImmutableTable, IMMUTABLE_TABLES } from "@/lib/dataRestore";
import { ORG_SCOPED_TABLES, USER_SCOPED_FOR_ORG_TABLES } from "@/lib/exportTables";

export const runtime = "nodejs";

const RESTORE_ROLES = ["Admin"];
const MAX_ROWS_PER_CALL = 1000;

const IMPORTABLE = new Set<string>([...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES]);

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
  if (!table || !IMPORTABLE.has(table)) {
    return NextResponse.json({ error: `Table "${table}" is not part of the backup contract.` }, { status: 400 });
  }
  if (isImmutableTable(table)) {
    // SURF-8: append-only / self-insert-only tables cannot be blind-imported.
    return NextResponse.json({ error: `Table "${table}" is append-only (${IMMUTABLE_TABLES[table]}); it is never restored by import.` }, { status: 400 });
  }
  if (isSkippedTable(table)) {
    return NextResponse.json({ error: `Table "${table}" is reconciled, never blind-imported.` }, { status: 400 });
  }
  if (rows.length === 0) return NextResponse.json({ ok: true, inserted: 0 });
  if (rows.length > MAX_ROWS_PER_CALL) {
    return NextResponse.json({ error: `Send at most ${MAX_ROWS_PER_CALL} rows per call.` }, { status: 413 });
  }
  if (!idRemap || typeof idRemap !== "object" || !idRemap.orgId || !idRemap.uid) {
    return NextResponse.json({ error: "idRemap missing — call /api/admin/restore/begin first." }, { status: 400 });
  }

  // Remap, then FORCE the org boundary: whatever the backup (or a hostile
  // client) claims, restored rows belong to the authorized workspace.
  let mapped = rows.map((r) => {
    const m = remapRow(r, idRemap);
    if ("org_id" in m) m.org_id = orgId;
    return m;
  });

  // Never resurrect comments onto a ticket that's since been archived to a
  // stub — the JSONB stays cleared, so re-inserting rows would split-brain it.
  if (table === "ticket_comments" && mapped.length) {
    const ticketIds = Array.from(new Set(mapped.map((r) => r.ticket_id).filter(Boolean))) as string[];
    const archived = new Set<string>();
    for (let i = 0; i < ticketIds.length; i += 500) {
      const { data } = await sb
        .from("tickets").select("id")
        .in("id", ticketIds.slice(i, i + 500)).eq("org_id", orgId).not("archived_at", "is", null);
      for (const t of ((data ?? []) as Array<{ id: string }>)) archived.add(t.id);
    }
    if (archived.size) mapped = mapped.filter((r) => !archived.has(r.ticket_id as string));
  }

  let inserted = 0;
  for (let i = 0; i < mapped.length; i += 500) {
    const chunk = mapped.slice(i, i + 500);
    const up = await sb.from(table).upsert(chunk, { onConflict: conflictTargetFor(table), ignoreDuplicates: true, count: "exact" });
    if (up.error) {
      const ins = await sb.from(table).insert(chunk, { count: "exact" });
      if (ins.error) {
        return NextResponse.json({ error: ins.error.message, inserted }, { status: 500 });
      }
      inserted += ins.count ?? chunk.length;
    } else {
      inserted += up.count ?? chunk.length;
    }
  }

  // SURF-8 done-when 2: every restore chunk leaves an audit row naming the
  // table, the row count and the backup it came from. Checked write — a
  // restore whose trail cannot be written must not look complete.
  const { error: auditErr } = await sb.from("audit_logs").insert({
    action: "RESTORE_CHUNK", resource_type: "org", resource_id: orgId, org_id: orgId,
    user_id: actor.userId, user_email: actor.email,
    details: {
      table, rowsReceived: rows.length, rowsAfterFilters: mapped.length, inserted,
      backupOrgId: parsed.manifest?.orgId ?? Object.keys(idRemap.orgId ?? {})[0] ?? null,
      backupOrgName: parsed.manifest?.orgName ?? null,
    },
  });
  if (auditErr) {
    return NextResponse.json({ error: `Rows were written but the restore audit row failed: ${auditErr.message}`, inserted }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted });
}
