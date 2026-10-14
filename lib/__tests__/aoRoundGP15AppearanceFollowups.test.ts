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
  /** The argument text of `.insert(` / `.upsert(` from its opening paren to the matching close. */
  function argAt(s: string, open: number): string {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i);
    }
    return s.slice(open + 1);
  }
  const sites: Array<{ file: string; arg: string }> = [];
  for (const f of ["app", "lib", "components", "hooks"].flatMap(walk)) {
    const s = src(f);
    const tableConst = /const TABLE = "collections";/.test(s);
    const re = tableConst
      ? /\.from\(\s*(?:"(?:libraries|collections)"|TABLE)\s*\)\s*\.(?:insert|upsert)\(/g
      : /\.from\(\s*"(?:libraries|collections)"\s*\)\s*\.(?:insert|upsert)\(/g;
    for (const m of s.matchAll(re)) sites.push({ file: f, arg: argAt(s, m.index! + m[0].length - 1) });
  }

  it("the census sees exactly the known creation paths", () => {
    expect(sites.map((x) => x.file).sort()).toEqual([
      "app/(protected)/admin/libraries/page.tsx", // the admin wizard (dbConfig + org/stamp columns)
      "app/api/intake/upload/route.ts",           // the intake folder (service role: no uid, passes)
      "lib/libraryCollections.ts",                // createFolder
      "lib/libraryCollections.ts",                // createLibrary (Save-As / inline)
    ]);
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

  it("CENSUS: no file under components/ or app/ draws a library's or folder's .color into a style without the rule", () => {
    function walk(dir: string): string[] {
      return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
        const p = `${dir}/${d.name}`;
        if (d.isDirectory()) return d.name === "__tests__" || d.name === "node_modules" ? [] : walk(p);
        return /\.tsx$/.test(d.name) ? [p] : [];
      });
    }
    const raw: string[] = [];
    for (const f of ["components", "app"].flatMap(walk)) {
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
