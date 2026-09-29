// projects Round G — 20261091_prj_roundG_quality_rails.sql shape pins.
//
//   QUAL-12  a BEFORE INSERT OR UPDATE trigger ties checklist_items.org_id
//            to the parent checklist; checklist_items_write is re-created
//            from the NEWEST definition (20261013) with the USING half and
//            both authority disjuncts byte-carried — the lineDiff shows the
//            one added predicate and nothing else.
//   QUAL-11  turnover_review_events: append-only (member SELECT, own-row
//            INSERT tied to a real item, no UPDATE / DELETE policy, the verbs
//            revoked), kind constrained to review / reopen / nonconformance.
//   QUAL-7   punch_items gains the four nullable text columns.
//   QUAL-2   project_checklists.completed_basis with the backfill rule.
//   DEC-30   inventory captured BEFORE the transaction, counts only; one
//            final SELECT with the fixed (check, ok, n) shape.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const m91 = read("20261091_prj_roundG_quality_rails.sql");
const m13 = read("20261013_project_controls_program.sql");

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
/** Lines of `a` not in `b` and vice versa, compared trimmed (20261013's
 *  policy sits inside a DO block, two spaces deeper). */
function lineDiff(a: string, b: string) {
  const A = a.split("\n").map((l) => l.trim()).filter(Boolean), B = b.split("\n").map((l) => l.trim()).filter(Boolean);
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

describe("20261091 — script shape (DEC-30 / the one-result-set protocol)", () => {
  it("inventory TEMP TABLE is captured BEFORE the transaction, with aggregate counts only", () => {
    const inv = m91.indexOf("CREATE TEMP TABLE prj_roundg_quality_inventory");
    const begin = m91.indexOf("\nBEGIN;");
    expect(inv).toBeGreaterThan(0);
    expect(inv).toBeLessThan(begin);
    const invBlock = m91.slice(inv, begin);
    expect(invBlock).toMatch(/i\.org_id <> c\.org_id/);                       // QUAL-12 mismatch
    expect(invBlock).toMatch(/e->>'source' = 'manual'/);                       // QUAL-1 auto-only greens
    expect(invBlock).toMatch(/i\.manual_note IS NOT NULL/);                    // QUAL-2 zero-human completions
    expect(invBlock).not.toMatch(/SELECT \*/);
    expect((invBlock.match(/COUNT\(\*\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
  it("BEGIN … COMMIT wrap the DDL, and ONE final SELECT unions probes (ok, n NULL) with inventory rows (ok NULL, n)", () => {
    const begin = m91.indexOf("\nBEGIN;"), commit = m91.indexOf("\nCOMMIT;");
    expect(begin).toBeGreaterThan(0);
    expect(commit).toBeGreaterThan(begin);
    const tail = m91.slice(commit + "\nCOMMIT;".length);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
    expect((tail.match(/AS check,/g) ?? []).length).toBe(1);   // one statement: the branches are UNION ALL
    expect((tail.replace(/--[^\n]*/g, "").match(/;/g) ?? []).length).toBe(1);
    expect(tail.trim().endsWith("FROM prj_roundg_quality_inventory;")).toBe(true);
    // never a bare cast in a deparsed LIKE pattern; the with_check probe reads the deparsed subselect shape
    expect(tail).toMatch(/with_check LIKE '%org_id = \( SELECT c\.org_id%'/);
    expect(tail).not.toMatch(/LIKE '%::/);
  });
});

describe("20261091 — QUAL-12: org_id tied to the parent checklist", () => {
  const fn = between(m91, "CREATE OR REPLACE FUNCTION checklist_items_org_matches_parent()", "COMMENT ON FUNCTION checklist_items_org_matches_parent()");
  it("the trigger function is SECURITY DEFINER with search_path pinned, refuses a foreign org and a missing parent", () => {
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/SELECT c\.org_id INTO v_org FROM project_checklists c WHERE c\.id = NEW\.checklist_id/);
    expect(fn).toMatch(/IF NEW\.org_id IS DISTINCT FROM v_org THEN\s*\n\s*RAISE EXCEPTION/);
    expect(fn).toMatch(/ERRCODE = 'check_violation'/);
    expect(fn).toMatch(/IF v_org IS NULL THEN\s*\n\s*RAISE EXCEPTION/);
    expect(fn).not.toMatch(/''/); // no apostrophe escaping to trip the prosrc probe
  });
  it("the trigger fires BEFORE INSERT OR UPDATE, per row", () => {
    expect(m91).toMatch(/DROP TRIGGER IF EXISTS trg_checklist_items_org_matches_parent ON checklist_items;\s*\nCREATE TRIGGER trg_checklist_items_org_matches_parent\s*\n\s*BEFORE INSERT OR UPDATE ON checklist_items\s*\n\s*FOR EACH ROW EXECUTE FUNCTION checklist_items_org_matches_parent\(\);/);
  });
  it("checklist_items_write is re-created from 20261013 byte-faithfully except for the added WITH CHECK predicate", () => {
    const live = between(m13, "CREATE POLICY checklist_items_write ON checklist_items FOR ALL", "EXCEPTION WHEN duplicate_object");
    const next = between(m91, "CREATE POLICY checklist_items_write ON checklist_items FOR ALL", "COMMENT ON POLICY checklist_items_write");
    expect(m91).toMatch(/DROP POLICY IF EXISTS checklist_items_write ON checklist_items;/);
    const { onlyInA, onlyInB } = lineDiff(live, next);
    // The live USING half survives verbatim (both disjuncts).
    expect(next).toContain("USING (is_org_controller(org_id) OR EXISTS (\n    SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND user_owns_project(c.project_id)))");
    // Removed: only the old WITH CHECK opener and closer (the disjunct line inside it is carried).
    expect(onlyInA).toEqual([
      "WITH CHECK (is_org_controller(org_id) OR EXISTS (",
      "SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND user_owns_project(c.project_id)));",
    ]);
    // Added: the same opener wrapped in an extra paren and the one org predicate
    // (the disjunct line inside WITH CHECK is byte-identical to the USING one).
    expect(onlyInB).toEqual([
      "WITH CHECK ((is_org_controller(org_id) OR EXISTS (",
      "AND org_id = (SELECT c.org_id FROM project_checklists c WHERE c.id = checklist_items.checklist_id));",
    ]);
    expect(next).toContain("WITH CHECK ((is_org_controller(org_id) OR EXISTS (\n    SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND user_owns_project(c.project_id)))\n    AND org_id = (SELECT c.org_id FROM project_checklists c WHERE c.id = checklist_items.checklist_id));");
  });
  it("no other migration defines checklist_items_write (20261013 is the newest source)", () => {
    // The census in migrationSourceOfTruth.test.ts keeps definitions inside the
    // numbered sequence; here we pin which file we copied from.
    expect(m13).toContain("CREATE POLICY checklist_items_write ON checklist_items FOR ALL");
  });
});

describe("20261091 — QUAL-11: turnover_review_events is append-only", () => {
  const tbl = between(m91, "CREATE TABLE IF NOT EXISTS turnover_review_events (", "-- ── 3. QUAL-7");
  it("carries reviewer, name, note, from → to, kind, document, timestamp; kind and statuses are constrained", () => {
    for (const col of ["org_id UUID NOT NULL", "project_id UUID NOT NULL", "item_id UUID NOT NULL REFERENCES turnover_items(id) ON DELETE CASCADE",
      "from_status TEXT", "to_status TEXT NOT NULL", "reviewer UUID NOT NULL", "reviewer_name TEXT", "note TEXT",
      "document_id UUID REFERENCES documents(id) ON DELETE SET NULL", "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"]) {
      expect(tbl, col).toContain(col);
    }
    expect(tbl).toMatch(/kind TEXT NOT NULL DEFAULT 'review' CHECK \(kind IN \('review','reopen','nonconformance'\)\)/);
    expect(tbl).toMatch(/to_status IN \('open','received','accepted','rejected','waived'\)/);
  });
  it("RLS: member SELECT + own-row INSERT under turnover authority tied to a real item; UPDATE / DELETE revoked and no policy for them", () => {
    expect(tbl).toMatch(/ALTER TABLE turnover_review_events ENABLE ROW LEVEL SECURITY;/);
    expect(tbl).toMatch(/REVOKE UPDATE, DELETE ON turnover_review_events FROM authenticated, anon;/);
    expect(tbl).toMatch(/CREATE POLICY turnover_review_events_member_read ON turnover_review_events FOR SELECT/);
    expect(tbl).toMatch(/m\.status = 'active'/);
    const ins = between(tbl, "CREATE POLICY turnover_review_events_insert_own ON turnover_review_events FOR INSERT", ";");
    expect(ins).toMatch(/reviewer = auth\.uid\(\)/);
    expect(ins).toMatch(/is_org_controller\(org_id\) OR user_owns_project\(project_id\)/);
    expect(ins).toMatch(/t\.id = turnover_review_events\.item_id/);
    expect(ins).toMatch(/t\.org_id = turnover_review_events\.org_id/);
    expect(ins).toMatch(/t\.project_id = turnover_review_events\.project_id/);
    expect(tbl).not.toMatch(/FOR UPDATE|FOR DELETE|FOR ALL/);
  });
});

describe("20261091 — QUAL-7 / QUAL-2 columns and backfill", () => {
  it("punch_items gains closed_by_name, description, location, closure_note (nullable text, idempotent)", () => {
    for (const c of ["closed_by_name", "description", "location", "closure_note"]) {
      expect(m91).toMatch(new RegExp(`ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS ${c} TEXT;`));
    }
  });
  it("project_checklists.completed_basis is constrained to human / auto and backfilled: zero human decisions → auto, all counted items human → human, else NULL", () => {
    expect(m91).toMatch(/ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_basis TEXT\s*\n\s*CHECK \(completed_basis IS NULL OR completed_basis IN \('human','auto'\)\);/);
    const auto = between(m91, "SET completed_basis = 'auto'", ";");
    expect(auto).toMatch(/c\.status = 'complete'/);
    expect(auto).toMatch(/NOT EXISTS \(SELECT 1 FROM checklist_items i WHERE i\.checklist_id = c\.id AND i\.manual_note IS NOT NULL\)/);
    const human = between(m91, "SET completed_basis = 'human'", ";");
    expect(human).toMatch(/i\.status IN \('satisfied','na'\) OR i\.applicability = 'na'/);
    expect(human).toMatch(/i\.manual_note IS NULL/);
    expect(human).toMatch(/e->>'source' = 'manual'/);
    expect(human).toMatch(/c\.completed_basis IS NULL/);
  });
  it("the REL-4 quality-half CHECK constraints already exist in 20261013 and are probed, not re-created", () => {
    expect(m13).toMatch(/status TEXT NOT NULL DEFAULT 'open' CHECK \(status IN \('open','complete','void'\)\)/);
    expect(m13).toMatch(/status TEXT NOT NULL DEFAULT 'open' CHECK \(status IN \('open','needs_evidence','satisfied','na'\)\)/);
    expect(m13).toMatch(/applicability TEXT NOT NULL DEFAULT 'unknown' CHECK \(applicability IN \('applies','na','unknown'\)\)/);
    expect(m13).toMatch(/status TEXT NOT NULL DEFAULT 'open' CHECK \(status IN \('open','received','accepted','rejected','waived'\)\)/);
    expect(m13).toMatch(/status TEXT NOT NULL DEFAULT 'open' CHECK \(status IN \('open','done','void'\)\)/);
    expect(m91).toMatch(/REL-4 quality half: status \/ applicability CHECK constraints present on all four quality tables/);
    expect(m91.slice(m91.indexOf("\nBEGIN;"), m91.indexOf("\nCOMMIT;"))).not.toMatch(/ADD CONSTRAINT/);
  });
});
