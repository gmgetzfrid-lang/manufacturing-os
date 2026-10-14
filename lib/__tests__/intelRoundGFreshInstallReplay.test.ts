// intelligence Round G (I-27 FRESH-INSTALL REPLAY) — what the DEFAULT suite
// pins, without a database, about a brand-new install replaying
// supabase/schema.sql and every numbered migration in filename order.
//
// The replay itself runs only under `npm run test:db` (a real PostgreSQL 16;
// lib/__tests__/rls/freshReplay.test.ts). This file holds the shapes the
// fixes rest on, so CI catches a regression of the same class:
//   * IRLS-18: no CREATE INDEX reaches a table the sequence creates in a LATER
//     file unless it sits in a DO block guarded by
//     to_regclass('public.<table>') — the sibling of IRLS-6's ALTER TABLE
//     census (intelRoundGMigrationOrder.test.ts), which did not look at
//     indexes; 20260630's guarded statement is the original, and 20260707
//     builds the same index with the table.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const MIG = join(root, "supabase", "migrations");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const mig = (f: string) => readFileSync(join(MIG, f), "utf8");
const stripSqlComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");

const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
const indexRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?[a-z_][a-z0-9_]*"?\s+ON\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const doBlockRe = /DO\s+\$(\w*)\$([\s\S]*?)\$\1\$/gi;

type File = { name: string; sql: string };

/** Every CREATE INDEX on a table the sequence creates in a LATER file. A
 *  statement inside a DO block whose body checks
 *  to_regclass('public.<that table>') IS NOT NULL is guarded and skipped. */
function indexBeforeCreate(files: File[], baseline: Set<string>): string[] {
  const createdIn = new Map<string, string>();
  for (const f of files) {
    for (const m of stripSqlComments(f.sql).matchAll(createRe)) {
      const t = m[1].toLowerCase();
      if (!createdIn.has(t)) createdIn.set(t, f.name);
    }
  }
  const out: string[] = [];
  for (const f of files) {
    const src = stripSqlComments(f.sql);
    const guarded: Array<{ from: number; to: number; body: string }> = [];
    for (const m of src.matchAll(doBlockRe)) guarded.push({ from: m.index!, to: m.index! + m[0].length, body: m[2] });
    for (const m of src.matchAll(indexRe)) {
      const t = m[1].toLowerCase();
      if (baseline.has(t)) continue;
      const c = createdIn.get(t);
      if (!c || c <= f.name) continue;
      const inGuard = guarded.some((g) => m.index! >= g.from && m.index! < g.to
        && g.body.includes(`to_regclass('public.${t}') IS NOT NULL`));
      if (!inGuard) out.push(`${f.name} indexes ${t}, created only in ${c}`);
    }
  }
  return [...new Set(out)];
}

const numbered: File[] = readdirSync(MIG)
  .filter((f) => /^\d{8}.*\.sql$/.test(f))
  .sort()
  .map((name) => ({ name, sql: mig(name) }));
const baselineTables = () => new Set(
  [...stripSqlComments(read("supabase/schema.sql")).matchAll(createRe)].map((m) => m[1].toLowerCase()),
);

const TEAM_INDEX = "CREATE INDEX IF NOT EXISTS team_members_uid_idx\n  ON team_members (uid);";

describe("IRLS-18: no index reaches a table the sequence creates later", () => {
  it("team_members is not in the schema.sql baseline; 20260707 creates it and builds the same index with it", () => {
    expect(baselineTables().has("team_members")).toBe(false);
    expect(numbered.find((f) => /CREATE TABLE IF NOT EXISTS team_members \(/.test(f.sql))?.name).toBe("20260707_teams.sql");
    expect(mig("20260707_teams.sql")).toContain("CREATE INDEX IF NOT EXISTS team_members_uid_idx ON team_members(uid);");
  });

  it("no CREATE INDEX reaches a table the sequence creates later (unguarded)", () => {
    expect(indexBeforeCreate(numbered, baselineTables())).toEqual([]);
  });

  it("the census catches the pre-fix 20260630 — it is not vacuous — and a guard on the wrong table does not count", () => {
    const teams: File = { name: "20260707_teams.sql", sql: "CREATE TABLE IF NOT EXISTS team_members (id UUID);" };
    expect(indexBeforeCreate([{ name: "20260630_perf_indexes.sql", sql: TEAM_INDEX }, teams], new Set())).toEqual([
      "20260630_perf_indexes.sql indexes team_members, created only in 20260707_teams.sql",
    ]);
    const wrongGuard: File = { name: "20260630_x.sql", sql: `DO $$ BEGIN IF to_regclass('public.other') IS NOT NULL THEN\n${TEAM_INDEX}\nEND IF; END $$;` };
    expect(indexBeforeCreate([wrongGuard, teams], new Set())).toHaveLength(1);
  });

  it("20260630 runs the team_members index only when the table exists, byte-for-byte the original; its other three indexes are unchanged", () => {
    const sql = mig("20260630_perf_indexes.sql");
    const blocks = [...sql.matchAll(doBlockRe)];
    expect(blocks).toHaveLength(1);
    expect(blocks[0][2]).toContain("IF to_regclass('public.team_members') IS NOT NULL THEN");
    expect(blocks[0][2].replace(/\n {4}/g, "\n")).toContain(TEAM_INDEX);
    // nothing else in the file names the table outside the guard
    expect(stripSqlComments(sql.replace(blocks[0][0], ""))).not.toMatch(/team_members/);
    for (const stmt of [
      "CREATE INDEX IF NOT EXISTS documents_folder_listing_idx\n  ON documents (org_id, library_id, collection_id, updated_at DESC);",
      "CREATE INDEX IF NOT EXISTS collections_org_library_idx\n  ON collections (org_id, library_id);",
      "CREATE INDEX IF NOT EXISTS org_members_uid_org_active_idx\n  ON org_members (uid, org_id) WHERE status = 'active';",
    ]) expect(sql, stmt).toContain(stmt);
    // still no function, policy or trigger (DB-8)
    expect(stripSqlComments(sql)).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER)/i);
  });
});
