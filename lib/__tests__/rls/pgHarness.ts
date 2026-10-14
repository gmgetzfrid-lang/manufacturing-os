// The database harness (intelligence I-17; AREA-1, IRLS-6, INTK-14, CB-2).
//
// A real PostgreSQL 16, started for one `npm run test:db` run under a scratch
// directory and deleted afterwards. Nothing here runs in the default suite:
// vitest.config.ts excludes lib/__tests__/rls/**, and vitest.db.config.ts is
// the only config that includes it. With no PostgreSQL on the machine the
// opt-in run SKIPS, loudly, naming the missing binary (DEC-90 ruling 2).
//
// No npm dependency: the cluster is driven by the PostgreSQL binaries
// themselves (initdb, pg_ctl, psql), so the default CI install is unchanged.
//
// Engine discovery: $MOS_TEST_PG_BIN (a bin directory) alone when it is set;
// otherwise every PATH directory holding initdb, then the usual package
// locations (/usr/lib/postgresql/<n>/bin, Homebrew, /usr/pgsql-16). The major
// version must be 16 or later. initdb refuses to run as root, so under root
// the cluster runs as $MOS_TEST_PG_USER, else the OS user `postgres`.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface PgBinaries {
  dir: string;
  initdb: string;
  pgCtl: string;
  psql: string;
  major: number;
  version: string;
  /** The OS user the server runs as when the harness itself runs as root. */
  runAs: { name: string; uid: number; gid: number } | null;
}

export type Discovery = { ok: true; bin: PgBinaries } | { ok: false; missing: string };

function run(cmd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { encoding: "utf8", input: opts.input, env: opts.env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
}

function candidateDirs(env: NodeJS.ProcessEnv): string[] {
  // An explicit bin directory is the operator's choice: only it is tried.
  if (env.MOS_TEST_PG_BIN) return [env.MOS_TEST_PG_BIN];
  const out: string[] = [];
  for (const d of (env.PATH ?? "").split(delimiter)) if (d) out.push(d);
  const debian = "/usr/lib/postgresql";
  if (existsSync(debian)) {
    for (const v of readdirSync(debian).filter((x) => /^\d+$/.test(x)).sort((a, b) => Number(b) - Number(a))) {
      out.push(join(debian, v, "bin"));
    }
  }
  out.push("/usr/local/pgsql/bin", "/opt/homebrew/opt/postgresql@16/bin", "/usr/local/opt/postgresql@16/bin", "/usr/pgsql-16/bin");
  return out;
}

/** Finds a PostgreSQL ≥ 16 the harness can start, or names what is missing. */
export function discoverPostgres(env: NodeJS.ProcessEnv = process.env): Discovery {
  let seenOld: string | null = null;
  for (const dir of candidateDirs(env)) {
    const initdb = join(dir, "initdb");
    const pgCtl = join(dir, "pg_ctl");
    const psql = join(dir, "psql");
    const postgres = join(dir, "postgres");
    if (!existsSync(initdb) || !existsSync(pgCtl) || !existsSync(psql) || !existsSync(postgres)) continue;
    const v = run(postgres, ["--version"]);
    const m = /(\d+)(?:\.(\d+))?/.exec(v.stdout ?? "");
    const major = m ? Number(m[1]) : 0;
    if (major < 16) { seenOld = `${postgres} is ${String(v.stdout).trim() || "unknown"}`; continue; }
    let runAs: PgBinaries["runAs"] = null;
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      const name = env.MOS_TEST_PG_USER || "postgres";
      const uid = run("id", ["-u", name]);
      const gid = run("id", ["-g", name]);
      if (uid.status !== 0 || gid.status !== 0) {
        return { ok: false, missing: `a non-root OS user for initdb (running as root; no user '${name}' — set MOS_TEST_PG_USER)` };
      }
      if (run("runuser", ["--help"]).error) {
        return { ok: false, missing: "runuser (running as root; initdb must run as a non-root user)" };
      }
      runAs = { name, uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) };
    }
    const sharedir = run(join(dir, "pg_config"), ["--sharedir"]);
    const share = sharedir.status === 0 ? sharedir.stdout.trim() : "";
    if (share && !existsSync(join(share, "extension", "vector.control"))) {
      return { ok: false, missing: `pgvector (${join(share, "extension", "vector.control")}; 20260930 creates the vector extension — install postgresql-${major}-pgvector)` };
    }
    return { ok: true, bin: { dir, initdb, pgCtl, psql, major, version: String(v.stdout).trim(), runAs } };
  }
  if (env.MOS_TEST_PG_BIN) return { ok: false, missing: `initdb / pg_ctl / psql / postgres (PostgreSQL 16) in MOS_TEST_PG_BIN=${env.MOS_TEST_PG_BIN}` };
  return { ok: false, missing: seenOld ? `PostgreSQL 16 initdb (found only ${seenOld}; set MOS_TEST_PG_BIN)` : "initdb (PostgreSQL 16; set MOS_TEST_PG_BIN to its bin directory)" };
}

export interface PsqlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The first `ERROR:` message psql printed, if any. */
  error: string | null;
  /** Every `ERROR:` message, in order (a statement-by-statement file run). */
  errors: string[];
}

/** How a test reaches the scratch cluster (serialisable: handed to the tests by globalSetup). */
export interface PgConn {
  psql: string;
  /** The Unix-socket directory (the scratch root). */
  host: string;
  port: number;
  superuser: string;
}

/**
 * Runs SQL through psql. `sql` is sent with -c, as ONE simple-query message —
 * the way the Supabase SQL editor sends a paste: the statements share one
 * implicit transaction unless the script opens its own, and the first error
 * stops the rest. `file` instead runs a file statement by statement in
 * autocommit (used only for the baseline, see replay.ts).
 */
export function runPsql(conn: PgConn, db: string, user: string, input: { sql: string } | { file: string; stopOnError: boolean }, settings: Record<string, string> = {}): PsqlResult {
  const args = ["-X", "-q", "-A", "-t", "-h", conn.host, "-p", String(conn.port), "-U", user, "-d", db];
  if ("sql" in input) args.push("-v", "ON_ERROR_STOP=1", "-c", input.sql);
  else args.push("-v", `ON_ERROR_STOP=${input.stopOnError ? 1 : 0}`, "-f", input.file);
  const opts = ["-c client_min_messages=warning", ...Object.entries(settings).map(([k, v]) => `-c ${k}=${v}`)].join(" ");
  const r = run(conn.psql, args, { env: { ...process.env, PGOPTIONS: opts, PGCONNECT_TIMEOUT: "10" } });
  const stderr = r.stderr ?? "";
  const errors = [...stderr.matchAll(/ERROR:\s+([^\n]*)/g)].map((m) => m[1]);
  return { ok: r.status === 0 && errors.length === 0, stdout: (r.stdout ?? "").replace(/\n$/, ""), stderr, error: errors[0] ?? null, errors };
}

/** Runs SQL as the superuser and throws on any error. */
export function adminSql(conn: PgConn, db: string, sql: string): string {
  const r = runPsql(conn, db, conn.superuser, { sql });
  if (!r.ok) throw new Error(`harness admin SQL failed on ${db}: ${r.error ?? r.stderr}`);
  return r.stdout;
}

/** A scratch cluster: one directory under the OS temp dir, deleted by destroy(). */
export class ScratchCluster {
  readonly root: string;
  readonly port: number;
  readonly superuser = "supabase_admin";
  private started = false;

  constructor(readonly bin: PgBinaries) {
    this.root = mkdtempSync(join(tmpdir(), "mos-test-pg-"));
    this.port = 50000 + Math.floor(Math.random() * 10000);
    if (bin.runAs) chownSync(this.root, bin.runAs.uid, bin.runAs.gid);
  }

  private asServerUser(cmd: string, args: string[]) {
    return this.bin.runAs ? run("runuser", ["-u", this.bin.runAs.name, "--", cmd, ...args]) : run(cmd, args);
  }

  start(): void {
    const data = join(this.root, "data");
    const init = this.asServerUser(this.bin.initdb, ["-D", data, "-U", this.superuser, "--auth=trust", "-E", "UTF8", "--no-locale", "--no-sync"]);
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr || init.stdout}`);
    // The server listens on a Unix socket inside the scratch directory only.
    const conf = [
      "",
      "# mos test harness (scratch cluster)",
      "listen_addresses = ''",
      `unix_socket_directories = '${this.root}'`,
      `port = ${this.port}`,
      "fsync = off",
      "synchronous_commit = off",
      "full_page_writes = off",
      "max_connections = 40",
      "",
    ].join("\n");
    if (this.bin.runAs) {
      // The data directory is private to the server user (initdb makes it 0700).
      const a = run("runuser", ["-u", this.bin.runAs.name, "--", "tee", "-a", join(data, "postgresql.conf")], { input: conf });
      if (a.status !== 0) throw new Error(`could not configure the scratch cluster: ${a.stderr}`);
    } else {
      appendFileSync(join(data, "postgresql.conf"), conf);
    }
    const st = this.asServerUser(this.bin.pgCtl, ["-D", data, "-l", join(this.root, "server.log"), "-w", "-t", "60", "start"]);
    if (st.status !== 0) {
      const log = existsSync(join(this.root, "server.log")) ? readFileSync(join(this.root, "server.log"), "utf8") : "";
      throw new Error(`pg_ctl start failed: ${st.stderr || st.stdout}\n${log}`);
    }
    this.started = true;
  }

  /** Stops the server and deletes the whole scratch directory. Safe to call twice. */
  destroy(): void {
    if (this.started) {
      this.asServerUser(this.bin.pgCtl, ["-D", join(this.root, "data"), "-m", "immediate", "-w", "stop"]);
      this.started = false;
    }
    rmSync(this.root, { recursive: true, force: true });
  }

  get conn(): PgConn {
    return { psql: this.bin.psql, host: this.root, port: this.port, superuser: this.superuser };
  }

  /** Writes a scratch file inside the cluster directory (readable by the server user). */
  scratchFile(name: string, body: string): string {
    const p = join(this.root, name);
    writeFileSync(p, body);
    if (this.bin.runAs) chownSync(p, this.bin.runAs.uid, this.bin.runAs.gid);
    return p;
  }
}

/** Dollar-quotes a string for SQL with a tag that cannot occur inside it. */
export function dollarQuote(s: string): string {
  let tag = "q";
  while (s.includes(`$${tag}$`)) tag += "q";
  return `$${tag}$${s}$${tag}$`;
}
