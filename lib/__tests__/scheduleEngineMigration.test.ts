// lib/__tests__/scheduleEngineMigration.test.ts
//
// projects Round G — J6b SCHEDULE-ENGINE: PT SCH-7's realtime half.
//
//   20261106 puts `milestones` in the supabase_realtime publication (the board
//   subscribed to postgres_changes on a table no migration ever published).
//   One script: header, DEC-30 inventory in a TEMP TABLE before the
//   transaction (was it already published by hand?), BEGIN … COMMIT, one
//   final SELECT of (check, ok, n) — the probes and the inventory rows.
//
//   And the client half ScheduleTab owns: each batch move carries the row's
//   updated_at as loaded (the lock 20261098 checks), rejected moves come back
//   by id (onUnmatched: "return") and are named, rows that did move in a race
//   come back with their locks so they can be undone, and the realtime
//   channel listens to INSERT / UPDATE in this project only — never DELETE,
//   which Supabase delivers for every workspace without an RLS check.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mig = readFileSync(join(process.cwd(), "supabase", "migrations", "20261106_prj_roundG_milestones_realtime.sql"), "utf8");
const tab = readFileSync(join(process.cwd(), "components", "projects", "ScheduleTab.tsx"), "utf8");

describe("20261106 — milestones in supabase_realtime (PT SCH-7 / RT-12)", () => {
  it("one script: inventory temp table before BEGIN, BEGIN … COMMIT, then ONE final SELECT with (check, ok, n)", () => {
    const temp = mig.indexOf("CREATE TEMP TABLE");
    const begin = mig.indexOf("\nBEGIN;");
    const commit = mig.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(temp);
    expect(commit).toBeGreaterThan(begin);
    const tail = mig.slice(commit + "\nCOMMIT;".length);
    expect(tail).toMatch(/AS check,\s*\n/);
    expect(tail).toMatch(/ AS ok,\s*\n\s+NULL::text AS n/);
    expect(tail).toMatch(/UNION ALL\s*\nSELECT "check", NULL::boolean, n FROM prj_roundg_realtime_inventory;\s*$/);
    expect((tail.match(/;/g) ?? []).length).toBe(1); // exactly one statement after COMMIT
    const code = mig.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
    expect(code.match(/(?<!AS |")\bcheck\b(?!")/g) ?? []).toEqual([]);
  });
  it("the inventory is aggregate counts only, and records whether the table was already published by hand", () => {
    const inv = mig.slice(mig.indexOf("CREATE TEMP TABLE"), mig.indexOf("\nBEGIN;"));
    expect(inv).toMatch(/COUNT\(\*\)::text/);
    expect(inv).not.toMatch(/SELECT \*/);
    expect(inv).toMatch(/pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'milestones'/);
  });
  it("adds the table idempotently, only when the publication exists and the table is not in it; nothing else", () => {
    const body = mig.slice(mig.indexOf("\nBEGIN;"), mig.indexOf("\nCOMMIT;"));
    expect(body).toMatch(/IF EXISTS \(SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'\)\s+AND NOT EXISTS \(SELECT 1 FROM pg_publication_tables\s+WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'milestones'\) THEN\s+ALTER PUBLICATION supabase_realtime ADD TABLE public\.milestones;/);
    expect(body).not.toMatch(/POLICY|GRANT|REVOKE|FUNCTION|TRIGGER|REPLICA IDENTITY|DROP /);
  });
  it("probes the publication and that RLS still guards what realtime delivers", () => {
    expect(mig).toMatch(/'milestones is in the supabase_realtime publication' AS check/);
    expect(mig).toMatch(/c\.relname = 'milestones' AND c\.relrowsecurity/);
  });
  it("the header says what it widens: DELETE events carry the id of every deleted milestone, unchecked by RLS (review)", () => {
    const header = mig.slice(0, mig.indexOf("CREATE TEMP TABLE"));
    expect(header).toMatch(/WIDENING, id-only: Supabase does NOT apply RLS to DELETE events/);
    expect(header).toMatch(/NOT subscribe to DELETE/);
    expect(header).not.toMatch(/NOT widening/);
  });
});

describe("ScheduleTab — the lock, the named rejections and the live channel (PT SCH-7)", () => {
  it("each move carries the loaded row's updated_at (or the Undo's pinned value) and asks for the rejected ids back", () => {
    expect(tab).toMatch(/expectedUpdatedAt: opts\?\.expectedUpdatedAt\?\.\[c\.id\] \?\? \(loaded\.get\(c\.id\) as string \| null \| undefined\) \?\? undefined/);
    expect(tab).toMatch(/onUnmatched: "return"/);
    expect(tab).toMatch(/changed by someone else and \$\{names\.length === 1 \? "was" : "were"\} not moved: \$\{names\.slice\(0, 5\)\.join\(", "\)\}/);
    expect(tab).toMatch(/setMilestones\(\(arr\) => arr\.map\(\(m\) => \(m\.id && stamps\[m\.id\] \? \{ \.\.\.m, updatedAt: stamps\[m\.id\] \} : m\)\)\)/);
  });
  it("a partly written batch hands back the rows that moved and their new locks (so the board can undo them), and every failure carries its reason", () => {
    expect(tab).toMatch(/return \{ ok: false, matched: res\.matched, updatedAt: res\.updatedAt, error: reason \};/);
    expect(tab).toMatch(/return \{ ok: false, error: \(e as Error\)\.message \};/);
    expect(tab).not.toMatch(/return \{ ok: false \};/);
  });
  it("INSERT / UPDATE are filtered on project_id; DELETE is NOT subscribed (RLS is not applied to DELETE events)", () => {
    expect(tab).toMatch(/event: "INSERT", schema: "public", table: "milestones", filter: `project_id=eq\.\$\{projectId\}`/);
    expect(tab).toMatch(/event: "UPDATE", schema: "public", table: "milestones", filter: `project_id=eq\.\$\{projectId\}`/);
    expect(tab).not.toMatch(/event: "DELETE"/);
  });
  it("PT SAF-7: the re-baseline confirm names the baseline it replaces and promises 'kept' only when the database keeps it", () => {
    expect(tab).toMatch(/Replace the baseline \$\{setOn \? `set on \$\{setOn\} ` : ""\}\(\$\{baselineNow\.rowCount\} task/);
    expect(tab).toMatch(/const kept = baselineNow \? await baselineHistoryAvailable\(\{ orgId, projectId \}\) : null;/);
    expect(tab).toMatch(/kept === true\s*\? "The one you replace is kept — the Report can still measure drift against it/);
    expect(tab).toMatch(/: kept === false\s*\? "This database does not keep replaced baselines yet \(the baseline-history migration is not applied\): the one you replace is overwritten and cannot be recovered/);
    expect(tab).not.toMatch(/the one it replaces is kept, and the Report/); // the button's tooltip no longer promises it either
  });
  it("PT SCH-6: the board gets the FULL list and hides imported rows itself; the planning rollup reads the full list", () => {
    expect(tab).toMatch(/<ExecutionView\s+milestones=\{milestones\}\s+hideImported=\{!showGhost\}/);
    expect(tab).toMatch(/const planProgress = useMemo\(\(\) => buildProgressIndex\(milestones\), \[milestones\]\);/);
  });
});

// ── PT SCH-17 (review fix): 20261107 — a phase delete is all or nothing ────
const del = readFileSync(join(process.cwd(), "supabase", "migrations", "20261107_prj_roundG_milestone_delete.sql"), "utf8");
const delLib = readFileSync(join(process.cwd(), "lib", "milestones.ts"), "utf8");

describe("20261107 — delete_milestone_keep_subtree: promote, unlink and delete in one transaction, the DELETE checked (PT SCH-17)", () => {
  it("one script: inventory temp table before BEGIN, BEGIN … COMMIT, then ONE final SELECT with (check, ok, n)", () => {
    const temp = del.indexOf("CREATE TEMP TABLE");
    const begin = del.indexOf("\nBEGIN;");
    const commit = del.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(temp);
    expect(commit).toBeGreaterThan(begin);
    const tail = del.slice(commit + "\nCOMMIT;".length);
    expect(tail).toMatch(/AS check,\s*\n/);
    expect(tail).toMatch(/ AS ok,\s*\n\s+NULL::text AS n/);
    expect(tail).toMatch(/UNION ALL\s*\nSELECT "check", NULL::boolean, n FROM prj_roundg_milestone_delete_inventory;\s*$/);
    // exactly one statement after COMMIT (a ';' inside a probe's LIKE literal is not one)
    expect((tail.replace(/'(?:[^']|'')*'/g, "''").match(/;/g) ?? []).length).toBe(1);
    const code = del.replace(/--[^\n]*/g, "").replace(/\$\$[\s\S]*?\$\$/g, "$$$$").replace(/'(?:[^']|'')*'/g, "''");
    expect(code.match(/(?<!AS |")\bcheck\b(?!")/g) ?? []).toEqual([]);
  });
  it("the inventory is aggregate counts only (no customer rows)", () => {
    const inv = del.slice(del.indexOf("CREATE TEMP TABLE"), del.indexOf("\nBEGIN;"));
    expect(inv).toMatch(/COUNT\(\*\)::text/);
    expect(inv).not.toMatch(/SELECT \*/);
  });
  it("SECURITY INVOKER (RLS — the delete guard — still decides), search_path pinned, EXECUTE revoked from PUBLIC and anon", () => {
    expect(del).toMatch(/CREATE OR REPLACE FUNCTION delete_milestone_keep_subtree\(p_id uuid\)\nRETURNS jsonb\nLANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS \$\$/);
    expect(del).not.toMatch(/SECURITY DEFINER/);
    expect(del).toMatch(/REVOKE ALL ON FUNCTION delete_milestone_keep_subtree\(uuid\) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION delete_milestone_keep_subtree\(uuid\) TO authenticated, service_role;/);
    const body = del.slice(del.indexOf("\nBEGIN;"), del.indexOf("\nCOMMIT;"));
    expect(body).not.toMatch(/CREATE POLICY|DROP POLICY|CREATE TRIGGER|ALTER TABLE/);
  });
  it("the order inside: promote the children, unlink the dependents, then DELETE — and 0 rows deleted RAISEs (rolling both back)", () => {
    const fn = del.slice(del.indexOf("CREATE OR REPLACE FUNCTION delete_milestone_keep_subtree"), del.indexOf("REVOKE ALL ON FUNCTION"));
    const promote = fn.indexOf("SET parent_id = v_new_parent");
    const unlink = fn.indexOf("WHERE x.e <> to_jsonb(p_id::text)");
    const delAt = fn.indexOf("DELETE FROM milestones WHERE id = p_id;");
    expect(promote).toBeGreaterThan(0);
    expect(unlink).toBeGreaterThan(promote);
    expect(delAt).toBeGreaterThan(unlink);
    expect(fn.slice(delAt)).toMatch(/^DELETE FROM milestones WHERE id = p_id;\n\s+GET DIAGNOSTICS v_n = ROW_COUNT;\n\s+IF v_n = 0 THEN\n\s+RAISE EXCEPTION 'You cannot delete this task — nothing was changed'\n\s+USING ERRCODE = '42501'/);
    expect(fn).not.toMatch(/EXCEPTION\s+WHEN/); // nothing swallows the raise
    // The dependents are scoped like the client's read: the project, or the org for a row with no project.
    expect(fn).toMatch(/CASE WHEN v_row\.project_id IS NOT NULL THEN d\.project_id = v_row\.project_id\s+ELSE d\.org_id = v_row\.org_id END/);
  });
  it("the probes: exists, invoker, pinned, the checked delete, anon refused, authenticated granted, the guard still RESTRICTIVE", () => {
    for (const probe of [
      "'delete_milestone_keep_subtree(uuid) exists' AS check",
      "AND NOT p.prosecdef",
      "p.proconfig @> ARRAY['search_path=public']",
      "p.prosrc LIKE '%GET DIAGNOSTICS v_n = ROW_COUNT;%'",
      "NOT has_function_privilege('anon', 'public.delete_milestone_keep_subtree(uuid)', 'EXECUTE')",
      "has_function_privilege('authenticated', 'public.delete_milestone_keep_subtree(uuid)', 'EXECUTE')",
      "AND permissive = 'RESTRICTIVE' AND cmd = 'DELETE'",
    ]) expect(del).toContain(probe);
  });
  it("the client calls it first, and its fallback deletes FIRST with the row read back (source pin)", () => {
    const fnSrc = delLib.slice(delLib.indexOf("export async function deleteMilestone("), delLib.indexOf("// ─── Reads ──"));
    const rpc = fnSrc.indexOf('supabase.rpc("delete_milestone_keep_subtree", { p_id: id })');
    const delFirst = fnSrc.indexOf('.delete().eq("id", id).select("id")');
    const firstUpdate = fnSrc.indexOf(".update(");
    expect(rpc).toBeGreaterThan(0);
    expect(delFirst).toBeGreaterThan(rpc);
    expect(firstUpdate).toBeGreaterThan(delFirst);
    expect(fnSrc).toMatch(/if \(!Array\.isArray\(gone\) \|\| gone\.length === 0\) throw new MilestoneDeleteRefusedError\(m\.name\);/);
  });
});
