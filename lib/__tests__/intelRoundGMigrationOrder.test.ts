// intelligence Round G (I-06) — IRLS-6: the numbered sequence replays in
// filename order on a fresh database.
//
// 20260806_intelligence_layer.sql ALTERed knowledge_questions, which only
// 20260911_knowledge_ai.sql creates. Pasted as one script on a fresh database
// that raised 42P01 and rolled the whole file back (org_ai_instructions,
// document_related_resources, recently_viewed_docs, library_numbering), and
// 20260807 then failed on the missing document_related_resources.
//
// The fix: 20260806 runs the ALTER only when the table exists (a to_regclass
// DO guard — unchanged on every live deployment), and
// 20261123_intel_roundG_knowledge_questions_order.sql carries the SAME
// statements after 20260911. This file pins:
//   * a static in-order replay of every numbered migration: no ALTER TABLE
//     reaches a table the sequence creates LATER, unless it sits in a DO
//     block guarded by to_regclass('public.<table>') (schema.sql tables are
//     the baseline and exist first);
//   * the matcher catches the pre-fix shape (so the census is not vacuous);
//   * the guarded statements and 20261123's are byte-identical, line for line.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const MIG = join(root, "supabase", "migrations");
const mig = (f: string) => readFileSync(join(MIG, f), "utf8");
const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
const alterRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const doBlockRe = /DO\s+\$(\w*)\$([\s\S]*?)\$\1\$/gi;

type File = { name: string; sql: string };

/** Every ALTER TABLE on a table the sequence creates in a LATER file. A
 *  statement inside a DO block whose body checks
 *  to_regclass('public.<that table>') is guarded and skipped. */
function alterBeforeCreate(files: File[], baseline: Set<string>): string[] {
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
    for (const m of src.matchAll(alterRe)) {
      const t = m[1].toLowerCase();
      if (baseline.has(t)) continue;
      const c = createdIn.get(t);
      if (!c || c <= f.name) continue;
      const inGuard = guarded.some((g) => m.index! >= g.from && m.index! < g.to
        && g.body.includes(`to_regclass('public.${t}') IS NOT NULL`));
      if (!inGuard) out.push(`${f.name} ALTERs ${t}, created only in ${c}`);
    }
  }
  return [...new Set(out)];
}

const numbered: File[] = readdirSync(MIG)
  .filter((f) => /^\d{8}.*\.sql$/.test(f))
  .sort()
  .map((name) => ({ name, sql: mig(name) }));
const baseline = new Set(
  [...stripSqlComments(readFileSync(join(root, "supabase", "schema.sql"), "utf8")).matchAll(createRe)]
    .map((m) => m[1].toLowerCase()),
);

const ORIGINAL = [
  "ALTER TABLE knowledge_questions",
  "  ADD COLUMN IF NOT EXISTS search_tsv tsvector",
  "  GENERATED ALWAYS AS (",
  "    to_tsvector('english', coalesce(question, '') || ' ' || coalesce(answer, ''))",
  "  ) STORED;",
  "CREATE INDEX IF NOT EXISTS knowledge_questions_tsv_idx",
  "  ON knowledge_questions USING GIN (search_tsv);",
  "CREATE INDEX IF NOT EXISTS knowledge_questions_org_recent_idx",
  "  ON knowledge_questions (org_id, created_at DESC);",
].join("\n");

describe("IRLS-6: the numbered sequence replays in filename order", () => {
  it("knowledge_questions is not in the schema.sql baseline (the replay really depends on 20260911)", () => {
    expect(baseline.has("knowledge_questions")).toBe(false);
    expect(numbered.find((f) => /CREATE TABLE IF NOT EXISTS knowledge_questions \(/.test(f.sql))?.name)
      .toBe("20260911_knowledge_ai.sql");
  });

  it("no ALTER TABLE reaches a table the sequence creates later (unguarded)", () => {
    expect(alterBeforeCreate(numbered, baseline)).toEqual([]);
  });

  it("the census catches the pre-fix shape — it is not vacuous", () => {
    const preFix: File[] = [
      { name: "20260806_intelligence_layer.sql", sql: ORIGINAL },
      { name: "20260911_knowledge_ai.sql", sql: "CREATE TABLE IF NOT EXISTS knowledge_questions (id UUID);" },
    ];
    expect(alterBeforeCreate(preFix, new Set())).toEqual([
      "20260806_intelligence_layer.sql ALTERs knowledge_questions, created only in 20260911_knowledge_ai.sql",
    ]);
    // …and a guard on the WRONG table does not count.
    const wrongGuard: File[] = [
      { name: "20260806_x.sql", sql: `DO $$ BEGIN IF to_regclass('public.other') IS NOT NULL THEN\n${ORIGINAL}\nEND IF; END $$;` },
      preFix[1],
    ];
    expect(alterBeforeCreate(wrongGuard, new Set())).toHaveLength(1);
  });

  it("20260806 runs the statements only when the table exists, byte-for-byte the originals", () => {
    const sql = mig("20260806_intelligence_layer.sql");
    const block = [...sql.matchAll(doBlockRe)].find((m) => m[2].includes("knowledge_questions"));
    expect(block, "the knowledge_questions DO block").toBeTruthy();
    expect(block![2]).toContain("IF to_regclass('public.knowledge_questions') IS NOT NULL THEN");
    expect(block![2]).toContain(ORIGINAL);
    // Nothing else in the file touches the table outside the guard.
    const outside = stripSqlComments(sql.replace(block![0], ""));
    expect(outside).not.toMatch(/knowledge_questions/);
  });

  it("20261123 carries the same statements after 20260911, inside one transaction", () => {
    const names = numbered.map((f) => f.name);
    const at = names.indexOf("20261123_intel_roundG_knowledge_questions_order.sql");
    expect(at).toBeGreaterThan(names.indexOf("20260911_knowledge_ai.sql"));
    const sql = mig("20261123_intel_roundG_knowledge_questions_order.sql");
    const body = sql.slice(sql.indexOf("BEGIN;\n") + "BEGIN;\n".length, sql.indexOf("\nCOMMIT;")).trim();
    expect(lineDiff(body, ORIGINAL)).toEqual({ onlyInA: [], onlyInB: [] });
    expect(body).toBe(ORIGINAL);
    // No function, policy or trigger — nothing DB-8's census could call a fork.
    expect(stripSqlComments(sql)).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER)/i);
  });

  it("20261123 ends in ONE verification SELECT of shape (check, ok, n)", () => {
    const sql = mig("20261123_intel_roundG_knowledge_questions_order.sql");
    const tail = sql.slice(sql.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);
    expect(tail).toMatch(/SELECT '[^']+' AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    const selects = stripSqlComments(tail).split(/\bUNION ALL\b/);
    expect(selects.length).toBe(4);
    expect(stripSqlComments(tail).trim().endsWith(";")).toBe(true);
  });
});
