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
//   * IRLS-17: supabase/schema.sql runs as ONE script on an empty database,
//     so read top to bottom nothing in it reaches a table it has not made
//     yet (a REFERENCES, an index, an ALTER TABLE without IF EXISTS), no
//     index names a column the table does not have at that point, and no
//     statement hides at the end of a comment line; the copies it no longer
//     carries (project_documents, milestones, the archived_at index) are
//     made, unchanged in effect, by their numbered migrations.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { censusSchema } from "./helpers/schemaKeys";

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

// ── IRLS-17: schema.sql as one script, read top to bottom ──────────────────

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return -1; i = j; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function splitTop(body: string): string[] {
  const out: string[] = []; let depth = 0; let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") { const j = body.indexOf("'", i + 1); if (j < 0) { cur += body.slice(i); break; } cur += body.slice(i, j + 1); i = j; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const CONSTRAINT_HEAD = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)\b/i;

/**
 * Each statement of a one-script baseline that reaches a table, or names an
 * index column, the script has not made at that point. A table made only
 * inside a DO block is conditional: it counts for statements in that same
 * block, never for one outside it; a statement inside a DO block is the
 * block's own business (it runs its own existence check).
 */
function forwardReferences(raw: string): string[] {
  const src = stripSqlComments(raw);
  const blocks = [...src.matchAll(doBlockRe)].map((m) => ({ from: m.index!, to: m.index! + m[0].length }));
  const inBlock = (pos: number) => blocks.some((b) => pos >= b.from && pos < b.to);
  // where each table is made (unconditionally), and each column it gains
  const made = new Map<string, number>();
  const cols: Array<{ t: string; c: string; pos: number }> = [];
  for (const m of src.matchAll(createRe)) {
    if (inBlock(m.index!)) continue;
    const t = m[1].toLowerCase();
    if (!made.has(t)) made.set(t, m.index!);
    const open = m.index! + m[0].length - 1;
    const close = matchParen(src, open);
    for (const el of splitTop(src.slice(open + 1, close))) {
      const c = el.match(/^"?([a-z_][a-z0-9_]*)"?\s+/i);
      if (c && !CONSTRAINT_HEAD.test(el)) cols.push({ t, c: c[1].toLowerCase(), pos: m.index! });
    }
  }
  for (const m of src.matchAll(/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    if (!inBlock(m.index!)) cols.push({ t: m[1].toLowerCase(), c: m[2].toLowerCase(), pos: m.index! });
  }
  const isMade = (t: string, pos: number) => t.startsWith("auth.") || (made.has(t) && made.get(t)! < pos);
  const out: string[] = [];
  for (const m of src.matchAll(/\bREFERENCES\s+((?:"?[a-z_][a-z0-9_]*"?\.)?"?[a-z_][a-z0-9_]*"?)/gi)) {
    if (inBlock(m.index!)) continue;
    const t = m[1].replace(/"/g, "").toLowerCase().replace(/^public\./, "");
    if (!isMade(t, m.index!)) out.push(`REFERENCES ${t} before it is made`);
  }
  for (const m of src.matchAll(indexRe)) {
    if (inBlock(m.index!)) continue;
    const t = m[1].toLowerCase();
    if (!isMade(t, m.index!)) { out.push(`an index on ${t} before it is made`); continue; }
    // the index's plain columns must exist at this point
    const after = src.slice(m.index! + m[0].length);
    const using = after.match(/^\s*(?:USING\s+\w+\s*)?\(/i);
    if (!using) continue;
    const open = m.index! + m[0].length + using[0].length - 1;
    const close = matchParen(src, open);
    const tail = src.slice(close + 1, close + 1 + 400).split(";")[0];
    const where = tail.match(/^\s*WHERE\s+([\s\S]*)$/i)?.[1] ?? "";
    const named = [
      ...splitTop(src.slice(open + 1, close)).filter((e) => !e.includes("(")).map((e) => e.split(/\s+/)[0]),
      ...[...where.matchAll(/\b([a-z_][a-z0-9_]*)\s+IS\s+(?:NOT\s+)?NULL\b/gi)].map((w) => w[1]),
    ].map((c) => c.replace(/"/g, "").toLowerCase());
    for (const c of named) {
      if (!cols.some((x) => x.t === t && x.c === c && x.pos < m.index!)) out.push(`an index on ${t}(${c}) before the column exists`);
    }
  }
  for (const m of src.matchAll(/\bALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    if (inBlock(m.index!) || m[1]) continue;
    const t = m[2].toLowerCase();
    if (!isMade(t, m.index!)) out.push(`ALTER TABLE ${t} before it is made${made.has(t) ? "" : " (made only conditionally, or not here at all)"}`);
  }
  return [...new Set(out)];
}

/** The copies schema.sql carried until IRLS-17, as they stood (e13bc7b). */
const OLD_PROJECT_DOCUMENTS = `CREATE TABLE IF NOT EXISTS project_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  source        TEXT NOT NULL DEFAULT 'checkout' CHECK (source IN ('checkout','manual')),
  UNIQUE (project_id, document_id)
);
CREATE INDEX IF NOT EXISTS project_documents_project_idx  ON project_documents(project_id);
CREATE INDEX IF NOT EXISTS project_documents_document_idx ON project_documents(document_id);
CREATE INDEX IF NOT EXISTS project_documents_org_idx      ON project_documents(org_id);`;
const OLD_MILESTONE_COLUMNS = [
  "id", "org_id", "project_id", "document_id", "name", "description", "weight", "planned_at", "actual_at", "first_completed_at",
  "status", "linked_revision_label", "linked_ticket_id", "source", "external_ref", "created_at", "created_by", "created_by_name",
  "updated_at", "updated_by", "completed_by", "completed_by_name", "status_reason",
];
const OLD_MILESTONE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS milestones_org_idx ON milestones(org_id);",
  "CREATE INDEX IF NOT EXISTS milestones_project_idx ON milestones(project_id) WHERE project_id IS NOT NULL;",
  "CREATE INDEX IF NOT EXISTS milestones_document_idx ON milestones(document_id) WHERE document_id IS NOT NULL;",
  "CREATE INDEX IF NOT EXISTS milestones_org_planned_idx ON milestones(org_id, planned_at);",
  "CREATE INDEX IF NOT EXISTS milestones_org_source_idx ON milestones(org_id, source);",
  "CREATE UNIQUE INDEX IF NOT EXISTS milestones_external_ref_uniq ON milestones(org_id, source, external_ref) WHERE external_ref IS NOT NULL;",
];
const squash = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();

describe("IRLS-17: supabase/schema.sql runs as one script on an empty database", () => {
  const schema = read("supabase/schema.sql");

  it("read top to bottom, nothing reaches a table the file has not made yet, and no index names a column the table does not have yet", () => {
    expect(forwardReferences(schema)).toEqual([]);
  });

  it("the census catches every shape the one-script run stopped on (it is not vacuous)", () => {
    const pre = [
      "CREATE TABLE IF NOT EXISTS orgs (id UUID PRIMARY KEY);",
      "CREATE TABLE IF NOT EXISTS t1 (id UUID, p UUID REFERENCES projects(id));",
      "CREATE TABLE IF NOT EXISTS dv (id UUID, org_id UUID);",
      "CREATE INDEX IF NOT EXISTS dv_archived_idx ON dv(org_id, archived_at) WHERE archived_at IS NOT NULL;",
      "DO $$ BEGIN IF EXISTS (SELECT 1) THEN CREATE TABLE IF NOT EXISTS da (id UUID); END IF; END$$;",
      "ALTER TABLE da ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE IF EXISTS da ENABLE ROW LEVEL SECURITY;",
      "CREATE INDEX IF NOT EXISTS x ON later (id);",
      "CREATE TABLE IF NOT EXISTS projects (id UUID PRIMARY KEY);",
      "CREATE TABLE IF NOT EXISTS later (id UUID);",
    ].join("\n");
    expect(forwardReferences(pre).sort()).toEqual([
      "ALTER TABLE da before it is made (made only conditionally, or not here at all)",
      "REFERENCES projects before it is made",
      "an index on dv(archived_at) before the column exists",
      "an index on later before it is made",
    ]);
  });

  it("no statement hides at the end of a comment line; pg_trgm is created on its own line before the first trigram index", () => {
    // a statement glued after the end of a comment's sentence, as
    // ".CREATE EXTENSION IF NOT EXISTS pg_trgm;" was until IRLS-17
    const glued = /[;.)]\s*(CREATE|ALTER|DROP|INSERT|GRANT|REVOKE)\s+[A-Z][A-Z ]*\s+"?[a-z_][\s\S]*;\s*$/;
    expect(glued.test("-- (see migration 20260724_ticket_numbering.sql).CREATE EXTENSION IF NOT EXISTS pg_trgm;")).toBe(true);
    const hidden = schema.split("\n").filter((l) => /^\s*--/.test(l) && glued.test(l));
    expect(hidden).toEqual([]);
    const ext = schema.search(/^CREATE EXTENSION IF NOT EXISTS pg_trgm;$/m);
    expect(ext).toBeGreaterThan(0);
    expect(ext).toBeLessThan(schema.indexOf("gin_trgm_ops"));
  });

  it("project_documents, milestones and the archived_at index live only in their migrations, which make them unchanged in effect", () => {
    const code = stripSqlComments(schema);
    expect(code).not.toMatch(/CREATE TABLE IF NOT EXISTS (project_documents|milestones)\b/);
    expect(code).not.toMatch(/document_versions_archived_idx/);
    expect(code).not.toMatch(/ALTER TABLE (project_documents|milestones) /);
    // project_documents: 20260609 carries the copy byte for byte (and its RLS)
    expect(mig("20260609_phase1_normalization.sql")).toContain(OLD_PROJECT_DOCUMENTS);
    expect(mig("20260609_phase1_normalization.sql")).toContain("ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;");
    // milestones: every column and index of the copy is made by the numbered sequence
    const census = censusSchema();
    const missing = OLD_MILESTONE_COLUMNS.filter((c) => !census.get("milestones")?.columns.has(c));
    expect(missing).toEqual([]);
    const all = squash(numbered.map((f) => stripSqlComments(f.sql)).join("\n"));
    for (const ix of OLD_MILESTONE_INDEXES) expect(all, ix).toContain(squash(ix));
    expect(mig("20260614_phase7_milestones.sql")).toContain("ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;");
    // the archived_at column and its index: 20260808
    const m808 = squash(mig("20260808_archive_foundation.sql"));
    expect(m808).toContain(squash("alter table document_versions add column if not exists archived_at timestamptz;"));
    expect(m808).toContain(squash("CREATE INDEX IF NOT EXISTS document_versions_archived_idx ON document_versions(org_id, archived_at) WHERE archived_at IS NOT NULL;"));
    // document_assets: RLS stays on wherever the table exists
    expect(schema).toContain("ALTER TABLE IF EXISTS document_assets ENABLE ROW LEVEL SECURITY;");
    expect(mig("20260609_phase1_normalization.sql")).toContain("ALTER TABLE document_assets ENABLE ROW LEVEL SECURITY;");
  });

  it("the header says the file runs as one script and is never re-run on a live database", () => {
    const header = schema.slice(0, schema.indexOf("-- TABLES"));
    expect(header).toMatch(/Never re-run this file on a live database/);
    expect(header).toMatch(/It runs as ONE script on an empty database/);
    expect(header).toMatch(/IRLS-17/);
    expect(header).not.toMatch(/projects, milestones/);
  });
});

describe("IRLS-20: nothing outside the records tells an author to mirror a migration into schema.sql (DB-8)", () => {
  it("the CI header names the numbered migrations as the only source of truth and schema.sql as the frozen baseline", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/is mirrored into supabase\/schema\.sql/);
    expect(ci).toMatch(/supabase\/migrations\/ -- the only source of truth/);
    expect(ci).toMatch(/supabase\/schema\.sql is the\s*\n#\s*frozen pre-migration baseline/);
    expect(ci).toMatch(/never edited to copy a migration/);
  });

  it("the public data-portability page and the architecture doc describe the schema as the baseline plus every migration", () => {
    const page = read("app/data-portability/page.tsx");
    expect(page).not.toMatch(/complete database schema lives at supabase\/schema\.sql/);
    expect(page).toMatch(/supabase\/schema\.sql \(the starting baseline\) followed by every numbered file in supabase\/migrations, applied in filename order/);
    expect(page).not.toContain("blob/master/supabase/schema.sql");
    const arch = read("docs/ARCHITECTURE.md");
    expect(arch).not.toMatch(/cumulative create-from-scratch reference/);
    expect(arch).toMatch(/schema\.sql\s+← frozen pre-migration baseline \(DB-8\)/);
  });
});
