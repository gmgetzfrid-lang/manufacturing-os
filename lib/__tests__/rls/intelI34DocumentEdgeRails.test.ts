// intelligence Round G I-34 DOCUMENT EDGE READ RAILS (DACL-11) — exercised at
// RUNTIME on the replayed PostgreSQL 16 (npm run test:db), each read sent as
// PostgREST sends it (the role, and the JWT's claims).
//
//   * document_supersessions (20261261, NEW): a lineage row is readable only
//     while BOTH its documents are readable by the caller.
//   * entity_mentions (20261120) and document_related_resources (20261126):
//     the rails already in place — every document column they name.
//
// Pinned per table, per role: a member who can read the documents (Engineer
// granted on the private one, a DocCtrl controller), a member who cannot
// (Viewer), another workspace's member, anon, and the service role. "Before"
// is the same seeded database with 20261261's one policy dropped — the only
// object the file creates — so every reader with access is shown to read
// exactly today's rows, and the lineage writers' statements (a controller's
// upsert-on-the-pair and delete, the read-backs) answer the same before and
// after. The paste itself runs on the replay's snapshot taken just before it
// (CHECKPOINTS) and on a copy holding only this suite's workspace, where its
// ONE result set reads every probe true and the inventory counts exactly the
// rows each rail hides.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, selectAs, seedOrg, skipReason, type Caller, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = "20261261_intel_roundG_document_edge_read_rails.sql";
const sql = () => readFileSync(join(process.cwd(), "supabase", "migrations", FILE), "utf8");

describe.skipIf(skip !== null)("I-34 / DACL-11: document edge read rails, per table and per role, before and after 20261261", () => {
  let orgId = "";
  let otherOrg = "";
  let m: Record<string, SeededMember> = {};
  let outsider: SeededMember;
  const asset = randomUUID();
  const open1 = randomUUID(), open2 = randomUUID(), priv = randomUUID(), mirror = randomUUID();
  const pid = process.pid;
  const before = `mos_i34_before_${pid}`;
  const afterW = `mos_i34_after_w_${pid}`;
  const beforeW = `mos_i34_before_w_${pid}`;
  const pasteCp = `mos_i34_paste_cp_${pid}`;
  const pasteOwn = `mos_i34_paste_own_${pid}`;
  const anon: Caller = { role: "anon" };
  const service: Caller = { role: "service_role" };

  const count = (on: string, c: Caller, table: string) =>
    selectAs(on, c, `SELECT count(*) FROM ${table} WHERE org_id = '${orgId}'`)[0];

  beforeAll(() => {
    const s = seedOrg(db, { engineer: { role: "Engineer" }, viewer: { role: "Viewer" }, docctrl: { role: "Viewer", roles: ["DocCtrl"] } });
    orgId = s.orgId; m = s.m;
    const o = seedOrg(db, { admin: { role: "Admin" } });
    otherOrg = o.orgId; outsider = o.m.admin;
    const lib = randomUUID(), klib = randomUUID();
    const doc = (id: string, k: string, vis: string, index: object | null) =>
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility, acl_index) VALUES ('${id}', '${orgId}', '${lib}', '${k}.pdf', '${k}', 'I34-${id.slice(0, 8)}', '0', 'Draft', '${vis}', ${index ? `'${JSON.stringify(index)}'::jsonb` : "NULL"})`;
    admin(db, [
      `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'I34', 'documents')`,
      `INSERT INTO knowledge_libraries (id, org_id, name) VALUES ('${klib}', '${orgId}', 'I34 KB')`,
      `INSERT INTO assets (id, org_id, tag, tag_normalized, created_by) VALUES ('${asset}', '${orgId}', 'E-204', 'e-204', '${m.engineer.uid}')`,
      doc(open1, "open1", "normal", null),
      doc(open2, "open2", "normal", null),
      // a private document granted to Engineer only
      doc(priv, "priv", "private", { allow: { roles: { read: ["Engineer"] } } }),
      `INSERT INTO knowledge_documents (id, org_id, library_id, name, file_key, source_document_id) VALUES ('${mirror}', '${orgId}', '${klib}', 'priv mirror', 'orgs/${orgId}/k/${mirror}.pdf', '${priv}')`,
      // lineage: open1 → open2 (both open), open1 → priv, priv → open2
      `INSERT INTO document_supersessions (org_id, superseded_doc_id, replacement_doc_id, reason, created_by) VALUES ('${orgId}', '${open1}', '${open2}', 'split', '${m.docctrl.uid}')`,
      `INSERT INTO document_supersessions (org_id, superseded_doc_id, replacement_doc_id, reason, created_by) VALUES ('${orgId}', '${open1}', '${priv}', 'split', '${m.docctrl.uid}')`,
      `INSERT INTO document_supersessions (org_id, superseded_doc_id, replacement_doc_id, reason, created_by) VALUES ('${orgId}', '${priv}', '${open2}', 'merge', '${m.docctrl.uid}')`,
      // curated links: open↔open, open→priv, a url on open, a url on priv
      `INSERT INTO document_related_resources (org_id, document_id, kind, target_document_id, label) VALUES ('${orgId}', '${open1}', 'document', '${open2}', 'see also')`,
      `INSERT INTO document_related_resources (org_id, document_id, kind, target_document_id, label) VALUES ('${orgId}', '${open1}', 'document', '${priv}', 'debottleneck')`,
      `INSERT INTO document_related_resources (org_id, document_id, kind, url, label) VALUES ('${orgId}', '${open1}', 'url', 'https://example.test/a', 'vendor')`,
      `INSERT INTO document_related_resources (org_id, document_id, kind, url, label) VALUES ('${orgId}', '${priv}', 'url', 'https://example.test/b', 'vendor')`,
      // mentions: on open1, on priv, and through priv's mirror
      `INSERT INTO entity_mentions (org_id, asset_id, document_id, page, context_snippet, matched_text) VALUES ('${orgId}', '${asset}', '${open1}', 1, 'E-204 on open1', 'E-204')`,
      `INSERT INTO entity_mentions (org_id, asset_id, document_id, page, context_snippet, matched_text) VALUES ('${orgId}', '${asset}', '${priv}', 1, 'E-204 on priv', 'E-204')`,
      `INSERT INTO entity_mentions (org_id, asset_id, knowledge_document_id, page, context_snippet, matched_text) VALUES ('${orgId}', '${asset}', '${mirror}', 2, 'E-204 in the mirror', 'E-204')`,
    ].join(";\n") + ";");
    // "before": the same rows, without the one policy 20261261 creates
    admin("postgres", `CREATE DATABASE ${before} TEMPLATE ${REPLAY_DB}`);
    admin(before, "DROP POLICY document_supersessions_documents_readable ON document_supersessions");
  });
  afterAll(() => {
    for (const d of [before, afterW, beforeW, pasteCp, pasteOwn]) {
      try { admin("postgres", `DROP DATABASE IF EXISTS ${d}`); } catch { /* deleted with the cluster */ }
    }
  });

  it("20261261 replays as one paste, and the policy it creates is the only difference from the 'before' copy", () => {
    const f = mosDb().report!.files.find((x) => x.file === FILE);
    expect(f?.ok, f?.error ?? "").toBe(true);
    const pol = "SELECT count(*) FROM pg_policies WHERE tablename = 'document_supersessions' AND policyname = 'document_supersessions_documents_readable'";
    expect(admin(db, pol)).toBe("1");
    expect(admin(before, pol)).toBe("0");
    expect(admin(mosDb().report!.checkpoints["20261261"], pol)).toBe("0");
  });

  it("document_supersessions: a reader without access to one document loses exactly the rows naming it; readers with access, the service role and other workspaces read what they read today", () => {
    // before (today): member-wide
    for (const k of ["engineer", "viewer", "docctrl"]) expect(count(before, m[k].caller, "document_supersessions"), `before ${k}`).toBe("3");
    // after: the Viewer keeps only the open → open row
    expect(count(db, m.viewer.caller, "document_supersessions")).toBe("1");
    expect(selectAs(db, m.viewer.caller, `SELECT superseded_doc_id || '>' || replacement_doc_id FROM document_supersessions WHERE org_id = '${orgId}'`))
      .toEqual([`${open1}>${open2}`]);
    // readers with access: unchanged
    for (const k of ["engineer", "docctrl"]) expect(count(db, m[k].caller, "document_supersessions"), `after ${k}`).toBe("3");
    // the service role (every server route that reads with it): unchanged
    expect(count(before, service, "document_supersessions")).toBe("3");
    expect(count(db, service, "document_supersessions")).toBe("3");
    // another workspace: nothing, before or after
    expect(count(before, outsider.caller, "document_supersessions")).toBe("0");
    expect(count(db, outsider.caller, "document_supersessions")).toBe("0");
  });

  it("entity_mentions (20261120) and document_related_resources (20261126): every document column is railed, and 20261261 changes no reader's rows", () => {
    for (const on of [before, db]) {
      // mentions: open1's only for the Viewer (priv's own and its mirror's are hidden)
      expect(count(on, m.viewer.caller, "entity_mentions"), on).toBe("1");
      for (const k of ["engineer", "docctrl"]) expect(count(on, m[k].caller, "entity_mentions"), `${on} ${k}`).toBe("3");
      expect(count(on, service, "entity_mentions"), on).toBe("3");
      expect(count(on, outsider.caller, "entity_mentions"), on).toBe("0");
      // curated links: open↔open and open's url for the Viewer; a link TO priv and a url ON priv hidden
      expect(count(on, m.viewer.caller, "document_related_resources"), on).toBe("2");
      for (const k of ["engineer", "docctrl"]) expect(count(on, m[k].caller, "document_related_resources"), `${on} ${k}`).toBe("4");
      expect(count(on, service, "document_related_resources"), on).toBe("4");
      expect(count(on, outsider.caller, "document_related_resources"), on).toBe("0");
    }
    expect(selectAs(db, m.viewer.caller, `SELECT kind || ':' || COALESCE(target_document_id::text, url) FROM document_related_resources WHERE org_id = '${orgId}' ORDER BY kind`))
      .toEqual([`document:${open2}`, "url:https://example.test/a"]);
  });

  it("anon reads none of the three tables, before or after", () => {
    for (const on of [before, db]) {
      for (const t of ["document_supersessions", "entity_mentions", "document_related_resources"]) {
        const r = asCaller(on, anon, `SELECT 1 FROM ${t} WHERE org_id = '${orgId}'`);
        if (r.ok) expect(r.rows, `${on} ${t}`).toBe(0);
        else expect(r.code, `${on} ${t}`).toBe("42501");
      }
    }
  });

  it("the lineage writers' statements answer the same before and after: a controller's read-back, upsert on the pair, delete; a non-controller's delete refused (0 rows)", () => {
    admin("postgres", `CREATE DATABASE ${afterW} TEMPLATE ${REPLAY_DB}`);
    admin("postgres", `CREATE DATABASE ${beforeW} TEMPLATE ${before}`);
    for (const on of [beforeW, afterW]) {
      // writeSupersessionLineage / markSupersededAndLink read-back: .eq(superseded).in(replacements)
      expect(selectAs(on, m.docctrl.caller, `SELECT count(*) FROM document_supersessions WHERE superseded_doc_id = '${open1}' AND replacement_doc_id IN ('${open2}', '${priv}')`)[0], on).toBe("2");
      expect(selectAs(on, m.engineer.caller, `SELECT count(*) FROM document_supersessions WHERE superseded_doc_id = '${open1}' AND replacement_doc_id IN ('${open2}', '${priv}')`)[0], on).toBe("2");
      // the upsert on the pair (ON CONFLICT DO NOTHING): an existing pair writes nothing, a new one is written
      expect(asCaller(on, m.docctrl.caller,
        `INSERT INTO document_supersessions (org_id, superseded_doc_id, replacement_doc_id, reason, created_by) VALUES ('${orgId}', '${open1}', '${open2}', 'again', '${m.docctrl.uid}') ON CONFLICT (superseded_doc_id, replacement_doc_id) DO NOTHING`), on)
        .toEqual({ ok: true, rows: 0 });
      expect(asCaller(on, m.docctrl.caller,
        `INSERT INTO document_supersessions (org_id, superseded_doc_id, replacement_doc_id, reason, created_by) VALUES ('${orgId}', '${open2}', '${priv}', 'new', '${m.docctrl.uid}') ON CONFLICT (superseded_doc_id, replacement_doc_id) DO NOTHING`), on)
        .toEqual({ ok: true, rows: 1 });
      // a non-controller's delete (deleteLineage / a compensation) removes nothing (20261131: controller-only)
      expect(asCaller(on, m.viewer.caller, `DELETE FROM document_supersessions WHERE superseded_doc_id = '${open1}'`), on).toEqual({ ok: true, rows: 0 });
      expect(asCaller(on, m.engineer.caller, `DELETE FROM document_supersessions WHERE superseded_doc_id = '${open1}'`), on).toEqual({ ok: true, rows: 0 });
      // the reversal's delete (Document Control only): both of the operation's rows, the private one included
      expect(asCaller(on, m.docctrl.caller, `DELETE FROM document_supersessions WHERE superseded_doc_id IN ('${open1}') AND replacement_doc_id IN ('${open2}', '${priv}')`), on)
        .toEqual({ ok: true, rows: 2 });
      expect(admin(on, `SELECT count(*) FROM document_supersessions WHERE org_id = '${orgId}'`), on).toBe("2");
    }
  });

  it("the paste on the snapshot taken just before it: clean, every probe true", () => {
    admin("postgres", `CREATE DATABASE ${pasteCp} TEMPLATE ${mosDb().report!.checkpoints["20261261"]}`);
    const r = runPsql(mosDb().conn!, pasteCp, "postgres", { sql: sql() });
    expect(r.error).toBeNull();
    const rows = r.stdout.split("\n").filter((l) => l.includes("|"));
    const probes = rows.filter((l) => /\|[tf]\|$/.test(l));
    expect(probes.length).toBe(6);
    for (const p of probes) expect(p, p).toMatch(/\|t\|$/);
    expect(rows.filter((l) => /^inventory \(before\): .*\|\|\d+$/.test(l)).length).toBe(7);
  });

  it("the inventory counts exactly the rows each rail hides from someone (this workspace alone, plus one legacy cross-workspace lineage row), and a re-paste is clean", () => {
    admin("postgres", `CREATE DATABASE ${pasteOwn} TEMPLATE ${before}`);
    // a legacy lineage row (20261131's DRLS-13 inventory keeps them) whose replacement sits in ANOTHER workspace
    const otherLib = randomUUID(), foreign = randomUUID();
    admin(pasteOwn, [
      "SET session_replication_role = replica",
      `DELETE FROM document_supersessions WHERE org_id <> '${orgId}'`,
      `DELETE FROM document_related_resources WHERE org_id <> '${orgId}'`,
      `DELETE FROM entity_mentions WHERE org_id <> '${orgId}'`,
      `DELETE FROM org_members WHERE org_id NOT IN ('${orgId}', '${otherOrg}')`,
      `INSERT INTO libraries (id, org_id, name, type) VALUES ('${otherLib}', '${otherOrg}', 'I34 other', 'documents')`,
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility) VALUES ('${foreign}', '${otherOrg}', '${otherLib}', 'foreign.pdf', 'foreign', 'I34-${foreign.slice(0, 8)}', '0', 'Draft', 'normal')`,
      `INSERT INTO document_supersessions (org_id, superseded_doc_id, replacement_doc_id, reason, created_by) VALUES ('${orgId}', '${open2}', '${foreign}', 'legacy', '${m.docctrl.uid}')`,
    ].join(";\n") + ";");
    // before the paste the row's own controller reads it (member-wide read)
    expect(count(pasteOwn, m.docctrl.caller, "document_supersessions")).toBe("4");
    const r = runPsql(mosDb().conn!, pasteOwn, "postgres", { sql: sql() });
    expect(r.error).toBeNull();
    const inv = new Map(r.stdout.split("\n").filter((l) => l.startsWith("inventory (before): "))
      .map((l) => { const parts = l.split("|"); return [parts[0].replace("inventory (before): ", ""), parts[2]] as const; }));
    const pick = (prefix: string) => [...inv.entries()].find(([k]) => k.startsWith(prefix))?.[1];
    expect(pick("document_supersessions rows")).toBe("4");
    expect(pick("document_supersessions rows naming a private / hidden document")).toBe("2");
    expect(pick("document_supersessions rows naming a normal document with a read deny")).toBe("0");
    expect(pick("document_supersessions rows whose documents are not both in the row's workspace")).toBe("1");
    expect(pick("document_related_resources rows naming a private / hidden document")).toBe("2");
    expect(pick("entity_mentions rows on a private / hidden document")).toBe("2");
    // engineer and viewer here; docctrl (DocCtrl held additively) and the other workspace's Admin are controllers
    expect(pick("active members outside the controller tier")).toBe("2");
    // the policy is in place and the Viewer now reads one lineage row
    expect(count(pasteOwn, m.viewer.caller, "document_supersessions")).toBe("1");
    // the residue the inventory names (document control, DRLS-13): the cross-workspace row is hidden from the
    // row's own controller too, and a controller's DELETE of it skips it with no error (0 rows), so a
    // reversal's read-back would report none left — recorded at DACL-11, not fixed here
    expect(count(pasteOwn, m.docctrl.caller, "document_supersessions")).toBe("3");
    expect(asCaller(pasteOwn, m.docctrl.caller, `DELETE FROM document_supersessions WHERE replacement_doc_id = '${foreign}'`)).toEqual({ ok: true, rows: 0 });
    expect(admin(pasteOwn, `SELECT count(*) FROM document_supersessions WHERE replacement_doc_id = '${foreign}'`)).toBe("1");
    const again = runPsql(mosDb().conn!, pasteOwn, "postgres", { sql: sql() });
    expect(again.error).toBeNull();
    for (const p of again.stdout.split("\n").filter((l) => /\|[tf]\|$/.test(l))) expect(p, p).toMatch(/\|t\|$/);
  });
});
