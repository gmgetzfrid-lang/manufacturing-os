// intelligence Round G — I-28 DEFINER ORACLES (projects-and-cost INTK-19):
// shape pins on 20261224_intel_roundG_definer_oracles.sql, in the default
// suite (no database). The behaviour, per role before and after the paste,
// is proven on PostgreSQL 16 by lib/__tests__/rls/intelI28DefinerOracles.test.ts
// (`npm run test:db`).
//
//   * Every function the file re-creates starts from its NEWEST earlier
//     definition, found by scanning the folder at test time, and is that body
//     plus exactly the marked additions: cut them and it is byte-identical
//     (lineDiff keeps every earlier line, except the calls named here).
//   * The client binding is one predicate, written the same way in each bound
//     helper: the request's role (the role GUC PostgREST sets, or the JWT's
//     role claim) is anon or authenticated, and the uid is not auth.uid() —
//     then 42501. It never tests auth.uid() for NULL (DRLS-16's anon census,
//     dcHotfixAnonExecute.test.ts, reads that as a service pass).
//   * DRLS-16: both new SECURITY DEFINER functions pin search_path and are
//     revoked from PUBLIC and anon (effective_owner_matches from every client
//     role and the service role); org_capability_allows_for's REVOKE runs
//     only inside the live-database precondition.
//   * DEC-30: the apply-order check (a marker of every file it needs,
//     20261137's ai.manage_caps row and 20261136's quality_signoff_granted_for
//     included), then the counts-only inventory TEMP TABLE, before one
//     BEGIN … COMMIT; one final SELECT (check, ok, n).
//   * The header's paste facts: the holds it inherits from 20261159 and
//     20261199, and the never-re-paste rule (20261159, 20261199, 20261133 and
//     20261027 BREAK what it keeps working; the others only undo it).
//   * node_visible and every policy are untouched (DEC-90: intelligence I-30
//     re-creates node_visible once); effective_owner_matches names no
//     member_is_active, so 20261217's precondition holds in either order.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261224_intel_roundG_definer_oracles.sql";
const M = read(FILE);
const numbered = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();

/** The function from its CREATE header to the end of its dollar-quoted body. */
function fnBody(text: string, header: string): string {
  const a = text.indexOf(header);
  expect(a, `function not found: ${header}`).toBeGreaterThanOrEqual(0);
  return text.slice(a, text.indexOf("$$;", text.indexOf("AS $$", a) + 5) + 3);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
/** Remove the text from `from` up to (not including) `to`; `from` must occur once. */
function cut(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(from, a + 1), `marker not unique: ${from}`).toBe(-1);
  const b = text.indexOf(to, a + from.length);
  expect(b, `end marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(0, a) + text.slice(b);
}
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const codeOnly = (sql: string) => stripComments(sql).replace(/'(?:[^']|'')*'/g, "''");

/** The newest definition of `header` in a file before this one (the folder is scanned now). */
function newestBefore(header: string): { file: string; body: string } {
  const definers = numbered.filter((f) => f < FILE && stripComments(read(f)).includes(header));
  expect(definers.length, `no earlier definition of ${header}`).toBeGreaterThan(0);
  const file = definers[definers.length - 1];
  return { file, body: fnBody(read(file), header) };
}

const CLIENT = `(current_setting('role', true) IN ('anon', 'authenticated')
          OR COALESCE(auth.role(), '') IN ('anon', 'authenticated'))`;

describe("20261224 — every re-created function starts from its NEWEST earlier body (lineDiff; the folder is scanned now)", () => {
  it("user_can_publish_on_library: 20261059's body plus the client binding — cut it and it is byte-identical", () => {
    const H = "CREATE OR REPLACE FUNCTION user_can_publish_on_library(";
    const base = newestBefore(H);
    expect(base.file).toBe("20261059_rp_roundE_org_subject_publish.sql");
    const next = fnBody(M, H);
    expect(lineDiff(base.body, next).onlyInA).toEqual([]);
    expect(cut(next, "\n  -- INTK-19 (20261224): a client role (the anon key, or a signed-in\n", "\n  -- The member's FULL role collection")).toBe(base.body);
    expect(next).toContain(`  IF p_uid IS DISTINCT FROM auth.uid()::text\n     AND ${CLIENT} THEN\n    RAISE EXCEPTION 'user_can_publish_on_library answers a client only about the signed-in caller (INTK-19).'\n      USING ERRCODE = '42501';`);
    // the binding sits after the NULL check: anon's NULL uid is answered false as before
    expect(next.indexOf("IF p_library IS NULL OR p_uid IS NULL OR p_org IS NULL THEN")).toBeLessThan(next.indexOf("IF p_uid IS DISTINCT FROM auth.uid()::text"));
  });

  it("user_is_effective_owner: 20261042's walk plus the client binding and the no-workspace rule; still four membership tests, all naming member_is_active", () => {
    const H = "CREATE OR REPLACE FUNCTION user_is_effective_owner(";
    const base = newestBefore(H);
    expect(base.file).toBe("20261042_rp_phase6_revocation_and_succession.sql");
    const next = fnBody(M, H);
    expect(lineDiff(base.body, next).onlyInA).toEqual([]);
    let s = next;
    s = cut(s, "  -- INTK-19 (20261224): the request's role, not the function's owner.\n", "BEGIN\n");
    s = cut(s, "\n  -- INTK-19 (20261224): a client role (the anon key, or a signed-in\n", "\n  -- The org is the library's");
    s = cut(s, "\n  -- INTK-19 (20261224): for a client role, no workspace means no owner.\n", "\n  -- GAP-5 / OWN-12");
    expect(s).toBe(base.body);
    expect(next).toContain("  v_client boolean := current_setting('role', true) IN ('anon', 'authenticated')\n                      OR COALESCE(auth.role(), '') IN ('anon', 'authenticated');");
    expect(next).toContain("  IF v_client AND p_uid IS DISTINCT FROM auth.uid() THEN\n    RAISE EXCEPTION 'user_is_effective_owner answers a client only about the signed-in caller (INTK-19).'\n      USING ERRCODE = '42501';");
    expect(next).toContain("  IF v_client AND v_org IS NULL THEN\n    RETURN false;\n  END IF;");
    // 20261042's own probe counts four member_is_active( calls; the comments add none
    expect(next.split("member_is_active(").length - 1).toBe(4);
    // the binding comes after the NULL uid check, the workspace rule after the library is read
    expect(next.indexOf("IF p_uid IS NULL THEN RETURN false; END IF;")).toBeLessThan(next.indexOf("IF v_client AND p_uid IS DISTINCT FROM auth.uid() THEN"));
    expect(next.indexOf("SELECT org_id INTO v_org FROM libraries WHERE id = p_library;")).toBeLessThan(next.indexOf("IF v_client AND v_org IS NULL THEN"));
  });

  it("effective_owner_matches: the same walk (20261042's body) under its own name, the four membership tests written inline as member_is_active's EXISTS", () => {
    const base = newestBefore("CREATE OR REPLACE FUNCTION user_is_effective_owner(").body;
    const twin = fnBody(M, "CREATE OR REPLACE FUNCTION effective_owner_matches(");
    expect(twin).not.toMatch(/member_is_active/);
    const back = twin
      .replace("CREATE OR REPLACE FUNCTION effective_owner_matches(", "CREATE OR REPLACE FUNCTION user_is_effective_owner(")
      .replace("  IF p_doc_owner IS NOT NULL\n     AND EXISTS (SELECT 1 FROM org_members m WHERE m.uid = p_doc_owner AND m.status = 'active' AND (v_org IS NULL OR m.org_id = v_org)) THEN\n",
        "  IF p_doc_owner IS NOT NULL AND member_is_active(v_org, p_doc_owner) THEN\n")
      .split("EXISTS (SELECT 1 FROM org_members m WHERE m.uid = v_owner AND m.status = 'active' AND (v_org IS NULL OR m.org_id = v_org)) THEN RETURN v_owner = p_uid; END IF;")
      .join("member_is_active(v_org, v_owner) THEN RETURN v_owner = p_uid; END IF;");
    expect(back).toBe(base);
    // member_is_active's own body is that EXISTS (20261042)
    expect(read("20261042_rp_phase6_revocation_and_succession.sql")).toMatch(/SELECT 1 FROM org_members\s+WHERE uid = p_uid AND status = 'active' AND \(p_org IS NULL OR org_id = p_org\)/);
  });

  it("review_signoff_owner_stamp: 20261159's body with the one candidate call renamed (and a comment) — the stamp's outcomes are untouched", () => {
    const H = "CREATE OR REPLACE FUNCTION review_signoff_owner_stamp()";
    const base = newestBefore(H);
    expect(base.file).toBe("20261159_dc_roundF_guard_owner_and_held_pointer.sql");
    const next = fnBody(M, H);
    const { onlyInA, onlyInB } = lineDiff(base.body, next);
    expect(onlyInA).toEqual(["     AND user_is_effective_owner(v_doc_owner, v_collection, v_library, c.uid)"]);
    expect(onlyInB).toEqual([
      "  -- INTK-19 (20261224): asked through effective_owner_matches, the same walk",
      "  -- for definer code: this signed-in INSERT asks about candidates other than",
      "  -- the caller, which user_is_effective_owner now refuses to a client role.",
      "     AND effective_owner_matches(v_doc_owner, v_collection, v_library, c.uid)",
    ]);
    expect(M).toContain("REVOKE ALL ON FUNCTION review_signoff_owner_stamp() FROM PUBLIC, anon, authenticated, service_role;");
    // the trigger is not re-created (CREATE OR REPLACE keeps the function it runs)
    expect(codeOnly(M)).not.toMatch(/CREATE TRIGGER/);
  });

  it("org_capability_allows: 20261052's one-line body plus the client binding", () => {
    const H = "CREATE OR REPLACE FUNCTION org_capability_allows(";
    const base = newestBefore(H);
    expect(base.file).toBe("20261052_rp_phase7_capability_resource_dimension.sql");
    const next = fnBody(M, H);
    expect(lineDiff(base.body, next).onlyInA).toEqual([]);
    expect(cut(next, "  -- INTK-19 (20261224): a client role (the anon key, or a signed-in\n", "  RETURN org_capability_allows_for(")).toBe(base.body);
    expect(next).toContain(`  IF p_uid IS DISTINCT FROM auth.uid()\n     AND ${CLIENT} THEN\n    RAISE EXCEPTION 'org_capability_allows answers a client only about the signed-in caller (INTK-19).'\n      USING ERRCODE = '42501';`);
  });

  it("acl_index_denies: 20261025's body plus the client binding", () => {
    const H = "CREATE OR REPLACE FUNCTION acl_index_denies(";
    const base = newestBefore(H);
    expect(base.file).toBe("20261025_fix_capability_and_deny_column_typos.sql");
    const next = fnBody(M, H);
    expect(lineDiff(base.body, next).onlyInA).toEqual([]);
    expect(cut(next, "  -- INTK-19 (20261224): a client role (the anon key, or a signed-in\n", "  IF p_idx->'deny'->'users'->p_action ? p_uid::text THEN RETURN TRUE; END IF;")).toBe(base.body);
    expect(next).toContain(`  IF p_uid IS DISTINCT FROM auth.uid()\n     AND ${CLIENT} THEN\n    RAISE EXCEPTION 'acl_index_denies answers a client only about the signed-in caller (INTK-19).'\n      USING ERRCODE = '42501';`);
  });

  it("project_org: 20260913's one SELECT, caller-scoped (the only removed line)", () => {
    const H = "CREATE OR REPLACE FUNCTION project_org(";
    const base = newestBefore(H);
    expect(base.file).toBe("20260913_projects_rls_recursion_fix.sql");
    const next = fnBody(M, H);
    const { onlyInA } = lineDiff(base.body, next);
    expect(onlyInA).toEqual(["  SELECT org_id FROM projects WHERE id = p_project;"]);
    expect(next).toContain("RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$");
    expect(next).toContain(`  SELECT p.org_id FROM projects p
   WHERE p.id = p_project
     AND (NOT (current_setting('role', true) IN ('anon', 'authenticated')
               OR COALESCE(auth.role(), '') IN ('anon', 'authenticated'))
          OR EXISTS (SELECT 1 FROM org_members m
                      WHERE m.org_id = p.org_id AND m.uid = auth.uid() AND m.status = 'active'));`);
  });

  it("transmittals_guard: 20261199's body with its two TRX-1 calls asked as the caller (and a comment); still SECURITY INVOKER", () => {
    const H = "CREATE OR REPLACE FUNCTION transmittals_guard()";
    const base = newestBefore(H);
    expect(base.file).toBe("20261199_dc_roundF_transmittal_issue_verdict.sql");
    const next = fnBody(M, H);
    const { onlyInA, onlyInB } = lineDiff(base.body, next);
    expect(onlyInA).toEqual([
      "          IF NOT org_capability_allows_for(NEW.org_id, 'transmittal.issue', v_uid, '{}'::jsonb) THEN",
      "            IF NOT org_capability_allows_for(NEW.org_id, 'transmittal.issue', v_uid,",
    ]);
    expect(onlyInB).toEqual([
      "      -- INTK-19 (20261224): asked as the caller (caller_capability_allows;",
      "      -- v_uid is auth.uid() here), now that the uid-taking form is the",
      "      -- service role's and the definers' alone.",
      "          IF NOT caller_capability_allows(NEW.org_id, 'transmittal.issue', '{}'::jsonb) THEN",
      "            IF NOT caller_capability_allows(NEW.org_id, 'transmittal.issue',",
    ]);
    expect(next).toMatch(/^CREATE OR REPLACE FUNCTION transmittals_guard\(\)\nRETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS \$\$/);
    // v_uid is auth.uid() and never reassigned; both calls sit inside IF v_uid IS NOT NULL
    expect(next).toContain("  v_uid uuid := auth.uid();");
    expect(next.match(/\bv_uid\s*:=/g)).toBeNull();
    const trx1 = next.slice(next.indexOf("    IF v_uid IS NOT NULL THEN\n      -- ── TRX-4"), next.indexOf("  -- ── TRX-3 / TRX-8 / TRX-12"));
    expect(trx1.match(/caller_capability_allows\(/g)).toHaveLength(2);
  });

  it("caller_capability_allows: org_capability_allows_for for auth.uid() only", () => {
    const f = fnBody(M, "CREATE OR REPLACE FUNCTION caller_capability_allows(");
    expect(f).toBe(`CREATE OR REPLACE FUNCTION caller_capability_allows(p_org uuid, p_cap text, p_resource jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_capability_allows_for(p_org, p_cap, auth.uid(), p_resource);
$$;`);
  });
});

describe("20261224 — what it creates and re-creates, and nothing else (DEC-31)", () => {
  it("nine functions: seven re-created from their newest bodies, two new; no policy, no trigger, no node_visible", () => {
    expect([...codeOnly(M).matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((m) => m[1])).toEqual([
      "user_can_publish_on_library", "user_is_effective_owner", "effective_owner_matches", "review_signoff_owner_stamp",
      "org_capability_allows", "acl_index_denies", "project_org", "caller_capability_allows", "transmittals_guard",
    ]);
    expect(codeOnly(M)).not.toMatch(/CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY|CREATE\s+TRIGGER|DROP\s+TRIGGER|FUNCTION node_visible/i);
    // the two new names are new (no earlier file defines them)
    for (const f of numbered.filter((x) => x < FILE)) {
      expect(stripComments(read(f)), f).not.toMatch(/\b(effective_owner_matches|caller_capability_allows)\b/);
    }
    // no later file re-creates any of them (a later re-creation starts from this body and updates this pin)
    for (const f of numbered.filter((x) => x > FILE)) {
      expect(stripComments(read(f)), f).not.toMatch(/CREATE OR REPLACE FUNCTION (user_can_publish_on_library|user_is_effective_owner|effective_owner_matches|review_signoff_owner_stamp|org_capability_allows|acl_index_denies|project_org|caller_capability_allows|transmittals_guard)\(/);
    }
  });

  it("the four bound helpers share one client predicate, never test auth.uid() for NULL, and refuse with 42501", () => {
    const bound = ["user_can_publish_on_library", "user_is_effective_owner", "org_capability_allows", "acl_index_denies"].map((n) => fnBody(M, `CREATE OR REPLACE FUNCTION ${n}(`));
    for (const b of bound) {
      expect(b).toMatch(/current_setting\('role', true\) IN \('anon', 'authenticated'\)\s+OR COALESCE\(auth\.role\(\), ''\) IN \('anon', 'authenticated'\)/);
      expect(b).not.toMatch(/auth\.uid\(\)\s+IS\s+(NOT\s+)?NULL/i);
      expect(b).toMatch(/answers a client only about the signed-in caller \(INTK-19\)\.'\n\s+USING ERRCODE = '42501';/);
    }
    // project_org reads the session through membership only, never a NULL test
    expect(fnBody(M, "CREATE OR REPLACE FUNCTION project_org(")).not.toMatch(/auth\.uid\(\)\s+IS\s+(NOT\s+)?NULL/i);
  });

  it("DRLS-16: every SECURITY DEFINER function it creates pins search_path; the new ones are revoked from PUBLIC and anon and granted narrowly", () => {
    for (const m of codeOnly(M).matchAll(/CREATE OR REPLACE FUNCTION (\w+)\([^)]*\)\s*RETURNS[^$]*?AS \$\$/g)) {
      if (/SECURITY DEFINER/.test(m[0])) expect(m[0], m[1]).toMatch(/SET search_path = public/);
    }
    expect(M).toContain("REVOKE ALL ON FUNCTION effective_owner_matches(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;");
    expect(M).toContain("REVOKE ALL ON FUNCTION caller_capability_allows(uuid, text, jsonb) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION caller_capability_allows(uuid, text, jsonb) TO authenticated, service_role;");
    // no grant on a re-created policy helper changes (CREATE OR REPLACE keeps them)
    for (const n of ["user_can_publish_on_library", "user_is_effective_owner", "org_capability_allows", "acl_index_denies", "project_org", "transmittals_guard"]) {
      expect(codeOnly(M), n).not.toMatch(new RegExp(`(GRANT|REVOKE)[^;]*FUNCTION ${n}\\(`));
    }
  });

  it("org_capability_allows_for's REVOKE runs only inside the live-database precondition, paired with service_role's GRANT", () => {
    const body = M.slice(M.search(/^BEGIN;/m), M.search(/^COMMIT;/m));
    const gate = body.slice(body.indexOf("DO $grants$"), body.indexOf("$grants$;"));
    expect(gate).toMatch(/SELECT COALESCE\(SUM\(n\), 0\) INTO v_blockers FROM intel_i28_20261224_inventory WHERE pre;\s+IF v_blockers = 0 THEN\s+REVOKE ALL ON FUNCTION org_capability_allows_for\(uuid, text, uuid, jsonb\) FROM PUBLIC, anon, authenticated;\s+GRANT EXECUTE ON FUNCTION org_capability_allows_for\(uuid, text, uuid, jsonb\) TO service_role;\s+ELSE\s+RAISE NOTICE '20261224 left org_capability_allows_for executable/);
    expect(codeOnly(body).match(/REVOKE[^;]*org_capability_allows_for/g)).toHaveLength(1);
    // the four precondition rows: policies, views/defaults/CHECKs/triggers, other invoker functions, definers that would lose the call
    const inventory = M.slice(M.indexOf("CREATE TEMP TABLE intel_i28_20261224_inventory"), M.search(/^BEGIN;/m));
    expect(inventory).toContain("SELECT 75, 'precondition (expect 0): SECURITY INVOKER functions other than transmittals_guard whose body names org_capability_allows_for(', COUNT(*), true");
    expect(inventory).toContain("SELECT 76, 'precondition (expect 0): SECURITY DEFINER functions naming org_capability_allows_for( owned by a role that is neither its owner nor a superuser (they would lose the call)', COUNT(*), true");
    expect(inventory.match(/h\.name = 'org_capability_allows_for'\n {2}FROM h/g)).toHaveLength(2);
  });

  it("20261217 holds in either order: only user_is_effective_owner names member_is_active, and it stays SECURITY DEFINER", () => {
    for (const m of codeOnly(M).matchAll(/CREATE OR REPLACE FUNCTION (\w+)\([\s\S]*?\$\$;/g)) {
      if (m[1] !== "user_is_effective_owner") expect(m[0], m[1]).not.toMatch(/\bmember_is_active\s*\(/);
    }
    expect(fnBody(M, "CREATE OR REPLACE FUNCTION user_is_effective_owner(")).toContain("STABLE SECURITY DEFINER SET search_path = public");
  });
});

describe("20261224 — the one-paste shape (DEC-30)", () => {
  it("apply-order check → counts-only inventory TEMP TABLE → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const code = stripComments(M);
    const order = code.indexOf("RAISE EXCEPTION '20261224 needs 20260913, 20261025, 20261042, 20261052, 20261059, 20261136, 20261137, 20261159 and 20261199 pasted first; nothing was changed.';");
    const temp = code.indexOf("CREATE TEMP TABLE intel_i28_20261224_inventory");
    const begin = code.search(/^BEGIN;/m);
    const commit = code.search(/^COMMIT;/m);
    expect(order).toBeGreaterThan(0);
    expect(order).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(code.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;/gm)).toHaveLength(1);
    const tail = code.slice(commit + "COMMIT;".length).trim();
    expect(tail.startsWith("SELECT")).toBe(true);
    expect(tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((s) => s.trim()).length).toBe(1);
    expect(tail).toContain('AS "check"');
    expect(tail).toMatch(/AS ok,\s+NULL::text AS n/);
    // the inventory reads the catalog only — never a customer table
    const inventory = code.slice(temp, begin);
    expect(inventory).not.toMatch(/FROM\s+(public\.)?(documents|org_members|orgs|users|projects|libraries|transmittals|assets)\b/i);
    expect(inventory).toMatch(/COUNT\(\*\)/);
  });

  it("the final SELECT: 13 probes, 2 after-counts, then the inventory in order (44 rows, as the header says)", () => {
    const tail = M.slice(M.search(/^COMMIT;/m));
    const probes = [...tail.matchAll(/^SELECT '([^']|'')+'(::text AS "check")?,\n\s+\(/gm)];
    expect(probes).toHaveLength(13);
    expect(tail.match(/^SELECT 'after: /gm)).toHaveLength(2);
    expect(tail).toContain("SELECT check_name, NULL, n::text FROM (SELECT check_name, n FROM intel_i28_20261224_inventory ORDER BY ord) i;");
    // 6 helpers x 4 counts, then rows 75, 76, 77, 81, 82
    const inv = M.slice(M.indexOf("INSERT INTO intel_i28_20261224_inventory"), M.search(/^BEGIN;/m));
    expect(inv.match(/^SELECT h\.k \* 10 \+ [1-4],/gm)).toHaveLength(4);
    expect(inv.match(/^ {2}FROM h$/gm)).toHaveLength(4);
    expect([...inv.matchAll(/^SELECT (\d+), '/gm)].map((m) => m[1])).toEqual(["75", "76", "77", "81", "82"]);
    expect(M).toContain("EXPECTED RESULT (one result set, 44 rows): 13 probes with ok = true");
  });

  it("the apply-order check reads a marker of every file it needs, 20261137 and 20261136 included (each ends by granting authenticated the evaluator)", () => {
    const check = M.slice(M.indexOf("-- ── 0. apply order"), M.indexOf("-- ── 1. pre-apply inventory"));
    // 20261137: the ai.manage_caps row of the evaluator (its signature alone has existed since 20261052)
    expect(check).toContain("OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.org_capability_allows_for(uuid,text,uuid,jsonb)') AND prosrc LIKE '%WHEN ''ai.manage_caps''%')");
    expect(check).not.toMatch(/OR to_regprocedure\('public\.org_capability_allows_for/);
    // 20261136: quality_signoff_granted_for, which no other file creates
    expect(check).toContain("OR to_regprocedure('public.quality_signoff_granted_for(uuid,uuid,uuid)') IS NULL");
    const evaluatorRow = /WHEN 'ai\.manage_caps'/;
    expect(fnBody(read("20261137_intel_roundG_ai_manage_caps.sql"), "CREATE OR REPLACE FUNCTION org_capability_allows_for(")).toMatch(evaluatorRow);
    for (const f of numbered.filter((x) => x < "20261137")) expect(stripComments(read(f)), f).not.toMatch(evaluatorRow);
    expect(numbered.filter((f) => f < FILE && /CREATE OR REPLACE FUNCTION quality_signoff_granted_for\(/.test(stripComments(read(f))))).toEqual(["20261136_prj_roundG_quality_signoff.sql"]);
    // both files grant authenticated the evaluator: neither may come after this file
    expect(read("20261136_prj_roundG_quality_signoff.sql")).toContain("GRANT EXECUTE ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) TO authenticated, service_role;");
    expect(read("20261137_intel_roundG_ai_manage_caps.sql")).toContain("GRANT EXECUTE ON FUNCTION org_capability_allows_for(UUID, TEXT, UUID, JSONB) TO authenticated, service_role;");
  });

  it("the header states the paste facts: order, the inherited holds, independence of 20261217 and 20261212, no deploy gate of its own, the never-re-paste rule, the rollback", () => {
    const header = M.slice(0, M.indexOf("-- ── 0. apply order"));
    const flat = header.replace(/\n--\s*/g, " ");
    expect(header).toContain("--   ORDER: after 20261199, 20261159, 20261137 and 20261136, and after the");
    expect(flat).toContain("Independent of 20261217 and 20261212 (either order).");
    expect(flat).toContain("HOLDS: inherits the holds of 20261159 (the Intake force deployed, projects-and-cost INTK-18) and 20261199 (the app carrying document-control P24 deployed). Paste only after both are lifted and pasted. Until then the apply-order check refuses and changes nothing.");
    expect(flat).toContain("DEPLOY GATE: none of its own.");
    expect(flat).not.toMatch(/DEPLOY GATE: none\. /);
    // the re-pastes that BREAK what this file keeps working (INTK-19 review fix pass)
    expect(header).toContain("--   ⚠ NEVER RE-PASTE 20261159, 20261199, 20261133 OR 20261027 AFTER THIS FILE.");
    expect(flat).toContain("Re-pasting 20261199 or 20261133 puts back a transmittals_guard that asks org_capability_allows_for as the signed-in member: it BREAKS every transmit authority's issue, void and revoke (42501, permission denied for function org_capability_allows_for).");
    expect(flat).toContain("Re-pasting 20261159 puts back a review_signoff_owner_stamp that asks user_is_effective_owner about other candidates: it BREAKS signed-in roster opening on a document whose review control needs the owner (42501 from user_is_effective_owner).");
    expect(flat).toContain("Each stays broken until this file is pasted again in the same sitting. After 20261133, paste 20261199 first: this file's apply-order check refuses over 20261133's older guard.");
    // the re-pastes that only revert
    expect(flat).toContain("Re-pasting 20261059, 20261042, 20261052, 20261025 or 20260913 only puts that function's earlier, unbound body back, and re-pasting 20261137 (or 20261136) only gives authenticated org_capability_allows_for back: each undoes this file for that function and breaks nothing this file changed; re-paste this file after it.");
    // "undoes" is never said of the files that break
    const reverts = flat.slice(flat.indexOf("Re-pasting 20261059"), flat.indexOf("re-paste this file after it.", flat.indexOf("Re-pasting 20261059")));
    for (const f of ["20261159", "20261199", "20261133", "20261027"]) expect(reverts, f).not.toContain(f);
    // the facts behind the rule: those files' bodies ask the narrowed helpers
    expect(fnBody(read("20261199_dc_roundF_transmittal_issue_verdict.sql"), "CREATE OR REPLACE FUNCTION transmittals_guard()")).toContain("org_capability_allows_for(NEW.org_id, 'transmittal.issue', v_uid");
    expect(fnBody(read("20261133_dc_roundF_transmittal_rails.sql"), "CREATE OR REPLACE FUNCTION transmittals_guard()")).toContain("org_capability_allows_for(NEW.org_id, 'transmittal.issue', v_uid");
    expect(fnBody(read("20261159_dc_roundF_guard_owner_and_held_pointer.sql"), "CREATE OR REPLACE FUNCTION review_signoff_owner_stamp()")).toContain("user_is_effective_owner(v_doc_owner, v_collection, v_library, c.uid)");
    expect(fnBody(read("20261027_dc_phase1_unguarded_doors.sql"), "CREATE OR REPLACE FUNCTION transmittals_guard()")).not.toMatch(/org_capability_allows/);
    expect(M).toMatch(/^--\s+GRANT EXECUTE ON FUNCTION public\.org_capability_allows_for\(uuid, text, uuid, jsonb\) TO authenticated;$/m);
    // the size the harness sends as one message (psql -c), with room to spare
    expect(Buffer.byteLength(M)).toBeLessThan(120_000);
  });
});
