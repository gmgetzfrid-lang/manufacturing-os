// intelligence Round G — I-05 GOV-10: shape pins on
// 20261137_intel_roundG_ai_manage_caps.sql.
//
// org_capability_allows_for is re-created from its NEWEST earlier definition
// with exactly ONE added CASE row (ai.manage_caps → ["Admin"]). "Newest
// earlier" is found by scanning the numbered sequence at test time — never
// a hard-coded file — so when another package's re-creation lands before
// this file and its row is folded into this body, the comparison follows it
// and still admits only this file's row.
//
// capability_policy_write_guard is re-created the same way (newest earlier
// definer: 20261056) with exactly ONE changed line — 'ai.manage_caps' joins
// its critical list, because the capability is `critical: true`: without it
// a Doc Controller could set the row to [DocCtrl], become its sole holder
// and raise their own cap with no Admin involved.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITY_DEFS } from "@/lib/capabilityPolicy";

const dir = join(process.cwd(), "supabase", "migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261137_intel_roundG_ai_manage_caps.sql";
const m137 = read(FILE);
const numbered = readdirSync(dir).filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql")).sort();
const H = "CREATE OR REPLACE FUNCTION org_capability_allows_for(";

function fnBody(text: string): string {
  const a = text.indexOf(H);
  expect(a, "evaluator not found").toBeGreaterThanOrEqual(0);
  return text.slice(a, text.indexOf("$$;", text.indexOf("AS $$", a) + 5) + 3);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const between = (text: string, from: string, to: string) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
};
const caseMap = (fn: string) => {
  const out = new Map<string, string[]>();
  for (const m of between(fn, "v_tokens := CASE p_cap", "END;").matchAll(/WHEN '([^']+)'\s+THEN '(\[[^\]]*\])'::jsonb/g)) {
    out.set(m[1], JSON.parse(m[2]) as string[]);
  }
  return out;
};
const tailOf = (m: string) => m.slice(m.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);
const codeOnly = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

const ADDED = `      WHEN 'ai.manage_caps'           THEN '["Admin"]'::jsonb`;
const fn137 = fnBody(m137);
const earlierDefiners = numbered.filter((f) => f < FILE && read(f).includes(H));
const newestEarlier = earlierDefiners[earlierDefiners.length - 1];
const fnPrev = fnBody(read(newestEarlier));

describe("20261137 — org_capability_allows_for learns ai.manage_caps (GOV-10)", () => {
  it("starts from the NEWEST earlier definition (found by scanning the sequence)", () => {
    expect(newestEarlier).toBeDefined();
    expect(newestEarlier < FILE).toBe(true);
    // at this package's base that is document-control P7's 20261132
    expect(earlierDefiners).toContain("20261132_dc_roundF_transmit_capability.sql");
  });

  it("is that body plus exactly ONE line — this file's CASE row — nothing removed, nothing else added", () => {
    const { onlyInA, onlyInB } = lineDiff(fnPrev, fn137);
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual([ADDED]);
    expect(fn137.split("\n").length).toBe(fnPrev.split("\n").length + 1);
    // inside the CASE, before its ELSE. Its place among the other rows is
    // free: J2b's parallel quality.sign_off row (20261136) folds into this
    // body at merge on either side of it, and the lineDiff above still
    // admits exactly this one row against whichever definer is newest.
    const caseBlock = between(fn137, "v_tokens := CASE p_cap", "END;");
    expect(caseBlock).toContain(ADDED);
    expect(caseBlock.indexOf(ADDED)).toBeLessThan(caseBlock.indexOf("ELSE '[]'::jsonb"));
    for (const id of caseMap(fnPrev).keys()) {
      expect(caseBlock.indexOf(`'${id}'`), id).toBeGreaterThanOrEqual(0);
      expect(caseBlock.indexOf(`'${id}'`), id).toBeLessThan(caseBlock.indexOf("ELSE '[]'::jsonb"));
    }
    expect(fn137).toMatch(/org_capability_allows_for\(p_org UUID, p_cap TEXT, p_uid UUID, p_resource JSONB\)\s*\nRETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public/);
  });

  it("the CASE mirrors CAPABILITY_DEFS exactly (every id, same defaults, same count) — ai.manage_caps defaults to Admin", () => {
    const sql = caseMap(fn137);
    for (const d of CAPABILITY_DEFS) expect(sql.get(d.id), d.id).toEqual(d.defaultRoles);
    expect(sql.size).toBe(CAPABILITY_DEFS.length);
    const def = CAPABILITY_DEFS.find((d) => d.id === "ai.manage_caps");
    expect(def?.defaultRoles).toEqual(["Admin"]);
    // CRITICAL: a change to who holds it is Admin's, and Admin stays on it —
    // in the policy route, in validateCapabilityPolicy and in the write guard
    // this file re-creates (below)
    expect(def?.critical).toBe(true);
  });

  it("DRLS-16: EXECUTE is taken from PUBLIC and anon and granted to authenticated + service_role, inside the transaction", () => {
    const tx = between(m137, "\nBEGIN;", "\nCOMMIT;");
    const sig = "org_capability_allows_for(UUID, TEXT, UUID, JSONB)";
    expect(tx).toContain(`REVOKE EXECUTE ON FUNCTION ${sig} FROM PUBLIC;`);
    expect(tx).toContain(`REVOKE EXECUTE ON FUNCTION ${sig} FROM anon;`);
    expect(tx).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated, service_role;`);
    expect(tx.indexOf("REVOKE")).toBeGreaterThan(tx.indexOf(H));
    // the probe pair checks both sides after apply
    expect(m137).toContain("NOT has_function_privilege('anon', 'org_capability_allows_for(uuid, text, uuid, jsonb)', 'EXECUTE')");
    expect(m137).toContain("has_function_privilege('authenticated', 'org_capability_allows_for(uuid, text, uuid, jsonb)', 'EXECUTE')");
  });

  it("does not touch the 3-argument wrapper", () => {
    // (nor any trigger: the write guard is re-created in place, below)
    expect(m137).not.toMatch(/CREATE TRIGGER|DROP TRIGGER/);
    expect(m137).not.toMatch(/CREATE OR REPLACE FUNCTION org_capability_allows\(/);
    expect(m137).not.toMatch(/DROP FUNCTION/);
  });

  it("one paste: inventory TEMP TABLE before BEGIN, one BEGIN/COMMIT, ONE final SELECT (check, ok, n) of probes + aggregate counts", () => {
    expect(m137.indexOf("CREATE TEMP TABLE intel_round_g_137_before AS")).toBeLessThan(m137.indexOf("\nBEGIN;"));
    expect((m137.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((m137.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const tail = tailOf(m137);
    expect((codeOnly(tail).match(/;/g) ?? []).length).toBe(1);
    expect(codeOnly(tail)).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/);
    expect(tail).toMatch(/AS check,\s*\n[\s\S]*?AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail).toContain("SELECT inventory, NULL::boolean, n FROM intel_round_g_137_before");
    // the probe's LIKE pattern is the CASE row itself, quotes doubled (prosrc is verbatim)
    expect(tail).toContain(`prosrc LIKE '%${ADDED.trim().replace(/'/g, "''")}%'`);
    // aggregate counts only — never a customer row
    const inventory = between(m137, "CREATE TEMP TABLE", "\nBEGIN;");
    expect(inventory).not.toMatch(/SELECT \*|SELECT data\b|SELECT uid|SELECT email/);
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(6);
    expect(tail).not.toMatch(/SELECT \*|SELECT data\b|SELECT uid|SELECT email/);
  });

  it("the probes check the write guard after apply: the critical row, every earlier rail, the trigger still bound, anon revoked", () => {
    const tail = tailOf(m137);
    expect(tail).toContain(`prosrc LIKE '%ARRAY[''ticket.manage'', ''ticket.force_close'', ''ticket.reassign_engineer'', ''checkout.force_release'', ''ai.manage_caps''] LOOP%'`);
    expect(tail).toContain("prosrc LIKE '%cannot be granted to yourself%'");
    expect(tail).toContain("JOIN pg_trigger t ON t.tgfoid = p.oid");
    expect(tail).toContain("t.tgname = 'trg_capability_policy_write_guard'");
    expect(tail).toContain("NOT has_function_privilege('anon', 'capability_policy_write_guard()', 'EXECUTE')");
    expect(m137).toMatch(/expect ok = true × 10/);
    // ten probes: each carries ok and a NULL n — the first names the column, the other nine repeat its cast
    expect((tail.match(/^\s+NULL::text( AS n)?$/gm) ?? []).length).toBe(10);
  });

  it("the pre-apply inventory counts what the app half changes: Doc Control losing cap-setting, and $0 caps that now lock", () => {
    expect(m137).toContain("they stop setting AI caps unless the policy console grants ai.manage_caps");
    expect(m137).toContain("WHERE user_id IS NOT NULL AND monthly_cap_usd = 0");
    expect(m137).toContain("WHERE user_id IS NULL AND monthly_cap_usd = 0");
  });
});

// ── the write guard ──────────────────────────────────────────────────────────
const G = "CREATE OR REPLACE FUNCTION capability_policy_write_guard(";
function guardBody(text: string): string {
  const a = text.indexOf(G);
  expect(a, "write guard not found").toBeGreaterThanOrEqual(0);
  return text.slice(a, text.indexOf("$$;", text.indexOf("AS $$", a) + 5) + 3);
}
const guardDefiners = numbered.filter((f) => f < FILE && read(f).includes(G));
const newestGuard = guardDefiners[guardDefiners.length - 1];
const guardPrev = guardBody(read(newestGuard));
const guard137 = guardBody(m137);
const criticalArray = (ids: string[]) => `    FOREACH v_cap IN ARRAY ARRAY[${ids.map((id) => `'${id}'`).join(", ")}] LOOP`;

describe("20261137 — capability_policy_write_guard learns that ai.manage_caps is critical (GOV-10)", () => {
  it("starts from the NEWEST earlier definition of the guard (found by scanning the sequence) — 20261056 at this package's base", () => {
    expect(newestGuard).toBeDefined();
    expect(guardDefiners).toContain("20261056_rp_roundE_capability_policy_write_guard.sql");
    // no later numbered file re-creates it after this one
    expect(numbered.filter((f) => f > FILE && read(f).includes(G))).toEqual([]);
  });

  it("is that body with exactly ONE line changed — the critical list gains 'ai.manage_caps' — nothing else added or removed", () => {
    const { onlyInA, onlyInB } = lineDiff(guardPrev, guard137);
    expect(onlyInA).toHaveLength(1);
    expect(onlyInB).toHaveLength(1);
    expect(onlyInA[0]).toMatch(/^    FOREACH v_cap IN ARRAY ARRAY\[.*\] LOOP$/);
    expect(onlyInB[0]).toBe(onlyInA[0].replace("] LOOP", ", 'ai.manage_caps'] LOOP"));
    expect(guard137.split("\n").length).toBe(guardPrev.split("\n").length);
    expect(guard137).toMatch(/RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
  });

  it("its critical list is CAPABILITY_DEFS critical: true, in order — the policy route, validateCapabilityPolicy and the guard read the same set", () => {
    const critical = CAPABILITY_DEFS.filter((d) => d.critical).map((d) => d.id);
    expect(critical).toContain("ai.manage_caps");
    expect(guard137).toContain(criticalArray(critical));
    // the rails it applies to every critical id: a change is Admin's; Admin (or '*') stays on every list
    expect(guard137).toMatch(/IF v_entry IS DISTINCT FROM v_old_entry AND NOT v_admin THEN\s*\n\s*RAISE EXCEPTION 'Only an Admin may change a critical capability/);
    expect(guard137).toContain("ELSIF NOT (v_entry ? 'Admin' OR v_entry ? '*') THEN");
  });

  it("DRLS-16: EXECUTE taken from PUBLIC and anon, restated for authenticated + service_role, inside the transaction after the guard", () => {
    const tx = between(m137, "\nBEGIN;", "\nCOMMIT;");
    const sig = "capability_policy_write_guard()";
    expect(tx).toContain(`REVOKE EXECUTE ON FUNCTION ${sig} FROM PUBLIC;`);
    expect(tx).toContain(`REVOKE EXECUTE ON FUNCTION ${sig} FROM anon;`);
    expect(tx).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated, service_role;`);
    expect(tx.indexOf(`REVOKE EXECUTE ON FUNCTION ${sig}`)).toBeGreaterThan(tx.indexOf(G));
    expect(tx.indexOf(G)).toBeGreaterThan(tx.indexOf(H));
  });
});
