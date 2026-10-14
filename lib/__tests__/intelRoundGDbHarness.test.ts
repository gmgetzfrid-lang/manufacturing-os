// intelligence I-17 DATABASE HARNESS — what the DEFAULT suite pins about it.
//
// The harness itself (lib/__tests__/rls/) needs a real PostgreSQL and runs
// only under `npm run test:db`. This file runs everywhere and holds the
// wiring and the migration's shape, without a database:
//   * the default suite never picks the database suites up, and its own
//     include and the `test` script are what they were;
//   * the opt-in config includes only lib/__tests__/rls/;
//   * with no PostgreSQL the discovery names what is missing (the opt-in run
//     then skips loudly, never fails);
//   * 20261217's one-paste shape (DEC-30) and its guarded REVOKEs (DRLS-16);
//   * the call sites the four narrowings were reasoned from, so a new caller
//     makes someone re-read the decision.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoverPostgres } from "./rls/pgHarness";
import { CALLABLE_DEFINERS, TRIGGER_FUNCTIONS } from "./rls/definerDecisions";
import { BASELINE_KNOWN_ERRORS, CHECKPOINTS, OPERATOR_SWITCHES, OUT_OF_ORDER_FILES } from "./rls/replayKnownDefects";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("I-17: the database harness is opt-in", () => {
  it("vitest.config.ts excludes lib/__tests__/rls/** and keeps its include", () => {
    const cfg = read("vitest.config.ts");
    expect(cfg).toContain('include: ["lib/__tests__/**/*.test.ts"]');
    expect(cfg).toContain('exclude: [...configDefaults.exclude, "lib/__tests__/rls/**"]');
    expect(cfg).not.toContain("globalSetup");
  });

  it("vitest.db.config.ts includes only the database suites and starts the cluster in its globalSetup", () => {
    const cfg = read("vitest.db.config.ts");
    expect(cfg).toContain('include: ["lib/__tests__/rls/**/*.test.ts"]');
    expect(cfg).toContain('globalSetup: ["./lib/__tests__/rls/globalSetup.ts"]');
    expect(cfg).toContain("fileParallelism: false");
  });

  it("`npm test` is unchanged; `npm run test:db` is the only door", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; devDependencies: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:db"]).toBe("vitest run --config vitest.db.config.ts");
    // no database client was added: the harness drives the PostgreSQL binaries
    for (const dep of ["pg", "postgres", "@electric-sql/pglite"]) {
      expect(pkg.dependencies[dep], dep).toBeUndefined();
      expect(pkg.devDependencies[dep], dep).toBeUndefined();
    }
  });

  it("CI runs the default suite only", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("run: npm test");
    expect(ci).not.toContain("test:db");
  });

  it("with no PostgreSQL, discovery names the missing binary instead of failing", () => {
    const d = discoverPostgres({ ...process.env, MOS_TEST_PG_BIN: "/nonexistent-mos-pg-bin" });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.missing).toMatch(/initdb .*MOS_TEST_PG_BIN=\/nonexistent-mos-pg-bin/);
  });

  it("every database suite skips itself when the cluster is absent", () => {
    const dir = join(root, "lib", "__tests__", "rls");
    const suites = readdirSync(dir).filter((f) => f.endsWith(".test.ts"));
    expect(suites.length).toBeGreaterThanOrEqual(3);
    for (const f of suites) {
      const src = readFileSync(join(dir, f), "utf8");
      const describes = src.match(/^describe(\.\w+)?\(/gm) ?? [];
      const guarded = src.match(/^describe\.skipIf\(skip !== null\)\(/gm) ?? [];
      expect(guarded.length, f).toBe(describes.length);
    }
  });
});

describe("I-17: the replay's recorded defects and decisions are well-formed", () => {
  const migrations = readdirSync(join(root, "supabase", "migrations"));

  it("each recorded out-of-order file, operator switch and checkpoint names a real migration", () => {
    for (const k of OUT_OF_ORDER_FILES) {
      expect(migrations, k.file).toContain(k.file);
      expect(k.finding).toMatch(/IRLS-1[89]/);
    }
    for (const f of Object.keys(OPERATOR_SWITCHES)) expect(migrations, f).toContain(f);
    for (const c of CHECKPOINTS) expect(migrations.some((m) => m.startsWith(c)), c).toBe(true);
    expect(BASELINE_KNOWN_ERRORS.length).toBeGreaterThan(0);
  });

  it("the decision table names each function once, and no function is both a trigger and callable", () => {
    const callable = CALLABLE_DEFINERS.map((d) => d.signature);
    expect(new Set(callable).size).toBe(callable.length);
    expect(new Set(TRIGGER_FUNCTIONS).size).toBe(TRIGGER_FUNCTIONS.length);
    expect(callable.filter((s) => TRIGGER_FUNCTIONS.includes(s))).toEqual([]);
    for (const d of CALLABLE_DEFINERS) expect(d.reason.trim().length, d.signature).toBeGreaterThan(60);
  });

  it("the Supabase stand-in lives outside supabase/ and defines nothing in public", () => {
    const sql = read("lib/__tests__/rls/supabaseStandIn.sql");
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?(?!auth\.)\w+\s*\(/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION auth\.uid\(\)/);
    expect(sql).toMatch(/ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role/);
  });
});

describe("20261217: the definer-grant narrowings (DEC-30 shape, DRLS-16)", () => {
  const file = "supabase/migrations/20261217_intel_roundG_definer_grants.sql";
  const sql = read(file);
  const code = sql.replace(/--[^\n]*/g, "");

  it("one paste: counts-only inventory before the transaction, BEGIN … COMMIT, one final SELECT", () => {
    const tempAt = code.indexOf("CREATE TEMP TABLE");
    const beginAt = code.search(/^BEGIN;/m);
    const commitAt = code.search(/^COMMIT;/m);
    expect(tempAt).toBeGreaterThan(-1);
    expect(tempAt).toBeLessThan(beginAt);
    expect(beginAt).toBeLessThan(commitAt);
    expect(code.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;/gm)).toHaveLength(1);
    const tail = code.slice(commitAt + "COMMIT;".length).trim();
    expect(tail.startsWith("SELECT")).toBe(true);
    // one statement: no semicolon outside a string literal but the last
    const unquoted = tail.replace(/'(?:[^']|'')*'/g, "''");
    expect(unquoted.split(";").filter((s) => s.trim()).length).toBe(1);
    expect(tail).toContain('AS "check"');
    expect(tail).toMatch(/AS ok/);
    expect(tail).toMatch(/AS n/);
    // the inventory reads the catalog only — never a customer table
    const inventory = code.slice(tempAt, beginAt);
    expect(inventory).not.toMatch(/FROM\s+(public\.)?(documents|org_members|orgs|users|tickets|assets)\b/i);
  });

  it("creates or re-creates nothing; every REVOKE is guarded by to_regprocedure and paired with a narrow GRANT", () => {
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER)\b/i);
    const body = code.slice(code.search(/^BEGIN;/m), code.search(/^COMMIT;/m));
    const revokes = body.match(/REVOKE ALL ON FUNCTION public\.(\w+)\(/g) ?? [];
    expect(revokes.map((r) => r.replace(/.*public\.(\w+)\(/, "$1")).sort()).toEqual(
      ["force_release_document", "issue_document_number", "member_is_active", "next_ticket_number"],
    );
    for (const name of ["member_is_active", "next_ticket_number", "issue_document_number", "force_release_document"]) {
      const guard = body.indexOf(`IF to_regprocedure('public.${name}(`);
      const revoke = body.indexOf(`REVOKE ALL ON FUNCTION public.${name}(`);
      expect(guard, name).toBeGreaterThan(-1);
      expect(guard, name).toBeLessThan(revoke);
    }
    expect(body).toMatch(/REVOKE ALL ON FUNCTION public\.member_is_active\(uuid, uuid\) FROM PUBLIC, anon, authenticated;\s+GRANT EXECUTE ON FUNCTION public\.member_is_active\(uuid, uuid\) TO service_role;/);
    for (const sig of ["next_ticket_number(uuid, integer)", "issue_document_number(uuid)", "force_release_document(uuid, text)"]) {
      const esc = sig.replace(/[()]/g, "\\$&");
      expect(body, sig).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc} FROM PUBLIC, anon;\\s+GRANT EXECUTE ON FUNCTION public\\.${esc} TO authenticated, service_role;`));
    }
  });

  it("the decision table records exactly these four as 20261217's", () => {
    const by = (d: string) => CALLABLE_DEFINERS.filter((x) => x.decision === d).map((x) => x.signature).sort();
    expect(by("revoked-20261217")).toEqual(["member_is_active(uuid,uuid)"]);
    expect(by("signed-in-rpc")).toEqual(["force_release_document(uuid,text)", "issue_document_number(uuid)", "next_ticket_number(uuid,integer)"]);
  });

  // The narrowings were reasoned from these call sites (grep every .rpc( site,
  // DEC-90 ruling 4). A new caller — above all a signed-out page — must make
  // someone re-read the decision before it ships.
  function namedIn(fn: string): string[] {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (f === "node_modules" || f === "__tests__" || f.startsWith(".")) continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f) && readFileSync(p, "utf8").match(new RegExp(`["'\`]${fn}["'\`]`))) hits.push(p.slice(root.length + 1));
      }
    };
    for (const d of ["app", "lib", "components", "hooks"]) if (existsSync(join(root, d))) walk(join(root, d));
    return hits.sort();
  }

  it("member_is_active is named by no app code; the other three only by the signed-in callers the decisions cite", () => {
    expect(namedIn("member_is_active")).toEqual([]);
    expect(namedIn("next_ticket_number")).toEqual(["app/api/tickets/create/route.ts", "lib/ticketNumber.ts"]);
    expect(namedIn("issue_document_number")).toEqual(["lib/libraryNumbering.ts"]);
    expect(namedIn("force_release_document")).toEqual(["lib/checkoutEpisodes.ts"]);
  });
});
