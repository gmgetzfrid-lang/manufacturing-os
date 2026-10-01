// intelligence Round G (I-07) — the shape of 20261124 and the DWG-9 replay.
//
//   * 20261124 is one paste: the DEC-30 inventory into a TEMP TABLE BEFORE the
//     transaction (aggregate counts only — the two the fleet plan names:
//     verdicts on a sheet mirrored into several libraries, and cached
//     pos_source='vision' estimates), BEGIN … COMMIT, then ONE final SELECT
//     of (check, ok, n) rows.
//   * DWG-6: library_id, the backfill from audit_details.knowledgeDocumentId,
//     the org-wide key dropped and UNIQUE (org_id, library_id, sheet_number,
//     revision_code) NULLS NOT DISTINCT created; the route's upsert names
//     exactly that key.
//   * DWG-11: drawing_entity_rollup() reads exactly TAG_ENTITY_KINDS and
//     returns the columns rollUpEntities produces; both functions are
//     SECURITY INVOKER, search_path pinned, EXECUTE for service_role only;
//     neither name is defined anywhere else in the sequence (nothing is
//     re-created, so there is no older body to stay faithful to).
//   * DWG-9: a static in-order replay of the numbered sequence — no ALTER
//     TABLE reaches a table an EARLIER file dropped (and nothing re-created),
//     unless it sits in a DO block guarded by to_regclass('public.<table>');
//     the matcher catches the pre-fix 20261009; the guarded ALTER is the
//     original statement, line for line.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TAG_ENTITY_KINDS } from "@/lib/knowledgeEntityKinds";
import { rollUpEntities, extractEquipmentTags } from "@/lib/drawingText";

const root = process.cwd();
const MIG = join(root, "supabase", "migrations");
const FILE = "20261124_intel_roundG_drawing_audit_scope.sql";
const sql = readFileSync(join(MIG, FILE), "utf8");
const stripSqlComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
const code = stripSqlComments(sql);
function lineDiff(a: string, b: string) {
  const A = a.split("\n").map((l) => l.trim()).filter(Boolean);
  const B = b.split("\n").map((l) => l.trim()).filter(Boolean);
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

describe("20261124 — one paste: inventory, transaction, one result set", () => {
  it("captures the inventory into a TEMP TABLE before BEGIN, and ends in a single SELECT after COMMIT", () => {
    const temp = code.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g24_before AS");
    const begin = code.indexOf("BEGIN;");
    const commit = code.indexOf("COMMIT;");
    expect(temp).toBeGreaterThanOrEqual(0);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    const tail = code.slice(commit + "COMMIT;".length);
    // ONE statement after COMMIT: the verification + inventory SELECT.
    const outsideStrings = tail.replace(/'([^']|'')*'/g, "''");
    expect(outsideStrings.split(";").filter((s) => s.trim()).length).toBe(1);
    expect(tail).toMatch(/SELECT '[^']+' AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    expect(tail).toMatch(/SELECT 'inventory \(before\): ' \|\| what, NULL, n::text FROM _intel_g24_before;?\s*$/);
  });

  it("the inventory is aggregate-only and carries the two DEC-30 counts the plan names", () => {
    const inv = code.slice(code.indexOf("CREATE TEMP TABLE"), code.indexOf("BEGIN;"));
    expect(inv).not.toMatch(/SELECT\s+\*/);
    const selects = inv.match(/SELECT '/g) ?? [];
    expect(selects.length).toBe((inv.match(/COUNT\(\*\)/g) ?? []).length);
    expect(inv).toMatch(/mirrored into more than one library/);
    expect(inv).toMatch(/COUNT\(DISTINCT kd\.library_id\)[\s\S]*> 1/);
    expect(inv).toMatch(/WHERE pos_source = 'vision'/);
  });

  it("the DWG-2 phantom count uses the extractor's own line grammar — a size-annotated valve is not a phantom (fix pass)", () => {
    const m = code.match(/AND upper\(e\.raw\) ~ \('([\s\S]*?)'\);/);
    expect(m).not.toBeNull();
    // The SQL literal, as Postgres reads it: '' is one quote, each tag splice
    // is the row's own tag.
    const asRegex = (tag: string) => new RegExp(m![1].replace(/' \|\| e\.tag \|\| '/g, tag).replace(/''/g, "'"));
    const cases: Array<[string, string, boolean]> = [
      ['6"-P-1024-A1A', "P-1024", true], ['6 IN-P-1024', "P-1024", true], ['6" P-1024-A1A', "P-1024", true],
      ['2" PSV-2001', "PSV-2001", false], ['4" FCV-101 TO V-3', "FCV-101", false], ['3"X4" PSV-101', "PSV-101", false],
      ['2" PSV-2001-A', "PSV-2001", false], ["V-1402 6\" DRAIN", "V-1402", false],
    ];
    for (const [raw, tag, phantom] of cases) {
      expect(asRegex(tag).test(raw), raw).toBe(phantom);
      // …and the extractor agrees: a phantom is exactly what it no longer mints.
      expect(extractEquipmentTags(raw).some((t) => t.tag === tag), raw).toBe(!phantom);
    }
  });

  it("probes compare deparsed/catalog text only — no bare casts inside LIKE patterns", () => {
    for (const m of sql.matchAll(/LIKE '([^']|'')*'/g)) expect(m[0]).not.toMatch(/::/);
  });
});

describe("20261124 — DWG-6: the verdict key carries the library", () => {
  it("adds library_id (no FK: the record outlives its library) and backfills it from the recorded knowledge document", () => {
    expect(code).toMatch(/ALTER TABLE drawing_audit_logs ADD COLUMN IF NOT EXISTS library_id UUID;/);
    expect(code).not.toMatch(/library_id UUID REFERENCES/);
    expect(code).toMatch(/UPDATE drawing_audit_logs a\s+SET library_id = kd\.library_id\s+FROM knowledge_documents kd\s+WHERE a\.library_id IS NULL\s+AND \(a\.audit_details->>'knowledgeDocumentId'\) ~ '\^\[0-9a-fA-F-\]\{36\}\$'\s+AND kd\.id = \(a\.audit_details->>'knowledgeDocumentId'\)::uuid\s+AND kd\.org_id = a\.org_id;/);
  });

  it("drops the org-wide key and creates the scoped one, NULLS NOT DISTINCT", () => {
    const drop = code.indexOf("DROP INDEX IF EXISTS drawing_audit_logs_sheet_rev_idx;");
    const create = code.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS drawing_audit_logs_scope_sheet_rev_idx");
    expect(drop).toBeGreaterThan(code.indexOf("BEGIN;"));
    expect(create).toBeGreaterThan(drop);
    expect(code).toMatch(/ON drawing_audit_logs \(org_id, library_id, sheet_number, revision_code\) NULLS NOT DISTINCT;/);
    // The index being replaced is the one 20260929 created — by that name.
    expect(readFileSync(join(MIG, "20260929_mention_engine.sql"), "utf8"))
      .toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS drawing_audit_logs_sheet_rev_idx\s+ON drawing_audit_logs \(org_id, sheet_number, revision_code\);/);
  });

  it("the drawing route upserts on exactly that key — and on the org-wide one only where library_id does not exist yet", () => {
    const route = readFileSync(join(root, "app/api/knowledge/drawing/route.ts"), "utf8");
    expect(route).toContain(`{ onConflict: "org_id,library_id,sheet_number,revision_code" }`);
    // The pre-20261124 key appears once, in the legacyKey branch, which
    // drops library_id from the rows (review fix pass 2).
    const legacy = route.split(`onConflict: "org_id,sheet_number,revision_code"`);
    expect(legacy).toHaveLength(2);
    expect(legacy[0].slice(-400)).toMatch(/legacyKey\s*\?[\s\S]*rows\.map\(\(\{ library_id: _library, \.\.\.row \}\) => row\)/);
  });

  it("touches no policy: drawing_audit_logs keeps its three (and the probe says so)", () => {
    expect(code).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY|GRANT [A-Z, ]+ ON (TABLE )?drawing_audit_logs/);
    expect(sql).toMatch(/COUNT\(\*\) = 3 AND COUNT\(\*\) FILTER \(WHERE cmd = 'DELETE'\) = 0[\s\S]*tablename = 'drawing_audit_logs'/);
  });
});

describe("20261124 — DWG-11: the census counted by the database", () => {
  const body = (name: string) => {
    const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(p_document_ids uuid\\[\\]\\)([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(code);
    expect(m, `${name} is defined`).toBeTruthy();
    return { header: m![1], src: m![2] };
  };

  it("drawing_entity_rollup reads exactly TAG_ENTITY_KINDS and returns rollUpEntities' columns", () => {
    const f = body("drawing_entity_rollup");
    const kinds = /e\.kind IN \(([^)]*)\)/.exec(f.src)![1].match(/'(\w+)'/g)!.map((k) => k.slice(1, -1));
    expect(kinds).toEqual([...TAG_ENTITY_KINDS]);
    expect(f.header).toMatch(/RETURNS TABLE \(document_id uuid, kind text, tag text, occurrences integer, first_page integer, pages integer\[\]\)/);
    const jsCols = Object.keys(rollUpEntities([{ document_id: "d", page: 1, kind: "equipment", tag: "V-1" }])[0]);
    expect(jsCols).toEqual(["document_id", "kind", "tag", "occurrences", "first_page", "pages"]);
    expect(f.src).toMatch(/GROUP BY e\.document_id, e\.kind, e\.tag\s+ORDER BY e\.document_id, e\.kind, e\.tag/);
    expect(f.src).toMatch(/ARRAY_AGG\(DISTINCT e\.page ORDER BY e\.page\) AS pages/);
  });

  it("both functions: SECURITY INVOKER, search_path pinned, EXECUTE for service_role only", () => {
    for (const name of ["drawing_entity_rollup", "knowledge_doc_text_stats"]) {
      const f = body(name);
      expect(f.header).toMatch(/SECURITY INVOKER\s+SET search_path = public/);
      expect(f.header).not.toMatch(/SECURITY DEFINER/);
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${name}(uuid[]) FROM PUBLIC, anon, authenticated;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(uuid[]) TO service_role;`);
    }
  });

  it("nothing is re-created: neither function is defined anywhere else in the sequence", () => {
    for (const f of readdirSync(MIG).filter((n) => n.endsWith(".sql") && n !== FILE)) {
      const other = stripSqlComments(readFileSync(join(MIG, f), "utf8"));
      expect(other, f).not.toMatch(/FUNCTION\s+(public\.)?(drawing_entity_rollup|knowledge_doc_text_stats)\b/);
    }
  });
});

// ── DWG-9 — the numbered sequence replays in filename order ─────────────────

const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
const dropRe = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const alterRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const doBlockRe = /DO\s+\$(\w*)\$([\s\S]*?)\$\1\$/gi;

type MigFile = { name: string; sql: string };

/** Every ALTER TABLE on a table an earlier statement DROPPED (and nothing
 *  re-created since), outside a to_regclass-guarded DO block. ALTER TABLE
 *  IF EXISTS is guarded by itself. */
function alterAfterDrop(files: MigFile[]): string[] {
  const dropped = new Map<string, string>();
  const out: string[] = [];
  for (const f of files) {
    const src = stripSqlComments(f.sql);
    const guarded: Array<{ from: number; to: number; body: string }> = [];
    for (const m of src.matchAll(doBlockRe)) guarded.push({ from: m.index!, to: m.index! + m[0].length, body: m[2] });
    const events: Array<{ at: number; kind: "create" | "drop" | "alter"; table: string; ifExists: boolean }> = [];
    for (const m of src.matchAll(createRe)) events.push({ at: m.index!, kind: "create", table: m[1].toLowerCase(), ifExists: false });
    for (const m of src.matchAll(dropRe)) events.push({ at: m.index!, kind: "drop", table: m[1].toLowerCase(), ifExists: false });
    for (const m of src.matchAll(alterRe)) events.push({ at: m.index!, kind: "alter", table: m[1].toLowerCase(), ifExists: /IF\s+EXISTS/i.test(m[0]) });
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.kind === "create") dropped.delete(e.table);
      else if (e.kind === "drop") {
        const inGuard = guarded.some((g) => e.at >= g.from && e.at < g.to);
        if (!inGuard) dropped.set(e.table, f.name);
      } else if (dropped.has(e.table) && !e.ifExists) {
        const inGuard = guarded.some((g) => e.at >= g.from && e.at < g.to
          && g.body.includes(`to_regclass('public.${e.table}') IS NOT NULL`));
        if (!inGuard) out.push(`${f.name} ALTERs ${e.table}, dropped by ${dropped.get(e.table)}`);
      }
    }
  }
  return [...new Set(out)];
}

const numbered: MigFile[] = readdirSync(MIG)
  .filter((f) => /^\d{8}.*\.sql$/.test(f)).sort()
  .map((name) => ({ name, sql: readFileSync(join(MIG, name), "utf8") }));

const ORIGINAL_20261009 = `ALTER TABLE knowledge_line_traces
  ADD COLUMN IF NOT EXISTS method TEXT,
  -- Turn count is a cheap sanity signal: a "trace" with implausibly many
  -- direction changes is line-work wandering, not a pipe run.
  ADD COLUMN IF NOT EXISTS turns INTEGER;`;

describe("DWG-9 — no ALTER reaches a table the sequence already dropped", () => {
  it("the whole numbered sequence replays clean in filename order", () => {
    expect(alterAfterDrop(numbered)).toEqual([]);
  });

  it("the matcher catches the pre-fix 20261009 (so the replay is not vacuous)", () => {
    const prefix = numbered.map((f) => f.name === "20261009_trace_method.sql" ? { ...f, sql: ORIGINAL_20261009 } : f);
    expect(alterAfterDrop(prefix)).toEqual([
      "20261009_trace_method.sql ALTERs knowledge_line_traces, dropped by 20261007_retire_line_traces.sql",
    ]);
  });

  it("the guarded ALTER is the original statement, line for line, and defines nothing (DB-8)", () => {
    const now = numbered.find((f) => f.name === "20261009_trace_method.sql")!.sql;
    const block = /DO \$\$\nBEGIN\n  IF to_regclass\('public\.knowledge_line_traces'\) IS NOT NULL THEN\n([\s\S]*?)\n  END IF;\nEND \$\$;/.exec(now);
    expect(block).toBeTruthy();
    expect(lineDiff(block![1], ORIGINAL_20261009)).toEqual({ onlyInA: [], onlyInB: [] });
    expect(stripSqlComments(now)).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER)/i);
  });

  it("the export exclusion for the retired table stays — the coverage census still finds its CREATE (verifier correction b)", () => {
    expect(readFileSync(join(root, "lib/exportTables.ts"), "utf8")).toMatch(/knowledge_line_traces:/);
    expect(readFileSync(join(MIG, "20261007_line_traces.sql"), "utf8")).toMatch(/CREATE TABLE IF NOT EXISTS knowledge_line_traces/);
  });
});
