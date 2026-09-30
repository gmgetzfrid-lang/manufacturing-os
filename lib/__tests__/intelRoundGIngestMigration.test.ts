// intelligence Round G (I-06) — 20261122_intel_roundG_ingest_integrity.sql.
//
// Shape (the one-paste protocol: inventory TEMP TABLE before BEGIN, DDL,
// COMMIT, ONE final SELECT of (check, ok, n)), the columns the code reads
// (every one the lib strips on a pre-migration database), and ILIFE-5's
// end-to-end trace: deleting a controlled document reaches every row derived
// from its mirror through ON DELETE CASCADE — mirror → chunks (and their
// embeddings, a column of the chunk row), page entities, entity mentions,
// line traces — with dangling mirrors purged BEFORE the key is added.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG = join(process.cwd(), "supabase", "migrations");
const FILE = "20261122_intel_roundG_ingest_integrity.sql";
const sql = readFileSync(join(MIG, FILE), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
const code = strip(sql);
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("20261122 — the one-paste shape", () => {
  it("inventory before BEGIN, aggregate counts only; DDL inside BEGIN/COMMIT; one final SELECT", () => {
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    const temp = code.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g22_before");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(commit).toBeGreaterThan(begin);
    const inventory = code.slice(temp, begin);
    // Aggregates only — never a customer row.
    const branches = inventory.split(/\bUNION ALL\b/);
    expect(branches.length).toBe(9);
    for (const b of branches) expect(b).toMatch(/COUNT\(/);
    const tail = code.slice(commit + "\nCOMMIT;".length).trim();
    expect(tail.startsWith("SELECT")).toBe(true);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,\s*NULL::text AS n/);
    expect(tail.endsWith("FROM _intel_g22_before;")).toBe(true);
    expect((tail.match(/;/g) ?? []).length).toBe(1);
    // Probes carry ok with n NULL; inventory rows carry ok NULL with n text.
    expect(tail).toMatch(/SELECT 'inventory \(before\): ' \|\| what, NULL, n::text FROM _intel_g22_before;$/);
  });

  it("defines no function, policy or trigger (nothing for DB-8 or the search_path pin to track)", () => {
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER)/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b/i);
  });
});

describe("20261122 — the columns the code reads", () => {
  const cols: Array<[string, string]> = [
    ["knowledge_documents", "ingest_claimed_by TEXT"],
    ["knowledge_documents", "ingest_claimed_at TIMESTAMPTZ"],
    ["knowledge_documents", "empty_pages INTEGER NOT NULL DEFAULT 0"],
    ["knowledge_documents", "vision_failed_pages INTEGER[] NOT NULL DEFAULT '{}'"],
    ["knowledge_documents", "vision_retry_after TIMESTAMPTZ"],
    ["knowledge_documents", "vision_partial_accepted BOOLEAN NOT NULL DEFAULT FALSE"],
    ["knowledge_documents", "chunk_version SMALLINT"],
    ["knowledge_libraries", "chunk_version SMALLINT NOT NULL DEFAULT 1"],
    ["knowledge_chunks", "source TEXT NOT NULL DEFAULT 'text'"],
    ["knowledge_chunks", "source_model TEXT"],
    ["knowledge_sources", "last_synced_at TIMESTAMPTZ"],
  ];
  it.each(cols)("%s gains %s (idempotent)", (table, def) => {
    expect(code).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${def};`);
  });

  it("every knowledge_documents column the lib strips on a pre-migration database is one this file adds", () => {
    const lib = src("lib/knowledgeIngest.ts");
    const list = /const INGEST_COLUMNS_20261122 = \[([\s\S]*?)\];/.exec(lib)![1];
    const names = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(
      ["chunk_version", "empty_pages", "ingest_claimed_at", "ingest_claimed_by", "vision_failed_pages", "vision_partial_accepted", "vision_retry_after"],
    );
    for (const n of names) expect(code).toMatch(new RegExp(`ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS ${n} `));
  });

  it("the source CHECK binds new rows and is validated over the existing ones (idempotent on a re-run)", () => {
    expect(code).toMatch(/ADD CONSTRAINT knowledge_chunks_source_check\s+CHECK \(source IN \('text', 'vision'\)\) NOT VALID;/);
    expect(code).toMatch(/ALTER TABLE knowledge_chunks VALIDATE CONSTRAINT knowledge_chunks_source_check;/);
  });
});

describe("ILIFE-5 / IRLS-7 — deleting a controlled document removes its whole AI shadow", () => {
  it("dangling mirrors are purged BEFORE the key, inside the transaction, then the key is ON DELETE CASCADE", () => {
    const tx = code.slice(code.indexOf("\nBEGIN;"), code.indexOf("\nCOMMIT;"));
    const purge = tx.indexOf("DELETE FROM knowledge_documents kd");
    const fk = tx.indexOf("ADD CONSTRAINT knowledge_documents_source_document_fk");
    expect(purge).toBeGreaterThan(-1);
    expect(fk).toBeGreaterThan(purge);
    expect(tx.slice(purge, fk)).toMatch(/NOT EXISTS \(SELECT 1 FROM documents d WHERE d\.id = kd\.source_document_id\)/);
    expect(tx).toMatch(/FOREIGN KEY \(source_document_id\) REFERENCES documents\(id\) ON DELETE CASCADE;/);
  });

  it("every table derived from a knowledge document cascades from it — traced across the numbered sequence", () => {
    const all = readdirSync(MIG).filter((f) => /^\d{8}.*\.sql$/.test(f)).map((f) => strip(readFileSync(join(MIG, f), "utf8"))).join("\n");
    const cascades = (table: string, column: string) =>
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?${column} UUID(?: NOT NULL)? REFERENCES knowledge_documents\\(id\\) ON DELETE CASCADE`).test(all);
    // chunks carry the embedding column, so the vectors go with them.
    expect(cascades("knowledge_chunks", "document_id")).toBe(true);
    expect(/ALTER TABLE knowledge_chunks[\s\S]{0,80}ADD COLUMN IF NOT EXISTS embedding/.test(all)).toBe(true);
    expect(cascades("knowledge_page_entities", "document_id")).toBe(true);
    expect(cascades("entity_mentions", "knowledge_document_id")).toBe(true);
    expect(cascades("knowledge_line_traces", "document_id")).toBe(true);
    // The one referrer that does not cascade is deliberate: a process flow
    // keeps its edge and loses only the pointer to the drawing it came from.
    expect(all).toMatch(/source_document_id UUID REFERENCES knowledge_documents\(id\) ON DELETE SET NULL/);
    // No other table references knowledge_documents.
    const referrers = [...all.matchAll(/REFERENCES knowledge_documents\(id\) ON DELETE (\w+)/g)].map((m) => m[1]);
    expect(referrers.sort()).toEqual(["CASCADE", "CASCADE", "CASCADE", "CASCADE", "SET"]);
  });

  it("the verification SELECT checks the key and the whole cascade chain", () => {
    const tail = code.slice(code.indexOf("\nCOMMIT;"));
    expect(tail).toMatch(/k\.confrelid = 'public\.documents'::regclass\s+AND k\.confdeltype = 'c'/);
    expect(tail).toMatch(/c\.relname IN \('knowledge_chunks', 'knowledge_page_entities', 'entity_mentions', 'knowledge_line_traces'\)/);
    expect(tail).toMatch(/no mirror names a missing document/);
  });
});
