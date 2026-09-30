// projects Round G — J4 migrations 20261095 (PERF-11 indexes) and 20261096
// (COST-13 / COST-3 / COST-12 columns, explicit registry link, one-off
// party backfill). Shape pins: one transaction, inventory captured BEFORE
// it, the fixed (check, ok, n) result shape, counts only — never customer
// rows — and the SQL vocabularies byte-equal to the TypeScript ones they
// mirror (ISO-4217 set, legal-suffix list).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ISO_4217, normalizeCompanyName } from "@/lib/bidTab";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const m95 = read("20261095_prj_roundG_registry_indexes.sql");
const m96 = read("20261096_prj_roundG_cost_doc_links_and_extent.sql");
const bidTabSrc = readFileSync(join(process.cwd(), "lib", "bidTab.ts"), "utf8");

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const finalSelect = (sql: string) => sql.slice(sql.lastIndexOf("COMMIT;"));

describe("20261095 — registry indexes (PERF-11)", () => {
  it("is one transaction of index DDL, not widening: no policy, grant or function", () => {
    const body = stripComments(m95);
    expect((body.match(/\bBEGIN;/g) ?? []).length).toBe(1);
    expect((body.match(/\bCOMMIT;/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/CREATE POLICY|GRANT |CREATE (OR REPLACE )?FUNCTION|SECURITY DEFINER/);
    expect(body).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  });

  it("counts documents and milestones BEFORE the transaction and builds their trigram indexes in it only when small; the CONCURRENTLY path is comment-only", () => {
    const beginAt = m95.indexOf("\nBEGIN;");
    const before = m95.slice(0, beginAt);
    expect(before).toMatch(/CREATE TEMP TABLE prj_g_index_inventory AS/);
    const inventoryRows = stripComments(before).match(/SELECT 'inventory:[^']*'[^\n]*\n?[^\n]*/g) ?? [];
    expect(inventoryRows).toHaveLength(2);
    for (const r of inventoryRows) expect(r).toMatch(/COUNT\(\*\)::text/);
    expect(before).toMatch(/FROM documents/);
    expect(before).toMatch(/FROM milestones/);
    // Inside the transaction the write-heavy tables are gated on their size.
    const tx = m95.slice(beginAt, m95.indexOf("COMMIT;"));
    expect(tx).toMatch(/IF \(SELECT COUNT\(\*\) FROM milestones\) <= 50000 THEN\s+CREATE INDEX IF NOT EXISTS milestones_responsible_party_trgm_idx/);
    expect(tx).toMatch(/IF \(SELECT COUNT\(\*\) FROM documents\) <= 50000 THEN\s+CREATE INDEX IF NOT EXISTS documents_title_trgm_idx[\s\S]*documents_name_trgm_idx[\s\S]*documents_document_number_trgm_idx[\s\S]*ELSE/);
    // CONCURRENTLY never runs inside the transaction; the four statements exist only as the operator's commented foot block.
    expect(stripComments(m95)).not.toMatch(/CREATE INDEX CONCURRENTLY/);
    const foot = m95.slice(m95.lastIndexOf("Large-table builds"));
    for (const idx of ["milestones_responsible_party_trgm_idx", "documents_title_trgm_idx", "documents_name_trgm_idx", "documents_document_number_trgm_idx"]) {
      expect(foot).toMatch(new RegExp(`-- CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idx} ON`));
    }
  });

  it("indexes every party_id join the gather reads and every ILIKE column, trigram GIN", () => {
    for (const t of ["change_orders", "turnover_items", "punch_items", "cost_documents", "cost_entries"]) {
      expect(m95).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${t}_party_idx\\s+ON ${t}\\s+\\(party_id\\)`));
    }
    for (const [t, col] of [["milestones", "responsible_party"], ["project_intake_links", "company_name"], ["documents", "title"], ["documents", "name"], ["documents", "document_number"], ["companies", "name"], ["companies", "trade"]]) {
      expect(m95).toMatch(new RegExp(`ON ${t} USING GIN \\(${col} gin_trgm_ops\\)`));
    }
    // companies.status CHECK — guarded, named, the three registry states.
    expect(m95).toMatch(/ADD CONSTRAINT companies_status_check\s+CHECK \(status IN \('active','inactive','do_not_use'\)\)/);
    expect(m95).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
  });

  it("ends in one SELECT of (check, ok, n) probes, one per index, all UNION ALL", () => {
    const tail = finalSelect(m95);
    expect(tail).toMatch(/AS check,\s*\n?\s*EXISTS[\s\S]*AS ok, NULL::text AS n/);
    const probes = (tail.match(/UNION ALL SELECT/g) ?? []).length;
    expect(probes).toBe(14);   // 13 probes + the inventory rows
    expect(tail).toMatch(/UNION ALL SELECT inventory, NULL::boolean, n FROM prj_g_index_inventory;/);
    expect(tail).not.toMatch(/SELECT \*/);
  });
});

describe("20261096 — cost-document links and read extent (COST-13 / COST-3 / COST-12)", () => {
  it("captures the DEC-30 inventory in temp tables BEFORE the transaction, as counts only", () => {
    const beginAt = m96.indexOf("\nBEGIN;");
    expect(beginAt).toBeGreaterThan(0);
    const before = m96.slice(0, beginAt);
    expect(before).toMatch(/CREATE TEMP TABLE prj_g_inventory AS/);
    expect(before).toMatch(/CREATE TEMP TABLE prj_g_party_match AS/);
    // Every inventory row is a COUNT(*)::text — no name, no id, no row leaves the database.
    const inventoryRows = stripComments(before).match(/SELECT 'inventory:[^']*'[^\n]*\n?[^\n]*/g) ?? [];
    expect(inventoryRows.length).toBe(8);
    for (const r of inventoryRows) expect(r).toMatch(/COUNT\(\*\)::text/);
    expect(stripComments(m96)).not.toMatch(/SELECT \*/);
    expect((stripComments(m96).match(/\bBEGIN;/g) ?? []).length).toBe(1);
    expect((stripComments(m96).match(/\bCOMMIT;/g) ?? []).length).toBe(1);
    expect(stripComments(m96)).not.toMatch(/CREATE POLICY|GRANT |CREATE (OR REPLACE )?FUNCTION|SECURITY DEFINER/);
  });

  it("adds the read-extent, registry-link and quality-manual-extent columns, with the FK ON DELETE SET NULL", () => {
    expect(m96).toMatch(/ALTER TABLE cost_documents ADD COLUMN IF NOT EXISTS pages_total INT;/);
    expect(m96).toMatch(/ALTER TABLE cost_documents ADD COLUMN IF NOT EXISTS pages_read\s+INT;/);
    expect(m96).toMatch(/ALTER TABLE cost_documents ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies\(id\) ON DELETE SET NULL;/);
    expect(m96).toMatch(/CREATE INDEX IF NOT EXISTS cost_documents_company_idx ON cost_documents \(company_id\)/);
    expect(m96).toMatch(/ALTER TABLE companies ADD COLUMN IF NOT EXISTS quality_manual_pages_read\s+INT;/);
    expect(m96).toMatch(/ALTER TABLE companies ADD COLUMN IF NOT EXISTS quality_manual_pages_total INT;/);
    // No default on pages_total: existing rows stay NULL = 'read extent unknown'.
    expect(m96).not.toMatch(/pages_total INT (NOT NULL|DEFAULT)/);
  });

  it("backfills project_parties.company_id only on a UNIQUE normalised match, inside the transaction", () => {
    const tx = m96.slice(m96.indexOf("\nBEGIN;"), m96.indexOf("COMMIT;"));
    expect(tx).toMatch(/UPDATE project_parties p\s+SET company_id = m\.company_id\s+FROM prj_g_party_match m\s+WHERE m\.party_id = p\.id AND m\.matches = 1 AND p\.company_id IS NULL;/);
    // The SQL normalisation strips the same legal suffixes as lib/bidTab.normalizeCompanyName.
    const tsList = /const LEGAL_SUFFIXES = new Set\(\[([\s\S]*?)\]\);/.exec(bidTabSrc)![1].match(/"([a-z]+)"/g)!.map((x) => x.replace(/"/g, ""));
    const sqlList = /\(inc\|[a-z|]+\)\)\+\$/.exec(m96)![0].replace(/^\(|\)\)\+\$$/g, "").split("|");
    expect(new Set(sqlList)).toEqual(new Set(tsList));
    expect((m96.match(/'\^the\\s\+'/g) ?? []).length).toBe(2);
  });

  it("the ISO-4217 list in the inventory is byte-equal to lib/bidTab.ISO_4217", () => {
    const block = /NOT IN \(([\s\S]*?)\)\s*\nUNION ALL/.exec(m96)![1];
    const codes = block.match(/'([A-Z]{3})'/g)!.map((x) => x.replace(/'/g, ""));
    expect(new Set(codes)).toEqual(ISO_4217);
    expect(codes.length).toBe(ISO_4217.size);
  });

  it("ends in one (check, ok, n) SELECT: probes with ok, inventory rows with n; the INTK-12 backfill stays commented", () => {
    const tail = finalSelect(m96);
    expect(tail).toMatch(/AS check,\s*\n?\s*EXISTS[\s\S]*AS ok, NULL::text AS n/);
    expect(tail).toMatch(/UNION ALL SELECT inventory, NULL::boolean, n FROM prj_g_inventory;/);
    expect((tail.match(/UNION ALL SELECT/g) ?? []).length).toBe(7);
    // The expiry backfill is present for the operator and every line of it is a comment.
    expect(tail).toMatch(/-- UPDATE project_intake_links\n--\s+SET expires_at = created_at \+ INTERVAL '90 days'/);
    expect(stripComments(tail)).not.toMatch(/UPDATE project_intake_links/);
  });
});

describe("20261096 — the SQL name normaliser behaves exactly like lib/bidTab.normalizeCompanyName", () => {
  // The expression, whitespace-normalised, exactly as both CTEs carry it:
  // punctuation → space, collapse, TRIM, THEN strip trailing legal
  // suffixes (the order that lets "Gulf Mechanical, Inc." lose its "inc").
  const SUFFIX = "(\\s+(inc|incorporated|llc|ltd|limited|co|corp|corporation|company|gmbh|plc|lp|llp|pty|sa|ag|bv|nv|srl|sarl|pte|pllc|pc))+$";
  const EXPECTED = `trim(regexp_replace(regexp_replace( trim(regexp_replace(regexp_replace(lower(replace(name, '&', ' and ')), '[^a-z0-9 ]+', ' ', 'g'), '\\s+', ' ', 'g')), '${SUFFIX}', ''), '^the\\s+', '')) AS key`;
  const ws = (x: string) => x.replace(/\s+/g, " ").replace(/\( /g, "(").trim();

  it("both CTEs carry the trim-before-suffix expression", () => {
    const exprs = m96.match(/trim\(regexp_replace\(regexp_replace\([\s\S]*?AS key/g) ?? [];
    expect(exprs).toHaveLength(2);
    for (const e of exprs) expect(ws(e)).toBe(ws(EXPECTED));
  });

  // A faithful port of that expression (PostgreSQL regexp_replace without
  // 'g' replaces the first match; with 'g' every match; [a-z] ranges are by
  // code point, as in JS). Verified against PostgreSQL 16 on the same names.
  const sqlNormalize = (name: string) => {
    let s = name.replace(/&/g, " and ").toLowerCase();
    s = s.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    s = s.replace(new RegExp(SUFFIX), "");
    s = s.replace(/^the\s+/, "");
    return s.trim();
  };

  it("realistic letterhead forms normalise identically in SQL and TypeScript", () => {
    const names = [
      "Gulf Mechanical, Inc.", "Apex Co.", "Apex Inc.", "APEX", "The X Co. Ltd", "Delta & Sons Corp.",
      "  Bayline   Industrial Services, LLC ", "O'Brien Welding Co., Inc.", "Acme Co Inc.", "3M Company",
      "Company of Heroes Ltd.", "Alpha\tBravo Pty. Ltd.", "The Co", "Co Inc", "Inc", "The",
    ];
    for (const n of names) expect(sqlNormalize(n)).toBe(normalizeCompanyName(n));
    expect(sqlNormalize("Gulf Mechanical, Inc.")).toBe("gulf mechanical");
    expect(sqlNormalize("Apex Co.")).toBe("apex");
    // "Apex" and "Apex Inc." are ONE key in both languages — ambiguous, so a party "Apex" never auto-binds.
    expect(sqlNormalize("Apex")).toBe(sqlNormalize("Apex Inc."));
  });
});
