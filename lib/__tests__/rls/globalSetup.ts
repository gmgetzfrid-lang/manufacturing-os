// globalSetup for `npm run test:db` (vitest.db.config.ts) — intelligence I-17.
//
// Finds a PostgreSQL 16, starts a scratch cluster, replays the repository
// onto it once, hands the tests the connection and the replay report, and
// deletes the cluster afterwards. With no PostgreSQL it prints ONE line naming
// what is missing and the suites skip (DEC-90 ruling 2): never a failure,
// never a silent pass.

import type { TestProject } from "vitest/node";
import { discoverPostgres, ScratchCluster, type PgConn } from "./pgHarness";
import { replayFreshInstall, type ReplayReport } from "./replay";

export interface MosDbContext {
  skip: string | null;
  conn: PgConn | null;
  report: ReplayReport | null;
}

declare module "vitest" {
  export interface ProvidedContext {
    mosDb: MosDbContext;
  }
}

export default function setup(project: TestProject) {
  const found = discoverPostgres();
  if (!found.ok) {
    const line = `[test:db] SKIPPED — missing ${found.missing}. The database suites did not run.`;
    console.warn(line);
    project.provide("mosDb", { skip: line, conn: null, report: null });
    return;
  }
  const cluster = new ScratchCluster(found.bin);
  const cleanup = () => { try { cluster.destroy(); } catch { /* already gone */ } };
  process.once("exit", cleanup);
  try {
    cluster.start();
    console.warn(`[test:db] ${found.bin.version} — scratch cluster at ${cluster.root} (deleted after the run)`);
    const report = replayFreshInstall(cluster.conn, process.cwd(), (l) => console.warn(l));
    console.warn(`[test:db] replayed schema.sql + ${report.files.length} migrations in ${(report.ms / 1000).toFixed(1)} s (pgvector ${report.vector ?? "absent"})`);
    project.provide("mosDb", { skip: null, conn: cluster.conn, report });
  } catch (e) {
    cleanup();
    throw e;
  }
  return () => {
    cleanup();
  };
}
