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
//            decisions made before the table existed are backfilled. The note
//            is the one the decision set, the reviewer's name comes from the
//            users profile, and item_id is a plain column: the history
//            outlives a deleted item. A restore never imports the table
//            (IMMUTABLE_TABLES); a restored decided item gets one row.
//   SAF-4    the reason bar at the database: quality_reason_ok() mirrors
//            reasonProblem() (length, canned list and the Unicode whitespace
//            / zero-width classes pinned to the lib); each rail demands the
//            decision's OWN reason (the note's normalised key must change),
//            a standing decision keeps its reason, and the reviewer / closer
//            is the caller, named from auth.users.
//            checklist_items_decision_rail bounds the machine actor to each
//            machine's own columns (sentinel names pinned to the lib; a sweep
//            green's citation must resolve to its row), stamps a person's
//            write with the caller, refuses a single-item delete or move, and
//            SHARE-locks the checklist row (waiting at most 500 ms, so a
//            cascading delete wins instead of deadlocking) before reading its
//            status. A citation's document may carry no provenance (NULL-safe
//            predicate); every citation branch is in the item's org; a legacy
//            evidence value stored as one object is one chip.
//   QUAL-7   punch_items gains the four nullable text columns.
//   QUAL-2   project_checklists.completed_basis: checklist_completion_basis()
//            is completionBasis()'s rule clause for clause (only a note that
//            meets the bar counts — a person chip is not a reason); the
//            backfill calls it; the rail
//            refuses an empty or unfinished completion (setChecklistStatus's
//            gate), records the basis for every end-user write and ignores a
//            client value; a completed checklist's items are frozen.
//   DEC-30   inventory captured BEFORE the transaction, counts only; one
//            final SELECT with the fixed (check, ok, n) shape — and no bare
//            reserved word as a column reference (a bare `check` is a
//            syntax error that swallows every probe and the inventory). The
//            script was run end to end on Postgres 16 (see the records).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CANNED_REASONS, MACHINE_ACTOR_ASSESSMENT, MACHINE_ACTOR_SWEEP, REASON_INVISIBLE_CLASS, REASON_MIN_LENGTH, REASON_SPACE_CLASS,
} from "@/lib/checklistEngine";
import { IMMUTABLE_TABLES, isImmutableTable, planRestore, RESTORE_TABLE_ORDER } from "@/lib/dataRestore";

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
    // QUAL-2: the four reasons a completion backfills to auto — a note counts
    // only when it meets the bar (the session-local copy of quality_reason_ok)
    expect(invBlock).toMatch(/AND i\.applicability <> 'na' AND i\.status NOT IN \('satisfied', 'na'\)/);
    expect(invBlock).toMatch(/i\.status = 'satisfied' AND i\.applicability <> 'na'\s*\n\s*AND NOT pg_temp\.prj_roundg_reason_ok\(i\.manual_note\)/);
    expect(invBlock).toMatch(/\(i\.status = 'na' OR i\.applicability = 'na'\)\s*\n\s*AND NOT pg_temp\.prj_roundg_reason_ok\(i\.manual_note\)/);
    expect(invBlock).toMatch(/AND NOT EXISTS \(\s*\n\s*SELECT 1 FROM checklist_items i[\s\S]*?AND pg_temp\.prj_roundg_reason_ok\(i\.manual_note\)\)\)::text/);
    // a person chip is not a reason: the basis rows never read one
    const basisRows = invBlock.slice(invBlock.indexOf("inventory: completed checklists with a green item"), invBlock.indexOf("inventory: completed checklists (all)"));
    expect(basisRows).not.toMatch(/'manual'/);
    // legacy sweep citations that name no row
    expect(invBlock).toMatch(/AND \(e \? 'documentId' OR e \? 'turnoverItemId' OR e \? 'checklistId'\)/);
    expect(invBlock).not.toMatch(/COALESCE\(i\.manual_note, ''\) (<>|=) ''/);   // "any note" is not a reason
    expect(invBlock).toMatch(/i\.manual_note IS NOT NULL AND NOT pg_temp\.prj_roundg_reason_ok\(i\.manual_note\)/);
    // QUAL-11: the decided items the backfill covers, and the two it cannot fully
    expect(invBlock).toMatch(/status IN \('accepted', 'waived', 'rejected'\) AND reviewed_by IS NULL/);
    expect(invBlock).not.toMatch(/SELECT \*/);
    expect((invBlock.match(/COUNT\(\*\)/g) ?? []).length).toBeGreaterThanOrEqual(16);
    // QUAL-12 header + siblings: rows whose org is not their project's
    for (const t of ["project_checklists c", "turnover_items t", "punch_items k"]) {
      expect(invBlock, t).toContain(`FROM ${t}\n          JOIN projects p ON p.id = `);
    }
    expect((invBlock.match(/\.org_id <> p\.org_id/g) ?? []).length).toBe(4);
  });
  it("the inventory's reason bar is a session-local copy of quality_reason_ok, created before the inventory and before BEGIN", () => {
    const tmp = between(m91, "CREATE OR REPLACE FUNCTION pg_temp.prj_roundg_reason_ok(p_reason text)", "$$;");
    const real = between(m91, "CREATE OR REPLACE FUNCTION quality_reason_ok(p_reason text)", "$$;");
    const body = (f: string) => f.slice(f.indexOf("AS $$"));
    expect(body(tmp)).toBe(body(real));
    expect(m91.indexOf("CREATE OR REPLACE FUNCTION pg_temp.prj_roundg_reason_ok")).toBeLessThan(m91.indexOf("CREATE TEMP TABLE prj_roundg_quality_inventory"));
    expect(m91.indexOf("CREATE OR REPLACE FUNCTION pg_temp.prj_roundg_reason_ok")).toBeLessThan(m91.indexOf("\nBEGIN;"));
    expect(tmp).not.toMatch(/SECURITY DEFINER/);
  });
  it("the helpers every rule reads (the reason bar, the actor's name) are created before the basis rule and every rail", () => {
    const begin = m91.indexOf("\nBEGIN;");
    const basis = m91.indexOf("CREATE OR REPLACE FUNCTION checklist_completion_basis(");
    for (const f of ["CREATE OR REPLACE FUNCTION quality_reason_ok(", "CREATE OR REPLACE FUNCTION quality_actor_name("]) {
      expect(m91.indexOf(f), f).toBeGreaterThan(begin);
      expect(m91.indexOf(f), f).toBeLessThan(basis);
    }
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
    for (const col of ["org_id UUID NOT NULL", "project_id UUID NOT NULL", "item_id UUID NOT NULL,",
      "from_status TEXT", "to_status TEXT NOT NULL", "reviewer UUID,", "reviewer_name TEXT", "note TEXT",
      "document_id UUID REFERENCES documents(id) ON DELETE SET NULL", "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"]) {
      expect(tbl, col).toContain(col);
    }
    expect(tbl).toMatch(/kind TEXT NOT NULL DEFAULT 'review' CHECK \(kind IN \('review','reopen','nonconformance'\)\)/);
    expect(tbl).toMatch(/to_status IN \('open','received','accepted','rejected','waived'\)/);
  });
  it("the history outlives its item: item_id is a plain column — no foreign key, no cascade (an earlier draft's key is dropped on a re-run); probed", () => {
    const create = between(m91, "CREATE TABLE IF NOT EXISTS turnover_review_events (", ");\n");
    expect(create).not.toMatch(/REFERENCES turnover_items/);
    expect(create).toMatch(/^\s*item_id UUID NOT NULL,$/m);
    expect(tbl).toContain("ALTER TABLE turnover_review_events DROP CONSTRAINT IF EXISTS turnover_review_events_item_id_fkey;");
    expect(m91.slice(m91.indexOf("\nCOMMIT;"))).toMatch(/k\.contype = 'f'\s*\n\s*AND k\.confrelid = 'public\.turnover_items'::regclass/);
  });
  it("a restore never imports the history (SURF-8 IMMUTABLE_TABLES); the trigger writes one row per restored decided item instead", () => {
    expect(isImmutableTable("turnover_review_events")).toBe(true);
    expect(IMMUTABLE_TABLES.turnover_review_events).toMatch(/written only by the database/);
    expect(RESTORE_TABLE_ORDER).toContain("turnover_review_events");   // the position stays, as for audit_logs / e_signatures
    const plan = planRestore(
      { manifest: { orgId: "b" }, tables: { turnover_items: [{ id: "t1" }], turnover_review_events: [{ id: "e1" }] } },
      { orgId: "a", orgName: "A", members: [] },
    );
    expect(plan.counts.tables.find((t) => t.name === "turnover_review_events")?.willImport).toBe(false);
    expect(plan.counts.tables.find((t) => t.name === "turnover_items")?.willImport).toBe(true);
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
    // born open is not a decision
    expect(fn).toMatch(/IF NEW\.status = 'open' THEN RETURN NULL; END IF;/);
    // a restore (service pass) of a decided item: one row from its own stamps,
    // dated by them, and none when the item's history already stands
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN\s*\n[\s\S]*?IF NEW\.status NOT IN \('accepted', 'waived', 'rejected'\)\s*\n\s*OR EXISTS \(SELECT 1 FROM turnover_review_events e WHERE e\.item_id = NEW\.id\) THEN\s*\n\s*RETURN NULL;/);
    expect(fn).toMatch(/v_at := COALESCE\(NEW\.reviewed_at, NEW\.created_at, NOW\(\)\);/);
    expect(fn).toMatch(/WHEN NEW\.status = 'rejected' THEN 'nonconformance'/);
    expect(fn).toMatch(/WHEN v_from IN \('accepted', 'waived'\) AND NEW\.status NOT IN \('accepted', 'waived'\) THEN 'reopen'/);
    // the reviewer is the real caller, NAMED from the users profile (never the client's name)
    expect(fn).toMatch(/COALESCE\(auth\.uid\(\), NEW\.reviewed_by\)/);
    expect(fn).toMatch(/CASE WHEN auth\.uid\(\) IS NOT NULL THEN quality_actor_name\(auth\.uid\(\)\) ELSE NEW\.reviewed_by_name END/);
    // the note is NEW's only when this write CHANGED it (normalised) — a fresh
    // reviewed_at over a carried-over note does not re-attribute it
    expect(fn).toMatch(/v_note := CASE WHEN quality_reason_key\(NEW\.review_note\) IS DISTINCT FROM quality_reason_key\(OLD\.review_note\)\s*\n\s*THEN NEW\.review_note END;/);
    expect(fn).not.toMatch(/reviewed_at IS DISTINCT FROM/);
    expect(fn).not.toMatch(/v_stamped/);
    expect(m91).toMatch(/CREATE TRIGGER trg_turnover_items_review_event\s*\n\s*AFTER INSERT OR UPDATE OF status ON turnover_items\s*\n\s*FOR EACH ROW EXECUTE FUNCTION turnover_items_record_review_event\(\);/);
  });
  it("quality_actor_name reads the SIGN-IN email in auth.users (the lib's actor name) — never the self-editable users profile — and no client may call it", () => {
    const fn = between(m91, "CREATE OR REPLACE FUNCTION quality_actor_name(p_uid uuid)", "$$;");
    expect(fn).toMatch(/LANGUAGE sql STABLE\s*\n\s*SET search_path = public/);
    expect(fn).toContain("SELECT NULLIF(split_part(u.email, '@', 1), '') FROM auth.users u WHERE u.id = p_uid;");
    expect(fn).not.toMatch(/FROM users u|display_name/);
    expect(m91).toContain("REVOKE EXECUTE ON FUNCTION quality_actor_name(uuid) FROM PUBLIC, anon, authenticated;");
  });
});

describe("20261091 — SAF-4 / GAP-405: the reason bar at the database", () => {
  const reasonFn = between(m91, "CREATE OR REPLACE FUNCTION quality_reason_ok(p_reason text)", "COMMENT ON FUNCTION quality_reason_ok(text)");
  it("quality_reason_ok mirrors reasonProblem(): the same minimum, the same canned list, and the same two character classes (Unicode whitespace, zero-width)", () => {
    expect(reasonFn).toMatch(/LANGUAGE sql IMMUTABLE\s*\n\s*SET search_path = public/);
    expect(reasonFn).toContain(`length(regexp_replace(COALESCE(p_reason, ''), '[${REASON_SPACE_CLASS}${REASON_INVISIBLE_CLASS}]', '', 'g')) >= ${REASON_MIN_LENGTH}`);
    const list = /NOT IN \(([^)]*)\)/.exec(reasonFn)![1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
    expect(list).toEqual([...CANNED_REASONS]);
    // the canned check compares the normalised key — the same expression as quality_reason_key
    const keyExpr = `lower(btrim(regexp_replace(regexp_replace(COALESCE(p_reason, ''), '[${REASON_INVISIBLE_CLASS}]', '', 'g'), '[${REASON_SPACE_CLASS}]+', ' ', 'g')))`;
    expect(reasonFn).toContain(`COALESCE(${keyExpr}, '')`);
    const keyFn = between(m91, "CREATE OR REPLACE FUNCTION quality_reason_key(p_reason text)", "$$;");
    expect(keyFn).toMatch(/LANGUAGE sql IMMUTABLE\s*\n\s*SET search_path = public/);
    expect(keyFn).toContain(`SELECT NULLIF(${keyExpr}, '');`);
    // the classes, as the lib builds them, strip what the verifier fed the bar
    const sp = new RegExp(`[${REASON_SPACE_CLASS}${REASON_INVISIBLE_CLASS}]`, "g");
    expect("\u00a0".repeat(10).replace(sp, "")).toBe("");
    expect("\u200b".repeat(10).replace(sp, "")).toBe("");
    // the final SELECT probes it functionally with a no-break space and a zero-width space
    const tail = m91.slice(m91.indexOf("\nCOMMIT;"));
    expect(tail).toContain("AND NOT quality_reason_ok(repeat(chr(160), 10))");
    expect(tail).toContain("AND NOT quality_reason_ok(repeat(chr(8203), 12))");
  });
  const rail = (name: string) => between(m91, `CREATE OR REPLACE FUNCTION ${name}()`, "$$;");
  it("turnover_items: waive, reject and any move out of accepted / waived (a reopen) need their OWN reason — a note that changed and meets the bar", () => {
    const fn = rail("turnover_items_decision_rail");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/v_moved := TG_OP = 'INSERT' OR NEW\.status IS DISTINCT FROM OLD\.status;/);
    expect(fn).toMatch(/ELSIF NEW\.status IN \('waived', 'rejected'\)\s*\n\s*OR \(TG_OP = 'UPDATE' AND OLD\.status IN \('accepted', 'waived'\) AND NEW\.status NOT IN \('accepted', 'waived'\)\) THEN/);
    // the note on the row is the earlier decision's: it must CHANGE, and meet the bar
    expect(fn).toMatch(/IF \(TG_OP = 'UPDATE' AND quality_reason_key\(NEW\.review_note\) IS NOT DISTINCT FROM quality_reason_key\(OLD\.review_note\)\)\s*\n\s*OR NOT quality_reason_ok\(NEW\.review_note\) THEN\s*\n\s*RAISE EXCEPTION/);
    // trigger timing covers a note-, reviewer- or document-only write, not just a status change
    expect(m91).toMatch(/CREATE TRIGGER trg_turnover_items_decision_rail\s*\n\s*BEFORE INSERT OR UPDATE OF status, review_note, reviewed_by, reviewed_by_name, reviewed_at, document_id ON turnover_items/);
  });
  it("turnover_items: a standing decision keeps its note, reviewer, date and reviewed document — only a document delete (ON DELETE SET NULL, one trigger level down) may null the reference", () => {
    const fn = rail("turnover_items_decision_rail");
    expect(fn).toMatch(/IF NOT v_moved THEN[\s\S]*?IF OLD\.status IN \('accepted', 'waived', 'rejected'\)\s*\n\s*AND \(NEW\.review_note IS DISTINCT FROM OLD\.review_note\s*\n\s*OR NEW\.reviewed_by IS DISTINCT FROM OLD\.reviewed_by\s*\n\s*OR NEW\.reviewed_by_name IS DISTINCT FROM OLD\.reviewed_by_name\s*\n\s*OR NEW\.reviewed_at IS DISTINCT FROM OLD\.reviewed_at\s*\n\s*OR \(NEW\.document_id IS DISTINCT FROM OLD\.document_id\s*\n\s*AND NOT \(NEW\.document_id IS NULL AND pg_trigger_depth\(\) > 1\)\)\) THEN\s*\n\s*RAISE EXCEPTION/);
  });
  it("turnover_items: the reviewer on the row is the caller — uid and profile name stamped on every decision / reopen and on any write that names a reviewer", () => {
    const fn = rail("turnover_items_decision_rail");
    expect(fn).toMatch(/IF \(v_moved AND \(NEW\.status IN \('accepted', 'waived', 'rejected'\)\s*\n\s*OR \(TG_OP = 'UPDATE' AND OLD\.status IN \('accepted', 'waived'\)\)\)\)/);
    expect(fn).toMatch(/NEW\.reviewed_by := auth\.uid\(\);\s*\n\s*NEW\.reviewed_by_name := quality_actor_name\(auth\.uid\(\)\);\s*\n\s*NEW\.reviewed_at := NOW\(\);/);
  });
  it("punch_items: void needs its OWN reason in closure_note; a standing closure keeps its closer and date (a void its reason too); the closer is the caller, the date the server's", () => {
    const fn = rail("punch_items_void_rail");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/IF NEW\.status IN \('done', 'void'\)\s*\n\s*AND \(NEW\.closed_by IS DISTINCT FROM OLD\.closed_by\s*\n\s*OR NEW\.closed_by_name IS DISTINCT FROM OLD\.closed_by_name\s*\n\s*OR NEW\.closed_at IS DISTINCT FROM OLD\.closed_at\) THEN\s*\n\s*RAISE EXCEPTION/);
    expect(fn).toMatch(/IF NEW\.status = 'void' AND NEW\.closure_note IS DISTINCT FROM OLD\.closure_note THEN\s*\n\s*RAISE EXCEPTION 'A void keeps its reason/);
    expect(fn).toMatch(/ELSIF NEW\.status = 'void'\s*\n\s*AND \(\(TG_OP = 'UPDATE' AND quality_reason_key\(NEW\.closure_note\) IS NOT DISTINCT FROM quality_reason_key\(OLD\.closure_note\)\)\s*\n\s*OR NOT quality_reason_ok\(NEW\.closure_note\)\) THEN/);
    expect(fn).toMatch(/NEW\.closed_by := auth\.uid\(\);\s*\n\s*NEW\.closed_by_name := quality_actor_name\(auth\.uid\(\)\);/);
    expect(fn).toMatch(/IF v_moved AND NEW\.status IN \('done', 'void'\) THEN\s*\n\s*NEW\.closed_at := NOW\(\);/);
    expect(m91).toMatch(/CREATE TRIGGER trg_punch_items_void_rail\s*\n\s*BEFORE INSERT OR UPDATE OF status, closure_note, closed_by, closed_by_name, closed_at ON punch_items/);
  });
  describe("checklist_items_decision_rail — the machine actor, the person, and the frozen completion", () => {
    const fn = () => rail("checklist_items_decision_rail");
    it("is SECURITY DEFINER, pinned, fires on every INSERT / UPDATE / DELETE, and replaces the earlier N/A-only rail", () => {
      expect(fn()).toMatch(/SECURITY DEFINER SET search_path = public/);
      expect(fn()).toMatch(/IF auth\.uid\(\) IS NULL THEN\s+-- service pass[^\n]*\n\s*IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;\s*\n\s*RETURN NEW;/);
      expect(m91).toMatch(/CREATE TRIGGER trg_checklist_items_decision_rail\s*\n\s*BEFORE INSERT OR UPDATE OR DELETE ON checklist_items\s*\n\s*FOR EACH ROW EXECUTE FUNCTION checklist_items_decision_rail\(\);/);
      expect(m91).toContain("DROP TRIGGER IF EXISTS trg_checklist_items_na_rail ON checklist_items;");
      expect(m91).toContain("DROP FUNCTION IF EXISTS checklist_items_na_rail();");
      expect(m91).not.toMatch(/CREATE OR REPLACE FUNCTION checklist_items_na_rail/);
    });
    it("an item leaves only with its checklist: a signed-in single-item DELETE is refused (a cascade from the checklist, project or org runs one trigger level down and passes), and an item never moves", () => {
      const f = fn();
      expect(f).toMatch(/IF TG_OP = 'DELETE' THEN\s*\n\s*IF pg_trigger_depth\(\) > 1 THEN RETURN OLD; END IF;\s*\n\s*RAISE EXCEPTION 'A checklist item is never deleted on its own/);
      expect(f).toMatch(/IF TG_OP = 'UPDATE' AND NEW\.checklist_id IS DISTINCT FROM OLD\.checklist_id THEN\s*\n\s*RAISE EXCEPTION/);
    });
    it("every item write SHARE-locks its checklist row BEFORE reading its status — it serialises with a completion — and a completed checklist is frozen (probed)", () => {
      const f = fn();
      expect(f).toContain("PERFORM 1 FROM project_checklists c WHERE c.id = NEW.checklist_id FOR SHARE;");
      // …waiting at most 500 ms (under deadlock_timeout): against a delete that cascades into the item
      // this write holds, the item write gives way (55P03) instead of deadlocking; the setting is restored
      expect(f).toMatch(/v_lock_timeout := current_setting\('lock_timeout'\);\s*\n\s*PERFORM set_config\('lock_timeout', '500ms', true\);\s*\n\s*PERFORM 1 FROM project_checklists c WHERE c\.id = NEW\.checklist_id FOR SHARE;\s*\n\s*PERFORM set_config\('lock_timeout', v_lock_timeout, true\);/);
      expect(f).toMatch(/SELECT c\.status = 'complete' INTO v_frozen FROM project_checklists c WHERE c\.id = NEW\.checklist_id;\s*\n\s*IF COALESCE\(v_frozen, false\) THEN\s*\n\s*RAISE EXCEPTION 'This checklist is complete/);
      expect(f.indexOf("FOR SHARE;")).toBeLessThan(f.indexOf("INTO v_frozen"));
      expect(f.indexOf("INTO v_frozen")).toBeLessThan(f.indexOf("IF NEW.updated_by IS NULL THEN"));
      const tail = m91.slice(m91.indexOf("\nCOMMIT;"));
      expect(tail).toContain("p.prosrc LIKE '%PERFORM 1 FROM project_checklists c WHERE c.id = NEW.checklist_id FOR SHARE%'");
    });
    it("updated_by NULL is the machine actor, bounded to exactly what each machine writes: the two sentinel names (pinned to the lib), never a person's item, no note, no person chip; the sweep's and the assessment's own columns and transitions", () => {
      const f = fn();
      const lists = [...f.matchAll(/NEW\.updated_by_name NOT IN \(([^)]*)\)/g)].map((m) => m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")));
      expect(lists).toHaveLength(2);
      for (const l of lists) expect(l).toEqual([MACHINE_ACTOR_SWEEP, MACHINE_ACTOR_ASSESSMENT]);
      expect(f).toMatch(/IF NEW\.updated_by_name IS NULL OR NEW\.updated_by_name NOT IN/);
      // human territory, as isHumanTerritory reads it: any VISIBLE note (an empty or blank one is none) or a person chip
      // (a legacy chip stored as one object counts: checklist_chips reads checklist_evidence)
      expect(f).toMatch(/IF quality_reason_key\(OLD\.manual_note\) IS NOT NULL OR checklist_chips\(OLD\.evidence, false\) @> '\[\{"source": "manual"\}\]'::jsonb THEN/);
      expect(f).toMatch(/IF NEW\.manual_note IS DISTINCT FROM OLD\.manual_note\s*\n\s*OR checklist_chips\(NEW\.evidence, false\) IS DISTINCT FROM checklist_chips\(OLD\.evidence, false\) THEN/);
      // the columns that changed, and each machine's allow-list (what runAutoEvidence / applyAssessment send)
      expect(f).toMatch(/FROM jsonb_each\(to_jsonb\(NEW\)\) n\s*\n\s*WHERE n\.value IS DISTINCT FROM \(to_jsonb\(OLD\) -> n\.key\);/);
      expect(f).toContain("IF NOT v_changed <@ ARRAY['status', 'evidence', 'updated_at', 'updated_by', 'updated_by_name']");
      expect(f).toMatch(/OR OLD\.applicability = 'na' OR OLD\.status = 'na'\s*\n\s*OR \(NEW\.status IS DISTINCT FROM OLD\.status AND NEW\.status NOT IN \('satisfied', 'needs_evidence'\)\)\s*\n\s*OR \(NEW\.evidence IS DISTINCT FROM OLD\.evidence AND jsonb_typeof\(NEW\.evidence\) IS DISTINCT FROM 'array'\) THEN/);
      expect(f).toContain("IF NOT v_changed <@ ARRAY['applicability', 'ai_rationale', 'status', 'updated_at', 'updated_by', 'updated_by_name']");
      expect(f).toMatch(/AND NOT \(\(NEW\.status = 'na' AND NEW\.applicability = 'na'\)\s*\n\s*OR \(OLD\.status = 'na' AND NEW\.status = 'open' AND NEW\.applicability = 'applies'\)\)\)/);
      // QUAL-5 at the database: never an N/A on a satisfied or evidence-bearing item
      expect(f).toMatch(/OR \(NEW\.applicability = 'na'\s*\n\s*AND \(OLD\.status = 'satisfied'\s*\n\s*OR jsonb_array_length\(checklist_evidence\(OLD\.evidence\)\) > 0\)\) THEN/);
      // text, section, seq … are in neither list
      for (const col of ["text", "section", "seq", "manual_note", "checklist_id", "org_id"]) {
        expect(f).not.toMatch(new RegExp(`ARRAY\\[[^\\]]*'${col}'`));
      }
      // a row born with no actor (createChecklist) is born undecided
      expect(f).toMatch(/IF NEW\.status <> 'open' OR NEW\.applicability = 'na' OR NEW\.manual_note IS NOT NULL/);
      const chips = between(m91, "CREATE OR REPLACE FUNCTION checklist_chips(p_evidence jsonb, p_auto boolean)", "$$;");
      expect(chips).toMatch(/LANGUAGE sql IMMUTABLE\s*\n\s*SET search_path = public/);
      expect(chips).toMatch(/WHERE \(e\.value->>'source' IS NOT DISTINCT FROM 'auto'\) = p_auto;/);
      expect(chips).toMatch(/jsonb_agg\(e\.value ORDER BY e\.ordinality\)/);
      expect(chips).toMatch(/FROM jsonb_array_elements\(checklist_evidence\(p_evidence\)\) WITH ORDINALITY/);
      // the evidence as a list of chips: an array as it stands, ONE object as a single chip (normalizeEvidence in the lib)
      const ev = between(m91, "CREATE OR REPLACE FUNCTION checklist_evidence(p_evidence jsonb)", "$$;");
      expect(ev).toMatch(/LANGUAGE sql IMMUTABLE\s*\n\s*SET search_path = public/);
      expect(ev).toMatch(/WHEN 'array' THEN p_evidence\s*\n\s*WHEN 'object' THEN jsonb_build_array\(p_evidence\)\s*\n\s*ELSE '\[\]'::jsonb/);
      expect(m91).toContain("DROP FUNCTION IF EXISTS checklist_non_auto_chips(jsonb);");
    });
    it("a sweep green's citation must RESOLVE to its row — an admitted document of the workspace, an accepted turnover item or a human MI completion of the project; a label alone proves nothing", () => {
      const f = fn();
      expect(f).toMatch(/IF NEW\.status = 'satisfied'\s*\n\s*AND \(OLD\.status IS DISTINCT FROM 'satisfied' OR NEW\.evidence IS DISTINCT FROM OLD\.evidence\)\s*\n\s*AND NOT checklist_auto_citation_ok\(NEW\.checklist_id, NEW\.org_id, NEW\.evidence\) THEN/);
      const cite = between(m91, "CREATE OR REPLACE FUNCTION checklist_auto_citation_ok(p_checklist_id uuid, p_org_id uuid, p_evidence jsonb)", "$$;");
      expect(cite).toMatch(/LANGUAGE sql STABLE\s*\n\s*SET search_path = public/);
      expect(cite).not.toMatch(/SECURITY DEFINER/);
      expect(cite).toMatch(/WHERE e->>'source' = 'auto'/);
      expect(cite).toMatch(/FROM jsonb_array_elements\(checklist_evidence\(p_evidence\)\) e/);
      // the register's rule, as the lib's gather admits a document (EVIDENCE_DOCUMENT_STATUSES)
      const libStatuses = /EVIDENCE_DOCUMENT_STATUSES: ReadonlyArray<string> = \[([^\]]*)\]/.exec(readFileSync(join(process.cwd(), "lib", "checklists.ts"), "utf8"))![1];
      expect(cite).toContain(`d.status IN (${libStatuses.replace(/"/g, "'")})`);
      expect(cite).toMatch(/WHERE d\.id = quality_try_uuid\(e->>'documentId'\) AND d\.org_id = p_org_id/);
      expect(cite).toMatch(/JOIN document_versions v ON v\.id = d\.current_version_id/);
      // a version with NO provenance (the bulk upload's, every version before 20260823) is admitted,
      // as the lib admits it: `provenance = 'external'` would be NULL there and refuse the green
      expect(cite).toMatch(/AND NOT \(v\.provenance IS NOT DISTINCT FROM 'external' AND v\.review_state IS DISTINCT FROM 'approved'\)/);
      expect(cite).not.toMatch(/v\.provenance = 'external'/);
      const libAdmit = readFileSync(join(process.cwd(), "lib", "checklists.ts"), "utf8");
      expect(libAdmit).toContain(`.filter((v) => v.provenance === "external" && v.review_state !== "approved")`);
      // every branch is tied to the item's org
      expect(cite).toMatch(/WHERE t\.id = quality_try_uuid\(e->>'turnoverItemId'\) AND t\.org_id = p_org_id\s*\n\s*AND t\.project_id = c\.project_id AND t\.status = 'accepted'/);
      expect(cite).toMatch(/WHERE m\.id = quality_try_uuid\(e->>'checklistId'\) AND m\.org_id = p_org_id\s*\n\s*AND m\.project_id = c\.project_id AND m\.id <> c\.id\s*\n\s*AND m\.kind = 'mi' AND m\.status = 'complete' AND m\.completed_basis = 'human'/);
      const uuidFn = between(m91, "CREATE OR REPLACE FUNCTION quality_try_uuid(p_text text)", "$$;");
      expect(uuidFn).toMatch(/CASE WHEN p_text ~\* '\^\[0-9a-f\]\{8\}-/);
    });
    it("every other signed-in write is a person's: stamped with the caller, the machine's citations left alone, a decision needs a note that CHANGED (normalised), and a note meets the bar and is never cleared", () => {
      const f = fn();
      expect(f).toMatch(/NEW\.updated_by := auth\.uid\(\);\s*\n\s*NEW\.updated_by_name := quality_actor_name\(auth\.uid\(\)\);/);
      expect(f).toMatch(/IF checklist_chips\(NEW\.evidence, true\)\s*\n\s*IS DISTINCT FROM checklist_chips\(CASE WHEN TG_OP = 'UPDATE' THEN OLD\.evidence END, true\) THEN/);
      expect(f).toMatch(/v_note_changed := CASE WHEN TG_OP = 'INSERT' THEN quality_reason_key\(NEW\.manual_note\) IS NOT NULL\s*\n\s*ELSE quality_reason_key\(NEW\.manual_note\) IS DISTINCT FROM quality_reason_key\(OLD\.manual_note\) END;/);
      expect(f).toMatch(/v_decides := CASE WHEN TG_OP = 'INSERT' THEN NEW\.status <> 'open' OR NEW\.applicability = 'na'\s*\n\s*ELSE NEW\.status IS DISTINCT FROM OLD\.status OR NEW\.applicability IS DISTINCT FROM OLD\.applicability END;/);
      expect(f).toMatch(/IF v_decides AND NOT v_note_changed THEN\s*\n\s*RAISE EXCEPTION/);
      expect(f).toMatch(/IF v_note_changed AND NOT quality_reason_ok\(NEW\.manual_note\) THEN\s*\n\s*RAISE EXCEPTION/);
      // the person branch comes after the machine branch returned
      expect(f.indexOf("NEW.updated_by := auth.uid();")).toBeGreaterThan(f.indexOf("IF NEW.updated_by IS NULL THEN"));
  });
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
  it("checklist_completion_basis() is completionBasis()'s rule: an unfinished item, a green with no person's reason (a chip alone is not one), an N/A with no reason that meets the bar, or no human green at all → auto; else human", () => {
    expect(m91).toMatch(/ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_basis TEXT\s*\n\s*CHECK \(completed_basis IS NULL OR completed_basis IN \('human','auto'\)\);/);
    const fn = between(m91, "CREATE OR REPLACE FUNCTION checklist_completion_basis(p_checklist_id uuid)", "COMMENT ON FUNCTION checklist_completion_basis(uuid)");
    expect(fn).toMatch(/LANGUAGE sql STABLE\s*\n\s*SET search_path = public/);
    expect(fn).not.toMatch(/SECURITY DEFINER/);   // callable by a client only under its own RLS
    const whens = fn.split(/\bWHEN (?:NOT )?EXISTS \(/).slice(1);
    expect(whens).toHaveLength(4);
    // 1. an applicable item neither green nor N/A (isBlockingItem)
    expect(whens[0]).toMatch(/AND i\.applicability <> 'na' AND i\.status NOT IN \('satisfied', 'na'\)\)/);
    expect(whens[0]).toMatch(/THEN 'auto'/);
    // 2. a green with no person's reason (no note that meets the bar — a person chip alone is not a reason)
    expect(whens[1]).toMatch(/i\.status = 'satisfied' AND i\.applicability <> 'na'\s*\n\s*AND NOT quality_reason_ok\(i\.manual_note\)\)/);
    expect(whens[1]).toMatch(/THEN 'auto'/);
    // 3. an N/A with no reason that meets the bar
    expect(whens[2]).toMatch(/AND \(i\.status = 'na' OR i\.applicability = 'na'\)\s*\n\s*AND NOT quality_reason_ok\(i\.manual_note\)\)/);
    expect(whens[2]).toMatch(/THEN 'auto'/);
    // 4. no green a person decided (a note that meets the bar)
    expect(fn).toMatch(/WHEN NOT EXISTS \(/);
    expect(whens[3]).toMatch(/i\.status = 'satisfied' AND i\.applicability <> 'na'\s*\n\s*AND quality_reason_ok\(i\.manual_note\)\)/);
    // a person-attached chip is read nowhere in the rule (the verifier's chip laundering)
    expect(fn).not.toMatch(/'manual'|jsonb_array_elements/);
    expect(whens[3]).toMatch(/THEN 'auto'\s*\n\s*ELSE 'human'/);
    // "any note" is never a person's reason (the laundering the verifier reproduced with 'x')
    expect(fn).not.toMatch(/COALESCE\(i\.manual_note, ''\)/);
  });
  it("the backfill calls that rule for every completed checklist, so nothing completed is left NULL or stale (probed)", () => {
    const upd = between(m91, "UPDATE project_checklists c", ";");
    expect(upd).toMatch(/SET completed_basis = checklist_completion_basis\(c\.id\)/);
    expect(upd).toMatch(/c\.status = 'complete'/);
    expect(upd).toMatch(/c\.completed_basis IS DISTINCT FROM checklist_completion_basis\(c\.id\)/);
    expect(m91).toMatch(/COUNT\(\*\) = 0 FROM project_checklists WHERE status = 'complete' AND completed_basis IS NULL/);
    expect(m91).toMatch(/checklist_completion_basis\(gen_random_uuid\(\)\) = 'auto'/);
  });
  it("the completion rail: the gate at the database (no items, or an applicable item neither satisfied nor N/A, refuses), then the basis for every end-user write, a client value ignored", () => {
    const fn = between(m91, "CREATE OR REPLACE FUNCTION project_checklists_completion_basis_rail()", "COMMENT ON FUNCTION project_checklists_completion_basis_rail()");
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(fn).toMatch(/IF NEW\.status = 'complete' THEN\s*\n\s*IF TG_OP = 'UPDATE' AND OLD\.status = 'complete' THEN/);
    // a completion keeps its kind (a QA/QC completion never becomes a citable MI one) and its project
    expect(fn).toMatch(/IF NEW\.kind IS DISTINCT FROM OLD\.kind OR NEW\.project_id IS DISTINCT FROM OLD\.project_id THEN\s*\n\s*RAISE EXCEPTION 'A completed checklist keeps its kind and its project/);
    expect(fn).toMatch(/END IF;\s*\n\s*NEW\.completed_basis := OLD\.completed_basis;/);
    // setChecklistStatus's gate, mirrored exactly: items exist, and none is blocking (isBlockingItem)
    expect(fn).toMatch(/IF NOT EXISTS \(SELECT 1 FROM checklist_items i WHERE i\.checklist_id = NEW\.id\) THEN\s*\n\s*RAISE EXCEPTION 'This checklist has no items/);
    expect(fn).toMatch(/AND i\.applicability <> 'na' AND i\.status NOT IN \('satisfied', 'na'\);\s*\n\s*IF v_blocking > 0 THEN\s*\n\s*RAISE EXCEPTION/);
    expect(fn.indexOf("IF v_blocking > 0 THEN")).toBeLessThan(fn.indexOf("NEW.completed_basis := checklist_completion_basis(NEW.id);"));
    expect(fn).toMatch(/NEW\.completed_basis := checklist_completion_basis\(NEW\.id\);/);
    expect(fn).toMatch(/ELSE\s*\n\s*NEW\.completed_basis := NULL;/);
    expect(m91).toMatch(/CREATE TRIGGER trg_project_checklists_completion_basis\s*\n\s*BEFORE INSERT OR UPDATE ON project_checklists\s*\n\s*FOR EACH ROW EXECUTE FUNCTION project_checklists_completion_basis_rail\(\);/);
  });
  it("jsonb_array_elements never meets a non-array (an object or a JSON null in evidence would abort the script)", () => {
    const calls = [...m91.matchAll(/jsonb_array_elements\(([^)]*\)?[^)]*)\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const m of calls) {
      // the inventory's inline guard, or checklist_evidence() (array, one object as one chip, else none)
      expect(m[0], m[0]).toMatch(/CASE WHEN jsonb_typeof\(i\.evidence\) = 'array' THEN i\.evidence ELSE '\[\]'::jsonb END|^jsonb_array_elements\(checklist_evidence\(p_evidence\)\)$/);
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
