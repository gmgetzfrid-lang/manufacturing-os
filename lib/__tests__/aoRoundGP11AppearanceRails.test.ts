// admin-and-org Round G, P11 APPEARANCE RAILS.
//
//   ORG-17  20261210: a library's or folder's cover image, cover tint and
//           page background change only for the node editor's authority
//           (Admin / DocCtrl — lib/storageKey.ts NODE_CUSTOMIZE_ROLES, read by
//           is_org_controller), a writer with no uid passes, every other
//           column is decided exactly as before. Behaviour was exercised on a
//           throwaway PostgreSQL 16 with the real trigger bodies (the cases
//           are in the record); this file pins the shape, and pins it against
//           the NEWEST definitions found by scanning supabase/migrations at
//           test time, so a later re-creation is diffed against, never
//           skipped.
//   ORG-18  lib/dataRestore.ts clearSkippedNodeImagePointers and the restore
//           page: a cover / background the restore skipped (legacy SVG, HEIC,
//           TIFF) leaves no node pointing at it when the storage check
//           reported it missing (`missing: true`, which the resolve route
//           gives for a HEAD failure of ANY kind — not a proof of absence),
//           and every such node is named, with no list cut short silently.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NODE_CUSTOMIZE_ROLES } from "@/lib/storageKey";
import {
  clearSkippedNodeImagePointers, pageConfigWithoutBackground, nodeImageFileLabel, nodeImagePointerLabel, overflowLines,
  nodeImageClearVerdict, storageAnsweredInRun, restoreEnvelopeNodeIds, nodeIdsPresentBeforeRestore, addRestoredNodeIds,
  RESTORE_ADDITIVE_NOTE, RESTORE_FILES_POINTER_NOTE, NODE_IMAGE_KEPT_REASON_TEXT,
  type NodeImagePointerNode, type NodeImageClearScope,
} from "@/lib/dataRestore";

const ROOT = process.cwd();
const DIR = join(ROOT, "supabase", "migrations");
const FILES = readdirSync(DIR).filter((f) => /^\d{8}_.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const FILE = "20261210_ao_roundG_node_appearance_rail.sql";
const SQL = read(FILE);
const CODE = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

/** Every CREATE [OR REPLACE] FUNCTION <name>( … in the given files, in order,
 *  with the body up to its closing dollar quote. */
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

/** Every trigger any migration (or schema.sql) attaches to libraries / collections. */
function triggersOn(table: "libraries" | "collections"): Array<{ file: string; name: string; fn: string; timing: string }> {
  const out: Array<{ file: string; name: string; fn: string; timing: string }> = [];
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+"?(\\w+)"?\\s+(BEFORE|AFTER)\\s+([\\w\\s,]+?)\\s+ON\\s+(?:public\\.)?${table}\\b[\\s\\S]*?EXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+(\\w+)`, "gi");
  for (const f of [...FILES.map((x) => join(DIR, x)), join(ROOT, "supabase", "schema.sql")]) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(re)) out.push({ file: f.split("/").pop()!, name: m[1], timing: `${m[2]} ${m[3].trim()}`.toUpperCase(), fn: m[4] });
  }
  return out;
}

// ── ORG-17: 20261210 ────────────────────────────────────────────────────────
describe("20261210 — DEC-30 one-paste shape", () => {
  it("counts-only TEMP inventory BEFORE the transaction, one BEGIN / COMMIT, one final (check, ok, n) SELECT", () => {
    const begin = CODE.indexOf("\nBEGIN;");
    expect(begin).toBeGreaterThan(0);
    expect(CODE.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(CODE.match(/\nCOMMIT;/g)).toHaveLength(1);
    expect(CODE.indexOf("CREATE TEMP TABLE IF NOT EXISTS ao_p11_20261210_inventory")).toBeLessThan(begin);
    const inv = CODE.slice(CODE.indexOf("INSERT INTO ao_p11_20261210_inventory"), begin);
    expect(inv).toMatch(/COUNT\(\*\)/);
    expect(inv).not.toMatch(/SELECT\s+\*/); // never customer rows
    // every inventory row is an aggregate: each SELECT in the inventory is a COUNT(*)
    for (const sel of inv.split(/UNION ALL/)) expect(sel, sel.slice(0, 80)).toMatch(/COUNT\(\*\)/);
    const tail = CODE.slice(CODE.lastIndexOf("\nCOMMIT;"));
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    const after = tail.replace(/^\nCOMMIT;/, "");
    expect(after.trimStart()).toMatch(/^SELECT /);
    expect(after).not.toMatch(/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|TRUNCATE)\b/m);
    expect(after.trimEnd().endsWith(";")).toBe(true);
    // the inventory rows close the one result set
    expect(after.trimEnd()).toMatch(/SELECT check_name, NULL, n::text FROM ao_p11_20261210_inventory;$/);
  });

  it("DRLS-16: the one SECURITY DEFINER function pins search_path and revokes EXECUTE from PUBLIC, anon and authenticated", () => {
    const defs = [...SQL.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(\)\s*\nRETURNS[^\n]*/g)];
    expect(defs.map((m) => m[1])).toEqual(["enforce_node_appearance_columns"]);
    expect(defs[0][0]).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(SQL).toContain("REVOKE ALL ON FUNCTION enforce_node_appearance_columns() FROM PUBLIC, anon, authenticated;");
  });

  it("probe literals: a prosrc apostrophe inside a body string is written '''' ; no bare cast inside a pg_policies LIKE", () => {
    expect(CODE).toContain("prosrc LIKE '%folder''''s or library''''s cover image or background.%'");
    for (const m of CODE.matchAll(/(qual|with_check)\s+LIKE\s+'([^']|'')*'/g)) expect(m[0]).not.toMatch(/::/);
  });
});

describe("20261210 — the rail (ORG-17)", () => {
  const fn = definitions("enforce_node_appearance_columns", [FILE])[0][1];

  it("a writer with no uid (restore, service jobs) passes first, before anything is judged", () => {
    const body = fn.slice(fn.indexOf("BEGIN"));
    const firstStatement = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"))[1];
    expect(firstStatement).toBe("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
  });

  it("judges exactly the cover image, its tint and the page background — every other column is decided as before", () => {
    const cols = new Set([...fn.matchAll(/\b(?:NEW|OLD)\.(\w+)/g)].map((m) => m[1]));
    // org_id is the gate's argument, never a judged column
    expect([...cols].sort()).toEqual(["cover_image_url", "cover_tint", "org_id", "page_config"]);
    expect(fn).toMatch(/NEW\.cover_image_url IS DISTINCT FROM OLD\.cover_image_url/);
    expect(fn).toMatch(/NEW\.cover_tint IS DISTINCT FROM OLD\.cover_tint/);
    // page_config only through its background key (the header stays as today); a JSON null reads as none
    for (const m of fn.matchAll(/(NEW|OLD)\.page_config([^\n]*)/g)) expect(m[2]).toMatch(/^ -> 'background', 'null'::jsonb\)/);
    expect(fn).toMatch(/NULLIF\(NEW\.page_config -> 'background', 'null'::jsonb\)\s*\n\s*IS DISTINCT FROM NULLIF\(OLD\.page_config -> 'background', 'null'::jsonb\)/);
    expect(fn).not.toMatch(/\bcolor\b|\bicon\b|\bdescription\b|\bname\b|header/);
    // it never writes NEW (a rail, not a rewrite)
    expect(fn).not.toMatch(/NEW\.\w+\s*:=/);
  });

  it("the gate is is_org_controller(OLD.org_id), refusing with check_violation and the upload route's own sentence", () => {
    expect(fn).toContain("IF NOT is_org_controller(OLD.org_id) THEN");
    expect(fn).toContain("USING ERRCODE = 'check_violation';");
    const sentence = "Only an Admin or a Document Controller can change a folder's or library's cover image or background.";
    expect(fn).toContain(`RAISE EXCEPTION '${sentence.replace(/'/g, "''")}'`);
    expect(src("app/api/storage/upload-url/route.ts")).toContain(sentence);
  });

  it("the SQL gate is the node editor's gate: the NEWEST is_org_controller reads exactly NODE_CUSTOMIZE_ROLES, by role or roles, for an active member", () => {
    const [file, live] = definitions("is_org_controller", FILES).at(-1)!;
    expect(file < FILE, file).toBe(true);
    expect(live).toMatch(/status = 'active'/);
    const roleList = live.match(/role IN \(([^)]*)\)/)![1].split(",").map((r) => r.trim().replace(/'/g, ""));
    const rolesList = live.match(/roles && ARRAY\[([^\]]*)\]/)![1].split(",").map((r) => r.trim().replace(/'/g, ""));
    expect(roleList.sort()).toEqual([...NODE_CUSTOMIZE_ROLES].sort());
    expect(rolesList.sort()).toEqual([...NODE_CUSTOMIZE_ROLES].sort());
  });

  it("one BEFORE UPDATE row trigger on libraries and one on collections, both re-runnable", () => {
    for (const t of ["libraries", "collections"]) {
      expect(SQL).toContain(`DROP TRIGGER IF EXISTS trg_node_appearance_columns ON ${t};\nCREATE TRIGGER trg_node_appearance_columns\n  BEFORE UPDATE ON ${t}\n  FOR EACH ROW EXECUTE FUNCTION enforce_node_appearance_columns();`);
    }
    expect(CODE.match(/CREATE TRIGGER/g)).toHaveLength(2);
    expect(CODE.match(/DROP TRIGGER/g)).toHaveLength(2);
  });

  it("re-creates nothing that already lives: no policy, no other function; the names are new to the sequence (no earlier definition to diff against)", () => {
    expect(CODE).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY|ALTER FUNCTION|DROP FUNCTION/);
    for (const f of FILES.filter((x) => x < FILE)) {
      expect(read(f), f).not.toMatch(/enforce_node_appearance_columns|trg_node_appearance_columns/);
    }
  });

  it("TRIPWIRE: the newest enforce_node_appearance_columns in the whole sequence still judges the three values by is_org_controller", () => {
    const [file, text] = definitions("enforce_node_appearance_columns", FILES).at(-1)!;
    expect(file >= FILE, file).toBe(true);
    expect(text).toMatch(/NEW\.cover_image_url IS DISTINCT FROM OLD\.cover_image_url/);
    expect(text).toMatch(/NEW\.cover_tint IS DISTINCT FROM OLD\.cover_tint/);
    expect(text).toMatch(/NULLIF\(NEW\.page_config -> 'background'/);
    expect(text).toContain("IF NOT is_org_controller(OLD.org_id) THEN");
  });
});

describe("20261210 — coexists with every trigger already on libraries and collections (listed at test time)", () => {
  const lib = triggersOn("libraries");
  const col = triggersOn("collections");

  it("the census sees them (not vacuous): the 20261077 guard, the INSERT rail, the review-control audit, P8's delete audit; the folder guard and audit", () => {
    const names = (xs: typeof lib) => new Set(xs.map((x) => x.name));
    for (const n of ["trg_library_sensitive_columns", "trg_library_insert_sensitive_columns", "trg_libraries_review_control_audit", "trg_library_delete_audit", "trg_node_appearance_columns"]) {
      expect(names(lib).has(n), n).toBe(true);
    }
    for (const n of ["collections_guard_access", "trg_collections_review_control_audit", "trg_node_appearance_columns"]) {
      expect(names(col).has(n), n).toBe(true);
    }
  });

  it("only this file attaches trg_node_appearance_columns, and no other trigger uses its function", () => {
    // admin-and-org P15 (20261216, ORG-19 / ORG-21) re-attaches the same
    // trigger as BEFORE INSERT OR UPDATE from the function's re-created body;
    // its own test (aoRoundGP15AppearanceFollowups) line-diffs that body
    // against this file's and pins the attachment.
    const P15 = "20261216_ao_roundG_appearance_insert_and_colour.sql";
    for (const t of [...lib, ...col]) {
      if (t.name === "trg_node_appearance_columns" || t.fn === "enforce_node_appearance_columns") {
        expect([FILE, P15]).toContain(t.file);
        expect(t.name).toBe("trg_node_appearance_columns");
        expect(t.fn).toBe("enforce_node_appearance_columns");
        expect(t.timing).toBe(t.file === P15 ? "BEFORE INSERT OR UPDATE" : "BEFORE UPDATE");
      }
    }
  });

  it("no other BEFORE trigger's NEWEST body reads or rewrites the appearance columns — the rail's verdict does not depend on firing order", () => {
    const fns = new Set([...lib, ...col].filter((t) => t.timing.startsWith("BEFORE") && t.fn !== "enforce_node_appearance_columns").map((t) => t.fn));
    expect(fns.size).toBeGreaterThanOrEqual(4);
    for (const name of fns) {
      const all = definitions(name, FILES);
      if (all.length === 0) continue; // a schema.sql-only function: none today
      const [file, body] = all.at(-1)!;
      expect(body, `${name} (${file})`).not.toMatch(/cover_image_url|cover_tint|page_config/);
    }
  });
});

describe("ORG-17 regression — the only app writers of the appearance columns are the node editor's saves (and the restore's ORG-18 clear)", () => {
  function walk(dir: string): string[] {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
      const p = `${dir}/${d.name}`;
      if (d.isDirectory()) return d.name === "__tests__" || d.name === "node_modules" ? [] : walk(p);
      return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
    });
  }
  it("a write naming cover_image_url / cover_tint / page_config appears only in the three known places", () => {
    const writers: string[] = [];
    for (const f of ["app", "lib", "components", "hooks"].flatMap(walk)) {
      const s = src(f);
      if (/\b(cover_image_url|cover_tint|page_config)\s*:/.test(s) || /patch\.page_config\s*=/.test(s)) writers.push(f);
    }
    expect(writers.sort()).toEqual([
      "app/(protected)/documents/page.tsx", // saveLibraryAppearance — offered under isController (ORG-16 pins the gate)
      "lib/dataRestore.ts",                 // ORG-18: the Admin's restore clears a skipped image's pointer
      "lib/libraryCollections.ts",          // updateCollectionAppearance — offered under isController
    ]);
    // lib/storageOrphans.ts names page_config only in a read probe shape, never a write
    expect(src("lib/storageOrphans.ts")).not.toMatch(/\.update\(/);
  });
  it("the two editor saves are the same writes as before (a controller's save is admitted unchanged)", () => {
    const page = src("app/(protected)/documents/page.tsx");
    expect(page).toMatch(/cover_image_url: v\.coverImageUrl \?\? null,\n\s+cover_tint: v\.coverTint \?\? null,/);
    expect(page).toMatch(/page_config: pageConfig,/);
    const lc = src("lib/libraryCollections.ts");
    expect(lc).toMatch(/cover_image_url: appearance\.coverImageUrl \?\? null,\n\s+cover_tint: appearance\.coverTint \?\? null,/);
    expect(lc).toMatch(/if \(pageConfig !== undefined\) patch\.page_config = pageConfig;/);
    // ORG-16's pin on the editor's gate is the authority this rail mirrors
    expect(src("lib/__tests__/aoRoundGStorageFollowups.test.ts")).toContain("both pages offer the editor only to isController");
  });
});

// ── ORG-18 ─────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
type Db = { libraries: Row[]; collections: Row[] };
type Call = { table: string; op: "select" | "update"; patch?: Row; filters: string[] };

/** A small in-memory PostgREST chain: eq / contains filters, a thenable
 *  select or update(…).select("id"). Errors and refusals are injectable. */
function fakeClient(db: Db, opts: { readError?: (table: string, filters: string[]) => string | null; refuse?: (table: string, id: unknown) => boolean } = {}) {
  const calls: Call[] = [];
  const contains = (v: unknown, probe: unknown): boolean => {
    if (probe && typeof probe === "object") {
      if (!v || typeof v !== "object") return false;
      return Object.entries(probe as Row).every(([k, pv]) => contains((v as Row)[k], pv));
    }
    return v === probe;
  };
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = [];
    const call: Call = { table, op: "select", filters: [] };
    const builder = {
      select() { return builder; },
      update(patch: Row) { call.op = "update"; call.patch = patch; return builder; },
      eq(col: string, val: unknown) { call.filters.push(`${col}=${String(val)}`); preds.push((r) => r[col] === val); return builder; },
      in(col: string, vals: unknown[]) { call.filters.push(`${col} in ${vals.length}`); preds.push((r) => vals.includes(r[col])); return builder; },
      contains(col: string, val: unknown) { call.filters.push(`${col}@>${JSON.stringify(val)}`); preds.push((r) => contains(r[col], val)); return builder; },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => void) {
        calls.push(call);
        const rows = (db as Record<string, Row[]>)[table].filter((r) => preds.every((p) => p(r)));
        if (call.op === "select") {
          const err = opts.readError?.(table, call.filters) ?? null;
          return resolve(err ? { data: null, error: { message: err } } : { data: rows.map((r) => ({ ...r })), error: null });
        }
        const hit = rows.filter((r) => !opts.refuse?.(table, r.id));
        for (const r of hit) Object.assign(r, call.patch);
        return resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
      },
    };
    return builder;
  };
  return { client: { from } as never, calls };
}

const ORG = "00000000-0000-0000-0000-0000000000a1";
const OTHER = "00000000-0000-0000-0000-0000000000b1";
const SVG = `orgs/${ORG}/branding/covers/legacy.svg`;
const HEIC = `orgs/${ORG}/branding/backgrounds/legacy.heic`;
const PNG = `orgs/${ORG}/branding/covers/ok.png`;

function fixture(): Db {
  return {
    libraries: [
      { id: "lib-1", org_id: ORG, name: "P&IDs", color: "#123456", cover_image_url: SVG, cover_tint: "brand",
        page_config: { header: { height: "tall" }, background: { type: "image", imagePath: HEIC, opacity: 0.18 } } },
      { id: "lib-2", org_id: ORG, name: "Vendor", cover_image_url: PNG, page_config: null },
      { id: "lib-x", org_id: OTHER, name: "Other plant", cover_image_url: SVG, page_config: null },
    ],
    collections: [
      { id: "fold-1", org_id: ORG, name: "Unit 100", cover_image_url: null, page_config: { background: { type: "image", imagePath: HEIC } } },
      { id: "fold-2", org_id: ORG, name: "Unit 200", cover_image_url: SVG, page_config: { header: { height: "compact" } } },
    ],
  };
}

/** Every fixture node in this workspace was added by the restore, and storage answered. */
const ADDED_ALL: NodeImageClearScope = {
  restoredLibraryIds: new Set(["lib-1", "lib-2", "lib-x"]),
  restoredFolderIds: new Set(["fold-1", "fold-2"]),
  storageAnswered: true,
};

describe("ORG-18 — a cover / background the restore skipped leaves no node pointing at it, and the node is named", () => {
  it("REPRODUCED → fixed: a library's legacy SVG cover (reported missing) — the pointer is cleared and the library named; nothing else on the row changes", async () => {
    const db = fixture();
    const { client } = fakeClient(db);
    const r = await clearSkippedNodeImagePointers(client, ORG, [{ key: SVG, reportedMissing: true }], ADDED_ALL);
    expect(r.errors).toEqual([]);
    expect(r.kept).toEqual([]);
    expect(r.cleared).toEqual([
      { kind: "library", id: "lib-1", name: "P&IDs", slot: "cover", file: "covers/legacy.svg" },
      { kind: "folder", id: "fold-2", name: "Unit 200", slot: "cover", file: "covers/legacy.svg" },
    ]);
    expect(db.libraries[0]).toMatchObject({ cover_image_url: null, cover_tint: "brand", color: "#123456", name: "P&IDs" });
    // its background (a different key, not skipped here) is untouched
    expect((db.libraries[0].page_config as Row).background).toEqual({ type: "image", imagePath: HEIC, opacity: 0.18 });
    expect(db.collections[1]).toMatchObject({ cover_image_url: null, page_config: { header: { height: "compact" } } });
    // another workspace's library naming the same key is never read or written
    expect(db.libraries[2].cover_image_url).toBe(SVG);
    // a cover that was put back is untouched
    expect(db.libraries[1].cover_image_url).toBe(PNG);
  });

  it("a legacy HEIC page background: background becomes { type: 'none' } (what Customize writes for none), the header and other keys are kept", async () => {
    const db = fixture();
    const { client, calls } = fakeClient(db);
    const r = await clearSkippedNodeImagePointers(client, ORG, [{ key: HEIC, reportedMissing: true }], ADDED_ALL);
    expect(r.cleared.map(nodeImagePointerLabel)).toEqual([
      'library "P&IDs" — background (backgrounds/legacy.heic)',
      'folder "Unit 100" — background (backgrounds/legacy.heic)',
    ]);
    expect(db.libraries[0].page_config).toEqual({ header: { height: "tall" }, background: { type: "none" } });
    expect(db.libraries[0].cover_image_url).toBe(SVG); // the cover is another key
    expect(db.collections[0].page_config).toEqual({ background: { type: "none" } });
    // every write is scoped to the workspace and to the pointer still naming the key (a concurrent re-pick is not undone)
    for (const c of calls.filter((x) => x.op === "update")) {
      expect(c.filters).toContain(`org_id=${ORG}`);
      expect(c.filters.some((f) => f.startsWith("page_config@>") || f.startsWith("cover_image_url="))).toBe(true);
    }
  });

  it("a key the storage check did not report missing is NOT cleared — its nodes are named as still pointing at it", async () => {
    const db = fixture();
    const { client, calls } = fakeClient(db);
    const r = await clearSkippedNodeImagePointers(client, ORG, [{ key: SVG, reportedMissing: false }], ADDED_ALL);
    expect(r.cleared).toEqual([]);
    expect(r.kept.map((n) => n.id)).toEqual(["lib-1", "fold-2"]);
    expect(r.kept.every((n) => n.keptBecause === "not-reported-missing")).toBe(true);
    expect(calls.filter((c) => c.op === "update")).toEqual([]);
    expect(db.libraries[0].cover_image_url).toBe(SVG);
  });

  it("the same key seen twice is one key; reported missing on either pass counts as reported missing", async () => {
    const db = fixture();
    const { client, calls } = fakeClient(db);
    const r = await clearSkippedNodeImagePointers(client, ORG, [{ key: SVG, reportedMissing: false }, { key: SVG, reportedMissing: true }], ADDED_ALL);
    expect(r.cleared).toHaveLength(2);
    expect(calls.filter((c) => c.op === "select")).toHaveLength(4); // cover + background read, per table, once
  });

  it("a skipped file no node points at: nothing to clear, nothing written; no org or no keys: no reads at all", async () => {
    const { client, calls } = fakeClient(fixture());
    const r = await clearSkippedNodeImagePointers(client, ORG, [{ key: `orgs/${ORG}/branding/covers/orphan.tiff`, reportedMissing: true }], ADDED_ALL);
    expect(r).toEqual({ cleared: [], kept: [], errors: [] });
    expect(calls.filter((c) => c.op === "update")).toEqual([]);
    const empty = fakeClient(fixture());
    expect(await clearSkippedNodeImagePointers(empty.client, "", [{ key: SVG, reportedMissing: true }], ADDED_ALL)).toEqual({ cleared: [], kept: [], errors: [] });
    expect(await clearSkippedNodeImagePointers(empty.client, ORG, [], ADDED_ALL)).toEqual({ cleared: [], kept: [], errors: [] });
    expect(empty.calls).toEqual([]);
  });

  it("checked: a failed read is said (no write follows it); a refused write (zero rows — RLS, the 20261210 rail) is said and never counted as cleared", async () => {
    const db = fixture();
    const { client } = fakeClient(db, {
      readError: (t, f) => (t === "collections" && f.some((x) => x.startsWith("cover_image_url=")) ? "permission denied" : null),
      refuse: (t, id) => t === "libraries" && id === "lib-1",
    });
    const r = await clearSkippedNodeImagePointers(client, ORG, [{ key: SVG, reportedMissing: true }], ADDED_ALL);
    expect(r.cleared).toEqual([]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/^The library "P&IDs" still points at the missing cover covers\/legacy\.svg: Nothing was changed/);
    expect(r.errors[1]).toBe("Could not read the folders that use covers/legacy.svg as a cover (permission denied).");
    expect(db.libraries[0].cover_image_url).toBe(SVG);
    expect(db.collections[1].cover_image_url).toBe(SVG);
  });

  // ── fix pass 2: DEC-90 fail-safe — the clear touches only rows this restore added ──
  it("REVIEW PIN: a row that was already here (not added by this restore) naming a reported-missing key is KEPT, named, and never written", async () => {
    const db = fixture();
    const { client, calls } = fakeClient(db);
    // lib-1 and fold-2 both name SVG; only fold-2 was added by this restore
    const r = await clearSkippedNodeImagePointers(client, ORG, [{ key: SVG, reportedMissing: true }], {
      restoredLibraryIds: new Set(), restoredFolderIds: new Set(["fold-2"]), storageAnswered: true,
    });
    expect(r.errors).toEqual([]);
    expect(r.cleared.map((n) => n.id)).toEqual(["fold-2"]);
    expect(r.kept).toEqual([{ kind: "library", id: "lib-1", name: "P&IDs", slot: "cover", file: "covers/legacy.svg", keptBecause: "already-here" }]);
    expect(db.libraries[0].cover_image_url).toBe(SVG); // the live cover is untouched
    const writes = calls.filter((c) => c.op === "update");
    expect(writes).toHaveLength(1);
    expect(writes[0].filters).toContain("id=fold-2");
  });

  it("the same holds for a background: an existing library's background is kept, an added folder's is cleared", async () => {
    const db = fixture();
    const { client } = fakeClient(db);
    const r = await clearSkippedNodeImagePointers(client, ORG, [{ key: HEIC, reportedMissing: true }], {
      restoredLibraryIds: new Set(), restoredFolderIds: new Set(["fold-1"]), storageAnswered: true,
    });
    expect(r.cleared.map((n) => n.id)).toEqual(["fold-1"]);
    expect(r.kept.map((n) => [n.id, n.keptBecause])).toEqual([["lib-1", "already-here"]]);
    expect((db.libraries[0].page_config as Row).background).toEqual({ type: "image", imagePath: HEIC, opacity: 0.18 });
    expect(db.collections[0].page_config).toEqual({ background: { type: "none" } });
  });

  it("a run in which storage never answered (outage, wrong credentials) clears nothing — every report of missing is distrusted, each node named", async () => {
    const db = fixture();
    const { client, calls } = fakeClient(db);
    const r = await clearSkippedNodeImagePointers(client, ORG, [{ key: SVG, reportedMissing: true }, { key: HEIC, reportedMissing: true }],
      { ...ADDED_ALL, storageAnswered: false });
    expect(r.cleared).toEqual([]);
    expect(r.kept).toHaveLength(4);
    expect(r.kept.every((n) => n.keptBecause === "storage-unanswered")).toBe(true);
    expect(calls.filter((c) => c.op === "update")).toEqual([]);
  });

  it("nodeImageClearVerdict: a clear needs all three; any doubt keeps", () => {
    expect(nodeImageClearVerdict(true, true, true)).toBeNull();
    expect(nodeImageClearVerdict(false, true, true)).toBe("not-reported-missing");
    expect(nodeImageClearVerdict(true, false, true)).toBe("already-here");
    expect(nodeImageClearVerdict(true, true, false)).toBe("storage-unanswered");
    expect(nodeImageClearVerdict(false, false, false)).toBe("not-reported-missing");
  });

  it("storageAnsweredInRun: only an upload or a file found present is evidence (a space-archived file is decided from the database)", () => {
    expect(storageAnsweredInRun({ uploaded: 0, skipped: 0 })).toBe(false);
    expect(storageAnsweredInRun({ uploaded: 1, skipped: 0 })).toBe(true);
    expect(storageAnsweredInRun({ uploaded: 0, skipped: 3 })).toBe(true);
    // the page passes its counters object, which carries offline / failed too
    expect(storageAnsweredInRun({ uploaded: 0, skipped: 0, offline: 4, failed: 9 } as { uploaded: number; skipped: number })).toBe(false);
  });

  it("restoreEnvelopeNodeIds / addRestoredNodeIds: the backup's ids, minus those already here, added to earlier runs'", () => {
    const env = { tables: { libraries: [{ id: "lib-1" }, { id: "lib-9" }, { id: "lib-9" }, null, { name: "no id" }], collections: [{ id: "fold-7" }], notes: [{ id: "n" }] } };
    const ids = restoreEnvelopeNodeIds(env as never);
    expect(ids).toEqual({ libraries: ["lib-1", "lib-9"], collections: ["fold-7"] });
    expect(restoreEnvelopeNodeIds({ tables: {} })).toEqual({ libraries: [], collections: [] });
    const first = addRestoredNodeIds(null, ids, { libraries: new Set(["lib-1"]), collections: new Set() });
    expect([...first.libraries]).toEqual(["lib-9"]);
    expect([...first.collections]).toEqual(["fold-7"]);
    // a second run sees the first run's rows as already here — they stay counted as added
    const second = addRestoredNodeIds(first, ids, { libraries: new Set(["lib-1", "lib-9"]), collections: new Set(["fold-7"]) });
    expect([...second.libraries]).toEqual(["lib-9"]);
    expect([...second.collections]).toEqual(["fold-7"]);
  });

  it("nodeIdsPresentBeforeRestore: reads this workspace's rows among the backup's ids in chunks; a failed read is ok:false (the caller then clears nothing)", async () => {
    const db = fixture();
    const { client, calls } = fakeClient(db);
    const many = Array.from({ length: 450 }, (_, i) => `lib-n${i}`);
    const r = await nodeIdsPresentBeforeRestore(client, ORG, { libraries: ["lib-1", "lib-x", ...many], collections: ["fold-2", "fold-9"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.libraries]).toEqual(["lib-1"]); // lib-x is another workspace's
      expect([...r.collections]).toEqual(["fold-2"]);
    }
    const libReads = calls.filter((c) => c.table === "libraries");
    expect(libReads).toHaveLength(3); // 452 ids → 200 + 200 + 52
    for (const c of calls) expect(c.filters).toContain(`org_id=${ORG}`);
    const bad = fakeClient(fixture(), { readError: (t) => (t === "collections" ? "permission denied" : null) });
    const e = await nodeIdsPresentBeforeRestore(bad.client, ORG, { libraries: ["lib-1"], collections: ["fold-2"] });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toMatch(/^Could not read which folders were already here before the restore \(permission denied\)/);
    // a thrown read (network) is ok:false too — it never throws into the restore
    const throwing = { from: () => { throw new Error("Failed to fetch"); } } as never;
    const t = await nodeIdsPresentBeforeRestore(throwing, ORG, { libraries: ["lib-1"], collections: [] });
    expect(t).toEqual({ ok: false, error: expect.stringContaining("(Failed to fetch)") });
  });

  it("the restore's promise is said: the additive note now names what the files step can change, and that an existing record is never changed by it", () => {
    expect(RESTORE_ADDITIVE_NOTE.endsWith(RESTORE_FILES_POINTER_NOTE)).toBe(true);
    expect(RESTORE_FILES_POINTER_NOTE).toContain("only folders and libraries this restore added");
    expect(RESTORE_FILES_POINTER_NOTE).toContain("legacy SVG, HEIC or TIFF cover or background");
    expect(RESTORE_FILES_POINTER_NOTE).toContain("each one is named");
    expect(RESTORE_FILES_POINTER_NOTE).toContain("A folder or library that was already here is never changed by it.");
    // the counter exception and "kept exactly as it is" stay as pinned elsewhere (restoreApplyRoute.test.ts)
    expect(RESTORE_ADDITIVE_NOTE).toMatch(/kept exactly as it is/);
    expect(RESTORE_ADDITIVE_NOTE).toMatch(/The one exception the restore itself makes is a ticket or document numbering counter/);
  });

  it("the pure helpers", () => {
    expect(pageConfigWithoutBackground(null)).toEqual({ background: { type: "none" } });
    expect(pageConfigWithoutBackground([1])).toEqual({ background: { type: "none" } });
    expect(pageConfigWithoutBackground({ header: { layout: "plain" }, background: { type: "image", imagePath: "k" } }))
      .toEqual({ header: { layout: "plain" }, background: { type: "none" } });
    expect(nodeImageFileLabel(SVG)).toBe("covers/legacy.svg");
    const n: NodeImagePointerNode = { kind: "folder", id: "f", name: "", slot: "cover", file: "covers/a.svg" };
    expect(nodeImagePointerLabel(n)).toBe('folder "f" — cover (covers/a.svg)');
    expect(nodeImagePointerLabel({ ...n, keptBecause: "already-here" }))
      .toBe(`folder "f" — cover (covers/a.svg): kept, because ${NODE_IMAGE_KEPT_REASON_TEXT["already-here"]}`);
  });

  it("overflowLines: the first `cap` lines and how many more — every line is either shown or counted", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
    expect(overflowLines(eight, 5)).toEqual({ shown: eight.slice(0, 5), more: 3 });
    expect(overflowLines(eight, 10)).toEqual({ shown: eight, more: 0 });
    expect(overflowLines(eight, 8)).toEqual({ shown: eight, more: 0 });
    expect(overflowLines([], 5)).toEqual({ shown: [], more: 0 });
    expect(overflowLines(eight, 0)).toEqual({ shown: [], more: 8 });
    expect(overflowLines(eight, -1)).toEqual({ shown: [], more: 8 });
    for (const cap of [0, 1, 5, 10]) {
      const { shown, more } = overflowLines(eight, cap);
      expect(shown.length + more).toBe(eight.length);
    }
  });

  it("DEC-29: the helper's comments do not claim more than the route gives — `missing: true` only for storage's NotFound since ORG-20 (drafting-flow DF-P11); the helper still trusts it no further", () => {
    const route = src("app/api/storage/resolve/route.ts");
    // ORG-20 (DF-P11): the HEAD's catch answers missing: true only for a
    // NotFound; any other failure is a 503 the restore counts as "not
    // reported missing" (check.ok is false).
    expect(route).toMatch(/\} catch \(e\) \{\n\s+if \(!isStorageNotFound\(e\)\) \{/);
    expect(route).toMatch(/status: 503/);
    const lib = src("lib/dataRestore.ts");
    const block = lib.slice(lib.indexOf("// ── ORG-18:"), lib.indexOf("export async function clearSkippedNodeImagePointers"));
    expect(block).toContain("That answer is NOT a proof of absence");
    expect(block).toContain("a HEAD failure of any kind");
    expect(block).not.toMatch(/never removed|CONFIRMED|confirmed missing/);
    expect(lib).not.toContain("the check only ever");
    expect(lib).not.toContain("confirmedMissing");
  });
});

describe("ORG-18 — the restore page clears and names (app/(protected)/admin/restore/page.tsx)", () => {
  const page = src("app/(protected)/admin/restore/page.tsx");
  it("each skipped cover / background key is kept with whether the storage check reported it missing (the resolve route's `missing: true`)", () => {
    // DF-P11 integrator fix pass: the probe's answer is read by
    // classifyRestoreFileProbe (lib/dataRestore.ts) — reportedMissing is
    // `missing: true` on a 200 only (a 503 reads as not reported missing),
    // pinned behaviourally in storageResolve.test.ts.
    expect(page).toContain("skippedNodeImages.push({ key, reportedMissing: probe.reportedMissing });");
    expect(page).toContain("const probe = classifyRestoreFileProbe(key, check.status, state);");
    // the route answers that when HeadObject answers NotFound (ORG-20, DF-P11:
    // any other failure is a 503, which this flag reads as not reported missing)
    expect(src("app/api/storage/resolve/route.ts")).toMatch(/archived: true, missing: true, archiveId: v\?\.archive_id \?\? null/);
    // …and a file already present is counted present before any of this (never cleared)
    expect(page.indexOf('if (probe.kind === "skip") { counters.skipped++; return; }'))
      .toBeLessThan(page.indexOf("skippedNodeImages.push("));
  });
  it("after every file is tried, the pointers are cleared through the checked helper with this workspace's id, and the result is shown", () => {
    const loopEnd = page.indexOf("await Promise.all(\n      Array.from({ length: Math.min(CONCURRENCY, entries.length) }");
    const call = page.indexOf("await clearSkippedNodeImagePointers(supabase, activeOrgId, skippedNodeImages, {");
    expect(loopEnd).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(loopEnd);
    expect(page).toContain("setFilesProgress({ running: false, total: entries.length, ...counters, ...detail(), ...(pointers ?? {}) });");
    expect(page).toContain('data-testid="restore-node-images-cleared"');
    expect(page).toContain("So nothing points at a missing image, the cover or background was removed from");
    expect(page).toContain("These still point at a skipped image (nothing was changed), each with the reason it was kept:");
    expect(page).not.toContain("could not confirm");
    expect(page).toContain("filesProgress.nodeImagePointerErrors");
    // a thrown helper is said, never a silent success
    expect(page).toMatch(/catch \(e\) \{\n\s+pointers = \{ nodeImagesCleared: \[\], nodeImagesKept: \[\], nodeImagePointerErrors: \[/);
  });
  it("no list drops a node silently: cleared and kept show 10 then 'and N more', errors show 5 then 'and N more that failed', each with every line under Show all", () => {
    expect(page).toContain("overflowLines, type SkippedNodeImage,");
    // cleared
    expect(page).toMatch(/const all = filesProgress\.nodeImagesCleared!;\n\s+const \{ shown, more \} = overflowLines\(all, 10\);/);
    expect(page).toContain('<ShowAllLines lines={all} testId="restore-node-images-cleared-all" />');
    // kept
    expect(page).toMatch(/const all = filesProgress\.nodeImagesKept!;\n\s+const \{ shown, more \} = overflowLines\(all, 10\);/);
    expect(page).toContain('<ShowAllLines lines={all} testId="restore-node-images-kept-all" />');
    expect((page.match(/\{more > 0 \? `; and \$\{fmtNum\(more\)\} more` : ""\}/g) ?? []).length).toBe(2);
    // errors
    expect(page).toMatch(/const all = filesProgress\.nodeImagePointerErrors!;\n\s+const \{ shown, more \} = overflowLines\(all, 5\);/);
    expect(page).toContain("and {fmtNum(more)} more that failed");
    expect(page).toContain('<ShowAllLines lines={all} testId="restore-node-image-errors-all" />');
    // the old silent caps are gone
    expect(page).not.toContain("nodeImagePointerErrors ?? []).slice(0, 5)");
    expect(page).not.toMatch(/nodeImages(Cleared|Kept)!\.length > 10 \? "; …"/);
    // Show all lists every line it is given
    expect(page).toMatch(/function ShowAllLines\(\{ lines, testId \}[^)]*\) \{[\s\S]*?\{lines\.map\(\(l, i\) => <li key=\{`\$\{i\}:\$\{l\}`\}>\{l\}<\/li>\)\}/);
  });
  it("fix pass 2: the 'was it here' read runs after the confirm and BEFORE the records are written; only added rows and an answering storage may be cleared", () => {
    const confirm = page.indexOf("if (!ok) return;\n      // ORG-18 fix pass 2:");
    const before = page.indexOf("await nodeIdsPresentBeforeRestore(supabase, activeOrgId, backupNodeIds)");
    const run = page.indexOf("async () => await runChunkedRestore(");
    expect(confirm).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(confirm);
    expect(run).toBeGreaterThan(before);
    expect(page).toContain("if (nodesBefore?.ok) restoredNodesRef.current = addRestoredNodeIds(restoredNodesRef.current, backupNodeIds, nodesBefore);");
    expect(page).toContain("else if (nodesBefore && !nodesBefore.ok) restoredNodesNoteRef.current = nodesBefore.error;");
    // the clear is scoped: nothing added → empty sets (nothing cleared); storage evidence from this run's counters
    expect(page).toContain("restoredLibraryIds: added?.libraries ?? new Set<string>(),");
    expect(page).toContain("restoredFolderIds: added?.collections ?? new Set<string>(),");
    expect(page).toContain("storageAnswered: storageAnsweredInRun(counters),");
    // a failed "was it here" read is said with the pointer errors
    expect(page).toContain("nodeImagePointerErrors: [...(restoredNodesNoteRef.current ? [restoredNodesNoteRef.current] : []), ...r.errors],");
    // a new drop forgets the previous backup's added rows
    expect(page).toContain("restoredNodesRef.current = null; restoredNodesNoteRef.current = null;");
  });
  it("fix pass 2: the files step says, before it runs, that it can change records — only ones this restore added", () => {
    const para = page.indexOf("Re-uploads the <b>{fmtNum(fileEntryCount)}</b> file(s)");
    const note = page.indexOf('<span data-testid="restore-files-pointer-note">{RESTORE_FILES_POINTER_NOTE}</span>');
    const button = page.indexOf("onClick={() => void putFilesBack()}");
    expect(para).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(para);
    expect(button).toBeGreaterThan(note);
    // and the confirm before the records are applied carries it (RESTORE_ADDITIVE_NOTE ends with it)
    expect(page).toContain("`${RESTORE_ADDITIVE_NOTE} This can't be auto-undone.`");
  });
  it("REGRESSION: the ORG-16 file notice is unchanged and still names each skipped file", () => {
    expect(page).toContain("nodeImagesNotRestored: [...nodeImagesNotRestored],");
    expect(page).toContain("folder or library cover / background image(s) in this");
  });
});
