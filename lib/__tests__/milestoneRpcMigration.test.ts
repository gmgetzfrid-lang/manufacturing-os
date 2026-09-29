// projects Round G — shape pins on the three schedule migrations:
//
//   20261097 import_batch_id + the DEC-30 inventory of position-keyed rows.
//   20261098 apply_milestone_moves re-created from 20260907 (PC SCHED-4 /
//            PT SCH-7 / PC SCHED-9): auth.role() tested explicitly, EXECUTE
//            revoked from PUBLIC + anon, the expected_updated_at lock, a true
//            ROW_COUNT, matched / unmatched returned, shift recomputed, the
//            role list read through can_edit_project_schedule →
//            caller_holds_any_role — and byte-faithful to the live body
//            everywhere else (lineDiff).
//   20261099 set_project_baseline / clear_project_baseline, the baseline
//            write guard trigger, milestone_baseline_history (PC SCHED-3).
//
// Every migration is ONE script: header, temp-table inventory BEFORE the
// transaction, BEGIN … COMMIT, one final SELECT of (check, ok, n) rows.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const m07 = read("20260907_milestone_batch_move.sql");
const m97 = read("20261097_prj_roundG_import_identity.sql");
const m98 = read("20261098_prj_roundG_apply_milestone_moves.sql");
const m99 = read("20261099_prj_roundG_baseline_authority.sql");

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
const nonBlank = (ls: string[]) => ls.filter((l) => l.trim() !== "");

describe("the one-script shape (paste into the SQL editor, read the last result set)", () => {
  for (const [name, sql] of [["20261097", m97], ["20261098", m98], ["20261099", m99]] as const) {
    it(`${name}: inventory temp table before BEGIN, then BEGIN … COMMIT, then ONE final SELECT with (check, ok, n)`, () => {
      const temp = sql.indexOf("CREATE TEMP TABLE");
      const begin = sql.indexOf("\nBEGIN;");
      const commit = sql.indexOf("\nCOMMIT;");
      expect(temp).toBeGreaterThan(0);
      expect(begin).toBeGreaterThan(temp);
      expect(commit).toBeGreaterThan(begin);
      const tail = sql.slice(commit + "\nCOMMIT;".length);
      expect(tail).toMatch(/AS check,\s*\n/);
      expect(tail).toMatch(/ AS ok,\s*\n\s+NULL::text AS n/);
      expect(tail).toMatch(/UNION ALL\s*\nSELECT check, NULL::boolean, n FROM prj_roundg_\w+_inventory;\s*$/);
      // inventory rows are aggregate COUNTs only — never customer rows
      const inv = between(sql, "CREATE TEMP TABLE", "\nBEGIN;");
      expect(inv).not.toMatch(/SELECT \*|\bname\b.*FROM milestones/);
      // no model identifiers anywhere
      expect(sql).not.toMatch(/claude|anthropic|fable|opus|sonnet/i);
    });
  }
});

describe("20261097 — import provenance (PT SCH-3 / SCH-14)", () => {
  it("adds import_batch_id (TEXT, partial index) and nothing else; inventories position-keyed refs", () => {
    const body = between(m97, "\nBEGIN;", "\nCOMMIT;");
    expect(body).toMatch(/ALTER TABLE milestones\s+ADD COLUMN IF NOT EXISTS import_batch_id TEXT;/);
    expect(body).toMatch(/CREATE INDEX IF NOT EXISTS milestones_import_batch_idx\s+ON milestones\(import_batch_id\)\s+WHERE import_batch_id IS NOT NULL;/);
    expect(body).not.toMatch(/POLICY|GRANT|FUNCTION|TRIGGER|source_key/);
    expect(m97).toMatch(/external_ref LIKE 'csv-row:%' OR external_ref LIKE 'msp-row:%'/);
    expect(m97).toMatch(/milestones_external_ref_per_project_uniq/);
  });
});

describe("20261098 — apply_milestone_moves (PC SCHED-4 + PT SCH-7 + PC SCHED-9), base 20260907", () => {
  const live = between(m07, "CREATE OR REPLACE FUNCTION apply_milestone_moves(", "$$;\n");
  const next = between(m98, "CREATE FUNCTION apply_milestone_moves(", "$$;\n\nREVOKE ALL ON FUNCTION apply_milestone_moves");

  it("the return type changes, so the old signature is dropped first and the grants are stated", () => {
    expect(m98.indexOf("DROP FUNCTION IF EXISTS apply_milestone_moves(uuid, uuid, jsonb);")).toBeLessThan(m98.indexOf("CREATE FUNCTION apply_milestone_moves("));
    expect(next).toMatch(/RETURNS JSONB\s*\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
    expect(m98).toMatch(/REVOKE ALL ON FUNCTION apply_milestone_moves\(uuid, uuid, jsonb\) FROM PUBLIC, anon;/);
    expect(m98).toMatch(/GRANT EXECUTE ON FUNCTION apply_milestone_moves\(uuid, uuid, jsonb\) TO authenticated, service_role;/);
    expect(m07).not.toMatch(/REVOKE|GRANT/); // the base never revoked — that was the hole
  });

  it("SCHED-4: the NULL-uid branch tests auth.role() = service_role explicitly; membership + the predicate otherwise", () => {
    expect(next).toMatch(/IF v_uid IS NULL THEN\s*\n(\s*--[^\n]*\n)*\s*IF auth\.role\(\) IS DISTINCT FROM 'service_role' THEN\s*\n\s*RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';/);
    expect(next).toMatch(/IF NOT caller_is_active_member\(p_org\) THEN/);
    expect(next).toMatch(/IF NOT can_edit_project_schedule\(p_org, p_project\) THEN\s*\n\s*RAISE EXCEPTION 'You do not have schedule-editing rights on this project' USING ERRCODE = '42501';/);
    expect(next).not.toMatch(/service role: trusted server code/);
    expect(next).not.toMatch(/SELECT role, COALESCE\(roles, ARRAY\[role\]\)/);
  });

  it("DEC-35: the role list lives once, in can_edit_project_schedule, read through caller_holds_any_role (same four roles + owner as 20260907)", () => {
    const helper = between(m98, "CREATE OR REPLACE FUNCTION can_edit_project_schedule(", "$$;\n");
    expect(helper).toMatch(/RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public/);
    expect(helper).toMatch(/caller_holds_any_role\(p_org, ARRAY\['Admin','DocCtrl','Manager','Supervisor'\]::text\[\]\)/);
    expect(helper).toMatch(/p\.owner_user_id = auth\.uid\(\)/);
    expect(live).toMatch(/v_roles && ARRAY\['Admin','DocCtrl','Manager','Supervisor'\]/); // the same set, inline before
    expect(next).not.toMatch(/ARRAY\['Admin'/);
    expect(m98).toMatch(/REVOKE ALL ON FUNCTION can_edit_project_schedule\(uuid, uuid\) FROM PUBLIC, anon;/);
  });

  it("SCH-7: the lock is in the WHERE, the count is ROW_COUNT, matched / unmatched come back", () => {
    expect(next).toMatch(/AND \(\(v_move->>'expected_updated_at'\) IS NULL\s*\n\s*OR updated_at IS NOT DISTINCT FROM \(v_move->>'expected_updated_at'\)::timestamptz\);/);
    expect(next).toMatch(/GET DIAGNOSTICS v_n = ROW_COUNT;\s*\n\s*IF v_n > 0 THEN\s*\n\s*v_matched := v_matched \|\| v_id;\s*\n\s*v_count := v_count \+ v_n;\s*\n\s*ELSE\s*\n\s*v_unmatched := v_unmatched \|\| v_id;/);
    expect(next).toMatch(/RETURN jsonb_build_object\(\s*\n\s*'count', v_count,\s*\n\s*'matched', to_jsonb\(v_matched\),\s*\n\s*'unmatched', to_jsonb\(v_unmatched\)\s*\n\s*\);/);
    expect(next).not.toMatch(/v_count := v_count \+ 1;/); // the per-element count is gone
  });

  it("SCHED-9: shift follows the moved start, in UTC, and a hand-set swing is kept", () => {
    expect(next).toMatch(/WHEN \(v_move->>'start'\) IS NULL OR shift = 'swing' THEN shift/);
    expect(next).toMatch(/WHEN EXTRACT\(HOUR FROM \(\(v_move->>'start'\)::timestamptz AT TIME ZONE 'UTC'\)\) BETWEEN 6 AND 17 THEN 'day'/);
  });

  it("is byte-faithful to the live 20260907 body everywhere else (lineDiff)", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    // Removed from the live body: exactly the header line, the INT return, the
    // headline-role read + inline role list, the blind NULL-uid escape and
    // the per-element count. Nothing else.
    expect(nonBlank(onlyInA)).toEqual([
      "CREATE OR REPLACE FUNCTION apply_milestone_moves(",
      "  p_moves JSONB   -- [{\"id\": \"...\", \"start\": \"ISO\", \"finish\": \"ISO\"}, ...]",
      "RETURNS INT",
      "  v_role TEXT;",
      "  v_roles TEXT[];",
      "  v_owner TEXT;",
      "    -- service role: trusted server code",
      "    NULL;",
      "    SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles",
      "    FROM org_members",
      "    WHERE org_id = p_org AND uid = v_uid AND status = 'active'",
      "    LIMIT 1;",
      "    IF v_role IS NULL THEN",
      "    SELECT owner_user_id::text INTO v_owner FROM projects WHERE id = p_project AND org_id = p_org;",
      "    IF NOT (",
      "      v_roles && ARRAY['Admin','DocCtrl','Manager','Supervisor']",
      "      OR v_owner = v_uid::text",
      "    ) THEN",
      "    WHERE id = (v_move->>'id')::uuid",
      "      AND project_id = p_project;", // the lock clause now follows it
      "    v_count := v_count + 1;",
      "  RETURN v_count;",
    ]);
    // Everything added is one of: a comment, the explicit role test, the
    // membership / predicate calls, the lock, the shift CASE, the diagnostics
    // and the jsonb result.
    const allowed = [
      /^\s*--/, /CREATE FUNCTION apply_milestone_moves\(/, /expected_updated_at/, /RETURNS JSONB/,
      /v_id UUID;|v_n INT;|v_matched UUID\[\]|v_unmatched UUID\[\]/, /auth\.role\(\) IS DISTINCT FROM 'service_role'/,
      /caller_is_active_member\(p_org\)|can_edit_project_schedule\(p_org, p_project\)/, /v_id := \(v_move->>'id'\)::uuid;|WHERE id = v_id/,
      /shift = CASE|WHEN \(v_move->>'start'\) IS NULL|EXTRACT\(HOUR FROM|ELSE 'night'|^\s*END,$/,
      /GET DIAGNOSTICS|IF v_n > 0 THEN|v_matched := |v_count := v_count \+ v_n;|v_unmatched := /,
      /RETURN jsonb_build_object\(|'count', v_count,|'matched', to_jsonb|'unmatched', to_jsonb|^\s*\);$/,
      /^\s*(ELSE|END IF;)$/,
      /^\s+AND project_id = p_project$/, // same predicate, semicolon moved to the lock clause
    ];
    for (const l of nonBlank(onlyInB)) {
      expect(allowed.some((re) => re.test(l)), `unexpected new line: ${l}`).toBe(true);
    }
    // The transaction shape and the UPDATE's core survive verbatim.
    for (const l of [
      "  FOR v_move IN SELECT jsonb_array_elements(p_moves) LOOP",
      "    UPDATE milestones",
      "    SET planned_start_at = (v_move->>'start')::timestamptz,",
      "        planned_at = (v_move->>'finish')::timestamptz,",
      "        updated_at = NOW(),",
      "        updated_by = v_uid",
      "      AND org_id = p_org",
      "      AND project_id = p_project",
      "  END LOOP;",
    ]) expect(next.split("\n")).toContain(l);
  });

  it("probes print anon's EXECUTE before (inventory) and after (probe), and the SCHED-9 recompute candidates", () => {
    expect(m98).toMatch(/has_function_privilege\('anon', 'public\.apply_milestone_moves\(uuid,uuid,jsonb\)', 'EXECUTE'\)::text END AS n/);
    expect(m98).toMatch(/NOT has_function_privilege\('anon', 'public\.apply_milestone_moves\(uuid,uuid,jsonb\)', 'EXECUTE'\),/);
    expect(m98).toMatch(/source IN \('p6', 'msproject', 'csv', 'mpxj'\) AND shift IS NOT NULL/);
    // prosrc probes are verbatim: apostrophes doubled, no bare casts
    expect(m98).toMatch(/p\.prosrc LIKE '%auth\.role\(\) IS DISTINCT FROM ''service_role''%'/);
  });
});

describe("20261099 — baseline authority, atomicity, history, audit (PC SCHED-3 / PT SAF-7)", () => {
  const setFn = between(m99, "CREATE OR REPLACE FUNCTION set_project_baseline(", "$$;\n");
  const clearFn = between(m99, "CREATE OR REPLACE FUNCTION clear_project_baseline(", "$$;\n");
  const guard = between(m99, "CREATE OR REPLACE FUNCTION milestones_baseline_write_guard()", "$$;\n");

  it("the RPCs enforce the SAME predicate as apply_milestone_moves and refuse the anon key the same way", () => {
    for (const fn of [setFn, clearFn]) {
      expect(fn).toMatch(/RETURNS jsonb\s*\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
      expect(fn).toMatch(/IF v_uid IS NULL THEN\s*\n\s*IF auth\.role\(\) IS DISTINCT FROM 'service_role' THEN/);
      expect(fn).toMatch(/IF NOT caller_is_active_member\(p_org\) THEN/);
      expect(fn).toMatch(/IF NOT can_edit_project_schedule\(p_org, p_project\) THEN\s*\n\s*RAISE EXCEPTION 'You do not have schedule-editing rights on this project' USING ERRCODE = '42501';/);
      expect(fn).toMatch(/PERFORM set_config\('app\.baseline_rpc', '1', true\);/);
      expect(fn).toMatch(/INSERT INTO milestone_baseline_history \(org_id, project_id, taken_by, reason, row_count, rows\)/);
      expect(fn).toMatch(/INSERT INTO audit_logs \(action, resource_type, resource_id, org_id, user_id, user_email, details\)/);
    }
    for (const name of ["set_project_baseline", "clear_project_baseline"]) {
      expect(m99).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${name}\\(uuid, uuid\\) FROM PUBLIC, anon;`));
      expect(m99).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${name}\\(uuid, uuid\\) TO authenticated, service_role;`));
    }
  });

  it("set: ONE UPDATE over the project (no half-apply), history of the prior snapshot first, SCHEDULE_BASELINED with count + history id", () => {
    expect(setFn.match(/UPDATE milestones/g)).toHaveLength(1);
    expect(setFn).toMatch(/SET baseline_start_at\s+= COALESCE\(planned_start_at, planned_at\),\s*\n\s*baseline_finish_at = planned_at,\s*\n\s*baseline_set_at\s+= NOW\(\),\s*\n\s*baseline_set_by\s+= v_uid\s*\n\s*WHERE org_id = p_org AND project_id = p_project;/);
    expect(setFn.indexOf("INSERT INTO milestone_baseline_history")).toBeLessThan(setFn.indexOf("UPDATE milestones"));
    expect(setFn).toMatch(/VALUES \(p_org, p_project, v_uid, 'rebaseline', v_prior_count, v_prior\)/);
    expect(setFn).toMatch(/GET DIAGNOSTICS v_count = ROW_COUNT;/);
    expect(setFn).toMatch(/'SCHEDULE_BASELINED', 'project', p_project::text, p_org, v_uid, NULLIF\(auth\.jwt\(\) ->> 'email', ''\)/);
    expect(setFn).toMatch(/RETURN jsonb_build_object\('count', v_count, 'previous_rows', v_prior_count, 'history_id', v_history\);/);
  });

  it("clear: nothing to clear returns 0 without a history row; otherwise history first, then NULLs, then SCHEDULE_BASELINE_CLEARED", () => {
    expect(clearFn).toMatch(/IF v_prior_count = 0 THEN\s*\n\s*RETURN jsonb_build_object\('count', 0, 'previous_rows', 0, 'history_id', NULL\);/);
    expect(clearFn).toMatch(/VALUES \(p_org, p_project, v_uid, 'clear', v_prior_count, v_prior\)/);
    expect(clearFn).toMatch(/SET baseline_start_at = NULL, baseline_finish_at = NULL, baseline_set_at = NULL, baseline_set_by = NULL/);
    expect(clearFn).toMatch(/'SCHEDULE_BASELINE_CLEARED'/);
  });

  it("the guard is a BEFORE UPDATE row trigger refusing any baseline_* change without the RPC flag (42501)", () => {
    expect(guard).toMatch(/RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public/);
    for (const c of ["baseline_start_at", "baseline_finish_at", "baseline_set_at", "baseline_set_by"]) {
      expect(guard).toMatch(new RegExp(`NEW\\.${c}\\s+IS DISTINCT FROM OLD\\.${c}`));
    }
    expect(guard).toMatch(/IF COALESCE\(current_setting\('app\.baseline_rpc', true\), ''\) <> '1' THEN\s*\n\s*RAISE EXCEPTION 'The baseline is set and cleared through set_project_baseline \/ clear_project_baseline only\.'\s*\n\s*USING ERRCODE = '42501';/);
    expect(m99).toMatch(/DROP TRIGGER IF EXISTS trg_milestones_baseline_write_guard ON milestones;\s*\nCREATE TRIGGER trg_milestones_baseline_write_guard\s*\n\s*BEFORE UPDATE ON milestones\s*\n\s*FOR EACH ROW EXECUTE FUNCTION milestones_baseline_write_guard\(\);/);
  });

  it("history: org + project scoped, RLS on, members read, no write policy at all", () => {
    const tbl = between(m99, "CREATE TABLE IF NOT EXISTS milestone_baseline_history (", ");");
    expect(tbl).toMatch(/org_id\s+UUID NOT NULL REFERENCES orgs\(id\) ON DELETE CASCADE/);
    expect(tbl).toMatch(/project_id\s+UUID NOT NULL REFERENCES projects\(id\) ON DELETE CASCADE/);
    expect(tbl).toMatch(/reason\s+TEXT NOT NULL CHECK \(reason IN \('rebaseline', 'clear'\)\)/);
    expect(tbl).toMatch(/rows\s+JSONB NOT NULL/);
    expect(m99).toMatch(/ALTER TABLE milestone_baseline_history ENABLE ROW LEVEL SECURITY;/);
    expect(m99).toMatch(/CREATE POLICY milestone_baseline_history_member_read ON milestone_baseline_history\s*\n\s*FOR SELECT TO authenticated\s*\n\s*USING \(caller_is_active_member\(org_id\)\);/);
    expect((m99.match(/CREATE POLICY/g) ?? []).length).toBe(1);
  });

  it("inventories half-applied baselines over LEAF rows (DEC-30) and probes the policy shape without bare casts", () => {
    expect(m99).toMatch(/NOT EXISTS \(SELECT 1 FROM milestones c WHERE c\.parent_id = m\.id\)/);
    expect(m99).toMatch(/HAVING COUNT\(\*\) FILTER \(WHERE m\.baseline_finish_at IS NOT NULL\) > 0\s*\n\s*AND COUNT\(\*\) FILTER \(WHERE m\.baseline_finish_at IS NULL\) > 0/);
    expect(m99).toMatch(/AND NOT EXISTS \(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'milestone_baseline_history'\s*\n\s*AND cmd IN \('INSERT', 'UPDATE', 'DELETE', 'ALL'\)\)/);
  });
});
