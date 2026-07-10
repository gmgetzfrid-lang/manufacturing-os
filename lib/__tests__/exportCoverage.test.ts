// lib/__tests__/exportCoverage.test.ts
//
// THE BACKUP COMPLETENESS TRIPWIRE. A full-org backup is only "complete" if
// every table that exists is either exported or deliberately excluded with a
// written reason. This test diffs the export contract (lib/exportTables.ts)
// against every CREATE TABLE in supabase/schema.sql + supabase/migrations/.
//
// If you just added a table and this test failed: decide its backup fate —
// add it to ORG_SCOPED_TABLES (org data), USER_SCOPED_FOR_ORG_TABLES
// (per-user data joined via membership), or EXPORT_EXCLUDED_TABLES (with the
// reason it must not be copied) — and, unless excluded, give it a restore
// position in RESTORE_TABLE_ORDER or a skip reason in SKIP_TABLES.
//
// This exact failure mode shipped once: compliance tables (acknowledgment
// signatures, review sign-offs) existed for weeks while backups silently
// omitted them, and three phantom `cost_*` tables marked every backup
// INCOMPLETE. Never again.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ORG_SCOPED_TABLES,
  USER_SCOPED_FOR_ORG_TABLES,
  EXPORT_EXCLUDED_TABLES,
} from "@/lib/exportTables";
import { RESTORE_TABLE_ORDER, CONFLICT_TARGETS, planRestore } from "@/lib/dataRestore";

/** Every table name created anywhere in supabase/ (schema.sql + migrations). */
function discoverCreatedTables(): Set<string> {
  const root = join(process.cwd(), "supabase");
  const sources: string[] = [readFileSync(join(root, "schema.sql"), "utf8")];
  for (const name of readdirSync(join(root, "migrations"))) {
    if (name.endsWith(".sql")) sources.push(readFileSync(join(root, "migrations", name), "utf8"));
  }
  const tables = new Set<string>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  for (const src of sources) {
    for (const m of src.matchAll(re)) tables.add(m[1].toLowerCase());
  }
  return tables;
}

const created = discoverCreatedTables();
const exported = new Set<string>([...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES]);
const excluded = new Set<string>(Object.keys(EXPORT_EXCLUDED_TABLES));

describe("backup coverage tripwire", () => {
  it("found a plausible number of tables (sanity)", () => {
    expect(created.size).toBeGreaterThan(40);
  });

  it("every exported table actually exists (no phantoms marking backups INCOMPLETE)", () => {
    const phantoms = [...exported].filter((t) => !created.has(t));
    expect(phantoms, `Exported tables with no CREATE TABLE anywhere: ${phantoms.join(", ")}`).toEqual([]);
  });

  it("every existing table is exported or deliberately excluded (no silent gaps)", () => {
    const unaccounted = [...created].filter((t) => !exported.has(t) && !excluded.has(t)).sort();
    expect(
      unaccounted,
      `Tables with NO backup decision (add to exportTables.ts): ${unaccounted.join(", ")}`,
    ).toEqual([]);
  });

  it("no table is both exported and excluded", () => {
    const both = [...exported].filter((t) => excluded.has(t));
    expect(both).toEqual([]);
  });

  it("every excluded table has a written reason", () => {
    for (const [table, reason] of Object.entries(EXPORT_EXCLUDED_TABLES)) {
      expect(reason.trim().length, `${table} needs a real exclusion reason`).toBeGreaterThan(10);
    }
  });

  it("every org-scoped table has a deliberate restore decision (ordered or skipped)", () => {
    // Ask the planner which tables it would skip — that's the real skip set.
    const plan = planRestore(
      {
        manifest: { orgId: "b" },
        tables: Object.fromEntries([...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES].map((t) => [t, [{}]])),
      },
      { orgId: "c", orgName: "x", members: [] },
    );
    const skipped = new Set(plan.counts.tables.filter((t) => !t.willImport).map((t) => t.name));
    const undecided = [...exported].filter((t) => !skipped.has(t) && !RESTORE_TABLE_ORDER.includes(t)).sort();
    expect(
      undecided,
      `Exported tables with no restore position (add to RESTORE_TABLE_ORDER or SKIP_TABLES): ${undecided.join(", ")}`,
    ).toEqual([]);
  });

  it("conflict targets reference real tables", () => {
    const bad = Object.keys(CONFLICT_TARGETS).filter((t) => !created.has(t));
    expect(bad).toEqual([]);
  });

  it("restore order only contains real tables", () => {
    const bad = RESTORE_TABLE_ORDER.filter((t) => !created.has(t));
    expect(bad, `RESTORE_TABLE_ORDER entries with no CREATE TABLE: ${bad.join(", ")}`).toEqual([]);
  });
});
