// intelligence Round G — I-18 (GOV-15): 20261173_intel_roundG_ai_cap_change.sql.
//
// One SECURITY DEFINER function makes a cap change one transaction. The file
// is read as text (there is no database here; the function itself was run on
// a throwaway PostgreSQL 16 — GOV-10's sequential matrix, the refusals, the
// DRLS-16 grants and two-change interleavings, recorded in GOV-15's
// resolution). This pins what that run proved against later edits:
//   - DEC-30's one-paste shape: a counts-only TEMP inventory BEFORE the
//     transaction, BEGIN … COMMIT, ONE final SELECT (check, ok, n);
//   - the function is NEW (no earlier migration defines it), nothing else is
//     re-created, and the route's rpc call matches its signature;
//   - DRLS-16: search_path pinned, EXECUTE from PUBLIC / anon /
//     authenticated revoked and granted to service_role only, and a
//     signed-in session refused in the body;
//   - the lock (advisory + FOR UPDATE) and every decision the app maps.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const FILE = "20261173_intel_roundG_ai_cap_change.sql";
const sql = readFileSync(join(dir, FILE), "utf8");
const code = sql.replace(/--[^\n]*/g, "");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const capChange = readFileSync(join(process.cwd(), "lib", "ai", "capChange.ts"), "utf8");

const body = (() => {
  const m = /CREATE OR REPLACE FUNCTION ai_cap_change\(([\s\S]*?)\) RETURNS JSONB([\s\S]*?)AS \$\$([\s\S]*?)\$\$;/.exec(sql);
  if (!m) throw new Error("ai_cap_change definition not found");
  return { args: m[1], attrs: m[2], text: m[3] };
})();

describe("20261173 — DEC-30's one-paste shape", () => {
  it("a header comment, the counts-only inventory BEFORE the transaction, BEGIN … COMMIT, then ONE final SELECT (check, ok, n)", () => {
    expect(sql.startsWith("-- ")).toBe(true);
    const temp = code.indexOf("CREATE TEMP TABLE intel_round_g_173_before");
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(0);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1);
    const tail = code.slice(commit + "\nCOMMIT;".length);
    // one statement after the transaction: the final SELECT
    expect(tail.trim().split(/;\s*$/m).filter((s) => s.trim()).length).toBe(1);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,[\s\S]*NULL::text AS n/);
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM intel_round_g_173_before;\s*$/);
  });

  it("the inventory holds aggregate counts only — never a customer row", () => {
    const inventory = code.slice(code.indexOf("CREATE TEMP TABLE"), code.indexOf("\nBEGIN;"));
    const selects = inventory.split(/UNION ALL/);
    expect(selects.length).toBe(6);
    for (const s of selects) expect(s).toMatch(/COUNT\(\*\)::text/);
  });
});

describe("20261173 — the function, its grants and its lock (DRLS-16, GOV-15)", () => {
  it("is NEW: no earlier migration in the sequence defines ai_cap_change, and this file re-creates nothing else", () => {
    const earlier = files.filter((f) => f < FILE && /FUNCTION\s+(?:public\.)?ai_cap_change\s*\(/i.test(readFileSync(join(dir, f), "utf8")));
    expect(earlier).toEqual([]);
    expect(code.match(/CREATE (?:OR REPLACE )?FUNCTION/g)).toHaveLength(1);
    expect(code).not.toMatch(/CREATE (?:OR REPLACE )?(?:POLICY|TRIGGER)|DROP FUNCTION|ALTER TABLE/i);
  });

  it("takes exactly the arguments the route sends, and answers jsonb", () => {
    expect(body.args.replace(/\s+/g, " ").trim()).toBe(
      "p_org_id UUID, p_actor UUID, p_target UUID, p_cap_usd NUMERIC, p_clear BOOLEAN, p_other_holders BOOLEAN");
    for (const p of ["p_org_id", "p_actor", "p_target", "p_cap_usd", "p_clear", "p_other_holders"]) {
      expect(capChange).toMatch(new RegExp(`${p}: `));
    }
    expect(capChange).toMatch(/export const CAP_CHANGE_FUNCTION = "ai_cap_change";/);
  });

  it("SECURITY DEFINER with search_path pinned; EXECUTE revoked from PUBLIC, anon and authenticated and granted to service_role ONLY", () => {
    expect(body.attrs).toMatch(/SECURITY DEFINER\s+SET search_path = public/);
    const sig = "ai_cap_change\\(UUID, UUID, UUID, NUMERIC, BOOLEAN, BOOLEAN\\)";
    expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`));
    expect(code).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${sig} FROM anon;`));
    expect(code).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${sig} FROM authenticated;`));
    const grants = [...code.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO ([^;]+);`, "g"))].map((m) => m[1].trim());
    expect(grants).toEqual(["service_role"]);
    // the NULL-uid rule: only the service role (no user) is served; a
    // signed-in session is refused before anything is read
    expect(body.text).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN\s+RAISE EXCEPTION/);
    expect(body.text.indexOf("IF auth.uid() IS NOT NULL")).toBeLessThan(body.text.indexOf("pg_advisory_xact_lock"));
  });

  it("locks before it reads: the workspace's cap-change lock, then FOR UPDATE on the default and the override rows it decides from", () => {
    const lock = body.text.indexOf("PERFORM pg_advisory_xact_lock(hashtext('ai_cap_change'), hashtext(p_org_id::text));");
    expect(lock).toBeGreaterThan(0);
    const reads = [...body.text.matchAll(/FROM ai_usage_limits\s+WHERE ([^;]+?) FOR UPDATE;/g)].map((m) => m[1].replace(/\s+/g, " "));
    expect(reads).toEqual([
      "org_id = p_org_id AND user_id IS NULL",
      "org_id = p_org_id AND user_id = p_target",
      "org_id = p_org_id AND user_id = p_actor",
    ]);
    expect(body.text.indexOf("FOR UPDATE")).toBeGreaterThan(lock);
    // every write and every audit row comes after the lock
    for (const w of ["INSERT INTO ai_usage_limits", "UPDATE ai_usage_limits", "DELETE FROM ai_usage_limits", "INSERT INTO audit_logs"]) {
      expect(body.text.indexOf(w)).toBeGreaterThan(lock);
    }
  });

  it("decides what the app maps: the ban, the non-raising self-clear (allowed), the sole holder's record first, the hold before the default moves", () => {
    for (const reason of ["self_raise", "self_clear", "roster_unreadable", "sole_audit_failed"]) {
      expect(body.text).toContain(`'reason', '${reason}'`);
      expect(capChange).toContain(`case "${reason}":`);
    }
    // the self-clear is refused only when the default is HIGHER (a raise)
    expect(body.text).toMatch(/IF v_default_cap > v_previous THEN\s+RETURN jsonb_build_object\('outcome', 'refused', 'reason', 'self_clear'\);/);
    // a sole holder's record is written before the change and refuses it unrecorded
    expect(body.text.indexOf("'reason', 'sole_audit_failed'")).toBeLessThan(body.text.indexOf("DELETE FROM ai_usage_limits"));
    // the hold is inserted before the default is written
    const hold = body.text.indexOf("VALUES (p_org_id, p_actor, v_pin, p_actor, now());");
    const def = body.text.indexOf("UPDATE ai_usage_limits SET monthly_cap_usd = p_cap_usd");
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThan(def);
    // every other row is written in a guarded block: a refusing log never undoes the change
    expect(body.text.match(/EXCEPTION WHEN OTHERS THEN\s+v_retry := v_retry \|\| jsonb_build_array\(v_(?:details|held)\);/g)).toHaveLength(3);
    // every field the route reads is one the function answers
    for (const key of ["outcome", "cap_usd", "previous_cap_usd", "sole_holder", "pinned_at_default", "held_self_at_usd", "audit_retry", "error"]) {
      expect(body.text).toContain(`'${key}'`);
      expect(capChange).toContain(`d.${key}`);
    }
  });

  it("the probes check the function, the lock, the grants and the indexes it relies on (seven, ok = true)", () => {
    const tail = code.slice(code.indexOf("\nCOMMIT;"));
    expect(tail.match(/NULL::text\s*(?:AS n)?\s*\nUNION ALL/g)?.length).toBe(7);
    expect(tail).toContain("has_function_privilege('service_role', 'ai_cap_change(uuid, uuid, uuid, numeric, boolean, boolean)', 'EXECUTE')");
    expect(tail).toContain("NOT has_function_privilege('anon', 'ai_cap_change(uuid, uuid, uuid, numeric, boolean, boolean)', 'EXECUTE')");
    expect(tail).toContain("x.grantee = 0 AND x.privilege_type = 'EXECUTE'");
    expect(tail).toContain("'ai_usage_limits_org_default_idx', 'ai_usage_limits_user_idx'");
  });
});
