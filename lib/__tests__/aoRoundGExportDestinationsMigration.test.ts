// admin-and-org Round G, package P2 — BKP-11 Done-when 1 (DEC-78):
// 20261154 narrows what a member can read of export_destinations to the
// card columns. Shape tests over the one-paste file (DEC-30 / the protocol:
// inventory TEMP table of counts before BEGIN, one transaction, ONE final
// (check, ok, n) SELECT) and over what it relies on.
//
// Reproduced on base 2290b94: 20260605_rls_policies_new_tables.sql:141-144
// is the only definition of export_dest_member_select — `FOR SELECT TO
// authenticated USING (EXISTS (… org_members … uid = auth.uid() … 'active'))`
// with no column restriction and no REVOKE anywhere in the sequence, so every
// active member could select *_encrypted.
//
// Second review fix pass: export_runs_member_select (20260605:147-150, the
// only definition) let the same members read every column of export_runs —
// destination_path (the webhook URL, or <bucket>/<key>), diagnostics (the
// push step naming the same) and error_message (the raw runner message). The
// file now narrows export_runs to its card columns too.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { censusSchema } from "./helpers/schemaKeys";
import { REDACT_COLUMNS } from "@/lib/exportTables";

const root = process.cwd();
const MIGRATIONS = join(root, "supabase", "migrations");
const FILE = "20261154_ao_roundG_export_destinations_select.sql";
const raw = readFileSync(join(MIGRATIONS, FILE), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");
const numbered = readdirSync(MIGRATIONS).filter((n) => /^\d{8}.*\.sql$/.test(n)).sort();

const CREDENTIALS = ["access_key_id_encrypted", "secret_access_key_encrypted", "webhook_secret_encrypted"];
const COORDINATES = ["endpoint", "region", "bucket", "prefix", "webhook_url"];
/** Fix pass: the runner's raw error message can carry the coordinates (a DNS
 *  failure names the host; a webhook failure carries the remote's body). */
const RAW_ERRORS = ["last_run_error"];

function grantedColumns(table = "export_destinations"): string[] {
  const m = sql.match(new RegExp(`GRANT\\s+SELECT\\s*\\(([^)]*)\\)\\s*ON\\s+TABLE\\s+${table}\\s+TO\\s+authenticated\\s*;`, "i"));
  expect(m, `the column grant on ${table}`).not.toBeNull();
  return m![1].split(",").map((c) => c.trim()).filter(Boolean);
}
/** export_runs columns a member never reads: where a run went, its step
 *  trace, its raw error, the archive link, and who triggered it by address. */
const RUN_WITHHELD = ["destination_path", "diagnostics", "error_message", "download_url", "download_url_expires_at", "triggered_by_email"];

describe("20261154 — the one-paste shape", () => {
  it("inventory TEMP table (counts only) before ONE transaction, then ONE final (check, ok, n) SELECT", () => {
    const temp = sql.indexOf("CREATE TEMP TABLE _ao_g54_before");
    const begin = sql.indexOf("BEGIN;");
    const commit = sql.indexOf("COMMIT;");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(sql.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(sql.match(/\bCOMMIT;/g)).toHaveLength(1);
    const tail = sql.slice(commit + "COMMIT;".length).trim();
    // exactly one statement after COMMIT, ending the file
    expect(tail.split(";").filter((x) => x.trim()).length).toBe(1);
    expect(tail).toMatch(/^SELECT '[^']+' AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    expect(tail).toMatch(/UNION ALL SELECT inventory, NULL, n FROM _ao_g54_before;$/);
    // the inventory reads counts, never rows
    const inventory = sql.slice(temp, begin);
    for (const sel of inventory.split(/UNION ALL/)) expect(sel).toMatch(/COUNT\(\*\)::text|THEN 1 ELSE 0 END\)::text/);
    expect(inventory).not.toMatch(/SELECT\s+\*/i);
  });

  it("probes never put a cast inside a LIKE pattern (pg_policies.qual is deparsed)", () => {
    for (const m of sql.matchAll(/LIKE\s+'([^']*)'/g)) expect(m[1]).not.toMatch(/::/);
  });

  it("defines no function, policy or trigger (nothing to pin; migrationSourceOfTruth / searchPathPin unaffected)", () => {
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(sql).not.toMatch(/CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY/i);
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i);
  });

  it("the header carries the rollback to the previous privileges, one line per table", () => {
    expect(raw).toMatch(/--\s+GRANT SELECT ON export_destinations TO anon, authenticated;/);
    expect(raw).toMatch(/--\s+GRANT SELECT ON export_runs TO anon, authenticated;/);
  });
});

describe("20261154 — the narrowing is a privilege, the policy is kept (the reversible option)", () => {
  it("the member policy is defined once in the whole sequence (20260605), and this file leaves it as it is", () => {
    const definers = numbered.filter((f) => /CREATE\s+POLICY\s+"?export_dest_member_select"?/i.test(readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "")));
    expect(definers).toEqual(["20260605_rls_policies_new_tables.sql"]);
    // and no earlier file ever narrowed the privilege (the defect, on base)
    const earlier = numbered.filter((f) => f < FILE);
    for (const f of earlier) {
      expect(readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, ""), f).not.toMatch(/(REVOKE|GRANT)\s+[^;]*\bON\s+(TABLE\s+)?export_destinations\b/i);
    }
  });

  it("revokes the table-level SELECT from PUBLIC, anon and authenticated", () => {
    expect(sql).toMatch(/REVOKE\s+SELECT\s+ON\s+TABLE\s+export_destinations\s+FROM\s+PUBLIC,\s*anon,\s*authenticated\s*;/i);
  });

  it("grants back exactly the card columns: every column of the table but the credentials, the coordinates and the raw run error", () => {
    const cols = [...(censusSchema().get("export_destinations")?.columns ?? [])];
    expect(cols.length).toBeGreaterThan(20);
    expect(cols).toContain("last_run_error");
    const expected = cols.filter((c) => !CREDENTIALS.includes(c) && !COORDINATES.includes(c) && !RAW_ERRORS.includes(c)).sort();
    expect(grantedColumns().sort()).toEqual(expected);
    expect(grantedColumns()).toEqual(expect.arrayContaining(["last_run_at", "last_run_status", "last_run_bytes"]));
  });

  it("last_run_error is withheld because the runner stores raw messages that can name the destination", () => {
    const runner = readFileSync(join(root, "lib", "exportRunner.ts"), "utf8");
    expect(runner).toMatch(/lookup\(/);                       // a DNS failure names the host
    expect(runner).toMatch(/Webhook \$\{[^}]+\}: /);           // a webhook failure carries the remote's body
    const scheduled = readFileSync(join(root, "app", "api", "data-export", "run-scheduled", "route.ts"), "utf8");
    expect(scheduled).toMatch(/last_run_error/);
    expect(grantedColumns()).not.toContain("last_run_error");
  });

  it("no credential the export redacts is ever granted (BKP-11 and DEC-45 agree on what a credential is)", () => {
    expect([...REDACT_COLUMNS.export_destinations.columns].sort()).toEqual([...CREDENTIALS].sort());
    for (const c of [...CREDENTIALS, ...COORDINATES]) expect(grantedColumns(), c).not.toContain(c);
  });

  it("the probes check each limb: no credential, no coordinate, the card columns, anon nothing, service role whole", () => {
    for (const c of [...CREDENTIALS, ...COORDINATES, ...RAW_ERRORS]) {
      expect(sql).toMatch(new RegExp(`NOT has_column_privilege\\('authenticated', 'public\\.export_destinations', '${c}', 'SELECT'\\)`));
    }
    expect(sql).toMatch(/NOT has_any_column_privilege\('anon', 'public\.export_destinations', 'SELECT'\)/);
    expect(sql).toMatch(/has_table_privilege\('service_role', 'public\.export_destinations', 'SELECT'\)/);
    expect(sql).toMatch(/policyname = 'export_dest_member_select'/);
  });
});

describe("nothing in the app reads export_destinations with a member's session (the narrowing breaks no screen)", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = join(dir, d.name);
      if (d.isDirectory()) return d.name === "__tests__" || d.name === "node_modules" ? [] : walk(p);
      return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
    });
  }
  it("every reader is a server route under app/api/data-export", () => {
    const readers = [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components"))]
      .filter((f) => /from\(\s*["']export_destinations["']\s*\)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1).split("\\").join("/"))
      .sort();
    expect(readers.length).toBeGreaterThan(0);
    for (const r of readers) expect(r, r).toMatch(/^app\/api\/data-export\/.*route\.ts$/);
    // and none of them uses the browser client
    for (const r of readers) expect(readFileSync(join(root, r), "utf8"), r).not.toMatch(/from\s+["']@\/lib\/supabase["']/);
  });
});

describe("20261154 — export_runs: the same coordinates, one row per run, narrowed the same way (second review fix pass)", () => {
  it("the member policy is defined once in the whole sequence (20260605), no earlier file narrowed it, and this file leaves it as it is", () => {
    const definers = numbered.filter((f) => /CREATE\s+POLICY\s+"?export_runs_member_select"?/i.test(readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "")));
    expect(definers).toEqual(["20260605_rls_policies_new_tables.sql"]);
    for (const f of numbered.filter((n) => n < FILE)) {
      expect(readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, ""), f).not.toMatch(/(REVOKE|GRANT)\s+[^;]*\bON\s+(TABLE\s+)?export_runs\b/i);
    }
  });

  it("revokes the table-level SELECT from PUBLIC, anon and authenticated", () => {
    expect(sql).toMatch(/REVOKE\s+SELECT\s+ON\s+TABLE\s+export_runs\s+FROM\s+PUBLIC,\s*anon,\s*authenticated\s*;/i);
  });

  it("grants back exactly the card columns: every column of the table but where it went, its trace, its raw error, the archive link and the email", () => {
    const cols = [...(censusSchema().get("export_runs")?.columns ?? [])];
    expect(cols.length).toBeGreaterThan(15);
    for (const c of RUN_WITHHELD) expect(cols, c).toContain(c);
    const expected = cols.filter((c) => !RUN_WITHHELD.includes(c)).sort();
    expect(grantedColumns("export_runs").sort()).toEqual(expected);
    expect(grantedColumns("export_runs")).toEqual(expect.arrayContaining(["status", "total_bytes", "started_at", "completed_at"]));
  });

  it("the withheld columns are the ones the runner writes the destination and the raw error into", () => {
    const runner = readFileSync(join(root, "lib", "exportRunner.ts"), "utf8");
    expect(runner).toMatch(/step\("webhook:push", dest\.webhook_url/);      // diagnostics names the webhook URL
    expect(runner).toMatch(/step\("s3:push", `\$\{dest\.bucket\}\//);         // … and the bucket
    for (const route of ["run", "run-scheduled"]) {
      const src = readFileSync(join(root, "app", "api", "data-export", route, "route.ts"), "utf8");
      expect(src, route).toMatch(/destination_path: result\.destinationPath/);
      expect(src, route).toMatch(/error_message: msg\.slice\(0, 1000\)/);
    }
    for (const c of RUN_WITHHELD) expect(grantedColumns("export_runs"), c).not.toContain(c);
  });

  it("the probes check each limb: RLS on, policy kept, no table-level SELECT, each withheld column, the card columns, the service role", () => {
    expect(sql).toMatch(/to_regclass\('public\.export_runs'\)/);
    expect(sql).toMatch(/policyname = 'export_runs_member_select'/);
    expect(sql).toMatch(/NOT has_table_privilege\('authenticated', 'public\.export_runs', 'SELECT'\)/);
    expect(sql).toMatch(/NOT has_any_column_privilege\('anon', 'public\.export_runs', 'SELECT'\)/);
    for (const c of RUN_WITHHELD) {
      expect(sql).toMatch(new RegExp(`NOT has_column_privilege\\('authenticated', 'public\\.export_runs', '${c}', 'SELECT'\\)`));
    }
    expect(sql).toMatch(/has_table_privilege\('service_role', 'public\.export_runs', 'SELECT'\)/);
    // and the inventory counts what members could read before the paste
    const inventory = sql.slice(sql.indexOf("CREATE TEMP TABLE _ao_g54_before"), sql.indexOf("BEGIN;"));
    expect(inventory).toMatch(/FROM export_runs\s+WHERE destination_path IS NOT NULL OR diagnostics IS NOT NULL OR error_message IS NOT NULL/);
  });

  it("nothing in the app reads export_runs with a member's session: every reader is a server route under app/api/data-export", () => {
    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const p = join(dir, d.name);
        if (d.isDirectory()) return d.name === "__tests__" || d.name === "node_modules" ? [] : walk(p);
        return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
      });
    }
    const readers = [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components")), ...walk(join(root, "hooks"))]
      .filter((f) => /from\(\s*["']export_runs["']\s*\)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1).split("\\").join("/"))
      .sort();
    expect(readers).toEqual(["app/api/data-export/run-scheduled/route.ts", "app/api/data-export/run/route.ts", "app/api/data-export/runs/route.ts"]);
    for (const r of readers) expect(readFileSync(join(root, r), "utf8"), r).not.toMatch(/from\s+["']@\/lib\/supabase["']/);
  });
});
