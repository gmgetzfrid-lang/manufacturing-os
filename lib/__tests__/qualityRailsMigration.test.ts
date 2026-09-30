// projects Round G — 20261091_prj_roundG_quality_rails.sql shape pins.
//
//   ORDER    the column + backfill statements run BEFORE any trigger in the
//            script exists (a trigger created earlier in the transaction
//            fires on the backfill: the project-org trigger aborted the whole
//            script on one legacy mismatched row — reproduced on Postgres 16).
//   QUAL-12  a BEFORE INSERT OR UPDATE trigger ties checklist_items.org_id
//            to the parent checklist; checklist_items_write is re-created
//            from the NEWEST definition (20261013) with the USING half and
//            both authority disjuncts byte-carried — the lineDiff shows the
//            one added predicate and nothing else. One row up, the header
//            (and the sibling project-scoped quality tables) is tied to the
//            PROJECT's org by quality_row_org_matches_project(), and
//            project_checklists_write is re-created the same way; an UPDATE
//            that only nulls an ON DELETE SET NULL reference passes, so a
//            document or party delete is never blocked by a legacy row.
//   QUAL-11  turnover_review_events: append-only, written ONLY by the
//            database (AFTER INSERT OR UPDATE OF status on turnover_items) —
//            member SELECT, no write policy, the write verbs revoked; the
//            decisions made before the table existed are backfilled.
//   SAF-4    the reason bar at the database: quality_reason_ok() mirrors
//            reasonProblem() (length and canned list pinned to the lib), and
//            the three rails check the column each decision writes.
//   QUAL-7   punch_items gains the four nullable text columns.
//   QUAL-2   project_checklists.completed_basis: checklist_completion_basis()
//            is completionBasis()'s rule; the backfill calls it; the rail
//            records it for every end-user write and ignores a client value.
//   DEC-30   inventory captured BEFORE the transaction, counts only; one
//            final SELECT with the fixed (check, ok, n) shape — and no bare
//            reserved word as a column reference (a bare `check` is a
//            syntax error that swallows every probe and the inventory). The
//            script was run end to end on Postgres 16 (see the records).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CANNED_REASONS, REASON_MIN_LENGTH } from "@/lib/checklistEngine";

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
/** Postgres RESERVED key words (SQL key words appendix, "reserved" and
 *  "reserved (can be function or type)"): never valid as a bare column ref. */
const PG_RESERVED = new Set(`all analyse analyze and any array as asc asymmetric both case cast check collate column
  constraint create current_catalog current_date current_role current_time current_timestamp current_user default
  deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect
  into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references
  returning select session_user some symmetric system_user table then to trailing true union unique user using
  variadic when where window with authorization binary collation concurrently cross current_schema freeze full
  ilike inner is isnull join left like natural notnull outer overlaps right similar tablesample verbose`.split(/\s+/));
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
    // QUAL-2: the three reasons a completion backfills to auto
    expect(invBlock).toMatch(/i\.status = 'satisfied' AND i\.applicability <> 'na'\s*\n\s*AND COALESCE\(i\.manual_note, ''\) = ''/);
    expect(invBlock).toMatch(/\(i\.status = 'na' OR i\.applicability = 'na'\)\s*\n\s*AND COALESCE\(i\.manual_note, ''\) = ''/);
    expect(invBlock).toMatch(/AND NOT EXISTS \(\s*\n\s*SELECT 1 FROM checklist_items i[\s\S]*?COALESCE\(i\.manual_note, ''\) <> ''/);
    // QUAL-11: the decided items the backfill covers, and the two it cannot fully
    expect(invBlock).toMatch(/status IN \('accepted', 'waived', 'rejected'\) AND reviewed_by IS NULL/);
    expect(invBlock).not.toMatch(/SELECT \*/);
    expect((invBlock.match(/COUNT\(\*\)/g) ?? []).length).toBeGreaterThanOrEqual(14);
    // QUAL-12 header + siblings: rows whose org is not their project's
    for (const t of ["project_checklists c", "turnover_items t", "punch_items k"]) {
      expect(invBlock, t).toContain(`FROM ${t}\n          JOIN projects p ON p.id = `);
    }
    expect((invBlock.match(/\.org_id <> p\.org_id/g) ?? []).length).toBe(4);
  });
  it("every backfill runs BEFORE the script creates any trigger — a trigger created earlier in the transaction would fire on it", () => {
    const firstTrigger = m91.indexOf("CREATE TRIGGER");
    const begin = m91.indexOf("\nBEGIN;");
    const basisBackfill = m91.indexOf("SET completed_basis = checklist_completion_basis(c.id)");
    const historyBackfill = m91.indexOf("INSERT INTO turnover_review_events (org_id, project_id, item_id, from_status, to_status, kind, reviewer, reviewer_name, note, document_id, created_at)");
    for (const at of [basisBackfill, historyBackfill]) {
      expect(at).toBeGreaterThan(begin);
      expect(at).toBeLessThan(firstTrigger);
    }
    // No UPDATE / INSERT / DELETE on a table after the first CREATE TRIGGER
    // (the trigger bodies are the only DML there, inside $$ … $$).
    const after = m91.slice(firstTrigger, m91.indexOf("\nCOMMIT;")).replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
    expect(after).not.toMatch(/^\s*(UPDATE|INSERT INTO|DELETE FROM)\b/m);
    // A re-run meets the same state: the one trigger that fires on the basis
    // backfill (the project-org trigger; the basis rail lets the SQL editor's
    // service pass through) is dropped before it and re-created in §2.
    const drop = m91.indexOf("DROP TRIGGER IF EXISTS trg_project_checklists_org_matches_project ON project_checklists;");
    expect(drop).toBeGreaterThan(begin);
    expect(drop).toBeLessThan(basisBackfill);
    expect(m91.indexOf("CREATE TRIGGER trg_project_checklists_org_matches_project")).toBeGreaterThan(basisBackfill);
  });
  it("the inventory's columns are not reserved words, so the final SELECT can reference them bare", () => {
    const inv = m91.slice(m91.indexOf("CREATE TEMP TABLE prj_roundg_quality_inventory"), m91.indexOf("\nUNION ALL", m91.indexOf("CREATE TEMP TABLE prj_roundg_quality_inventory")));
    const cols = [...inv.matchAll(/\bAS ([a-z_]+)\b/gi)].map((m) => m[1].toLowerCase()).filter((c) => c !== "select");
    expect(cols).toEqual(["label", "n"]);
    for (const c of cols) expect(PG_RESERVED.has(c), `inventory column "${c}" is a reserved word`).toBe(false);
    // The branch that reads the inventory references each column bare (or quoted).
    const last = m91.trim().split("\n").at(-1)!;
    const refs = /^SELECT (.+) FROM prj_roundg_quality_inventory;$/.exec(last);
    expect(refs, last).not.toBeNull();
    for (const ref of refs![1].split(",").map((x) => x.trim())) {
      if (ref === "NULL" || /^"[^"]+"$/.test(ref)) continue;
      expect(PG_RESERVED.has(ref.toLowerCase()), `bare reserved word "${ref}" as a column ref`).toBe(false);
    }
  });
  it("no probe or inventory branch uses a reserved word as a bare column reference (`check` only ever appears as the AS label)", () => {
    const tail = m91.slice(m91.indexOf("\nCOMMIT;") + "\nCOMMIT;".length)
      .replace(/--[^\n]*/g, "")
      .replace(/'(?:[^']|'')*'/g, "''");
    // Every `check` token is the output label of the first branch.
    expect(tail.match(/\bcheck\b/gi)).toEqual(["check"]);
    expect(tail).toMatch(/\) AS ok,|' AS check,/);
    expect(tail).toMatch(/'' AS check,/);
    // Each UNION ALL branch opens with a string literal, NULL, or a non-reserved identifier.
    for (const branch of tail.split(/\bUNION ALL\b/)) {
      const head = /SELECT\s+([^\s,]+)/.exec(branch);
      expect(head, branch.slice(0, 80)).not.toBeNull();
      const first = head![1];
      if (first === "''" || first === "NULL") continue;
      expect(PG_RESERVED.has(first.toLowerCase()), `branch opens with bare reserved word "${first}"`).toBe(false);
    }
  });
  it("BEGIN … COMMIT wrap the DDL, and ONE final SELECT unions probes (ok, n NULL) with inventory rows (ok NULL, n)", () => {
    const begin = m91.indexOf("\nBEGIN;"), commit = m91.indexOf("\nCOMMIT;");
    expect(begin).toBeGreaterThan(0);
    expect(commit).toBeGreaterThan(begin);
    const tail = m91.slice(commit + "\nCOMMIT;".length);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
    expect((tail.match(/AS check,/g) ?? []).length).toBe(1);   // one statement: the branches are UNION ALL
    expect((tail.replace(/--[^\n]*/g, "").match(/;/g) ?? []).length).toBe(1);
    expect(tail.trim().endsWith("SELECT label, NULL, n FROM prj_roundg_quality_inventory;")).toBe(true);
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
  it("no other migration defines checklist_items_write / project_checklists_write (20261013 is the newest source)", () => {
    // The census in migrationSourceOfTruth.test.ts keeps definitions inside the
    // numbered sequence; here we pin which file we copied from.
    expect(m13).toContain("CREATE POLICY checklist_items_write ON checklist_items FOR ALL");
    expect(m13).toContain("CREATE POLICY project_checklists_write ON project_checklists FOR ALL");
    for (const f of readdirSync(join(process.cwd(), "supabase", "migrations")).filter((x) => x.endsWith(".sql"))) {
      if (f === "20261013_project_controls_program.sql" || f === "20261091_prj_roundG_quality_rails.sql") continue;
      const body = read(f);
      expect(body, f).not.toMatch(/CREATE POLICY (checklist_items_write|project_checklists_write)\b/);
    }
  });
});

describe("20261091 — QUAL-12 one row up: the header (and its siblings) carry the PROJECT's org", () => {
  const fn = between(m91, "CREATE OR REPLACE FUNCTION quality_row_org_matches_project()", "COMMENT ON FUNCTION quality_row_org_matches_project()");
  it("the trigger function is SECURITY DEFINER with search_path pinned, reads projects.org_id, refuses a foreign org and a missing project", () => {
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/SELECT p\.org_id INTO v_org FROM projects p WHERE p\.id = NEW\.project_id/);
    // an UPDATE that only nulls a reference column named in TG_ARGV passes
    // (a document / party delete); everything else is checked
    expect(fn).toMatch(/IF TG_OP = 'UPDATE'\s*\n\s*AND \(to_jsonb\(NEW\) - TG_ARGV\) = \(to_jsonb\(OLD\) - TG_ARGV\)/);
    expect(fn).toMatch(/\(to_jsonb\(NEW\) -> a\.col\) <> 'null'::jsonb/);
    expect(fn.indexOf("RETURN NEW;")).toBeLessThan(fn.indexOf("SELECT p.org_id INTO v_org"));
    expect(fn).toMatch(/IF v_org IS NULL THEN\s*\n\s*RAISE EXCEPTION/);
    expect(fn).toMatch(/IF NEW\.org_id IS DISTINCT FROM v_org THEN\s*\n\s*RAISE EXCEPTION/);
    expect(fn).toMatch(/ERRCODE = 'check_violation'/);
    expect(fn).toMatch(/ERRCODE = 'foreign_key_violation'/);
    expect(fn).not.toMatch(/''/);
  });
  it("fires BEFORE INSERT OR UPDATE, per row, on the header and every project-scoped quality table with the user_owns_project(project_id) shape — each passing its ON DELETE SET NULL reference columns", () => {
    const args: Record<string, string> = {
      project_checklists: "'source_document_id'",
      turnover_items: "'document_id', 'party_id'",
      punch_items: "'party_id'",
      turnover_review_events: "'document_id'",
    };
    for (const [t, a] of Object.entries(args)) {
      expect(m91, t).toMatch(new RegExp(
        `DROP TRIGGER IF EXISTS trg_${t}_org_matches_project ON ${t};\\s*\\nCREATE TRIGGER trg_${t}_org_matches_project\\s*\\n\\s*BEFORE INSERT OR UPDATE ON ${t}\\s*\\n\\s*FOR EACH ROW EXECUTE FUNCTION quality_row_org_matches_project\\(${a.replace(/[()]/g, "\\$&")}\\);`));
    }
    // The argument lists are exactly the tables' ON DELETE SET NULL columns
    // (20261013 for the three live tables, this script for the history).
    const setNullCols = (sql: string, table: string) => {
      const body = between(sql, `CREATE TABLE IF NOT EXISTS ${table} (`, ");\n");
      return [...body.matchAll(/^\s*(\w+) UUID REFERENCES \w+\(id\) ON DELETE SET NULL/gm)].map((m) => `'${m[1]}'`).sort();
    };
    const argList = (t: string) => args[t].split(", ").sort();
    expect(setNullCols(m13, "project_checklists")).toEqual(argList("project_checklists"));
    expect(setNullCols(m13, "turnover_items")).toEqual(argList("turnover_items"));
    expect(setNullCols(m13, "punch_items")).toEqual(argList("punch_items"));
    expect(setNullCols(m91, "turnover_review_events")).toEqual(argList("turnover_review_events"));
    // turnover_review_events' trigger is created after the table exists.
    expect(m91.indexOf("CREATE TRIGGER trg_turnover_review_events_org_matches_project"))
      .toBeGreaterThan(m91.indexOf("CREATE TABLE IF NOT EXISTS turnover_review_events ("));
  });
  it("project_checklists_write is re-created from 20261013 byte-faithfully except for the added WITH CHECK predicate", () => {
    const live = between(m13, "CREATE POLICY project_checklists_write ON project_checklists FOR ALL", "EXCEPTION WHEN duplicate_object");
    const next = between(m91, "CREATE POLICY project_checklists_write ON project_checklists FOR ALL", "COMMENT ON POLICY project_checklists_write");
    expect(m91).toMatch(/DROP POLICY IF EXISTS project_checklists_write ON project_checklists;/);
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual(["WITH CHECK (is_org_controller(org_id) OR user_owns_project(project_id));"]);
    expect(onlyInB).toEqual([
      "WITH CHECK ((is_org_controller(org_id) OR user_owns_project(project_id))",
      "AND org_id = (SELECT p.org_id FROM projects p WHERE p.id = project_checklists.project_id));",
    ]);
    // The USING half survives verbatim.
    expect(next).toContain("USING (is_org_controller(org_id) OR user_owns_project(project_id))");
  });
  it("the final SELECT probes the function, the four triggers and the deparsed WITH CHECK", () => {
    const tail = m91.slice(m91.indexOf("\nCOMMIT;"));
    expect(tail).toMatch(/p\.proname = 'quality_row_org_matches_project'/);
    expect(tail).toMatch(/COUNT\(DISTINCT c\.relname\) = 4 FROM pg_trigger t/);
    expect(tail).toMatch(/with_check LIKE '%org_id = \( SELECT p\.org_id%'/);
    expect(tail).toMatch(/with_check LIKE '%p\.id = project_checklists\.project_id%'/);
  });
});

describe("20261091 — QUAL-11: turnover_review_events is append-only and written by the database", () => {
  const tbl = between(m91, "CREATE TABLE IF NOT EXISTS turnover_review_events (", "-- ── 1. QUAL-12");
  it("carries reviewer, name, note, from → to, kind, document, timestamp; kind and statuses are constrained; reviewer is NULL only for the service pass or an unattributed legacy decision", () => {
    for (const col of ["org_id UUID NOT NULL", "project_id UUID NOT NULL", "item_id UUID NOT NULL REFERENCES turnover_items(id) ON DELETE CASCADE",
      "from_status TEXT", "to_status TEXT NOT NULL", "reviewer UUID,", "reviewer_name TEXT", "note TEXT",
      "document_id UUID REFERENCES documents(id) ON DELETE SET NULL", "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"]) {
      expect(tbl, col).toContain(col);
    }
    expect(tbl).toMatch(/kind TEXT NOT NULL DEFAULT 'review' CHECK \(kind IN \('review','reopen','nonconformance'\)\)/);
    expect(tbl).toMatch(/to_status IN \('open','received','accepted','rejected','waived'\)/);
  });
  it("RLS: member SELECT only — no client INSERT / UPDATE / DELETE policy, and the write verbs (TRUNCATE too) revoked", () => {
    expect(tbl).toMatch(/ALTER TABLE turnover_review_events ENABLE ROW LEVEL SECURITY;/);
    expect(tbl).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON turnover_review_events FROM authenticated, anon;/);
    expect(tbl).toMatch(/CREATE POLICY turnover_review_events_member_read ON turnover_review_events FOR SELECT/);
    expect(tbl).toMatch(/m\.status = 'active'/);
    // the earlier own-row INSERT policy is gone (and dropped on a re-run)
    expect(m91).not.toMatch(/CREATE POLICY turnover_review_events_insert_own/);
    expect(tbl).toMatch(/DROP POLICY IF EXISTS turnover_review_events_insert_own ON turnover_review_events;/);
    expect(m91).not.toMatch(/CREATE POLICY \w+ ON turnover_review_events FOR (INSERT|UPDATE|DELETE|ALL)/);
  });
  it("the backfill writes one row per decision already made (reviewer, name, note, date; a rejection as a nonconformance), skips mismatched orgs, and is idempotent", () => {
    const ins = between(m91, "INSERT INTO turnover_review_events (org_id, project_id, item_id, from_status, to_status, kind, reviewer, reviewer_name, note, document_id, created_at)", ";");
    expect(ins).toMatch(/CASE WHEN t\.status = 'rejected' THEN 'nonconformance' ELSE 'review' END/);
    expect(ins).toMatch(/t\.reviewed_by, t\.reviewed_by_name, t\.review_note, t\.document_id,/);
    expect(ins).toMatch(/COALESCE\(t\.reviewed_at, t\.created_at\)/);
    expect(ins).toMatch(/WHERE t\.status IN \('accepted', 'waived', 'rejected'\)/);
    expect(ins).toMatch(/AND t\.org_id = p\.org_id/);
    expect(ins).toMatch(/AND NOT EXISTS \(SELECT 1 FROM turnover_review_events e WHERE e\.item_id = t\.id\)/);
  });
  it("every status change of a turnover item appends its history row in the same statement (AFTER INSERT OR UPDATE OF status)", () => {
    const fn = between(m91, "CREATE OR REPLACE FUNCTION turnover_items_record_review_event()", "COMMENT ON FUNCTION turnover_items_record_review_event()");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/IF NEW\.status IS NOT DISTINCT FROM OLD\.status THEN RETURN NULL; END IF;/);
    // born open is not a decision; a restore (service pass) brings its own history
    expect(fn).toMatch(/IF NEW\.status = 'open' OR auth\.uid\(\) IS NULL THEN RETURN NULL; END IF;/);
    expect(fn).toMatch(/WHEN NEW\.status = 'rejected' THEN 'nonconformance'/);
    expect(fn).toMatch(/WHEN v_from IN \('accepted', 'waived'\) AND NEW\.status NOT IN \('accepted', 'waived'\) THEN 'reopen'/);
    // the reviewer is the real caller; the name and note only when this write stamped them
    expect(fn).toMatch(/COALESCE\(auth\.uid\(\), NEW\.reviewed_by\)/);
    expect(fn).toMatch(/v_stamped := NEW\.reviewed_at IS DISTINCT FROM OLD\.reviewed_at;/);
    expect(fn).toMatch(/CASE WHEN v_stamped THEN NEW\.reviewed_by_name END/);
    expect(fn).toMatch(/CASE WHEN v_stamped THEN NEW\.review_note END/);
    expect(m91).toMatch(/CREATE TRIGGER trg_turnover_items_review_event\s*\n\s*AFTER INSERT OR UPDATE OF status ON turnover_items\s*\n\s*FOR EACH ROW EXECUTE FUNCTION turnover_items_record_review_event\(\);/);
  });
});

describe("20261091 — SAF-4 / GAP-405: the reason bar at the database", () => {
  const reasonFn = between(m91, "CREATE OR REPLACE FUNCTION quality_reason_ok(p_reason text)", "COMMENT ON FUNCTION quality_reason_ok(text)");
  it("quality_reason_ok mirrors reasonProblem(): the same minimum and the same canned list", () => {
    expect(reasonFn).toMatch(/LANGUAGE sql IMMUTABLE\s*\n\s*SET search_path = public/);
    expect(reasonFn).toContain(`length(regexp_replace(COALESCE(p_reason, ''), '\\s', '', 'g')) >= ${REASON_MIN_LENGTH}`);
    const list = /NOT IN \(([^)]*)\)/.exec(reasonFn)![1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
    expect(list).toEqual([...CANNED_REASONS]);
    expect(reasonFn).toMatch(/lower\(regexp_replace\(COALESCE\(p_reason, ''\), '\^\\s\+\|\\s\+\$', '', 'g'\)\)/);
  });
  const rail = (name: string) => between(m91, `CREATE OR REPLACE FUNCTION ${name}()`, "$$;");
  it("turnover_items: waive, reject and any move out of accepted / waived (a reopen) need a reason in review_note", () => {
    const fn = rail("turnover_items_decision_rail");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/IF TG_OP = 'UPDATE' AND NEW\.status IS NOT DISTINCT FROM OLD\.status THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/IF NEW\.status IN \('waived', 'rejected'\)\s*\n\s*OR \(TG_OP = 'UPDATE' AND OLD\.status IN \('accepted', 'waived'\) AND NEW\.status NOT IN \('accepted', 'waived'\)\) THEN/);
    expect(fn).toMatch(/IF NOT quality_reason_ok\(NEW\.review_note\) THEN\s*\n\s*RAISE EXCEPTION/);
    expect(m91).toMatch(/CREATE TRIGGER trg_turnover_items_decision_rail\s*\n\s*BEFORE INSERT OR UPDATE OF status ON turnover_items/);
  });
  it("punch_items: void needs a reason in closure_note", () => {
    const fn = rail("punch_items_void_rail");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/IF NEW\.status = 'void' AND NOT quality_reason_ok\(NEW\.closure_note\) THEN/);
    expect(m91).toMatch(/CREATE TRIGGER trg_punch_items_void_rail\s*\n\s*BEFORE INSERT OR UPDATE OF status ON punch_items/);
  });
  it("checklist_items: a person's (uid-stamped) move to N/A needs a reason in manual_note; the machine-stamped assessment passes and is never citable", () => {
    const fn = rail("checklist_items_na_rail");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/IF NEW\.updated_by IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/NEW\.status = 'na' AND \(TG_OP = 'INSERT' OR OLD\.status IS DISTINCT FROM 'na'\)/);
    expect(fn).toMatch(/NEW\.applicability = 'na' AND \(TG_OP = 'INSERT' OR OLD\.applicability IS DISTINCT FROM 'na'\)/);
    expect(fn).toMatch(/IF NOT quality_reason_ok\(NEW\.manual_note\) THEN/);
    expect(m91).toMatch(/CREATE TRIGGER trg_checklist_items_na_rail\s*\n\s*BEFORE INSERT OR UPDATE OF status, applicability ON checklist_items/);
  });
  it("the final SELECT probes the rails functionally and by shape", () => {
    const tail = m91.slice(m91.indexOf("\nCOMMIT;"));
    expect(tail).toMatch(/quality_reason_ok\('No hydrotest in an electrical-only scope'\)/);
    expect(tail).toMatch(/NOT quality_reason_ok\('decided by reviewer'\)/);
    expect(tail).toMatch(/NOT quality_reason_ok\(NULL\)/);
    expect(tail).toMatch(/COUNT\(\*\) = 5 FROM pg_proc p/);
    expect(tail).toMatch(/pg_get_triggerdef\(t\.oid\) LIKE '%AFTER INSERT OR UPDATE OF status ON %turnover_items%'/);
  });
});

describe("20261091 — QUAL-7 / QUAL-2 columns and backfill", () => {
  it("punch_items gains closed_by_name, description, location, closure_note (nullable text, idempotent)", () => {
    for (const c of ["closed_by_name", "description", "location", "closure_note"]) {
      expect(m91).toMatch(new RegExp(`ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS ${c} TEXT;`));
    }
  });
  it("checklist_completion_basis() is completionBasis()'s rule: a green on the sweep alone, an N/A with no person's reason, or no human green at all → auto; else human", () => {
    expect(m91).toMatch(/ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_basis TEXT\s*\n\s*CHECK \(completed_basis IS NULL OR completed_basis IN \('human','auto'\)\);/);
    const fn = between(m91, "CREATE OR REPLACE FUNCTION checklist_completion_basis(p_checklist_id uuid)", "COMMENT ON FUNCTION checklist_completion_basis(uuid)");
    expect(fn).toMatch(/LANGUAGE sql STABLE\s*\n\s*SET search_path = public/);
    expect(fn).not.toMatch(/SECURITY DEFINER/);   // callable by a client only under its own RLS
    const whens = fn.split(/\bWHEN (?:NOT )?EXISTS \(/).slice(1);
    expect(whens).toHaveLength(3);
    // 1. a green resting on the sweep alone
    expect(whens[0]).toMatch(/i\.status = 'satisfied' AND i\.applicability <> 'na'\s*\n\s*AND COALESCE\(i\.manual_note, ''\) = ''\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM jsonb_array_elements/);
    expect(whens[0]).toMatch(/THEN 'auto'/);
    // 2. an N/A no person gave a reason for
    expect(whens[1]).toMatch(/AND \(i\.status = 'na' OR i\.applicability = 'na'\)\s*\n\s*AND COALESCE\(i\.manual_note, ''\) = ''\)/);
    expect(whens[1]).toMatch(/THEN 'auto'/);
    // 3. no green a person decided (a note, or a person-attached chip)
    expect(fn).toMatch(/WHEN NOT EXISTS \(/);
    expect(whens[2]).toMatch(/i\.status = 'satisfied' AND i\.applicability <> 'na'\s*\n\s*AND \(COALESCE\(i\.manual_note, ''\) <> ''\s*\n\s*OR EXISTS \(SELECT 1 FROM jsonb_array_elements/);
    expect(whens[2]).toMatch(/THEN 'auto'\s*\n\s*ELSE 'human'/);
  });
  it("the backfill calls that rule for every completed checklist, so nothing completed is left NULL (probed)", () => {
    const upd = between(m91, "UPDATE project_checklists c", ";");
    expect(upd).toMatch(/SET completed_basis = checklist_completion_basis\(c\.id\)/);
    expect(upd).toMatch(/c\.status = 'complete'/);
    expect(upd).toMatch(/c\.completed_basis IS NULL/);
    expect(m91).toMatch(/COUNT\(\*\) = 0 FROM project_checklists WHERE status = 'complete' AND completed_basis IS NULL/);
    expect(m91).toMatch(/checklist_completion_basis\(gen_random_uuid\(\)\) = 'auto'/);
  });
  it("the completion-basis rail: the database records the basis for every end-user write and ignores a client value", () => {
    const fn = between(m91, "CREATE OR REPLACE FUNCTION project_checklists_completion_basis_rail()", "COMMENT ON FUNCTION project_checklists_completion_basis_rail()");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/IF NEW\.status = 'complete' THEN\s*\n\s*IF TG_OP = 'UPDATE' AND OLD\.status = 'complete' THEN\s*\n\s*NEW\.completed_basis := OLD\.completed_basis;/);
    expect(fn).toMatch(/ELSE\s*\n\s*NEW\.completed_basis := checklist_completion_basis\(NEW\.id\);/);
    expect(fn).toMatch(/ELSE\s*\n\s*NEW\.completed_basis := NULL;/);
    expect(m91).toMatch(/CREATE TRIGGER trg_project_checklists_completion_basis\s*\n\s*BEFORE INSERT OR UPDATE ON project_checklists\s*\n\s*FOR EACH ROW EXECUTE FUNCTION project_checklists_completion_basis_rail\(\);/);
  });
  it("jsonb_array_elements never meets a non-array (an object or a JSON null in evidence would abort the script)", () => {
    for (const m of m91.matchAll(/jsonb_array_elements\(([^)]*\)?[^)]*)\)/g)) {
      expect(m[0], m[0]).toMatch(/CASE WHEN jsonb_typeof\(i\.evidence\) = 'array' THEN i\.evidence ELSE '\[\]'::jsonb END/);
    }
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
