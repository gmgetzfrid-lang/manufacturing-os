// intelligence Round G (I-15) — 20261233, GM-7's recorded residual: the
// index on proposed_links (org_id, status, created_at DESC, id DESC), the
// graph's keyset read's own order. Shape only (DEC-30's one-paste form);
// the cases it was exercised on are in its header and GM-7's record.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase/migrations");
const FILE = "20261233_intel_roundG_proposed_links_keyset_index.sql";
const sql = readFileSync(join(DIR, FILE), "utf8");
/** The script without its comment lines. */
const body = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("20261233 — DEC-30 one-paste shape", () => {
  it("is the only file numbered 20261233", () => {
    expect(readdirSync(DIR).filter((f) => f.startsWith("20261233"))).toEqual([FILE]);
  });

  it("opens with a header comment naming the finding, the paste order and the rollback", () => {
    expect(sql.startsWith("-- ─")).toBe(true);
    for (const s of ["GM-7", "PASTE AND DEPLOY ORDER", "Not widening (DEC-30)", "APPLIED BY HAND (DEC-30)", "ROLLBACK: DROP INDEX IF EXISTS proposed_links_org_status_keyset_idx;", "Exercised on PostgreSQL 16"]) {
      expect(sql).toContain(s);
    }
  });

  it("captures a counts-only inventory BEFORE the transaction, then BEGIN … COMMIT once, then ONE final SELECT", () => {
    const temp = body.indexOf("CREATE TEMP TABLE intel_i15_20261233_before");
    const begin = body.indexOf("\nBEGIN;");
    const commit = body.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(body.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(body.match(/^COMMIT;$/gm)).toHaveLength(1);
    const tail = body.slice(commit + "\nCOMMIT;".length);
    // one statement after COMMIT: the result set
    expect(tail.trim().split(";").filter((s) => s.trim()).length).toBe(1);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,[\s\S]*NULL::text AS n/);
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM \(SELECT inventory, n FROM intel_i15_20261233_before ORDER BY ord\) b;\s*$/);
  });

  it("the inventory reads aggregate counts only — never a customer row", () => {
    const inv = body.slice(body.indexOf("CREATE TEMP TABLE"), body.indexOf("\nBEGIN;"));
    expect(inv).not.toMatch(/SELECT \*/i);
    const selects = inv.match(/\(SELECT [^)]*/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).toMatch(/^\(SELECT (COUNT\(\*|COALESCE\(MAX\(c)/);
  });

  it("the transaction is exactly the one CREATE INDEX IF NOT EXISTS, in the reader's order — nothing else", () => {
    const tx = body.slice(body.indexOf("\nBEGIN;") + 7, body.indexOf("\nCOMMIT;")).trim();
    expect(tx).toBe("CREATE INDEX IF NOT EXISTS proposed_links_org_status_keyset_idx\n  ON proposed_links (org_id, status, created_at DESC, id DESC);");
    expect(body).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|POLICY|TRIGGER)|DROP (INDEX|POLICY|FUNCTION|TRIGGER)|ALTER TABLE|GRANT|REVOKE|UPDATE |DELETE FROM|INSERT INTO (?!intel_)/i);
    expect(body).not.toMatch(/CONCURRENTLY/);
  });

  it("the probes deparse what they check: the index definition, validity, the old index kept, RLS still on", () => {
    expect(body).toContain("indexdef LIKE '%(org_id, status, created_at DESC, id DESC)%'");
    expect(body).toContain("i.indisvalid AND i.indisready");
    expect(body).toContain("indexname = 'proposed_links_org_status_idx'");
    expect(body).toContain("c.relrowsecurity");
  });

  it("names no model identifier", () => {
    expect(sql).not.toMatch(/claude|gpt-|gemini|sonnet|opus|haiku/i);
  });
});
