// intelligence Round G (I-23) — 20261194_intel_roundG_mention_run_state.sql:
// the mention index's run state (IRLS-14, done-when 1's remainder).
//
// Shape (the one-paste protocol, DEC-30: inventory TEMP TABLE before BEGIN,
// aggregate counts only; DDL inside BEGIN/COMMIT; ONE final SELECT of
// (check, ok, n)); the table the code reads and writes, column for column;
// RLS (a member reads only their own org's row; only the service role
// writes) and that the file creates no function, trigger or view — a new
// table, so there is no earlier body to pin with a lineDiff. The policies
// were exercised on a throwaway PostgreSQL 16 (IRLS-14's Resolution).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MENTION_RUN_COLUMNS, MENTION_RUN_MEMBER_COLUMNS, MENTION_RUNS_TABLE } from "@/lib/mentionRunState";

const MIG = join(process.cwd(), "supabase", "migrations");
const FILE = "20261194_intel_roundG_mention_run_state.sql";
const sql = readFileSync(join(MIG, FILE), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
const code = strip(sql);
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const tx = code.slice(code.indexOf("\nBEGIN;"), code.indexOf("\nCOMMIT;"));

describe("20261194 — the one-paste shape", () => {
  it("is the only file numbered 20261194, named for its round", () => {
    expect(readdirSync(MIG).filter((f) => f.startsWith("20261194"))).toEqual([FILE]);
    expect(FILE).toMatch(/^20261194_intel_roundG_[a-z_]+\.sql$/);
  });

  it("inventory before BEGIN, aggregate counts only; DDL inside one BEGIN/COMMIT; one final SELECT of (check, ok, n)", () => {
    const temp = code.indexOf("CREATE TEMP TABLE _intel_g94_before");
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(commit).toBeGreaterThan(begin);
    expect((code.match(/\nBEGIN;/g) ?? []).length).toBe(1);
    expect((code.match(/\nCOMMIT;/g) ?? []).length).toBe(1);
    const inventory = code.slice(temp, begin);
    const branches = inventory.split(/\bUNION ALL\b/);
    expect(branches.length).toBe(5);
    // The first branch says whether this is a re-run; every other is a COUNT.
    expect(branches[0]).toMatch(/to_regclass\('public\.mention_index_runs'\)/);
    for (const b of branches.slice(1)) expect(b).toMatch(/COUNT\(\*\)/);
    // Never a customer row: no column of a row is selected, only counts.
    expect(inventory).not.toMatch(/SELECT\s+(id|name|uid|email|file_key|org_id)\b/i);
    const tail = code.slice(commit + "\nCOMMIT;".length).trim();
    expect(tail.startsWith("SELECT")).toBe(true);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,\s*NULL::text AS n/);
    expect((tail.match(/;/g) ?? []).length).toBe(1);
    expect(tail).toMatch(/SELECT 'inventory \(before\): ' \|\| what, NULL, n::text FROM _intel_g94_before;$/);
    // Inventory rows carry ok NULL; the after-count too.
    expect(tail).toMatch(/SELECT 'after: mention_index_runs rows[^']*', NULL,\s*\(SELECT COUNT\(\*\) FROM mention_index_runs\)::text/);
  });

  it("probes LIKE only on deparsed text, never on a bare cast", () => {
    const likes = [...code.matchAll(/LIKE\s+'([^']*)'/g)].map((m) => m[1]);
    expect(likes.length).toBeGreaterThan(0);
    for (const l of likes) expect(l, l).not.toMatch(/::/);
  });
});

describe("20261194 — the table the code reads and writes", () => {
  const body = /CREATE TABLE IF NOT EXISTS mention_index_runs \(([\s\S]*?)\n\);/.exec(tx)?.[1] ?? "";
  const columns = [...body.matchAll(/^\s+([a-z_]+)\s+[A-Z]/gm)].map((m) => m[1]);

  it("one row per org: org_id the key, gone with its org", () => {
    expect(body).toMatch(/org_id\s+UUID PRIMARY KEY REFERENCES orgs\(id\) ON DELETE CASCADE/);
    expect(MENTION_RUNS_TABLE).toBe("mention_index_runs");
  });

  it("creates exactly the columns lib/mentionRunState.ts names (plus updated_at), each also added IF NOT EXISTS for a re-paste", () => {
    const read = MENTION_RUN_COLUMNS.split(",").map((c) => c.trim());
    expect([...columns].sort()).toEqual([...read, "updated_at"].sort());
    for (const c of columns.filter((c) => c !== "org_id")) {
      expect(tx, c).toMatch(new RegExp(`ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS ${c} `));
    }
    // Every column the writers name exists too (start, end, failure, place).
    const lib = src("lib/mentionRunState.ts");
    const written = new Set([...lib.matchAll(/\b(last_[a-z_]+|backfill_[a-z_]+|updated_at|org_id):/g)].map((m) => m[1]));
    for (const c of written) expect(columns, c).toContain(c);
  });

  it("the CHECKs hold the vocabulary the code writes", () => {
    expect(tx).toMatch(/CHECK \(last_run_source IN \('ingest', 'map'\)\)/);
    expect(tx).toMatch(/CHECK \(last_failed_source IN \('ingest', 'map'\)\)/);
    expect(tx).toMatch(/CHECK \(last_run_outcome IN \('running', 'succeeded', 'failed', 'stopped'\)\)/);
    expect(tx).toMatch(/CHECK \(backfill_state IN \('running', 'time_limit', 'failed'\)\)/);
    // The dictionary's fingerprint is a sha256 in hex (64), well under its cap.
    expect(tx).toMatch(/CHECK \(backfill_dictionary IS NULL OR char_length\(backfill_dictionary\) <= 128\)/);
    expect(src("lib/mentionIndexer.ts")).toMatch(/createHash\("sha256"\)[\s\S]*?\.digest\("hex"\)/);
    const lib = src("lib/mentionRunState.ts");
    expect(lib).toMatch(/export type MentionRunSource = "ingest" \| "map";/);
    expect(lib).toMatch(/export type MentionRunOutcome = "running" \| "succeeded" \| "failed" \| "stopped";/);
    expect(lib).toMatch(/export type BackfillState = "running" \| "time_limit" \| "failed";/);
    // The plain-words sentence is capped below the column's CHECK.
    expect(lib).toMatch(/const ERROR_MAX = 500;/);
    expect(tx).toMatch(/char_length\(last_failed_error\) <= 2000/);
  });

  it("RLS: a member reads only their own org's row; only the service role writes; anon holds nothing", () => {
    expect(tx).toMatch(/ALTER TABLE mention_index_runs ENABLE ROW LEVEL SECURITY;/);
    const policies = [...tx.matchAll(/CREATE POLICY (\w+) ON mention_index_runs FOR (\w+)/g)].map((m) => [m[1], m[2]]);
    expect(policies).toEqual([["mention_index_runs_member_read", "SELECT"]]);
    expect(tx).toMatch(/FOR SELECT TO authenticated\s+USING \(EXISTS \(SELECT 1 FROM org_members m\s+WHERE m\.org_id = mention_index_runs\.org_id\s+AND m\.uid = auth\.uid\(\)\s+AND m\.status = 'active'\)\);/);
    expect(tx).toMatch(/REVOKE ALL ON TABLE mention_index_runs FROM anon, authenticated;/);
    expect(tx).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mention_index_runs TO service_role;/);
    // Writes are never granted to a signed-in session.
    expect(tx).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*TO[^;]*authenticated/);
  });

  it("review minor: a member is granted SELECT on the member columns only — exactly MENTION_RUN_MEMBER_COLUMNS, which the reader selects — never a document id, the cursor, the run id or the fingerprint", () => {
    expect(tx).not.toMatch(/GRANT SELECT ON TABLE mention_index_runs TO authenticated/);
    const grants = [...tx.matchAll(/GRANT SELECT \(([^)]*)\)\s+ON TABLE mention_index_runs TO authenticated;/g)];
    expect(grants).toHaveLength(1);
    const granted = grants[0][1].split(",").map((c) => c.trim()).sort();
    expect(granted).toEqual(MENTION_RUN_MEMBER_COLUMNS.split(",").map((c) => c.trim()).sort());
    for (const c of ["last_run_id", "last_run_document_id", "last_failed_document_id", "backfill_cursor", "backfill_dictionary"]) {
      expect(granted, c).not.toContain(c);
    }
    expect(src("lib/mentionRunState.ts")).toMatch(/\.select\(MENTION_RUN_MEMBER_COLUMNS\)\.eq\("org_id", orgId\)\.maybeSingle\(\)/);
    // The probe pins the same twelve after apply.
    expect(code).toMatch(/has_column_privilege\('authenticated', 'public\.mention_index_runs', c\.column_name, 'SELECT'\)\) = 12/);
  });

  it("creates no function (no SECURITY DEFINER for DRLS-16), trigger or view, and changes no existing row", () => {
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER|VIEW)/i);
    expect(code).not.toMatch(/SECURITY DEFINER/i);
    expect(code).not.toMatch(/\b(UPDATE\s+\w+\s+SET|DELETE FROM|INSERT INTO)\b/i);
    // The only DROPs are of its own temp table, constraints and policy (re-run).
    for (const m of code.matchAll(/DROP\s+(\w+)/g)) expect(["TABLE", "CONSTRAINT", "POLICY"]).toContain(m[1]);
    expect(code).toMatch(/DROP TABLE IF EXISTS pg_temp\._intel_g94_before;/);
  });

  it("the header states the paste and deploy order, what runs unpasted, the widening and who writes — no more than the code does", () => {
    expect(sql).toMatch(/Apply AFTER 20260929_mention_engine\.sql/);
    expect(sql).toMatch(/The app may be deployed before\n-- or after the paste, and keeps working while it is unpasted/);
    expect(sql).toMatch(/\(PGRST205 \/ 42P01\) or a missing\n-- column \(42703 \/ PGRST204\) as "no run state"/);
    expect(sql).toMatch(/WIDENING\? Yes, narrowly/);
    expect(sql).toMatch(/The knowledge-document ids\n-- \(last_run_document_id, last_failed_document_id, backfill_cursor\), the\n-- build's run id and the dictionary's fingerprint are NOT granted/);
    expect(sql).toMatch(/No document id, name or text,\n-- no person\./);
    expect(sql).toMatch(/WHO WRITES: the service role only/);
    expect(sql).toMatch(/no SECURITY DEFINER body for DRLS-16's revoke and grant/);
  });
});

describe("20261194 — the code tolerates the table being absent (today's behaviour)", () => {
  const lib = src("lib/mentionRunState.ts");

  it("the four missing-schema codes are 'not installed', and every writer and reader catches", () => {
    expect(lib).toMatch(/code === "PGRST205" \|\| code === "42P01" \|\| code === "42703" \|\| code === "PGRST204"/);
    for (const fn of ["readMentionRunState", "startMentionRun", "finishMentionRun", "recordMentionFailure", "clearStandingFailure", "saveBackfillCursor", "clearBackfillCursor"]) {
      const at = lib.indexOf(`export async function ${fn}(`);
      expect(at, fn).toBeGreaterThan(-1);
      const next = lib.indexOf("\nexport ", at + 10);
      expect(lib.slice(at, next < 0 ? undefined : next), fn).toMatch(/\} catch/);
    }
  });

  it("the builders record through it, the map reads through it", () => {
    expect(src("lib/knowledgeIngest.ts")).toMatch(/startMentionRun\(supabaseAdmin, doc\.org_id, "ingest", doc\.id\)/);
    expect(src("lib/mentionIndexer.ts")).toMatch(/startMentionRun\(supabaseAdmin, orgId, "map"\)/);
    expect(src("app/(protected)/graph/page.tsx")).toMatch(/readMentionRunState\(supabase, activeOrgId\)/);
  });

  it("the ingest pass no longer swallows a failure with an empty catch", () => {
    const ingest = src("lib/knowledgeIngest.ts");
    const fn = ingest.slice(ingest.indexOf("export async function rebuildDocumentMentions("), ingest.indexOf("export async function onDocumentReady("));
    expect(fn).not.toMatch(/catch \{ \/\*/);
    expect(fn).toMatch(/finishMentionRun\(supabaseAdmin, await started, \{ outcome: "failed", error: e \}\)/);
    // Both the start (beside the build) and a pass that could not start are inside the cap.
    expect(fn).toMatch(/await capped\(build\);/);
    expect(fn).toMatch(/await capped\(recordMentionFailure\(/);
    expect(fn).toMatch(/recordMentionFailure\(supabaseAdmin, doc\.org_id, "ingest", doc\.id, e\)/);
  });
});
