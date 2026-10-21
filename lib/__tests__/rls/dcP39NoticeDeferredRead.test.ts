// document-control Round G — P39 NOTICE RECORD REQUESTS (DIST-20, the done-
// when the integrator added at the P38 merge): 20261259 at RUNTIME on the
// replayed database (the I-17 harness; `npm run test:db`).
//
// A DOCUMENT_NOTICE_RECORD_DEFERRED audit row names a document, a person, a
// notice kind and a time. Before 20261259 every member of the workspace read
// it (audit_logs_org_access) — for an ACL-restricted document, what the
// record (document_notice_events_read) would refuse them. 20261259 adds one
// RESTRICTIVE SELECT policy: that action's rows are read only by someone who
// can read the document they name. Asserted here, each statement sent as
// PostgREST sends that caller's request:
//   · THE DEFECT, closed: a Viewer the ACL denies read the deferred row about
//     the restricted document before (reproduced on a copy with the policy
//     dropped) and reads nothing after; the Engineer the ACL grants, a
//     Document Controller and an Admin read it; another workspace reads 0;
//     a row whose document is gone, or that names no document, is read by no
//     signed-in member; the open document's row reads to every member;
//   · REGRESSION FIRST: every OTHER action reads, for every reader (Viewer,
//     Engineer, Document Controller, Admin, Auditor, another workspace),
//     exactly the rows it read on the copy without the policy — the audit
//     trail overlay (admin.audit_view, ALOG-16's node rows, the org-level
//     trail) included;
//   · the service role (the scans' replay) still reads every deferred row;
//   · a re-paste is clean: four probes true, four inventory counts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = join(process.cwd(), "supabase", "migrations", "20261259_dc_roundG_notice_deferred_read.sql");
const svc = { role: "service_role" } as const;

describe.skipIf(skip !== null)("DIST-20 (P39): a deferred notice row reads as the record reads; every other audit row as before, at runtime", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let outsider: SeededMember;
  const lib = randomUUID();
  const restricted = randomUUID();
  const open = randomUUID();
  const gone = randomUUID();
  const deferred: Record<string, string> = {};
  const others: Record<string, string> = {};
  const copies: string[] = [];
  const copy = (tag: string) => {
    const name = `mos_p39_${tag}_${process.pid}`;
    admin("postgres", `CREATE DATABASE ${name} TEMPLATE ${REPLAY_DB}`);
    copies.push(name);
    return name;
  };
  const ids = (o: Record<string, string>) => Object.values(o).map((r) => `'${r}'`).join(", ");
  const readOthers = (who: SeededMember, on = db) =>
    selectAs(on, who.caller, `SELECT id::text FROM audit_logs WHERE id IN (${ids(others)}) ORDER BY id`);
  const reads = (who: SeededMember, key: string, on = db) =>
    selectAs(on, who.caller, `SELECT count(*) FROM audit_logs WHERE id = '${deferred[key]}'`)[0] === "1";

  beforeAll(() => {
    const s = seedOrg(db, {
      viewer: { role: "Viewer" },
      engineer: { role: "Engineer" },
      docctrl: { role: "Viewer", roles: ["DocCtrl"] },
      adm: { role: "Admin" },
      auditor: { role: "Auditor" },
    });
    orgId = s.orgId;
    m = s.m;
    outsider = seedOrg(db, { admin: { role: "Admin" } }).m.admin;
    const stmts = [
      `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'Drawings', 'documents')`,
      // private, read granted to the Engineer role only (the documents ACL)
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility, acl_index) VALUES ('${restricted}', '${orgId}', '${lib}', 'r.pdf', 'R', 'R-${restricted.slice(0, 8)}', '0', 'Draft', 'private', '{"allow":{"roles":{"read":["Engineer"]}}}'::jsonb)`,
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${open}', '${orgId}', '${lib}', 'o.pdf', 'O', 'O-${open.slice(0, 8)}', '0', 'Draft')`,
    ];
    const audit = (bucket: Record<string, string>, key: string, action: string, type: string, rid: string, userId: string | null) => {
      const id = randomUUID();
      bucket[key] = id;
      stmts.push(`INSERT INTO audit_logs (id, org_id, action, resource_type, resource_id, user_id, user_role, details) VALUES ('${id}', '${orgId}', '${action}', '${type}', '${rid}', ${userId ? `'${userId}'` : "NULL"}, ${userId ? "NULL" : "'system'"}, '{"source":"acknowledgment","rows":[]}'::jsonb)`);
    };
    // the deferred rows (the system actor, as the recorder writes them)
    audit(deferred, "restricted", "DOCUMENT_NOTICE_RECORD_DEFERRED", "document", restricted, null);
    audit(deferred, "open", "DOCUMENT_NOTICE_RECORD_DEFERRED", "document", open, null);
    audit(deferred, "gone", "DOCUMENT_NOTICE_RECORD_DEFERRED", "document", gone, null);
    audit(deferred, "notUuid", "DOCUMENT_NOTICE_RECORD_DEFERRED", "document", "not-a-document-id", null);
    // every other kind of row an audit viewer shows: about the restricted document, the open one, the org
    audit(others, "view", "VIEW", "document", restricted, m.engineer.uid);
    audit(others, "deadLetter", "NOTIFICATION_DEAD_LETTER", "document", restricted, null);
    audit(others, "alternate", "REVIEW_ALTERNATE_ACTIVATED", "document", restricted, m.docctrl.uid);
    audit(others, "acl", "NODE_ACL_CHANGED", "document", restricted, m.docctrl.uid);
    audit(others, "ackRequested", "ACK_REQUESTED", "document", open, m.docctrl.uid);
    audit(others, "policy", "CAPABILITY_POLICY_CHANGED", "org_configuration", orgId, m.adm.uid);
    audit(others, "member", "MEMBER_ROLE_CHANGED", "member", m.viewer.uid, m.adm.uid);
    audit(others, "goneDoc", "DOCUMENT_DELETED", "document", gone, m.docctrl.uid);
    admin(db, stmts.join(";\n") + ";");
  });
  afterAll(() => {
    for (const c of copies) { try { admin("postgres", `DROP DATABASE IF EXISTS ${c}`); } catch { /* deleted with the cluster */ } }
  });

  it("the documents themselves read as expected (the precondition): the restricted one by the Engineer, the controller and the Admin only", () => {
    const docCount = (who: SeededMember) => selectAs(db, who.caller, `SELECT count(*) FROM documents WHERE id = '${restricted}'`)[0];
    expect(docCount(m.viewer)).toBe("0");
    expect(docCount(m.engineer)).toBe("1");
    expect(docCount(m.docctrl)).toBe("1");
    expect(docCount(m.adm)).toBe("1");
  });

  it("reproduced: without 20261259's policy (dropped on a copy) the Viewer the ACL denies read the deferred row about the restricted document", () => {
    const before = copy("before");
    admin(before, "DROP POLICY audit_logs_notice_deferred_readers ON audit_logs;");
    expect(reads(m.viewer, "restricted", before)).toBe(true);
    expect(reads(m.viewer, "gone", before)).toBe(true);
  });

  it("THE DEFECT, closed: the deferred row about the restricted document reads only to the document's readers (the Engineer, the controller, the Admin); the open one to every member; none to another workspace", () => {
    expect(reads(m.viewer, "restricted")).toBe(false);
    expect(reads(m.engineer, "restricted")).toBe(true);
    expect(reads(m.docctrl, "restricted")).toBe(true);
    expect(reads(m.adm, "restricted")).toBe(true);
    for (const k of ["viewer", "engineer", "docctrl", "adm"]) expect(reads(m[k], "open"), k).toBe(true);
    for (const k of Object.keys(deferred)) expect(reads(outsider, k), k).toBe(false);
  });

  it("a deferred row whose document is gone, or that names no document, is read by no signed-in member; the service role (the replay) still reads every deferred row", () => {
    for (const k of ["viewer", "engineer", "docctrl", "adm", "auditor"]) {
      expect(reads(m[k], "gone"), k).toBe(false);
      expect(reads(m[k], "notUuid"), k).toBe(false);
    }
    expect(selectAs(db, svc, `SELECT count(*) FROM audit_logs WHERE id IN (${ids(deferred)})`)).toEqual(["4"]);
  });

  it("REGRESSION: every other action reads, for every reader, exactly the rows it read without the policy (the audit trail overlay included)", () => {
    const before = copy("others");
    admin(before, "DROP POLICY audit_logs_notice_deferred_readers ON audit_logs;");
    for (const k of ["viewer", "engineer", "docctrl", "adm", "auditor"]) {
      const was = readOthers(m[k], before);
      expect(readOthers(m[k]), k).toEqual(was);
      expect(was.length, `${k} reads some of the other rows`).toBeGreaterThan(0);
    }
    expect(readOthers(outsider)).toEqual(readOthers(outsider, before));
    expect(readOthers(outsider)).toEqual([]);
    // the overlay still does its own work: the org-level trail is the audit viewers' alone
    expect(selectAs(db, m.viewer.caller, `SELECT count(*) FROM audit_logs WHERE id = '${others.policy}'`)).toEqual(["0"]);
    expect(selectAs(db, m.auditor.caller, `SELECT count(*) FROM audit_logs WHERE id = '${others.policy}'`)).toEqual(["1"]);
  });

  it("a member's ordinary audit insert still lands (the policy is SELECT only)", () => {
    expect(asCaller(db, m.viewer.caller, `INSERT INTO audit_logs (org_id, action, resource_type, resource_id, user_id, user_email) VALUES ('${orgId}', 'VIEW', 'document', '${open}', '${m.viewer.uid}', '${m.viewer.email}')`)).toEqual({ ok: true, rows: 1 });
  });

  it("a re-paste on the applied database is clean: four probes true, four inventory counts (rows on file, about a restricted document, about a gone or unnamed one, restrictive SELECT policies)", () => {
    const again = copy("again");
    const r = runPsql(mosDb().conn!, again, "postgres", { sql: readFileSync(FILE, "utf8") });
    expect(r.error).toBeNull();
    const lines = r.stdout.split("\n").filter((l) => l.split("|").length === 3);
    const probes = lines.filter((l) => l.split("|")[2] === "");
    expect(probes).toHaveLength(4);
    for (const p of probes) expect(p.split("|")[1], p).toBe("t");
    const counts = lines.filter((l) => l.split("|")[1] === "");
    expect(counts).toHaveLength(4);
    expect(counts[3].split("|")[2]).toBe("2");                              // a re-run: the overlay and this rule
  });
});
