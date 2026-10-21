// intelligence Round G I-26 BRIDGE REMAINDERS — the two pastes, exercised on
// the replayed PostgreSQL 16 (npm run test:db):
//
//   20261235 (GAP-307 acceptance 3) — knowledge_document_assets: a knowledge
//     upload's own document↔equipment relation. A member reads a row only
//     while they can read the knowledge document (the RESTRICTIVE EXISTS on
//     knowledge_documents runs under their own RLS — a mirror of a private
//     controlled document hides its rows from a member who cannot open that
//     document); another workspace's member reads nothing; nobody signed in
//     writes it; the service role cannot relate another workspace's upload or
//     asset (23503); a drawing row is always a machine's (23514). The paste's
//     ONE result set reads every probe true, and a re-paste is clean.
//   20261236 (WIRE-8 done-when 3) — documents_asset_tags_gin, built
//     CONCURRENTLY as the file's only statement: the replay sends it as one
//     simple-query message (as the SQL editor does) and it builds valid; the
//     asset hub's containment read (asset_tags @> '[{"tag": …}]') uses it.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const REL = "20261235_intel_roundG_knowledge_document_assets.sql";
const GIN = "20261236_intel_roundG_asset_tags_gin.sql";
const sqlOf = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");

describe.skipIf(skip !== null)("I-26: 20261235 knowledge_document_assets and 20261236 the asset_tags GIN index, on the replayed database", () => {
  let orgId = "";
  let otherOrg = "";
  let m: Record<string, SeededMember> = {};
  let outsider: SeededMember;
  const asset = randomUUID();
  const otherAsset = randomUUID();
  const kUpload = randomUUID();
  const kPrivate = randomUUID();
  const kOther = randomUUID();
  const copy = `mos_i26_${process.pid}`;

  const rowsOf = (who: SeededMember, kdoc: string, on = db) =>
    selectAs(on, who.caller, `SELECT count(*) FROM knowledge_document_assets WHERE knowledge_document_id = '${kdoc}'`)[0];

  beforeAll(() => {
    const s = seedOrg(db, { engineer: { role: "Engineer" }, viewer: { role: "Viewer" }, docctrl: { role: "Viewer", roles: ["DocCtrl"] } });
    orgId = s.orgId; m = s.m;
    const o = seedOrg(db, { admin: { role: "Admin" } });
    otherOrg = o.orgId; outsider = o.m.admin;
    const lib = randomUUID(), klib = randomUUID(), oklib = randomUUID(), priv = randomUUID();
    admin(db, [
      `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'I26', 'documents')`,
      `INSERT INTO knowledge_libraries (id, org_id, name) VALUES ('${klib}', '${orgId}', 'I26 KB')`,
      `INSERT INTO knowledge_libraries (id, org_id, name) VALUES ('${oklib}', '${otherOrg}', 'Other KB')`,
      `INSERT INTO assets (id, org_id, tag, tag_normalized, created_by) VALUES ('${asset}', '${orgId}', 'E-101', 'e-101', '${m.engineer.uid}')`,
      `INSERT INTO assets (id, org_id, tag, tag_normalized, created_by) VALUES ('${otherAsset}', '${otherOrg}', 'E-101', 'e-101', '${outsider.uid}')`,
      // a private controlled document granted to Engineer only, and its mirror
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility, acl_index) VALUES ('${priv}', '${orgId}', '${lib}', 'p.pdf', 'p', 'P-${priv.slice(0, 8)}', '0', 'Draft', 'private', '${JSON.stringify({ allow: { roles: { read: ["Engineer"] } } })}'::jsonb)`,
      `INSERT INTO knowledge_documents (id, org_id, library_id, name, file_key, source_document_id) VALUES ('${kPrivate}', '${orgId}', '${klib}', 'mirror', 'orgs/${orgId}/k/${kPrivate}.pdf', '${priv}')`,
      // an upload straight into the knowledge library (no controlled document)
      `INSERT INTO knowledge_documents (id, org_id, library_id, name, file_key) VALUES ('${kUpload}', '${orgId}', '${klib}', 'upload', 'orgs/${orgId}/k/${kUpload}.pdf')`,
      `INSERT INTO knowledge_documents (id, org_id, library_id, name, file_key) VALUES ('${kOther}', '${otherOrg}', '${oklib}', 'other upload', 'orgs/${otherOrg}/k/${kOther}.pdf')`,
      // the Bridge's knowledge door writes as the service role
      `INSERT INTO knowledge_document_assets (org_id, knowledge_document_id, asset_id, tag_text, sheet_label, pages, model) VALUES ('${orgId}', '${kUpload}', '${asset}', 'E-101', '25-PID-0101 SHT 2', ARRAY[2], NULL)`,
      `INSERT INTO knowledge_document_assets (org_id, knowledge_document_id, asset_id, tag_text, pages, model) VALUES ('${orgId}', '${kPrivate}', '${asset}', 'E-101', ARRAY[1], 'vision-model-x')`,
    ].join(";\n") + ";");
  });
  afterAll(() => {
    try { admin("postgres", `DROP DATABASE IF EXISTS ${copy}`); } catch { /* deleted with the cluster */ }
  });

  it("both files replay as one paste each — the CONCURRENTLY build too (its file holds that one statement)", () => {
    const files = mosDb().report!.files;
    expect(files.find((f) => f.file === REL)?.ok, files.find((f) => f.file === REL)?.error ?? "").toBe(true);
    expect(files.find((f) => f.file === GIN)?.ok, files.find((f) => f.file === GIN)?.error ?? "").toBe(true);
  });

  it("a member reads an upload's relation; a mirror's rows only while they can open the controlled document; another workspace's member reads nothing", () => {
    for (const k of ["engineer", "viewer", "docctrl"]) expect(rowsOf(m[k], kUpload), k).toBe("1");
    expect(rowsOf(m.viewer, kPrivate)).toBe("0");
    expect(rowsOf(m.engineer, kPrivate)).toBe("1");
    expect(rowsOf(m.docctrl, kPrivate)).toBe("1");
    expect(rowsOf(outsider, kUpload)).toBe("0");
    const anon = asCaller(db, { role: "anon" }, `SELECT 1 FROM knowledge_document_assets`);
    expect(anon.ok).toBe(false);
    if (!anon.ok) expect(anon.code).toBe("42501");
  });

  it("nobody signed in writes it — not a controller, not by insert, update or delete", () => {
    const ins = asCaller(db, m.docctrl.caller,
      `INSERT INTO knowledge_document_assets (org_id, knowledge_document_id, asset_id) VALUES ('${orgId}', '${kUpload}', '${asset}')`);
    expect(ins.ok).toBe(false);
    if (!ins.ok) expect(ins.code).toBe("42501");
    const upd = asCaller(db, m.docctrl.caller, `UPDATE knowledge_document_assets SET sheet_label = 'forged' WHERE knowledge_document_id = '${kUpload}'`);
    expect(upd.ok).toBe(false);
    const del = asCaller(db, m.docctrl.caller, `DELETE FROM knowledge_document_assets WHERE knowledge_document_id = '${kUpload}'`);
    expect(del.ok).toBe(false);
    expect(admin(db, `SELECT sheet_label FROM knowledge_document_assets WHERE knowledge_document_id = '${kUpload}'`)).toBe("25-PID-0101 SHT 2");
  });

  it("the service role cannot relate another workspace's upload or asset (23503), nor write a drawing row a person asserted (23514); its own pair is one row", () => {
    const sr = { role: "service_role" as const };
    const crossDoc = asCaller(db, sr, `INSERT INTO knowledge_document_assets (org_id, knowledge_document_id, asset_id) VALUES ('${orgId}', '${kOther}', '${asset}')`);
    expect(crossDoc.ok).toBe(false);
    if (!crossDoc.ok) expect(crossDoc.code).toBe("23503");
    const crossAsset = asCaller(db, sr, `INSERT INTO knowledge_document_assets (org_id, knowledge_document_id, asset_id) VALUES ('${orgId}', '${kUpload}', '${otherAsset}')`);
    expect(crossAsset.ok).toBe(false);
    if (!crossAsset.ok) expect(crossAsset.code).toBe("23503");
    const human = asCaller(db, sr, `INSERT INTO knowledge_document_assets (org_id, knowledge_document_id, asset_id, asserted_by) VALUES ('${otherOrg}', '${kOther}', '${otherAsset}', 'human')`);
    expect(human.ok).toBe(false);
    if (!human.ok) expect(human.code).toBe("23514");
    const dup = asCaller(db, sr, `INSERT INTO knowledge_document_assets (org_id, knowledge_document_id, asset_id) VALUES ('${orgId}', '${kUpload}', '${asset}')`);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("23505");
    // the knowledge door's upsert refreshes the one row
    const up = asCaller(db, sr, `INSERT INTO knowledge_document_assets (org_id, knowledge_document_id, asset_id, pages) VALUES ('${orgId}', '${kUpload}', '${asset}', ARRAY[2,3]) ON CONFLICT (knowledge_document_id, asset_id) DO UPDATE SET pages = EXCLUDED.pages`);
    expect(up).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT pages FROM knowledge_document_assets WHERE knowledge_document_id = '${kUpload}'`)).toBe("{2,3}");
  });

  it("deleting the upload deletes its relation (ON DELETE CASCADE)", () => {
    admin("postgres", `CREATE DATABASE ${copy} TEMPLATE ${REPLAY_DB}`);
    admin(copy, `DELETE FROM knowledge_documents WHERE id = '${kUpload}'`);
    expect(admin(copy, `SELECT count(*) FROM knowledge_document_assets WHERE knowledge_document_id = '${kUpload}'`)).toBe("0");
  });

  it("a re-paste of 20261235 is clean and its ONE result set reads every probe true (inventory rows carry a count)", () => {
    const r = runPsql(mosDb().conn!, copy, "postgres", { sql: sqlOf(REL) });
    expect(r.error).toBeNull();
    const rows = r.stdout.split("\n").filter((l) => l.includes("|"));
    const probes = rows.filter((l) => /\|[tf]\|$/.test(l));
    expect(probes.length).toBe(6);
    for (const p of probes) expect(p, p).toMatch(/\|t\|$/);
    const counts = rows.filter((l) => /\|\|\d+$/.test(l));
    expect(counts.length).toBe(4);
  });

  it("20261236: documents_asset_tags_gin is valid and ready, and the hub's containment read uses it", () => {
    expect(admin(db, `SELECT i.indisvalid AND i.indisready FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'documents_asset_tags_gin'`)).toBe("t");
    expect(admin(db, `SELECT pg_get_indexdef('documents_asset_tags_gin'::regclass)`)).toMatch(/USING gin \(asset_tags jsonb_path_ops\)/);
    // the containment itself is served by the GIN index (the replayed table is
    // tiny, so the planner is told not to prefer a sequential or b-tree scan)
    const plan = admin(db, `SET enable_seqscan = off; EXPLAIN SELECT id FROM documents WHERE asset_tags @> '[{"tag": "E-101"}]'::jsonb`);
    expect(plan).toMatch(/Bitmap Index Scan on documents_asset_tags_gin/);
    // (with the hub's org filter beside it the planner weighs the org's own
    // index against this one by the table's real size — on the replayed,
    // near-empty table that comparison says nothing, so it is not asserted)
    // a second paste is a no-op (IF NOT EXISTS), still one statement
    const again = runPsql(mosDb().conn!, copy, "postgres", { sql: sqlOf(GIN) });
    expect(again.error).toBeNull();
  });
});
