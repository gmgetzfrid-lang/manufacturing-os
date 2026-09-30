// projects Round G — J3 MONEY-LEDGER: shape pins on the two migrations.
//
//   20261093 — COST-10 delete guards (four money tables, purge GUC + audited
//              service-role path; a parent's FK cascade passes, a direct
//              DELETE is refused), MON-8/REL-4 CHECKs on cost_documents,
//              COST-9 unambiguous backfill in ANY status, the
//              cost_ledger_orphans view (legacy unlinked entries attend their
//              document; approved COs whose entry is void or missing are
//              listed), the DEC-30 inventory captured BEFORE the transaction.
//   20261094 — COST-6: change_orders_write split into INSERT (proposed only,
//              created_by = auth.uid()) and UPDATE, no DELETE grant, the
//              decision-guard trigger judging the CALLER (never a
//              client-written decided_by / created_by) with a defensively
//              parsed threshold; the controller-or-owner predicate
//              byte-carried from 20261013 and the controller-tier predicate
//              byte-carried from 20260814.
//
// Every migration is ONE script whose final statement is a single SELECT of
// (check, ok, n): probes carry ok, inventory rows carry n.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const m93 = read("20261093_prj_roundG_money_rails.sql");
const m94 = read("20261094_prj_roundG_change_order_authority.sql");
const m13 = read("20261013_project_controls_program.sql");
const m14 = read("20260814_documents_delete_controllers.sql");
const m26 = read("20260826_legal_hold_delete_guard.sql");

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
/** Lines of `a` that are not in `b` and vice versa — the substitution diff. */
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const trimmed = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("--"));
/** The final statement: everything after the COMMIT. */
const finalSelect = (m: string) => m.slice(m.lastIndexOf("COMMIT;") + "COMMIT;".length);
/** The final statement with its string literals blanked — the read-only
 *  check must not trip on a probe LABEL that names a verb. */
const code = (s: string) => s.replace(/'(?:[^']|'')*'/g, "''");

describe("20261093 — money rails", () => {
  it("captures the DEC-30 inventory in a temp table BEFORE the transaction, aggregate counts only", () => {
    const before = m93.slice(0, m93.indexOf("BEGIN;"));
    expect(before).toContain("CREATE TEMP TABLE prj_g_money_inventory AS");
    expect(before).toMatch(/awarded\/posted documents with no cost entry linked/);
    // the inventory asks the view's question: an entry voided by hand counts as attended
    expect(before).toContain("AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.source_document_id = d.id))::text AS n");
    expect(before).toMatch(/approved change orders with posted_entry_id NULL/);
    // blocker (REL-9 / COST-4): approvals whose entry was voided by hand are counted before apply
    expect(before).toMatch(/approved change orders whose posted_entry_id points at a void or missing entry/);
    expect(before).toContain("AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.id = c.posted_entry_id AND e.status = 'posted'))::text");
    // the backfill candidates are counted in ANY status (a hand-voided award entry is the document's too)
    const candidates = between(before, "COST-9 backfill candidates", "UNION ALL");
    expect(candidates).not.toContain("status = 'posted'");
    expect(before).toMatch(/status outside the CHECK set/);
    expect(before).toMatch(/kind outside the CHECK set/);
    expect(before).toMatch(/decided by their proposer/);
    // counts, never rows
    expect((before.match(/COUNT\(\*\)/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(before).not.toMatch(/SELECT \*/);
    expect(m93.indexOf("CREATE TEMP TABLE")).toBeLessThan(m93.indexOf("BEGIN;"));
    expect(m93.indexOf("BEGIN;")).toBeLessThan(m93.indexOf("COMMIT;"));
  });

  it("the delete guard is a SECURITY DEFINER trigger function with search_path pinned, in 20260826's shape", () => {
    const fn = between(m93, "CREATE OR REPLACE FUNCTION enforce_cost_ledger_delete_guard()", "COMMENT ON FUNCTION");
    expect(fn).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(fn).toContain("current_setting('app.record_purge', true)");
    expect(fn).toContain("v_purge = 'project:' || OLD.project_id::text");
    expect(fn).toContain("current_setting('request.jwt.claim.role', true)");
    expect(fn).toContain("v_jwt_role = 'service_role'");
    expect(fn).not.toContain("auth.role()");
    // the service-role path audits FIRST, then returns OLD
    expect(fn.indexOf("INSERT INTO audit_logs")).toBeLessThan(fn.lastIndexOf("RETURN OLD;"));
    expect(fn).toContain("'COST_ROW_PURGED'");
    expect(fn).toContain("USING ERRCODE = 'check_violation'");
    // same refusal shape as the legal-hold guard
    expect(m26).toContain("USING ERRCODE = 'check_violation'");
    expect(fn).toMatch(/RAISE EXCEPTION\s+'Financial records are never deleted/);
  });

  it("a parent's FK cascade passes the guard; the check sits after the audited paths and before the refusal", () => {
    // Deleting a project (or org) cascades to its cost rows; inside the
    // cascade the parent row is already gone in the trigger's snapshot, so
    // the parent's own rail decides (J8 / PC-2's projects guard). A direct
    // DELETE on a cost row still sees its project and is refused.
    const fn = between(m93, "CREATE OR REPLACE FUNCTION enforce_cost_ledger_delete_guard()", "COMMENT ON FUNCTION");
    const cascade = "IF NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)\n     OR NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN\n    RETURN OLD;";
    expect(fn).toContain(cascade);
    expect(fn.indexOf("v_jwt_role = 'service_role'")).toBeLessThan(fn.indexOf(cascade));
    expect(fn.indexOf(cascade)).toBeLessThan(fn.indexOf("RAISE EXCEPTION"));
    // the header no longer promises a broken project delete
    const header = m93.slice(0, m93.indexOf("CREATE TEMP TABLE"));
    expect(header).toContain("An FK CASCADE from the parent's");
    expect(header).not.toMatch(/deleting a\s+--\s+project through PostgREST now fails/);
  });

  it("BEFORE DELETE row triggers on all four money tables", () => {
    for (const t of ["cost_entries", "change_orders", "cost_documents", "cost_accounts"]) {
      const re = new RegExp(
        `DROP TRIGGER IF EXISTS trg_${t}_delete_guard ON ${t};\\s*CREATE TRIGGER trg_${t}_delete_guard\\s+BEFORE DELETE ON ${t}\\s+FOR EACH ROW\\s+EXECUTE FUNCTION enforce_cost_ledger_delete_guard\\(\\);`,
      );
      expect(m93, t).toMatch(re);
    }
  });

  it("CHECK constraints on cost_documents.status and kind are NOT VALID and duplicate-guarded (20260908's shape)", () => {
    expect(m93).toMatch(/ADD CONSTRAINT cost_documents_status_check\s+CHECK \(status IN \('draft', 'parsed', 'awarded', 'declined', 'posted', 'void'\)\) NOT VALID;/);
    expect(m93).toMatch(/ADD CONSTRAINT cost_documents_kind_check\s+CHECK \(kind IN \('quote', 'invoice', 'po'\)\) NOT VALID;/);
    expect((m93.match(/EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;/g) ?? []).length).toBe(2);
  });

  it("the COST-9 backfill links only an entry whose reference matches exactly ONE document — in ANY status", () => {
    const upd = between(m93, "UPDATE cost_entries e", "-- ── 4.");
    // no status predicate: an award entry voided by hand (the MOVED_MONEY
    // correction) is linked too, so its document is never offered a re-post
    expect(upd).toContain(" WHERE e.source_document_id IS NULL\n   AND (e.description LIKE 'Award — %' OR e.description LIKE 'Invoice — %')");
    expect(upd).not.toContain("e.status = 'posted'");
    expect(upd).toContain("e.reference = COALESCE(d.doc_number, d.file_name)");
    expect(upd).toContain("(e.entry_type = 'commitment' AND d.kind = 'quote' AND d.status = 'awarded')");
    expect(upd).toContain("(e.entry_type = 'actual' AND d.kind = 'invoice' AND d.status = 'posted')");
    expect(upd).toMatch(/\) = 1;\s*$/);
  });

  it("the orphans view is security_invoker and unions the two orphan states", () => {
    const view = between(m93, "CREATE OR REPLACE VIEW cost_ledger_orphans", "COMMENT ON VIEW");
    expect(view).toContain("WITH (security_invoker = true)");
    expect(view).toContain("d.status IN ('awarded', 'posted')");
    // any linked entry — a VOID one included — attends the document (MON-1 / COST-11 minor)
    expect(view).toContain("AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.source_document_id = d.id)\n");
    expect(view).not.toContain("e.source_document_id = d.id AND e.status = 'posted'");
    // blocker: an UNLINKED pre-Round-G entry of the document's award/invoice
    // shape (any status) attends it too — the ambiguous backfill residue is
    // never offered a re-post
    const legacy = between(view, "AND NOT EXISTS (\n     SELECT 1 FROM cost_entries e\n      WHERE e.source_document_id IS NULL", "UNION ALL");
    expect(legacy).toContain("AND e.project_id = d.project_id");
    expect(legacy).toContain("AND btrim(e.reference) = btrim(COALESCE(d.doc_number, d.file_name))");
    expect(legacy).toContain("(d.kind = 'quote' AND e.entry_type = 'commitment' AND e.description LIKE 'Award — %')");
    expect(legacy).toContain("(d.kind IN ('invoice', 'po') AND e.entry_type = 'actual' AND e.description LIKE 'Invoice — %')");
    expect(legacy).not.toContain("e.status");
    // an approved CO is listed unless its linked entry is POSTED (missing, void or no link)
    expect(view).toContain("WHERE c.status = 'approved'\n   AND NOT EXISTS (SELECT 1 FROM cost_entries e WHERE e.id = c.posted_entry_id AND e.status = 'posted');");
  });

  it("final statement: 5 probes + the inventory + 2 after-rows, fixed (check, ok, n) shape, read-only", () => {
    const fin = finalSelect(m93);
    expect(fin).toMatch(/AS check,[\s\S]*AS ok,[\s\S]*AS n/);
    expect((fin.match(/UNION ALL/g) ?? []).length).toBe(7);
    expect(fin).toContain('SELECT "check", NULL::boolean, n FROM prj_g_money_inventory');
    expect(fin).toMatch(/proname = 'enforce_cost_ledger_delete_guard' AND pronargs = 0/);
    expect(fin).toContain("prosrc LIKE '%app.record_purge%'");
    expect(fin).toContain("prosrc LIKE '%NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)%'");
    expect(fin).toContain("COUNT(*) = 4 FROM pg_trigger");
    expect(fin).toContain("COUNT(*) = 2 FROM pg_constraint");
    expect(fin).toContain("viewname = 'cost_ledger_orphans'");
    // the view probe reads the DEPARSED definition by its words, never a cast
    expect(fin).toContain("definition LIKE '%source_document_id IS NULL%'");
    expect(fin).toContain("definition LIKE '%posted_entry_id%'");
    expect(fin).not.toMatch(/LIKE '%[^']*::[^']*%'/);
    const after = between(fin, "inventory (after): award/invoice-shaped entries still unlinked", "UNION ALL");
    expect(after).not.toContain("status = 'posted'");
    expect(code(fin)).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/);
  });
});

describe("20261094 — change-order authority", () => {
  it("drops the FOR ALL grant and splits it: INSERT proposed-only by the caller, UPDATE controller-or-owner, NO delete policy", () => {
    expect(m94).toContain("DROP POLICY IF EXISTS change_orders_write ON change_orders;");
    // created_by is pinned to the caller at insert — a NULL or forged proposer
    // can never slip past the self-decision rule
    expect(m94).toMatch(/CREATE POLICY change_orders_insert ON change_orders FOR INSERT\s+WITH CHECK \(status = 'proposed' AND created_by = auth\.uid\(\) AND \(is_org_controller\(org_id\) OR user_owns_project\(project_id\)\)\);/);
    expect(m94).toMatch(/CREATE POLICY change_orders_update ON change_orders FOR UPDATE\s+USING \(is_org_controller\(org_id\) OR user_owns_project\(project_id\)\)\s+WITH CHECK \(is_org_controller\(org_id\) OR user_owns_project\(project_id\)\);/);
    expect(m94).not.toMatch(/CREATE POLICY \w+ ON change_orders FOR (ALL|DELETE)/);
    expect(m94).not.toMatch(/DROP POLICY IF EXISTS change_orders_member_read/);
  });

  it("the controller-or-owner predicate is byte-carried from 20261013's change_orders_write (line diff = the header only)", () => {
    const live = trimmed(between(m13, "CREATE POLICY change_orders_write ON change_orders FOR ALL", "EXCEPTION WHEN duplicate_object"));
    const next = trimmed(between(m94, "CREATE POLICY change_orders_update ON change_orders FOR UPDATE", "COMMENT ON POLICY change_orders_insert"));
    const { onlyInA, onlyInB } = lineDiff(live.join("\n"), next.join("\n"));
    expect(onlyInA).toEqual(["CREATE POLICY change_orders_write ON change_orders FOR ALL"]);
    expect(onlyInB).toEqual(["CREATE POLICY change_orders_update ON change_orders FOR UPDATE"]);
    const pred = "is_org_controller(org_id) OR user_owns_project(project_id)";
    expect(m94).toContain(`WITH CHECK (status = 'proposed' AND created_by = auth.uid() AND (${pred}))`);
  });

  it("the decision guard is SECURITY DEFINER with search_path pinned; the rules fire on proposed → approved/rejected", () => {
    const fn = between(m94, "CREATE OR REPLACE FUNCTION enforce_change_order_decision_guard()", "COMMENT ON FUNCTION");
    expect(fn).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(fn).toContain("IF OLD.status <> 'proposed' OR NEW.status NOT IN ('approved', 'rejected') THEN");
    // self-decision: refused while another eligible decider exists (controllers ∪ owner, minus the decider)
    expect(fn).toContain("v_decider = OLD.created_by");
    expect(fn).toContain("uid <> v_decider");
    expect(fn).toContain("p.owner_user_id <> v_decider");
    expect(fn).toContain("IF v_others > 0 THEN");
    // threshold: configuration, evaluated for the DECIDER
    expect(fn).toContain("c.key = 'change_order_approval_threshold'");
    expect(fn).toContain("abs(NEW.amount) > v_threshold");
    expect(fn).toContain("WHERE uid = v_decider");
    expect((fn.match(/USING ERRCODE = 'check_violation'/g) ?? []).length).toBe(5);
    // no apostrophe inside a string literal (the probe rule): the two messages are plain
    expect(fn).not.toMatch(/'[^'\n]*''[^'\n]*'/);
    expect(m94).toMatch(/CREATE TRIGGER trg_change_orders_decision_guard\s+BEFORE UPDATE ON change_orders\s+FOR EACH ROW\s+EXECUTE FUNCTION enforce_change_order_decision_guard\(\);/);
  });

  it("the guard judges the SIGNED-IN caller, never a client-written decided_by / created_by (blocker)", () => {
    const fn = between(m94, "CREATE OR REPLACE FUNCTION enforce_change_order_decision_guard()", "COMMENT ON FUNCTION");
    expect(fn).toContain("v_uid uuid := auth.uid();");
    // a session must record ITSELF as the decider…
    expect(fn).toContain("IF v_uid IS NOT NULL AND NEW.decided_by IS DISTINCT FROM v_uid THEN");
    // …and both rules judge the caller (a service write, with no uid, is judged on the recorded decider)
    expect(fn).toContain("v_decider := COALESCE(v_uid, NEW.decided_by);");
    expect(fn.indexOf("v_decider := COALESCE(v_uid, NEW.decided_by);")).toBeLessThan(fn.indexOf("SELECT COUNT(*) INTO v_others"));
    // the old trust in the client's columns is gone
    expect(fn).not.toContain("NEW.decided_by = NEW.created_by");
    expect(fn).not.toContain("WHERE uid = NEW.decided_by");
    // the proposer is never rewritten, on ANY update — checked before the early return
    expect(fn).toContain("IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN");
    expect(fn.indexOf("IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN")).toBeLessThan(fn.indexOf("IF OLD.status <> 'proposed'"));
    // the decider is written by the decision or cleared by its revert, nothing else
    expect(fn).toContain("IF NEW.decided_by IS DISTINCT FROM OLD.decided_by\n     AND NOT (OLD.status = 'proposed' AND NEW.status <> 'proposed')\n     AND NOT (NEW.status = 'proposed' AND NEW.decided_by IS NULL) THEN");
    expect(fn.indexOf("IF NEW.decided_by IS DISTINCT FROM OLD.decided_by")).toBeLessThan(fn.indexOf("IF OLD.status <> 'proposed'"));
  });

  it("a malformed threshold means NO threshold — parsed defensively in the guard and the inventory, never a raw cast", () => {
    const fn = between(m94, "CREATE OR REPLACE FUNCTION enforce_change_order_decision_guard()", "COMMENT ON FUNCTION");
    const parse = String.raw`CASE WHEN c.data->>'amount' ~ '^\s*\d+(\.\d+)?\s*$' THEN (c.data->>'amount')::numeric END`;
    expect(fn).toContain(parse);
    expect(m94).not.toContain("NULLIF(c.data->>'amount', '')::numeric");
    expect(m94).not.toContain("NULLIF(o.data->>'amount', '')::numeric");
    const fin = finalSelect(m94);
    expect(fin).toContain(String.raw`CASE WHEN o.data->>'amount' ~ '^\s*\d+(\.\d+)?\s*$' THEN (o.data->>'amount')::numeric END`);
    expect(fin).toMatch(/malformed \(read as NO threshold\)/);
  });

  it("the controller-tier predicate is byte-carried from is_org_controller (20260814), twice", () => {
    const live = between(m14, "CREATE OR REPLACE FUNCTION is_org_controller(p_org uuid)", "$$;");
    const liveLine = trimmed(live).find((l) => l.startsWith("AND (role IN"));
    expect(liveLine).toBe("AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])");
    const fn = between(m94, "CREATE OR REPLACE FUNCTION enforce_change_order_decision_guard()", "COMMENT ON FUNCTION");
    expect(trimmed(fn).filter((l) => l === liveLine)).toHaveLength(2);
    // and the guard never re-derives the tier from the headline alone
    expect(fn).not.toMatch(/role = 'Admin'|role = 'DocCtrl'/);
  });

  it("final statement: 7 probes + 5 inventory rows, deparsed-safe, read-only", () => {
    const fin = finalSelect(m94);
    expect((fin.match(/UNION ALL/g) ?? []).length).toBe(11);
    expect(fin).toContain("with_check LIKE '%created_by = auth.uid()%'");
    expect(fin).toContain("prosrc LIKE '%v_decider := COALESCE(v_uid, NEW.decided_by)%'");
    expect(fin).toContain("prosrc LIKE '%NEW.created_by IS DISTINCT FROM OLD.created_by%'");
    expect(fin).toMatch(/created_by NULL/);
    expect(fin).toContain("policyname = 'change_orders_write') AS ok");
    expect(fin).toContain("with_check LIKE '%proposed%'");
    expect(fin).toContain("cmd IN ('DELETE', 'ALL')");
    expect(fin).toContain("policyname = 'change_orders_member_read' AND cmd = 'SELECT'");
    expect(fin).toContain("prosrc LIKE '%change_order_approval_threshold%'");
    expect(fin).toContain("tgname = 'trg_change_orders_decision_guard'");
    // deparsed columns are never matched on a bare cast
    expect(fin).not.toMatch(/LIKE '%::text%'/);
    expect(code(fin)).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/);
  });
});
