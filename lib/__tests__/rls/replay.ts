// The fresh-install replay (intelligence I-17; IRLS-6): supabase/schema.sql,
// then every numbered migration in filename order, onto the Supabase
// stand-in, in a database created for the run.
//
// How each file is sent, and why:
//   * supabaseStandIn.sql — as the superuser, stopping on the first error.
//   * supabase/schema.sql — as `postgres`, the whole file as ONE
//     simple-query message, exactly as the SQL editor sends a paste (since
//     intelligence I-27, IRLS-17: until then it stopped at :328 on a fresh
//     database, so the harness ran it statement by statement). Its error, if
//     any, is held to BASELINE_KNOWN_ERRORS (empty).
//   * each numbered migration — as `postgres`, the whole file as ONE
//     simple-query message, exactly as the Supabase SQL editor sends a paste
//     (one implicit transaction unless the file opens its own; the first error
//     stops the rest). psql's -c argument is capped at 128 kB by the kernel
//     (MAX_ARG_STRLEN), so a file over MAX_C_BYTES cannot be sent that way:
//     the replay then STOPS, naming the file, rather than run it any other
//     way (psql -f would run it statement by statement in autocommit, and a
//     late error would leave its earlier statements applied — not what a
//     paste does). Only the opt-in run checks the files against the limit
//     (freshReplay.test.ts, and this stop): it is a limit of the harness's
//     transport, so it never gates the default suite or CI, which pins only
//     that the stop exists. The largest file today, 20261157, is about 99 kB.
//
// The replay never edits a file. A file that fails is recorded; the known
// ones (OUT_OF_ORDER_FILES, empty since I-27) are re-run once at the end when
// they rolled back.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { adminSql, runPsql, type PgConn } from "./pgHarness";
import { CHECKPOINTS, OPERATOR_SWITCHES, OUT_OF_ORDER_FILES } from "./replayKnownDefects";

export interface FileOutcome {
  file: string;
  ok: boolean;
  error: string | null;
  ms: number;
}

export interface ReplayReport {
  engine: string;
  vector: string | null;
  database: string;
  /** Snapshot database per checkpoint: the sequence up to (not including) that file. */
  checkpoints: Record<string, string>;
  baselineErrors: string[];
  files: FileOutcome[];
  retries: FileOutcome[];
  ms: number;
}

export const REPLAY_DB = "mos_replay";
/** The largest file the replay sends as one simple-query message (psql -c), under the kernel's 128 kB argument cap. */
export const MAX_C_BYTES = 120_000;

export function numberedMigrations(repoRoot: string): string[] {
  return readdirSync(join(repoRoot, "supabase", "migrations"))
    .filter((f) => /^\d{8}.*\.sql$/.test(f))
    .sort();
}

/** One file as ONE simple-query message (a paste), or a stop naming it when it is too large to send that way. */
function runAsPaste(conn: PgConn, db: string, path: string, file: string, settings: Record<string, string> = {}): FileOutcome {
  const t0 = Date.now();
  const body = readFileSync(path, "utf8");
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_C_BYTES) {
    throw new Error(
      `${file} is ${bytes} bytes, over the replay's ${MAX_C_BYTES}-byte limit for one simple-query message (psql -c). ` +
      "The harness will not run it statement by statement, which is not what a paste does: split the migration, or give the harness a transport that sends it as one message.",
    );
  }
  const r = runPsql(conn, db, "postgres", { sql: body }, settings);
  return { file, ok: r.ok, error: r.ok ? null : (r.error ?? r.stderr.trim().split("\n")[0] ?? "unknown failure"), ms: Date.now() - t0 };
}

function runMigration(conn: PgConn, db: string, path: string, file: string): FileOutcome {
  return runAsPaste(conn, db, path, file, OPERATOR_SWITCHES[file] ?? {});
}

/** The helper schema the RLS tests call through (never part of the census). */
const HARNESS_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS harness AUTHORIZATION supabase_admin;
GRANT USAGE ON SCHEMA harness TO anon, authenticated, service_role, postgres;
-- SECURITY INVOKER: the statement runs as whoever calls it, so row-level
-- security judges it exactly as it judges that role's PostgREST request.
-- The exception block is a subtransaction: a refused statement leaves nothing.
CREATE OR REPLACE FUNCTION harness.try_sql(p_sql text) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE n bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN 'ok:' || n;
EXCEPTION WHEN OTHERS THEN
  RETURN 'err:' || SQLSTATE || ':' || SQLERRM;
END
$fn$;
REVOKE ALL ON FUNCTION harness.try_sql(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION harness.try_sql(text) TO anon, authenticated, service_role, postgres;
`;

export function replayFreshInstall(conn: PgConn, repoRoot: string, log: (line: string) => void = () => {}): ReplayReport {
  const t0 = Date.now();
  const engine = adminSql(conn, "postgres", "SELECT version()");
  adminSql(conn, "postgres", `CREATE DATABASE ${REPLAY_DB}`);
  const standIn = runPsql(conn, REPLAY_DB, conn.superuser, { file: join(repoRoot, "lib", "__tests__", "rls", "supabaseStandIn.sql"), stopOnError: true });
  if (!standIn.ok) throw new Error(`the Supabase stand-in failed: ${standIn.error ?? standIn.stderr}`);
  const vector = adminSql(conn, REPLAY_DB, "SELECT extversion FROM pg_extension WHERE extname = 'vector'") || null;

  // supabase/schema.sql as ONE script, the editor's way (IRLS-17): an error
  // anywhere rolls the whole paste back, so its first error is the outcome.
  const baseline = runAsPaste(conn, REPLAY_DB, join(repoRoot, "supabase", "schema.sql"), "supabase/schema.sql");
  const baselineErrors = baseline.ok ? [] : [baseline.error ?? "unknown failure"];
  log(`[test:db] baseline supabase/schema.sql as one script: ${baseline.ok ? "ok" : `FAILED — ${baselineErrors[0]}`}`);

  const checkpoints: Record<string, string> = {};
  const files: FileOutcome[] = [];
  for (const file of numberedMigrations(repoRoot)) {
    const cp = CHECKPOINTS.find((c) => file.startsWith(c) && !checkpoints[c]);
    if (cp) {
      const snap = `mos_before_${cp}`;
      adminSql(conn, "postgres", `CREATE DATABASE ${snap} TEMPLATE ${REPLAY_DB}`);
      checkpoints[cp] = snap;
    }
    const out = runMigration(conn, REPLAY_DB, join(repoRoot, "supabase", "migrations", file), file);
    files.push(out);
    if (!out.ok) log(`[test:db] ${file}: ${out.error}`);
  }

  // Known out-of-order files that rolled back: re-run once after the sequence,
  // in the final database and in every checkpoint snapshot that ran them.
  const retries: FileOutcome[] = [];
  for (const k of OUT_OF_ORDER_FILES) {
    const first = files.find((f) => f.file === k.file);
    if (!first || first.ok || k.mode !== "retry") continue;
    const path = join(repoRoot, "supabase", "migrations", k.file);
    retries.push(runMigration(conn, REPLAY_DB, path, k.file));
    for (const [cp, snap] of Object.entries(checkpoints)) {
      if (k.file < cp) {
        const r = runMigration(conn, snap, path, k.file);
        if (!r.ok) retries.push({ ...r, file: `${k.file} (in ${snap})` });
      }
    }
  }

  for (const db of [REPLAY_DB, ...Object.values(checkpoints)]) adminSql(conn, db, HARNESS_SCHEMA);
  return { engine, vector, database: REPLAY_DB, checkpoints, baselineErrors, files, retries, ms: Date.now() - t0 };
}
