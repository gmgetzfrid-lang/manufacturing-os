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

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { admin, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";

const skip = skipReason();
const db = REPLAY_DB;

describe.skipIf(skip !== null)("IRLS-9 / IEDGE-6: mention rows follow the mirrored document's access, at runtime", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let outsider: SeededMember;
  const asset = randomUUID();
  const docs: Record<string, string> = {};

  const mentionsOf = (who: SeededMember, docId: string) =>
    selectAs(db, who.caller, `SELECT count(*) FROM entity_mentions WHERE document_id = '${docId}'`)[0];

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
    // index denies Viewer read; an open normal document — each mirrored, each
    // with one mention of E-101
    const shapes: Record<string, { vis: string; index: object | null }> = {
      privateEngineer: { vis: "private", index: { allow: { roles: { read: ["Engineer"] } } } },
      normalDenyViewer: { vis: "normal", index: { deny: { roles: { read: ["Viewer"] } } } },
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

  it("a normal document whose index denies the member's role read: zero mention rows once 20261212's binding applied (the replayed fresh install has no drop box, so it applied); others keep the row", () => {
    expect(admin(db, "SELECT prosrc LIKE '%IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (%' FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6")).toBe("t");
    expect(mentionsOf(m.viewer, docs.normalDenyViewer)).toBe("0");
    expect(mentionsOf(m.engineer, docs.normalDenyViewer)).toBe("1");
    expect(mentionsOf(m.docctrl, docs.normalDenyViewer)).toBe("1");
  });

  it("the mirror row itself (knowledge_documents, 20261120's knowledge_documents_select) follows the same access (intelligence KACL-7)", () => {
    const mirrorsOf = (who: SeededMember, docId: string) =>
      selectAs(db, who.caller, `SELECT count(*) FROM knowledge_documents WHERE source_document_id = '${docId}'`)[0];
    expect(mirrorsOf(m.viewer, docs.privateEngineer)).toBe("0");
    expect(mirrorsOf(m.viewer, docs.normalDenyViewer)).toBe("0");
    expect(mirrorsOf(m.viewer, docs.open)).toBe("1");
    for (const k of ["engineer", "docctrl"]) {
      expect(mirrorsOf(m[k], docs.privateEngineer), k).toBe("1");
      expect(mirrorsOf(m[k], docs.normalDenyViewer), k).toBe("1");
    }
  });

  it("the sentence itself is withheld with the row (no context_snippet of a document the reader cannot open)", () => {
    const rows = selectAs(db, m.viewer.caller, `SELECT context_snippet FROM entity_mentions WHERE asset_id = '${asset}' ORDER BY context_snippet`);
    expect(rows).toEqual(["Pump E-101 discharge line (open)"]);
  });
});
