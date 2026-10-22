// drafting-flow Round G, DF-P25 — 20261267's shape (DEC-30 one paste), and
// the one function it re-creates pinned against its NEWEST definition in
// supabase/migrations (scanned at test time). Runtime behaviour on
// PostgreSQL 16: lib/__tests__/rls/dfP25ExceptionReviewFollowups.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");
const F = "20261267_df_roundG_exception_review_followups.sql";
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
const fnBody = (sql: string, name: string): string => {
  const i = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  if (i < 0) return "";
  const end = sql.indexOf("\n$$;", i);
  return sql.slice(i, end + 4);
};
/** The newest definition of `name` in a file numbered BELOW 20261267. */
const newestBefore = (name: string): { file: string; body: string } => {
  const prior = files.filter((f) => f < F && strip(mig(f)).includes(`CREATE OR REPLACE FUNCTION ${name}(`));
  const file = prior[prior.length - 1];
  return { file, body: fnBody(strip(mig(file)), name) };
};

describe("20261267 — DEC-30 one paste", () => {
  it("header, prerequisite check, counts-only inventory BEFORE the transaction, one BEGIN/COMMIT, one final SELECT (check, ok, n)", () => {
    expect(raw.startsWith("-- ─")).toBe(true);
    expect(raw).toContain("⚠ APPLIED BY HAND (DEC-30).");
    expect(raw).toContain("PASTE / DEPLOY ORDER");
    const pre = S.indexOf("DO $$");
    const temp = S.indexOf("CREATE TEMP TABLE df_round_g_267_before AS");
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
    const tail = S.slice(commit + "\nCOMMIT;".length).trim();
    expect(tail.startsWith('SELECT "check", ok, n FROM (')).toBe(true);
    expect(tail).toMatch(/ORDER BY sec, ord;$/);
    expect(tail).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT)\b/m);
  });
  it("the prerequisite refuses, changing nothing, without 20261264's function and tables", () => {
    const pre = S.slice(S.indexOf("DO $$"), S.indexOf("CREATE TEMP TABLE"));
    expect(pre).toContain("to_regclass('public.ticket_preauthorizations') IS NULL");
    expect(pre).toContain("p.proname = 'apply_ticket_preauthorizations'");
    expect(pre).toContain("nothing was changed");
    // review fix pass 3: the inventory reads 20261241's routing_control — the
    // prerequisite says so instead of the paste stopping on a bare 42703
    expect(pre).toContain("column_name = 'routing_control'");
    expect(pre).toContain("table_name IN ('libraries', 'collections', 'documents')) < 3 THEN");
    expect(pre).toContain("20261267 needs 20261241");
  });
  it("the inventory is aggregate counts only (6 rows) — never a customer row", () => {
    const inv = S.slice(S.indexOf("CREATE TEMP TABLE"), S.indexOf("\nBEGIN;"));
    expect((inv.match(/SELECT \d+(?: AS ord)?,/g) ?? []).length).toBe(6);
    expect((inv.match(/COUNT\(\*\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(inv).not.toMatch(/SELECT\s+\*/);
  });
  it("8 probes, the inventory and 2 after-rows in the one result set", () => {
    const tail = S.slice(S.indexOf('SELECT "check", ok, n FROM ('));
    expect((tail.match(/SELECT 1, \d+, '|SELECT 1 AS sec, 1 AS ord/g) ?? []).length).toBe(8);
    expect(tail).toContain("SELECT 2, ord, inventory, NULL, n FROM df_round_g_267_before");
    expect((tail.match(/SELECT 3, \d+, 'after:/g) ?? []).length).toBe(2);
  });
  it("no SECURITY DEFINER; every function SECURITY INVOKER, search_path pinned, EXECUTE revoked from client roles (DRLS-16 shape)", () => {
    expect(S).not.toMatch(/SECURITY DEFINER/);
    for (const fn of ["org_members_status_change_stamp", "ticket_history_actor_guard", "document_hold_examination_fixed", "document_hold_examination_opener"]) {
      expect(S).toContain(`CREATE OR REPLACE FUNCTION ${fn}()\nRETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$`);
      expect(S).toContain(`REVOKE ALL ON FUNCTION ${fn}() FROM PUBLIC, anon, authenticated;`);
    }
  });
});

describe("20261267 — what it re-creates, and what it does NOT", () => {
  it("apply_ticket_preauthorizations is 20261264's body (its newest) with exactly the one added condition (and its comment)", () => {
    const prior = newestBefore("apply_ticket_preauthorizations");
    expect(prior.file).toBe("20261264_df_roundG_consent_escalation.sql");
    const mine = fnBody(S, "apply_ticket_preauthorizations");
    const d = lineDiff(prior.body, mine);
    expect(d.onlyA).toEqual(["AND m.created_at IS NOT NULL AND m.created_at <= p.created_at)"]);
    expect(d.onlyB).toEqual([
      "AND m.created_at IS NOT NULL AND m.created_at <= p.created_at",
      "AND (m.status_changed_at IS NULL OR m.status_changed_at < p.created_at))",
    ]);
    // the grants are 20261264's, verbatim
    for (const g of [
      "REVOKE ALL ON FUNCTION apply_ticket_preauthorizations(UUID, UUID, TIMESTAMPTZ, UUID[], JSONB, JSONB, TIMESTAMPTZ, UUID[]) FROM PUBLIC, anon, authenticated;",
      "GRANT EXECUTE ON FUNCTION apply_ticket_preauthorizations(UUID, UUID, TIMESTAMPTZ, UUID[], JSONB, JSONB, TIMESTAMPTZ, UUID[]) TO service_role;",
    ]) {
      expect(strip(mig(prior.file))).toContain(g);
      expect(S).toContain(g);
    }
  });
  it("the comment lines that changed are comments only (the raw file's diff beyond the condition is in `--` lines)", () => {
    const priorRaw = (() => { const t = mig("20261264_df_roundG_consent_escalation.sql"); const i = t.lastIndexOf("CREATE OR REPLACE FUNCTION apply_ticket_preauthorizations("); return t.slice(i, t.indexOf("\n$$;", i) + 4); })();
    const mineRaw = (() => { const i = raw.lastIndexOf("CREATE OR REPLACE FUNCTION apply_ticket_preauthorizations("); return raw.slice(i, raw.indexOf("\n$$;", i) + 4); })();
    const d = lineDiff(priorRaw, mineRaw);
    expect([...d.onlyA, ...d.onlyB].filter((l) => !l.startsWith("--") && !l.includes("m.created_at <= p.created_at") && !l.includes("status_changed_at"))).toEqual([]);
  });
  it("ticket_update_guard (newest body pending as a HOLD — 20261250) and 20261073's hold guards are NOT re-created; no existing trigger or policy is re-created", () => {
    for (const name of ["ticket_update_guard", "enforce_document_hold_guard", "enforce_document_hold_org_guard"]) expect(S).not.toContain(`FUNCTION ${name}(`);
    expect(S).not.toMatch(/CREATE POLICY/);
    const triggers = [...S.matchAll(/CREATE TRIGGER (\w+)/g)].map((x) => x[1]).sort();
    expect(triggers).toEqual(["trg_document_hold_examination_fixed", "trg_document_hold_examination_opener", "trg_org_members_status_changed", "trg_ticket_history_actor_guard"]);
    for (const t of triggers) for (const f of files.filter((x) => x < F)) expect(strip(mig(f))).not.toContain(`CREATE TRIGGER ${t}`);
    for (const fn of ["org_members_status_change_stamp", "ticket_history_actor_guard", "document_hold_examination_fixed", "document_hold_examination_opener"]) {
      for (const f of files.filter((x) => x < F)) expect(strip(mig(f))).not.toContain(`FUNCTION ${fn}(`);
    }
  });
  it("the actor guard checks appended AND in-place-rewritten entries (never an unchanged one), only for a client role, and refuses with 42501 (review fix pass 2)", () => {
    const g = fnBody(S, "ticket_history_actor_guard");
    expect(g).toContain("IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;");
    expect(g).toContain("WHERE h.ordinality > v_old_len\n                     OR h.value IS DISTINCT FROM (OLD.history -> (h.ordinality::int - 1)) LOOP");
    expect(g).not.toContain("WHERE h.ordinality > v_old_len LOOP");
    // the probe pins the same clause in the live function
    expect(S).toContain("AND p.prosrc LIKE '%h.value IS DISTINCT FROM (OLD.history -> (h.ordinality::int - 1))%'");
    expect(g).toContain("USING ERRCODE = '42501'");
    expect(S).toContain("BEFORE UPDATE OF history ON tickets");
  });
  it("the hold record's opener check: only a client insert carrying a record, refused 42501 unless opened_by is the caller (review fix pass)", () => {
    const g = fnBody(S, "document_hold_examination_opener");
    expect(g).toContain("IF NEW.examination IS NOT NULL AND current_user IN ('authenticated', 'anon')");
    expect(g).toContain("AND (auth.uid() IS NULL OR NEW.opened_by IS DISTINCT FROM auth.uid()) THEN");
    expect(g).toContain("USING ERRCODE = '42501'");
    expect(S).toContain("CREATE TRIGGER trg_document_hold_examination_opener\n  BEFORE INSERT ON document_holds\n  FOR EACH ROW EXECUTE FUNCTION document_hold_examination_opener();");
  });
  it("a recorded hold's opener is pinned by THIS file, for every role, without 20261073 (review fix pass 3)", () => {
    const g = fnBody(S, "document_hold_examination_fixed");
    expect(g).toContain("IF NEW.examination IS DISTINCT FROM OLD.examination THEN");
    expect(g).toContain("IF OLD.examination IS NOT NULL\n     AND (NEW.opened_by IS DISTINCT FROM OLD.opened_by OR NEW.opened_by_name IS DISTINCT FROM OLD.opened_by_name) THEN");
    expect(g).not.toContain("current_user");
    expect(g.match(/USING ERRCODE = '42501'/g)).toHaveLength(2);
    expect(S).toContain("CREATE TRIGGER trg_document_hold_examination_fixed\n  BEFORE UPDATE OF examination, opened_by, opened_by_name ON document_holds\n  FOR EACH ROW EXECUTE FUNCTION document_hold_examination_fixed();");
    // probe 7 checks the trigger's columns and the opener clause
    expect(S).toContain("= ARRAY['examination', 'opened_by', 'opened_by_name'])");
    expect(S).toContain("AND p.prosrc LIKE '%NEW.opened_by IS DISTINCT FROM OLD.opened_by OR NEW.opened_by_name IS DISTINCT FROM OLD.opened_by_name%'");
    // the header no longer leans on 20261073 for the opener
    expect(raw).not.toContain("pinned once placed by 20261073's guard");
  });
  it("the status stamp: NULL on insert, the time on a status change, the stored value otherwise", () => {
    const f = fnBody(S, "org_members_status_change_stamp");
    expect(f).toContain("NEW.status_changed_at := NULL;");
    expect(f).toContain("ELSIF NEW.status IS DISTINCT FROM OLD.status THEN\n    NEW.status_changed_at := clock_timestamp();");
    expect(f).toContain("NEW.status_changed_at := OLD.status_changed_at;");
    expect(S).toContain("BEFORE INSERT OR UPDATE ON org_members");
  });
});
