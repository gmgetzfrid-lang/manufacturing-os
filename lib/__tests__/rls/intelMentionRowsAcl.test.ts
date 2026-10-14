// intelligence IRLS-9 done-when 3 (and IEDGE-6, KACL-7): a member without access to a
// MIRRORED controlled document gets zero mention rows for it — asserted at
// RUNTIME on the replayed database, each read sent as PostgREST sends a
// signed-in person's request (role `authenticated`, the JWT's claims).
//
// The policy under test is 20261120's RESTRICTIVE entity_mentions_source_readable
// (the controlled document's row AND the mirror's row must be readable under the
// caller's own RLS) beside 20260929's membership read; the documents row is
// judged by node_visible (documents_acl_select). Before this harness the
// policy was pinned only by shape (lib/__tests__/knowledgeMemoryAcl.test.ts)
// and a manual scratch run.
//
// A NORMAL document whose index denies the member's role read is the case
// 20261212's deny binding would close at the database. That binding is held
// back by default (DEC-90: its operator switch stays off; it lands with
// intelligence I-30), so on the replayed database the row still reaches the
// member — the PostgREST gap DACL-12 c1 describes, pinned here as open — and
// only a scratch copy pasted with the switch on shows the binding close it.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, mosDb, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;

describe.skipIf(skip !== null)("IRLS-9 / IEDGE-6: mention rows follow the mirrored document's access, at runtime", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let outsider: SeededMember;
  const asset = randomUUID();
  const docs: Record<string, string> = {};
  const bound = `mos_i12_mentions_${process.pid}`;

  const mentionsOf = (who: SeededMember, docId: string, on = db) =>
    selectAs(on, who.caller, `SELECT count(*) FROM entity_mentions WHERE document_id = '${docId}'`)[0];
  const mirrorsOf = (who: SeededMember, docId: string, on = db) =>
    selectAs(on, who.caller, `SELECT count(*) FROM knowledge_documents WHERE source_document_id = '${docId}'`)[0];

  beforeAll(() => {
    const s = seedOrg(db, { engineer: { role: "Engineer" }, viewer: { role: "Viewer" }, docctrl: { role: "Viewer", roles: ["DocCtrl"] } });
    orgId = s.orgId;
    m = s.m;
    outsider = seedOrg(db, { admin: { role: "Admin" } }).m.admin;
    const lib = randomUUID(), klib = randomUUID();
    const stmts = [
      `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'Mentions', 'documents')`,
      `INSERT INTO knowledge_libraries (id, org_id, name) VALUES ('${klib}', '${orgId}', 'Mentions KB')`,
      `INSERT INTO assets (id, org_id, tag, tag_normalized, created_by) VALUES ('${asset}', '${orgId}', 'E-101', 'e-101', '${m.engineer.uid}')`,
    ];
    // a private document granted to Engineer only; a normal document whose
    // index denies Viewer read (and upload — not a drop box); an open normal
    // document — each mirrored, each with one mention of E-101
    const shapes: Record<string, { vis: string; index: object | null }> = {
      privateEngineer: { vis: "private", index: { allow: { roles: { read: ["Engineer"] } } } },
      normalDenyViewer: { vis: "normal", index: { deny: { roles: { read: ["Viewer"], upload: ["Viewer"] } } } },
      open: { vis: "normal", index: null },
    };
    for (const [k, sh] of Object.entries(shapes)) {
      const d = randomUUID(), kd = randomUUID();
      docs[k] = d;
      stmts.push(
        `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility, acl_index) VALUES ('${d}', '${orgId}', '${lib}', '${k}.pdf', '${k}', 'M-${d.slice(0, 8)}', '0', 'Draft', '${sh.vis}', ${sh.index ? `'${JSON.stringify(sh.index)}'::jsonb` : "NULL"})`,
        `INSERT INTO knowledge_documents (id, org_id, library_id, name, file_key, source_document_id) VALUES ('${kd}', '${orgId}', '${klib}', '${k}', 'orgs/${orgId}/k/${kd}.pdf', '${d}')`,
        `INSERT INTO entity_mentions (org_id, asset_id, knowledge_document_id, document_id, page, context_snippet, matched_text) VALUES ('${orgId}', '${asset}', '${kd}', '${d}', 1, 'Pump E-101 discharge line (${k})', 'E-101')`,
      );
    }
    admin(db, stmts.join(";\n") + ";");
  });
  afterAll(() => {
    try { admin("postgres", `DROP DATABASE IF EXISTS ${bound}`); } catch { /* deleted with the cluster */ }
  });

  it("a member without access to the mirrored document gets zero mention rows for it; a member with access, and a controller, get its row", () => {
    // private, granted to Engineer only
    expect(mentionsOf(m.viewer, docs.privateEngineer)).toBe("0");
    expect(mentionsOf(m.engineer, docs.privateEngineer)).toBe("1");
    expect(mentionsOf(m.docctrl, docs.privateEngineer)).toBe("1");
    // the open document: every member
    for (const k of ["viewer", "engineer", "docctrl"]) expect(mentionsOf(m[k], docs.open), k).toBe("1");
    // another workspace's member: nothing, open or not
    expect(mentionsOf(outsider, docs.open)).toBe("0");
    expect(mentionsOf(outsider, docs.privateEngineer)).toBe("0");
  });

  it("the mirror row itself (knowledge_documents, 20261120's knowledge_documents_select) follows the same access (intelligence KACL-7)", () => {
    expect(mirrorsOf(m.viewer, docs.privateEngineer)).toBe("0");
    expect(mirrorsOf(m.viewer, docs.open)).toBe("1");
    for (const k of ["engineer", "docctrl"]) expect(mirrorsOf(m[k], docs.privateEngineer), k).toBe("1");
    expect(mirrorsOf(outsider, docs.privateEngineer)).toBe("0");
  });

  it("OPEN (owner intelligence I-30): a normal document whose index denies the member's role read still reaches that member at the database — 20261212 holds the deny binding back by default, and the replayed install does not set its switch", () => {
    expect(admin(db, "SELECT prosrc LIKE '%IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (%' FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6")).toBe("f");
    expect(mentionsOf(m.viewer, docs.normalDenyViewer)).toBe("1");
    expect(mirrorsOf(m.viewer, docs.normalDenyViewer)).toBe("1");
  });

  it("with the binding applied (a scratch copy pasted with 20261212's switch on — never the paste guide's instruction): the member the deny names gets zero mention rows and no mirror row; others keep them", () => {
    admin("postgres", `CREATE DATABASE ${bound} TEMPLATE ${REPLAY_DB}`);
    // only this suite's workspace, so no other suite's rows trip the drop-box precondition
    admin(bound, `SET session_replication_role = replica; DELETE FROM documents WHERE org_id <> '${orgId}'; DELETE FROM collections WHERE org_id <> '${orgId}'; DELETE FROM libraries WHERE org_id <> '${orgId}';`);
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261212_intel_roundG_node_visible_deny.sql"), "utf8")
      .replace("-- SET LOCAL app.i12_deny_binding = 'on';", "SET LOCAL app.i12_deny_binding = 'on';");
    const r = runPsql(mosDb().conn!, bound, "postgres", { sql });
    expect(r.error).toBeNull();
    expect(admin(bound, "SELECT prosrc LIKE '%IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (%' FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6")).toBe("t");
    expect(mentionsOf(m.viewer, docs.normalDenyViewer, bound)).toBe("0");
    expect(mirrorsOf(m.viewer, docs.normalDenyViewer, bound)).toBe("0");
    for (const k of ["engineer", "docctrl"]) {
      expect(mentionsOf(m[k], docs.normalDenyViewer, bound), k).toBe("1");
      expect(mirrorsOf(m[k], docs.normalDenyViewer, bound), k).toBe("1");
    }
  });

  it("the sentence itself is withheld with the row (no context_snippet of a document the reader cannot open)", () => {
    const rows = selectAs(db, m.viewer.caller, `SELECT context_snippet FROM entity_mentions WHERE asset_id = '${asset}' ORDER BY context_snippet`);
    // the private document's sentence never; the normal-deny one still reaches the member until I-30 (above)
    expect(rows).toEqual(["Pump E-101 discharge line (normalDenyViewer)", "Pump E-101 discharge line (open)"]);
  });
});
