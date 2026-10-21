// document-control Round G — P38 DOCUMENT NOTICE RECORD: the shape of
// 20261257_dc_roundG_document_notice_record.sql (DEC-30 one-paste, DIST-19).
//
// The file creates ONE new table and re-creates nothing that exists (no
// function, policy or trigger of an earlier migration is named — checked
// against the whole folder at test time, so no lineDiff is owed). It was
// exercised on a throwaway PostgreSQL 16 (recorded in DIST-19's Resolution
// block): first apply and re-run all probes true; service-role write;
// ON CONFLICT (id) DO NOTHING replay; UPDATE and DELETE refused; a bad kind
// refused; authenticated INSERT / UPDATE / DELETE refused; reads follow the
// document (ACL-restricted document hidden, other org hidden, no session
// hidden, anon refused); not_emailed visible only to its person; the one
// query; a member's document delete and an org delete cascade; the
// prerequisite check refuses and changes nothing.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");
const FILE = "20261257_dc_roundG_document_notice_record.sql";
const raw = readFileSync(join(DIR, FILE), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");
const header = raw.slice(0, raw.indexOf("DO $$"));

describe("20261257 — DEC-30 one-paste shape", () => {
  it("prerequisite check → counts-only TEMP inventory → BEGIN … COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = sql.indexOf("DO $$");
    const temp = sql.indexOf("CREATE TEMP TABLE dc_round_g_257_before AS");
    const begin = sql.indexOf("BEGIN;");
    const commit = sql.indexOf("COMMIT;");
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(temp).toBeGreaterThan(pre);
    expect(begin).toBeGreaterThan(temp);
    expect(commit).toBeGreaterThan(begin);
    const tail = sql.slice(commit + "COMMIT;".length);
    expect(tail.replace(/'(?:[^']|'')*'/g, "''").match(/;/g)).toHaveLength(1);   // one statement after the transaction
    expect(tail.trim().startsWith('SELECT "check", ok, n FROM (')).toBe(true);
    expect(tail).toMatch(/ORDER BY sec, ord;\s*$/);
  });

  it("the inventory is aggregate counts only — never a customer row", () => {
    const inv = sql.slice(sql.indexOf("CREATE TEMP TABLE"), sql.indexOf("BEGIN;"));
    const selects = inv.match(/SELECT[\s\S]*?FROM/g) ?? [];
    expect(selects.length).toBe(3);
    for (const s of selects) expect(s).toMatch(/COUNT\(\*\)::text/);
  });

  it("the prerequisite check refuses, changing nothing, without the four base tables", () => {
    for (const t of ["documents", "document_review_signoffs", "document_acknowledgments", "distribution_acks"]) {
      expect(sql).toContain(`to_regclass('public.${t}') IS NULL`);
    }
    expect(sql).toMatch(/RAISE EXCEPTION '20261257 needs[^']*nothing was changed\.'/);
  });
});

describe("20261257 — the record", () => {
  it("is append-only: UPDATE refused, DELETE only once its document or org is gone; the trigger function is SECURITY INVOKER, search_path pinned, EXECUTE revoked", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION document_notice_events_append_only()\nRETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(sql).toContain("IF TG_OP = 'UPDATE' THEN");
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM documents WHERE id = OLD.document_id)\n     AND EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN");
    expect(sql).toContain("REVOKE ALL ON FUNCTION document_notice_events_append_only() FROM PUBLIC, anon, authenticated, service_role;");
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON document_notice_events\nFOR EACH ROW EXECUTE FUNCTION document_notice_events_append_only();");
    expect(sql).not.toMatch(/SECURITY DEFINER/);                 // DRLS-16: none to pin
  });

  it("reads follow the document; a not_emailed row only by its person; no client write (no write policy, grants revoked)", () => {
    expect(sql).toContain(`CREATE POLICY document_notice_events_read ON document_notice_events
  FOR SELECT TO authenticated
  USING ((kind <> 'not_emailed' OR recipient = auth.uid())
         AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_notice_events.document_id AND d.org_id = document_notice_events.org_id));`);
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON document_notice_events FROM anon, authenticated;");
    expect(sql).toContain("REVOKE ALL ON document_notice_events FROM anon;");
    expect(sql).toContain("ALTER TABLE document_notice_events ENABLE ROW LEVEL SECURITY;");
  });

  it("cascades from documents and orgs (every document delete and the org shed keep working)", () => {
    expect(sql).toContain("org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,");
    expect(sql).toContain("document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,");
  });

  it("the CHECKs list exactly the kinds and sources lib/documentNoticeRecord.ts writes", () => {
    const ts = readFileSync(join(process.cwd(), "lib", "documentNoticeRecord.ts"), "utf8");
    const union = (name: string) => [...ts.match(new RegExp(`export type ${name} = ([^;]+);`))![1].matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    const check = (col: string) => [...sql.match(new RegExp(`${col} TEXT NOT NULL CHECK \\(${col} IN \\(([^)]*)\\)\\)`))![1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    expect(check("kind")).toEqual(union("DocumentNoticeKind"));
    expect(check("source")).toEqual(union("DocumentNoticeSource"));
  });

  it("every field the app writes is a column of the table", () => {
    const body = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS document_notice_events ("), sql.indexOf("\n);", sql.indexOf("CREATE TABLE IF NOT EXISTS document_notice_events (")));
    const cols = new Set([...body.matchAll(/^\s+(\w+) [A-Z]/gm)].map((m) => m[1]));
    const ts = readFileSync(join(process.cwd(), "lib", "documentNoticeRecord.ts"), "utf8");
    const iface = ts.slice(ts.indexOf("export interface DocumentNoticeRow {"), ts.indexOf("}", ts.indexOf("export interface DocumentNoticeRow {")));
    const fields = [...iface.matchAll(/^\s+(\w+): /gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(10);
    for (const f of fields) expect(cols.has(f), f).toBe(true);
    // the cooldown read and the replay read only real columns
    for (const c of ["recipient", "document_id", "kind", "noticed_at", "source", "org_id"]) expect(cols.has(c), c).toBe(true);
  });

  it("re-creates nothing an earlier migration defines (a new table, function, trigger and policy only — no lineDiff owed)", () => {
    const others = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f) && f !== FILE)
      .map((f) => readFileSync(join(DIR, f), "utf8").replace(/--[^\n]*/g, "")).join("\n");
    for (const name of ["document_notice_events_append_only", "trg_document_notice_events_append_only", "document_notice_events_read", "document_notice_events"]) {
      expect(others.includes(name), name).toBe(false);
    }
    // nothing existing is altered
    expect(sql).not.toMatch(/ALTER TABLE (?!document_notice_events)\w+/);
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS (?!document_notice_events_read)/);
  });

  it("the header carries THE ONE QUERY (DIST-19 done-when 3) over the three obligations and the record, and the paste / deploy order", () => {
    expect(header).toContain("THE ONE QUERY (DIST-19 done-when 3)");
    for (const s of ["FROM document_review_signoffs s WHERE s.document_version_id = $1 AND s.reviewer_user_id = $2",
      "FROM document_acknowledgments a WHERE a.document_version_id = $1 AND a.assignee_user_id = $2",
      "FROM distribution_acks d WHERE d.version_id = $1 AND d.recipient_user_id = $2",
      "e.kind = 'reminded'", "e.kind = 'escalated'", "e.kind = 'alternate_activated'"]) expect(header).toContain(s);
    expect(header).toMatch(/PASTE \/ DEPLOY ORDER/);
    expect(header).toMatch(/42P01 \/ PGRST205/);
  });
});
