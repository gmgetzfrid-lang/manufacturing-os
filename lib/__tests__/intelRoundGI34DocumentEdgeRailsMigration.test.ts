// intelligence Round G I-34 DOCUMENT EDGE READ RAILS — the paste contract and
// the shape of 20261261 (DACL-11), read from the migration folder at test
// time.
//
//   * One paste (DEC-30): the TEMP counts-only inventory before the
//     transaction, one BEGIN/COMMIT, ONE final SELECT (check, ok, n).
//   * The prerequisite check (20261131 live; no lineage row naming a document
//     in another workspace — DEC-90 ruling 2) runs before the inventory AND,
//     verbatim, right after BEGIN, so a client that continues past an error
//     still cannot land the rail (DEC-90 ruling 1).
//   * It creates ONE object — document_supersessions_documents_readable —
//     in the shape of 20261170's two rails (RESTRICTIVE FOR SELECT TO
//     authenticated, EXISTS on documents under the caller's RLS), on BOTH
//     document columns. It re-creates no function, policy or trigger.
//   * The census, after the whole sequence: every document-linked table
//     (document_supersessions, entity_mentions, document_related_resources,
//     document_assets, project_documents) carries a RESTRICTIVE read rail on
//     EVERY column that references documents — a column added later without
//     one fails here.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");
const FILES = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const FILE = "20261261_intel_roundG_document_edge_read_rails.sql";
const M70 = "20261170_intel_roundG_document_assets_source.sql";
const sql = read(FILE);
const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");
const code = stripComments(sql);

function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

interface Pol { file: string; text: string; restrictive: boolean; cmd: string }

/** The live policies on a table after the whole sequence (DROP / CREATE in filename order). */
function census(table: string): Map<string, Pol> {
  const live = new Map<string, Pol>();
  const re = new RegExp(String.raw`(DROP POLICY IF EXISTS\s+"?(\w+)"?\s+ON\s+(?:public\.)?${table}\s*;)|(CREATE POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?${table}\b[\s\S]*?;)`, "g");
  for (const f of FILES) {
    const body = stripComments(read(f));
    for (const m of body.matchAll(re)) {
      if (m[1]) live.delete(m[2]);
      else {
        const text = m[3];
        const cmd = /FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i.exec(text)?.[1].toUpperCase() ?? "ALL";
        live.set(m[4], { file: f, text, restrictive: /AS\s+RESTRICTIVE/i.test(text), cmd });
      }
    }
  }
  return live;
}

/** Every column of `table` that references documents(id), across the sequence and schema.sql. */
function documentColumns(table: string): Set<string> {
  const out = new Set<string>();
  const sources = [join(process.cwd(), "supabase", "schema.sql"), ...FILES.map((f) => join(DIR, f))];
  for (const p of sources) {
    const body = stripComments(readFileSync(p, "utf8"));
    const create = new RegExp(String.raw`CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?${table}\s*\(([\s\S]*?)\n\s*\);`, "g");
    for (const m of body.matchAll(create)) {
      for (const line of m[1].split("\n")) {
        const c = /^\s*(\w+)\s+UUID\b[^\n]*REFERENCES\s+(?:public\.)?documents\s*\(\s*id\s*\)/i.exec(line);
        if (c) out.add(c[1]);
      }
    }
    const add = new RegExp(String.raw`ALTER TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?${table}\s+ADD COLUMN(?: IF NOT EXISTS)?\s+(\w+)\s+UUID\b[^;]*REFERENCES\s+(?:public\.)?documents\s*\(\s*id\s*\)`, "gi");
    for (const m of body.matchAll(add)) out.add(m[1]);
  }
  return out;
}

describe("20261261 — the paste contract (DEC-30)", () => {
  it("TEMP counts-only inventory before the one transaction; ONE final SELECT with (check, ok, n)", () => {
    const begin = code.indexOf("\nBEGIN;");
    const temp = code.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g261_before AS");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(code.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;/gm)).toHaveLength(1);
    const tail = code.slice(code.indexOf("\nCOMMIT;"));
    // one statement after COMMIT: the verification SELECT
    expect(tail.trim().split(";").filter((s) => s.trim()).length).toBe(2);
    expect(tail).toMatch(/SELECT 'DACL-11: [^']+' AS "check",/);
    expect(tail).toMatch(/\) AS ok,\s+NULL::text AS n/);
    expect(tail).toMatch(/SELECT 'inventory \(before\): ' \|\| what, NULL, n::text FROM _intel_g261_before;\s*$/);
    // counts only — never a customer row
    const inventory = code.slice(temp, begin);
    expect(inventory.match(/SELECT '[^']*(?:''[^']*)*'(?: AS what)?, COUNT\(\*\)(?: AS n)?/g)).toHaveLength(7);
  });

  it("the inventory counts only what a rail hides (ruling (4)): visibility, never is_private; the cross-workspace lineage rows are counted", () => {
    const inventory = code.slice(code.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g261_before AS"), code.indexOf("\nBEGIN;"));
    // node_visible reads documents.visibility, never is_private (app-only): counting it would over-count
    expect(inventory).not.toMatch(/is_private/);
    expect(inventory).toContain("WHERE d.visibility IN ('private', 'hidden')");
    // a legacy row whose documents are not both in its workspace is hidden from a member of that workspace alone
    expect(inventory).toContain("SELECT 'document_supersessions rows whose documents are not both in the row''s workspace (must be 0: the paste refuses otherwise");
    expect(inventory).toMatch(/JOIN documents a ON a\.id = s\.superseded_doc_id\s+JOIN documents b ON b\.id = s\.replacement_doc_id\s+WHERE a\.org_id <> s\.org_id OR b\.org_id <> s\.org_id/);
    expect(code).not.toMatch(/SELECT \*/);
  });

  it("held behind 20261131: a prerequisite check BEFORE the inventory refuses (nothing changed) until 20261131 is live with its pair index, while 20261131's last check counts every policy", () => {
    const guard = code.indexOf("DO $$");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(code.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g261_before AS"));
    const block = code.slice(guard, code.indexOf("END $$;", guard));
    expect(block).toContain("IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_supersessions' AND cmd = 'ALL')");
    expect(block).toContain("policyname = 'document_supersessions_delete' AND cmd = 'DELETE'");
    expect(block).toContain("= ARRAY['replacement_doc_id', 'superseded_doc_id']");
    expect(block).toMatch(/RAISE EXCEPTION '20261261 needs 20261131 live with its supersession pair index built: [^']*Nothing was changed\.';/);
    // the reason: 20261131's own check counts EVERY policy on the table, so a fifth one (this rail) reads it false
    const m131 = read("20261131_dc_roundF_documents_rails.sql");
    if (m131.includes("AND (SELECT COUNT(*) = 4 FROM pg_policies WHERE tablename = 'document_supersessions'), NULL")) {
      expect(sql).toContain("Paste order: HOLD with 20261131");
      expect(sql).toContain("(20261131:519, COUNT(*) = 4, every policy counted)");
    }
    // the member-read probe no longer accepts a FOR ALL policy
    expect(code).not.toMatch(/cmd IN \('SELECT', 'ALL'\)/);
    expect(code).toContain("AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_supersessions' AND cmd = 'ALL'),");
  });

  it("the prerequisite check is repeated verbatim between BEGIN and CREATE POLICY (DEC-90 fail-safe): a client that continues past the first refusal aborts the transaction, so COMMIT rolls back", () => {
    const blocks = [...code.matchAll(/DO \$\$[\s\S]*?END \$\$;/g)].map((m) => ({ at: m.index!, text: m[0] }));
    expect(blocks).toHaveLength(2);
    const begin = code.indexOf("\nBEGIN;");
    const create = code.indexOf("CREATE POLICY document_supersessions_documents_readable");
    // the early one: before the inventory (the SQL editor stops there, so the inventory is skipped too)
    expect(blocks[0].at).toBeLessThan(code.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g261_before AS"));
    // the second one: inside the transaction, before the one DDL
    expect(blocks[1].at).toBeGreaterThan(begin);
    expect(blocks[1].at).toBeLessThan(create);
    expect(code.slice(begin, blocks[1].at).trim()).toBe("BEGIN;");
    expect(blocks[1].text).toBe(blocks[0].text);
  });

  it("refuses while any lineage row names a document in another workspace (DEC-90 ruling 2): counts only, a plain message, in both checks", () => {
    for (const b of [...code.matchAll(/DO \$\$[\s\S]*?END \$\$;/g)].map((m) => m[0])) {
      expect(b).toMatch(/SELECT COUNT\(\*\) INTO n_cross\s+FROM document_supersessions s\s+JOIN documents a ON a\.id = s\.superseded_doc_id\s+JOIN documents b ON b\.id = s\.replacement_doc_id\s+WHERE a\.org_id <> s\.org_id OR b\.org_id <> s\.org_id;/);
      expect(b).toMatch(/IF n_cross > 0 THEN\s+RAISE EXCEPTION '20261261 refused: % document_supersessions rows name a document in another workspace; reconcile them under document-control DRLS-13 first; nothing was changed\.', n_cross;/);
      // a count, never a row's contents
      expect(b).not.toMatch(/s\.id|superseded_doc_id\s*,|RAISE[^;]*(superseded_doc_id|replacement_doc_id)/);
    }
    expect(sql).toContain("It also refuses\n-- while any document_supersessions row names a document in another\n-- workspace");
  });

  it("the probes are deparse-safe: no bare cast inside a LIKE pattern; the qual is matched on its deparsed text", () => {
    for (const m of code.matchAll(/LIKE '([^']*)'/g)) expect(m[1], m[1]).not.toMatch(/::/);
    expect(code).toContain("qual LIKE '%d.id = document_supersessions.superseded_doc_id%'");
    expect(code).toContain("qual LIKE '%d.id = document_supersessions.replacement_doc_id%'");
  });
});

describe("20261261 — one object, in 20261170's shape", () => {
  const POLICY = [
    "CREATE POLICY document_supersessions_documents_readable ON document_supersessions",
    "  AS RESTRICTIVE FOR SELECT TO authenticated",
    "  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_supersessions.superseded_doc_id)",
    "         AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_supersessions.replacement_doc_id));",
  ].join("\n");

  it("creates exactly the one RESTRICTIVE read rail, on both document columns; re-creates no function, trigger or other policy", () => {
    expect(code).toContain(POLICY);
    expect(code.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(code.match(/DROP POLICY/g)).toEqual(["DROP POLICY"]);
    expect(code).toContain("DROP POLICY IF EXISTS document_supersessions_documents_readable ON document_supersessions;");
    expect(code).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|TRIGGER|VIEW)/);
    expect(code).not.toMatch(/\b(GRANT|REVOKE|UPDATE|DELETE FROM|INSERT INTO)\b/);
    expect(code).not.toMatch(/SECURITY DEFINER/);
  });

  it("copies 20261170's rail shape: the same AS RESTRICTIVE FOR SELECT TO authenticated line and the same EXISTS on documents under the caller's RLS", () => {
    const m70 = stripComments(read(M70));
    const rail70 = m70.slice(m70.indexOf("CREATE POLICY project_documents_document_readable"), m70.indexOf(";", m70.indexOf("CREATE POLICY project_documents_document_readable")) + 1);
    const shape = (s: string, rail: string, table: string) => s.replaceAll(rail, "<rail>").replaceAll(table, "<t>");
    const d = lineDiff(
      shape(rail70, "project_documents_document_readable", "project_documents"),
      shape(POLICY, "document_supersessions_documents_readable", "document_supersessions"),
    );
    expect(d.onlyInA).toEqual(["  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = <t>.document_id));"]);
    expect(d.onlyInB).toEqual([
      "  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = <t>.superseded_doc_id)",
      "         AND EXISTS (SELECT 1 FROM documents d WHERE d.id = <t>.replacement_doc_id));",
    ]);
  });

  it("no earlier migration defines a policy of that name (nothing re-created)", () => {
    for (const f of FILES.filter((x) => x < FILE)) expect(read(f), f).not.toContain("document_supersessions_documents_readable");
  });
});

describe("DACL-11 done-when 1 — the census after the whole sequence", () => {
  it("document_supersessions: 20261131's four per-command policies stand beside the new rail; it is the only restrictive one", () => {
    const live = census("document_supersessions");
    expect([...live.keys()].sort()).toEqual([
      "document_supersessions_delete", "document_supersessions_documents_readable", "document_supersessions_insert",
      "document_supersessions_select", "document_supersessions_update",
    ]);
    const restrictive = [...live.entries()].filter(([, p]) => p.restrictive);
    expect(restrictive.map(([n]) => n)).toEqual(["document_supersessions_documents_readable"]);
    expect(restrictive[0][1].file).toBe(FILE);
    expect(live.get("document_supersessions_select")!.text).toMatch(/FROM org_members m/);
  });

  // Every column referencing documents(id), and the read rail that covers it.
  const TABLES: Array<{ table: string; columns: string[]; rail: string; file: string }> = [
    { table: "document_supersessions", columns: ["replacement_doc_id", "superseded_doc_id"], rail: "document_supersessions_documents_readable", file: FILE },
    { table: "entity_mentions", columns: ["document_id"], rail: "entity_mentions_source_readable", file: "20261120_intel_roundG_knowledge_memory_acl.sql" },
    { table: "document_related_resources", columns: ["document_id", "target_document_id"], rail: "document_related_resources_read_endpoints", file: "20261126_intel_roundG_link_conflict_targets.sql" },
    { table: "document_assets", columns: ["document_id"], rail: "document_assets_document_readable", file: M70 },
    { table: "project_documents", columns: ["document_id"], rail: "project_documents_document_readable", file: M70 },
  ];

  for (const t of TABLES) {
    it(`${t.table}: every column that references documents (${t.columns.join(", ")}) is gated by ${t.rail}, a RESTRICTIVE SELECT EXISTS on documents`, () => {
      expect([...documentColumns(t.table)].sort()).toEqual(t.columns);
      const p = census(t.table).get(t.rail);
      expect(p, `${t.rail} is live`).toBeDefined();
      expect(p!.file).toBe(t.file);
      expect(p!.restrictive).toBe(true);
      expect(p!.cmd).toBe("SELECT");
      for (const c of t.columns) {
        expect(p!.text, c).toMatch(new RegExp(String.raw`EXISTS \(SELECT 1 FROM documents d WHERE d\.id = ${t.table}\.${c}\)`));
      }
    });
  }

  it("entity_mentions' second source column (the mirror, knowledge_document_id) is gated through knowledge_documents under the caller's RLS", () => {
    const p = census("entity_mentions").get("entity_mentions_source_readable")!;
    expect(p.text).toMatch(/EXISTS \(SELECT 1 FROM knowledge_documents k WHERE k\.id = entity_mentions\.knowledge_document_id\)/);
  });

  it("the probes confirm the two older rails rather than re-creating them (re-creating them TO authenticated would take them away from other roles)", () => {
    expect(code).not.toMatch(/CREATE POLICY entity_mentions_source_readable|CREATE POLICY document_related_resources_read_endpoints/);
    const tail = code.slice(code.indexOf("\nCOMMIT;"));
    expect(tail).toContain("policyname = 'entity_mentions_source_readable'");
    expect(tail).toContain("qual LIKE '%k.id = entity_mentions.knowledge_document_id%'");
    expect(tail).toContain("policyname = 'document_related_resources_read_endpoints'");
    expect(tail).toContain("qual LIKE '%d.id = document_related_resources.target_document_id%'");
    expect(tail).toContain("policyname = 'document_assets_document_readable'");
    expect(tail).toContain("policyname = 'project_documents_document_readable'");
  });
});
