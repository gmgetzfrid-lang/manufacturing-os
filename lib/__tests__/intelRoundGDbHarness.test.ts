// intelligence I-17 DATABASE HARNESS — what the DEFAULT suite pins about it.
//
// The harness itself (lib/__tests__/rls/) needs a real PostgreSQL and runs
// only under `npm run test:db`. This file runs everywhere and holds the
// wiring and the migration's shape, without a database:
//   * the default suite never picks the database suites up, and its own
//     include and the `test` script are what they were;
//   * the opt-in config includes only lib/__tests__/rls/;
//   * with no PostgreSQL the discovery names what is missing (the opt-in run
//     then skips loudly, never fails), and its rule is tested here as pure
//     logic over an injected host: this suite never writes or executes a
//     script (a noexec temp directory must not fail CI); the same three
//     cases against real executables run in the opt-in suite
//     (lib/__tests__/rls/discovery.test.ts);
//   * 20261217's one-paste shape (DEC-30), its live-database precondition
//     and its one guarded REVOKE (DRLS-16), and the three functions the
//     integrator's DEC-90 ruling 4 leaves as they are;
//   * the call sites those decisions were reasoned from, so a new caller
//     makes someone re-read the decision (a subset check: a caller that goes
//     away never trips it);
//   * discovery runs on PostgreSQL 16 unless the operator says otherwise, and
//     the replay stops on a migration too large to send as one paste (the
//     size itself is checked by the opt-in run only: a limit of the harness's
//     transport never gates this suite or CI);
//   * every decision about a function's body cites that body (the opt-in
//     census checks the fragments against the live catalog; here, against
//     the migrations' text), and a function that takes a person either binds
//     it or is an oracle with an owner (INTK-19).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { discoverPostgres, type DiscoveryHost } from "./rls/pgHarness";
import { BODY_CLAIM_DECISIONS, CALLABLE_DEFINERS, ORACLE_DECISIONS, PERSON_PARAM, RULING_4_RULED, TRIGGER_FUNCTIONS } from "./rls/definerDecisions";
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

  describe("discovery runs on PostgreSQL 16 unless the operator says otherwise (pure logic: an injected host, nothing executed)", () => {
    // A machine made of bin directories, each with the version its
    // `postgres --version` prints. Nothing is written or run.
    const machine = (dirs: Record<string, string>, o: { root?: boolean; users?: string[]; runuser?: boolean; share?: Record<string, boolean> } = {}): DiscoveryHost & { ran: string[] } => {
      const ran: string[] = [];
      const bins = ["initdb", "pg_ctl", "psql", "postgres"];
      return {
        ran,
        exists: (p) => Object.keys(dirs).some((d) => bins.some((b) => p === join(d, b))) || Object.entries(o.share ?? {}).some(([d, has]) => has && p === join(d, "extension", "vector.control")),
        listDir: () => [],
        isRoot: () => o.root ?? false,
        run: (cmd, args) => {
          ran.push([cmd, ...args].join(" "));
          const dir = Object.keys(dirs).find((d) => cmd === join(d, "postgres"));
          if (dir) return { status: 0, stdout: `postgres (PostgreSQL) ${dirs[dir]}\n` };
          const cfg = Object.keys(dirs).find((d) => cmd === join(d, "pg_config"));
          if (cfg) return o.share && cfg in o.share ? { status: 0, stdout: `${cfg}\n` } : { status: null, stdout: "", error: new Error("ENOENT") };
          if (cmd === "id") return (o.users ?? []).includes(args[1]) ? { status: 0, stdout: "1000\n" } : { status: 1, stdout: "" };
          if (cmd === "runuser") return o.runuser === false ? { status: null, stdout: "", error: new Error("ENOENT") } : { status: 0, stdout: "" };
          return { status: null, stdout: "", error: new Error(`unexpected ${cmd}`) };
        },
      };
    };
    // the rest of the environment is irrelevant: the host is injected
    const base: NodeJS.ProcessEnv = { ...process.env, MOS_TEST_PG_BIN: "", MOS_TEST_PG_ALLOW_MAJOR: "", MOS_TEST_PG_USER: "" };

    it("a host with 17 and 16 runs on 16, whichever comes first", () => {
      const host = machine({ "/v17": "17.2", "/v16": "16.13" });
      const d = discoverPostgres({ ...base, PATH: ["/v17", "/v16"].join(delimiter) }, { packageDirs: false, host });
      expect(d.ok).toBe(true);
      if (d.ok) { expect(d.bin.major).toBe(16); expect(d.bin.dir).toBe("/v16"); expect(d.bin.runAs).toBeNull(); }
    });

    it("a host with only 17 skips loudly, naming the two ways to use it", () => {
      const d = discoverPostgres({ ...base, PATH: "/v17" }, { packageDirs: false, host: machine({ "/v17": "17.2" }) });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.missing).toMatch(/PostgreSQL 16 initdb \(found only PostgreSQL 17 at .*MOS_TEST_PG_BIN.*MOS_TEST_PG_ALLOW_MAJOR=17\)/);
    });

    it("17 runs only when MOS_TEST_PG_ALLOW_MAJOR names it, or MOS_TEST_PG_BIN points at it; 15 never", () => {
      const host = machine({ "/v17": "17.2", "/v15": "15.6" });
      const allowed = discoverPostgres({ ...base, PATH: "/v17", MOS_TEST_PG_ALLOW_MAJOR: "17" }, { packageDirs: false, host });
      expect(allowed.ok && allowed.bin.major).toBe(17);
      const explicit = discoverPostgres({ ...base, PATH: "", MOS_TEST_PG_BIN: "/v17" }, { packageDirs: false, host });
      expect(explicit.ok && explicit.bin.major).toBe(17);
      const old = discoverPostgres({ ...base, PATH: "", MOS_TEST_PG_BIN: "/v15" }, { packageDirs: false, host });
      expect(old.ok).toBe(false);
    });

    it("under root the server runs as MOS_TEST_PG_USER (else postgres), and a missing user or runuser is named", () => {
      const env = { ...base, PATH: "/v16" };
      const ok = discoverPostgres(env, { packageDirs: false, host: machine({ "/v16": "16.13" }, { root: true, users: ["postgres"] }) });
      expect(ok.ok && ok.bin.runAs?.name).toBe("postgres");
      const noUser = discoverPostgres({ ...env, MOS_TEST_PG_USER: "nobody-here" }, { packageDirs: false, host: machine({ "/v16": "16.13" }, { root: true, users: ["postgres"] }) });
      expect(!noUser.ok && noUser.missing).toMatch(/non-root OS user .*'nobody-here'.*MOS_TEST_PG_USER/);
      const noRunuser = discoverPostgres(env, { packageDirs: false, host: machine({ "/v16": "16.13" }, { root: true, users: ["postgres"], runuser: false }) });
      expect(!noRunuser.ok && noRunuser.missing).toMatch(/^runuser/);
    });

    it("a server whose share directory lacks pgvector is named, not started", () => {
      const d = discoverPostgres({ ...base, PATH: "/v16" }, { packageDirs: false, host: machine({ "/v16": "16.13" }, { share: { "/v16": false } }) });
      expect(!d.ok && d.missing).toMatch(/^pgvector \(\/v16\/extension\/vector\.control/);
      const withVector = discoverPostgres({ ...base, PATH: "/v16" }, { packageDirs: false, host: machine({ "/v16": "16.13" }, { share: { "/v16": true } }) });
      expect(withVector.ok).toBe(true);
    });

    it("the default host is the real machine: the opt-in suite holds the same three cases against real executables", () => {
      const src = read("lib/__tests__/rls/discovery.test.ts");
      for (const name of ["a host with 17 and 16 runs on 16", "a host with only 17 skips loudly", "17 runs only when MOS_TEST_PG_ALLOW_MAJOR names it"]) expect(src, name).toContain(name);
      // and it writes its stand-in executables inside the repository, never in the OS temp directory
      expect(src).not.toMatch(/\btmpdir\(/);
      expect(src).toContain('"node_modules", ".cache"');
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
    // Empty since intelligence I-27 (IRLS-17 / IRLS-18 / IRLS-19): the fresh
    // replay — schema.sql as one script, then every file in filename order —
    // has no known defect left. A new one is listed with its finding and owner.
    expect(BASELINE_KNOWN_ERRORS).toEqual([]);
    expect(OUT_OF_ORDER_FILES).toEqual([]);
  });

  it("the replay sends supabase/schema.sql as ONE simple-query message, the editor's way (IRLS-17), never statement by statement", () => {
    const replay = read("lib/__tests__/rls/replay.ts");
    expect(replay).toMatch(/const baseline = runAsPaste\(conn, REPLAY_DB, join\(repoRoot, "supabase", "schema\.sql"\), "supabase\/schema\.sql"\);/);
    expect(replay).not.toMatch(/"schema\.sql"\), stopOnError/);
    // runAsPaste is the migrations' transport: -c (one message), with the size stop
    expect(replay).toMatch(/function runAsPaste\([\s\S]*?if \(bytes > MAX_C_BYTES\) \{\s+throw new Error\([\s\S]*?runPsql\(conn, db, "postgres", \{ sql: body \}, settings\)/);
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

  it("the REVOKE waits on a live-database precondition: six catalog counts in the TEMP inventory, a REVOKE only when all are 0 (else a NOTICE and no change), and a probe in the final SELECT", () => {
    const tempAt = code.indexOf("CREATE TEMP TABLE");
    const beginAt = code.search(/^BEGIN;/m);
    const inventory = code.slice(tempAt, beginAt);
    const names = "~ '\\mmember_is_active\\s*\\('";
    // one row per precondition, each flagged `pre` (true) and naming member_is_active(
    const rows = inventory.slice(inventory.indexOf("SELECT 1, ")).split(/\nUNION ALL\n/);
    expect(rows).toHaveLength(9);
    const pre = rows.filter((r) => /^SELECT \d, 'precondition \(expect 0\): /.test(r));
    expect(pre).toHaveLength(6);
    // the `pre` flag: true on exactly the six precondition rows, false on the three others
    for (const r of rows) expect(/(COUNT\(\*\)|\)\)), true\b/.test(r), r.slice(0, 80)).toBe(pre.includes(r));
    for (const r of pre) {
      if (!/proowner <> m\.proowner/.test(r)) expect(r, r.slice(0, 120)).toContain(names);
    }
    const bySubject = (needle: RegExp) => pre.filter((r) => needle.test(r));
    // policies: USING and WITH CHECK, deparsed
    expect(bySubject(/FROM pg_policy pol/)[0]).toMatch(/pg_get_expr\(pol\.polqual, pol\.polrelid\)[\s\S]*pg_get_expr\(pol\.polwithcheck, pol\.polrelid\)/);
    // SECURITY INVOKER bodies, SQL-standard bodies included
    expect(bySubject(/WHERE NOT p\.prosecdef/)[0]).toMatch(/p\.prosrc[\s\S]*pg_get_function_sqlbody\(p\.oid\)/);
    // views and materialized views
    expect(bySubject(/FROM pg_views/)[0]).toContain("pg_matviews");
    // definer functions other than user_is_effective_owner (and member_is_active itself)
    expect(bySubject(/WHERE p\.prosecdef/)[0]).toMatch(/p\.proname <> 'user_is_effective_owner'[\s\S]*p\.oid IS DISTINCT FROM to_regprocedure\('public\.member_is_active\(uuid,uuid\)'\)/);
    // user_is_effective_owner keeps the call: same owner as member_is_active, or a superuser
    expect(bySubject(/proowner <> m\.proowner/)[0]).toContain("NOT r.rolsuper");
    // defaults, CHECK constraints, trigger definitions
    expect(bySubject(/pg_attrdef/)[0]).toMatch(/pg_constraint[\s\S]*pg_trigger/);
    // the DO block: the REVOKE only when the precondition sums to 0
    const body = code.slice(beginAt, code.search(/^COMMIT;/m));
    expect(body).toMatch(/SELECT COALESCE\(SUM\(n\), 0\) INTO v_blockers FROM intel_i17_20261217_inventory WHERE pre;\s+IF v_blockers = 0 THEN\s+REVOKE ALL ON FUNCTION public\.member_is_active\(uuid, uuid\)/);
    const elseBranch = body.slice(body.indexOf("ELSE"), body.lastIndexOf("END IF;"));
    expect(elseBranch).toMatch(/^ELSE\s+RAISE NOTICE '20261217 changed nothing: /);
    expect(elseBranch).not.toMatch(/\b(GRANT|REVOKE)\b/);
    // the final SELECT probes it (NULL only for a database without the function)
    const tail = code.slice(code.search(/^COMMIT;/m));
    expect(tail).toMatch(/SELECT 'precondition: [^']*'::text AS "check",\s+CASE WHEN to_regprocedure\('public\.member_is_active\(uuid,uuid\)'\) IS NOT NULL\s+THEN \(SELECT COALESCE\(SUM\(i\.n\), 0\) = 0 FROM intel_i17_20261217_inventory i WHERE i\.pre\) END AS ok,/);
  });

  it("the header states the paste facts: order, deploy gate, expected rows, rollback", () => {
    expect(sql).toMatch(/^--\s+ORDER: independent of every other pending file\./m);
    expect(sql).toMatch(/^--\s+DEPLOY GATE: none/m);
    expect(sql).toMatch(/^--\s+EXPECTED RESULT \(one result set, 13 rows\): 3 probes with ok = true/m);
    // 3 probes + the after count + 9 inventory rows (3 counts + 6 preconditions)
    const tail = code.slice(code.search(/^COMMIT;/m));
    expect(tail.match(/^SELECT /gm)).toHaveLength(5);
    expect(code.match(/^SELECT \d, /gm)).toHaveLength(9);
  });

  it("the header's ROLLBACK restores member_is_active's pre-paste ACL, PUBLIC included", () => {
    expect(sql).toMatch(/^--\s+GRANT EXECUTE ON FUNCTION public\.member_is_active\(uuid, uuid\) TO PUBLIC, anon, authenticated;$/m);
  });

  it("the decision table: member_is_active is 20261217's; the other three are RULED (DEC-90 ruling 4: no revoke, final, no owner), anon still executing", () => {
    const by = (d: string) => CALLABLE_DEFINERS.filter((x) => x.decision === d).map((x) => x.signature).sort();
    expect(by("revoked-20261217")).toEqual(["member_is_active(uuid,uuid)"]);
    expect(by("anon-refused-by-body")).toEqual(["force_release_document(uuid,text)", "issue_document_number(uuid)", "next_ticket_number(uuid,integer)"]);
    expect(RULING_4_RULED).toMatch(/^RULED by the integrator \(DEC-90 ruling 4\): no revoke\..*Final; no owner\.$/);
    for (const d of CALLABLE_DEFINERS.filter((x) => x.decision === "anon-refused-by-body")) {
      expect(d.execute, d.signature).toEqual({ anon: true, authenticated: true, service_role: true });
      expect(d.owner, d.signature).toBeUndefined();
      expect(d.reason, d.signature).toContain(RULING_4_RULED);
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

  it("member_is_active is named by no app code; the other three only by the signed-in callers their decisions cite (a NEW caller trips this)", () => {
    expect(namedIn("member_is_active")).toEqual([]);
    // A subset check: every hit must be a caller the decision was reasoned
    // from. One that goes away is no regression; a new one must be read.
    const allowed: Record<string, string[]> = {
      next_ticket_number: ["app/api/tickets/create/route.ts", "lib/ticketNumber.ts"],
      issue_document_number: ["lib/libraryNumbering.ts"],
      force_release_document: ["lib/checkoutEpisodes.ts"],
    };
    for (const [fn, callers] of Object.entries(allowed)) {
      expect(namedIn(fn).filter((f) => !callers.includes(f)), `${fn}: a caller the decision was not reasoned from`).toEqual([]);
    }
  });
});
