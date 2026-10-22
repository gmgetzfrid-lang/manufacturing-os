// drafting-flow Round G, DF-P22 — 20261264's shape (DEC-30 one paste) and
// the one constraint it re-creates, pinned against its NEWEST definition in
// supabase/migrations (scanned at test time). Runtime behaviour on
// PostgreSQL 16: lib/__tests__/rls/dfP22ConsentEscalation.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");
const F = "20261264_df_roundG_consent_escalation.sql";
const raw = readFileSync(join(DIR, F), "utf8");
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const S = strip(raw);
const files = readdirSync(DIR).filter((f) => /^\d{8}_.*\.sql$/.test(f)).sort();
const mig = (f: string) => readFileSync(join(DIR, f), "utf8");

/** Lines of `a` not in `b` and of `b` not in `a` (trimmed, blank-free). */
function lineDiff(a: string, b: string): { onlyA: string[]; onlyB: string[] } {
  const la = a.split("\n").map((l) => l.trim()).filter(Boolean);
  const lb = b.split("\n").map((l) => l.trim()).filter(Boolean);
  return { onlyA: la.filter((l) => !lb.includes(l)), onlyB: lb.filter((l) => !la.includes(l)) };
}
const viaCheck = (sql: string): string => {
  const i = sql.lastIndexOf("ADD CONSTRAINT ticket_review_slots_satisfied_via_check");
  return i < 0 ? "" : sql.slice(i, sql.indexOf(";", i) + 1);
};

describe("20261264 — DEC-30 one paste", () => {
  it("header, prerequisite check, counts-only inventory BEFORE the transaction, one BEGIN/COMMIT, one final SELECT (check, ok, n)", () => {
    expect(raw.startsWith("-- ─")).toBe(true);
    expect(raw).toContain("⚠ APPLIED BY HAND (DEC-30).");
    expect(raw).toContain("PASTE / DEPLOY ORDER");
    const pre = S.indexOf("DO $$");
    const temp = S.indexOf("CREATE TEMP TABLE df_round_g_264_before AS");
    const begin = S.indexOf("\nBEGIN;");
    const commit = S.indexOf("\nCOMMIT;");
    const final = S.indexOf('SELECT "check", ok, n FROM (');
    expect(pre).toBeGreaterThan(0);
    expect(pre).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(commit).toBeLessThan(final);
    expect(S.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(S.match(/^COMMIT;$/gm)).toHaveLength(1);
    // after COMMIT: exactly one statement (the final SELECT)
    const tail = S.slice(commit + "\nCOMMIT;".length).trim();
    expect(tail.startsWith('SELECT "check", ok, n FROM (')).toBe(true);
    expect(tail).toMatch(/ORDER BY sec, ord;$/);
    expect(tail).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT)\b/m);
  });
  it("the inventory is aggregate counts only — never a customer row", () => {
    const inv = S.slice(S.indexOf("CREATE TEMP TABLE"), S.indexOf("\nBEGIN;"));
    const selects = inv.match(/SELECT \d+(?: AS ord)?,/g) ?? [];
    expect(selects.length).toBe(4);
    expect((inv.match(/COUNT\(\*\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(inv).not.toMatch(/SELECT\s+\*/);
  });
  it("no SECURITY DEFINER; every trigger function is SECURITY INVOKER with search_path pinned and EXECUTE revoked", () => {
    expect(S).not.toMatch(/SECURITY DEFINER/);
    for (const fn of ["ticket_sla_escalations_no_update", "ticket_preauthorizations_guard"]) {
      expect(S).toContain(`CREATE OR REPLACE FUNCTION ${fn}()\nRETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$`);
      expect(S).toContain(`REVOKE ALL ON FUNCTION ${fn}() FROM PUBLIC, anon, authenticated, service_role;`);
    }
  });
  it("both tables: row security on, ONE SELECT policy each, no client write grant", () => {
    for (const t of ["ticket_sla_escalations", "ticket_preauthorizations"]) {
      expect(S).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
      expect(S.match(new RegExp(`CREATE POLICY \\w+ ON ${t}`, "g"))).toHaveLength(1);
      expect(S).toContain(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${t} FROM anon, authenticated;`);
    }
    // fix pass 2: a pre-authorization is read by its own grantor or an Admin (the route's rule), not every member
    expect(S).toContain("USING (org_id IN (SELECT my_org_ids()) AND (grantor_id = auth.uid() OR is_org_admin(org_id)));");
    expect(S).not.toContain("USING (org_id IN (SELECT my_org_ids()));");
    expect(S).toContain("AND qual LIKE '%my_org_ids()%' AND qual LIKE '%grantor_id = auth.uid()%' AND qual LIKE '%is_org_admin(org_id)%')");
    expect(S).toContain("USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_sla_escalations.ticket_id AND t.org_id = ticket_sla_escalations.org_id));");
  });
  it("a pre-authorization: scoped, required expiry of at most 365 days, revoker with every revocation; no foreign key on its library (a removed library never widens it)", () => {
    expect(S).toContain("CONSTRAINT ticket_preauthorizations_scoped CHECK (library_id IS NOT NULL OR request_type IS NOT NULL OR work_class IS NOT NULL)");
    expect(S).toContain("CONSTRAINT ticket_preauthorizations_expiry CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '365 days')");
    expect(S).toContain("expires_at TIMESTAMPTZ NOT NULL,");
    expect(S).toMatch(/\n\s+library_id UUID,\n/);
    expect(S).not.toMatch(/library_id UUID REFERENCES/);
  });
  it("merge-time fix pass: apply_ticket_preauthorizations — SECURITY INVOKER, search_path pinned, service role only; locks membership rows then records FOR SHARE, re-checks revoked_at / expiry / continuous membership, then the compare-and-set — all in one call", () => {
    const sig = "apply_ticket_preauthorizations(UUID, UUID, TIMESTAMPTZ, UUID[], JSONB, JSONB, TIMESTAMPTZ, UUID[])";
    expect(S).toContain("RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(S).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`);
    expect(S).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`);
    const body = S.slice(S.indexOf("CREATE OR REPLACE FUNCTION apply_ticket_preauthorizations("), S.indexOf(`REVOKE ALL ON FUNCTION ${sig}`));
    const at = (needle: string) => { const i = body.indexOf(needle); expect(i, needle).toBeGreaterThan(0); return i; };
    // order: membership rows locked, then the records locked and re-checked, then membership continuity, then the write
    const lockMembers = at("PERFORM 1 FROM org_members m");
    const lockRecords = at("AND p.revoked_at IS NULL AND p.expires_at > now()");
    const continuity = at("AND m.created_at IS NOT NULL AND m.created_at <= p.created_at");
    const write = at("UPDATE tickets");
    expect(lockMembers).toBeLessThan(lockRecords);
    expect(lockRecords).toBeLessThan(continuity);
    expect(continuity).toBeLessThan(write);
    expect(body.match(/FOR SHARE/g)).toHaveLength(2);
    expect(body).toContain("a.action IN ('MEMBER_SUSPENDED', 'MEMBER_REMOVED', 'MEMBER_RESTORED', 'MEMBER_REACTIVATED')");
    expect(body).toContain("AND last_modified IS NOT DISTINCT FROM p_expected_last_modified;");
    expect(body).toContain("'not_in_force'");
    // it sits inside the one transaction, and the final SELECT probes it
    expect(S.indexOf("CREATE OR REPLACE FUNCTION apply_ticket_preauthorizations(")).toBeLessThan(S.indexOf("\nCOMMIT;"));
    expect(S).toContain("SELECT 1, 9, 'DF-P22 merge-time fix pass: apply_ticket_preauthorizations");
  });
  it("the escalation claim: one row per (ticket, breach, period)", () => {
    expect(S).toContain("UNIQUE (ticket_id, breached_at, period_index)");
  });
});

describe("the roster ledger's satisfied_via CHECK — re-created from its NEWEST definition, one value added", () => {
  it("FOLDER SCAN: 20261255 is the newest definition before 20261264, and nothing after re-defines it", () => {
    const definers = files.filter((f) => /ADD CONSTRAINT ticket_review_slots_satisfied_via_check\b/.test(strip(mig(f))) || /satisfied_via TEXT CHECK/.test(strip(mig(f))));
    const before = definers.filter((f) => f < F);
    expect(before.at(-1)).toBe("20261255_df_roundG_consent_window.sql");
    // drafting-flow DF-P26's 20261268 re-creates it from THIS file's body plus
    // one value ('rule'), pinned byte for byte by dfRoundG_P26_exceptionMigration.test.ts.
    expect(definers.filter((f) => f > F)).toEqual(["20261268_df_roundG_issuing_path_stops.sql"]);
  });
  it("lineDiff against 20261255: exactly the value list changes, by 'preauthorization' only; the shape CHECK is not touched", () => {
    const newest = viaCheck(strip(mig("20261255_df_roundG_consent_window.sql")));
    const mine = viaCheck(S);
    expect(newest).toContain("'primary', 'alternate', 'override', 'consent'");
    const d = lineDiff(mine, newest);
    expect(d.onlyB).toEqual(["CHECK (satisfied_via IS NULL OR satisfied_via IN ('primary', 'alternate', 'override', 'consent'));"]);
    expect(d.onlyA).toEqual(["CHECK (satisfied_via IS NULL OR satisfied_via IN ('primary', 'alternate', 'override', 'consent', 'preauthorization'));"]);
    expect(S).not.toMatch(/ADD CONSTRAINT ticket_review_slots_satisfied_shape/);
  });
});
