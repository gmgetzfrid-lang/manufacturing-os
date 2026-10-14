// admin-and-org Round G, P15 APPEARANCE FOLLOW-UPS.
//
//   ORG-19  20261216: the appearance rail also judges a NEW library or folder
//           — a person's INSERT that sets the cover image, its tint or a page
//           background needs is_org_controller(NEW.org_id), the gate 20261210
//           applies to a change; an INSERT that sets none of them is decided
//           as before; a write with no uid passes.
//   ORG-21  libraries.color / collections.color: every render site draws a
//           stored colour only when it is #rgb / #rrggbb (lib/nodeColor.ts),
//           and 20261216 refuses any other colour a signed-in writer sets on
//           INSERT or changes on UPDATE. A stored value is never rewritten.
//
// Behaviour was exercised on a throwaway PostgreSQL 16 with the real bodies
// (the cases are in the records). This file pins the shape against the
// NEWEST definitions found by scanning supabase/migrations at test time, the
// render sites as rendered, and every app INSERT into the two tables.

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

vi.mock("@/lib/storage", () => ({ peekSignedUrl: () => undefined, subscribeSignedUrl: () => () => {} }));

import NodeCover from "@/components/documents/NodeCover";
import PathBar from "@/components/documents/PathBar";
import { NODE_COLOR_PATTERN, NODE_COLOR_SQL_PATTERN, safeNodeColor } from "@/lib/nodeColor";
import { NODE_CUSTOMIZE_ROLES } from "@/lib/storageKey";

const ROOT = process.cwd();
const DIR = join(ROOT, "supabase", "migrations");
const FILES = readdirSync(DIR).filter((f) => /^\d{8}_.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const FILE = "20261216_ao_roundG_appearance_insert_and_colour.sql";
const P11 = "20261210_ao_roundG_node_appearance_rail.sql";
const SQL = read(FILE);
const CODE = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

const PAYLOAD = "red, red), url(https://example.net/p.png) /*";
const SWATCH_SRC = src("components/documents/CustomizeNodeModal.tsx").match(/const COLOR_SWATCHES = \[([^\]]*)\];/)![1];
const SWATCHES = [...SWATCH_SRC.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/** Every CREATE [OR REPLACE] FUNCTION <name>( … in the given files, in order. */
function definitions(name: string, files: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, "g");
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(re)) {
      const lineStart = s.lastIndexOf("\n", m.index!) + 1;
      if (/^\s*--/.test(s.slice(lineStart, m.index!))) continue;
      const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
      open.lastIndex = m.index!;
      const tag = open.exec(s)!;
      const end = s.indexOf(tag[0], tag.index + tag[0].length);
      out.push([f, s.slice(m.index!, end + tag[0].length)]);
    }
  }
  return out;
}

/** A set difference (Array.includes): it says which lines exist on one side
 *  only, not where. Order and repeats are pinned by the exact reconstruction
 *  test below. */
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

/** Every trigger any migration (or schema.sql) attaches to libraries / collections. */
function triggersOn(table: "libraries" | "collections"): Array<{ file: string; name: string; fn: string; timing: string }> {
  const out: Array<{ file: string; name: string; fn: string; timing: string }> = [];
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+"?(\\w+)"?\\s+(BEFORE|AFTER)\\s+([\\w\\s,]+?)\\s+ON\\s+(?:public\\.)?${table}\\b[\\s\\S]*?EXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+(\\w+)`, "gi");
  for (const f of [...FILES.map((x) => join(DIR, x)), join(ROOT, "supabase", "schema.sql")]) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(re)) out.push({ file: f.split("/").pop()!, name: m[1], timing: `${m[2]} ${m[3].trim().replace(/\s+/g, " ")}`.toUpperCase(), fn: m[4] });
  }
  return out;
}

// ── 20261216: DEC-30 shape ──────────────────────────────────────────────────
describe("20261216 — DEC-30 one-paste shape", () => {
  it("counts-only TEMP inventory BEFORE the transaction, one BEGIN / COMMIT, one final (check, ok, n) SELECT closed by the inventory rows", () => {
    const begin = CODE.indexOf("\nBEGIN;");
    expect(begin).toBeGreaterThan(0);
    expect(CODE.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(CODE.match(/\nCOMMIT;/g)).toHaveLength(1);
    expect(CODE.indexOf("CREATE TEMP TABLE IF NOT EXISTS ao_p15_20261216_inventory")).toBeLessThan(begin);
    const inv = CODE.slice(CODE.indexOf("INSERT INTO ao_p15_20261216_inventory"), begin);
    expect(inv).not.toMatch(/SELECT\s+\*/);
    for (const sel of inv.split(/UNION ALL/)) expect(sel, sel.slice(0, 80)).toMatch(/COUNT\(\*\)/);
    // the stored colours that fail the format are counted, never changed
    expect(inv).toContain(`color !~ '${NODE_COLOR_SQL_PATTERN}'`);
    const tail = CODE.slice(CODE.lastIndexOf("\nCOMMIT;"));
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    const after = tail.replace(/^\nCOMMIT;/, "");
    expect(after.trimStart()).toMatch(/^SELECT /);
    expect(after).not.toMatch(/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|TRUNCATE)\b/m);
    expect(after.trimEnd()).toMatch(/SELECT check_name, NULL, n::text FROM ao_p15_20261216_inventory;$/);
    // no row is rewritten anywhere in the script
    expect(CODE).not.toMatch(/\bUPDATE\s+(libraries|collections)\b/);
    expect(CODE).not.toMatch(/ADD CONSTRAINT|ALTER TABLE/);
  });

  it("DRLS-16: the one SECURITY DEFINER function pins search_path and revokes EXECUTE from PUBLIC, anon and authenticated", () => {
    const defs = [...SQL.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(\)\s*\nRETURNS[^\n]*/g)];
    expect(defs.map((m) => m[1])).toEqual(["enforce_node_appearance_columns"]);
    expect(defs[0][0]).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(SQL).toContain("REVOKE ALL ON FUNCTION enforce_node_appearance_columns() FROM PUBLIC, anon, authenticated;");
  });

  it("probe literals: a prosrc apostrophe inside a body string is written '''' ; no policy LIKE with a cast", () => {
    expect(CODE).toContain("prosrc LIKE '%A folder''''s or library''''s colour must be a hex colour such as #2563eb.%'");
    expect(CODE).toContain("prosrc LIKE '%folder''''s or library''''s cover image or background.%'");
    expect(CODE).toContain(`prosrc LIKE '%NEW.color !~ ''${NODE_COLOR_SQL_PATTERN}''%'`);
    for (const m of CODE.matchAll(/(qual|with_check)\s+LIKE\s+'([^']|'')*'/g)) expect(m[0]).not.toMatch(/::/);
  });
});

// ── 20261216: paste order (supersedes 20261210) and the 20261011 folder policy ──
describe("20261216 — paste order and what the paste may rely on", () => {
  const tail = CODE.slice(CODE.lastIndexOf("\nCOMMIT;"));
  const rows = tail.split(/\nUNION ALL\n/);
  const probes = rows.filter((r) => !/FROM ao_p15_20261216_inventory;\s*$/.test(r));
  const inv = CODE.slice(CODE.indexOf("INSERT INTO ao_p15_20261216_inventory"), CODE.indexOf("\nBEGIN;"));

  it("no probe requires collections_insert_controllers (20261011 is 'unknown' in the paste guide); the inventory reports it as 1 / 0", () => {
    expect(probes.length).toBe(8);
    for (const r of probes) expect(r, r.slice(0, 80)).not.toContain("collections_insert_controllers");
    const policyProbe = probes.find((r) => r.includes("no policy on libraries or collections was added or dropped"))!;
    expect(policyProbe).toContain("policyname = 'libraries_org_access'");
    expect(policyProbe).toContain("= (SELECT n FROM ao_p15_20261216_inventory WHERE check_name = 'before: policies on libraries and collections')");
    const row = inv.split(/UNION ALL/).find((r) => r.includes("collections_insert_controllers"))!;
    expect(row).toMatch(/^\s*SELECT 'before: collections_insert_controllers present \(/);
    expect(row).toContain("COUNT(*)");
    expect(row).toContain("policyname = 'collections_insert_controllers' AND permissive = 'RESTRICTIVE'");
    // the header no longer states the policy as live
    expect(SQL).not.toMatch(/collections_insert_controllers \(20261011\) already admits/);
    expect(SQL).toContain("IF 20261011's RESTRICTIVE\n--       collections_insert_controllers is live");
  });

  it("SUPERSEDES 20261210: the header says so and forbids a later 20261210 paste; the inventory says whether 20261210 came first", () => {
    expect(SQL).toContain("-- ORDER: this file SUPERSEDES 20261210.");
    expect(SQL).toContain("-- ⚠ NEVER paste 20261210 once this file is live.");
    const row = inv.split(/UNION ALL/).find((r) => r.includes("before: trg_node_appearance_columns attached"))!;
    expect(row).toContain("COUNT(*)");
    expect(row).toContain("tgname = 'trg_node_appearance_columns' AND NOT tgisinternal");
    expect(row).toContain("never paste 20261210 afterwards");
    // why it must be written down: 20261210's own trigger probe expects BEFORE UPDATE
    // only and never checks the INSERT bit as present, so a late 20261210 paste
    // still reads ok = true while it takes the INSERT door and the colour rule out
    const p11 = read(P11);
    expect(p11).toContain("AND (tg.tgtype & (4 | 8 | 32)) = 0),  -- not INSERT / DELETE / TRUNCATE");
    expect(p11).not.toContain("NEW.color");
  });

  it("supersession holds: 20261210 does nothing this file does not also do (one function and its REVOKE, one trigger name dropped and re-created on the same two tables; no policy, ALTER or GRANT)", () => {
    const p11 = read(P11).split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const ddl = (code: string) => [...code.matchAll(/^(CREATE OR REPLACE FUNCTION \w+|REVOKE ALL ON FUNCTION [^;]+|DROP TRIGGER IF EXISTS \w+ ON \w+|CREATE TRIGGER \w+)/gm)].map((m) => m[1]);
    expect(ddl(CODE)).toHaveLength(6);
    expect(ddl(p11)).toEqual(ddl(CODE));
    expect(p11).not.toMatch(/\b(ALTER|CREATE POLICY|DROP POLICY|GRANT)\b/);
    // every other top-level statement of 20261210 is its own TEMP inventory (counts only) or the final SELECT
    const others = [...p11.matchAll(/^(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|GRANT|REVOKE|COMMENT|TRUNCATE)\b[^\n]*/gm)]
      .map((m) => m[0])
      .filter((l) => !/^(CREATE OR REPLACE FUNCTION|REVOKE ALL ON FUNCTION|DROP TRIGGER IF EXISTS|CREATE TRIGGER) /.test(l));
    expect(others).toEqual([
      "CREATE TEMP TABLE IF NOT EXISTS ao_p11_20261210_inventory (check_name text, n bigint);",
      "TRUNCATE ao_p11_20261210_inventory;",
      "INSERT INTO ao_p11_20261210_inventory",
    ]);
  });
});

// ── 20261216: the re-created function, line-diffed against its newest earlier body ──
describe("20261216 — enforce_node_appearance_columns re-created from its NEWEST definition (20261210), lineDiff-pinned", () => {
  const before = definitions("enforce_node_appearance_columns", FILES.filter((f) => f < FILE));
  const fn = definitions("enforce_node_appearance_columns", [FILE])[0][1];

  it("the newest earlier definition is 20261210's (scanned at test time)", () => {
    expect(before.length).toBeGreaterThan(0);
    expect(before.at(-1)![0]).toBe(P11);
  });

  it("every line of 20261210's body is kept, and only the ORG-21 colour arm and the ORG-19 INSERT arm are added", () => {
    const { onlyInA, onlyInB } = lineDiff(before.at(-1)![1], fn);
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual([
      "  -- ORG-21: a colour is a hex colour (#rgb / #rrggbb, lib/nodeColor.ts) or",
      "  -- none. Judged when a new row sets one or a write changes it, so a stored",
      "  -- value that fails the format never blocks a write that keeps it.",
      `  IF NEW.color IS NOT NULL AND NEW.color !~ '${NODE_COLOR_SQL_PATTERN}'`,
      "     AND (TG_OP = 'INSERT' OR NEW.color IS DISTINCT FROM OLD.color) THEN",
      "    RAISE EXCEPTION 'A folder''s or library''s colour must be a hex colour such as #2563eb.'",
      "      USING ERRCODE = 'check_violation';",
      "  -- ORG-19: a new row has no OLD. One that sets the cover image, its tint",
      "  -- or a page background is judged by the same gate as a change, on the new",
      "  -- row's workspace; one that sets none of them is decided as before.",
      "  IF TG_OP = 'INSERT' THEN",
      "    IF NEW.cover_image_url IS NOT NULL",
      "       OR NEW.cover_tint IS NOT NULL",
      "       OR NULLIF(NEW.page_config -> 'background', 'null'::jsonb) IS NOT NULL THEN",
      "      IF NOT is_org_controller(NEW.org_id) THEN",
      "        RAISE EXCEPTION 'Only an Admin or a Document Controller can change a folder''s or library''s cover image or background.'",
      "          USING ERRCODE = 'check_violation';",
      "      END IF;",
      "    RETURN NEW;",
    ]);
    // (a set diff: lines 20261210 already carries — "  END IF;", the UPDATE arm's
    // sentence at its own indentation — are not repeated here)
  });

  it("ORDER AND REPEATS: the body is exactly 20261210's, unchanged and in order, with the colour arm and then the INSERT arm spliced in right after the uid pass", () => {
    const UID = "  IF auth.uid() IS NULL THEN RETURN NEW; END IF;\n";
    const colourArm = [
      "  -- ORG-21: a colour is a hex colour (#rgb / #rrggbb, lib/nodeColor.ts) or",
      "  -- none. Judged when a new row sets one or a write changes it, so a stored",
      "  -- value that fails the format never blocks a write that keeps it.",
      `  IF NEW.color IS NOT NULL AND NEW.color !~ '${NODE_COLOR_SQL_PATTERN}'`,
      "     AND (TG_OP = 'INSERT' OR NEW.color IS DISTINCT FROM OLD.color) THEN",
      "    RAISE EXCEPTION 'A folder''s or library''s colour must be a hex colour such as #2563eb.'",
      "      USING ERRCODE = 'check_violation';",
      "  END IF;",
    ];
    const insertArm = [
      "  -- ORG-19: a new row has no OLD. One that sets the cover image, its tint",
      "  -- or a page background is judged by the same gate as a change, on the new",
      "  -- row's workspace; one that sets none of them is decided as before.",
      "  IF TG_OP = 'INSERT' THEN",
      "    IF NEW.cover_image_url IS NOT NULL",
      "       OR NEW.cover_tint IS NOT NULL",
      "       OR NULLIF(NEW.page_config -> 'background', 'null'::jsonb) IS NOT NULL THEN",
      "      IF NOT is_org_controller(NEW.org_id) THEN",
      "        RAISE EXCEPTION 'Only an Admin or a Document Controller can change a folder''s or library''s cover image or background.'",
      "          USING ERRCODE = 'check_violation';",
      "      END IF;",
      "    END IF;",
      "    RETURN NEW;",
      "  END IF;",
    ];
    const p11 = before.at(-1)![1];
    expect(p11.split(UID)).toHaveLength(2);
    // a reordered, duplicated or dropped 20261210 line fails here, which the set diff above cannot see
    // (a replacer function: the colour pattern's "$'" must not be read as a replacement token)
    expect(fn).toBe(p11.replace(UID, () => UID + [...colourArm, ...insertArm].join("\n") + "\n"));
  });

  it("the uid pass is still the first statement; the INSERT arm returns before the UPDATE arm reads OLD", () => {
    const body = fn.slice(fn.indexOf("BEGIN"));
    const statements = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));
    expect(statements[1]).toBe("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
    const insertArm = fn.indexOf("IF TG_OP = 'INSERT' THEN");
    const updateArm = fn.indexOf("IF NEW.cover_image_url IS DISTINCT FROM OLD.cover_image_url");
    expect(insertArm).toBeGreaterThan(0);
    expect(updateArm).toBeGreaterThan(insertArm);
    const arm = fn.slice(insertArm, updateArm);
    expect(arm).toContain("RETURN NEW;\n  END IF;");
    expect(arm).not.toMatch(/\bOLD\./);
    // the INSERT arm judges exactly the three values 20261210 judges on UPDATE, by the same gate and sentence
    expect([...new Set([...arm.matchAll(/\bNEW\.(\w+)/g)].map((m) => m[1]))].sort()).toEqual(["cover_image_url", "cover_tint", "org_id", "page_config"]);
    const sentence = "Only an Admin or a Document Controller can change a folder''s or library''s cover image or background.";
    expect(fn.split(sentence)).toHaveLength(3); // the INSERT arm and the UPDATE arm
  });

  it("the colour arm is a format rule only (no authority gate), judged on INSERT or on a change — never on a write that keeps the stored value", () => {
    const start = fn.indexOf("IF NEW.color IS NOT NULL");
    const arm = fn.slice(start, fn.indexOf("END IF;", start));
    expect(arm).not.toMatch(/is_org_controller/);
    expect(arm).toContain("(TG_OP = 'INSERT' OR NEW.color IS DISTINCT FROM OLD.color)");
    // it never writes NEW (a rail, not a rewrite)
    expect(fn).not.toMatch(/NEW\.\w+\s*:=/);
  });

  it("the gate is still the node editor's: the NEWEST is_org_controller reads exactly NODE_CUSTOMIZE_ROLES", () => {
    const [, live] = definitions("is_org_controller", FILES).at(-1)!;
    const roleList = live.match(/role IN \(([^)]*)\)/)![1].split(",").map((r) => r.trim().replace(/'/g, ""));
    expect(roleList.sort()).toEqual([...NODE_CUSTOMIZE_ROLES].sort());
  });

  it("the trigger is re-attached as BEFORE INSERT OR UPDATE on libraries and on collections, re-runnable", () => {
    for (const t of ["libraries", "collections"]) {
      expect(SQL).toContain(`DROP TRIGGER IF EXISTS trg_node_appearance_columns ON ${t};\nCREATE TRIGGER trg_node_appearance_columns\n  BEFORE INSERT OR UPDATE ON ${t}\n  FOR EACH ROW EXECUTE FUNCTION enforce_node_appearance_columns();`);
    }
    expect(CODE.match(/CREATE TRIGGER/g)).toHaveLength(2);
    expect(CODE.match(/DROP TRIGGER/g)).toHaveLength(2);
    expect(CODE).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY|ALTER FUNCTION|DROP FUNCTION/);
    // the probe checks the INSERT and UPDATE bits
    expect(CODE).toContain("AND (tg.tgtype & 4) = 4      -- INSERT");
    expect(CODE).toContain("AND (tg.tgtype & 16) = 16    -- UPDATE");
  });

  it("TRIPWIRE: the newest enforce_node_appearance_columns in the whole sequence still holds the INSERT door and the colour rule", () => {
    const [file, text] = definitions("enforce_node_appearance_columns", FILES).at(-1)!;
    expect(file >= FILE, file).toBe(true);
    expect(text).toContain(`NEW.color !~ '${NODE_COLOR_SQL_PATTERN}'`);
    expect(text).toContain("IF TG_OP = 'INSERT' THEN");
    expect(text).toContain("IF NOT is_org_controller(NEW.org_id) THEN");
    expect(text).toContain("IF NOT is_org_controller(OLD.org_id) THEN");
  });
});

describe("20261216 — coexists with every trigger on libraries and collections (listed at test time)", () => {
  const all = [...triggersOn("libraries"), ...triggersOn("collections")];

  it("trg_node_appearance_columns is attached only by 20261210 (BEFORE UPDATE) and 20261216 (BEFORE INSERT OR UPDATE); the newest is this file's", () => {
    const attach = all.filter((t) => t.name === "trg_node_appearance_columns" || t.fn === "enforce_node_appearance_columns");
    expect(attach.length).toBeGreaterThanOrEqual(4);
    for (const t of attach) {
      expect(t.name).toBe("trg_node_appearance_columns");
      expect(t.fn).toBe("enforce_node_appearance_columns");
      expect([P11, FILE]).toContain(t.file);
      expect(t.timing).toBe(t.file === FILE ? "BEFORE INSERT OR UPDATE" : "BEFORE UPDATE");
    }
    expect(attach.map((t) => t.file).sort().at(-1)).toBe(FILE);
  });

  it("no other BEFORE trigger's NEWEST body reads or rewrites the appearance columns or the colour (firing order cannot change the verdict); the INSERT rail is among them", () => {
    const fns = new Set(all.filter((t) => t.timing.startsWith("BEFORE") && t.fn !== "enforce_node_appearance_columns").map((t) => t.fn));
    expect(fns.has("enforce_library_insert_sensitive_columns")).toBe(true);
    for (const name of fns) {
      const defs = definitions(name, FILES);
      if (defs.length === 0) continue;
      const [file, body] = defs.at(-1)!;
      expect(body, `${name} (${file})`).not.toMatch(/cover_image_url|cover_tint|page_config|\bNEW\.color\b/);
    }
  });
});

// ── ORG-19 regression: every app INSERT into libraries / collections ────────
describe("ORG-19 regression — no app INSERT into libraries or collections sets an appearance column or a colour", () => {
  function walk(dir: string): string[] {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
      const p = `${dir}/${d.name}`;
      if (d.isDirectory()) return d.name === "__tests__" || d.name === "node_modules" ? [] : walk(p);
      return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
    });
  }
  /** The text between the paren at `open` and its matching close, and the close's index. */
  function argAt(s: string, open: number): { inner: string; close: number } {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) return { inner: s.slice(open + 1, i), close: i };
    }
    return { inner: s.slice(open + 1), close: s.length };
  }
  /** The table a `.from(` argument names, when it can be read statically: a
   *  string literal ('…', "…", or `…` with no ${}), or an identifier the same
   *  file declares as `const NAME = <such a literal>`. undefined otherwise. */
  function tableOf(s: string, arg: string): string | undefined {
    const lit = arg.match(/^(["'`])([^"'`\\]*)\1$/);
    if (lit && !lit[2].includes("${")) return lit[2];
    if (!/^[A-Za-z_$][\w$]*$/.test(arg)) return undefined;
    const decl = s.match(new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${arg.replace(/\$/g, "\\$")}\\s*(?::[^=\\n]+)?=\\s*(["'\`])([^"'\`$\\\\]*)\\1\\s*;`));
    return decl ? decl[2] : undefined;
  }
  // Every `.from(<argument>)` directly followed by `.insert(` / `.upsert(`, in
  // every .ts / .tsx under app/, lib/, components/ and hooks/ (tests excluded).
  const sites: Array<{ file: string; arg: string }> = [];
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const f of ["app", "lib", "components", "hooks"].flatMap(walk)) {
    const s = src(f);
    for (const m of s.matchAll(/\.from\(/g)) {
      const from = argAt(s, m.index! + m[0].length - 1);
      const verb = s.slice(from.close + 1).match(/^\s*\.(insert|upsert)\(/);
      if (!verb) continue;
      const arg = from.inner.trim();
      const table = tableOf(s, arg);
      if (table === undefined) { unresolved.push(`${f}: .from(${arg}).${verb[1]}(`); continue; }
      if (!/^["'`]/.test(arg)) resolved.push(`${f}: ${arg} = "${table}"`);
      if (table === "libraries" || table === "collections") {
        sites.push({ file: f, arg: argAt(s, from.close + verb[0].length).inner });
      }
    }
  }

  it("the census sees exactly the known creation paths (a literal table, or a same-file const resolved to one)", () => {
    expect(sites.map((x) => x.file).sort()).toEqual([
      "app/(protected)/admin/libraries/page.tsx", // the admin wizard (dbConfig + org/stamp columns)
      "app/api/intake/upload/route.ts",           // the intake folder (service role: no uid, passes)
      "lib/libraryCollections.ts",                // createFolder (.from(TABLE), TABLE = "collections")
      "lib/libraryCollections.ts",                // createLibrary (Save-As / inline)
    ]);
    // createFolder is found through the identifier, not a literal
    expect(resolved).toContain('lib/libraryCollections.ts: TABLE = "collections"');
    // a table whose name merely contains the word is not one of these two
    expect(src("lib/collections.ts")).toContain('.from("curated_collections")');
    expect(src("lib/knowledge.ts")).toContain('.from("knowledge_libraries")');
  });

  it("NAMED EXCEPTIONS: the only insert / upsert sites whose table cannot be read statically, each shown not to be an app creation by a person", () => {
    expect(unresolved.sort()).toEqual([
      // insertRows(table, rows): `table` is typed "cost_accounts" | "milestones" | "project_parties"
      "components/projects/ProjectWizard.tsx: .from(table).insert(",
      // the backup restore's applyRestoreChunk: its client is the apply-table route's
      // service-role client (pinned below), so its rows carry no uid and the rail passes them
      "lib/dataRestore.ts: .from(table).upsert(",
    ]);
    expect(src("lib/projectWizardWrites.ts")).toContain('insertRows(table: "cost_accounts" | "milestones" | "project_parties", rows: Record<string, unknown>[])');
    expect(src("components/projects/ProjectWizard.tsx")).toContain("const writeDeps = (projectId: string): WizardWriteDeps => ({");
    expect(src("lib/dataRestore.ts")).toContain("const up = await sb.from(table).upsert(rows, { onConflict: conflictTargetFor(table), ignoreDuplicates: true, count: \"exact\" });");
  });

  it("none of them names cover_image_url, cover_tint, page_config or color — the INSERT door changes no app flow", () => {
    for (const { file, arg } of sites) expect(arg, file).not.toMatch(/\b(cover_image_url|cover_tint|page_config|color)\b/);
    // the wizard's insert spreads dbConfig: pin that dbConfig names none of them either
    const page = src("app/(protected)/admin/libraries/page.tsx");
    const dbConfig = page.slice(page.indexOf("const dbConfig = {"), page.indexOf("};", page.indexOf("const dbConfig = {")));
    expect(dbConfig).toContain("acl_index: buildAclIndex");
    expect(dbConfig).not.toMatch(/\b(cover_image_url|cover_tint|page_config|color)\b/);
    // the intake folder is the service role's write (no uid → the rail passes it)
    expect(src("app/api/intake/upload/route.ts")).toMatch(/await supabaseAdmin\n\s+\.from\("collections"\)\n\s+\.insert\(\{ org_id: input\.orgId, library_id: input\.libraryId, name: `Intake — \$\{input\.projectName\}` \}\)/);
  });

  it("the restore writes rows through the service role (the apply-table route's admin client), so its INSERTs carry no uid and pass", () => {
    const route = src("app/api/admin/restore/apply-table/route.ts");
    expect(route).toContain("const sb = actor.admin;");
    expect(route).toMatch(/applyRestoreChunk\(sb,/);
  });
});

// ── ORG-21: the colour rule and the render sites ────────────────────────────
describe("ORG-21 — one colour rule: #rgb / #rrggbb, in the app and in the database", () => {
  it("the JS and SQL patterns are the same rule, and the rail, the inventory and the probe use the SQL one", () => {
    // This pins TEXTUAL agreement only: NODE_COLOR_SQL_PATTERN is compiled here
    // as a JavaScript RegExp, so PostgreSQL ARE semantics (how '$' treats a
    // trailing newline, flags, POSIX classes) are not exercised by vitest. The
    // authority for the database behaviour is the PostgreSQL 16 run in the
    // ORG-21 record (#abc / #ABC accepted, 'red', 'blue', the payload and
    // '#2563eb' plus a trailing newline refused, a write that keeps a stored
    // value passing). Re-run it if this pattern changes.
    expect(NODE_COLOR_PATTERN.source).toBe("^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$");
    expect(NODE_COLOR_SQL_PATTERN).toBe("^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$");
    const sqlAsJs = new RegExp(NODE_COLOR_SQL_PATTERN);
    const battery = [...SWATCHES, "#abc", "#ABCDEF", "#12345", "#1234567", "#ggg", "red", "", " #2563eb", "#2563eb ", "#2563eb\n", PAYLOAD, "url(x)", "rgb(1,2,3)", "var(--x)", "#2563eb;background:url(x)"];
    for (const v of battery) expect(sqlAsJs.test(v), JSON.stringify(v)).toBe(NODE_COLOR_PATTERN.test(v));
    const uses = SQL.split(`'${NODE_COLOR_SQL_PATTERN}'`).length - 1;
    expect(uses).toBeGreaterThanOrEqual(5); // inventory ×2, the rail, the probe's prosrc, the swatch probe ×2
  });

  it("every colour the node editor offers passes, and the probe lists exactly the editor's swatches", () => {
    expect(SWATCHES).toHaveLength(12);
    for (const c of SWATCHES) expect(safeNodeColor(c), c).toBe(c);
    const probe = SQL.match(/unnest\(ARRAY\[([^\]]*)\]\)/)![1];
    expect([...probe.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(SWATCHES);
    // "Theme" is no colour: the editor stores undefined → null
    expect(src("components/documents/CustomizeNodeModal.tsx")).toContain("onClick={() => set({ color: undefined })} title=\"Match theme\"");
  });

  it("safeNodeColor: a hex colour is kept; anything else is undefined (draw the default)", () => {
    expect(safeNodeColor("#abc")).toBe("#abc");
    expect(safeNodeColor("#A1B2C3")).toBe("#A1B2C3");
    for (const v of [PAYLOAD, "red", "", "url(https://example.net/p.png)", "#2563eb\n", null, undefined, 42, {}]) {
      expect(safeNodeColor(v), JSON.stringify(v)).toBeUndefined();
    }
  });
});

describe("ORG-21 — NodeCover as rendered", () => {
  const html = (color: string | null | undefined) => renderToStaticMarkup(React.createElement(NodeCover, { appearance: { color, icon: "folder" } }));

  it("REPRODUCED → fixed: the payload renders the theme gradient and no url(", () => {
    const out = html(PAYLOAD);
    expect(out).not.toContain("url(");
    expect(out).not.toContain("example.net");
    expect(out).toContain('style="background:var(--brand-gradient)"');
  });

  it("REGRESSION: every editor swatch renders exactly the gradient it rendered before", () => {
    for (const c of SWATCHES) {
      expect(html(c)).toContain(`style="background:linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 55%, #000))"`);
    }
    expect(html("#abc")).toContain("linear-gradient(135deg, #abc, color-mix(in srgb, #abc 55%, #000))");
  });

  it("no colour (Theme), an empty string and a legacy named value all render the theme gradient", () => {
    for (const c of [null, undefined, "", "red"]) expect(html(c)).toContain('style="background:var(--brand-gradient)"');
  });
});

describe("ORG-21 — the other node-colour sites (PathBar, FolderRail, LibraryHomeBoard) draw only a hex colour", () => {
  const bar = (color: string | null) => renderToStaticMarkup(React.createElement(PathBar, {
    library: { name: "Lib", icon: null, color },
    segments: [{ id: "f1", name: "Unit 100", icon: null, color }],
    onNavigate: () => {},
  }));

  it("PathBar: the payload draws the theme tile (no url(); the library chip falls back to the plain glyph), a swatch draws as before", () => {
    const bad = bar(PAYLOAD);
    expect(bad).not.toContain("url(");
    expect(bad).toContain("background:var(--brand-gradient)");
    const good = bar("#2563eb");
    expect(good).toContain("background:#2563eb");
    expect(good.split("background:#2563eb").length - 1).toBe(2); // the library chip and the folder segment
  });

  it("FolderRail and LibraryHomeBoard pass the stored colour through safeNodeColor before it reaches a style", () => {
    const rail = src("components/documents/FolderRail.tsx");
    expect(rail).toContain("const color = safeNodeColor(folder.color);");
    expect(rail).toContain('style={{ background: color ?? "var(--brand-gradient)" }}');
    expect(rail).toContain("{safeNodeColor(folder.color) || folder.icon ? <FolderGlyph");
    expect(src("components/documents/LibraryHomeBoard.tsx")).toContain('style={{ background: safeNodeColor(f.color) ?? "var(--brand-gradient)" }}');
  });

  function walkTsx(dir: string, ext: RegExp): string[] {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
      const p = `${dir}/${d.name}`;
      if (d.isDirectory()) return d.name === "__tests__" || d.name === "node_modules" ? [] : walkTsx(p, ext);
      return ext.test(d.name) ? [p] : [];
    });
  }

  it("CENSUS (narrow, all of components/ and app/): no inline style={{ … }} draws a folder / f / lib / library / seg / current / node .color without the rule", () => {
    const raw: string[] = [];
    for (const f of ["components", "app"].flatMap((d) => walkTsx(d, /\.tsx$/))) {
      const s = src(f);
      for (const m of s.matchAll(/style=\{\{[^}]*\b(?:folder|f|lib|library|seg|current|node)\??\.color\b[^}]*\}\}/g)) {
        if (!/safeNodeColor\(/.test(m[0])) raw.push(`${f}: ${m[0]}`);
      }
    }
    expect(raw).toEqual([]);
    // NodeCover's own gradient reads the validated colour only
    const cover = src("components/documents/NodeCover.tsx");
    expect(cover).toContain("const color = safeNodeColor(appearance.color);");
    expect(cover).not.toMatch(/appearance\.color \|\|/);
  });

  // The widened census (the integrator's ruling on the final review's minor 1).
  // In components/documents/** and app/(protected)/documents/** it parses every
  // .ts / .tsx file (the TypeScript parser) and takes as a STYLE VALUE:
  //   · the value of an object property named background / backgroundColor /
  //     backgroundImage (a React style object), shorthand included;
  //   · an assignment to <x>.background / .backgroundColor / .backgroundImage,
  //     and <x>.setProperty("background…", value);
  //   · every ${…} of a template literal whose text holds linear-gradient( ,
  //     color-mix( or a CSS background: / background-color: / background-image:;
  //   · every non-literal operand of a `+` chain one of whose string literals
  //     holds the same.
  // A value is FLAGGED when it reads a colour: a `.color` / `["color"]` member,
  // or a name with "color" in it that is a parameter, a destructured binding, an
  // import or undeclared. A name declared with an initializer (const / let
  // x = <init>) is followed to its init (lexical scope, recursively), so
  // `const bg = \`…${color}…\`` and `const color = appearance.color` are seen
  // through. A value is CLEAN when its
  // colour comes only through safeNodeColor(…) (the call is not looked into), a
  // const assigned from safeNodeColor(…), or literals. A ternary's condition is
  // not a drawn value and is not judged.
  const COLOUR_NAME = /color/i;
  const BG_KEY = /^background(?:Color|Image)?$/;
  const CSS_TRIGGER = /linear-gradient\(|color-mix\(|background(?:-color|-image)?\s*:/;

  function nodeColourStyleHits(fileName: string, text: string): string[] {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const hits = new Map<number, string>();
    const bindsIn = (name: ts.BindingName, text: string): ts.Identifier | undefined => {
      if (ts.isIdentifier(name)) return name.text === text ? name : undefined;
      for (const el of name.elements) {
        if (ts.isOmittedExpression(el)) continue;
        const hit = bindsIn(el.name, text);
        if (hit) return hit;
      }
      return undefined;
    };
    /** The innermost declaration of an identifier, by lexical scope. */
    const resolve = (id: ts.Identifier): ts.Identifier | ts.Node | undefined => {
      for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
        if (ts.isFunctionLike(n)) for (const p of n.parameters) { const b = bindsIn(p.name, id.text); if (b) return b; }
        if (ts.isCatchClause(n) && n.variableDeclaration) { const b = bindsIn(n.variableDeclaration.name, id.text); if (b) return b; }
        if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
          for (const d of n.initializer.declarations) { const b = bindsIn(d.name, id.text); if (b) return b; }
        }
        const stmts = ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) ? n.statements : undefined;
        for (const s of stmts ?? []) {
          if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) { const b = bindsIn(d.name, id.text); if (b) return b; }
          if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === id.text) return s;
          if (ts.isImportDeclaration(s) && s.importClause && s.importClause.getText(sf).match(new RegExp(`\\b${id.text}\\b`))) return s;
        }
      }
      return undefined;
    };
    const reads = (node: ts.Node, seen: Set<ts.Node>): boolean => {
      if (ts.isTypeNode(node)) return false;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "safeNodeColor") return false;
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return false;
      if (ts.isPropertyAccessExpression(node)) return node.name.text === "color" || reads(node.expression, seen);
      if (ts.isElementAccessExpression(node)) {
        if (ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "color") return true;
        return reads(node.expression, seen) || reads(node.argumentExpression, seen);
      }
      if (ts.isConditionalExpression(node)) return reads(node.whenTrue, seen) || reads(node.whenFalse, seen);
      if (ts.isIdentifier(node)) {
        const b = resolve(node);
        if (b && ts.isIdentifier(b) && ts.isVariableDeclaration(b.parent) && b.parent.name === b && b.parent.initializer) {
          if (seen.has(b)) return false;
          seen.add(b);
          return reads(b.parent.initializer, seen);
        }
        return COLOUR_NAME.test(node.text);
      }
      return ts.forEachChild(node, (c) => (reads(c, seen) ? true : undefined)) ?? false;
    };
    const judge = (value: ts.Node) => {
      if (!reads(value, new Set())) return;
      const at = value.getStart(sf);
      hits.set(at, `${fileName}:${sf.getLineAndCharacterOfPosition(at).line + 1}: ${value.getText(sf).replace(/\s+/g, " ")}`);
    };
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && BG_KEY.test(n.name.text)) judge(n.initializer);
      if (ts.isShorthandPropertyAssignment(n) && BG_KEY.test(n.name.text)) judge(n.name);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && BG_KEY.test(n.left.name.text)) judge(n.right);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "setProperty"
          && n.arguments.length > 1 && ts.isStringLiteralLike(n.arguments[0]) && /^background/.test(n.arguments[0].text)) judge(n.arguments[1]);
      if (ts.isTemplateExpression(n) && CSS_TRIGGER.test([n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(""))) {
        for (const span of n.templateSpans) judge(span.expression);
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken
          && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
        const operands: ts.Expression[] = [];
        const flat = (e: ts.Expression): void => {
          if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) { flat(e.left); flat(e.right); } else operands.push(e);
        };
        flat(n);
        if (operands.some((o) => ts.isStringLiteralLike(o) && CSS_TRIGGER.test(o.text))) for (const o of operands) if (!ts.isStringLiteralLike(o)) judge(o);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return [...hits.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
  }

  it("CENSUS (widened, components/documents/** and app/(protected)/documents/**): no style value reads a colour except through safeNodeColor; the one named exception is the curated book", () => {
    const files = ["components/documents", "app/(protected)/documents"].flatMap((d) => walkTsx(d, /\.tsx?$/));
    expect(files.length).toBeGreaterThan(50);
    const hits = files.flatMap((f) => nodeColourStyleHits(f, src(f)));
    // NAMED EXCEPTION: CollectionsStrip draws curated_collections.color (a curated
    // book, not a library or folder) only through bookCover, whose own
    // /^#[0-9a-fA-F]{6}$/ guard is evaluated from source in the CollectionsStrip
    // test below. Listed exactly, so a new hit in that file fails too.
    expect(hits).toEqual([
      "components/documents/CollectionsStrip.tsx:51: color",
      "components/documents/CollectionsStrip.tsx:51: color",
      "components/documents/CollectionsStrip.tsx:198: bookCover(collection.color)",
    ]);
  }, 30_000); // parses ~1.6 MB of TSX

  // Copied verbatim from the base (700f1fc) bodies: each fixture is the drawing
  // site, the lines its value is declared on and the function head it sits in,
  // in their base order (lines in between left out). The only lines that are
  // not the base's end in "// fixture wrapper" (LibraryHomeBoard's site sits
  // deep in PartGrid's JSX). CI checks out one commit, so `git show 700f1fc:…`
  // is not available at test time.
  const BASE_700F1FC: Record<string, string> = {
    "components/documents/NodeCover.tsx": [
      "export default function NodeCover({",
      "  appearance,",
      "  className = \"\",",
      "  rounded = \"rounded-xl\",",
      "  iconSize = \"w-6 h-6\",",
      "  showIcon = true,",
      "}: {",
      "  appearance: NodeAppearanceLike;",
      "  className?: string;",
      "  rounded?: string;",
      "  iconSize?: string;",
      "  showIcon?: boolean;",
      "}) {",
      "  const color = appearance.color || undefined;",
      "  // No image → color/brand gradient panel with the icon.",
      "  const bg = color",
      "    ? `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 55%, #000))`",
      "    : \"var(--brand-gradient)\";",
      "  return (",
      "    <div className={`relative grid place-items-center ${rounded} ${className}`} style={{ background: bg }}>",
      "      {showIcon && <NodeIcon name={appearance.icon} className={`${iconSize} text-white drop-shadow`} />}",
      "    </div>",
      "  );",
      "}",
    ].join("\n"),
    "components/documents/PathBar.tsx": [
      "/** The little colored tile that stands in for the node. */",
      "function Tile({ icon, color, className = \"w-4 h-4\" }: {",
      "  icon?: string | null; color?: string | null; className?: string;",
      "}) {",
      "  return (",
      "    <span",
      "      className={`${className} rounded grid place-items-center text-white shrink-0`}",
      "      style={{ background: color || \"var(--brand-gradient)\" }}",
      "    >",
      "      <NodeIcon name={icon} className=\"w-2.5 h-2.5\" />",
      "    </span>",
      "  );",
      "}",
    ].join("\n"),
    "components/documents/FolderRail.tsx": [
      "function FolderGlyph({ folder, active }: { folder: LibraryCollection; active: boolean }) {",
      "  if (folder.color || folder.icon) {",
      "    return (",
      "      <span",
      "        className=\"w-4 h-4 rounded grid place-items-center text-white shrink-0\"",
      "        style={{ background: folder.color || \"var(--brand-gradient)\" }}",
      "      >",
      "        <NodeIcon name={folder.icon} className=\"w-2.5 h-2.5\" />",
      "      </span>",
      "    );",
      "  }",
      "  return <Folder className={`w-3.5 h-3.5 shrink-0 ${active ? \"text-[var(--color-accent)]\" : \"text-amber-500\"}`} />;",
      "}",
    ].join("\n"),
    "components/documents/LibraryHomeBoard.tsx": [
      "function PartGrid() { return ( // fixture wrapper",
      "                <div className=\"flex flex-wrap gap-2\">",
      "                  {pickFolders(rootFolders, p.settings?.folderIds).map((f) => (",
      "                    <button key={f.id} onClick={() => onOpenFolder(f.id!)}",
      "                      className=\"group inline-flex items-center gap-2 px-3 py-1.5 rounded-2xl border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-2)] text-sm font-semibold text-[var(--color-text)] transition-colors hover-lift\">",
      "                      <span className=\"w-5 h-5 rounded-md grid place-items-center text-white shrink-0 shadow-sm\" style={{ background: f.color || \"var(--brand-gradient)\" }}>",
      "                        <NodeIcon name={f.icon} className=\"w-3 h-3\" />",
      "                      </span>",
      "                    </button>",
      "                  ))}",
      "                </div>",
      "); } // fixture wrapper",
    ].join("\n"),
  };

  it("SELF-TEST: the widened census finds every base (700f1fc) site this package fixed — NodeCover, PathBar, FolderRail and LibraryHomeBoard", () => {
    const hits = Object.entries(BASE_700F1FC).flatMap(([f, text]) => nodeColourStyleHits(f, text));
    expect(hits).toEqual([
      "components/documents/NodeCover.tsx:17: color",
      "components/documents/NodeCover.tsx:17: color",
      "components/documents/NodeCover.tsx:20: bg",
      "components/documents/PathBar.tsx:8: color || \"var(--brand-gradient)\"",
      "components/documents/FolderRail.tsx:6: folder.color || \"var(--brand-gradient)\"",
      "components/documents/LibraryHomeBoard.tsx:6: f.color || \"var(--brand-gradient)\"",
    ]);
    expect(new Set(hits.map((h) => h.split(":")[0])).size).toBe(4);
    // and the same four sites as they are now are clean
    for (const f of Object.keys(BASE_700F1FC)) expect(nodeColourStyleHits(f, src(f)), f).toEqual([]);
  });

  it("SELF-TEST: the shapes it flags and the shapes it accepts", () => {
    const run = (body: string) => nodeColourStyleHits("x.tsx", body).map((h) => h.replace(/^x\.tsx:\d+: /, ""));
    // flagged
    expect(run("const a = <i style={{ backgroundColor: node.color }} />;")).toEqual(["node.color"]);
    expect(run("const a = <i style={{ background: n[\"color\"] }} />;")).toEqual(["n[\"color\"]"]);
    expect(run("function T({ tileColor }: { tileColor: string }) { return <i style={{ background: tileColor }} />; }")).toEqual(["tileColor"]);
    expect(run("function T({ folder }: any) { const { color } = folder; return <i style={{ background: color }} />; }")).toEqual(["color"]);
    expect(run("function T({ folder }: any) { const g = \"linear-gradient(90deg, \" + folder.color + \", #000)\"; return <i style={{ background: g }} />; }")).toEqual(["folder.color", "g"]);
    expect(run("function T({ folder }: any) { const c = folder.color; const g = `color-mix(in srgb, ${c} 50%, #000)`; return <i style={{ backgroundImage: g }} />; }")).toEqual(["c", "g"]);
    expect(run("function T(el: HTMLElement, lib: any) { el.style.background = lib.color; el.style.setProperty(\"background-color\", lib.color); }")).toEqual(["lib.color", "lib.color"]);
    expect(run("function T(el: HTMLElement, lib: any) { el.style.cssText = `padding:2px;background:${lib.color}`; }")).toEqual(["lib.color"]);
    // accepted
    expect(run("const a = <i style={{ background: safeNodeColor(f.color) ?? \"var(--brand-gradient)\" }} />;")).toEqual([]);
    expect(run("function T({ folder }: any) { const color = safeNodeColor(folder.color); return <i style={{ background: color ?? \"x\" }} />; }")).toEqual([]);
    expect(run("function T({ folder }: any) { const color = safeNodeColor(folder.color); const bg = color ? `linear-gradient(135deg, ${color}, #000)` : \"x\"; return <i style={{ background: bg }} />; }")).toEqual([]);
    expect(run("const a = <i style={{ background: \"var(--color-accent)\", backgroundColor: REASON_META[r].hex }} />;")).toEqual([]);
    expect(run("const a = <i style={{ background: f.color ? \"var(--a)\" : \"var(--b)\" }} />;")).toEqual([]);
    // lexical scope: a safe `color` in one function does not clean another function's raw `color`
    expect(run([
      "function A({ folder }: any) { const color = safeNodeColor(folder.color); return <i style={{ background: color }} />; }",
      "function B({ color }: any) { return <i style={{ background: color }} />; }",
    ].join("\n"))).toEqual(["color"]);
  });
});

describe("ORG-21 — CollectionsStrip (curated books: curated_collections.color, not a library or folder) already draws only #rrggbb", () => {
  it("DEC-29: its guard held before this package — the payload draws the purple default book, a #rrggbb draws its gradient", () => {
    const strip = src("components/documents/CollectionsStrip.tsx");
    const fnSrc = strip.match(/function bookCover\(color\?: string \| null\): string \{[\s\S]*?\n\}/)![0];
    expect(fnSrc).toContain("if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {");
    const body = fnSrc.replace("function bookCover(color?: string | null): string {", "").replace(/\}$/, "");
    const bookCover = new Function("color", body) as (c?: string | null) => string;
    expect(bookCover(PAYLOAD)).toBe("linear-gradient(135deg, #7c3aed, #4c1d95)");
    expect(bookCover("red")).toBe("linear-gradient(135deg, #7c3aed, #4c1d95)");
    expect(bookCover(null)).toBe("linear-gradient(135deg, #7c3aed, #4c1d95)");
    expect(bookCover("#2563eb")).toBe("linear-gradient(135deg, #2563eb, color-mix(in srgb, #2563eb 55%, #000))");
    // the only style that draws a curated colour goes through it
    expect(strip).toContain("style={{ background: bookCover(collection.color) }}");
    expect(strip.match(/collection\.color/g)).toHaveLength(1);
  });
});
