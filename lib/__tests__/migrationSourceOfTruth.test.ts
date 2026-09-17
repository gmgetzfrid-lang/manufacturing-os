// One source of truth for the database (DB-8).
//
// supabase/REMEDIATION_APPLY_ALL.sql advertised itself "safe to RE-RUN": every
// statement was CREATE OR REPLACE, frozen on the day it was written. A re-run
// after a later migration silently restored the frozen bodies of seven
// authority functions (is_org_controller, can_manage_node, …) over the live
// hardening — no error, no record. Two more files had the same shape:
// APPLY_roles-and-permissions_2026-08-24.sql (publish_revision and
// org_capability_allows frozen at 20261019/20261025) and CATCHUP_2026-05-28.sql
// (three checkout_messages policies). All three are now guarded stubs.
//
// This test keeps it that way: every .sql file under supabase/ that is NOT a
// numbered migration (and not schema.sql, the pre-migration baseline) must
// define NO function, policy or trigger that the numbered sequence defines.
// "Byte-identical today" is not an exemption — that is exactly the fork-in-
// waiting the finding describes — so the rule is any overlap at all.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const supabaseDir = join(root, "supabase");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const allSql = walk(supabaseDir).filter((p) => p.endsWith(".sql"));
const isNumbered = (p: string) => /supabase\/migrations\/\d{8}[^/]*\.sql$/.test(p);
const numbered = allSql.filter(isNumbered).sort();
const baseline = join(supabaseDir, "schema.sql");
const outside = allSql.filter((p) => !isNumbered(p) && p !== baseline);

const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
const arityOf = (args: string) => {
  const s = args.trim();
  if (!s) return 0;
  let depth = 0, count = 1;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
};

const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)/gi;
const policyRe = /CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?/gi;
const triggerRe = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?(\w+)"?\s+/gi;

/** Every function / policy / trigger a file defines, as stable keys. */
function definitions(file: string): Set<string> {
  const txt = stripSqlComments(readFileSync(file, "utf8"));
  const out = new Set<string>();
  for (const m of txt.matchAll(fnRe)) out.add(`function ${m[1]}/${arityOf(m[2])}`);
  for (const m of txt.matchAll(policyRe)) out.add(`policy ${m[2]}.${m[1]}`);
  for (const m of txt.matchAll(triggerRe)) out.add(`trigger ${m[1]}`);
  return out;
}

const rel = (p: string) => relative(root, p);

describe("the numbered migration sequence is the only source of truth (DB-8)", () => {
  it("the census sees the sequence and the retired scripts", () => {
    expect(numbered.length).toBeGreaterThan(100);
    const names = outside.map(rel);
    expect(names).toContain("supabase/REMEDIATION_APPLY_ALL.sql");
    expect(names).toContain("supabase/APPLY_roles-and-permissions_2026-08-24.sql");
    expect(names).toContain("supabase/migrations/CATCHUP_2026-05-28.sql");
  });

  it("no file outside the numbered sequence defines a function, policy or trigger the sequence defines", () => {
    const sequence = new Set<string>();
    for (const f of numbered) for (const k of definitions(f)) sequence.add(k);
    expect(sequence.size).toBeGreaterThan(100);

    const forks: string[] = [];
    for (const f of outside) {
      for (const k of definitions(f)) {
        if (sequence.has(k)) forks.push(`${rel(f)} :: ${k}`);
      }
    }
    expect(forks, [
      "A file outside supabase/migrations/NNNNNNNN_*.sql re-defines something the numbered sequence owns.",
      "Re-running it would restore a frozen copy over the live migration (DB-8). Retire the file",
      "(see the stub in supabase/REMEDIATION_APPLY_ALL.sql) or move the change into a numbered migration:",
      ...forks,
    ].join("\n")).toEqual([]);
  });

  it("the three retired scripts are guarded no-ops: a paste raises, and they carry no DDL at all", () => {
    for (const name of [
      "supabase/REMEDIATION_APPLY_ALL.sql",
      "supabase/APPLY_roles-and-permissions_2026-08-24.sql",
      "supabase/migrations/CATCHUP_2026-05-28.sql",
    ]) {
      const raw = readFileSync(join(root, name), "utf8");
      expect(raw, name).toMatch(/^-- RETIRED — DO NOT RUN\./m);
      const code = stripSqlComments(raw);
      expect(code, name).toMatch(/RAISE EXCEPTION 'RETIRED \(DB-8\)/);
      expect(code, name).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/i);
      expect(definitions(join(root, name)).size, name).toBe(0);
    }
  });

  it("the sequence's search_path lint and this census agree on what a numbered migration is", () => {
    // searchPathPin.test.ts replays /^\d{8}/ files under supabase/migrations;
    // this file uses the same predicate, so CATCHUP_* and DIAGNOSE_* fall on
    // the same side of the line for both lints.
    for (const f of numbered) expect(/^\d{8}/.test(relative(join(supabaseDir, "migrations"), f))).toBe(true);
    for (const f of outside.filter((p) => p.includes("/migrations/"))) {
      expect(/^\d{8}/.test(relative(join(supabaseDir, "migrations"), f))).toBe(false);
    }
  });
});
