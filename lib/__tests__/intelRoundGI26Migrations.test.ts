// intelligence Round G I-26 BRIDGE REMAINDERS — the shape of its two pastes
// (DEC-30). The runtime cases (row-level security per role, the 23503 / 23514
// refusals, the CONCURRENTLY build and the planner using it) run on the
// replayed PostgreSQL 16: lib/__tests__/rls/intelI26BridgeRemainders.test.ts.
//
//   20261235 — knowledge_document_assets (GAP-307 acceptance 3): counts-only
//     inventory BEFORE the transaction, BEGIN/COMMIT, ONE final SELECT
//     (check, ok, n); every object it creates is new (scanned over the
//     folder at test time — nothing is re-created, so no lineDiff applies);
//     its one function is not SECURITY DEFINER and pins search_path.
//   20261236 — documents_asset_tags_gin (WIRE-8 done-when 3): the ONLY
//     statement in its file, CREATE INDEX CONCURRENTLY IF NOT EXISTS, no
//     transaction (CONCURRENTLY cannot run in one), and the header says an
//     INVALID index left by a failed build is dropped and the paste re-run.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");
const REL = "20261235_intel_roundG_knowledge_document_assets.sql";
const GIN = "20261236_intel_roundG_asset_tags_gin.sql";
const raw = (f: string) => readFileSync(join(DIR, f), "utf8");
/** The SQL without comments and string literals' contents (enough to count statements). */
const code = (f: string) => raw(f).replace(/--[^\n]*/g, "");
const statements = (sql: string) => {
  // split on semicolons outside $$ bodies and quotes
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!inQuote && sql.startsWith("$$", i)) { inDollar = !inDollar; cur += "$$"; i++; continue; }
    if (!inDollar && ch === "'") inQuote = !inQuote;
    if (!inDollar && !inQuote && ch === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
const numbered = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();

describe("20261236 — the asset_tags GIN index is its own paste, one statement, CONCURRENTLY", () => {
  it("holds exactly one statement: CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_asset_tags_gin ON documents USING GIN (asset_tags jsonb_path_ops)", () => {
    const st = statements(code(GIN));
    expect(st).toEqual(["CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_asset_tags_gin ON documents USING GIN (asset_tags jsonb_path_ops)"]);
    expect(code(GIN)).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });
  it("the header says how to check it, and that an INVALID index left by a failed build is dropped and the paste re-run", () => {
    const h = raw(GIN);
    expect(h).toMatch(/INVALID index/);
    expect(h).toContain("DROP INDEX CONCURRENTLY IF EXISTS documents_asset_tags_gin;");
    expect(h).toMatch(/i\.indisvalid AND i\.indisready/);
    expect(h).toMatch(/its own paste/);
  });
  it("no earlier file builds an index on documents.asset_tags (the name is new)", () => {
    for (const f of numbered.filter((x) => x < GIN)) {
      expect(code(f), f).not.toMatch(/documents_asset_tags_gin/);
      expect(code(f), f).not.toMatch(/ON\s+documents\s+USING\s+GIN\s*\(\s*asset_tags/i);
    }
  });
  it("the asset hub's containment read it serves is still there (the relation first, the containment beside it)", () => {
    const hub = readFileSync(join(process.cwd(), "app", "(protected)", "assets", "[tag]", "page.tsx"), "utf8");
    expect(hub).toContain('.contains("asset_tags", [{ tag }])');
  });
});

describe("20261235 — knowledge_document_assets, one DEC-30 paste", () => {
  const sql = code(REL);
  const begin = sql.search(/^BEGIN;/m);
  const commit = sql.search(/^COMMIT;/m);

  it("inventory (TEMP, counts only) before BEGIN; one BEGIN / COMMIT; ONE statement after COMMIT — the final SELECT (check, ok, n)", () => {
    expect(begin).toBeGreaterThan(0);
    expect(commit).toBeGreaterThan(begin);
    expect(sql.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;/gm)).toHaveLength(1);
    const before = sql.slice(0, begin);
    expect(before).toMatch(/CREATE TEMP TABLE _intel_g235_before AS/);
    // counts only — never a customer row
    for (const sel of before.split(/UNION ALL/)) {
      if (/SELECT/i.test(sel)) expect(sel, sel).toMatch(/COUNT\(\*\)/);
    }
    const after = statements(sql.slice(commit + "COMMIT;".length));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/^SELECT '[^']/);
    expect(after[0]).toMatch(/AS "check"/);
    expect(after[0]).toMatch(/AS ok/);
    expect(after[0]).toMatch(/NULL::text AS n/);
    expect(after[0]).toMatch(/SELECT what, NULL, n::text FROM _intel_g235_before/);
  });

  it("the table mirrors document_assets' provenance columns, keys the knowledge document with ON DELETE CASCADE, and keeps one row per pair", () => {
    const ddl = sql.slice(begin, commit);
    for (const col of ["asserted_by", "asserted_by_user", "model", "source_revision", "source_version_id", "sheet_label", "pages", "tag_text"]) {
      expect(ddl, col).toMatch(new RegExp(`\\n\\s+${col}\\s+`));
    }
    expect(ddl).toMatch(/knowledge_document_id\s+UUID NOT NULL REFERENCES knowledge_documents\(id\) ON DELETE CASCADE/);
    expect(ddl).toMatch(/asset_id\s+UUID NOT NULL REFERENCES assets\(id\) ON DELETE CASCADE/);
    expect(ddl).toMatch(/UNIQUE \(knowledge_document_id, asset_id\)/);
    expect(ddl).toMatch(/CHECK \(source <> 'drawing' OR asserted_by = 'machine'\)/);
  });

  it("read follows the knowledge document's own readability; nobody signed in writes it", () => {
    const ddl = sql.slice(begin, commit);
    expect(ddl).toMatch(/AS RESTRICTIVE FOR SELECT TO authenticated\s+USING \(EXISTS \(SELECT 1 FROM knowledge_documents k WHERE k\.id = knowledge_document_assets\.knowledge_document_id\)\)/);
    expect(ddl).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(ddl).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON knowledge_document_assets FROM authenticated;/);
    expect(ddl).toMatch(/REVOKE ALL ON knowledge_document_assets FROM anon;/);
  });

  it("its one function is the caller's (not SECURITY DEFINER), pins search_path, refuses another workspace's ends with 23503, and is not callable by name", () => {
    const ddl = sql.slice(begin, commit);
    expect(ddl).not.toMatch(/SECURITY DEFINER/);
    expect(ddl).toMatch(/CREATE OR REPLACE FUNCTION knowledge_document_assets_same_org\(\)\s+RETURNS trigger LANGUAGE plpgsql SET search_path = public AS \$\$/);
    expect(ddl.match(/ERRCODE = '23503'/g)).toHaveLength(2);
    expect(ddl).toMatch(/REVOKE ALL ON FUNCTION knowledge_document_assets_same_org\(\) FROM PUBLIC, anon, authenticated;/);
  });

  it("every object it creates is new — no earlier file defines the table, its function, its trigger or its policies (nothing is re-created)", () => {
    const names = ["knowledge_document_assets_same_org", "trg_knowledge_document_assets_same_org",
      "knowledge_document_assets_select", "knowledge_document_assets_document_readable", "TABLE IF NOT EXISTS knowledge_document_assets"];
    for (const f of numbered.filter((x) => x < REL)) {
      const s = code(f);
      for (const n of names) expect(s.includes(n), `${f} names ${n}`).toBe(false);
    }
  });

  it("the probes cover the shape the header promises (six probes, an after-count, three inventory rows)", () => {
    const after = sql.slice(commit);
    expect(after.match(/UNION ALL/g)).toHaveLength(7);
    expect(after).toMatch(/permissive = 'RESTRICTIVE'/);
    expect(after).toMatch(/has_table_privilege\('authenticated', 'public\.knowledge_document_assets', 'INSERT'\)/);
    expect(after).toMatch(/confdeltype = 'c'/);
  });
});
