// GET /api/admin/schema-health — is the database the code assumes actually
// there?
//
// Migrations are applied by hand, and most of lib/ degrades silently when a
// table is missing — a feature ships, deploys green, and renders an empty
// panel because its migration was never run. This route probes every
// expectation in lib/schemaExpectations and names the migration file that
// supplies each missing piece, so "the feature looks empty" becomes "run
// 20260825_work_packages_acks.sql" instead of a mystery.
//
// Admin-only: the answer enumerates the database's shape.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { EXPECTED_TABLES, EXPECTED_COLUMNS } from "@/lib/schemaExpectations";

export const runtime = "nodejs";
export const maxDuration = 60;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

const missingTable = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist/i.test(e.message ?? ""));
const missingColumn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42703" || /column .* does not exist/i.test(e.message ?? ""));

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return bad("Unauthorized", 401);
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  const roles = new Set<string>([member?.role as string, ...(((member?.roles as string[]) ?? []))]);
  if (!member || !roles.has("Admin")) return bad("Admin only", 403);

  // Probe in parallel chunks — HEAD selects, zero rows transferred.
  const tableResults: Array<{ table: string; migration: string; ok: boolean }> = [];
  const CHUNK = 15;
  for (let i = 0; i < EXPECTED_TABLES.length; i += CHUNK) {
    await Promise.all(EXPECTED_TABLES.slice(i, i + CHUNK).map(async (t) => {
      const { error: e } = await supabaseAdmin
        .from(t.table).select("*", { count: "exact", head: true }).limit(0);
      tableResults.push({ ...t, ok: !missingTable(e) });
    }));
  }

  const presentTables = new Set(tableResults.filter((t) => t.ok).map((t) => t.table));
  const columnResults: Array<{ table: string; column: string; migration: string; feature: string; ok: boolean }> = [];
  await Promise.all(EXPECTED_COLUMNS.map(async (c) => {
    // A column probe on a missing table would double-report; the table row
    // already covers it.
    if (!presentTables.has(c.table) && EXPECTED_TABLES.some((t) => t.table === c.table)) {
      columnResults.push({ ...c, ok: false });
      return;
    }
    const { error: e } = await supabaseAdmin
      .from(c.table).select(c.column, { head: true }).limit(0);
    columnResults.push({ ...c, ok: !missingColumn(e) && !missingTable(e) });
  }));

  const missingTables = tableResults.filter((t) => !t.ok).sort((a, b) => a.migration.localeCompare(b.migration));
  const missingColumns = columnResults.filter((c) => !c.ok).sort((a, b) => a.migration.localeCompare(b.migration));
  // The actionable output: which migration FILES need running, in order.
  const migrationsToRun = [...new Set([
    ...missingTables.map((t) => t.migration),
    ...missingColumns.map((c) => c.migration),
  ])].sort();

  return NextResponse.json({
    checkedTables: tableResults.length,
    checkedColumns: columnResults.length,
    healthy: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
    migrationsToRun,
  });
}
