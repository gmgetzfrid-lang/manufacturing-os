// intelligence Round G (I-09) — 20261155_intel_roundG_process_flows_authority.sql,
// read as text (there is no live database here; the paste's final SELECT is
// the live check, and the file was run on a scratch PostgreSQL 16 — the
// cases are recorded on FLOW-2).
//
// Shape: the three policies it re-creates start from their NEWEST earlier
// definition (found by scanning the sequence) and differ by exactly the
// authority clauses (lineDiff); the two functions are new, invoker-rights,
// search_path pinned; the one-paste protocol holds (TEMP-table inventory of
// counts before BEGIN, one final SELECT of (check, ok, n)); the inventory's
// controller predicate is is_org_controller's own; no probe LIKEs a bare cast.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const FILE = "20261155_intel_roundG_process_flows_authority.sql";
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const text = (f: string) => readFileSync(join(dir, f), "utf8");
const m = text(FILE);
const lineDiff = (a: string, b: string) => {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
};
/** The statement `CREATE POLICY <name> …;` in a file (to the first `;` at a line end). */
const policyIn = (src: string, name: string): string | null => {
  const at = src.search(new RegExp(`CREATE POLICY ${name} ON process_flows`));
  if (at < 0) return null;
  const end = src.indexOf(";\n", at);
  return src.slice(at, end + 1);
};
/** The newest migration BEFORE this one that defines the policy. */
const newestEarlier = (name: string): { file: string; body: string } => {
  let out: { file: string; body: string } | null = null;
  for (const f of files) {
    if (f >= FILE) break;
    const body = policyIn(text(f), name);
    if (body) out = { file: f, body };
  }
  if (!out) throw new Error(`no earlier definition of ${name}`);
  return out;
};

describe("20261155 — the policies, from their newest definition plus the authority clauses only", () => {
  it("process_flows_insert: 20261017's text, plus status-by-authority, origin manual, no source document", () => {
    const old = newestEarlier("process_flows_insert");
    expect(old.file).toBe("20261017_process_flows.sql");
    const next = policyIn(m, "process_flows_insert")!;
    const d = lineDiff(old.body, next);
    expect(d.onlyInA).toEqual([]);
    expect(d.onlyInB).toEqual([
      "  AND (status = 'proposed' OR is_org_controller(org_id))",
      "  AND origin = 'manual'",
      "  AND source_document_id IS NULL",
    ]);
  });

  it("process_flows_update / _delete: 20261017's text with the author's arm narrowed to a row still proposed", () => {
    for (const name of ["process_flows_update", "process_flows_delete"]) {
      const old = newestEarlier(name);
      expect(old.file).toBe("20261017_process_flows.sql");
      const next = policyIn(m, name)!;
      const d = lineDiff(old.body, next);
      for (const l of d.onlyInA) expect(l).toContain("created_by = auth.uid()");
      for (const l of d.onlyInB) expect(l).toContain("(created_by = auth.uid() AND status = 'proposed')");
      expect(d.onlyInB.length).toBe(d.onlyInA.length);
      expect(next.replace(/\(created_by = auth\.uid\(\) AND status = 'proposed'\)/g, "created_by = auth.uid()")).toBe(old.body);
    }
  });

  it("the SELECT policy is untouched (every active member reads the map)", () => {
    expect(policyIn(m, "process_flows_select")).toBeNull();
  });
});

describe("20261155 — the guard and the cleanup", () => {
  const fn = (name: string) => {
    const at = m.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`);
    return m.slice(at, m.indexOf("$$;", at) + 3);
  };

  it("both functions are new — no earlier migration defines them, so nothing live is re-created", () => {
    for (const f of files.filter((x) => x < FILE)) {
      expect(text(f), f).not.toMatch(/FUNCTION\s+(process_flows_guard|assets_process_flows_cleanup)\s*\(/);
    }
  });

  it("invoker rights, search_path pinned; the guard runs BEFORE INSERT OR UPDATE, the cleanup AFTER DELETE ON assets", () => {
    for (const name of ["process_flows_guard", "assets_process_flows_cleanup"]) {
      const f = fn(name);
      expect(f).toMatch(/RETURNS trigger LANGUAGE plpgsql SET search_path = public AS \$\$/);
      expect(f).not.toMatch(/SECURITY DEFINER/);
    }
    expect(m).not.toMatch(/SECURITY DEFINER\s+SET/);
    expect(m).toMatch(/CREATE TRIGGER trg_process_flows_guard\n  BEFORE INSERT OR UPDATE ON process_flows\n  FOR EACH ROW EXECUTE FUNCTION process_flows_guard\(\);/);
    expect(m).toMatch(/CREATE TRIGGER trg_assets_process_flows_cleanup\n  AFTER DELETE ON assets\n  FOR EACH ROW EXECUTE FUNCTION assets_process_flows_cleanup\(\);/);
  });

  it("the guard: endpoints for every writer, then a NULL uid (the service role only — no anon write passes RLS) returns, then the person's rules", () => {
    const g = fn("process_flows_guard");
    const endpoints = g.indexOf("process_flows_endpoint");
    const svc = g.indexOf("IF v_uid IS NULL THEN RETURN NEW; END IF;");
    expect(endpoints).toBeGreaterThan(0);
    expect(svc).toBeGreaterThan(endpoints);
    expect(g.indexOf("process_flows_source")).toBeLessThan(svc);
    for (const rule of ["process_flows_origin", "process_flows_provenance", "process_flows_fixed", "process_flows_decide"]) {
      expect(g.indexOf(rule), rule).toBeGreaterThan(svc);
    }
    // status by authority on a person's insert; decisions stamped by the database
    expect(g).toContain("v_controller := is_org_controller(NEW.org_id);");
    expect(g).toContain("IF NOT v_controller THEN NEW.status := 'proposed'; END IF;");
    expect(g).toContain("NEW.created_by := v_uid;");
    expect(g).toContain("NEW.decided_by := v_uid; NEW.decided_by_name := v_email; NEW.decided_at := now();");
    expect(g).toContain("NEW.decided_by := OLD.decided_by; NEW.decided_by_name := OLD.decided_by_name; NEW.decided_at := OLD.decided_at;");
    // a unit end is a Site Codebook unit; an asset end is this org's asset
    expect(g).toContain("c.org_id = NEW.org_id AND c.kind = 'unit' AND c.code = v_ref");
    expect(g).toContain("a.id = v_ref::uuid AND a.org_id = NEW.org_id");
    expect(g).toMatch(/USING ERRCODE = '23503'/);
    // no role literal in the guard: the tier is is_org_controller's (DEC-35)
    expect(g).not.toMatch(/'Admin'|'DocCtrl'/);
  });

  it("the fixed-column check lets the foreign key CLEAR the source (deleting a cited knowledge document), and still refuses setting or retargeting it", () => {
    // 20261017: source_document_id REFERENCES knowledge_documents(id) ON DELETE SET NULL —
    // the RI action is an UPDATE run under the deleting person's auth.uid().
    expect(text("20261017_process_flows.sql")).toContain("source_document_id UUID REFERENCES knowledge_documents(id) ON DELETE SET NULL,");
    const g = fn("process_flows_guard");
    const fixed = g.slice(g.indexOf("-- UPDATE by a person."), g.indexOf("process_flows_fixed"));
    expect(fixed).toContain("OR (NEW.source_document_id IS NOT NULL AND NEW.source_document_id IS DISTINCT FROM OLD.source_document_id)");
    // the unconditional form (which refused the SET NULL) is gone
    expect(fixed).not.toMatch(/OR NEW\.source_document_id IS DISTINCT FROM OLD\.source_document_id/);
    // every other provenance column stays fixed, a NULLing included
    for (const col of ["source_page", "source_version_id", "evidence", "origin", "created_by", "created_by_name", "created_at"]) {
      expect(fixed, col).toContain(`OR NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
    // and the paste's final SELECT checks it live
    const probes = m.slice(m.indexOf("\nCOMMIT;\n"));
    expect(probes).toContain("prosrc LIKE '%OR (NEW.source_document_id IS NOT NULL AND NEW.source_document_id IS DISTINCT FROM OLD.source_document_id)%'");
    expect(probes).toContain("c.confrelid = 'knowledge_documents'::regclass AND c.confdeltype = 'n'");
  });

  it("the cleanup deletes only this org's flows that end at the deleted asset", () => {
    const c = fn("assets_process_flows_cleanup");
    expect(c).toContain("WHERE org_id = OLD.org_id");
    expect(c).toContain("(from_kind = 'asset' AND from_ref = OLD.id::text)");
    expect(c).toContain("(to_kind = 'asset' AND to_ref = OLD.id::text)");
  });

  it("the revision column and the to-side index", () => {
    expect(m).toContain("ALTER TABLE process_flows ADD COLUMN IF NOT EXISTS source_version_id UUID;");
    expect(m).toContain("CREATE INDEX IF NOT EXISTS process_flows_to_idx ON process_flows (org_id, to_kind, to_ref);");
  });
});

describe("20261155 — the one-paste protocol (DEC-30)", () => {
  it("inventory TEMP TABLE before BEGIN, counts only; BEGIN … COMMIT; then ONE final SELECT of (check, ok, n)", () => {
    const temp = m.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g55_before AS");
    const begin = m.indexOf("\nBEGIN;\n");
    const commit = m.indexOf("\nCOMMIT;\n");
    expect(temp).toBeGreaterThan(0);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    const inventory = m.slice(temp, begin);
    // every selected value is an aggregate count — never a row
    for (const line of inventory.split("\n").filter((l) => /^SELECT /.test(l))) {
      expect(line, line).toMatch(/^SELECT '(?:[^']|'')*'( AS what)?, COUNT\((\*|DISTINCT f\.created_by)\)( AS n)?( FROM |$)/);
    }
    const tail = m.slice(commit + "\nCOMMIT;\n".length);
    const lines = tail.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("--"));
    // one statement: every top-level SELECT after the first follows a UNION ALL; nothing else at column 0
    const top = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^[A-Z]/.test(l));
    expect(top[0].l).toMatch(/^SELECT '[^']*(?:''[^']*)*' AS "check",/);
    for (const { l, i } of top.slice(1)) {
      expect(l, l).toMatch(/^(UNION ALL|SELECT )/);
      if (l.startsWith("SELECT ")) expect(lines[i - 1]).toBe("UNION ALL");
    }
    expect(tail.trimEnd().endsWith(";")).toBe(true);
    expect(tail).toMatch(/\) AS ok,\n\s+NULL::text AS n\n/);
    expect(tail).toContain("SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g55_before");
  });

  it("the inventory's controller predicate is is_org_controller's own (20260814)", () => {
    const def = text("20260814_documents_delete_controllers.sql");
    expect(def).toContain("AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])");
    const inv = m.slice(m.indexOf("CREATE TEMP TABLE"), m.indexOf("\nBEGIN;\n"));
    const spelled = [...inv.matchAll(/\(m\.role IN \('Admin', 'DocCtrl'\) OR m\.roles && ARRAY\['Admin', 'DocCtrl'\]::text\[\]\)/g)];
    expect(spelled.length).toBe(5);
    expect(inv).not.toMatch(/'Manager'|'Supervisor'/);
  });

  it("no probe LIKEs a bare cast against a deparsed policy", () => {
    const probes = m.slice(m.indexOf("\nCOMMIT;\n"));
    for (const like of probes.matchAll(/(?:qual|with_check) LIKE '([^']*(?:''[^']*)*)'/g)) {
      expect(like[1], like[1]).not.toContain("::");
    }
  });
});
