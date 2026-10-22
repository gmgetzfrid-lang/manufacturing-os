// drafting-flow Round G, DF-P24 — 20261266_df_roundG_examination_scope.sql,
// read as text (the runtime cases are lib/__tests__/rls/dfP24ExaminationScope.test.ts):
//   * DEC-30 one paste: prerequisites, a counts-only TEMP inventory BEFORE
//     the transaction, BEGIN … COMMIT, ONE final SELECT ("check", ok, n);
//   * nothing existing is re-created: no earlier migration defines the
//     guard function, the trigger, the policy or the table (each is new);
//   * no SECURITY DEFINER; both functions (the guard and — second fix pass —
//     the stamp of a requirement's `since`) pin search_path and no client
//     role executes them; no client write grant; one SELECT policy;
//   * the stamp trigger never reads the `since` a writer sent; the
//     requirements stored before a first paste are re-stamped BEFORE it is
//     created;
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
    expect(selects.length).toBe(3);
    for (const s of selects) expect(s).toMatch(/COUNT\(\*\)::text/);
  });
  it("the final SELECT carries 6 probes (ok, n NULL) and the inventory + after rows (ok NULL, n the count)", () => {
    const tail = code.slice(code.indexOf('SELECT "check", ok, n FROM ('));
    expect((tail.match(/^SELECT 1, \d+,|^SELECT 1 AS sec, 1 AS ord,/gm) ?? []).length).toBe(6);
    expect(tail).toMatch(/SELECT 2, ord, inventory, NULL, n FROM df_round_g_266_before/);
    expect(tail).toMatch(/SELECT 3, 1, 'after: requests with examination data on record/);
  });
});

describe("20261266 — new objects only, fail-safe grants", () => {
  it("no earlier migration (or schema.sql) defines the table, the guard, its trigger or the policy", () => {
    const others = readdirSync(DIR).filter((f) => f.endsWith(".sql") && f !== FILE).map((f) => readFileSync(join(DIR, f), "utf8"));
    others.push(readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8"));
    for (const name of ["ticket_examination_scopes_guard", "trg_ticket_examination_scopes_guard", "ticket_examination_scopes_read", "CREATE TABLE IF NOT EXISTS ticket_examination_scopes", "drafting_examination_scope_stamp", "trg_org_config_examination_scope_stamp"]) {
      expect(others.some((t) => t.includes(name)), name).toBe(false);
    }
  });
  it("no SECURITY DEFINER; the guard is SECURITY INVOKER with search_path pinned and executable by no client role", () => {
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION ticket_examination_scopes_guard\(\)\nRETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS \$\$/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION ticket_examination_scopes_guard\(\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION drafting_examination_scope_stamp\(\)\nRETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS \$\$/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION drafting_examination_scope_stamp\(\) FROM PUBLIC, anon, authenticated, service_role;/);
  });
  it("second fix pass: the stamp trigger fires on the drafting row only, never reads the writer's since, and the pre-paste re-stamp runs before it exists", () => {
    expect(code).toMatch(/CREATE TRIGGER trg_org_config_examination_scope_stamp\nBEFORE INSERT OR UPDATE ON org_configurations\nFOR EACH ROW WHEN \(NEW\.key = 'drafting'\)\nEXECUTE FUNCTION drafting_examination_scope_stamp\(\);/);
    const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION drafting_examination_scope_stamp()"), code.indexOf("REVOKE ALL ON FUNCTION drafting_examination_scope_stamp()"));
    // NEW's since is never read: the only since read is OLD's (o.r), and the
    // written value is always the kept OLD time or the database's stamp
    expect(fn).not.toMatch(/v_req->>'since'|v_req->'since'/);
    expect(fn).toMatch(/v_out := v_out \|\| jsonb_build_array\(v_req \|\| jsonb_build_object\('since', COALESCE\(v_kept, v_stamp\)\)\);/);
    expect(fn).toMatch(/clock_timestamp\(\) AT TIME ZONE 'UTC'\) \+ interval '60 seconds'/);
    expect(fn).toMatch(/IF TG_OP = 'UPDATE' AND OLD\.key = 'drafting' AND OLD\.org_id = NEW\.org_id/);
    const restamp = code.indexOf("UPDATE org_configurations c\n   SET data = jsonb_set(c.data, '{examinationScope,requirements}'");
    expect(restamp).toBeGreaterThan(code.indexOf("\nBEGIN;"));
    expect(restamp).toBeLessThan(code.indexOf("CREATE TRIGGER trg_org_config_examination_scope_stamp"));
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
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_org_config_examination_scope_stamp ON org_configurations;/);
    expect(code).toMatch(/DROP POLICY IF EXISTS ticket_examination_scopes_read/);
    expect(code).toMatch(/DROP TABLE IF EXISTS df_round_g_266_before;/);
  });
});
