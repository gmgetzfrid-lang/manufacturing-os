// admin-and-org Round G, package P16 RESTORE TICKET NUMBER KEY — drafting-flow
// EDGE-5: 20261244 adds the tickets (org_id, ticket_id) unique key where a
// live database lacks it, refusing (and changing nothing) when a workspace
// holds a number twice. Shape tests over the one-paste file (DEC-30: the
// prerequisite check, the TEMP inventory of counts BEFORE one transaction,
// ONE final (check, ok, n) SELECT) and over the repository facts it rests on:
// supabase/schema.sql is the only file declaring the key, and no numbered
// migration before 20261244 creates or drops it. The three worlds (key live,
// added, refused) were exercised on a throwaway PostgreSQL 16 (the record
// lists the cases); the fresh-install replay (npm run test:db) runs the file
// after schema.sql, where the key is live and the paste changes nothing.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const MIGRATIONS = join(root, "supabase", "migrations");
const FILE = "20261244_ao_roundG_tickets_number_key.sql";
const raw = readFileSync(join(MIGRATIONS, FILE), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");
const numbered = readdirSync(MIGRATIONS).filter((n) => /^\d{8}.*\.sql$/.test(n)).sort();
const begin = sql.indexOf("\nBEGIN;");
const commit = sql.indexOf("\nCOMMIT;");
const ddl = sql.slice(begin, commit);
const verification = sql.slice(commit + "\nCOMMIT;".length);
const KEY_RE = /UNIQUE\s*\(\s*org_id\s*,\s*ticket_id\s*\)|tickets_org_id_ticket_id_key|ON\s+(?:public\.)?tickets\s*(?:USING\s+\w+\s*)?\(\s*(?:org_id\s*,\s*ticket_id|ticket_id\s*,\s*org_id)\s*\)/i;

describe("20261244 — where the key comes from today (DEC-90 ruling 1)", () => {
  it("supabase/schema.sql declares UNIQUE(org_id, ticket_id) inline in CREATE TABLE IF NOT EXISTS tickets — and nothing else in the repository does", () => {
    const schema = readFileSync(join(root, "supabase", "schema.sql"), "utf8");
    const table = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS tickets ("), schema.indexOf("CREATE INDEX IF NOT EXISTS tickets_org_id_idx"));
    expect(table).toMatch(/\n {2}UNIQUE\(org_id, ticket_id\)\n\);/);
    // no numbered migration before this one creates or drops the key
    for (const f of numbered.filter((n) => n < FILE)) {
      const body = readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "");
      expect(KEY_RE.test(body), f).toBe(false);
    }
    // nor any non-numbered SQL file under supabase/
    for (const f of readdirSync(join(root, "supabase")).filter((n) => n.endsWith(".sql") && n !== "schema.sql")) {
      expect(KEY_RE.test(readFileSync(join(root, "supabase", f), "utf8").replace(/--[^\n]*/g, "")), f).toBe(false);
    }
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && !/^\d{8}/.test(n))) {
      expect(KEY_RE.test(readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "")), f).toBe(false);
    }
  });
});

describe("20261244 — the one-paste shape (DEC-30)", () => {
  it("is the one file of its number", () => {
    expect(numbered.filter((f) => f.startsWith("20261244"))).toEqual([FILE]);
  });

  it("the prerequisite check, then the TEMP inventory BEFORE ONE transaction, then ONE final (check, ok, n) SELECT ending the file", () => {
    const guard = sql.indexOf("IF to_regclass('public.tickets') IS NULL THEN");
    const temp = sql.indexOf("CREATE TEMP TABLE _ao_g244_before");
    expect(guard).toBeGreaterThan(-1);
    expect(sql).toMatch(/RAISE EXCEPTION '20261244 needs the tickets table \(supabase\/schema\.sql\)\. Nothing was changed\.'/);
    expect(guard).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    const tail = verification.trim();
    expect(tail.split(/;\s*$/m).filter((x) => x.trim()).length).toBe(1);
    expect(tail).toMatch(/^SELECT "check", ok, n FROM \(/);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    expect(tail).toMatch(/SELECT 2, ord, inventory, NULL, n FROM _ao_g244_before\n\) AS final_rows\nORDER BY sec, ord;$/);
    expect(raw).toMatch(/APPLIED BY HAND \(DEC-30\)/);
  });

  it("the inventory is aggregate counts only — never a row", () => {
    const inv = sql.slice(sql.indexOf("CREATE TEMP TABLE"), begin);
    const parts = inv.split(/UNION ALL/);
    expect(parts.length).toBe(5);
    for (const sel of parts) expect(sel).toMatch(/COUNT\(\*\)|COUNT\(DISTINCT org_id\)|SUM\(n\)/);
    expect(inv).not.toMatch(/SELECT \*|row_to_json|json_agg|string_agg|to_jsonb\(/i);
    expect(inv).not.toMatch(/SELECT\s+ticket_id\b|SELECT\s+title\b/i);
    expect(inv).toMatch(/GROUP BY org_id, ticket_id HAVING COUNT\(\*\) > 1/);
  });

  it("the transaction: a lock timeout, and ONE DO block that adds the key only where it is absent and no number is held twice — under one lock for the check and the build", () => {
    expect(ddl).toMatch(/SET LOCAL lock_timeout = '10s';/);
    const block = ddl.slice(ddl.indexOf("DO $$"), ddl.indexOf("END $$;"));
    const present = block.indexOf("IF EXISTS (SELECT 1 FROM pg_index i");
    const lock = block.indexOf("LOCK TABLE tickets IN ACCESS EXCLUSIVE MODE;");
    const count = block.indexOf("SELECT COUNT(*) INTO v_dups FROM");
    const refuse = block.indexOf("IF v_dups > 0 THEN");
    const add = block.indexOf("ALTER TABLE tickets ADD CONSTRAINT tickets_org_id_ticket_id_key UNIQUE (org_id, ticket_id);");
    expect([present, lock, count, refuse, add].every((i) => i > -1)).toBe(true);
    expect(present).toBeLessThan(lock);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(refuse);
    expect(refuse).toBeLessThan(add);
    // the refusal returns before the ALTER, changing nothing
    expect(block.slice(refuse, add)).toMatch(/RAISE NOTICE '20261244 REFUSED: % request number\(s\)[\s\S]*RETURN;/);
    // "the key" means a plain unique index on exactly the two columns
    expect(block).toMatch(/i\.indisunique AND i\.indpred IS NULL AND i\.indexprs IS NULL\s+AND i\.indnkeyatts = 2/);
    expect(block).toMatch(/= ARRAY\['org_id', 'ticket_id'\]\) THEN/);
  });

  it("changes nothing else: no row written, no function, policy, trigger, grant or RLS change", () => {
    expect(sql).not.toMatch(/^\s*(CREATE|DROP)\s+(OR\s+REPLACE\s+)?(POLICY|FUNCTION|TRIGGER|INDEX|UNIQUE\s+INDEX)\b/im);
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE)\s/im);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+tickets\b/i);
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(ddl.match(/\bALTER TABLE\b/g)).toHaveLength(1);
  });

  it("the probes: the key, the world (true in every correct world), no number held twice, no request removed, RLS untouched", () => {
    const labels = Array.from(verification.matchAll(/'(EDGE-5[^']*(?:''[^']*)*)'/g)).map((m) => m[1]);
    expect(labels.some((l) => l.startsWith("EDGE-5: tickets carries a unique key on exactly (org_id, ticket_id)"))).toBe(true);
    expect(labels.filter((l) => l.startsWith("EDGE-5 world: "))).toHaveLength(3);
    expect(verification).toMatch(/EDGE-5 world: REFUSED — the key is absent and ' \|\| \(SELECT n FROM _ao_g244_before WHERE ord = 2\)/);
    expect(verification).toMatch(/= \(\(SELECT n FROM _ao_g244_before WHERE ord = 5\) <> '0' OR \(SELECT n FROM _ao_g244_before WHERE ord = 2\) = '0'\)/);
    expect(verification).toMatch(/NOT EXISTS \(SELECT 1 FROM tickets WHERE ticket_id IS NOT NULL GROUP BY org_id, ticket_id HAVING COUNT\(\*\) > 1\)/);
    expect(verification).toMatch(/\(SELECT COUNT\(\*\) FROM tickets\) >= \(SELECT n FROM _ao_g244_before WHERE ord = 1\)::bigint/);
    expect(verification).toMatch(/SELECT relrowsecurity FROM pg_class WHERE oid = 'public\.tickets'::regclass/);
    // P16 fix pass: probes 1 AND 3 are false in the REFUSED world (exercised on PostgreSQL 16); the header and the labels say so
    expect(labels.some((l) => l.startsWith("EDGE-5: no request number is held by more than one request in one workspace now (false only when this paste REFUSED, with probe 1"))).toBe(true);
    expect(raw).toMatch(/EXPECTED RESULT: probes 2, 4 and 5 are true on a correct paste in every\n-- world \(probe 2 is the world check\)\. Probes 1 and 3 are true, except in the\n-- REFUSED world/);
    expect(raw).toMatch(/Probes 1 and 3 are false in exactly one world, and together/);
    expect(raw).not.toMatch(/Probe 1 is false in exactly one world/);
  });

  it("the header names the paste order, the app's behaviour before and after, and the rollback", () => {
    expect(raw).toMatch(/PASTE ORDER: independent of every other file/);
    expect(raw).toMatch(/THE APP WORKS BEFORE AND AFTER THE PASTE, IN EITHER ORDER WITH THE P16\n-- DEPLOY/);
    expect(raw).toMatch(/ROLLBACK \(only if THIS file added the key/);
    expect(raw).toMatch(/ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_org_id_ticket_id_key;/);
  });
});
