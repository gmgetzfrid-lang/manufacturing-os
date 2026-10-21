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
//   · a re-paste is clean (every probe true).

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

  it("a re-paste on the applied database is clean: every probe true", () => {
    const again = copy("again");
    const r = runPsql(mosDb().conn!, again, "postgres", { sql: readFileSync(FILE, "utf8") });
    expect(r.error).toBeNull();
    const probes = r.stdout.split("\n").filter((l) => l.split("|").length === 3 && l.split("|")[2] === "");
    expect(probes).toHaveLength(8);
    for (const p of probes) expect(p.split("|")[1], p).toBe("t");
  });
});
