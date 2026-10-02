// intelligence Round G, I-20 fix pass 3 — GOV-14 done-when 3: migration
// 20261163 makes EMBED_BUILD_CONSENT_RECORDED a row only the embed route
// writes.
//
// Reproduced first: audit_logs_insert — its newest definition,
// 20260813_acl_close_gaps_and_audit_scope.sql:85-90 — checks only
// `user_id = auth.uid()` and the org, so any signed-in member could insert a
// consent row for their own consent (any details, any request), and the
// route's renewal lookup (consentRows) and raced put-back would take it for
// the route's own record. Run against PostgreSQL 16 with audit_logs and its
// policies as the sequence leaves them: before the paste a member's forged
// row (with an org, and with none) was inserted; after it both are refused
// by audit_logs_embed_consent_route_only, an ordinary member row (another
// action, with an org and with none) is still inserted, the service role
// still writes the consent row, and a second paste reports the same probes.
//
// Shape tests over the one-paste file (DEC-30 / the protocol: inventory TEMP
// table of counts before BEGIN, one transaction, ONE final (check, ok, n)
// SELECT) and over what it relies on.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const MIGRATIONS = join(root, "supabase", "migrations");
const FILE = "20261163_intel_roundG_embed_consent_audit_rows.sql";
const raw = readFileSync(join(MIGRATIONS, FILE), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");
const numbered = readdirSync(MIGRATIONS).filter((n) => /^\d{8}.*\.sql$/.test(n)).sort();
const ROUTE = readFileSync(join(root, "app/api/knowledge/embed/route.ts"), "utf8");
const ACTION = ROUTE.match(/export const EMBED_CONSENT_AUDIT_ACTION = "([A-Z_]+)";/)![1];

describe("20261163 — the one-paste shape", () => {
  it("is numbered in the sequence, named for the package's round", () => {
    expect(numbered).toContain(FILE);
    expect(FILE).toMatch(/^20261163_intel_roundG_[a-z_]+\.sql$/);
  });

  it("inventory TEMP table (counts only) before ONE transaction, then ONE final (check, ok, n) SELECT", () => {
    const temp = sql.indexOf("CREATE TEMP TABLE _intel_g63_before");
    const begin = sql.indexOf("BEGIN;");
    const commit = sql.indexOf("COMMIT;");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(sql.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(sql.match(/\bCOMMIT;/g)).toHaveLength(1);
    const tail = sql.slice(commit + "COMMIT;".length).trim();
    expect(tail.split(";").filter((x) => x.trim()).length).toBe(1);
    expect(tail).toMatch(/^SELECT '[^']+' AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    // the inventory rides in the same result set: ok NULL, n the count
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM _intel_g63_before;$/);
    // the inventory counts — never rows
    const inventory = sql.slice(temp, begin);
    expect(inventory.match(/COUNT\(\*\)::text/g)?.length).toBe(3);
    expect(inventory).not.toMatch(/SELECT\s+\*|details\s*,|user_id\s*,/);
  });

  it("the probes read pg_policies' deparsed text with no bare cast in a LIKE pattern", () => {
    const likes = sql.match(/LIKE '[^']*(?:''[^']*)*'/g) ?? [];
    expect(likes.length).toBeGreaterThan(0);
    for (const l of likes) expect(l).not.toMatch(/::/);
  });
});

describe("20261163 — one RESTRICTIVE INSERT policy, and nothing else", () => {
  const txn = sql.slice(sql.indexOf("BEGIN;"), sql.indexOf("COMMIT;"));

  it("refuses an anon or authenticated INSERT of the route's own consent action — the action the route writes", () => {
    expect(ACTION).toBe("EMBED_BUILD_CONSENT_RECORDED");
    expect(txn).toMatch(new RegExp(
      "DROP POLICY IF EXISTS audit_logs_embed_consent_route_only ON audit_logs;\\s*"
      + "CREATE POLICY audit_logs_embed_consent_route_only ON audit_logs\\s+"
      + "AS RESTRICTIVE FOR INSERT TO anon, authenticated\\s+"
      + `WITH CHECK \\(action IS DISTINCT FROM '${ACTION}'\\);`,
    ));
  });

  it("touches nothing else: no other policy, no table, function, trigger or grant", () => {
    expect(txn.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(txn.match(/DROP POLICY/g)).toHaveLength(1);
    expect(txn).not.toMatch(/ALTER TABLE|CREATE (OR REPLACE )?FUNCTION|TRIGGER|GRANT|REVOKE|DELETE FROM|UPDATE audit_logs|INSERT INTO/i);
    expect(txn).toMatch(/COMMENT ON POLICY audit_logs_embed_consent_route_only ON audit_logs IS/);
  });

  it("the probes check the new policy, the untouched insert and select rules, and append-only rows", () => {
    const tail = sql.slice(sql.indexOf("COMMIT;"));
    expect(tail).toMatch(/policyname = 'audit_logs_embed_consent_route_only'/);
    expect(tail).toMatch(/permissive = 'RESTRICTIVE' AND cmd = 'INSERT'/);
    expect(tail).toMatch(/with_check LIKE '%action IS DISTINCT FROM ''EMBED_BUILD_CONSENT_RECORDED''%'/);
    expect(tail).toMatch(/policyname = 'audit_logs_insert'/);
    expect(tail).toMatch(/policyname = 'audit_logs_org_access'/);
    expect(tail).toMatch(/policyname = 'audit_logs_admin_trail'/);
    expect(tail).toMatch(/cmd IN \('UPDATE', 'DELETE', 'ALL'\)/);
  });
});

describe("what 20261163 relies on", () => {
  /** The newest numbered definition of a policy on audit_logs, and its body. */
  function newest(policy: string): { file: string; body: string } {
    const files = numbered.filter((f) => f !== FILE && new RegExp(`CREATE POLICY ${policy} ON audit_logs`).test(readFileSync(join(MIGRATIONS, f), "utf8")));
    const file = files[files.length - 1];
    const text = readFileSync(join(MIGRATIONS, file), "utf8");
    const at = text.indexOf(`CREATE POLICY ${policy} ON audit_logs`);
    return { file, body: text.slice(at, text.indexOf(";", at)) };
  }

  it("reproduction: the newest audit_logs_insert lets a member insert ANY action for themselves — nothing in it names the action", () => {
    const { file, body } = newest("audit_logs_insert");
    expect(file).toBe("20260813_acl_close_gaps_and_audit_scope.sql");
    expect(body).toMatch(/FOR INSERT TO authenticated\s+WITH CHECK \(\s*user_id = auth\.uid\(\)\s+AND \(org_id IS NULL OR org_id IN \(SELECT my_org_ids\(\)\)\)\s*\)/);
    expect(body).not.toMatch(/action/);
  });

  it("no later migration in the sequence already restricts which actions a member may insert", () => {
    const after = numbered.filter((f) => f.slice(0, 8) > "20260813" && f !== FILE);
    for (const f of after) {
      const text = readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "");
      expect(text, f).not.toMatch(/CREATE POLICY \w+ ON audit_logs[\s\S]{0,80}FOR INSERT/);
    }
  });

  it("the route is the only code that writes the action, and it writes it on the service role", () => {
    const hits = execSync(
      "grep -rlE 'EMBED_BUILD_CONSENT_RECORDED|EMBED_CONSENT_AUDIT_ACTION' app lib components --include=*.ts --include=*.tsx | grep -v __tests__ || true",
      { cwd: root, encoding: "utf8" },
    ).split("\n").filter(Boolean).sort();
    expect(hits).toEqual(["app/api/knowledge/embed/route.ts"]);
    expect(ROUTE).toMatch(/await supabaseAdmin\.from\("audit_logs"\)\.insert\(\{\s*action: EMBED_CONSENT_AUDIT_ACTION,/);
    // …and the route reads the rows back by that action (what a member-written row would pass for)
    expect(ROUTE).toMatch(/\.eq\("action", EMBED_CONSENT_AUDIT_ACTION\)\.eq\("user_id", userId\)/);
  });
});
