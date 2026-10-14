// Engine discovery against real executables (intelligence I-17; DEC-90
// ruling 1) — `npm run test:db` only.
//
// The default suite tests the same rule as pure logic over an injected host
// (lib/__tests__/intelRoundGDbHarness.test.ts) and never writes or executes a
// script. Here the three cases run against stand-in bin directories whose
// `postgres --version` really executes. They are written inside the
// repository (node_modules/.cache/mos-fake-pg-*), never in the OS temp
// directory, and when a script there cannot be executed (a noexec mount) the
// cases skip with the reason printed.

import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { discoverPostgres } from "./pgHarness";
import { skipReason } from "./dbKit";

const skip = skipReason();

const cacheDir = join(process.cwd(), "node_modules", ".cache");
const made: string[] = [];

/** A stand-in bin directory: initdb / pg_ctl / psql exist, postgres prints a version. */
function fakeBin(version: string): string {
  mkdirSync(cacheDir, { recursive: true });
  const dir = mkdtempSync(join(cacheDir, "mos-fake-pg-"));
  made.push(dir);
  for (const f of ["initdb", "pg_ctl", "psql"]) writeFileSync(join(dir, f), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(dir, "postgres"), `#!/bin/sh\necho "postgres (PostgreSQL) ${version}"\n`);
  for (const f of ["initdb", "pg_ctl", "psql", "postgres"]) chmodSync(join(dir, f), 0o755);
  return dir;
}

/** Null when a script written there runs; otherwise why the cases skip. */
function cannotExecute(): string | null {
  if (process.platform === "win32") return "stand-in shell scripts need a POSIX shell";
  if (skip !== null) return skip;
  let dir: string | null = null;
  try {
    dir = fakeBin("16.0");
    const r = spawnSync(join(dir, "postgres"), ["--version"], { encoding: "utf8" });
    if (r.error || r.status !== 0 || !/\(PostgreSQL\) 16\.0/.test(r.stdout ?? "")) {
      return `a script in ${cacheDir} cannot be executed (${r.error?.message ?? `exit ${r.status}`}); is the repository on a noexec mount?`;
    }
    return null;
  } catch (e) {
    return `could not write a stand-in executable under ${cacheDir}: ${(e as Error).message}`;
  } finally {
    if (dir) { rmSync(dir, { recursive: true, force: true }); made.splice(made.indexOf(dir), 1); }
  }
}

const noExec = cannotExecute();
if (noExec !== null && skip === null) console.warn(`[test:db] discovery against real executables SKIPPED — ${noExec}`);

describe.skipIf(skip !== null)("discovery runs on PostgreSQL 16 unless the operator says otherwise (real executables)", () => {
  afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
  const base = { ...process.env, MOS_TEST_PG_BIN: "", MOS_TEST_PG_ALLOW_MAJOR: "", MOS_TEST_PG_USER: userInfo().username };

  it.skipIf(noExec !== null)("a host with 17 and 16 runs on 16, whichever comes first", () => {
    const v17 = fakeBin("17.2");
    const v16 = fakeBin("16.13");
    const d = discoverPostgres({ ...base, PATH: [v17, v16].join(delimiter) }, { packageDirs: false });
    expect(d.ok).toBe(true);
    if (d.ok) { expect(d.bin.major).toBe(16); expect(d.bin.dir).toBe(v16); }
  });

  it.skipIf(noExec !== null)("a host with only 17 skips loudly, naming the two ways to use it", () => {
    const v17 = fakeBin("17.2");
    const d = discoverPostgres({ ...base, PATH: v17 }, { packageDirs: false });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.missing).toMatch(/PostgreSQL 16 initdb \(found only PostgreSQL 17 at .*MOS_TEST_PG_BIN.*MOS_TEST_PG_ALLOW_MAJOR=17\)/);
  });

  it.skipIf(noExec !== null)("17 runs only when MOS_TEST_PG_ALLOW_MAJOR names it, or MOS_TEST_PG_BIN points at it", () => {
    const v17 = fakeBin("17.2");
    const allowed = discoverPostgres({ ...base, PATH: v17, MOS_TEST_PG_ALLOW_MAJOR: "17" }, { packageDirs: false });
    expect(allowed.ok && allowed.bin.major).toBe(17);
    const explicit = discoverPostgres({ ...base, PATH: "", MOS_TEST_PG_BIN: v17 }, { packageDirs: false });
    expect(explicit.ok && explicit.bin.major).toBe(17);
    const old = discoverPostgres({ ...base, PATH: "", MOS_TEST_PG_BIN: fakeBin("15.6") }, { packageDirs: false });
    expect(old.ok).toBe(false);
  });
});
