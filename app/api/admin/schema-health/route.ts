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
import { EXPECTED_TABLES, EXPECTED_COLUMNS, EXPECTED_FUNCTIONS } from "@/lib/schemaExpectations";

export const runtime = "nodejs";
export const maxDuration = 60;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

// PostgREST answers an absent table with PGRST205 ("Could not find the table
// … in the schema cache") on current versions, 42P01 on older ones — both
// mean missing (BKP-14 / intelligence ILIFE-12: matching 42P01 alone read a
// missing table as present).
const missingTable = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find the table/i.test(e.message ?? ""));
const missingColumn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42703" || /column .* does not exist/i.test(e.message ?? ""));
// An RPC PostgREST cannot resolve (PGRST202), or Postgres cannot find (42883).
// Any other answer — the probe's own 22P02 included — means it is there.
const missingFunction = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST202" || e.code === "42883" || /could not find the function|function .* does not exist/i.test(e.message ?? ""));

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
  const CHUNK = 40; // head-selects are tiny; wide bursts beat serialized chunks
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

  // public-surfaces SHR-12: the functions routes call by RPC. Each probe's
  // arguments are refused by the parameter's type, so nothing is executed.
  const functionResults = await Promise.all(EXPECTED_FUNCTIONS.map(async (f) => {
    const { error: e } = await supabaseAdmin.rpc(f.fn, f.probeArgs);
    return { signature: f.signature, migration: f.migration, feature: f.feature, ok: !missingFunction(e) };
  }));

  // A missing function is listed with the missing tables (the panel lists
  // database objects by name and the file that supplies them), marked as one.
  const missingTables = [
    ...tableResults.filter((t) => !t.ok).map((t) => ({ ...t, kind: "table" as const })),
    ...functionResults.filter((f) => !f.ok).map((f) => ({ table: f.signature, migration: f.migration, feature: f.feature, ok: false, kind: "function" as const })),
  ].sort((a, b) => a.migration.localeCompare(b.migration));
  const missingColumns = columnResults.filter((c) => !c.ok).sort((a, b) => a.migration.localeCompare(b.migration));
  // The actionable output: which migration FILES need running, in order.
  const migrationsToRun = [...new Set([
    ...missingTables.map((t) => t.migration),
    ...missingColumns.map((c) => c.migration),
  ])].sort();

  return NextResponse.json({
    checkedTables: tableResults.length,
    checkedColumns: columnResults.length,
    checkedFunctions: functionResults.length,
    healthy: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
    migrationsToRun,
  });
}
