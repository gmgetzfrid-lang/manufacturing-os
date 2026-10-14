// AREA-1 done-when 3 and CB-2 done-when 3 (intelligence I-17): the equipment
// registry's and the Bridge ledger's row-level security, asserted per role at
// RUNTIME on the replayed database — each statement sent as PostgREST sends a
// signed-in person's request (role `authenticated`, the JWT's claims in
// request.jwt.claims). Before this harness only a static policy census
// (lib/__tests__/intelRoundGRegistry.test.ts) and a manual scratch run existed.
//
// A refusal reads two ways in PostgreSQL, and both are asserted as they are:
// an INSERT a policy refuses raises 42501; an UPDATE or DELETE whose rows a
// policy's USING clause hides touches 0 rows (no error). lib/assets.ts turns
// a 0-row write into a thrown refusal (AREA-1's 2026-09-30 Partial).

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { admin, asCaller, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";

const skip = skipReason();
const db = REPLAY_DB;

describe.skipIf(skip !== null)("AREA-1: the equipment registry's authority, at runtime", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let outsider: SeededMember;

  const newAsset = (tag: string, by: string) =>
    `INSERT INTO assets (org_id, tag, tag_normalized, created_by) VALUES ('${orgId}', '${tag}', lower('${tag}'), '${by}')`;
  const seedAsset = (tag: string): string => {
    const id = randomUUID();
    admin(db, `INSERT INTO assets (id, org_id, tag, tag_normalized, created_by) VALUES ('${id}', '${orgId}', '${tag}', lower('${tag}'), '${m.admin.uid}')`);
    return id;
  };

  beforeAll(() => {
    const s = seedOrg(db, {
      viewer: { role: "Viewer" },
      auditor: { role: "Auditor" },
      engineer: { role: "Engineer-1" },
      manager: { role: "Manager" },
      supervisor: { role: "Supervisor" },
      docctrl: { role: "DocCtrl" },
      admin: { role: "Admin" },
      // additive roles: a Viewer headline who also holds DocCtrl is a controller
      viewerDocctrl: { role: "Viewer", roles: ["DocCtrl"] },
    });
    orgId = s.orgId;
    m = s.m;
    outsider = seedOrg(db, { admin: { role: "Admin" } }).m.admin;
  });

  it("every active member reads the registry; an outsider and anon read nothing", () => {
    const id = seedAsset("P-READ-1");
    for (const k of ["viewer", "auditor", "engineer", "manager", "admin"]) {
      expect(selectAs(db, m[k].caller, `SELECT count(*) FROM assets WHERE id = '${id}'`), k).toEqual(["1"]);
    }
    expect(selectAs(db, outsider.caller, `SELECT count(*) FROM assets WHERE id = '${id}'`)).toEqual(["0"]);
    expect(selectAs(db, { role: "anon" }, `SELECT count(*) FROM assets WHERE id = '${id}'`)).toEqual(["0"]);
  });

  it("INSERT: a Viewer's and an Auditor's JWT are refused 42501; Manager, Supervisor, DocCtrl and Admin create", () => {
    for (const k of ["viewer", "auditor"]) {
      const o = asCaller(db, m[k].caller, newAsset(`V-INS-${k}`, m[k].uid));
      expect(o, k).toMatchObject({ ok: false, code: "42501" });
    }
    for (const k of ["manager", "supervisor", "docctrl", "admin"]) {
      expect(asCaller(db, m[k].caller, newAsset(`W-INS-${k}`, m[k].uid)), k).toEqual({ ok: true, rows: 1 });
    }
    expect(asCaller(db, { role: "anon" }, newAsset("ANON-INS", m.viewer.uid))).toMatchObject({ ok: false, code: "42501" });
    expect(asCaller(db, outsider.caller, newAsset("OUT-INS", outsider.uid))).toMatchObject({ ok: false, code: "42501" });
  });

  it("UPDATE: a Viewer's and an Auditor's JWT touch 0 rows; a Manager edits", () => {
    const id = seedAsset("P-UPD-1");
    for (const k of ["viewer", "auditor"]) {
      expect(asCaller(db, m[k].caller, `UPDATE assets SET description = 'tampered' WHERE id = '${id}'`), k).toEqual({ ok: true, rows: 0 });
    }
    expect(asCaller(db, m.manager.caller, `UPDATE assets SET description = 'checked' WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT description FROM assets WHERE id = '${id}'`)).toBe("checked");
  });

  it("DELETE: Viewer, Manager and Supervisor touch 0 rows; Admin, DocCtrl and a Viewer holding DocCtrl delete, and the deletion is audited", () => {
    const id = seedAsset("P-DEL-1");
    for (const k of ["viewer", "auditor", "engineer", "manager", "supervisor"]) {
      expect(asCaller(db, m[k].caller, `DELETE FROM assets WHERE id = '${id}'`), k).toEqual({ ok: true, rows: 0 });
    }
    expect(asCaller(db, outsider.caller, `DELETE FROM assets WHERE id = '${id}'`)).toEqual({ ok: true, rows: 0 });
    expect(admin(db, `SELECT count(*) FROM assets WHERE id = '${id}'`)).toBe("1");
    expect(asCaller(db, m.admin.caller, `DELETE FROM assets WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT user_id::text || '|' || action FROM audit_logs WHERE resource_type = 'asset' AND resource_id = '${id}'`)).toBe(`${m.admin.uid}|ASSET_DELETED`);
    for (const k of ["docctrl", "viewerDocctrl"]) {
      const other = seedAsset(`P-DEL-${k}`);
      expect(asCaller(db, m[k].caller, `DELETE FROM assets WHERE id = '${other}'`), k).toEqual({ ok: true, rows: 1 });
    }
  });

  it("asset_types carries the same split: a Viewer cannot create, a Manager cannot delete, an Admin can", () => {
    const typeId = randomUUID();
    admin(db, `INSERT INTO asset_types (id, org_id, name) VALUES ('${typeId}', '${orgId}', 'Pump ${typeId.slice(0, 6)}')`);
    expect(asCaller(db, m.viewer.caller, `INSERT INTO asset_types (org_id, name) VALUES ('${orgId}', 'Viewer type')`)).toMatchObject({ ok: false, code: "42501" });
    expect(asCaller(db, m.manager.caller, `DELETE FROM asset_types WHERE id = '${typeId}'`)).toEqual({ ok: true, rows: 0 });
    expect(asCaller(db, m.admin.caller, `DELETE FROM asset_types WHERE id = '${typeId}'`)).toEqual({ ok: true, rows: 1 });
  });
});

describe.skipIf(skip !== null)("CB-2: the Bridge's proposal ledger, at runtime", () => {
  let orgId = "";
  let docId = "";
  let m: Record<string, SeededMember> = {};

  beforeAll(() => {
    const s = seedOrg(db, {
      viewer: { role: "Viewer" },
      manager: { role: "Manager" },
      admin: { role: "Admin" },
      docctrl: { role: "DocCtrl" },
    });
    orgId = s.orgId;
    m = s.m;
    const libId = randomUUID();
    docId = randomUUID();
    admin(db, `INSERT INTO libraries (id, org_id, name, type) VALUES ('${libId}', '${orgId}', 'P&IDs', 'documents');
               INSERT INTO documents (id, org_id, library_id, title, status) VALUES ('${docId}', '${orgId}', '${libId}', 'P&ID 100', 'Draft');`);
  });

  const forged = () =>
    `INSERT INTO document_equipment_suggestions (org_id, document_id, suggested) VALUES ('${orgId}', '${docId}', '[{"tag":"P-101","unitCode":"99","code":"9999.1"}]'::jsonb)`;

  it("a Viewer's direct INSERT of a forged proposal is refused 42501; so is a Manager's (not a controller)", () => {
    expect(asCaller(db, m.viewer.caller, forged())).toMatchObject({ ok: false, code: "42501" });
    expect(asCaller(db, m.manager.caller, forged())).toMatchObject({ ok: false, code: "42501" });
    expect(admin(db, `SELECT count(*) FROM document_equipment_suggestions WHERE document_id = '${docId}'`)).toBe("0");
  });

  it("a controller's write lands, every member reads it, and a Viewer can neither rewrite nor delete it", () => {
    expect(asCaller(db, m.docctrl.caller, forged())).toEqual({ ok: true, rows: 1 });
    expect(selectAs(db, m.viewer.caller, `SELECT count(*) FROM document_equipment_suggestions WHERE document_id = '${docId}'`)).toEqual(["1"]);
    expect(asCaller(db, m.viewer.caller, `UPDATE document_equipment_suggestions SET applied = '[]'::jsonb, status = 'applied' WHERE document_id = '${docId}'`)).toEqual({ ok: true, rows: 0 });
    expect(asCaller(db, m.viewer.caller, `DELETE FROM document_equipment_suggestions WHERE document_id = '${docId}'`)).toEqual({ ok: true, rows: 0 });
    expect(admin(db, `SELECT status FROM document_equipment_suggestions WHERE document_id = '${docId}'`)).toBe("pending");
    expect(asCaller(db, m.admin.caller, `UPDATE document_equipment_suggestions SET status = 'dismissed' WHERE document_id = '${docId}'`)).toEqual({ ok: true, rows: 1 });
  });

  it("the service role (the Bridge's own writes) is not judged by these policies", () => {
    expect(asCaller(db, { role: "service_role" }, `UPDATE document_equipment_suggestions SET status = 'pending' WHERE document_id = '${docId}'`)).toEqual({ ok: true, rows: 1 });
  });
});

describe.skipIf(skip !== null)("the runtime tests are not vacuous: the pre-20261128 policies let the refused writes through", () => {
  it("on a copy with 20260928's membership-wide ledger policy and without 20261128's delete overlay, a Viewer's forged proposal lands and a Manager's asset delete succeeds", () => {
    const scratch = "mos_registry_regress";
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    try {
      admin(scratch, `
        DROP POLICY doc_equip_sugg_write ON document_equipment_suggestions;
        CREATE POLICY doc_equip_sugg_write ON document_equipment_suggestions FOR ALL
          USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'))
          WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'));
        DROP POLICY assets_write_roles_delete ON assets;`);
      const s = seedOrg(scratch, { viewer: { role: "Viewer" }, manager: { role: "Manager" }, admin: { role: "Admin" } });
      const libId = randomUUID();
      const docId = randomUUID();
      const assetId = randomUUID();
      admin(scratch, `INSERT INTO libraries (id, org_id, name, type) VALUES ('${libId}', '${s.orgId}', 'P&IDs', 'documents');
                      INSERT INTO documents (id, org_id, library_id, title, status) VALUES ('${docId}', '${s.orgId}', '${libId}', 'P&ID 200', 'Draft');
                      INSERT INTO assets (id, org_id, tag, tag_normalized, created_by) VALUES ('${assetId}', '${s.orgId}', 'P-200', 'p200', '${s.m.admin.uid}');`);
      expect(asCaller(scratch, s.m.viewer.caller,
        `INSERT INTO document_equipment_suggestions (org_id, document_id, suggested) VALUES ('${s.orgId}', '${docId}', '[{"tag":"P-200","code":"9999.1"}]'::jsonb)`))
        .toEqual({ ok: true, rows: 1 });
      expect(asCaller(scratch, s.m.manager.caller, `DELETE FROM assets WHERE id = '${assetId}'`)).toEqual({ ok: true, rows: 1 });
    } finally {
      admin("postgres", `DROP DATABASE ${scratch}`);
    }
  });
});
