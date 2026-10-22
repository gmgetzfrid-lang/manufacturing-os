// projects-joint Round G, J21 DRAFTING-REQUEST PROJECT REMAINDERS — 20261262
// asserted at RUNTIME on the replayed PostgreSQL 16 (each statement as
// PostgREST sends it: role `authenticated` with the member's claims, or
// `service_role` with none).
//
//   PROJ-3 dw2: every project_documents attach / detach writes ONE audit_logs
//   row in its own transaction (PROJECT_DOCUMENT_ATTACHED / _DETACHED,
//   resource_type 'project'), whichever door made it — the card's insert /
//   delete, the service role, the checkout resync — and the attach / detach
//   outcome is exactly as before (REGRESSION: what landed still lands, what
//   the policy refused is still refused and writes nothing). A cascade from
//   the project's / document's / workspace's own deletion writes nothing and
//   the deletion succeeds. A repeat that changes nothing writes nothing.
//   PROJ-5: the intake door's 'manual' reference (no member behind it) to a
//   document the door CREATED (authored_by_link_id) in the project's own
//   intake folder reads 'intake'; the adoption's later 'manual' upsert keeps
//   it; a member's attach — even of a sheet filed by hand into the intake
//   folder, or of the door's own sheet — stays 'manual' (J21 fix pass);
//   'checkout' is never changed; the widened CHECK still refuses an unknown
//   value.
//   PROJ-10 dw2: milestones.linked_ticket_id is kept (no DDL drop).

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const F262 = "20261262_prj_roundG_project_register_record.sql";

function paste(f: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
  expect(r.ok, `${f}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("J21 — 20261262: the register's attach / detach record and the intake source (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let libId = "";
  const doc = (collectionId: string | null = null, number = `P-${randomUUID().slice(0, 6)}`, authoredByLink: string | null = null) => {
    const id = randomUUID();
    admin(db, `INSERT INTO documents (id, org_id, library_id, collection_id, title, document_number, status${authoredByLink ? ", authored_by_link_id" : ""}) VALUES ('${id}', '${orgId}', '${libId}', ${collectionId ? `'${collectionId}'` : "NULL"}, 'Sheet', '${number}', 'Draft'${authoredByLink ? `, '${authoredByLink}'` : ""})`);
    return id;
  };
  /** A sheet the intake door created (the stored intake-born fact, written by the door / service role). */
  const doorDoc = (collectionId: string) => doc(collectionId, undefined, randomUUID());
  const project = (opts: { intake?: string | null } = {}) => {
    const id = randomUUID();
    admin(db, `INSERT INTO projects (id, org_id, name, owner_user_id, created_by${opts.intake ? ", intake_collection_id" : ""}) VALUES ('${id}', '${orgId}', 'Turnaround', '${m.owner.uid}', '${m.owner.uid}'${opts.intake ? `, '${opts.intake}'` : ""})`);
    return id;
  };
  const folder = () => {
    const id = randomUUID();
    admin(db, `INSERT INTO collections (id, org_id, library_id, name) VALUES ('${id}', '${orgId}', '${libId}', 'Intake ${id.slice(0, 4)}')`);
    return id;
  };
  const audits = (projectId: string, action?: string) => admin(db,
    `SELECT COALESCE(string_agg(action || '|' || COALESCE(user_id::text, '') || '|' || COALESCE(actor_kind, '') || '|' || COALESCE(details->>'documentId', '') || '|' || COALESCE(details->>'source', ''), E'\\n' ORDER BY "timestamp", action), '')
       FROM audit_logs WHERE resource_type = 'project' AND resource_id = '${projectId}' AND action LIKE 'PROJECT_DOCUMENT_%'${action ? ` AND action = '${action}'` : ""}`)
    .split("\n").filter(Boolean);
  const sourceOf = (projectId: string, docId: string) => admin(db, `SELECT COALESCE(MAX(source), '') FROM project_documents WHERE project_id = '${projectId}' AND document_id = '${docId}'`);

  beforeAll(() => {
    const s = seedOrg(db, { owner: { role: "Engineer" }, viewer: { role: "Viewer" }, ctrl: { role: "DocCtrl" } });
    orgId = s.orgId;
    m = s.m;
    libId = randomUUID();
    admin(db, `INSERT INTO libraries (id, org_id, name, type) VALUES ('${libId}', '${orgId}', 'J21 Drawings', 'documents')`);
  });

  it("re-pastes cleanly (DEC-30 one paste); every probe answers true (seven); six inventory rows and one after-row carry counts", () => {
    const { probes, inventory } = paste(F262);
    expect(probes.length).toBe(7);
    expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(inventory.length).toBe(7);
  });

  it("PROJ-3 dw2 + REGRESSION: the owner's attach and detach through the card land exactly as before and each writes ONE audit row naming the owner (member)", () => {
    const p = project();
    const d = doc();
    expect(asCaller(db, m.owner.caller, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d}', 'manual')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, d)).toBe("manual");
    expect(audits(p)).toEqual([`PROJECT_DOCUMENT_ATTACHED|${m.owner.uid}|member|${d}|manual`]);
    expect(asCaller(db, m.owner.caller, `DELETE FROM project_documents WHERE project_id = '${p}' AND document_id = '${d}'`)).toEqual({ ok: true, rows: 1 });
    expect(audits(p, "PROJECT_DOCUMENT_DETACHED")).toEqual([`PROJECT_DOCUMENT_DETACHED|${m.owner.uid}|member|${d}|manual`]);
  });

  it("REGRESSION: a member the register policy refuses is still refused (42501) — and nothing is recorded; a repeat attach that changes nothing (DO NOTHING) records nothing", () => {
    const p = project();
    const d = doc();
    const refused = asCaller(db, m.viewer.caller, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d}', 'manual')`);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("42501");
    expect(audits(p)).toEqual([]);
    expect(asCaller(db, SERVICE, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d}', 'manual') ON CONFLICT (project_id, document_id) DO NOTHING`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d}', 'manual') ON CONFLICT (project_id, document_id) DO NOTHING`)).toEqual({ ok: true, rows: 0 });
    // the service role's row is the system's (no person behind it is known to the database)
    expect(audits(p)).toEqual([`PROJECT_DOCUMENT_ATTACHED||system|${d}|manual`]);
  });

  it("PROJ-3 dw2: a checkout under the project links its document as before (the resync, SECURITY DEFINER) and the attach is recorded with the checking-out member and source checkout; a re-checkout records nothing more", () => {
    const p = project();
    const d = doc();
    admin(db, `INSERT INTO project_members (project_id, user_id, role) VALUES ('${p}', '${m.viewer.uid}', 'collaborator') ON CONFLICT DO NOTHING`);
    const s1 = asCaller(db, m.viewer.caller, `INSERT INTO checkout_sessions (org_id, document_id, library_id, user_id, status, project_id) VALUES ('${orgId}', '${d}', '${libId}', '${m.viewer.uid}', 'released', '${p}')`);
    expect(s1).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, d)).toBe("checkout");
    expect(audits(p)).toEqual([`PROJECT_DOCUMENT_ATTACHED|${m.viewer.uid}|member|${d}|checkout`]);
    expect(asCaller(db, m.viewer.caller, `INSERT INTO checkout_sessions (org_id, document_id, library_id, user_id, status, project_id) VALUES ('${orgId}', '${d}', '${libId}', '${m.viewer.uid}', 'released', '${p}')`)).toEqual({ ok: true, rows: 1 });
    expect(audits(p)).toHaveLength(1);
  });

  it("PROJ-5: the intake door's reference (service role, 'manual') to a document the door created in the project's intake folder reads 'intake'; the adoption's later 'manual' upsert keeps it; a document outside the folder stays 'manual'", () => {
    const intake = folder();
    const filed = folder();
    const p = project({ intake });
    const d = doorDoc(intake);
    const other = doc(filed);
    expect(asCaller(db, SERVICE, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d}', 'manual') ON CONFLICT (project_id, document_id) DO NOTHING`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, d)).toBe("intake");
    expect(audits(p)).toEqual([`PROJECT_DOCUMENT_ATTACHED||system|${d}|intake`]);
    // adoption: the sheet moves out of the intake folder, then the register row is upserted 'manual'
    admin(db, `UPDATE documents SET collection_id = '${filed}' WHERE id = '${d}'`);
    expect(asCaller(db, m.ctrl.caller, `INSERT INTO project_documents (org_id, project_id, document_id, source, last_seen_at) VALUES ('${orgId}', '${p}', '${d}', 'manual', now())
                                       ON CONFLICT (project_id, document_id) DO UPDATE SET source = EXCLUDED.source, last_seen_at = EXCLUDED.last_seen_at`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, d)).toBe("intake");
    expect(audits(p)).toHaveLength(1); // an update, not an attach
    expect(asCaller(db, m.ctrl.caller, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${other}', 'manual')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, other)).toBe("manual");
  });

  it("PROJ-5: the trigger never writes 'checkout' over or away by itself; the widened CHECK still refuses an unknown value (23514); the card's 'manual' re-attach over a checkout row turns it 'manual' exactly as today — a hand-filed sheet in the intake folder too", () => {
    const intake = folder();
    const p = project({ intake });
    const d = doc(intake); // filed BY HAND into the intake folder (no authored_by_link_id)
    expect(asCaller(db, SERVICE, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d}', 'checkout')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, d)).toBe("checkout");
    const bogus = asCaller(db, SERVICE, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${doc()}', 'bogus')`);
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.code).toBe("23514");
    // the card's re-attach upserts 'manual' over a checkout row: today it becomes 'manual', and
    // it still does — a member is writing, and the door never created this sheet.
    expect(asCaller(db, m.owner.caller, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d}', 'manual')
                                         ON CONFLICT (project_id, document_id) DO UPDATE SET source = EXCLUDED.source`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, d)).toBe("manual");
    // outside the intake folder the re-attach is exactly today's: checkout → manual
    const d3 = doc();
    admin(db, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d3}', 'checkout')`);
    expect(asCaller(db, m.owner.caller, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d3}', 'manual')
                                         ON CONFLICT (project_id, document_id) DO UPDATE SET source = EXCLUDED.source`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, d3)).toBe("manual");
  });

  it("PROJ-5 (J21 fix pass, review major 2): a member's attach stays 'manual' — a sheet Document Control filed by hand into the intake folder, and even the door's own sheet attached by hand; its attach row says 'manual', never 'intake'", () => {
    const intake = folder();
    const p = project({ intake });
    const handFiled = doc(intake);
    expect(asCaller(db, m.owner.caller, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${handFiled}', 'manual')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, handFiled)).toBe("manual");
    expect(audits(p)).toEqual([`PROJECT_DOCUMENT_ATTACHED|${m.owner.uid}|member|${handFiled}|manual`]);
    // the same hand-filed sheet written by the service role: not the door's sheet, so still 'manual'
    const handFiled2 = doc(intake);
    expect(asCaller(db, SERVICE, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${handFiled2}', 'manual')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, handFiled2)).toBe("manual");
    // the door's sheet, attached by a member from the card (e.g. after a detach): the member did it
    const doors = doorDoc(intake);
    expect(asCaller(db, m.owner.caller, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${doors}', 'manual')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, doors)).toBe("manual");
  });

  it("PROJ-3 dw2: deleting a whole workspace (its projects, documents and register rows cascade) succeeds and leaves no detach row behind", () => {
    const s = seedOrg(db, { boss: { role: "Admin" } });
    const lib = randomUUID();
    const p = randomUUID();
    const d = randomUUID();
    admin(db, `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${s.orgId}', 'Gone', 'documents');
      INSERT INTO documents (id, org_id, library_id, title, status) VALUES ('${d}', '${s.orgId}', '${lib}', 'Gone sheet', 'Draft');
      INSERT INTO projects (id, org_id, name, owner_user_id, created_by) VALUES ('${p}', '${s.orgId}', 'Gone job', '${s.m.boss.uid}', '${s.m.boss.uid}');
      INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${s.orgId}', '${p}', '${d}', 'manual');`);
    expect(audits(p, "PROJECT_DOCUMENT_ATTACHED")).toHaveLength(1);
    admin(db, `DELETE FROM orgs WHERE id = '${s.orgId}'`);
    expect(admin(db, `SELECT COUNT(*) FROM project_documents WHERE project_id = '${p}'`)).toBe("0");
    expect(audits(p, "PROJECT_DOCUMENT_DETACHED")).toEqual([]);
  });

  it("PROJ-3 dw2: deleting the project or the document cascades its register rows as before (the deletion succeeds) and writes NO detach row", () => {
    const p = project();
    const d1 = doc();
    const d2 = doc();
    admin(db, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d1}', 'manual'), ('${orgId}', '${p}', '${d2}', 'manual')`);
    expect(audits(p, "PROJECT_DOCUMENT_ATTACHED")).toHaveLength(2);
    admin(db, `DELETE FROM documents WHERE id = '${d2}'`);
    expect(admin(db, `SELECT COUNT(*) FROM project_documents WHERE project_id = '${p}'`)).toBe("1");
    expect(audits(p, "PROJECT_DOCUMENT_DETACHED")).toEqual([]);
    expect(asCaller(db, m.owner.caller, `DELETE FROM projects WHERE id = '${p}'`)).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT COUNT(*) FROM project_documents WHERE project_id = '${p}'`)).toBe("0");
    expect(audits(p, "PROJECT_DOCUMENT_DETACHED")).toEqual([]);
  });

  it("PROJ-10 dw2: milestones.linked_ticket_id is kept (DROP-AS-UNUSED by record, no DDL drop) and still clears on a request's deletion", () => {
    expect(admin(db, `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'milestones' AND column_name = 'linked_ticket_id'`)).toBe("1");
    expect(admin(db, `SELECT col_description('public.milestones'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.milestones'::regclass AND attname = 'linked_ticket_id')) LIKE 'UNUSED (drafting-flow PROJ-10%'`)).toBe("t");
  });
});
