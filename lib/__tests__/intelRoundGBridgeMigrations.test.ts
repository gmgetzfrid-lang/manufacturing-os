// intelligence Round G (I-11) — the paste contract and the shape of
// 20261170 (GAP-302 / AREA-2 / DACL-11) and 20261171 (GAP-303 / GAP-309 /
// BR-9 / WIRE-8).
//
//   * One paste each: the TEMP inventory before the transaction, one
//     BEGIN/COMMIT, ONE final SELECT (check, ok, n).
//   * The two sync triggers re-created from their NEWEST earlier definition
//     (found by scanning the sequence) — byte-faithful except the header
//     line (SECURITY DEFINER SET search_path = public), EXECUTE revoked from
//     every client role (DRLS-16), the DELETE still scoped to 'jsonb_sync'.
//   * The documentAssetsPolicy census: after the sequence, document_assets
//     carries exactly the five policies 20261170 wrote — the FOR ALL
//     membership policy is gone and nothing later re-opens it; project_
//     documents carries the restrictive document-readable read.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");
const FILES = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const M70 = "20261170_intel_roundG_document_assets_source.sql";
const M71 = "20261171_intel_roundG_provenance.sql";
const m70 = read(M70);
const m71 = read(M71);
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

/** The body of `CREATE OR REPLACE FUNCTION name()` … its closing `$$;`. */
function fnBlock(sql: string, name: string): string | null {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`);
  if (start < 0) return null;
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end + 3);
}

/** The newest definition of a function in the sequence BEFORE `file`. */
function newestBefore(name: string, file: string): { file: string; block: string } {
  let hit: { file: string; block: string } | null = null;
  for (const f of FILES) {
    if (f >= file) break;
    const b = fnBlock(read(f), name);
    if (b) hit = { file: f, block: b };
  }
  expect(hit, `no earlier definition of ${name}`).not.toBeNull();
  return hit!;
}

function pasteContract(sql: string, temp: string) {
  const code = stripComments(sql);
  const begin = code.indexOf("\nBEGIN;");
  expect(code.indexOf(`CREATE TEMP TABLE IF NOT EXISTS ${temp}`)).toBeGreaterThan(-1);
  expect(code.indexOf(`CREATE TEMP TABLE IF NOT EXISTS ${temp}`)).toBeLessThan(begin);
  expect(code.match(/^BEGIN;/gm)).toHaveLength(1);
  expect(code.match(/^COMMIT;/gm)).toHaveLength(1);
  const tail = code.slice(code.indexOf("\nCOMMIT;") + 8).trim();
  // ONE statement after the transaction: the SELECT … UNION ALL … result set.
  expect(tail.startsWith("SELECT")).toBe(true);
  const unquoted = tail.replace(/'(?:[^']|'')*'/g, "''");
  expect(unquoted.replace(/;\s*$/, "").includes(";")).toBe(false);
  expect(tail).toMatch(/AS "check"/);
  expect(tail).toMatch(/AS ok/);
  expect(tail).toMatch(/NULL::text AS n/);
  expect(tail).toContain(`FROM ${temp}`);
  // Probes read deparsed policy text with plain substrings (no casts).
  for (const like of tail.match(/LIKE '[^']*(?:''[^']*)*'/g) ?? []) expect(like, like).not.toMatch(/::/);
}

describe("20261170 — the paste contract", () => {
  it("inventory before the transaction, one BEGIN/COMMIT, one final SELECT (check, ok, n)", () => pasteContract(m70, "_intel_g70_before"));
  it("counts what the plan asks before applying: unexpected sources, drawing-discovered assets, the GAP-304 backfill population, who loses link writes", () => {
    const inv = m70.slice(0, m70.indexOf("\nBEGIN;"));
    expect(inv).toMatch(/source NOT IN \('jsonb_sync', 'manual', 'drawing'\)/);
    expect(inv).toMatch(/FROM assets WHERE origin = 'drawing'/);
    expect(inv).toMatch(/equipment_bridge ->> 'targetColumnKey'/);
    expect(inv).toMatch(/NOT EXISTS \(SELECT 1 FROM document_assets da WHERE da\.document_id = d\.id\)/);
    expect(inv).toMatch(/registry writer tier/);
    expect(inv).not.toMatch(/SELECT \*|tag_text|document_number/); // aggregate counts only, never customer rows
  });
});

describe("20261170 — GAP-302: the vocabulary and where on the document", () => {
  it("the CHECK admits drawing, re-added NOT VALID and validated only when nothing violates it", () => {
    expect(m70).toMatch(/ADD CONSTRAINT document_assets_source_check\s+CHECK \(source IN \('jsonb_sync', 'manual', 'drawing'\)\) NOT VALID;/);
    expect(m70).toMatch(/IF NOT EXISTS \(SELECT 1 FROM document_assets\s+WHERE source IS NULL OR source NOT IN \('jsonb_sync', 'manual', 'drawing'\)\) THEN\s+ALTER TABLE document_assets VALIDATE CONSTRAINT document_assets_source_check;/);
    // The vocabulary CHECK is dropped first (20260609 named it inline).
    expect(m70).toMatch(/pg_get_constraintdef\(oid\) LIKE '%source%'/);
    expect(read("20260609_phase1_normalization.sql")).toMatch(/source\s+TEXT NOT NULL DEFAULT 'jsonb_sync' CHECK \(source IN \('jsonb_sync','manual'\)\)/);
  });
  it("a re-paste after 20261171 drops ONLY the vocabulary CHECK — document_assets_drawing_is_machine survives (fix pass: the loop matched every CHECK mentioning source)", () => {
    expect(m70).toMatch(/AND \(conname = 'document_assets_source_check'\s+OR \(pg_get_constraintdef\(oid\) LIKE '%source%'\s+AND pg_get_constraintdef\(oid\) LIKE '%jsonb_sync%'\)\) LOOP/);
    // The loop's predicate over the three CHECKs as PG16 deparses them
    // (verified on a scratch PG16 cluster after 20261170 then 20261171).
    const like = (s: string, pat: string) => new RegExp(`^${pat.split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(s);
    const dropped = (name: string, def: string) => name === "document_assets_source_check" || (like(def, "%source%") && like(def, "%jsonb_sync%"));
    expect(dropped("document_assets_source_check", "CHECK ((source = ANY (ARRAY['jsonb_sync'::text, 'manual'::text, 'drawing'::text])))")).toBe(true);
    expect(dropped("document_assets_source_check_legacy", "CHECK ((source = ANY (ARRAY['jsonb_sync'::text, 'manual'::text])))")).toBe(true);
    expect(dropped("document_assets_drawing_is_machine", "CHECK (((source <> 'drawing'::text) OR (asserted_by = 'machine'::text)))")).toBe(false);
    expect(dropped("document_assets_asserted_by_check", "CHECK ((asserted_by = ANY (ARRAY['machine'::text, 'human'::text])))")).toBe(false);
    // …and the probe counts the vocabulary CHECK only.
    expect(m70).toMatch(/AND pg_get_constraintdef\(oid\) LIKE '%source%'\s+AND pg_get_constraintdef\(oid\) LIKE '%jsonb_sync%'\) = 1 AS ok,/);
  });
  it("sheet_label and pages, nullable", () => {
    expect(m70).toMatch(/ADD COLUMN IF NOT EXISTS sheet_label TEXT;/);
    expect(m70).toMatch(/ADD COLUMN IF NOT EXISTS pages INTEGER\[\];/);
  });
});

describe("20261170 — the sync triggers, re-created from their newest definition (lineDiff)", () => {
  for (const name of ["documents_resync_assets", "assets_backfill_documents"]) {
    it(`${name}: byte-faithful except the header line; owner rights; search_path pinned; EXECUTE revoked from every client role`, () => {
      const live = newestBefore(name, M70);
      expect(live.file).toBe("20260609_phase1_normalization.sql");
      const next = fnBlock(m70, name)!;
      const { onlyInA, onlyInB } = lineDiff(live.block, next);
      expect(onlyInA).toEqual(["RETURNS trigger LANGUAGE plpgsql AS $$"]);
      expect(onlyInB).toEqual(["RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$"]);
      expect(m70).toContain(`REVOKE ALL ON FUNCTION ${name}() FROM PUBLIC, anon, authenticated;`);
      expect(m70.indexOf(`REVOKE ALL ON FUNCTION ${name}()`)).toBeGreaterThan(m70.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`));
    });
  }
  it("the resync DELETE can remove jsonb_sync rows only — a drawing or manual row survives every asset_tags edit (GAP-302 acceptance 1)", () => {
    const body = fnBlock(m70, "documents_resync_assets")!;
    const deletes = body.match(/DELETE FROM document_assets[\s\S]*?;/g) ?? [];
    expect(deletes).toEqual(["DELETE FROM document_assets\n   WHERE document_id = NEW.id AND source = 'jsonb_sync';"]);
    expect(body.match(/INSERT INTO document_assets[\s\S]*?ON CONFLICT \(document_id, asset_id\) DO NOTHING;/g)).toHaveLength(1);
    expect(body).not.toMatch(/UPDATE document_assets/);
  });
  it("the triggers themselves are not re-bound (CREATE OR REPLACE keeps the function each trigger runs)", () => {
    expect(stripComments(m70)).not.toMatch(/CREATE TRIGGER/);
  });
});

describe("20261170 — AREA-2 / DACL-11: the documentAssetsPolicy census", () => {
  type Pol = { file: string; text: string };
  /** The live policies on a table after the whole sequence, by name. */
  function census(table: string): Map<string, Pol> {
    const live = new Map<string, Pol>();
    for (const f of FILES) {
      const code = stripComments(read(f));
      for (const m of code.matchAll(new RegExp(`DROP POLICY IF EXISTS "?(\\w+)"? ON ${table}\\b`, "g"))) live.delete(m[1]);
      for (const m of code.matchAll(new RegExp(`CREATE POLICY "?(\\w+)"? ON ${table}\\b[\\s\\S]*?;`, "g"))) live.set(m[1], { file: f, text: m[0] });
    }
    return live;
  }
  it("document_assets carries exactly the five policies 20261170 wrote; the FOR ALL membership policy is gone", () => {
    const live = census("document_assets");
    expect([...live.keys()].sort()).toEqual([
      "document_assets_delete", "document_assets_document_readable", "document_assets_insert",
      "document_assets_select", "document_assets_update",
    ]);
    for (const p of live.values()) expect(p.file).toBe(M70);
    expect([...live.values()].some((p) => /FOR ALL/.test(p.text))).toBe(false);
  });
  it("writes: a manual row only, the registry writer tier by the role collection, a readable in-org document and an in-org asset; a drawing row is never a person's to update or delete", () => {
    const live = census("document_assets");
    const writers = "caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[])";
    const ins = live.get("document_assets_insert")!.text;
    expect(ins).toMatch(/FOR INSERT TO authenticated/);
    expect(ins).toContain("source = 'manual'");
    expect(ins).toContain(writers);
    expect(ins).toContain("EXISTS (SELECT 1 FROM documents d WHERE d.id = document_assets.document_id AND d.org_id = document_assets.org_id)");
    expect(ins).toContain("EXISTS (SELECT 1 FROM assets a WHERE a.id = document_assets.asset_id AND a.org_id = document_assets.org_id)");
    for (const name of ["document_assets_update", "document_assets_delete"]) {
      const t = live.get(name)!.text;
      expect(t).toContain("source <> 'drawing'");
      expect(t).toContain(writers);
    }
    expect(live.get("document_assets_update")!.text).toMatch(/WITH CHECK \(source = 'manual'/);
    // The roles are the registry writer tier the page claims (ADMIN_SURFACES "assets".writes).
    expect(readFileSync(join(process.cwd(), "lib", "adminSurfaces.ts"), "utf8"))
      .toMatch(/key: "assets", path: "\/admin\/assets", label: "Operating areas", entry: "\*", writes: \["Admin", "DocCtrl", "Manager", "Supervisor"\]/);
  });
  it("reads: members, AND (restrictive) only with the document readable — the documents read decision under the caller's RLS", () => {
    const live = census("document_assets");
    expect(live.get("document_assets_select")!.text).toMatch(/FOR SELECT TO authenticated\s+USING \(EXISTS \(SELECT 1 FROM org_members/);
    expect(live.get("document_assets_document_readable")!.text)
      .toMatch(/AS RESTRICTIVE FOR SELECT TO authenticated\s+USING \(EXISTS \(SELECT 1 FROM documents d WHERE d\.id = document_assets\.document_id\)\);/);
    const pd = census("project_documents");
    expect(pd.get("project_documents_document_readable")!.text)
      .toMatch(/AS RESTRICTIVE FOR SELECT TO authenticated\s+USING \(EXISTS \(SELECT 1 FROM documents d WHERE d\.id = project_documents\.document_id\)\);/);
    // 20261102's project policies stand beside it, untouched.
    expect([...pd.keys()].sort()).toEqual([
      "project_documents_delete", "project_documents_document_readable", "project_documents_insert",
      "project_documents_select", "project_documents_update",
    ]);
  });
  it("the probes check what was written: the member_all policy gone, both restrictive policies, the writer predicates", () => {
    const tail = m70.slice(m70.indexOf("\nCOMMIT;"));
    expect(tail).toMatch(/NOT EXISTS \(SELECT 1 FROM pg_policies WHERE tablename = 'document_assets' AND policyname = 'document_assets_member_all'\)/);
    expect(tail).toMatch(/permissive = 'RESTRICTIVE'/);
    expect(tail).toMatch(/NOT has_function_privilege\('anon', 'documents_resync_assets\(\)', 'EXECUTE'\)/);
    expect(tail).toMatch(/prosrc LIKE '%WHERE document_id = NEW\.id AND source = ''jsonb_sync'';%'/);
  });
  it("the registry drawer's Unlink reads back what it deleted and says so when a drawing link was not removed (the policy matches no row)", () => {
    const page = readFileSync(join(process.cwd(), "app", "(protected)", "admin", "assets", "page.tsx"), "utf8");
    const at = page.indexOf("const unlinkDocument = async");
    const body = page.slice(at, page.indexOf("refreshDocs();", at));
    expect(body).toMatch(/\.delete\(\)\s*\.eq\("document_id", documentId\)\.eq\("asset_id", asset\.id\)\.select\("id"\)/);
    expect(body).toMatch(/gone\.length === 0/);
    expect(body).toMatch(/dismissing the tag in that library's Equipment sweep/);
  });
});

describe("20261171 — the paste contract and provenance", () => {
  it("inventory before the transaction, one BEGIN/COMMIT, one final SELECT (check, ok, n)", () => pasteContract(m71, "_intel_g71_before"));
  it("GAP-303 / GAP-309 columns; asserted_by machine|human, NOT NULL; a drawing row is always machine (backfilled, then validated)", () => {
    for (const c of [
      "asserted_by TEXT NOT NULL DEFAULT 'human'", "asserted_by_user UUID", "model TEXT", "source_revision TEXT",
      "source_version_id UUID", "vanished_at TIMESTAMPTZ", "superseded_at TIMESTAMPTZ",
      // GAP-309 fix pass: "It is still there" is remembered for its revision.
      "presence_confirmed_on UUID",
    ]) expect(m71).toContain(`ADD COLUMN IF NOT EXISTS ${c};`);
    expect(m71).toMatch(/column_name IN \('vanished_at', 'superseded_at', 'presence_confirmed_on'\)/);
    expect(m71).toMatch(/CHECK \(asserted_by IN \('machine', 'human'\)\);/);
    const backfill = m71.indexOf("UPDATE document_assets SET asserted_by = 'machine' WHERE source = 'drawing'");
    const rule = m71.indexOf("CHECK (source <> 'drawing' OR asserted_by = 'machine') NOT VALID;");
    expect(backfill).toBeGreaterThan(0);
    expect(rule).toBeGreaterThan(backfill);
    expect(m71).toMatch(/VALIDATE CONSTRAINT document_assets_drawing_is_machine;/);
  });
  it("a person's write is stamped by the database — human, their uid, no model, no revision; the service role writes as given (a restored drawing row lands machine)", () => {
    const fn = fnBlock(m71, "document_assets_stamp_assertion")!;
    expect(fn).toMatch(/RETURNS trigger LANGUAGE plpgsql SET search_path = public AS \$\$/);
    expect(fn).not.toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN\s+IF NEW\.source = 'drawing' THEN NEW\.asserted_by := 'machine'; END IF;\s+RETURN NEW;\s+END IF;/);
    for (const l of [
      "NEW.asserted_by := 'human';", "NEW.asserted_by_user := auth.uid();", "NEW.model := NULL;",
      "NEW.source_revision := NULL;", "NEW.source_version_id := NULL;", "NEW.vanished_at := NULL;", "NEW.superseded_at := NULL;",
    ]) expect(fn).toContain(l);
    expect(m71).toMatch(/CREATE TRIGGER trg_document_assets_stamp_assertion\s+BEFORE INSERT OR UPDATE ON document_assets\s+FOR EACH ROW EXECUTE FUNCTION document_assets_stamp_assertion\(\);/);
    // No earlier migration defines it: nothing is re-created.
    for (const f of FILES.filter((x) => x < M71)) expect(read(f)).not.toContain("document_assets_stamp_assertion");
  });
  it("BR-9 / BR-14: the ledger's dismissed and sources columns", () => {
    expect(m71).toContain("ALTER TABLE document_equipment_suggestions ADD COLUMN IF NOT EXISTS dismissed JSONB NOT NULL DEFAULT '[]'::jsonb;");
    expect(m71).toContain("ALTER TABLE document_equipment_suggestions ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]'::jsonb;");
  });
  it("WIRE-8: GIN (jsonb_path_ops) on transmittals.items and tickets.metadata; a b-tree on the expression the impact scan filters", () => {
    expect(m71).toContain("CREATE INDEX IF NOT EXISTS transmittals_items_path_gin ON transmittals USING GIN (items jsonb_path_ops);");
    expect(m71).toContain("CREATE INDEX IF NOT EXISTS tickets_metadata_path_gin ON tickets USING GIN (metadata jsonb_path_ops);");
    expect(m71).toContain("CREATE INDEX IF NOT EXISTS tickets_source_document_id_idx ON tickets ((metadata -> 'source_document' ->> 'id'));");
    // …which is exactly what lib/impact.ts and lib/transmittals.ts ask.
    expect(readFileSync(join(process.cwd(), "lib", "impact.ts"), "utf8")).toContain('.eq("metadata->source_document->>id", documentId)');
    expect(readFileSync(join(process.cwd(), "lib", "transmittals.ts"), "utf8")).toMatch(/\.contains\("items", JSON\.stringify\(\[\{ documentId \}\]\)\)/);
  });
});

describe("the package's migration numbers", () => {
  it("only 20261170 and 20261171 carry this package's work, named in the intel Round G shape", () => {
    expect(FILES).toContain(M70);
    expect(FILES).toContain(M71);
    expect(FILES.filter((f) => /^2026117[01]_/.test(f))).toEqual([M70, M71]);
  });
});
