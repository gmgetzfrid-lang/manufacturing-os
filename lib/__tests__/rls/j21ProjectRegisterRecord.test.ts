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
//   Merge-time fix (DEC-90 ruling 3): a service-role UPDATE that moves a
//   link's project_id / document_id writes DETACHED (old) then ATTACHED
//   (new); an UPDATE changing neither writes nothing; a member's move is
//   still refused (20261102) and records nothing.
//   PROJ-5: a 'manual' reference reads 'intake' ONLY when the writer IS the
//   door (merge-time fix, DEC-90 ruling 4) — intake_door_housekeep
//   'reference' (the link's bound identity) or the upload route's
//   service-role fallback naming itself (x-mos-intake-door-reference) — for a
//   document that link created in the project's own intake folder; the
//   adoption's later 'manual' upsert keeps it; every other writer keeps the
//   value it sends: a member's attach (even of a sheet filed by hand into the
//   intake folder, or of the door's own sheet), a restore (it reproduces the
//   backed-up value), DF-P8's server-side reference (stays 'manual');
//   'checkout' is never changed; the widened CHECK still refuses an unknown
//   value.
//   PROJ-10 dw2: milestones.linked_ticket_id is kept (no DDL drop).

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, skipReason, type Caller, type Outcome, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { dollarQuote, runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const F262 = "20261262_prj_roundG_project_register_record.sql";

/** One statement as the caller with request headers, exactly as PostgREST
 *  sets them (transaction-local request.headers, JSON of the lower-cased
 *  header names). */
function asCallerWithHeaders(db: string, c: Caller, headers: Record<string, string>, statement: string): Outcome {
  const { conn } = mosDb();
  const claims: Record<string, string> = { role: c.role };
  if (c.uid) claims.sub = c.uid;
  if (c.email) claims.email = c.email;
  const sql = [
    `SET ROLE ${c.role};`,
    `SELECT set_config('request.jwt.claims', ${dollarQuote(JSON.stringify(claims))}, false);`,
    `SELECT set_config('request.headers', ${dollarQuote(JSON.stringify(headers))}, false);`,
    `SELECT harness.try_sql(${dollarQuote(statement)});`,
  ].join("\n");
  const r = runPsql(conn!, db, conn!.superuser, { sql });
  if (!r.ok) throw new Error(`harness call failed: ${r.error ?? r.stderr}`);
  const last = r.stdout.split("\n").pop() ?? "";
  const ok = /^ok:(\d+)$/.exec(last);
  if (ok) return { ok: true, rows: Number(ok[1]) };
  const err = /^err:([0-9A-Z]{5}):([\s\S]*)$/.exec(last);
  if (err) return { ok: false, code: err[1], message: err[2] };
  throw new Error(`unexpected harness answer: ${last}`);
}
const DOOR_HEADER = { "x-mos-intake-door-reference": "on" };

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
  /** A link of the project (the door's identity) and its credential hash. */
  const link = (projectId: string) => {
    const id = randomUUID();
    const hash = (randomUUID() + randomUUID()).replace(/-/g, "");
    admin(db, `INSERT INTO project_intake_links (id, org_id, project_id, company_name, token_hash, expires_at, created_by, assigned_doc_ids)
               VALUES ('${id}', '${orgId}', '${projectId}', 'Contractor Co', '${hash}', now() + interval '30 days', '${m.owner.uid}', ARRAY[]::uuid[])`);
    return { id, hash };
  };
  /** A sheet the intake door created (the stored intake-born fact, written by the door / service role) — by `linkId`, else by a link that is no row. */
  const doorDoc = (collectionId: string, linkId: string = randomUUID()) => doc(collectionId, undefined, linkId);
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

  it("PROJ-5: the intake door's own reference — intake_door_housekeep 'reference' (the link's bound identity) — to a document it created in the project's intake folder reads 'intake'; the adoption's later 'manual' upsert keeps it; a document outside the folder stays 'manual'", () => {
    const intake = folder();
    const filed = folder();
    const p = project({ intake });
    const l = link(p);
    const d = doorDoc(intake, l.id);
    const other = doc(filed);
    expect(asCaller(db, SERVICE, `SELECT 1 WHERE intake_door_housekeep('${l.hash}', 'reference', '${d}', NULL, now()) = 1`)).toEqual({ ok: true, rows: 1 });
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

  it("PROJ-5 (merge-time fix, ruling 4): the upload route's service-role fallback naming itself (x-mos-intake-door-reference: on) writes 'intake'; the SAME write without the header — DF-P8's server-side referenceDeliverableInProject, or any other service-role writer — stays 'manual'", () => {
    const intake = folder();
    const p = project({ intake });
    const l = link(p);
    const viaRoute = doorDoc(intake, l.id);
    expect(asCallerWithHeaders(db, SERVICE, DOOR_HEADER, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${viaRoute}', 'manual') ON CONFLICT (project_id, document_id) DO NOTHING`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, viaRoute)).toBe("intake");
    expect(audits(p)).toEqual([`PROJECT_DOCUMENT_ATTACHED||system|${viaRoute}|intake`]);
    // DF-P8's server reference of the door's own sheet (service role, no header): what it sends
    const dfp8 = doorDoc(intake, l.id);
    expect(asCaller(db, SERVICE, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${dfp8}', 'manual') ON CONFLICT (project_id, document_id) DO NOTHING`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, dfp8)).toBe("manual");
    // another header value, or the header from a non-service caller, is not the door
    const other = doorDoc(intake, l.id);
    expect(asCallerWithHeaders(db, SERVICE, { "x-mos-intake-door-reference": "yes" }, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${other}', 'manual')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, other)).toBe("manual");
    const byMember = doorDoc(intake, l.id);
    expect(asCallerWithHeaders(db, m.owner.caller, DOOR_HEADER, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${byMember}', 'manual')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, byMember)).toBe("manual");
  });

  it("PROJ-5 (merge-time fix, ruling 4): the door's header for a sheet ANOTHER project's link created, or a sheet no link of this project created, stays 'manual'; a link identity writing for another project is not this project's door", () => {
    const intake = folder();
    const p = project({ intake });
    const otherProject = project({ intake: folder() });
    const foreign = link(otherProject);
    const d1 = doorDoc(intake, foreign.id);
    expect(asCallerWithHeaders(db, SERVICE, DOOR_HEADER, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d1}', 'manual')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, d1)).toBe("manual");
    const d2 = doorDoc(intake); // authored_by_link_id names no link row
    expect(asCallerWithHeaders(db, SERVICE, DOOR_HEADER, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d2}', 'manual')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, d2)).toBe("manual");
    // the foreign link's identity (service role carrying its uid, as intake_door_bind sets it) on THIS project
    const own = link(p);
    const d3 = doorDoc(intake, own.id);
    expect(asCaller(db, { role: "service_role", uid: foreign.id }, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${d3}', 'manual')`)).toEqual({ ok: true, rows: 1 });
    expect(sourceOf(p, d3)).toBe("manual");
  });

  it("PROJ-5 (merge-time fix, ruling 4): a restore reproduces the backed-up value — an 'intake' row comes back 'intake', a 'manual' row of the door's own sheet comes back 'manual'", () => {
    const intake = folder();
    const p = project({ intake });
    const l = link(p);
    const wasIntake = doorDoc(intake, l.id);
    const wasManual = doorDoc(intake, l.id);
    expect(asCaller(db, SERVICE, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${wasIntake}', 'intake'), ('${orgId}', '${p}', '${wasManual}', 'manual')`)).toEqual({ ok: true, rows: 2 });
    expect(sourceOf(p, wasIntake)).toBe("intake");
    expect(sourceOf(p, wasManual)).toBe("manual");
    // and as the superuser (a SQL restore: no request at all)
    const sqlRestored = doorDoc(intake, l.id);
    admin(db, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p}', '${sqlRestored}', 'manual')`);
    expect(sourceOf(p, sqlRestored)).toBe("manual");
  });

  it("PROJ-3 dw2 (merge-time fix, ruling 3): a service-role UPDATE moving a link to another project writes DETACHED on the old project and ATTACHED on the new; moving its document likewise; an UPDATE changing neither id writes nothing", () => {
    const p1 = project();
    const p2 = project();
    const d = doc();
    const d2 = doc();
    admin(db, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p1}', '${d}', 'manual')`);
    expect(audits(p1)).toHaveLength(1);
    // neither id changes: a touch, a SET of the same ids
    expect(asCaller(db, SERVICE, `UPDATE project_documents SET last_seen_at = now() WHERE project_id = '${p1}' AND document_id = '${d}'`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, `UPDATE project_documents SET project_id = '${p1}', document_id = '${d}' WHERE project_id = '${p1}' AND document_id = '${d}'`)).toEqual({ ok: true, rows: 1 });
    expect(audits(p1)).toHaveLength(1);
    // the move
    expect(asCaller(db, SERVICE, `UPDATE project_documents SET project_id = '${p2}' WHERE project_id = '${p1}' AND document_id = '${d}'`)).toEqual({ ok: true, rows: 1 });
    expect(audits(p1, "PROJECT_DOCUMENT_DETACHED")).toEqual([`PROJECT_DOCUMENT_DETACHED||system|${d}|manual`]);
    expect(audits(p2)).toEqual([`PROJECT_DOCUMENT_ATTACHED||system|${d}|manual`]);
    expect(admin(db, `SELECT details->>'moved' FROM audit_logs WHERE resource_type = 'project' AND resource_id = '${p2}' AND action = 'PROJECT_DOCUMENT_ATTACHED'`)).toBe("true");
    // the document moves
    expect(asCaller(db, SERVICE, `UPDATE project_documents SET document_id = '${d2}' WHERE project_id = '${p2}' AND document_id = '${d}'`)).toEqual({ ok: true, rows: 1 });
    expect(audits(p2)).toEqual([`PROJECT_DOCUMENT_ATTACHED||system|${d}|manual`, `PROJECT_DOCUMENT_ATTACHED||system|${d2}|manual`, `PROJECT_DOCUMENT_DETACHED||system|${d}|manual`]);
    expect(admin(db, `SELECT COUNT(*) FROM audit_logs WHERE resource_type = 'project' AND resource_id IN ('${p1}', '${p2}') AND details->>'moved' = 'true'`)).toBe("4");
  });

  it("REGRESSION (ruling 3): a member's move of a link is still refused by 20261102 (enforce_project_document_link_fixed) and records nothing", () => {
    const p1 = project();
    const p2 = project();
    const d = doc();
    admin(db, `INSERT INTO project_documents (org_id, project_id, document_id, source) VALUES ('${orgId}', '${p1}', '${d}', 'manual')`);
    const moved = asCaller(db, m.owner.caller, `UPDATE project_documents SET project_id = '${p2}' WHERE project_id = '${p1}' AND document_id = '${d}'`);
    expect(moved.ok === false || moved.rows === 0).toBe(true);
    expect(admin(db, `SELECT project_id FROM project_documents WHERE document_id = '${d}'`)).toBe(p1);
    expect(audits(p1)).toHaveLength(1);
    expect(audits(p2)).toEqual([]);
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
