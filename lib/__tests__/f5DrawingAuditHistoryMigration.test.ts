// drafting-flow Round G, F5 DRAWING AUDIT HISTORY (EVID-14) — the shape of
// 20261270 and what the writers and readers of drawing_audit_logs do with it.
// The runtime proof is lib/__tests__/rls/f5DrawingAuditHistory.test.ts
// (npm run test:db); this file runs in the default suite.
//
//   * One DEC-30 paste: a prerequisite check, the counts-only inventory into a
//     TEMP TABLE before BEGIN, one transaction, ONE final SELECT (check, ok, n).
//     No apostrophe inside any SQL string literal.
//   * Nothing of drawing_audit_logs is re-created or dropped: no policy, index
//     or function of it; its key and three policies are probed unchanged.
//   * The history's read policy is the NEWEST drawing_audit_logs_read
//     expression (found by scanning supabase/migrations at test time) with the
//     table name swapped — never wider; no write policy; every write grant
//     revoked from anon, authenticated and service_role.
//   * DRLS-16: the one SECURITY DEFINER (the history trigger function) pins
//     search_path and revokes EXECUTE from PUBLIC, anon, authenticated and
//     service_role, and grants nothing.
//   * The writers name a source the CHECK allows; no reader of
//     drawing_audit_logs selects `source`, and nothing in app/ or lib/ reads
//     the history (every reader answers as before).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isMissingSourceColumn, writeWithSourceFallback, VERDICT_BOOKKEEPING_DETAILS } from "@/lib/drawingAuditLog";

const root = process.cwd();
const MIG = join(root, "supabase", "migrations");
const FILE = "20261270_df_roundG_drawing_audit_history.sql";
const sql = readFileSync(join(MIG, FILE), "utf8");
const stripSqlComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
const code = stripSqlComments(sql);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** The USING expression of the newest `CREATE POLICY <name> ON <table>` before `before`. */
function newestPolicyUsing(name: string, table: string, before: string): { file: string; using: string } {
  const files = readdirSync(MIG).filter((f) => /^\d{8}.*\.sql$/.test(f) && f < before).sort();
  let found: { file: string; using: string } | null = null;
  const re = new RegExp(`CREATE POLICY ${name} ON ${table}\\b[\\s\\S]*?USING\\s*\\(([\\s\\S]*?)\\);`, "g");
  for (const f of files) {
    const body = stripSqlComments(readFileSync(join(MIG, f), "utf8"));
    for (const m of body.matchAll(re)) found = { file: f, using: m[1] };
  }
  if (!found) throw new Error(`no definition of ${name} found`);
  return found;
}

describe("20261270 — one paste: prerequisite, inventory, transaction, one result set", () => {
  it("refuses without 20261124, captures the counts-only inventory before BEGIN, and ends in ONE SELECT after COMMIT", () => {
    const pre = code.indexOf("RAISE EXCEPTION '20261270 needs 20260929 and 20261124");
    const temp = code.indexOf("CREATE TEMP TABLE df_round_g_270_before AS");
    const begin = code.indexOf("BEGIN;");
    const commit = code.indexOf("COMMIT;");
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(pre).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(code.split("BEGIN;").length).toBe(2);
    expect(code.split("COMMIT;").length).toBe(2);
    expect(code.slice(Math.max(0, pre - 400), pre)).toMatch(/column_name = 'library_id'/);
    const tail = code.slice(commit + "COMMIT;".length);
    const outsideStrings = tail.replace(/'[^']*'/g, "''");
    expect(outsideStrings.split(";").filter((s) => s.trim()).length).toBe(1);
    expect(tail).toMatch(/^\s*SELECT v\."check", v\.ok, v\.n FROM \(/);
    // the inventory reads counts only — never a customer row
    const inv = code.slice(temp, begin);
    expect(inv).not.toMatch(/SELECT\s+\*/);
    for (const sel of inv.match(/SELECT \d, '[^']*',\s*[^\n]+/g) ?? []) expect(sel).toMatch(/COUNT\(\*\)|v_n::text/);
    expect((inv.match(/inventory \(before apply\)/g) ?? []).length).toBe(5);
  });

  it("no apostrophe inside any SQL string literal (the file has no escaped quote at all)", () => {
    expect(code).not.toContain("''");
    expect(code).not.toMatch(/[‘’]/);
  });

  it("nothing of drawing_audit_logs is re-created or dropped — no policy, index or function of it; only the column, its CHECK and three triggers are added", () => {
    expect(code).not.toMatch(/POLICY\s+\w+\s+ON\s+drawing_audit_logs\b/);
    expect(code).not.toMatch(/DROP INDEX/);
    expect(code).not.toMatch(/\bUPDATE drawing_audit_logs\b|\bDELETE FROM drawing_audit_logs\b|\bINSERT INTO drawing_audit_logs\b/);
    const alters = squash(code).match(/ALTER TABLE drawing_audit_logs [^;]+;/g) ?? [];
    expect(alters).toEqual([
      "ALTER TABLE drawing_audit_logs ADD COLUMN IF NOT EXISTS source TEXT;",
      "ALTER TABLE drawing_audit_logs DROP CONSTRAINT IF EXISTS drawing_audit_logs_source_check;",
      "ALTER TABLE drawing_audit_logs ADD CONSTRAINT drawing_audit_logs_source_check CHECK (source IS NULL OR source IN ('engine', 'orchestrator', 'human'));",
    ]);
    const triggers = [...code.matchAll(/CREATE TRIGGER (\w+)\s+(BEFORE|AFTER) ([A-Z ]+?) ON (\w+)/g)].map((m) => `${m[1]}|${m[2]} ${m[3]}|${m[4]}`);
    expect(triggers).toEqual([
      "trg_drawing_audit_logs_stamp_source|BEFORE INSERT OR UPDATE|drawing_audit_logs",
      "trg_drawing_audit_logs_history_update|AFTER UPDATE|drawing_audit_logs",
      "trg_drawing_audit_logs_history_delete|AFTER DELETE|drawing_audit_logs",
    ]);
  });

  it("history only on a change of substance: the UPDATE condition compares every column but id and audited_at, and audit_details without exactly VERDICT_BOOKKEEPING_DETAILS", () => {
    const when = squash(/CREATE TRIGGER trg_drawing_audit_logs_history_update\s+AFTER UPDATE ON drawing_audit_logs\s+FOR EACH ROW\s+WHEN ([\s\S]*?)\s+EXECUTE FUNCTION public\.drawing_audit_logs_record_history\(\);/.exec(code)![1]);
    const cols = ["org_id", "library_id", "document_id", "sheet_number", "revision_code", "status", "source"];
    expect(when).toContain(`(${cols.map((c) => `OLD.${c}`).join(", ")}) IS DISTINCT FROM (${cols.map((c) => `NEW.${c}`).join(", ")})`);
    expect(when).not.toMatch(/audited_at|OLD\.\*|OLD\.id\b/);
    const top = VERDICT_BOOKKEEPING_DETAILS.filter((k) => !k.includes("."));
    const nested = VERDICT_BOOKKEEPING_DETAILS.filter((k) => k.includes(".")).map((k) => k.split("."));
    expect(nested).toEqual([["set", "sheets"]]); // one nested path: #- takes one
    const stripped = (side: string) => `((${side}.audit_details - '{${top.join(",")}}'::text[]) #- '{${nested[0].join(",")}}'::text[])`;
    expect(when).toContain(`OR ${stripped("OLD")} IS DISTINCT FROM ${stripped("NEW")}`);
    // the columns compared are every column the table has, but id and audited_at (pinned below against the CREATE TABLE)
    expect([...cols, "id", "audit_details", "audited_at"].sort()).toEqual(["id", "org_id", "document_id", "sheet_number", "revision_code", "status", "audit_details", "audited_at", "library_id", "source"].sort());
  });

  it("the history is read with the NEWEST drawing_audit_logs_read expression, table name swapped — never wider; no write policy; every write grant revoked", () => {
    const newest = newestPolicyUsing("drawing_audit_logs_read", "drawing_audit_logs", FILE);
    const mine = newestPolicyUsing("drawing_audit_log_history_read", "drawing_audit_log_history", "99999999");
    expect(mine.file).toBe(FILE);
    expect(squash(mine.using)).toBe(squash(newest.using).replace("drawing_audit_logs.org_id", "drawing_audit_log_history.org_id"));
    const policies = [...code.matchAll(/CREATE POLICY (\w+) ON (\w+) FOR (\w+)/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}`);
    expect(policies).toEqual(["drawing_audit_log_history_read|drawing_audit_log_history|SELECT"]);
    expect(squash(code)).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON drawing_audit_log_history FROM anon, authenticated, service_role;");
    expect(code).not.toMatch(/GRANT\s+(ALL|INSERT|UPDATE|DELETE|SELECT|EXECUTE)/);
  });

  it("DRLS-16: the one SECURITY DEFINER pins search_path and revokes EXECUTE from every client role; the stamp function is SECURITY INVOKER", () => {
    const definers = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(\)[\s\S]*?SECURITY (DEFINER|INVOKER)\s+SET search_path = public\s+AS \$\$/g)].map((m) => `${m[1]}|${m[2]}`);
    expect(definers).toEqual(["drawing_audit_logs_stamp_source|INVOKER", "drawing_audit_logs_record_history|DEFINER"]);
    for (const fn of ["drawing_audit_logs_stamp_source", "drawing_audit_logs_record_history"]) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC, anon, authenticated, service_role;`);
    }
    // the definer census knows it (npm run test:db holds the live catalog to this list)
    expect(read("lib/__tests__/rls/definerDecisions.ts")).toMatch(/"drawing_audit_logs_record_history\(\)"/);
  });

  it("the history keeps the replaced row whole: every column drawing_audit_logs has (20260929 + 20261124 + this file) is copied from OLD", () => {
    const fnBody = code.slice(code.indexOf("FUNCTION public.drawing_audit_logs_record_history()"), code.indexOf("REVOKE ALL ON FUNCTION public.drawing_audit_logs_record_history()"));
    const values = squash(fnBody.slice(fnBody.indexOf("VALUES")));
    for (const col of ["id", "org_id", "library_id", "document_id", "sheet_number", "revision_code", "status", "source", "audit_details", "audited_at"]) {
      expect(values).toContain(`OLD.${col}`);
    }
    // and the table's own columns in 20260929 are exactly those, plus library_id (20261124) and source (here)
    const created = stripSqlComments(readFileSync(join(MIG, "20260929_mention_engine.sql"), "utf8"));
    const def = created.slice(created.indexOf("CREATE TABLE IF NOT EXISTS drawing_audit_logs ("));
    const cols = def.slice(def.indexOf("(") + 1, def.indexOf(");")).split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((c) => /^[a-z_]+$/.test(c));
    expect(cols).toEqual(["id", "org_id", "document_id", "sheet_number", "revision_code", "status", "audit_details", "audited_at"]);
    const later = readdirSync(MIG).filter((f) => /^\d{8}.*\.sql$/.test(f) && f !== FILE)
      .filter((f) => /ALTER TABLE (public\.)?drawing_audit_logs ADD COLUMN/.test(stripSqlComments(readFileSync(join(MIG, f), "utf8"))));
    expect(later).toEqual(["20261124_intel_roundG_drawing_audit_scope.sql"]);
  });
});

describe("EVID-14 — writers name a source the CHECK allows; every reader answers as before", () => {
  const route = read("app/api/knowledge/drawing/route.ts");
  const tools = read("lib/orchestrator/tools.ts");

  it("the drawing route writes engine and the orchestrator tool writes orchestrator, each through the 42703 / PGRST204 fallback, on 20261124's key only", () => {
    expect(route).toMatch(/writeWithSourceFallback\(\s*\(\) => supabaseAdmin\s*\.from\("drawing_audit_logs"\)\s*\.upsert\(rows\.map\(\(row\) => \(\{ \.\.\.row, source: "engine" as const \}\)\), \{ onConflict: "org_id,library_id,sheet_number,revision_code" \}\),\s*\(\) => supabaseAdmin\s*\.from\("drawing_audit_logs"\)\s*\.upsert\(rows, \{ onConflict: "org_id,library_id,sheet_number,revision_code" \}\),/);
    expect(tools).toMatch(/writeWithSourceFallback\(\s*\(\) => supabaseAdmin\.from\("drawing_audit_logs"\)\.upsert\(\{ \.\.\.row, library_id: null, source: "orchestrator" \}, \{ onConflict: "org_id,library_id,sheet_number,revision_code" \}\),\s*\(\) => supabaseAdmin\.from\("drawing_audit_logs"\)\.upsert\(\{ \.\.\.row, library_id: null \}, \{ onConflict: "org_id,library_id,sheet_number,revision_code" \}\),/);
    // the legacy key's write is untouched (20261270 needs 20261124)
    expect(route).toContain(`.upsert(rows.map(({ library_id: _library, ...row }) => row), { onConflict: "org_id,sheet_number,revision_code" })`);
    expect(tools).toContain(`? await supabaseAdmin.from("drawing_audit_logs").upsert(row, { onConflict: "org_id,sheet_number,revision_code" })`);
    const allowed = /CHECK \(source IS NULL OR source IN \(([^)]*)\)\)/.exec(code)![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    for (const s of [/\.\.\.row, source: "(\w+)" as const/.exec(route)![1], /library_id: null, source: "(\w+)" \}/.exec(tools)![1]]) expect(allowed).toContain(s);
  });

  it("no reader selects source, and nothing in app/, lib/ or components/ names the table drawing_audit_log_history (every current-row read is unchanged)", () => {
    for (const [name, text] of [["route", route], ["tools", tools]] as const) {
      for (const m of text.matchAll(/from\("drawing_audit_logs"\)\s*\.select\(([^)]*)\)/g)) expect(m[1], name).not.toMatch(/source/);
    }
    // the readers' column lists, as on the base
    expect(route).toContain(`.select(scoped ? "sheet_number, revision_code, status, audit_details, library_id" : "sheet_number, revision_code, status, audit_details",`);
    expect(tools).toContain(`await read("sheet_number, revision_code, status, audited_at, audit_details, library_id")`);
    expect(tools).toContain(`.from("drawing_audit_logs").select("status, revision_code, audit_details, library_id")`);
    expect(tools).toContain(`.from("drawing_audit_logs").select("status, revision_code, audit_details")`);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(p); }
        else if (/\.(ts|tsx)$/.test(e.name) && /["'`]drawing_audit_log_history["'`]/.test(read(p))) hits.push(p);
      }
    };
    walk("app"); walk("lib"); walk("components");
    expect(hits).toEqual([]);
  });
});

describe("writeWithSourceFallback — today's write only when the column is missing (nothing was written)", () => {
  type E = { code?: string; message?: string } | null;
  const run = async (first: E, second: E = null) => {
    const calls: string[] = [];
    const out = await writeWithSourceFallback<E>(
      async () => { calls.push("with source"); return { error: first }; },
      async () => { calls.push("today"); return { error: second }; },
    );
    return { calls, out };
  };

  it("success: one write", async () => {
    expect(await run(null)).toEqual({ calls: ["with source"], out: { error: null } });
  });

  it("PGRST204 / 42703 / the missing-column messages: today's write, and its answer", async () => {
    for (const e of [
      { code: "PGRST204", message: "Could not find the 'source' column of 'drawing_audit_logs' in the schema cache" },
      { code: "42703", message: 'column "source" of relation "drawing_audit_logs" does not exist' },
      { message: 'column "source" of relation "drawing_audit_logs" does not exist' },
    ]) {
      expect(isMissingSourceColumn(e)).toBe(true);
      expect(await run(e, { code: "23505", message: "dup" })).toEqual({ calls: ["with source", "today"], out: { error: { code: "23505", message: "dup" } } });
    }
  });

  it("any other refusal: the first answer, no second write", async () => {
    for (const e of [{ code: "23514", message: "check" }, { code: "42501", message: "rls" }, { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" }]) {
      expect(isMissingSourceColumn(e)).toBe(false);
      expect(await run(e)).toEqual({ calls: ["with source"], out: { error: e } });
    }
  });
});
