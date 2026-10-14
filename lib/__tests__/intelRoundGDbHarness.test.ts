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
//   * 20261217's one-paste shape (DEC-30) and its one guarded REVOKE
//     (DRLS-16), and the three functions DEC-90 ruling 4 leaves recorded;
//   * the call sites those decisions were reasoned from, so a new caller
//     makes someone re-read the decision;
//   * discovery runs on PostgreSQL 16 unless the operator says otherwise, and
//     the replay stops on a migration too large to send as one paste (the
//     size itself is checked by the opt-in run only: a limit of the harness's
//     transport never gates this suite or CI);
//   * every decision about a function's body cites that body (the opt-in
//     census checks the fragments against the live catalog; here, against
//     the migrations' text), and a function that takes a person either binds
//     it or is an oracle with an owner (INTK-19).

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { discoverPostgres } from "./rls/pgHarness";
import { BODY_CLAIM_DECISIONS, CALLABLE_DEFINERS, ORACLE_DECISIONS, PERSON_PARAM, RULING_4_OWNER, TRIGGER_FUNCTIONS } from "./rls/definerDecisions";
import { BASELINE_KNOWN_ERRORS, CHECKPOINTS, OPERATOR_SWITCHES, OUT_OF_ORDER_FILES } from "./rls/replayKnownDefects";
import { numberedMigrations } from "./rls/replay";

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

  describe("discovery runs on PostgreSQL 16 unless the operator says otherwise", () => {
    const made: string[] = [];
    // A stand-in bin directory: initdb / pg_ctl / psql exist, postgres prints a version.
    const fakeBin = (version: string) => {
      const dir = mkdtempSync(join(tmpdir(), "mos-fake-pg-"));
      made.push(dir);
      for (const f of ["initdb", "pg_ctl", "psql"]) writeFileSync(join(dir, f), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(dir, "postgres"), `#!/bin/sh\necho "postgres (PostgreSQL) ${version}"\n`);
      for (const f of ["initdb", "pg_ctl", "psql", "postgres"]) chmodSync(join(dir, f), 0o755);
      return dir;
    };
    afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
    const base = { ...process.env, MOS_TEST_PG_BIN: "", MOS_TEST_PG_ALLOW_MAJOR: "", MOS_TEST_PG_USER: userInfo().username };

    it.skipIf(process.platform === "win32")("a host with 17 and 16 runs on 16, whichever comes first", () => {
      const v17 = fakeBin("17.2");
      const v16 = fakeBin("16.13");
      const d = discoverPostgres({ ...base, PATH: [v17, v16].join(delimiter) }, { packageDirs: false });
      expect(d.ok).toBe(true);
      if (d.ok) { expect(d.bin.major).toBe(16); expect(d.bin.dir).toBe(v16); }
    });

    it.skipIf(process.platform === "win32")("a host with only 17 skips loudly, naming the two ways to use it", () => {
      const v17 = fakeBin("17.2");
      const d = discoverPostgres({ ...base, PATH: v17 }, { packageDirs: false });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.missing).toMatch(/PostgreSQL 16 initdb \(found only PostgreSQL 17 at .*MOS_TEST_PG_BIN.*MOS_TEST_PG_ALLOW_MAJOR=17\)/);
    });

    it.skipIf(process.platform === "win32")("17 runs only when MOS_TEST_PG_ALLOW_MAJOR names it, or MOS_TEST_PG_BIN points at it", () => {
      const v17 = fakeBin("17.2");
      const allowed = discoverPostgres({ ...base, PATH: v17, MOS_TEST_PG_ALLOW_MAJOR: "17" }, { packageDirs: false });
      expect(allowed.ok && allowed.bin.major).toBe(17);
      const explicit = discoverPostgres({ ...base, PATH: "", MOS_TEST_PG_BIN: v17 }, { packageDirs: false });
      expect(explicit.ok && explicit.bin.major).toBe(17);
      const old = discoverPostgres({ ...base, PATH: "", MOS_TEST_PG_BIN: fakeBin("15.6") }, { packageDirs: false });
      expect(old.ok).toBe(false);
    });
  });

  it("the replay stops, naming the file, on a migration too large to send as one simple-query message (it never runs one another way)", () => {
    // Static only: whether any file IS too large is the opt-in run's question
    // (freshReplay.test.ts, and the replay itself throws), never this suite's.
    const replay = read("lib/__tests__/rls/replay.ts");
    expect(replay).toMatch(/if \(bytes > MAX_C_BYTES\) \{\s+throw new Error\(/);
    expect(replay).not.toMatch(/\{ file: path, stopOnError/);
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

  it("every decision about a body is reasoned on its own: evidence from that body, a reason no other row shares", () => {
    const squash = (s: string) => s.replace(/\s+/g, " ").trim();
    // The functions' bodies come from these files (the opt-in census checks
    // each fragment against the live catalog; this is the CI-side check).
    const corpus = squash(
      [read("supabase/schema.sql"), ...numberedMigrations(root).map((f) => read(join("supabase", "migrations", f)))].join("\n"),
    );
    const bodyRows = CALLABLE_DEFINERS.filter((d) => BODY_CLAIM_DECISIONS.includes(d.decision));
    expect(bodyRows.length).toBeGreaterThan(50);
    for (const d of bodyRows) {
      expect(d.evidence?.length ?? 0, d.signature).toBeGreaterThan(0);
      for (const f of [...(d.evidence ?? []), ...(d.person?.evidence ?? [])]) {
        expect(corpus.includes(squash(f)), `${d.signature}: ${f}`).toBe(true);
      }
    }
    const reasons = bodyRows.map((d) => d.reason);
    expect(new Set(reasons).size, "two rows share a templated reason").toBe(reasons.length);
  });

  it("an oracle has an owner (INTK-19); a person binding names a person parameter and, when it claims the caller, auth.uid()", () => {
    for (const d of CALLABLE_DEFINERS.filter((x) => ORACLE_DECISIONS.includes(x.decision))) {
      expect(d.owner, d.signature).toMatch(/INTK-19/);
      expect(d.person, d.signature).toBeUndefined();
    }
    for (const d of CALLABLE_DEFINERS.filter((x) => x.person)) {
      const p = d.person!;
      expect(p.param, d.signature).toMatch(PERSON_PARAM);
      expect(p.evidence.some((f) => new RegExp(`\\b${p.param}\\b`).test(f)), d.signature).toBe(true);
      if (p.binding === "is-the-caller" || p.binding === "judged-for-caller" || p.binding === "caller-supplied-oracle") {
        expect(p.evidence.some((f) => f.includes(p.param) && f.includes("auth.uid()")), d.signature).toBe(true);
      }
      // a binding that still leaks is owned, like an oracle
      if (p.binding === "caller-supplied-oracle") expect(d.owner, d.signature).toMatch(/INTK-19/);
    }
    // The review's case: node_visible's p_owner is the row's column when a
    // policy calls it, but a caller supplies it over RPC, and the answer
    // depends on that person's membership.
    expect(CALLABLE_DEFINERS.find((d) => d.signature === "node_visible(text,jsonb,uuid,uuid,uuid,uuid)")?.person?.binding).toBe("caller-supplied-oracle");
    // The review's case: org_capability_allows_for judges a p_uid it is given,
    // so it is an oracle (authenticated-only), not "signed-in".
    expect(CALLABLE_DEFINERS.find((d) => d.signature === "org_capability_allows_for(uuid,text,uuid,jsonb)")).toMatchObject({
      decision: "signed-in-oracle",
      execute: { anon: false, authenticated: true, service_role: true },
    });
    expect(CALLABLE_DEFINERS.filter((d) => ORACLE_DECISIONS.includes(d.decision)).map((d) => d.signature.split("(")[0]).sort()).toEqual(
      ["acl_index_denies", "org_capability_allows", "org_capability_allows_for", "project_org", "user_can_publish_on_library", "user_is_effective_owner"],
    );
  });

  it("PERSON_PARAM names a person and nothing else", () => {
    for (const a of ["p_uid", "p_to_user", "p_actor", "p_member_id", "p_new_owner", "p_doc_owner", "p_owner", "p_user_id", "p_uids"]) expect(a).toMatch(PERSON_PARAM);
    for (const a of ["p_actor_name", "p_org", "p_org_id", "p_library_ids", "p_doc", "p_project", "p_new_owner_name", "p_record"]) expect(a).not.toMatch(PERSON_PARAM);
  });

  it("the Supabase stand-in lives outside supabase/ and defines nothing in public", () => {
    const sql = read("lib/__tests__/rls/supabaseStandIn.sql");
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?(?!auth\.)\w+\s*\(/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION auth\.uid\(\)/);
    expect(sql).toMatch(/ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role/);
  });
});

describe("20261217: the definer-grant narrowing (DEC-30 shape, DRLS-16; DEC-90 ruling 4)", () => {
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

  it("creates or re-creates nothing; its one REVOKE (member_is_active) is guarded by to_regprocedure and paired with a narrow GRANT", () => {
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER)\b/i);
    const body = code.slice(code.search(/^BEGIN;/m), code.search(/^COMMIT;/m));
    const revokes = body.match(/REVOKE ALL ON FUNCTION public\.(\w+)\(/g) ?? [];
    expect(revokes.map((r) => r.replace(/.*public\.(\w+)\(/, "$1"))).toEqual(["member_is_active"]);
    const guard = body.indexOf("IF to_regprocedure('public.member_is_active(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("REVOKE ALL ON FUNCTION public.member_is_active("));
    expect(body).toMatch(/REVOKE ALL ON FUNCTION public\.member_is_active\(uuid, uuid\) FROM PUBLIC, anon, authenticated;\s+GRANT EXECUTE ON FUNCTION public\.member_is_active\(uuid, uuid\) TO service_role;/);
    // DEC-90 ruling 4: the app calls these as authenticated, so the file
    // leaves their grants alone (no GRANT or REVOKE names them).
    for (const name of ["next_ticket_number", "issue_document_number", "force_release_document"]) {
      expect(code, name).not.toMatch(new RegExp(`(GRANT|REVOKE)[^;]*\\b${name}\\b`));
    }
  });

  it("the header's ROLLBACK restores member_is_active's pre-paste ACL, PUBLIC included", () => {
    expect(sql).toMatch(/^--\s+GRANT EXECUTE ON FUNCTION public\.member_is_active\(uuid, uuid\) TO PUBLIC, anon, authenticated;$/m);
  });

  it("the decision table: member_is_active is 20261217's; the other three are recorded with the integrator as owner, anon still executing", () => {
    const by = (d: string) => CALLABLE_DEFINERS.filter((x) => x.decision === d).map((x) => x.signature).sort();
    expect(by("revoked-20261217")).toEqual(["member_is_active(uuid,uuid)"]);
    expect(by("anon-refused-by-body")).toEqual(["force_release_document(uuid,text)", "issue_document_number(uuid)", "next_ticket_number(uuid,integer)"]);
    for (const d of CALLABLE_DEFINERS.filter((x) => x.decision === "anon-refused-by-body")) {
      expect(d.execute, d.signature).toEqual({ anon: true, authenticated: true, service_role: true });
      expect(d.owner, d.signature).toBe(RULING_4_OWNER);
      expect(d.reason, d.signature).toMatch(/DEC-90 ruling 4/);
    }
    // the membership answer member_is_active gave stays reachable until INTK-19 lands
    expect(CALLABLE_DEFINERS.find((d) => d.signature === "member_is_active(uuid,uuid)")?.owner).toMatch(/INTK-19/);
  });

  // The decisions were reasoned from these call sites (grep every .rpc( site,
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

  it("member_is_active is named by no app code; the other three only by the signed-in callers their decisions cite", () => {
    expect(namedIn("member_is_active")).toEqual([]);
    expect(namedIn("next_ticket_number")).toEqual(["app/api/tickets/create/route.ts", "lib/ticketNumber.ts"]);
    expect(namedIn("issue_document_number")).toEqual(["lib/libraryNumbering.ts"]);
    expect(namedIn("force_release_document")).toEqual(["lib/checkoutEpisodes.ts"]);
  });
});
