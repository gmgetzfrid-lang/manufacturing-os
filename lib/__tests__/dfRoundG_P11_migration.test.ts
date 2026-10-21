// drafting-flow Round G, DF-P11 AFTER-DC — 20261239_df_roundG_holds_release_grant_scope.sql.
//
//   * org_capability_allows_for re-created from its NEWEST earlier body (the
//     folder is scanned now, so a parallel re-creation folded in at merge is
//     found) with exactly two changes: the holds.release CASE row
//     (drafting-flow HAND-2: ["*"] → the controller tier plus the hold's
//     opener token, "$opener") and the grant loop's project scope
//     (projects-and-cost QUAL-14 done-when 2);
//   * hold_opener_may_update — the opener leg, honoured only while the org's
//     holds.release list names "$opener" (fix pass 2: a stored narrower
//     list decides as written), and the document_holds UPDATE policy that
//     calls it;
//   * enforce_distribution_ack_guard re-created from its newest earlier body
//     with the EVID-2 additions only (no withdrawal / re-dating of a recorded
//     acknowledgment; requested_at bound to the requester or a controller,
//     never earlier; requested_by immutable);
//   * capability_grant_scope_ready() — the route's probe;
//   * DEC-30's one-paste shape and DRLS-16's grants (the ack guard's EXECUTE
//     taken from PUBLIC / anon / authenticated — fix pass 2).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITY_DEFS, HOLD_OPENER_TOKEN } from "@/lib/capabilityPolicy";

const dir = join(process.cwd(), "supabase", "migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261239_df_roundG_holds_release_grant_scope.sql";
const M = read(FILE);
const numbered = readdirSync(dir).filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql")).sort();

const EV = "CREATE OR REPLACE FUNCTION org_capability_allows_for(";
const GD = "CREATE OR REPLACE FUNCTION enforce_distribution_ack_guard(";
function fnBody(text: string, header: string): string {
  const a = text.indexOf(header);
  expect(a, `${header} not found`).toBeGreaterThanOrEqual(0);
  return text.slice(a, text.indexOf("$$;", text.indexOf("AS $$", a) + 5) + 3);
}
function newestBefore(header: string): { file: string; body: string } {
  const files = numbered.filter((f) => f < FILE && read(f).includes(header));
  const file = files[files.length - 1];
  return { file, body: fnBody(read(file), header) };
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const caseMap = (fn: string) => {
  const from = fn.indexOf("v_tokens := CASE p_cap");
  const block = fn.slice(from, fn.indexOf("END;", from));
  const out = new Map<string, string[]>();
  for (const m of block.matchAll(/WHEN '([^']+)'\s+THEN '(\[[^\]]*\])'::jsonb/g)) out.set(m[1], JSON.parse(m[2]) as string[]);
  return out;
};
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const codeOnly = (sql: string) => stripComments(sql).replace(/'(?:[^']|'')*'/g, "''");

describe("20261239 — org_capability_allows_for: the holds.release default and a grant's project (HAND-2, QUAL-14)", () => {
  const base = newestBefore(EV);
  const mine = fnBody(M, EV);

  it("starts from the newest earlier body (20261137 on this base; 20261224 changed only its grant)", () => {
    expect(base.file).toBeDefined();
    expect(base.file).toBe("20261137_intel_roundG_ai_manage_caps.sql");
    expect(mine).toMatch(/org_capability_allows_for\(p_org UUID, p_cap TEXT, p_uid UUID, p_resource JSONB\)\s*\nRETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public/);
  });

  it("is that body with exactly the two changes — nothing else removed or added", () => {
    const { onlyInA, onlyInB } = lineDiff(base.body, mine);
    expect(onlyInA).toEqual([
      `      WHEN 'holds.release'            THEN '["*"]'::jsonb`,
      `              OR (v_grant->>'expiresAt')::timestamptz > NOW()) THEN`,
    ]);
    expect(onlyInB).toEqual([
      `      WHEN 'holds.release'            THEN '["Admin","DocCtrl","$opener"]'::jsonb`,
      `              OR (v_grant->>'expiresAt')::timestamptz > NOW())`,
      `         -- QUAL-14 (20261239): a grant that names a project holds on that project only.`,
      `         AND (COALESCE(v_grant->>'projectId', '') = ''`,
      `              OR v_grant->>'projectId' = p_resource->>'projectId') THEN`,
    ]);
  });

  it("the CASE mirrors CAPABILITY_DEFS exactly — holds.release defaults to Admin and DocCtrl (checkout.force_release's tier) plus the opener token", () => {
    const sql = caseMap(mine);
    for (const d of CAPABILITY_DEFS) expect(sql.get(d.id), d.id).toEqual(d.defaultRoles);
    expect(sql.size).toBe(CAPABILITY_DEFS.length);
    expect(HOLD_OPENER_TOKEN).toBe("$opener");
    expect(sql.get("holds.release")).toEqual(["Admin", "DocCtrl", HOLD_OPENER_TOKEN]);
    expect(sql.get("holds.release")!.filter((t) => t !== HOLD_OPENER_TOKEN)).toEqual(sql.get("checkout.force_release"));
    // the token is on holds.release alone
    for (const [cap, toks] of sql) if (cap !== "holds.release") expect(toks, cap).not.toContain(HOLD_OPENER_TOKEN);
    // holds.open is unchanged: anyone may still PLACE a hold
    expect(sql.get("holds.open")).toEqual(["*"]);
  });

  it("DRLS-16: EXECUTE is taken from PUBLIC and anon, from authenticated only where 20261224 already took it, and granted to service_role alone", () => {
    const tx = M.slice(M.indexOf("\nBEGIN;"), M.indexOf("\nCOMMIT;"));
    expect(tx).toContain("REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM PUBLIC, anon;");
    expect(tx).toContain("IF EXISTS (SELECT 1 FROM df_p11_20261239_inventory WHERE ord = 8 AND n = 0) THEN\n    REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM authenticated;");
    expect(tx).toContain("GRANT EXECUTE ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) TO service_role;");
    expect(codeOnly(M)).not.toMatch(/GRANT[^;]*org_capability_allows_for[^;]*TO[^;]*\b(authenticated|anon|PUBLIC)\b/i);
  });
});

describe("20261239 — enforce_distribution_ack_guard: a one-way acknowledgment, a bounded request time (EVID-2)", () => {
  const base = newestBefore(GD);
  const mine = fnBody(M, GD);

  it("starts from the newest earlier body (20261033)", () => {
    expect(base.file).toBe("20261033_dc_phase7b_guard_patches.sql");
    expect(mine).toMatch(/RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
  });

  it("is that body plus the EVID-2 lines — the only line changed is the identity list's last line", () => {
    const { onlyInA, onlyInB } = lineDiff(base.body, mine);
    expect(onlyInA).toEqual(["     OR NEW.org_id          IS DISTINCT FROM OLD.org_id THEN"]);
    expect(onlyInB).toContain("     OR NEW.org_id          IS DISTINCT FROM OLD.org_id");
    expect(onlyInB).toContain("     OR NEW.requested_by    IS DISTINCT FROM OLD.requested_by THEN");
    expect(onlyInB).toContain("    IF OLD.acknowledged_at IS NOT NULL THEN");
    expect(onlyInB).toContain("      RAISE EXCEPTION 'A recorded acknowledgment cannot be withdrawn or re-dated.'");
    expect(onlyInB).toContain("  IF NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN");
    expect(onlyInB).toContain("    IF NOT (OLD.requested_by::text = auth.uid()::text OR is_org_controller(OLD.org_id)) THEN");
    expect(onlyInB).toContain("    IF NEW.requested_at < OLD.requested_at THEN");
    // everything the base did is still there, in order
    for (const l of base.body.split("\n").filter((x) => x !== "     OR NEW.org_id          IS DISTINCT FROM OLD.org_id THEN")) {
      expect(mine.split("\n"), l).toContain(l);
    }
    // the service role (auth.uid() NULL) still returns first
    expect(mine.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;")).toBeLessThan(mine.indexOf("acknowledged_at IS NOT NULL"));
    // the withdrawal check runs before the recipient check, inside the transition branch
    const branch = mine.indexOf("IF NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN");
    expect(mine.indexOf("IF OLD.acknowledged_at IS NOT NULL THEN")).toBeGreaterThan(branch);
    expect(mine.indexOf("IF OLD.acknowledged_at IS NOT NULL THEN")).toBeLessThan(mine.indexOf("Only the named recipient can acknowledge"));
  });

  it("does not touch the trigger binding", () => {
    expect(stripComments(M)).not.toMatch(/CREATE TRIGGER|DROP TRIGGER|DROP FUNCTION/);
  });

  it("DRLS-16 (fix pass 2): EXECUTE on the re-created guard is taken from PUBLIC and every client role, inside the transaction, and probe 110 checks it", () => {
    const tx = M.slice(M.indexOf("\nBEGIN;"), M.indexOf("\nCOMMIT;"));
    expect(tx).toContain("REVOKE ALL ON FUNCTION enforce_distribution_ack_guard() FROM PUBLIC, anon, authenticated;");
    expect(tx.indexOf("REVOKE ALL ON FUNCTION enforce_distribution_ack_guard()")).toBeGreaterThan(tx.indexOf(GD));
    expect(codeOnly(M)).not.toMatch(/GRANT[^;]*enforce_distribution_ack_guard/i);
    expect(M).toContain("AND NOT has_function_privilege('anon', 'public.enforce_distribution_ack_guard()', 'EXECUTE')");
    expect(M).toContain("AND NOT has_function_privilege('authenticated', 'public.enforce_distribution_ack_guard()', 'EXECUTE'), NULL");
  });
});

describe("20261239 — document_holds_update: holds.release, or the opener leg while the list names \"$opener\" (HAND-2 review fix passes)", () => {
  const POL = "CREATE POLICY document_holds_update ON document_holds";
  const polOf = (text: string) => {
    const a = text.indexOf(POL);
    expect(a, `${POL} not found`).toBeGreaterThanOrEqual(0);
    return text.slice(a, text.indexOf("\n);", a) + 3);
  };
  const files = numbered.filter((f) => f < FILE && read(f).includes(POL));
  const baseFile = files[files.length - 1];
  const base = polOf(read(baseFile));
  const mine = polOf(M);

  it("starts from the newest earlier definition (20260901 on this base)", () => {
    expect(baseFile).toBe("20260901_db_hard_enforcement.sql");
  });

  it("is that body with exactly the opener leg added to USING and WITH CHECK, scoped TO authenticated (fix pass 3) — the 3-argument capability call kept", () => {
    const { onlyInA, onlyInB } = lineDiff(base, mine);
    expect(onlyInA).toEqual(["CREATE POLICY document_holds_update ON document_holds FOR UPDATE USING ("]);
    const leg = ["  OR hold_opener_may_update(org_id, opened_by)"];
    expect(onlyInB).toEqual(["CREATE POLICY document_holds_update ON document_holds FOR UPDATE TO authenticated USING (", ...leg, ...leg]);
    // fix pass 2: no unconditional `opened_by = auth.uid()` leg — the opener
    // is admitted only through the function that reads the org's list
    expect(mine).not.toMatch(/opened_by = auth\.uid\(\)/);
    expect((mine.match(/org_capability_allows\(org_id, 'holds\.release', auth\.uid\(\)\)/g) ?? []).length).toBe(2);
    // dropped and created inside the one transaction
    const tx = M.slice(M.indexOf("\nBEGIN;"), M.indexOf("\nCOMMIT;"));
    expect(tx).toContain("DROP POLICY IF EXISTS document_holds_update ON document_holds;");
    expect(tx).toContain(POL);
    // the apply-order check refuses a database without the policy
    expect(M).toContain("OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_holds' AND policyname = 'document_holds_update')");
  });

  it("probe 111 reads the deparsed policy with patterns a deparse can produce (no bare casts in LIKE)", () => {
    expect(M).toContain("COALESCE(qual, '') LIKE '%hold_opener_may_update(org_id, opened_by)%'");
    expect(M).toContain("COALESCE(with_check, '') LIKE '%hold_opener_may_update(org_id, opened_by)%'");
    for (const l of M.split("\n").filter((x) => /COALESCE\((qual|with_check), ''\) LIKE/.test(x))) expect(l, l).not.toMatch(/::/);
    // fix pass 3: the probe also checks the policy's role list
    expect(M).toContain("AND cmd = 'UPDATE' AND roles = ARRAY['authenticated']::name[]");
  });

  it("the app mirrors the leg: holdControlsFor / holdAffordances take the hold, assertHoldCapability the opener — each gated on holdOpenerTokenOn", () => {
    const holds = readFileSync(join(process.cwd(), "lib/holds.ts"), "utf8");
    expect(holds).toContain("canRelease: !readOnly && (policyAllows(policy, \"holds.release\", role, extra, uid) || (isHoldOpener(hold, uid) && holdOpenerTokenOn(policy))),");
    expect(holds).toContain("const openerLeg = cap === \"holds.release\" && holdOpenerTokenOn(policy);");
    expect(holds).toContain("const ownHold = openerLeg && isHoldOpener({ openedBy: opts.openedBy }, uid);");
    expect(holds).toContain(".from(\"document_holds\").select(\"org_id, opened_by, document_id, reason, notes\")");
    const aff = readFileSync(join(process.cwd(), "lib/checkoutAffordances.ts"), "utf8");
    expect(aff).toContain("const opener = !!uid && !!hold?.openedBy && hold.openedBy === uid && holdOpenerTokenOn(policy);");
    expect(aff).toContain("canRelease: opener || policyAllows(policy, \"holds.release\", role ?? null, extra, uid ?? null),");
  });
});

const polOfFile = (text: string) => {
  const a = text.indexOf("CREATE POLICY document_holds_update ON document_holds");
  return text.slice(a, text.indexOf("\n);", a) + 3);
};

describe("20261239 — hold_opener_may_update: the opener leg reads the org's holds.release list (HAND-2 fix pass 2)", () => {
  const HF = "CREATE OR REPLACE FUNCTION hold_opener_may_update(";
  const fn = fnBody(M, HF);
  const ev = fnBody(M, EV);

  it("is NEW in this file, SECURITY DEFINER with search_path pinned, created before the policy that calls it", () => {
    expect(numbered.filter((f) => f < FILE && read(f).includes("hold_opener_may_update"))).toEqual([]);
    expect(fn).toMatch(/^CREATE OR REPLACE FUNCTION hold_opener_may_update\(p_org UUID, p_opened_by UUID\)\nRETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS \$\$/);
    const tx = M.slice(M.indexOf("\nBEGIN;"), M.indexOf("\nCOMMIT;"));
    expect(tx.indexOf(HF)).toBeGreaterThan(0);
    expect(tx.indexOf(HF)).toBeLessThan(tx.indexOf("CREATE POLICY document_holds_update ON document_holds"));
  });

  it("DRLS-16 (fix pass 3): EXECUTE taken from PUBLIC and anon, granted to authenticated and service_role only — the policy is TO authenticated; probe 112 checks no PUBLIC grant and no anon EXECUTE", () => {
    const tx = M.slice(M.indexOf("\nBEGIN;"), M.indexOf("\nCOMMIT;"));
    expect(tx).toContain("REVOKE ALL ON FUNCTION hold_opener_may_update(uuid, uuid) FROM PUBLIC, anon;");
    expect(tx).toContain("GRANT EXECUTE ON FUNCTION hold_opener_may_update(uuid, uuid) TO authenticated, service_role;");
    expect(codeOnly(M)).not.toMatch(/GRANT[^;]*hold_opener_may_update[^;]*TO[^;]*\b(PUBLIC|anon)\b/i);
    expect(M).toContain("WHERE p.oid = to_regprocedure('public.hold_opener_may_update(uuid,uuid)') AND a.grantee = 0)");
    expect(M).toContain("AND NOT has_function_privilege('anon', 'public.hold_opener_may_update(uuid,uuid)', 'EXECUTE')");
    // why anon needs nothing: the policy applies to authenticated only, so an anon UPDATE has no policy (0 rows)
    expect(polOfFile(M)).toMatch(/^CREATE POLICY document_holds_update ON document_holds FOR UPDATE TO authenticated USING \(/);
    expect(fn.indexOf("IF p_opened_by IS NULL OR p_opened_by IS DISTINCT FROM auth.uid() THEN")).toBeLessThan(fn.indexOf("FROM org_configurations"));
  });

  it("only the caller who IS the opener, and an active member of the hold's org, can pass", () => {
    expect(fn).toContain("IF p_opened_by IS NULL OR p_opened_by IS DISTINCT FROM auth.uid() THEN\n    RETURN FALSE;");
    // no NULL-uid branch that admits (DRLS-16 / dcHotfixAnonExecute): a NULL session uid is DISTINCT from any opener
    expect(stripComments(fn)).not.toMatch(/auth\.uid\(\)\s+IS\s+(NOT\s+)?NULL/i);
    expect(fn).toContain("WHERE org_id = p_org AND uid = auth.uid() AND status = 'active') THEN\n    RETURN FALSE;");
  });

  it("reads the list exactly as the evaluator's base list: the stored entry, a rule list's first unconditional rule, the legacy bare list — else the shipped default", () => {
    expect(fn).toContain("SELECT COALESCE(data->'caps'->'holds.release', data->'holds.release') INTO v_entry");
    expect(ev).toContain("v_entry := COALESCE(v_val->'caps'->p_cap, v_val->p_cap);");
    // the unconditional-rule loop is the evaluator's, line for line
    const loop = (body: string) => {
      const a = body.indexOf("      -- 2. Otherwise the first unconditional rule — the base list.");
      return a >= 0 ? body.slice(body.indexOf("FOR v_rule IN", a), body.indexOf("END LOOP;\n      END IF;", a)) : "";
    };
    const evLoop = loop(ev);
    expect(evLoop.length).toBeGreaterThan(100);
    const fnLoop = fn.slice(fn.indexOf("FOR v_rule IN"), fn.indexOf("END LOOP;\n    ELSE"));
    const norm = (x: string) => x.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(norm(fnLoop)).toEqual(norm(evLoop));
    expect(fn).toContain("      v_tokens := v_entry;");
    // the fallback is the shipped default — the CASE row and CAPABILITY_DEFS
    const def = CAPABILITY_DEFS.find((d) => d.id === "holds.release")!.defaultRoles;
    expect(fn).toContain(`    v_tokens := '${JSON.stringify(def)}'::jsonb;`);
    expect(caseMap(ev).get("holds.release")).toEqual(def);
    expect(fn).toContain("  RETURN v_tokens ? '$opener';");
  });

  it("the app's holdOpenerTokenOn reads the same base list (tokensFor with no resource)", () => {
    const cp = readFileSync(join(process.cwd(), "lib/capabilityPolicy.ts"), "utf8");
    expect(cp).toContain("return tokensFor(policy, \"holds.release\").includes(HOLD_OPENER_TOKEN);");
  });
});

describe("20261239 — capability_grant_scope_ready(): the probe the policy route asks", () => {
  it("is SECURITY INVOKER, answers true, service role only", () => {
    expect(M).toContain("CREATE OR REPLACE FUNCTION capability_grant_scope_ready()\nRETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$\n  SELECT true;\n$$;");
    expect(M).toContain("REVOKE ALL ON FUNCTION capability_grant_scope_ready() FROM PUBLIC, anon, authenticated;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION capability_grant_scope_ready() TO service_role;");
    // created in the SAME transaction as the evaluator that reads grant scopes
    const tx = M.slice(M.indexOf("\nBEGIN;"), M.indexOf("\nCOMMIT;"));
    expect(tx.indexOf("capability_grant_scope_ready()")).toBeGreaterThan(tx.indexOf(EV));
    // and it is what the route probes
    const route = readFileSync(join(process.cwd(), "app/api/admin/capability-policy/route.ts"), "utf8");
    expect(route).toContain('supabaseAdmin.rpc("capability_grant_scope_ready")');
  });
});

describe("20261239 — the one-paste shape (DEC-30)", () => {
  it("apply-order check → counts-only TEMP inventory → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const code = stripComments(M);
    const order = code.indexOf("RAISE EXCEPTION '20261239 needs 20261137 and 20261033 pasted first; nothing was changed.';");
    const temp = code.indexOf("CREATE TEMP TABLE df_p11_20261239_inventory");
    const begin = code.search(/^BEGIN;/m);
    const commit = code.search(/^COMMIT;/m);
    expect(order).toBeGreaterThan(0);
    expect(order).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect((code.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((code.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const tail = codeOnly(M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length));
    expect((tail.match(/;/g) ?? []).length).toBe(1);
    expect(tail).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/);
    expect(M).toContain(`SELECT check_name AS "check", ok, n FROM (`);
    expect(M).toContain("SELECT ord, check_name, NULL, n::text FROM df_p11_20261239_inventory");
  });

  it("the inventory is counts only — every INSERT into it selects COUNT(*) or a 0/1 state, never a row", () => {
    const pre = M.slice(0, M.indexOf("\nBEGIN;"));
    const inserts = pre.split("INSERT INTO df_p11_20261239_inventory").slice(1);
    expect(inserts.length).toBe(8);
    for (const ins of inserts.slice(0, 7)) expect(ins, ins.slice(0, 120)).toMatch(/COUNT\(\*\)/);
    expect(inserts[7]).toMatch(/CASE WHEN has_function_privilege\('authenticated'/);
    // the 'state before' row is ord 8, and every reader of it says so
    expect(inserts[7]).toMatch(/^\nSELECT 8, 'state before: authenticated may execute/);
    expect((M.match(/df_p11_20261239_inventory WHERE ord = (\d+)/g) ?? []).every((x) => x.endsWith("ord = 8"))).toBe(true);
    expect(inserts.map((ins) => Number(/^\nSELECT (\d+),/.exec(ins)?.[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // fix pass 3: row 1 counts the stored old default ["*"] apart from every
    // other stored list (row 2), so the operator sees how many workspaces
    // this file leaves at "everyone" without anyone having chosen it
    expect(inserts[0]).toMatch(/^\nSELECT 1, 'inventory: workspaces whose stored holds\.release is exactly \["\*"\]/);
    expect(inserts[0]).toContain("COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') = '[\"*\"]'::jsonb;");
    expect(inserts[1]).toMatch(/^\nSELECT 2, 'inventory: workspaces whose stored holds\.release is any other list or a rule list/);
    expect(inserts[1]).toContain("COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') <> '[\"*\"]'::jsonb;");
    expect(M).toContain("= EXISTS (SELECT 1 FROM df_p11_20261239_inventory WHERE ord = 8 AND n = 1), NULL");
    // fix pass 2: no widening row — the opener leg honours a stored list, so
    // this file widens nothing
    expect(M).not.toMatch(/the one widening/);
  });

  it("the probes' LIKE patterns are the body text, quotes doubled (prosrc is verbatim)", () => {
    const ev = fnBody(M, EV);
    const gd = fnBody(M, GD);
    expect(M).toContain(`prosrc LIKE '%WHEN ''holds.release''            THEN ''["Admin","DocCtrl","$opener"]''::jsonb%'`);
    expect(ev).toContain(`WHEN 'holds.release'            THEN '["Admin","DocCtrl","$opener"]'::jsonb`);
    const hf = fnBody(M, "CREATE OR REPLACE FUNCTION hold_opener_may_update(");
    expect(M).toContain(`prosrc LIKE '%RETURN v_tokens ? ''$opener'';%'`);
    expect(hf).toContain(`RETURN v_tokens ? '$opener';`);
    expect(M).toContain(`prosrc LIKE '%v_tokens := ''["Admin","DocCtrl","$opener"]''::jsonb;%'`);
    expect(hf).toContain(`v_tokens := '["Admin","DocCtrl","$opener"]'::jsonb;`);
    expect(M).toContain(`prosrc LIKE '%v_grant->>''projectId'' = p_resource->>''projectId''%'`);
    expect(ev).toContain(`v_grant->>'projectId' = p_resource->>'projectId'`);
    expect(M).toContain(`prosrc LIKE '%NEW.requested_by    IS DISTINCT FROM OLD.requested_by%'`);
    expect(gd).toContain(`NEW.requested_by    IS DISTINCT FROM OLD.requested_by`);
    expect(gd).toContain("A recorded acknowledgment cannot be withdrawn or re-dated.");
  });

  it("names its paste order and its rollback", () => {
    expect(M).toContain("PASTE ORDER: deploy the app first");
    expect(M).toContain("ROLLBACK: re-paste 20261137's org_capability_allows_for, 20261033's");
    expect(M).toContain("enforce_distribution_ack_guard and 20260901's document_holds_update policy;");
  });
});
