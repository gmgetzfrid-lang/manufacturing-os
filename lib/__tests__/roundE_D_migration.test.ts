// Round E — package D: shape pins on 20261063 (admin.audit_view at the
// database). The re-created evaluator is proven byte-faithful to the live
// 20261052 body except ONE added CASE line; the audit_logs overlay keeps the
// verbatim 20261045 predicate and swaps the hardcoded role list for the
// policy evaluator; the paste is one script with one final result set.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITY_DEFS } from "@/lib/capabilityPolicy";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const m63 = read("20261063_rp_roundE_audit_view_capability.sql");
const m52 = read("20261052_rp_phase7_capability_resource_dimension.sql");
const m45 = read("20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql");

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const ADDED = `      WHEN 'admin.audit_view'         THEN '["Admin","Manager","Supervisor","DocCtrl","Auditor"]'::jsonb`;

describe("20261063 — org_capability_allows_for learns admin.audit_view; audit_logs_admin_trail reads the policy", () => {
  const fn63 = between(m63, "CREATE OR REPLACE FUNCTION org_capability_allows_for", "-- ── 2. the audit trail overlay reads the policy");
  const fn52 = between(m52, "CREATE OR REPLACE FUNCTION org_capability_allows_for", "-- The 3-argument entry point every existing policy and trigger calls");

  it("the evaluator body is the live 20261052 body plus exactly one CASE line — nothing removed, nothing else added", () => {
    const { onlyInA, onlyInB } = lineDiff(fn52.trimEnd(), fn63.trimEnd());
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual([ADDED]);
    expect(fn63).toMatch(/org_capability_allows_for\(p_org UUID, p_cap TEXT, p_uid UUID, p_resource JSONB\)\s*\nRETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public/);
    // the added line sits inside the CASE, right after admin.archive_view
    expect(fn63).toMatch(/WHEN 'admin\.archive_view'\s+THEN '\["Admin","DocCtrl"\]'::jsonb\n      WHEN 'admin\.audit_view'/);
  });
  it("the default CASE now mirrors CAPABILITY_DEFS exactly (every id, same defaults, same count)", () => {
    const caseNew = between(fn63, "v_tokens := CASE p_cap", "END;");
    const sqlDefaults = new Map<string, string[]>();
    for (const m of caseNew.matchAll(/WHEN '([^']+)'\s+THEN '(\[[^\]]*\])'::jsonb/g)) sqlDefaults.set(m[1], JSON.parse(m[2]) as string[]);
    for (const def of CAPABILITY_DEFS) expect(sqlDefaults.get(def.id), def.id).toEqual(def.defaultRoles);
    expect(sqlDefaults.size).toBe(CAPABILITY_DEFS.length);
  });
  it("the 3-argument wrapper is NOT re-created (it is unchanged and every policy keeps calling it)", () => {
    expect(m63).not.toMatch(/CREATE OR REPLACE FUNCTION org_capability_allows\(/);
    expect(m63).not.toMatch(/DROP FUNCTION/);
  });
  it("audit_logs_admin_trail: RESTRICTIVE SELECT, the policy evaluator in place of the role list, the org-level predicate verbatim from 20261045", () => {
    const pol63 = between(m63, "CREATE POLICY audit_logs_admin_trail ON audit_logs", "COMMIT;");
    const pol45 = between(m45, "CREATE POLICY audit_logs_admin_trail ON audit_logs", "-- ── 2. asset registry writes");
    expect(pol63).toMatch(/AS RESTRICTIVE FOR SELECT/);
    expect(pol63).toContain("org_capability_allows(org_id, 'admin.audit_view', auth.uid())");
    expect(pol63).not.toContain("caller_holds_any_role");
    expect(m63).toContain("DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;");
    const pred45 = between(pol45, "OR NOT (", "    )");
    const pred63 = between(pol63, "OR NOT (", "    )");
    expect(pred63).toBe(pred45);
  });
  it("one paste: pre-apply inventory in a TEMP TABLE before BEGIN (widening, DEC-2), one BEGIN/COMMIT, one read-only final SELECT", () => {
    const beginAt = m63.indexOf("\nBEGIN;");
    const tempAt = m63.indexOf("CREATE TEMP TABLE rp_round_e_63_before AS");
    expect(tempAt).toBeGreaterThan(0);
    expect(tempAt).toBeLessThan(beginAt);
    expect((m63.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((m63.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const tail = m63.slice(m63.indexOf("COMMIT;") + "COMMIT;".length);
    expect((tail.match(/;/g) ?? []).length).toBe(1); // exactly one statement after COMMIT
    expect(tail.trim().startsWith("-- ── Verification + inventory")).toBe(true);
    expect(tail).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE)\b/);
    expect(tail).toContain("SELECT inventory, n FROM rp_round_e_63_before");
    // probes: 6 booleans cast to text; inventory: 2 AFTER aggregate counts (+ the temp table)
    expect((tail.match(/\)::text/g) ?? []).length).toBe(8);
    expect((tail.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(2);
    expect(tail).not.toMatch(/SELECT \*|SELECT data\b|SELECT uid|SELECT email/);
    // prosrc probes: the literal's delimiting quotes doubled, no bare casts in qual patterns
    expect(tail).toContain("prosrc LIKE '%WHEN ''admin.audit_view''");
    expect(tail).toContain("qual LIKE '%org_capability_allows(org_id, ''admin.audit_view''%'");
    expect(tail).not.toMatch(/qual LIKE '%[^']*::text\[\][^']*'/);
  });
  it("the pre-apply inventory counts the five-role readers and the (expected-zero) stored entries and grants", () => {
    const inv = between(m63, "CREATE TEMP TABLE rp_round_e_63_before AS", "\nBEGIN;");
    expect(inv).toContain("ARRAY['Admin','Manager','Supervisor','DocCtrl','Auditor']::text[]");
    expect(inv).toContain("COALESCE(data->'caps', data) ? 'admin.audit_view'");
    expect(inv).toContain("g->>'cap' = 'admin.audit_view'");
    expect((inv.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(3);
  });
});
