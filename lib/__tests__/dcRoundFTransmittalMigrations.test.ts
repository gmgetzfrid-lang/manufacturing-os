// document-control Round F wave 2 — P7 TRANSMITTALS: shape pins on the two
// migrations.
//
//   20261132  org_capability_allows_for re-created from its NEWEST definition
//             (20261063) with exactly ONE added CASE row — transmittal.issue —
//             proven line by line; the CASE mirrors CAPABILITY_DEFS.
//   20261133  transmittals_guard re-created from its newest definition
//             (20261027) with every line of that body kept verbatim AND
//             contiguous (its header is the new body's prefix, its item rail +
//             token mint + RETURN its suffix); one trigger, BEFORE INSERT OR
//             UPDATE OR DELETE; the three write policies; the usage RPC; and
//             the DEC-30 one-paste shape (inventory TEMP TABLE before BEGIN,
//             one final SELECT of probes + aggregate counts).
//
// The SQL was also exercised end to end against a scratch PostgreSQL 16
// cluster (stub schema, real 20260717 / 20260910 / 20261027 / 20261132 /
// 20261133, every scenario of the records' Resolution blocks); these pins keep
// the files from drifting from what was run.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITY_DEFS } from "@/lib/capabilityPolicy";

const dir = join(process.cwd(), "supabase", "migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const m132 = read("20261132_dc_roundF_transmit_capability.sql");
const m133 = read("20261133_dc_roundF_transmittal_rails.sql");
const m63 = read("20261063_rp_roundE_audit_view_capability.sql");
const m27 = read("20261027_dc_phase1_unguarded_doors.sql");
const numbered = readdirSync(dir).filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql")).sort();

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
function fnBody(text: string, header: string): string {
  const a = text.indexOf(header);
  expect(a, `function not found: ${header}`).toBeGreaterThanOrEqual(0);
  return text.slice(a, text.indexOf("$$;", text.indexOf("AS $$", a) + 5) + 3);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const tailOf = (m: string) => m.slice(m.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);
/** The SQL with every string literal and comment blanked — so a probe's label
 *  ("fires BEFORE INSERT, UPDATE and DELETE") is not mistaken for DML. */
const codeOnly = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

describe("20261132 — org_capability_allows_for learns transmittal.issue", () => {
  const H = "CREATE OR REPLACE FUNCTION org_capability_allows_for";
  const fn132 = fnBody(m132, H);
  const fn63 = fnBody(m63, H);
  const ADDED = `      WHEN 'transmittal.issue'        THEN '["Admin","DocCtrl"]'::jsonb`;

  it("starts from the NEWEST definition: 20261063 was the last file to re-create the evaluator before this one, and this is the newest now", () => {
    const definers = numbered.filter((f) => read(f).includes(`${H}(`));
    expect(definers.slice(-2)).toEqual(["20261063_rp_roundE_audit_view_capability.sql", "20261132_dc_roundF_transmit_capability.sql"]);
  });
  it("is the 20261063 body plus exactly ONE line, placed after admin.audit_view — nothing removed, nothing else added", () => {
    const { onlyInA, onlyInB } = lineDiff(fn63, fn132);
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual([ADDED]);
    expect(fn132.split("\n").length).toBe(fn63.split("\n").length + 1);
    expect(fn132).toContain(`      WHEN 'admin.audit_view'         THEN '["Admin","Manager","Supervisor","DocCtrl","Auditor"]'::jsonb\n${ADDED}\n      ELSE '[]'::jsonb`);
    expect(fn132).toMatch(/org_capability_allows_for\(p_org UUID, p_cap TEXT, p_uid UUID, p_resource JSONB\)\s*\nRETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public/);
  });
  it("the CASE mirrors CAPABILITY_DEFS exactly (every id, same defaults, same count)", () => {
    const caseBlock = between(fn132, "v_tokens := CASE p_cap", "END;");
    const sql = new Map<string, string[]>();
    for (const m of caseBlock.matchAll(/WHEN '([^']+)'\s+THEN '(\[[^\]]*\])'::jsonb/g)) sql.set(m[1], JSON.parse(m[2]) as string[]);
    for (const d of CAPABILITY_DEFS) expect(sql.get(d.id), d.id).toEqual(d.defaultRoles);
    expect(sql.size).toBe(CAPABILITY_DEFS.length);
  });
  it("does not touch the 3-argument wrapper", () => {
    expect(m132).not.toMatch(/CREATE OR REPLACE FUNCTION org_capability_allows\(/);
    expect(m132).not.toMatch(/DROP FUNCTION/);
  });
  it("one paste: inventory TEMP TABLE before BEGIN, one BEGIN/COMMIT, ONE final SELECT (check, ok, n) of probes + aggregate counts", () => {
    expect(m132.indexOf("CREATE TEMP TABLE dc_round_f_132_before AS")).toBeLessThan(m132.indexOf("\nBEGIN;"));
    expect((m132.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((m132.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const tail = tailOf(m132);
    expect((codeOnly(tail).match(/;/g) ?? []).length).toBe(1);
    expect(codeOnly(tail)).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE)\b/);
    expect(tail).toMatch(/AS check,\s*\n[\s\S]*?AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail).toContain("SELECT inventory, NULL::boolean, n FROM dc_round_f_132_before");
    expect(tail).toContain("prosrc LIKE '%WHEN ''transmittal.issue''        THEN ''[\"Admin\",\"DocCtrl\"]''::jsonb%'");
    expect(tail).not.toMatch(/SELECT \*|SELECT data\b|SELECT uid|SELECT email/);
    // the AFTER delta asks the re-created evaluator, not the BEFORE predicate again
    expect(tail).toMatch(/<> org_capability_allows_for\(m\.org_id, 'transmittal\.issue', m\.uid, '\{\}'::jsonb\)/);
  });
});

describe("20261133 — transmittals_guard extended from 20261027, verbatim and contiguous", () => {
  const H = "CREATE OR REPLACE FUNCTION transmittals_guard()";
  const base = fnBody(m27, H);
  const next = fnBody(m133, H);
  const baseHead = base.slice(0, base.indexOf("BEGIN\n"));
  const baseTail = base.slice(base.indexOf("  -- Every item that names a document"));

  it("20261027 is the newest definition before this file (no other migration re-creates the guard)", () => {
    const definers = numbered.filter((f) => read(f).includes(H));
    expect(definers).toEqual(["20261027_dc_phase1_unguarded_doors.sql", "20261133_dc_roundF_transmittal_rails.sql"]);
  });
  it("every line of the 20261027 body survives (lineDiff), its header is the prefix and its item rail + mint + RETURN the suffix", () => {
    expect(lineDiff(base, next).onlyInA).toEqual([]);
    expect(next.startsWith(baseHead)).toBe(true);
    expect(next.endsWith(baseTail)).toBe(true);
    expect(baseTail).toContain("RAISE EXCEPTION 'transmittal item names a document outside this workspace';");
    expect(baseTail).toContain("NEW.portal_token := replace(gen_random_uuid()::text, '-', '')");
    // still invoker-rights, search_path pinned (the header line is verbatim)
    expect(next).toMatch(/^CREATE OR REPLACE FUNCTION transmittals_guard\(\)\nRETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS \$\$/);
  });
  it("the additions are only what 20261133 declares — declarations, then the rules, then the base rail", () => {
    const added = next.slice(baseHead.length, next.length - baseTail.length);
    expect(added.startsWith("  -- 20261133 (TRX-1 / TRX-2 / TRX-3 / TRX-4 / TRX-6 / TRX-8 / TRX-12):\n  v_uid uuid := auth.uid();")).toBe(true);
    expect(added).toContain("\nBEGIN\n");
    // order: DELETE arm first; the early return last, immediately before the base rail
    const body = added.slice(added.indexOf("\nBEGIN\n"));
    expect(body.indexOf("IF TG_OP = 'DELETE' THEN")).toBeLessThan(body.indexOf("IF TG_OP = 'INSERT' THEN"));
    expect(body.trimEnd().endsWith("IF TG_OP = 'UPDATE' AND NOT v_issue AND NEW.items IS NOT DISTINCT FROM OLD.items THEN\n    RETURN NEW;\n  END IF;")).toBe(true);
  });
  it("TRX-2: an issued transmittal is never deleted — for every caller; only the org's own cascade passes", () => {
    const del = between(next, "IF TG_OP = 'DELETE' THEN", "RETURN OLD;");
    expect(del).toMatch(/IF OLD\.status IS DISTINCT FROM 'draft'\s*\n\s*AND EXISTS \(SELECT 1 FROM orgs o WHERE o\.id = OLD\.org_id\) THEN/);
    expect(del).not.toMatch(/v_uid|auth\.uid/); // the service role is not exempt
  });
  it("TRX-1: a member session inserts a draft only; the server-owned columns start empty", () => {
    const ins = between(next, "IF TG_OP = 'INSERT' THEN", "  ELSE\n");
    expect(ins).toMatch(/IF v_uid IS NOT NULL THEN\s*\n\s*IF NEW\.status IS DISTINCT FROM 'draft' THEN/);
    for (const col of ["portal_token", "issued_at", "acknowledged_at", "acknowledged_by_name", "acknowledged_via", "acknowledged_meta", "portal_expires_at", "portal_revoked_at", "portal_revoked_by", "portal_last_used_at"]) {
      expect(ins, col).toContain(`NEW.${col} := NULL;`);
    }
  });
  it("TRX-6: identity fixed; the lifecycle runs one way; the issued record is immutable", () => {
    expect(next).toMatch(/IF NEW\.org_id IS DISTINCT FROM OLD\.org_id OR NEW\.seq IS DISTINCT FROM OLD\.seq\s*\n\s*OR NEW\.number IS DISTINCT FROM OLD\.number OR NEW\.created_by IS DISTINCT FROM OLD\.created_by THEN/);
    const life = between(next, "IF NEW.status IS DISTINCT FROM OLD.status AND NOT (", "RAISE EXCEPTION 'A transmittal cannot move");
    expect(life).toContain("(OLD.status = 'draft' AND NEW.status = 'issued')");
    expect(life).toContain("OR (OLD.status = 'issued' AND NEW.status IN ('acknowledged', 'voided'))");
    expect(life).toContain("OR (OLD.status = 'acknowledged' AND NEW.status = 'voided'))");
    const frozen = between(next, "IF OLD.status <> 'draft' AND (", "has been issued");
    for (const col of ["items", "recipient_name", "recipient_company", "recipient_email", "purpose", "subject", "notes", "created_by_name", "issued_at", "portal_token", "portal_expires_at"]) {
      expect(frozen, col).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
    expect(frozen).toContain("AND NOT (NEW.project_id IS NULL AND (pg_trigger_depth() > 1 OR v_uid IS NULL))");
  });
  it("TRX-6: the receipt is written once, on issued → acknowledged, never from a member session", () => {
    const ack = between(next, "OR NEW.acknowledged_meta IS DISTINCT FROM OLD.acknowledged_meta)", "-- ── TRX-4: revoking");
    expect(ack).toContain("AND NOT (OLD.status = 'issued' AND NEW.status = 'acknowledged') THEN");
    expect(ack).toMatch(/IF OLD\.status = 'issued' AND NEW\.status = 'acknowledged' THEN\s*\n\s*IF v_uid IS NOT NULL THEN/);
  });
  it("TRX-4: revocation is durable and stamped by the database; the usage trail is the portal's", () => {
    const rev = between(next, "-- ── TRX-4: revoking the portal link is durable", "IF v_uid IS NOT NULL THEN\n      -- ── TRX-4: the usage trail");
    expect(rev).toMatch(/IF OLD\.portal_revoked_at IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION 'This portal link was revoked on %/);
    expect(rev).toContain("NEW.portal_revoked_at := now();");
    expect(rev).toContain("NEW.portal_revoked_by := COALESCE(v_uid, NEW.portal_revoked_by);");
    expect(next).toMatch(/OR NEW\.portal_open_count IS DISTINCT FROM OLD\.portal_open_count\s*\n\s*OR NEW\.portal_download_count IS DISTINCT FROM OLD\.portal_download_count THEN/);
  });
  it("TRX-1: issue / void / revoke need transmittal.issue for every item's library (DEC-13), the base list otherwise", () => {
    const auth = between(next, "-- ── TRX-1: issuing, voiding and revoking are transmit authority", "-- ── TRX-3 / TRX-8 / TRX-12");
    expect(auth).toContain("IF (OLD.status = 'draft' AND NEW.status = 'issued')");
    expect(auth).toContain("OR (NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided')");
    expect(auth).toContain("OR NEW.portal_revoked_at IS DISTINCT FROM OLD.portal_revoked_at THEN");
    expect(auth).toContain("IF NOT org_capability_allows_for(NEW.org_id, 'transmittal.issue', v_uid, '{}'::jsonb) THEN");
    expect(auth).toContain("CASE WHEN v_lib IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('libraryId', v_lib::text) END) THEN");
    expect(auth).toContain("USING ERRCODE = 'insufficient_privilege'");
    expect(auth).not.toMatch(/'Admin'|'DocCtrl'/); // no role list — the capability decides (DEC-35)
  });
  it("TRX-3 / TRX-8 / TRX-12: the issue gate refuses withdrawn, held, foreign, branch or unreviewed items and writes the snapshot", () => {
    const gate = between(next, "  IF v_issue THEN", "  -- A write that leaves the items as they were");
    expect(gate).toContain("IF v_archived IS NOT NULL OR v_status IN ('Superseded', 'Void', 'Archived') THEN");
    expect(gate).toContain("IF EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = v_doc AND h.released_at IS NULL) THEN");
    expect(gate).toContain("IF v_record IS DISTINCT FROM v_doc THEN");
    expect(gate).toContain("IF COALESCE(v_branch, false) OR v_review IN ('in_review', 'rejected') THEN");
    expect(gate).toContain("IF v_key IS NULL OR v_shed IS NOT NULL THEN");
    expect(gate).toContain("v_ver := v_current;");
    expect(gate).toMatch(/'fileHash', v_hash,\s*\n\s*'statusAsSent', v_status,\s*\n\s*'effectiveDate', v_eff\)\);/);
    expect(gate).toContain("NEW.items := v_items;");
    expect(gate).toContain("NEW.issued_at := now();");
    expect(gate).toContain("NEW.portal_expires_at := now() + interval '90 days';");
  });
  it("ONE trigger, BEFORE INSERT OR UPDATE OR DELETE", () => {
    expect(m133).toContain("DROP TRIGGER IF EXISTS trg_transmittals_guard ON transmittals;\nCREATE TRIGGER trg_transmittals_guard\nBEFORE INSERT OR UPDATE OR DELETE ON transmittals\nFOR EACH ROW EXECUTE FUNCTION transmittals_guard();");
    expect((m133.match(/CREATE TRIGGER/g) ?? []).length).toBe(1);
  });
});

describe("20261133 — the write policies and the usage RPC", () => {
  const policy = (name: string) => between(m133, `CREATE POLICY ${name} ON transmittals`, ");\n");
  const ACTIVE = "EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id";

  it("TRX-1: INSERT admits a draft with no token, by an active member, as themself", () => {
    const p = policy("transmittals_insert");
    expect(p).toContain("FOR INSERT WITH CHECK (\n  status = 'draft'\n  AND portal_token IS NULL\n  AND created_by = auth.uid()");
    expect(p).toContain(ACTIVE);
  });
  it("TRX-6: UPDATE — a controller, a transmit authority, or the creator ONLY while an active member; USING and WITH CHECK identical", () => {
    const p = policy("transmittals_update");
    const using = between(p, "FOR UPDATE USING (", ") WITH CHECK (").slice("FOR UPDATE USING (".length);
    const check = p.slice(p.indexOf(") WITH CHECK (") + ") WITH CHECK (".length);
    expect(using.trim()).toBe(check.trim());
    expect(using).toContain("is_org_controller(org_id)");
    expect(using).toContain("OR org_capability_allows(org_id, 'transmittal.issue', auth.uid())");
    expect(using).toMatch(/OR \(created_by = auth\.uid\(\)\s*\n\s*AND EXISTS \(SELECT 1 FROM org_members WHERE org_id = transmittals\.org_id\s*\n\s*AND uid = auth\.uid\(\) AND status = 'active'\)\)/);
  });
  it("TRX-2 / TRX-6: DELETE — drafts only; a controller, or the creator only while an active member", () => {
    const p = policy("transmittals_delete");
    expect(p).toMatch(/FOR DELETE USING \(\n  status = 'draft'\n  AND \(is_org_controller\(org_id\)/);
    expect(p).toContain(ACTIVE);
  });
  it("bump_transmittal_portal_use is a pinned SECURITY DEFINER, service role only", () => {
    const fn = fnBody(m133, "CREATE OR REPLACE FUNCTION bump_transmittal_portal_use(p_id uuid, p_kind text)");
    expect(fn).toMatch(/RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(fn).toContain("WHERE id = p_id AND status IN ('issued', 'acknowledged');");
    for (const r of ["PUBLIC", "anon", "authenticated"]) expect(m133).toContain(`REVOKE ALL ON FUNCTION bump_transmittal_portal_use(uuid, text) FROM ${r};`);
    expect(m133).toContain("GRANT EXECUTE ON FUNCTION bump_transmittal_portal_use(uuid, text) TO service_role;");
  });
  it("adds the six portal lifecycle columns idempotently", () => {
    for (const c of ["portal_expires_at TIMESTAMPTZ", "portal_revoked_at TIMESTAMPTZ", "portal_revoked_by UUID", "portal_last_used_at TIMESTAMPTZ",
      "portal_open_count INTEGER NOT NULL DEFAULT 0", "portal_download_count INTEGER NOT NULL DEFAULT 0"]) {
      expect(m133, c).toContain(`ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS ${c};`);
    }
  });
});

describe("20261133 — DEC-30: the inventory before the apply, one paste, one result set", () => {
  const inv = between(m133, "CREATE TEMP TABLE dc_round_f_133_before AS", "\nBEGIN;");
  const tail = tailOf(m133);
  it("the inventory is captured BEFORE the transaction, as aggregate counts only", () => {
    expect(m133.indexOf("DROP TABLE IF EXISTS dc_round_f_133_before;")).toBeLessThan(m133.indexOf("CREATE TEMP TABLE dc_round_f_133_before AS"));
    expect(m133.indexOf("CREATE TEMP TABLE dc_round_f_133_before AS")).toBeLessThan(m133.indexOf("\nBEGIN;"));
    expect(inv).not.toMatch(/SELECT \*/);
    expect((inv.match(/::text/g) ?? []).length).toBeGreaterThanOrEqual(11);
  });
  it("TRX-12: the unpinned-item population, split by what the new fallback does with each (1 / 0 / many candidates)", () => {
    expect(inv).toContain("WHERE NULLIF(COALESCE(it->>'versionId', it->>'version_id', ''), '') IS NULL");
    expect(inv).toContain("AND NOT COALESCE(v.is_branch, false)");
    expect(inv).toContain("AND (v.review_state IS NULL OR v.review_state = 'approved')");
    expect(inv).toContain("AND v.created_at <= u.issued_at) AS n");
    expect(inv).toContain("(SELECT COUNT(*) FROM cand WHERE n = 1)::text");
    expect(inv).toContain("(SELECT COUNT(*) FROM cand WHERE n = 0)::text");
    expect(inv).toContain("(SELECT COUNT(*) FROM cand WHERE n > 1)::text");
  });
  it("TRX-6: issued rows (and drafts) whose creator is no longer an active member", () => {
    expect(inv).toContain("'BEFORE (TRX-6): issued / acknowledged transmittals whose creator is no longer an active member");
    expect(inv).toContain("'BEFORE (TRX-6): drafts whose creator is no longer an active member");
  });
  it("one BEGIN/COMMIT, one final read-only SELECT with the (check, ok, n) shape; probes deparse-safe", () => {
    expect((m133.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((m133.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    expect((codeOnly(tail).match(/;/g) ?? []).length).toBe(1);
    expect(codeOnly(tail)).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE)\b/);
    expect(tail).toMatch(/AS check,\s*\n[\s\S]*?AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail).toContain("SELECT inventory, NULL::boolean, n FROM dc_round_f_133_before");
    expect((tail.match(/^SELECT '/gm) ?? []).length).toBe(10); // 9 probes + 1 AFTER row
    // pg_policies.qual / with_check are deparsed: no bare cast inside a LIKE pattern
    expect(tail).not.toMatch(/(qual|with_check) LIKE '%[^']*::[a-z]/);
    // prosrc is verbatim: the mint's literals are written with doubled quotes
    expect(tail).toContain("prosrc LIKE '%NEW.portal_token := replace(gen_random_uuid()::text, ''-'', '''')%'");
    expect(tail).not.toMatch(/SELECT data\b|SELECT uid|SELECT email|portal_token FROM/);
  });
});
