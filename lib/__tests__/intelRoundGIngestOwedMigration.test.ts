// intelligence Round G (I-06b) — 20261162_intel_roundG_ingest_owed_vision.sql
// (ING-13): the column the reset records a regenerated document's AI-vision
// pages in, so a batch with no vision context holds them instead of
// committing them text-only.
//
// Shape (the one-paste protocol: inventory TEMP TABLE before BEGIN, DDL,
// COMMIT, ONE final SELECT of (check, ok, n)), the column the code reads and
// strips on a database that has not applied it, and that the file touches
// no function, policy, trigger or grant.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG = join(process.cwd(), "supabase", "migrations");
const FILE = "20261162_intel_roundG_ingest_owed_vision.sql";
const sql = readFileSync(join(MIG, FILE), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
const code = strip(sql);
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("20261162 — the one-paste shape", () => {
  it("is the only file numbered 20261162", () => {
    expect(readdirSync(MIG).filter((f) => f.startsWith("20261162"))).toEqual([FILE]);
  });

  it("inventory before BEGIN, aggregate counts only; DDL inside BEGIN/COMMIT; one final SELECT", () => {
    const temp = code.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g62_before");
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(commit).toBeGreaterThan(begin);
    const inventory = code.slice(temp, begin);
    const branches = inventory.split(/\bUNION ALL\b/);
    expect(branches.length).toBe(2);
    for (const b of branches) expect(b).toMatch(/COUNT\(\*\)/);
    // Columns every database that can run the code already has.
    expect(inventory).toMatch(/WHERE vision_pages > 0/);
    expect(inventory).toMatch(/WHERE status = 'stale' AND pages_indexed = 0/);
    const tail = code.slice(commit + "\nCOMMIT;".length).trim();
    expect(tail.startsWith("SELECT")).toBe(true);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,\s*NULL::text AS n/);
    expect((tail.match(/;/g) ?? []).length).toBe(1);
    expect(tail).toMatch(/SELECT 'inventory \(before\): ' \|\| what, NULL, n::text FROM _intel_g62_before;$/);
  });

  it("adds exactly the column the code reads, idempotently, and probes its type and the 20261122 it depends on", () => {
    const tx = code.slice(code.indexOf("\nBEGIN;"), code.indexOf("\nCOMMIT;"));
    expect(tx).toContain("ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vision_owed_pages INTEGER[] NOT NULL DEFAULT '{}';");
    expect((tx.match(/ALTER TABLE/g) ?? []).length).toBe(1);
    const tail = code.slice(code.indexOf("\nCOMMIT;"));
    expect(tail).toMatch(/column_name = 'vision_owed_pages' AND data_type = 'ARRAY' AND udt_name = '_int4'\s+AND is_nullable = 'NO'/);
    expect(tail).toMatch(/table_name = 'knowledge_documents' AND column_name = 'vision_failed_pages'/);
    expect(tail).toMatch(/table_name = 'knowledge_chunks' AND column_name = 'source'/);
  });

  it("changes no row and defines no function, policy, trigger or grant", () => {
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER)/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|\bSECURITY DEFINER\b/i);
    expect(code).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO)\b/);
  });
});

describe("20261162 — the code reads the column, and runs without it", () => {
  const lib = src("lib/knowledgeIngest.ts");

  it("the lib strips exactly this column on a database that has not applied it", () => {
    const list = /const INGEST_COLUMNS_20261162 = \[([\s\S]*?)\];/.exec(lib)![1];
    expect([...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual(["vision_owed_pages"]);
    for (const n of ["vision_owed_pages"]) expect(code).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${n} `));
  });

  it("the reset writes it (RESET_ROW starts it empty; the owed pages are read before anything is deleted)", () => {
    const resetRow = /const RESET_ROW = \{([\s\S]*?)\};/.exec(lib)![1];
    expect(resetRow).toMatch(/vision_owed_pages: \[\] as number\[\]/);
    const fn = lib.slice(lib.indexOf("export async function resetKnowledgeIndex("));
    expect(fn.indexOf("await visionOwedPages(id, seen)")).toBeGreaterThan(0);
    expect(fn.indexOf("await visionOwedPages(id, seen)")).toBeLessThan(fn.indexOf('.from("knowledge_chunks").delete()'));
  });

  it("only a batch with no vision context reads it — a batch with a key reads exactly the pages it always did", () => {
    expect(lib).toMatch(/const owedVision = vision \? new Set<number>\(\) : new Set<number>\(pageQueue\(cur\.vision_owed_pages\)\);/);
  });
});
