// document-control F6-column-widths (REV-38 / REV-39) — 20261271's shape,
// read at test time from supabase/migrations (its behaviour is pinned on
// PostgreSQL 16 by lib/__tests__/rls/dcF6ColumnWidthsMerge.test.ts):
//   * the DEC-30 one-paste shape: prerequisites, a TEMP counts-only
//     inventory before the transaction, one BEGIN / COMMIT, one final SELECT
//     (check, ok, n); no apostrophe inside any SQL string literal;
//   * it re-creates nothing that exists: its three functions and two triggers
//     are defined by no other migration (scanned), it creates no policy and
//     drops nothing but its own triggers;
//   * DRLS-16 for its one SECURITY DEFINER function;
//   * the rail's five columns, and a tripwire: every app write of one of them
//     sits in a file whose write is offered to controllers only (the trace
//     REV-39 records). A new writer elsewhere fails here until it is judged.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIR = join(ROOT, "supabase", "migrations");
const FILE = "20261271_dc_rev38_column_widths_merge.sql";
const FILES = readdirSync(DIR).filter((f) => /^\d{8}_.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const SQL = read(FILE);
const CODE = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const codeOf = (f: string) => read(f).split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

const NEW_FUNCTIONS = ["bump_library_column_widths_rev", "save_library_column_widths", "enforce_library_layout_columns"];
const NEW_TRIGGERS = ["trg_library_column_widths_rev", "trg_library_layout_columns"];
const LAYOUT_COLUMNS = ["column_widths", "custom_columns", "column_label_overrides", "uniqueness_keys", "home_config"];

describe("20261271 — the DEC-30 one-paste shape", () => {
  it("prerequisites, then the TEMP counts-only inventory, then one BEGIN / COMMIT, then one final SELECT (check, ok, n)", () => {
    const pre = CODE.indexOf("DO $$");
    const temp = CODE.indexOf("CREATE TEMP TABLE dc_rev38_20261271_before AS");
    const begin = CODE.indexOf("\nBEGIN;");
    const commit = CODE.indexOf("\nCOMMIT;");
    expect(pre).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(CODE.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(CODE.match(/^COMMIT;$/gm)?.length).toBe(1);
    const after = CODE.slice(commit + "\nCOMMIT;".length);
    expect(after.trim().startsWith('SELECT "check", ok, n FROM (')).toBe(true);
    expect(after.replace(/'[^']*'/g, "").match(/;/g)?.length).toBe(1); // one statement (literals aside)
    expect(after.trim().endsWith("ORDER BY sec, ord;")).toBe(true);
    // the inventory reads counts only, never a row
    const inventory = CODE.slice(temp, begin);
    expect(inventory.match(/COUNT\(\*\)::text/g)?.length).toBe(7);
    expect(inventory).not.toMatch(/SELECT \*|row_to_json|to_jsonb\(l\)/);
  });

  it("no apostrophe inside any SQL string literal (no doubled quote, no E-string)", () => {
    expect(CODE).not.toMatch(/''/);
    expect(CODE).not.toMatch(/\bE'/);
  });

  it("re-paste safe: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS before each CREATE TRIGGER", () => {
    expect(CODE).toContain("ALTER TABLE libraries ADD COLUMN IF NOT EXISTS column_widths_rev bigint NOT NULL DEFAULT 0;");
    expect(CODE.match(/CREATE FUNCTION/g)).toBeNull();
    for (const t of NEW_TRIGGERS) {
      expect(CODE.indexOf(`DROP TRIGGER IF EXISTS ${t} ON libraries;`)).toBeLessThan(CODE.indexOf(`CREATE TRIGGER ${t}`));
    }
  });
});

describe("20261271 — it re-creates nothing that exists", () => {
  it("its three functions and two triggers are defined by no other migration or schema.sql; it defines no other function, trigger or policy", () => {
    const created = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION\s+(\w+)\s*\(/g)].map((m) => m[1]);
    expect(created.sort()).toEqual([...NEW_FUNCTIONS].sort());
    expect([...CODE.matchAll(/CREATE TRIGGER\s+(\w+)/g)].map((m) => m[1]).sort()).toEqual([...NEW_TRIGGERS].sort());
    expect(CODE).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY|DROP FUNCTION|ALTER FUNCTION/);
    expect([...CODE.matchAll(/DROP TRIGGER IF EXISTS (\w+)/g)].map((m) => m[1]).sort()).toEqual([...NEW_TRIGGERS].sort());
    const others = [...FILES.filter((f) => f !== FILE).map(codeOf), readFileSync(join(ROOT, "supabase", "schema.sql"), "utf8")];
    for (const name of [...NEW_FUNCTIONS, ...NEW_TRIGGERS, "column_widths_rev"]) {
      expect(others.some((s) => new RegExp(`\\b${name}\\b`).test(s)), name).toBe(false);
    }
  });
});

describe("20261271 — DRLS-16 and the function's contract", () => {
  it("save_library_column_widths: SECURITY DEFINER, search_path pinned, EXECUTE revoked from PUBLIC, anon and service_role, granted to authenticated", () => {
    expect(CODE).toMatch(/CREATE OR REPLACE FUNCTION save_library_column_widths\(p_library uuid, p_set jsonb, p_reset text\[\]\)\nRETURNS TABLE \(column_widths jsonb, column_widths_rev bigint\)\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(CODE).toContain("REVOKE ALL ON FUNCTION save_library_column_widths(uuid, jsonb, text[]) FROM PUBLIC, anon, service_role;");
    expect(CODE).toContain("GRANT EXECUTE ON FUNCTION save_library_column_widths(uuid, jsonb, text[]) TO authenticated;");
    // the two trigger functions are SECURITY INVOKER with search_path pinned
    for (const f of ["bump_library_column_widths_rev", "enforce_library_layout_columns"]) {
      expect(CODE).toContain(`CREATE OR REPLACE FUNCTION ${f}()\nRETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$`);
      expect(CODE).toContain(`REVOKE ALL ON FUNCTION ${f}() FROM PUBLIC;`);
    }
  });

  it("held to is_org_controller of the library workspace; one merge statement; the version is the server's", () => {
    expect(CODE).toContain("IF v_org IS NULL OR NOT is_org_controller(v_org) THEN");
    expect(CODE).toMatch(/RETURN QUERY\s+UPDATE libraries l\s+SET column_widths = \(CASE WHEN jsonb_typeof\(l\.column_widths\) = 'object' THEN l\.column_widths ELSE '\{\}'::jsonb END \|\| v_set\) - v_reset,/);
    expect(CODE).toContain("NEW.column_widths_rev := OLD.column_widths_rev + 1;");
    expect(CODE).toContain("NEW.column_widths_rev := OLD.column_widths_rev;");
    expect(CODE).toContain("NEW.column_widths_rev := 0;");
  });
});

describe("20261271 — the layout rail and its writers", () => {
  it("the rail judges exactly the five layout columns, by is_org_controller(OLD.org_id), passing a write with no uid", () => {
    const body = CODE.slice(CODE.indexOf("CREATE OR REPLACE FUNCTION enforce_library_layout_columns()"), CODE.indexOf("DROP TRIGGER IF EXISTS trg_library_layout_columns"));
    expect([...body.matchAll(/NEW\.(\w+) IS DISTINCT FROM OLD\.\1/g)].map((m) => m[1]).sort()).toEqual([...LAYOUT_COLUMNS].sort());
    expect(body).toContain("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
    expect(body).toContain("IF NOT is_org_controller(OLD.org_id) THEN");
  });

  it("tripwire: every app write of a layout column is in a file whose write is offered to controllers only (REV-39's trace)", () => {
    const CONTROLLER_ONLY_WRITERS = new Set([
      "app/(protected)/documents/[libraryId]/page.tsx", // each write under isController (the column, rule, home and width paths)
      "app/(protected)/admin/libraries/page.tsx",       // the library editor: controllers only (redirect, render null)
      "lib/libraryColumnWidths.ts",                     // the width save: the controller tier (canSaveColumnWidths)
    ]);
    const walk = (d: string): string[] => readdirSync(join(ROOT, d)).flatMap((n) => {
      const p = `${d}/${n}`;
      if (n === "node_modules" || n === "__tests__") return [];
      return statSync(join(ROOT, p)).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
    const offenders: string[] = [];
    for (const f of [...walk("app"), ...walk("lib"), ...walk("components")]) {
      const s = readFileSync(join(ROOT, f), "utf8");
      for (const m of s.matchAll(/\.from\(\s*["']libraries["']\s*\)[\s\S]{0,40}?\.(update|upsert)\(([\s\S]{0,400}?)\)/g)) {
        if (LAYOUT_COLUMNS.some((c) => new RegExp(`\\b${c}\\b|\\.\\.\\.dbConfig`).test(m[2])) && !CONTROLLER_ONLY_WRITERS.has(f)) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
