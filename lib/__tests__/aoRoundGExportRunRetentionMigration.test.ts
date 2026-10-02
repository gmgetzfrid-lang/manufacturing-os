// admin-and-org Round G, package P3 (fix pass 7) — BKP-6 Done-when 3:
// 20261172 gives export_runs a column for each of a retention purge's
// counts (deleted, failed). Shape tests over the one-paste file (DEC-30:
// inventory TEMP table of counts before BEGIN, one transaction, ONE final
// (check, ok, n) SELECT) and over what it relies on: the export_runs
// definition and every later migration touching it, the writer
// (lib/exportRunner.ts retentionRunColumns / closeSucceededRun) and the
// reader (the data-export page), and 20261154's column grant, which the new
// columns stay out of.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { censusSchema } from "./helpers/schemaKeys";
import { RETENTION_COLUMNS_MIGRATION, retentionRunColumns } from "@/lib/exportRunner";

const root = process.cwd();
const MIGRATIONS = join(root, "supabase", "migrations");
const FILE = "20261172_ao_roundG_export_run_retention.sql";
const raw = readFileSync(join(MIGRATIONS, FILE), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");
const numbered = readdirSync(MIGRATIONS).filter((n) => /^\d{8}.*\.sql$/.test(n)).sort();
const COLUMNS = ["retention_deleted", "retention_failed"];
const ddl = sql.slice(sql.indexOf("\nBEGIN;"), sql.indexOf("\nCOMMIT;"));
const verification = sql.slice(sql.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

describe("20261172 — the one-paste shape (DEC-30)", () => {
  it("is the number taken for this fix, and the runner names it", () => {
    expect(numbered.filter((f) => f.startsWith("20261172"))).toEqual([FILE]);
    expect(RETENTION_COLUMNS_MIGRATION).toBe(FILE);
  });

  it("the export_runs guard, then the TEMP inventory BEFORE ONE transaction, then ONE final (check, ok, n) SELECT ending the file", () => {
    const guard = sql.indexOf("IF to_regclass('public.export_runs') IS NULL THEN");
    const temp = sql.indexOf("CREATE TEMP TABLE _ao_g72_before");
    expect(guard).toBeGreaterThan(-1);
    expect(sql).toMatch(/RAISE EXCEPTION '20261172 needs 20260530/);
    expect(guard).toBeLessThan(temp);
    expect(temp).toBeLessThan(sql.indexOf("\nBEGIN;"));
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    const tail = verification.trim();
    expect(tail.split(";").filter((x) => x.trim()).length).toBe(1);
    expect(tail).toMatch(/^SELECT '[^']+' AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    expect(tail).toMatch(/UNION ALL SELECT inventory, NULL, n FROM _ao_g72_before;$/);
    expect(raw).toMatch(/APPLIED BY HAND \(DEC-30\)/);
  });

  it("the inventory is aggregate counts only — never rows", () => {
    const inv = sql.slice(sql.indexOf("CREATE TEMP TABLE"), sql.indexOf("\nBEGIN;"));
    const parts = inv.split(/UNION ALL/);
    expect(parts.length).toBe(6);
    for (const sel of parts) expect(sel).toMatch(/COUNT\(\*\)|has_table_privilege\(/);
    expect(inv).not.toMatch(/SELECT \*|row_to_json|json_agg|string_agg|array_agg|to_jsonb\(/i);
    // what it counts: a re-run, the rows, the runs whose trace records a purge, and the privileges it must leave as they were
    expect(inv).toMatch(/column_name IN \('retention_deleted', 'retention_failed'\)/);
    expect(inv).toMatch(/diagnostics @> '\[\{"step": "s3:retention:done"\}\]'::jsonb/);
    expect(inv).toMatch(/diagnostics @> '\[\{"step": "s3:retention:err"\}\]'::jsonb/);
    expect(inv).toMatch(/'auth_select'[\s\S]*has_table_privilege\('authenticated', 'public\.export_runs', 'SELECT'\)/);
    expect(inv).toMatch(/'anon_select'[\s\S]*has_table_privilege\('anon', 'public\.export_runs', 'SELECT'\)/);
  });

  it("additive only: two nullable integers (no default, no constraint, no backfill), each commented; no policy, grant, function, trigger or index", () => {
    const stmts = ddl.split(";").map((x) => x.trim().replace(/\s+/g, " ")).filter((x) => x && x !== "BEGIN");
    expect(stmts).toEqual([
      "ALTER TABLE export_runs ADD COLUMN IF NOT EXISTS retention_deleted INTEGER, ADD COLUMN IF NOT EXISTS retention_failed INTEGER",
      expect.stringMatching(/^COMMENT ON COLUMN export_runs\.retention_deleted IS 'BKP-6: /),
      expect.stringMatching(/^COMMENT ON COLUMN export_runs\.retention_failed IS 'BKP-6: /),
    ]);
    // statements only (a probe's label may say "no grant changed")
    expect(sql).not.toMatch(/^\s*(CREATE|DROP|ALTER)\s+(OR\s+REPLACE\s+)?(POLICY|FUNCTION|TRIGGER|INDEX|UNIQUE\s+INDEX)\b/im);
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE)\s/m);
    expect(sql).not.toMatch(/^\s*UPDATE\s+export_runs\b/im);
    expect(ddl).not.toMatch(/\bDEFAULT\b|\bNOT\s+NULL\b|\bCHECK\s*\(|\bCONSTRAINT\b/i);
  });

  it("the probes check each limb: both columns' shape and comment, RLS and the member policy kept, no grant changed in either world, the service role", () => {
    for (const c of COLUMNS) {
      expect(verification).toMatch(new RegExp(`column_name = '${c}'\\s+AND data_type = 'integer' AND is_nullable = 'YES' AND column_default IS NULL`));
      expect(verification).toMatch(new RegExp(`attname = '${c}' AND NOT attisdropped\\)\\) LIKE 'BKP-6:%'`));
      expect(verification).toMatch(new RegExp(`has_column_privilege\\('authenticated', 'public\\.export_runs', '${c}', 'SELECT'\\)\\s+= has_table_privilege\\('authenticated', 'public\\.export_runs', 'SELECT'\\)`));
      expect(verification).toMatch(new RegExp(`has_column_privilege\\('service_role', 'public\\.export_runs', '${c}', 'UPDATE'\\)`));
    }
    expect(verification).toMatch(/relrowsecurity FROM pg_class WHERE oid = to_regclass\('public\.export_runs'\)/);
    expect(verification).toMatch(/policyname = 'export_runs_member_select'/);
    expect(verification).toMatch(/= \(SELECT n FROM _ao_g72_before WHERE k = 'auth_select'\)/);
    expect(verification).toMatch(/= \(SELECT n FROM _ao_g72_before WHERE k = 'anon_select'\)/);
    expect(verification).toMatch(/WHERE retention_deleted IS NOT NULL/);
    expect(verification).toMatch(/WHERE retention_failed > 0/);
  });
});

describe("20261172 — what it relies on", () => {
  it("export_runs is defined once (20260530); the only later files touching it are 20260605 (its policy), 20261154 (its privileges) and this one; none adds a column before it", () => {
    const touching = numbered.filter((f) => /\bexport_runs\b/.test(readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "")));
    expect(touching).toEqual([
      "20260530_data_export_schedules.sql",
      "20260605_rls_policies_new_tables.sql",
      "20261154_ao_roundG_export_destinations_select.sql",
      FILE,
    ]);
    const definers = numbered.filter((f) => /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?export_runs\b/i.test(readFileSync(join(MIGRATIONS, f), "utf8")));
    expect(definers).toEqual(["20260530_data_export_schedules.sql"]);
    for (const f of touching.filter((n) => n !== FILE)) {
      expect(readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, ""), f).not.toMatch(/ALTER\s+TABLE\s+(public\.)?export_runs\s+ADD/i);
    }
    const before = censusSchema(undefined, { through: "20261171" }).get("export_runs")!.columns;
    for (const c of COLUMNS) expect(before.has(c), c).toBe(false);
    const after = censusSchema().get("export_runs")!.columns;
    for (const c of COLUMNS) expect(after.has(c), c).toBe(true);
  });

  it("the writer writes exactly these columns, and the page reads them", () => {
    expect(Object.keys(retentionRunColumns({ keepDays: 30, scanned: 1, deleted: 1, failed: 0 })!).sort()).toEqual(COLUMNS);
    const page = readFileSync(join(root, "app", "(protected)", "admin", "data-export", "page.tsx"), "utf8");
    for (const c of COLUMNS) expect(page).toContain(`run.${c}`);
    for (const route of ["run", "run-scheduled"]) {
      const src = readFileSync(join(root, "app", "api", "data-export", route, "route.ts"), "utf8");
      expect(src, route).toMatch(/closeSucceededRun\([\s\S]*?\}, result\.retention\)/);
    }
  });

  it("no member is granted the new columns: 20261154's column grant snapshots the table before them, and no later file grants them", () => {
    const g54 = readFileSync(join(MIGRATIONS, "20261154_ao_roundG_export_destinations_select.sql"), "utf8").replace(/--[^\n]*/g, "");
    const grant = g54.match(/GRANT\s+SELECT\s*\(([^)]*)\)\s*ON\s+TABLE\s+export_runs\s+TO\s+authenticated\s*;/i);
    expect(grant).not.toBeNull();
    for (const c of COLUMNS) expect(grant![1]).not.toMatch(new RegExp(`\\b${c}\\b`));
    for (const f of numbered.filter((n) => n > "20261154_ao_roundG_export_destinations_select.sql")) {
      // statements only (a probe's label may say "no grant changed … on export_runs")
      expect(readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, ""), f).not.toMatch(/^\s*GRANT\s+[^;]*\bON\s+(TABLE\s+)?export_runs\b/im);
    }
  });
});
