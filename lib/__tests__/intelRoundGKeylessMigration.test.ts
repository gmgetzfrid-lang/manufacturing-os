// intelligence Round G (I-22) — 20261186_intel_roundG_keyless_text_only.sql:
// the keyless text-only count on knowledge_documents (ING-13 done-when 2,
// ING-6's keyless first-index limb; DEC-58 as ruled under DEC-90 A18).
//
// Shape (the one-paste protocol, DEC-30: inventory TEMP TABLE before BEGIN,
// aggregate counts only; DDL inside BEGIN/COMMIT; ONE final SELECT of
// (check, ok, n)), the column the code reads, and that the file re-creates
// no function, policy, trigger or view — so there is no newest body to pin
// with a lineDiff: it is an ADD COLUMN, and nothing else.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG = join(process.cwd(), "supabase", "migrations");
const FILE = "20261186_intel_roundG_keyless_text_only.sql";
const sql = readFileSync(join(MIG, FILE), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
const code = strip(sql);
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("20261186 — the one-paste shape", () => {
  it("is the only file numbered 20261186, named for its round", () => {
    expect(readdirSync(MIG).filter((f) => f.startsWith("20261186"))).toEqual([FILE]);
    expect(FILE).toMatch(/^20261186_intel_roundG_[a-z_]+\.sql$/);
  });

  it("inventory before BEGIN, aggregate counts only; DDL inside BEGIN/COMMIT; one final SELECT of (check, ok, n)", () => {
    const temp = code.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g86_before");
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(commit).toBeGreaterThan(begin);
    const inventory = code.slice(temp, begin);
    const branches = inventory.split(/\bUNION ALL\b/);
    expect(branches.length).toBe(2);
    for (const b of branches) expect(b).toMatch(/COUNT\(\*\)/);
    // Never a customer row: no column of a document is selected, only counts.
    expect(inventory).not.toMatch(/SELECT\s+(id|name|file_key)\b/i);
    const tail = code.slice(commit + "\nCOMMIT;".length).trim();
    expect(tail.startsWith("SELECT")).toBe(true);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,\s*NULL::text AS n/);
    expect((tail.match(/;/g) ?? []).length).toBe(1);
    expect(tail).toMatch(/SELECT 'inventory \(before\): ' \|\| what, NULL, n::text FROM _intel_g86_before;$/);
  });

  it("adds exactly the column the code reads, idempotently — integer, NOT NULL, default 0 — and probes it and the 20261122 it depends on", () => {
    const tx = code.slice(code.indexOf("\nBEGIN;"), code.indexOf("\nCOMMIT;"));
    expect(tx).toContain("ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vision_keyless_pages INTEGER NOT NULL DEFAULT 0;");
    expect((tx.match(/ALTER TABLE/g) ?? []).length).toBe(1);
    const tail = code.slice(code.indexOf("\nCOMMIT;"));
    expect(tail).toMatch(/column_name = 'vision_keyless_pages' AND data_type = 'integer'\s+AND is_nullable = 'NO' AND column_default = '0'/);
    expect(tail).toMatch(/table_name = 'knowledge_documents'\s+AND column_name = 'ingest_claimed_by'/);
  });

  it("re-creates nothing (no lineDiff to pin), changes no row, and grants nothing", () => {
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER|VIEW)/i);
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|\bSECURITY DEFINER\b/i);
    expect(code).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO)\b/);
  });

  it("the header says why NOT NULL DEFAULT 0, the paste order, and what runs unpasted — no more than the code does", () => {
    expect(sql).toMatch(/Why NOT NULL DEFAULT 0 and not nullable/);
    expect(sql).toMatch(/Apply AFTER 20261122_intel_roundG_ingest_integrity\.sql/);
    // Only the keyless count's paths run as before unpasted: the DRAWING
    // FACTS' failed-page line and the dropped TRUST need only 20261122
    // (intelRoundGKeylessAskFacts.test.ts, 'a database without 20261186 …').
    expect(sql).toMatch(/Until this file is pasted\n-- every path that reads or writes the keyless count runs as before/);
    expect(sql).toMatch(/need only 20261122/);
    expect(sql).not.toMatch(/the code runs exactly as before/);
    expect(sql).toMatch(/The app may be deployed before or after the paste\./);
  });
});

describe("20261186 — the code writes and reads the column, and runs without it", () => {
  const lib = src("lib/knowledgeIngest.ts");

  it("the engine strips exactly this column on an older database, beside 20261122's and 20261162's", () => {
    const list = /const INGEST_COLUMNS_20261186 = \[([\s\S]*?)\];/.exec(lib)![1];
    expect([...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual(["vision_keyless_pages"]);
    expect((lib.match(/!INGEST_COLUMNS_20261186\.includes\(k\)/g) ?? []).length).toBe(2);
  });

  it("RESET_ROW starts it at 0; a generation's first batch starts it at 0; the commit writes it under the claim", () => {
    const resetRow = /const RESET_ROW = \{([\s\S]*?)\};/.exec(lib)![1];
    expect(resetRow).toMatch(/vision_keyless_pages: 0,/);
    expect(lib).toMatch(/const baseKeylessTextPages = genStart \? 0 : /);
    expect(lib).toMatch(/vision_keyless_pages: baseKeylessTextPages \+ keylessTextPages,/);
    // Only a batch with NO vision context counts, and never a held page.
    expect(lib).toMatch(/const keylessTextOnly = !vision && !visionHeld && \(needsVision \|\| readsEveryPage\);/);
  });

  it("I-06b's and I-18's limbs in the engine are untouched (the MERGE notes)", () => {
    // The owed pages are read before anything is deleted.
    const fn = lib.slice(lib.indexOf("export async function resetKnowledgeIndex("));
    expect(fn.indexOf("await visionOwedPages(id, seen)")).toBeLessThan(fn.indexOf('.from("knowledge_line_traces").delete()'));
    expect(lib).toMatch(/const owedVision = vision \? new Set<number>\(\) : new Set<number>\(pageQueue\(cur\.vision_owed_pages\)\);/);
    expect(lib).toMatch(/\} else if \(opts\.noVisionReason \|\| owedHere\) \{/);
    expect(lib).toMatch(/visionAllPages: sponsor\.forceAllPages/);
    expect(lib).toMatch(/headroomRefused = await vision\.beforeCall\(\);/);
  });

  it("every reader tolerates its absence: the ask route falls back on 42703 / PGRST204 naming it, the page's read stops asking", () => {
    const ask = src("app/api/knowledge/ask/route.ts");
    expect(ask).toMatch(/if \(unreadRead\.error && columnsMissing\(unreadRead\.error, KEYLESS_PAGES_COLUMN\)\) \{\n\s+unreadRead = await unreadOf\("id, vision_failed_pages"\);/);
    const client = src("lib/knowledgeKeylessClient.ts");
    expect(client).toMatch(/e\.code === "42703" \|\| e\.code === "PGRST204"/);
  });
});
