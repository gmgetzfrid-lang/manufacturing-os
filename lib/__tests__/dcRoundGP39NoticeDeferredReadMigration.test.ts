// document-control Round G — P39 NOTICE RECORD REQUESTS (DIST-20, the done-
// when the integrator added at the P38 merge): the shape of
// supabase/migrations/20261259_dc_roundG_notice_deferred_read.sql. Its runtime
// behaviour (every reader, every action, before and after, a re-paste) is
// pinned on PostgreSQL 16 by lib/__tests__/rls/dcP39NoticeDeferredRead.test.ts
// under `npm run test:db`.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DOCUMENT_NOTICE_RECORD_DEFERRED } from "@/lib/documentNoticeRecord";

const DIR = join(process.cwd(), "supabase", "migrations");
const FILE = "20261259_dc_roundG_notice_deferred_read.sql";
const sql = readFileSync(join(DIR, FILE), "utf8");
const code = sql.replace(/--[^\n]*/g, "");
const POLICY = "audit_logs_notice_deferred_readers";

describe("20261259 — the deferred notice rows read as the record reads (DEC-30 one-paste shape)", () => {
  it("is the reserved number, named in the round's pattern, with a header comment", () => {
    expect(readdirSync(DIR).filter((f) => f.startsWith("20261259"))).toEqual([FILE]);
    expect(sql.startsWith("-- ─")).toBe(true);
    expect(sql).toMatch(/APPLIED BY HAND \(DEC-30\)/);
    expect(sql).toMatch(/PASTE \/ DEPLOY ORDER/);
    expect(sql).toMatch(/ROLLBACK of this policy alone:\n--\s+DROP POLICY IF EXISTS audit_logs_notice_deferred_readers ON audit_logs;/);
  });

  it("one paste: prerequisite check → counts-only TEMP inventory BEFORE the transaction → BEGIN / DDL / COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = code.indexOf("DO $$");
    const temp = code.indexOf("CREATE TEMP TABLE dc_round_g_259_before AS");
    const begin = code.indexOf("BEGIN;");
    const commit = code.indexOf("COMMIT;");
    const final = code.indexOf('SELECT "check", ok, n FROM (');
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(pre).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(commit).toBeLessThan(final);
    expect(code.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(code.match(/\bCOMMIT;/g)).toHaveLength(1);
    // the final SELECT is the last statement
    expect(code.slice(final).trim().endsWith("ORDER BY sec, ord;")).toBe(true);
    expect(code.slice(final).replace(/'([^']|'')*'/g, "''").match(/;/g)).toHaveLength(1);   // outside string literals
    // counts only: every inventory row is a COUNT(*) — never a customer row
    const inv = code.slice(temp, begin);
    expect(inv.match(/COUNT\(\*\)::text/g)).toHaveLength(4);
    expect(inv).not.toMatch(/SELECT\s+(a|d)\.\w+\s*,/);
    expect(inv).not.toMatch(/details|user_email|title/);
  });

  it("the DDL is ONE new RESTRICTIVE SELECT policy on audit_logs, re-creating nothing, altering nothing, defining no function or trigger", () => {
    const ddl = code.slice(code.indexOf("BEGIN;"), code.indexOf("COMMIT;"));
    expect(ddl.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(ddl.match(/DROP POLICY IF EXISTS/g)).toHaveLength(1);
    expect(ddl).toContain(`DROP POLICY IF EXISTS ${POLICY} ON audit_logs;`);
    expect(ddl).toContain(`CREATE POLICY ${POLICY} ON audit_logs\n  AS RESTRICTIVE FOR SELECT\n  USING (`);
    expect(code).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|TRIGGER)|ALTER TABLE|ALTER POLICY|GRANT |REVOKE |SECURITY DEFINER/);
    // nothing an earlier migration defines is re-created: the policy name is new
    const others = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f) && f !== FILE)
      .map((f) => readFileSync(join(DIR, f), "utf8").replace(/--[^\n]*/g, "")).join("\n");
    expect(others.includes(POLICY)).toBe(false);
  });

  it("the rule: the action test first (every other row never reaches the documents read), then a read of the document the row names, under the reader's own documents policies; the cast guarded", () => {
    const body = code.slice(code.indexOf(`CREATE POLICY ${POLICY}`), code.indexOf("COMMENT ON POLICY"));
    expect(body).toContain(`COALESCE(action, '') <> '${DOCUMENT_NOTICE_RECORD_DEFERRED}'\n    OR (resource_type = 'document'`);
    expect(body).toContain("AND EXISTS (SELECT 1 FROM documents d");
    expect(body).toContain("WHERE d.id = CASE WHEN resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
    expect(body).toContain("THEN resource_id::uuid END");
    expect(body).toContain("AND d.org_id = audit_logs.org_id))");
    // no role, capability or person is named: the read is the document's (Admins and DocCtrl read every document)
    expect(body).not.toMatch(/auth\.uid|org_capability_allows|is_org_controller|TO (anon|authenticated)/);
  });

  it("the result set: four probes (ok, n NULL) and four inventory rows (ok NULL, n the count); no bare cast inside a LIKE pattern (pg_policies.qual is deparsed)", () => {
    const final = code.slice(code.indexOf('SELECT "check", ok, n FROM ('));
    expect(final.match(/^SELECT 1, \d+, '|^SELECT 1 AS sec, 1 AS ord, '/gm)).toHaveLength(4);
    expect(final).toContain("SELECT 2, ord, inventory, NULL, n FROM dc_round_g_259_before");
    for (const pattern of final.match(/LIKE '([^']|'')*'/g) ?? []) expect(pattern, pattern).not.toMatch(/::/);
    // the probes read the policy back as deparsed: the action test, the documents read, the org match
    expect(final).toContain("qual LIKE '%<> ''DOCUMENT_NOTICE_RECORD_DEFERRED''%'");
    expect(final).toContain("qual LIKE '%FROM documents d%'");
    expect(final).toContain("qual LIKE '%d.org_id = audit_logs.org_id%'");
    expect(final).toContain("roles = ARRAY['public']::name[]");
  });

  it("the header says why a policy and not a service-role-only table (DEC-90 ruling (4) for P39), and what a re-paste of 20261142 / 20261157 / 20261219 reads", () => {
    expect(sql).toMatch(/WHY A POLICY, NOT A SERVICE-ROLE-ONLY DEFERRAL TABLE/);
    expect(sql).toMatch(/a re-paste of 20261219 reads its "ONE restrictive\n-- overlay" probe false/);
  });
});
