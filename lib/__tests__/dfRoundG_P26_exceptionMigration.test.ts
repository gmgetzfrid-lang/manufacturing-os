// drafting-flow Round G, DF-P26 — 20261268's shape (DEC-30 one paste) and
// the three constraints it re-creates, each pinned against its NEWEST
// definition in supabase/migrations (scanned at test time) with a lineDiff:
// exactly the exception-only rule's value / alternative added, nothing else.
// Runtime behaviour on PostgreSQL 16: lib/__tests__/rls/dfP26IssuingPathStops.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");
const F = "20261268_df_roundG_issuing_path_stops.sql";
const raw = readFileSync(join(DIR, F), "utf8");
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const S = strip(raw);
const files = readdirSync(DIR).filter((f) => /^\d{8}_.*\.sql$/.test(f)).sort();
const mig = (f: string) => readFileSync(join(DIR, f), "utf8");

function lineDiff(a: string, b: string): { onlyA: string[]; onlyB: string[] } {
  const la = a.split("\n").map((l) => l.trim()).filter(Boolean);
  const lb = b.split("\n").map((l) => l.trim()).filter(Boolean);
  return { onlyA: la.filter((l) => !lb.includes(l)), onlyB: lb.filter((l) => !la.includes(l)) };
}
const stmt = (sql: string, marker: string): string => {
  const i = sql.lastIndexOf(marker);
  if (i < 0) return "";
  // the statement ends at the first ";" that closes it (a CHECK body has none inside)
  return sql.slice(i, sql.indexOf(";", i) + 1);
};
const VIA = "ADD CONSTRAINT ticket_review_slots_satisfied_via_check";
const SHAPE = "ADD CONSTRAINT ticket_review_slots_satisfied_shape";

describe("20261268 — DEC-30 one paste", () => {
  it("header, prerequisite check, counts-only inventory BEFORE the transaction, one BEGIN/COMMIT, one final SELECT (check, ok, n)", () => {
    expect(raw.startsWith("-- ─")).toBe(true);
    expect(raw).toContain("⚠ APPLIED BY HAND (DEC-30).");
    expect(raw).toContain("PASTE / DEPLOY ORDER");
    const pre = S.indexOf("DO $$");
    const temp = S.indexOf("CREATE TEMP TABLE df_round_g_268_before AS");
    const begin = S.indexOf("\nBEGIN;");
    const commit = S.indexOf("\nCOMMIT;");
    const final = S.indexOf('SELECT "check", ok, n FROM (');
    expect(pre).toBeGreaterThan(0);
    expect(pre).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(commit).toBeLessThan(final);
    expect(S.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(S.match(/\nCOMMIT;/g)).toHaveLength(1);
    expect(S.match(/SELECT "check", ok, n FROM \(/g)).toHaveLength(1);
    // the inventory counts — never a customer row
    const inv = S.slice(temp, begin);
    expect(inv).not.toMatch(/SELECT \*/);
    expect(inv.match(/COUNT\(\*\)/g)!.length).toBeGreaterThanOrEqual(3);
    // 4 probes (ok, n NULL) + the inventory + one after-row
    expect(S.match(/SELECT 1, \d, '/g)).toHaveLength(3);
    expect(S).toContain("SELECT 1 AS sec, 1 AS ord,");
    expect(S).toContain("SELECT 2, ord, inventory, NULL, n FROM df_round_g_268_before");
    expect(S).toContain(") AS final_rows\nORDER BY sec, ord;");
  });
  it("refuses, changing nothing, without 20261242, 20261255, 20261264 and 20261241", () => {
    const pre = S.slice(S.indexOf("DO $$"), S.indexOf("CREATE TEMP TABLE"));
    for (const n of ["20261242", "20261255", "20261264", "20261241"]) expect(pre).toContain(`needs ${n}`);
    expect(pre.match(/nothing was changed/g)!.length).toBe(4);
  });
  it("no SECURITY DEFINER; no policy; no grant to a client role; the probe function is the service role's only (DRLS-16 shape)", () => {
    expect(S).not.toMatch(/SECURITY DEFINER/);
    expect(S).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY/);
    expect(S).not.toMatch(/GRANT [^;]* TO (authenticated|anon|PUBLIC)/i);
    expect(S).toContain("CREATE OR REPLACE FUNCTION exception_only_review_ready()\nRETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$");
    expect(S).toContain("REVOKE ALL ON FUNCTION exception_only_review_ready() FROM PUBLIC, anon, authenticated;");
    expect(S).toContain("GRANT EXECUTE ON FUNCTION exception_only_review_ready() TO service_role;");
    expect(S.indexOf("CREATE OR REPLACE FUNCTION exception_only_review_ready()")).toBeLessThan(S.indexOf("\nCOMMIT;"));
    // the app's probe name is the function this file creates (and no earlier file does)
    const app = readFileSync(join(process.cwd(), "lib", "exceptionOnlyReview.ts"), "utf8");
    expect(app).toContain('db.rpc("exception_only_review_ready")');
    expect(files.filter((f) => f !== F && /FUNCTION\s+exception_only_review_ready/.test(strip(mig(f))))).toEqual([]);
  });
  it("probes read deparsed definitions (pg_get_constraintdef) — never a bare cast in a LIKE", () => {
    const probes = S.slice(S.indexOf('SELECT "check", ok, n FROM ('));
    expect(probes).not.toMatch(/LIKE '%::/);
    expect(probes).toContain("pg_get_constraintdef(oid) LIKE '%''rule''%'");
  });
});

describe("the satisfied_via CHECK — re-created from its NEWEST definition, one value added", () => {
  it("FOLDER SCAN: 20261264 is the newest definition before 20261268, and nothing after re-defines it", () => {
    const definers = files.filter((f) => new RegExp(`${VIA}\\b`).test(strip(mig(f))) || /satisfied_via TEXT CHECK/.test(strip(mig(f))));
    expect(definers.filter((f) => f < F).at(-1)).toBe("20261264_df_roundG_consent_escalation.sql");
    expect(definers.filter((f) => f > F)).toEqual([]);
  });
  it("lineDiff against 20261264: exactly the value list changes, by 'rule' only", () => {
    const newest = stmt(strip(mig("20261264_df_roundG_consent_escalation.sql")), VIA);
    const mine = stmt(S, VIA);
    const d = lineDiff(mine, newest);
    expect(d.onlyB).toEqual(["CHECK (satisfied_via IS NULL OR satisfied_via IN ('primary', 'alternate', 'override', 'consent', 'preauthorization'));"]);
    expect(d.onlyA).toEqual(["CHECK (satisfied_via IS NULL OR satisfied_via IN ('primary', 'alternate', 'override', 'consent', 'preauthorization', 'rule'));"]);
  });
});

describe("the shape CHECK — re-created from its NEWEST definition, the rule's alternative added", () => {
  it("FOLDER SCAN: 20261255 is the newest definition before 20261268, and nothing after re-defines it", () => {
    const definers = files.filter((f) => new RegExp(`${SHAPE}\\b`).test(strip(mig(f))) || /CONSTRAINT ticket_review_slots_satisfied_shape CHECK/.test(strip(mig(f))));
    expect(definers.filter((f) => f < F).at(-1)).toBe("20261255_df_roundG_consent_window.sql");
    expect(definers.filter((f) => f > F)).toEqual([]);
  });
  it("lineDiff against 20261255: the signer branch no longer admits 'rule', and one alternative is added — every other line identical", () => {
    const newest = stmt(strip(mig("20261255_df_roundG_consent_window.sql")), SHAPE);
    const mine = stmt(S, SHAPE);
    const d = lineDiff(mine, newest);
    expect(d.onlyB).toEqual([
      "(satisfied_by IS NOT NULL AND signature_id IS NOT NULL AND satisfied_via IS DISTINCT FROM 'consent')",
      "OR (satisfied_via = 'consent' AND mode = 'consent_window' AND satisfied_by IS NULL AND signature_id IS NULL)))",
    ]);
    expect(d.onlyA).toEqual([
      "(satisfied_by IS NOT NULL AND signature_id IS NOT NULL AND satisfied_via IS DISTINCT FROM 'consent' AND satisfied_via IS DISTINCT FROM 'rule')",
      "OR (satisfied_via = 'consent' AND mode = 'consent_window' AND satisfied_by IS NULL AND signature_id IS NULL)",
      "OR (satisfied_via = 'rule' AND mode = 'blocking' AND satisfied_by IS NULL AND signature_id IS NULL)))",
    ]);
  });
});

describe("the events' CHECK — re-created from its NEWEST (and only) definition, one value added", () => {
  it("FOLDER SCAN: 20261242's inline column CHECK is the only earlier definition; nothing after re-defines it", () => {
    const definers = files.filter((f) => /event TEXT NOT NULL CHECK \(event IN/.test(strip(mig(f))) || /ADD CONSTRAINT ticket_review_slot_events_event_check\b/.test(strip(mig(f))));
    expect(definers.filter((f) => f < F)).toEqual(["20261242_df_roundG_ticket_roster.sql"]);
    expect(definers.filter((f) => f > F)).toEqual([]);
  });
  it("the value list: 20261242's, plus 'reopened'; dropped by its default name; the append-only trigger untouched", () => {
    expect(strip(mig("20261242_df_roundG_ticket_roster.sql"))).toContain("event TEXT NOT NULL CHECK (event IN ('opened', 'told', 'satisfied', 'voided')),");
    expect(S).toContain("ALTER TABLE ticket_review_slot_events DROP CONSTRAINT IF EXISTS ticket_review_slot_events_event_check;");
    expect(S).toContain("CHECK (event IN ('opened', 'told', 'satisfied', 'voided', 'reopened'));");
    expect(S).not.toMatch(/FUNCTION ticket_review_slot_events_append_only|CREATE TRIGGER|DROP TRIGGER/);
  });
});
