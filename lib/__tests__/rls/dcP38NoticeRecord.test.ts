// document-control Round G — P38 DOCUMENT NOTICE RECORD (DIST-19): 20261257
// at RUNTIME on the replayed database (the I-17 harness; `npm run test:db`).
//
// P38 fix pass (the review's blocker): the scans keep a notice-record row
// they could not write in a DOCUMENT_NOTICE_RECORD_DEFERRED audit row and the
// next run replays it, through the service role, into the append-only
// document_notice_events. A signed-in member could insert such an audit row
// under audit_logs_insert (any action, their own uid) and plant a permanent
// false notice. The replay now reads only user_id IS NULL rows; 20261257
// also refuses a member the action outright (audit_logs_notice_deferred_
// server_only, RESTRICTIVE FOR INSERT TO anon, authenticated — the GOV-14
// shape of 20261163). Asserted here, each statement sent as PostgREST sends
// that caller's request:
//   · REGRESSION FIRST: a member's ordinary audit row still lands; the
//     service role's (system) deferred row still lands;
//   · a member's deferred row is refused 42501 (and was admitted before the
//     paste — reproduced on a copy with the policy dropped);
//   · the record itself: the service role writes, a member cannot, a member
//     reads the rows of a document they can read, an UPDATE is refused;
//   · a re-paste is clean (every probe true);
//   · merge-time fix pass — the record's READ rules at runtime: a notice row
//     on an ACL-restricted document is hidden from a member the ACL denies
//     (and shown to one it grants, and to a controller); another workspace's
//     member reads 0; a not_emailed row is read by its own person and by no
//     other member; anon is refused outright (42501 — 20261257 revokes every
//     privilege from anon).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = join(process.cwd(), "supabase", "migrations", "20261257_dc_roundG_document_notice_record.sql");
const svc = { role: "service_role" } as const;

describe.skipIf(skip !== null)("DIST-19 (P38): the deferred notice rows are the server's alone, and the record is append-only, at runtime", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const lib = randomUUID();
  const doc = randomUUID();
  const copies: string[] = [];
  const copy = (tag: string) => {
    const name = `mos_p38_${tag}_${process.pid}`;
    admin("postgres", `CREATE DATABASE ${name} TEMPLATE ${REPLAY_DB}`);
    copies.push(name);
    return name;
  };
  const deferredBy = (who: SeededMember) =>
    `INSERT INTO audit_logs (org_id, action, resource_type, resource_id, user_id, user_email, details) VALUES ('${orgId}', 'DOCUMENT_NOTICE_RECORD_DEFERRED', 'document', '${doc}', '${who.uid}', '${who.email}', jsonb_build_object('source', 'distribution_ack', 'rows', jsonb_build_array(jsonb_build_object('id', '${randomUUID()}', 'org_id', '${orgId}', 'document_id', '${doc}', 'kind', 'reminded', 'recipient', '${who.uid}', 'source', 'distribution_ack', 'noticed_at', '2099-01-01T00:00:00Z'))))`;
  const notice = (id: string) =>
    `INSERT INTO document_notice_events (id, org_id, document_id, source, kind, recipient, subject_user_id, actor_name) VALUES ('${id}', '${orgId}', '${doc}', 'review_signoff', 'reminded', '${m.viewer.uid}', '${m.viewer.uid}', 'System')`;

  beforeAll(() => {
    const s = seedOrg(db, { viewer: { role: "Viewer" }, recipient: { role: "Engineer-1" }, docctrl: { role: "Viewer", roles: ["DocCtrl"] } });
    orgId = s.orgId;
    m = s.m;
    admin(db, [
      `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'Drawings', 'documents')`,
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${doc}', '${orgId}', '${lib}', 'p.pdf', 'P', 'P-${doc.slice(0, 8)}', '0', 'Draft')`,
    ].join(";\n") + ";");
  });
  afterAll(() => {
    for (const c of copies) { try { admin("postgres", `DROP DATABASE IF EXISTS ${c}`); } catch { /* deleted with the cluster */ } }
  });

  it("REGRESSION: a member's ordinary audit row still lands; the service role's system deferred row still lands", () => {
    expect(asCaller(db, m.viewer.caller, `INSERT INTO audit_logs (org_id, action, resource_type, resource_id, user_id, user_email) VALUES ('${orgId}', 'VIEW', 'document', '${doc}', '${m.viewer.uid}', '${m.viewer.email}')`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, svc, `INSERT INTO audit_logs (org_id, action, resource_type, resource_id, user_id, user_role, details) VALUES ('${orgId}', 'DOCUMENT_NOTICE_RECORD_DEFERRED', 'document', '${doc}', NULL, 'system', '{"source":"review_signoff","rows":[]}'::jsonb)`)).toEqual({ ok: true, rows: 1 });
  });

  it("a signed-in member (a Viewer, the recipient, a controller) may not write a DOCUMENT_NOTICE_RECORD_DEFERRED row; anon neither", () => {
    for (const who of [m.viewer, m.recipient, m.docctrl]) {
      const r = asCaller(db, who.caller, deferredBy(who));
      expect(r.ok, who.email).toBe(false);
      if (!r.ok) expect(r.code).toBe("42501");
    }
    const anon = asCaller(db, { role: "anon" }, deferredBy(m.viewer));
    expect(anon.ok).toBe(false);
    expect(admin(db, `SELECT count(*) FROM audit_logs WHERE org_id = '${orgId}' AND action = 'DOCUMENT_NOTICE_RECORD_DEFERRED' AND user_id IS NOT NULL`)).toBe("0");
  });

  it("reproduced: without the policy (dropped on a copy) the member's forged deferred row was admitted", () => {
    const before = copy("before");
    admin(before, "DROP POLICY audit_logs_notice_deferred_server_only ON audit_logs;");
    expect(asCaller(before, m.recipient.caller, deferredBy(m.recipient))).toEqual({ ok: true, rows: 1 });
  });

  it("the record: the service role writes (a replay of the same id writes nothing), a member cannot, a member reads the document's rows, an UPDATE is refused", () => {
    const id = randomUUID();
    expect(asCaller(db, svc, notice(id))).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, svc, `${notice(id)} ON CONFLICT (id) DO NOTHING`)).toEqual({ ok: true, rows: 0 });
    const ins = asCaller(db, m.docctrl.caller, notice(randomUUID()));
    expect(ins.ok).toBe(false);
    if (!ins.ok) expect(ins.code).toBe("42501");
    expect(selectAs(db, m.viewer.caller, `SELECT count(*) FROM document_notice_events WHERE id = '${id}'`)).toEqual(["1"]);
    const upd = asCaller(db, svc, `UPDATE document_notice_events SET noticed_at = '2099-01-01' WHERE id = '${id}'`);
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.code).toBe("23514");
  });

  describe("merge-time fix pass: the record's read rules, at runtime", () => {
    const aclLib = randomUUID();
    const restricted = randomUUID();
    const open = randomUUID();
    const rows = { restricted: randomUUID(), open: randomUUID(), notEmailed: randomUUID() };
    let r: Record<string, SeededMember> = {};
    let outsider: SeededMember;
    const count = (who: SeededMember, id: string) =>
      selectAs(db, who.caller, `SELECT count(*) FROM document_notice_events WHERE id = '${id}'`)[0];

    beforeAll(() => {
      const s2 = seedOrg(db, { viewer: { role: "Viewer" }, engineer: { role: "Engineer" }, docctrl: { role: "Viewer", roles: ["DocCtrl"] }, recipient: { role: "Viewer" } });
      r = s2.m;
      outsider = seedOrg(db, { admin: { role: "Admin" } }).m.admin;
      const o = s2.orgId;
      const ev = (id: string, d: string, kind: string, recipient: string, details = "{}") =>
        `INSERT INTO document_notice_events (id, org_id, document_id, source, kind, recipient, subject_user_id, actor_name, details) VALUES ('${id}', '${o}', '${d}', 'acknowledgment', '${kind}', '${recipient}', '${recipient}', 'System', '${details}'::jsonb)`;
      admin(db, [
        `INSERT INTO libraries (id, org_id, name, type) VALUES ('${aclLib}', '${o}', 'Restricted', 'documents')`,
        // private, read granted to the Engineer role only (the documents ACL — node_visible)
        `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility, acl_index) VALUES ('${restricted}', '${o}', '${aclLib}', 'r.pdf', 'R', 'R-${restricted.slice(0, 8)}', '0', 'Draft', 'private', '{"allow":{"roles":{"read":["Engineer"]}}}'::jsonb)`,
        `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${open}', '${o}', '${aclLib}', 'o.pdf', 'O', 'O-${open.slice(0, 8)}', '0', 'Draft')`,
        ev(rows.restricted, restricted, "reminded", r.engineer.uid),
        ev(rows.open, open, "reminded", r.viewer.uid),
        ev(rows.notEmailed, open, "not_emailed", r.recipient.uid, '{"reason":"prefers the weekly digest"}'),
      ].join(";\n") + ";");
    });

    it("the documents themselves read as expected (the precondition): the restricted one by the Engineer and the controller only", () => {
      const docCount = (who: SeededMember) => selectAs(db, who.caller, `SELECT count(*) FROM documents WHERE id = '${restricted}'`)[0];
      expect(docCount(r.viewer)).toBe("0");
      expect(docCount(r.engineer)).toBe("1");
      expect(docCount(r.docctrl)).toBe("1");
    });

    it("an ACL-restricted document's notice row is hidden from a member the ACL denies; shown to one it grants and to a controller", () => {
      expect(count(r.viewer, rows.restricted)).toBe("0");
      expect(count(r.recipient, rows.restricted)).toBe("0");
      expect(count(r.engineer, rows.restricted)).toBe("1");
      expect(count(r.docctrl, rows.restricted)).toBe("1");
      // the open document's row: every member of the workspace
      for (const k of ["viewer", "engineer", "docctrl", "recipient"]) expect(count(r[k], rows.open), k).toBe("1");
    });

    it("another workspace's member reads 0 rows, open document or not", () => {
      for (const id of Object.values(rows)) expect(count(outsider, id)).toBe("0");
      expect(selectAs(db, outsider.caller, `SELECT count(*) FROM document_notice_events WHERE org_id <> (SELECT org_id FROM org_members WHERE uid = '${outsider.uid}')`)).toEqual(["0"]);
    });

    it("a not_emailed row is read by its own person (with its reason) and by no other member, a controller included", () => {
      expect(selectAs(db, r.recipient.caller, `SELECT details->>'reason' FROM document_notice_events WHERE id = '${rows.notEmailed}'`)).toEqual(["prefers the weekly digest"]);
      for (const k of ["viewer", "engineer", "docctrl"]) expect(count(r[k], rows.notEmailed), k).toBe("0");
    });

    it("RESIDUAL, pinned as it is: a system DOCUMENT_NOTICE_RECORD_DEFERRED row about the restricted document is read by a member the ACL denies (audit_logs_org_access) — why the recorder keeps only ids, kind and numbers in it", () => {
      const o = admin(db, `SELECT org_id FROM documents WHERE id = '${restricted}'`);
      const audit = randomUUID();
      admin(db, `INSERT INTO audit_logs (id, org_id, action, resource_type, resource_id, user_id, user_role, details) VALUES ('${audit}', '${o}', 'DOCUMENT_NOTICE_RECORD_DEFERRED', 'document', '${restricted}', NULL, 'system', jsonb_build_object('source', 'acknowledgment', 'rows', jsonb_build_array(jsonb_build_object('id', '${randomUUID()}', 'document_id', '${restricted}', 'kind', 'reminded', 'recipient', '${r.engineer.uid}'))));`);
      expect(count(r.viewer, rows.restricted)).toBe("0");                                     // the record: hidden
      expect(selectAs(db, r.viewer.caller, `SELECT count(*) FROM audit_logs WHERE id = '${audit}'`)).toEqual(["1"]);   // the deferred row: not
      expect(selectAs(db, outsider.caller, `SELECT count(*) FROM audit_logs WHERE id = '${audit}'`)).toEqual(["0"]);
    });

    it("anon is refused outright: 42501 (every privilege revoked from anon), not merely 0 rows", () => {
      const anon = asCaller(db, { role: "anon" }, `SELECT 1 FROM document_notice_events`);
      expect(anon.ok).toBe(false);
      if (!anon.ok) expect(anon.code).toBe("42501");
    });
  });

  it("a re-paste on the applied database is clean: every probe true", () => {
    const again = copy("again");
    const r = runPsql(mosDb().conn!, again, "postgres", { sql: readFileSync(FILE, "utf8") });
    expect(r.error).toBeNull();
    const probes = r.stdout.split("\n").filter((l) => l.split("|").length === 3 && l.split("|")[2] === "");
    expect(probes).toHaveLength(8);
    for (const p of probes) expect(p.split("|")[1], p).toBe("t");
  });
});
