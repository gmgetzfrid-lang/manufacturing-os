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
