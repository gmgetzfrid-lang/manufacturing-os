// drafting-flow Round G, DF-P24 — 20261266_df_roundG_examination_scope.sql,
// read as text (the runtime cases are lib/__tests__/rls/dfP24ExaminationScope.test.ts):
//   * DEC-30 one paste: prerequisites, a counts-only TEMP inventory BEFORE
//     the transaction, BEGIN … COMMIT, ONE final SELECT ("check", ok, n);
//   * nothing existing is re-created: no earlier migration defines the
//     guard function, the trigger, the policy or the table (each is new);
//   * no SECURITY DEFINER; the one function pins search_path and no client
//     role executes it; no client write grant; one SELECT policy;
//   * the inventory never selects a customer row (aggregates only).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");
const FILE = "20261266_df_roundG_examination_scope.sql";
const sql = readFileSync(join(DIR, FILE), "utf8");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("20261266 — DEC-30 one-paste shape", () => {
  it("prerequisites, then the TEMP inventory, then BEGIN … COMMIT, then ONE final SELECT", () => {
    const pre = code.indexOf("DO $$");
    const temp = code.indexOf("CREATE TEMP TABLE df_round_g_266_before");
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    const final = code.indexOf('SELECT "check", ok, n FROM (');
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(pre).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(commit).toBeLessThan(final);
    expect(code.match(/\nBEGIN;/g)?.length).toBe(1);
    expect(code.match(/\nCOMMIT;/g)?.length).toBe(1);
    // after COMMIT there is exactly one statement: the result set
    expect(code.slice(commit + "\nCOMMIT;".length).trim().split(/;\s*$/m).filter((s) => s.trim()).length).toBe(1);
  });
  it("the inventory is counts only — no customer row is ever selected", () => {
    const inv = code.slice(code.indexOf("CREATE TEMP TABLE"), code.indexOf("\nBEGIN;"));
    const selects = inv.match(/SELECT[\s\S]*?FROM/g) ?? [];
    expect(selects.length).toBe(2);
    for (const s of selects) expect(s).toMatch(/COUNT\(\*\)::text/);
  });
  it("the final SELECT carries 4 probes (ok, n NULL) and the inventory + after rows (ok NULL, n the count)", () => {
    const tail = code.slice(code.indexOf('SELECT "check", ok, n FROM ('));
    expect((tail.match(/^SELECT 1, \d+,|^SELECT 1 AS sec, 1 AS ord,/gm) ?? []).length).toBe(4);
    expect(tail).toMatch(/SELECT 2, ord, inventory, NULL, n FROM df_round_g_266_before/);
    expect(tail).toMatch(/SELECT 3, 1, 'after: requests with examination data on record/);
  });
});

describe("20261266 — new objects only, fail-safe grants", () => {
  it("no earlier migration (or schema.sql) defines the table, the guard, its trigger or the policy", () => {
    const others = readdirSync(DIR).filter((f) => f.endsWith(".sql") && f !== FILE).map((f) => readFileSync(join(DIR, f), "utf8"));
    others.push(readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8"));
    for (const name of ["ticket_examination_scopes_guard", "trg_ticket_examination_scopes_guard", "ticket_examination_scopes_read", "CREATE TABLE IF NOT EXISTS ticket_examination_scopes"]) {
      expect(others.some((t) => t.includes(name)), name).toBe(false);
    }
  });
  it("no SECURITY DEFINER; the guard is SECURITY INVOKER with search_path pinned and executable by no client role", () => {
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION ticket_examination_scopes_guard\(\)\nRETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS \$\$/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION ticket_examination_scopes_guard\(\) FROM PUBLIC, anon, authenticated, service_role;/);
  });
  it("row security on; ONE policy (a SELECT as the request reads); clients hold no write", () => {
    expect(code).toMatch(/ALTER TABLE ticket_examination_scopes ENABLE ROW LEVEL SECURITY;/);
    expect(code.match(/CREATE POLICY/g)?.length).toBe(1);
    expect(code).toMatch(/CREATE POLICY ticket_examination_scopes_read ON ticket_examination_scopes\n {2}FOR SELECT TO authenticated\n {2}USING \(EXISTS \(SELECT 1 FROM tickets t WHERE t\.id = ticket_examination_scopes\.ticket_id AND t\.org_id = ticket_examination_scopes\.org_id\)\);/);
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_examination_scopes FROM anon, authenticated;/);
    expect(code).toMatch(/REVOKE ALL ON ticket_examination_scopes FROM anon;/);
  });
  it("re-runnable: every object is created IF NOT EXISTS / OR REPLACE / after a DROP … IF EXISTS", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS ticket_examination_scopes/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS ticket_examination_scopes_org_idx/);
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_ticket_examination_scopes_guard/);
    expect(code).toMatch(/DROP POLICY IF EXISTS ticket_examination_scopes_read/);
    expect(code).toMatch(/DROP TABLE IF EXISTS df_round_g_266_before;/);
  });
});
