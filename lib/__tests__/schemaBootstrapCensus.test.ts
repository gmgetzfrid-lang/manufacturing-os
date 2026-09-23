// Bootstrap RLS census (PKG-14 / HLD-12).
//
// supabase/schema.sql is the documented from-scratch path, and it used to
// create 24 tables (work_packages, distribution_acks, document_holds, …) with
// RLS never enabled and no policy — an operator who ran only that file got
// tables any signed-in user of ANY tenant could read and write. The policies
// for those tables live in the numbered migrations (DB-8: the sequence is the
// only source of truth), so the reconciliation is: schema.sql says out loud
// that the migrations are mandatory, enables RLS on every table it creates
// (fail-closed until the migrations run), and this census fails the build if
// any table anywhere under supabase/ is created without RLS being enabled
// somewhere in the sequence.
//
// The census understands the loop shape 20260819 uses
// (FOREACH t IN ARRAY ARRAY['a','b'] LOOP EXECUTE format('ALTER TABLE %I
// ENABLE ROW LEVEL SECURITY', t) …) so a table enabled that way is seen.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const schemaPath = join(root, "supabase", "schema.sql");
const schema = readFileSync(schemaPath, "utf8");
const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");

function numberedMigrations(): Array<{ name: string; sql: string }> {
  const dir = join(root, "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => /^\d{8}.*\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
const enableRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
const loopRe = /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END\s+LOOP/gi;

function createdIn(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripSqlComments(sql).matchAll(createRe)) out.add(m[1].toLowerCase());
  return out;
}

function enabledIn(sql: string): Set<string> {
  const src = stripSqlComments(sql);
  const out = new Set<string>();
  for (const m of src.matchAll(enableRe)) out.add(m[1].toLowerCase());
  for (const m of src.matchAll(loopRe)) {
    if (!/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(m[2])) continue;
    for (const q of m[1].matchAll(/'([a-z_][a-z0-9_]*)'/gi)) out.add(q[1].toLowerCase());
  }
  return out;
}

describe("schema.sql is an honest, fail-closed baseline (PKG-14 / HLD-12)", () => {
  it("the header says the migrations are mandatory and the file alone is not a complete install", () => {
    const header = schema.slice(0, 2500);
    expect(header).toMatch(/NOT A COMPLETE INSTALL/);
    expect(header).toMatch(/migrations are MANDATORY/);
    expect(header).toMatch(/Never re-run this file on a live database/);
  });

  it("every table schema.sql creates has ROW LEVEL SECURITY enabled in schema.sql itself", () => {
    const created = createdIn(schema);
    const enabled = enabledIn(schema);
    expect(created.size).toBeGreaterThan(40);
    const missing = [...created].filter((t) => !enabled.has(t)).sort();
    expect(missing, `schema.sql creates these tables without enabling RLS (add them to the BOOTSTRAP RLS block): ${missing.join(", ")}`).toEqual([]);
    // The block the finding is about is present and names the three tables it cited.
    for (const t of ["work_packages", "work_package_documents", "distribution_acks", "document_holds"]) {
      expect(enabled.has(t), t).toBe(true);
    }
  });

  it("every table created anywhere under supabase/ is RLS-enabled somewhere in the sequence", () => {
    const created = createdIn(schema);
    const enabled = enabledIn(schema);
    const where = new Map<string, string>();
    for (const { name, sql } of numberedMigrations()) {
      for (const t of createdIn(sql)) created.add(t);
      for (const t of enabledIn(sql)) { enabled.add(t); if (!where.has(t)) where.set(t, name); }
    }
    expect(created.size).toBeGreaterThan(100);
    const unprotected = [...created].filter((t) => !enabled.has(t)).sort();
    expect(
      unprotected,
      `Tables created with RLS never enabled anywhere (a numbered migration must ALTER TABLE … ENABLE ROW LEVEL SECURITY): ${unprotected.join(", ")}`,
    ).toEqual([]);
    // The loop-enabled cost tables are seen through the FOREACH shape, not exempted.
    for (const t of ["cost_accounts", "cost_documents", "cost_entries", "project_parties"]) {
      expect(where.get(t), t).toBe("20260819_orphan_tables_backfill.sql");
    }
  });

  it("the file ends with the bootstrap census SELECT the operator sees as the last result", () => {
    const tail = schema.slice(-1800);
    expect(tail).toMatch(/relrowsecurity/);
    expect(tail).toMatch(/pg_policies/);
    expect(tail).toMatch(/RLS DISABLED/);
    expect(tail).toMatch(/apply the migrations/);
    // Nothing follows the census — it must be the LAST statement so the SQL
    // editor (which shows only the final result set) shows it.
    expect(schema.trimEnd()).toMatch(/ORDER BY 2, 1;$/);
  });

  it("schema.sql gains no new function / policy / trigger definition (policies live in the migrations — DB-8)", () => {
    const src = stripSqlComments(schema);
    const fns = [...src.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi)].map((m) => m[1]).sort();
    const policies = [...src.matchAll(/CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?/gi)].map((m) => `${m[2]}.${m[1]}`).sort();
    const triggers = [...src.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?(\w+)"?\s+/gi)].map((m) => m[1]);
    // The frozen baseline set. Adding a policy HERE is the anti-pattern the
    // finding describes (a second source of truth a re-run restores over
    // later hardening) — put it in a numbered migration instead.
    expect(fns).toEqual(["my_org_ids", "next_ticket_number", "normalize_tag", "post_ticket_comment"]);
    expect(policies.length).toBe(27);
    expect(triggers).toEqual([]);
  });
});
