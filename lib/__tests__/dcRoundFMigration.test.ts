// Document-control Round F (P9) — shape pins on 20261077_dc_roundF_records_rails.sql.
//
// The two re-created guard bodies must be byte-faithful to their LIVE
// predecessors except for the appended blocks — proven by diffing against
// the source slices (the rpPhase5Migration / sweepRoundD3 pattern). Every
// other section is pinned by statement, and the paste contract (inventory
// before BEGIN, one SELECT with the fixed column shape, verbatim prosrc
// probes, deparsed qual probes) is checked mechanically.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const m77 = read("20261077_dc_roundF_records_rails.sql");
const m43 = read("20261043_rp_phase6_legal_hold_and_force_release.sql");
const m36 = read("20261036_rp_phase3_publish_path.sql");

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
const nonComment = (ls: string[]) => ls.filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));

describe("20261077 §1 — enforce_document_retention_guard extended from the live 20261043 body (HLD-1 dispose gate)", () => {
  const live = between(m43, "CREATE OR REPLACE FUNCTION enforce_document_retention_guard()", "DROP TRIGGER IF EXISTS trg_document_retention_guard");
  const next = between(m77, "CREATE OR REPLACE FUNCTION enforce_document_retention_guard()", "DROP TRIGGER IF EXISTS trg_document_retention_guard");

  it("removes exactly one line (the early-return's THEN moves to the widened condition)", () => {
    expect(lineDiff(live, next).onlyInA).toEqual([
      "     AND NOT (OLD.legal_hold AND NEW.status IS DISTINCT FROM OLD.status) THEN",
    ]);
  });
  it("adds exactly the widened early return and the open-hold dispose gate", () => {
    expect(nonComment(lineDiff(live, next).onlyInB)).toEqual([
      "     AND NOT (OLD.legal_hold AND NEW.status IS DISTINCT FROM OLD.status)",
      "     AND NOT (NEW.status = 'Archived' AND OLD.status IS DISTINCT FROM 'Archived') THEN",
      "  IF ((NEW.disposition_state = 'disposed' AND OLD.disposition_state IS DISTINCT FROM 'disposed')",
      "      OR (NEW.status = 'Archived' AND OLD.status IS DISTINCT FROM 'Archived'))",
      "     AND NOT v_controller",
      "     AND EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = OLD.id AND h.released_at IS NULL) THEN",
      "    RAISE EXCEPTION 'This document has an open hold and cannot be disposed or archived until it is released.'",
    ]);
  });
  it("the legal-hold arms, the authority arms and the service pass survive verbatim; the gate sits after the legal-hold block", () => {
    expect(next).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(next).toMatch(/Legal hold can only be placed or released by an Admin or Document Controller\./);
    expect(next).toMatch(/This document is under legal hold and cannot be disposed\./);
    expect(next).toMatch(/This document is under legal hold and cannot be archived\./);
    expect(next.indexOf("cannot be archived.")).toBeLessThan(next.indexOf("FROM document_holds h"));
    expect(next).toMatch(/SECURITY DEFINER SET search_path = public/);
    const trg = between(m77, "CREATE TRIGGER trg_document_retention_guard", ";");
    expect(trg).toMatch(/BEFORE UPDATE ON documents\s+FOR EACH ROW EXECUTE FUNCTION enforce_document_retention_guard\(\)/);
  });
});

describe("20261077 §2 — enforce_library_sensitive_columns extended from the live 20261036 body (RET-4)", () => {
  const live = between(m36, "CREATE OR REPLACE FUNCTION enforce_library_sensitive_columns()", "DROP TRIGGER IF EXISTS trg_library_sensitive_columns");
  const next = between(m77, "CREATE OR REPLACE FUNCTION enforce_library_sensitive_columns()", "DROP TRIGGER IF EXISTS trg_library_sensitive_columns");

  it("removes nothing", () => {
    expect(lineDiff(live, next).onlyInA).toEqual([]);
  });
  it("adds exactly the attestation-column arm: controller OR the library owner", () => {
    expect(nonComment(lineDiff(live, next).onlyInB)).toEqual([
      "  IF (NEW.last_recertified_at IS DISTINCT FROM OLD.last_recertified_at",
      "      OR NEW.last_recertified_by IS DISTINCT FROM OLD.last_recertified_by",
      "      OR NEW.next_recertification_date IS DISTINCT FROM OLD.next_recertification_date) THEN",
      "       AND OLD.owner_user_id::text IS DISTINCT FROM auth.uid()::text THEN",
      "      RAISE EXCEPTION 'Only an Admin, Document Controller or the library owner can record an access recertification.'",
    ]);
    // The arm has no can_manage_node escape (the policy arm keeps it).
    const arm = next.slice(next.indexOf("NEW.last_recertified_at IS DISTINCT FROM"));
    expect(arm).toMatch(/IF NOT is_org_controller\(OLD\.org_id\)\s*\n\s*AND OLD\.owner_user_id::text IS DISTINCT FROM auth\.uid\(\)::text THEN/);
    expect(arm).not.toMatch(/can_manage_node/);
    expect(next).toMatch(/OR NEW\.recert_policy   IS DISTINCT FROM OLD\.recert_policy\) THEN/);
    // the notify watermark is named only in the comment, never guarded
    expect(nonComment(next.split("\n")).join("\n")).not.toMatch(/recert_notified_at/);
  });
});

describe("20261077 §3–§6 — the remaining rails", () => {
  it("§3 document_versions.file_url is write-once for every authenticated caller; service role passes", () => {
    const fn = between(m77, "CREATE OR REPLACE FUNCTION enforce_document_version_key_guard()", "DROP TRIGGER IF EXISTS trg_document_version_key_guard");
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/IF NEW\.file_url IS DISTINCT FROM OLD\.file_url THEN\s*\n\s*RAISE EXCEPTION 'A revision''s storage key cannot be changed once written/);
    expect(fn).not.toMatch(/is_org_controller/);
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    const trg = between(m77, "CREATE TRIGGER trg_document_version_key_guard", ";");
    expect(trg).toMatch(/BEFORE UPDATE ON document_versions\s+FOR EACH ROW EXECUTE FUNCTION enforce_document_version_key_guard\(\)/);
  });
  it("§4 document_review_events: backfill, FOR ALL dropped, SELECT + INSERT (org-bound), RESTRICTIVE false on UPDATE and DELETE", () => {
    expect(m77).toMatch(/UPDATE document_review_events e\s*\n\s*SET org_id = d\.org_id\s*\n\s*FROM documents d\s*\n\s*WHERE d\.id = e\.document_id AND e\.org_id IS NULL;/);
    expect(m77).toMatch(/DROP POLICY IF EXISTS "document_review_events_member_all" ON document_review_events;/);
    expect(between(m77, "CREATE POLICY document_review_events_select ON", ";")).toMatch(/FOR SELECT TO authenticated/);
    const ins = between(m77, "CREATE POLICY document_review_events_insert ON", ";");
    expect(ins).toMatch(/FOR INSERT TO authenticated/);
    expect(ins).toMatch(/m\.status = 'active'/);
    expect(ins).toMatch(/d\.org_id = document_review_events\.org_id/);
    expect(between(m77, "CREATE POLICY document_review_events_no_update ON", ";")).toMatch(/AS RESTRICTIVE FOR UPDATE USING \(false\)/);
    expect(between(m77, "CREATE POLICY document_review_events_no_delete ON", ";")).toMatch(/AS RESTRICTIVE FOR DELETE USING \(false\)/);
    // The NOT NULL / FK rail chooses its world by the live count and never deletes a row.
    const rail = between(m77, "DO $$", "END $$;");
    expect(rail).toMatch(/IF v_null = 0 THEN\s*\n\s*ALTER TABLE document_review_events ALTER COLUMN org_id SET NOT NULL;/);
    expect(rail).toMatch(/CHECK \(org_id IS NOT NULL\) NOT VALID/);
    expect(rail).toMatch(/FOREIGN KEY \(org_id\) REFERENCES orgs\(id\) ON DELETE CASCADE NOT VALID/);
    expect(rail).toMatch(/VALIDATE CONSTRAINT document_review_events_org_id_fkey/);
    expect(rail).not.toMatch(/\bDELETE FROM\b/);
  });
  it("§5 the disposition trail's DELETE policy is USING (false) — tightened from controller-only", () => {
    expect(between(m77, "CREATE POLICY doc_disposition_events_no_delete ON", ";")).toMatch(/AS RESTRICTIVE FOR DELETE USING \(false\)/);
    expect(m77).not.toMatch(/doc_disposition_events_no_delete[\s\S]{0,200}is_org_controller/);
    // The 20261043 INSERT authority and no-UPDATE policies are NOT re-created (they stand).
    expect(m77).not.toMatch(/CREATE POLICY doc_disposition_events_insert_authority/);
    expect(m77).not.toMatch(/CREATE POLICY doc_disposition_events_no_update/);
  });
  it("§6 archives.reclaim_shortfall is additive: integer NOT NULL DEFAULT 0", () => {
    expect(m77).toMatch(/ALTER TABLE archives ADD COLUMN IF NOT EXISTS reclaim_shortfall integer NOT NULL DEFAULT 0;/);
  });
});

describe("20261077 — the paste contract", () => {
  it("inventory TEMP TABLE before BEGIN; exactly one BEGIN/COMMIT; the final SELECT after COMMIT with the fixed column shape", () => {
    const temp = m77.indexOf("CREATE TEMP TABLE IF NOT EXISTS _dc_f77_before AS");
    const begin = m77.indexOf("\nBEGIN;");
    const commit = m77.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(0);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect((m77.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((m77.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const verify = m77.slice(commit);
    expect(verify).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
    expect(verify).toMatch(/FROM _dc_f77_before/);
    // aggregate counts only — never customer rows
    const inv = between(m77, "CREATE TEMP TABLE IF NOT EXISTS _dc_f77_before AS", "\nBEGIN;");
    expect(inv).toMatch(/COUNT\(\*\)/);
    expect(inv).not.toMatch(/SELECT (id|uid|email|file_url)\b/);
  });
  it("prosrc probes are verbatim (apostrophes as escaped pairs) and qual probes carry no bare cast", () => {
    const verify = m77.slice(m77.indexOf("\nCOMMIT;"));
    for (const x of verify.matchAll(/prosrc (?:NOT )?LIKE '((?:[^']|'')*)'/g)) {
      // inside the SQL string, an apostrophe from the body appears as '' — never a lone quote
      expect(x[1]).not.toMatch(/(^|[^'])'([^']|$)/);
    }
    expect(verify).toMatch(/prosrc LIKE '%AND NOT \(NEW\.status = ''Archived'' AND OLD\.status IS DISTINCT FROM ''Archived''\) THEN%'/);
    for (const x of verify.matchAll(/(?:qual|with_check) (?:=|LIKE) '([^']*(?:''[^']*)*)'/g)) {
      expect(x[1]).not.toMatch(/\w::\w/);
    }
    expect(verify).toMatch(/qual = 'false'/);
  });
  it("every function pins search_path; the probe count matches the three guards", () => {
    const creates = [...m77.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(\)[^$]*?\$\$/g)].map((x) => x[0]);
    expect(creates.length).toBe(3);
    for (const c of creates) expect(c).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(m77).toMatch(/proname IN \('enforce_document_retention_guard', 'enforce_library_sensitive_columns', 'enforce_document_version_key_guard'\)/);
  });
});
