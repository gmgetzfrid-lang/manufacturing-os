// drafting-flow Round G, DF-P5 ROSTER — the two migrations, asserted at
// RUNTIME on the replayed database (each statement sent as PostgREST sends it:
// role `authenticated` with the member's JWT claims, or `service_role` with
// none, which is how the workflow route writes).
//
//   20261241  routing_control on libraries / collections / documents: a plain
//             member cannot declare routing on a library or a document; a
//             controller and the library owner can (library); a folder or a
//             document is controller-ONLY — a document's effective owner is
//             refused (DF-P5 fix pass); a row INSERTED with a routing table
//             needs a controller and is audited; every change writes a
//             ROUTING_CONTROL_CHANGED audit row; only an object (or NULL) is
//             stored; an unrelated write by a member still lands (REGRESSION).
//   20261242  the roster ledger: no client role may write it; a member reads
//             a slot exactly when they can read its ticket (the Contractor
//             scope included); the event log is append-only (an UPDATE is
//             refused even for the service role, a DELETE while the ticket
//             exists) and leaves with its ticket (the shed's delete works)
//             or its org, whichever ON DELETE CASCADE fires first.
//   Both re-paste cleanly (DEC-30 one paste) with every probe true.

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const ROUTING = `'{"slots":[{"kind":"eng","mode":"blocking","fill":{"roles":["Engineer"]}}]}'::jsonb`;

describe.skipIf(skip !== null)("DF-P5 — routing_control guard and audit, the roster ledger (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let lib = "";
  let folder = "";
  let doc = "";

  beforeAll(() => {
    const s = seedOrg(db, {
      admin: { role: "Admin" }, owner: { role: "Drafter" }, member: { role: "Drafter" },
      requester: { role: "Requester" }, contractor: { role: "Contractor" },
    });
    orgId = s.orgId;
    m = s.m;
    lib = randomUUID();
    folder = randomUUID();
    doc = randomUUID();
    admin(db, [
      `INSERT INTO libraries (id, org_id, name, type, owner_user_id) VALUES ('${lib}', '${orgId}', 'P&IDs', 'documents', '${m.owner.uid}')`,
      `INSERT INTO collections (id, org_id, library_id, name) VALUES ('${folder}', '${orgId}', '${lib}', 'Unit 12')`,
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${doc}', '${orgId}', '${lib}', 'p.pdf', 'P', 'P-${doc.slice(0, 8)}', '0', 'Draft')`,
    ].join(";\n"));
  });

  it("each DF-P5 migration re-pastes cleanly (DEC-30 one paste) and every probe answers true; the inventory rows carry counts", () => {
    const { conn } = mosDb();
    for (const f of ["20261241_df_roundG_routing_control.sql", "20261242_df_roundG_ticket_roster.sql"]) {
      const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
      expect(r.ok, `${f}: ${r.error ?? ""}`).toBe(true);
      const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
      const probes = rows.filter((l) => /\|[tf]\|$/.test(l));
      expect(probes.length, f).toBeGreaterThanOrEqual(6);
      expect(probes.filter((l) => l.endsWith("|f|")), f).toEqual([]);
      expect(rows.filter((l) => /\|\|\d+$/.test(l)).length, f).toBeGreaterThanOrEqual(2);
    }
  });

  // ── 20261241 ────────────────────────────────────────────────────────────────
  it("a plain member cannot declare routing on a library or a document; nothing is stored", () => {
    for (const [table, id] of [["libraries", lib], ["documents", doc]] as const) {
      const r = asCaller(db, m.member.caller, `UPDATE ${table} SET routing_control = ${ROUTING} WHERE id = '${id}'`);
      expect(r.ok, table).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/Not permitted to change this (library|document)'s review routing/);
      expect(admin(db, `SELECT routing_control IS NULL FROM ${table} WHERE id = '${id}'`)).toBe("t");
    }
  });

  it("DF-P5 fix: a document's effective owner (its uploader / drafter) cannot set the document's routing — a controller only", () => {
    admin(db, `UPDATE documents SET owner_user_id = '${m.owner.uid}' WHERE id = '${doc}'`);
    expect(admin(db, `SELECT user_is_effective_owner(owner_user_id, collection_id, library_id, '${m.owner.uid}'::uuid) FROM documents WHERE id = '${doc}'`)).toBe("t");
    const r = asCaller(db, m.owner.caller, `UPDATE documents SET routing_control = ${ROUTING} WHERE id = '${doc}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Not permitted to change this document's review routing — only a document controller can/);
    expect(admin(db, `SELECT routing_control IS NULL FROM documents WHERE id = '${doc}'`)).toBe("t");
  });

  it("DF-P5 fix: a row INSERTED carrying a routing table needs a controller on every level; a controller's (and the service role's) insert is audited with before = NULL", () => {
    const d2 = randomUUID();
    const f2 = randomUUID();
    const l2 = randomUUID();
    const tries = [
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, routing_control) VALUES ('${d2}', '${orgId}', '${lib}', 'q.pdf', 'Q', 'Q-${d2.slice(0, 8)}', '0', 'Draft', ${ROUTING})`,
      `INSERT INTO collections (id, org_id, library_id, name, routing_control) VALUES ('${f2}', '${orgId}', '${lib}', 'Unit 13', ${ROUTING})`,
      `INSERT INTO libraries (id, org_id, name, type, owner_user_id, routing_control) VALUES ('${l2}', '${orgId}', 'Isos', 'documents', '${m.owner.uid}', ${ROUTING})`,
    ];
    for (const who of [m.owner.caller, m.member.caller]) {
      for (const stmt of tries) {
        const r = asCaller(db, who, stmt);
        expect(r.ok, stmt).toBe(false);
      }
    }
    expect(admin(db, `SELECT (SELECT COUNT(*) FROM documents WHERE id = '${d2}') + (SELECT COUNT(*) FROM collections WHERE id = '${f2}') + (SELECT COUNT(*) FROM libraries WHERE id = '${l2}')`)).toBe("0");
    // the guard itself refuses (not only a row policy): the owner may create a folder, never one carrying a table
    const own = asCaller(db, m.owner.caller, tries[1]);
    if (!own.ok && own.code === "23514") expect(own.message).toMatch(/only a document controller can declare one/);
    expect(asCaller(db, m.admin.caller, tries[1])).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, tries[0])).toEqual({ ok: true, rows: 1 });
    const rows = admin(db, `SELECT resource_type || ':' || (details->>'op') || ':' || COALESCE(details->>'before', 'null') || ':' || (details->>'via') FROM audit_logs WHERE action = 'ROUTING_CONTROL_CHANGED' AND resource_id IN ('${f2}', '${d2}') ORDER BY resource_type`);
    expect(rows.split("\n")).toEqual(["collection:insert:null:database", "document:insert:null:service_role"]);
    // an insert with no routing table is untouched (REGRESSION): no audit row
    const d3 = randomUUID();
    expect(asCaller(db, SERVICE, `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${d3}', '${orgId}', '${lib}', 'r.pdf', 'R', 'R-${d3.slice(0, 8)}', '0', 'Draft')`)).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'ROUTING_CONTROL_CHANGED' AND resource_id = '${d3}'`)).toBe("0");
  });

  it("the library owner and a controller can; a controller can set a folder; each change writes ROUTING_CONTROL_CHANGED with before / after", () => {
    expect(asCaller(db, m.owner.caller, `UPDATE libraries SET routing_control = ${ROUTING} WHERE id = '${lib}'`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, m.admin.caller, `UPDATE documents SET routing_control = ${ROUTING} WHERE id = '${doc}'`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, m.admin.caller, `UPDATE collections SET routing_control = ${ROUTING} WHERE id = '${folder}'`)).toEqual({ ok: true, rows: 1 });
    // a member's folder write is filtered by the controllers-only policy (no row)
    expect(asCaller(db, m.member.caller, `UPDATE collections SET routing_control = NULL WHERE id = '${folder}'`)).toEqual({ ok: true, rows: 0 });
    const audits = admin(db, `SELECT resource_type || ':' || (details->'after'->'slots'->0->>'kind') FROM audit_logs WHERE action = 'ROUTING_CONTROL_CHANGED' AND org_id = '${orgId}' AND details->>'op' = 'update' AND resource_id IN ('${lib}', '${doc}', '${folder}') ORDER BY resource_type`);
    expect(audits.split("\n").sort()).toEqual(["collection:eng", "document:eng", "library:eng"]);
  });

  it("only an object or NULL is stored (CHECK); clearing a level back to inherit is allowed", () => {
    const r = asCaller(db, m.admin.caller, `UPDATE libraries SET routing_control = '[1]'::jsonb WHERE id = '${lib}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("23514");
    expect(asCaller(db, m.admin.caller, `UPDATE libraries SET routing_control = NULL WHERE id = '${lib}'`)).toEqual({ ok: true, rows: 1 });
  });

  it("REGRESSION: a member's write that does not touch routing_control behaves as before (the guard looks at that column only)", () => {
    const before = admin(db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'ROUTING_CONTROL_CHANGED' AND org_id = '${orgId}'`);
    const r = asCaller(db, m.owner.caller, `UPDATE libraries SET name = 'P&IDs (Unit 12)' WHERE id = '${lib}'`);
    expect(r).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'ROUTING_CONTROL_CHANGED' AND org_id = '${orgId}'`)).toBe(before);
  });

  // ── 20261242 ────────────────────────────────────────────────────────────────
  const ticket = (requester: string): string => {
    const id = randomUUID();
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id) VALUES ('${id}', '${orgId}', 'KE-P5-${id.slice(0, 6)}', 'Tie-in', 'New Drawing', 'PENDING_REVIEW', '${requester}')`);
    return id;
  };
  const slot = (ticketId: string, roster = randomUUID()) =>
    `INSERT INTO ticket_review_slots (org_id, ticket_id, roster_id, slot_kind, mode, primaries, status, content_hash) VALUES ('${orgId}', '${ticketId}', '${roster}', 'eng', 'blocking', ARRAY['${m.admin.uid}']::uuid[], 'open', 'h')`;
  const event = (ticketId: string, roster: string) =>
    `INSERT INTO ticket_review_slot_events (org_id, ticket_id, roster_id, slot_kind, event) VALUES ('${orgId}', '${ticketId}', '${roster}', 'eng', 'opened')`;

  it("no client role may write the ledger; the service role (the workflow route) can", () => {
    const t = ticket(m.requester.uid);
    for (const who of [m.admin.caller, m.requester.caller]) {
      const r = asCaller(db, who, slot(t));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("42501");
    }
    expect(asCaller(db, SERVICE, slot(t))).toEqual({ ok: true, rows: 1 });
    const r2 = asCaller(db, m.admin.caller, `UPDATE ticket_review_slots SET status = 'void' WHERE ticket_id = '${t}'`);
    expect(r2.ok).toBe(false);
  });

  it("a member reads a slot exactly when they can read its ticket (the Contractor-only scope decides for a contractor)", () => {
    const t = ticket(m.requester.uid);
    asCaller(db, SERVICE, slot(t));
    expect(selectAs(db, m.requester.caller, `SELECT slot_kind FROM ticket_review_slots WHERE ticket_id = '${t}'`)).toEqual(["eng"]);
    const tickets = selectAs(db, m.contractor.caller, `SELECT id FROM tickets WHERE id = '${t}'`);
    const slots = selectAs(db, m.contractor.caller, `SELECT slot_kind FROM ticket_review_slots WHERE ticket_id = '${t}'`);
    expect(slots.length).toBe(tickets.length);
  });

  it("a satisfied slot must name who, when and the signature (CHECK)", () => {
    const t = ticket(m.requester.uid);
    asCaller(db, SERVICE, slot(t));
    const bad = asCaller(db, SERVICE, `UPDATE ticket_review_slots SET status = 'satisfied' WHERE ticket_id = '${t}'`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("23514");
    expect(asCaller(db, SERVICE, `UPDATE ticket_review_slots SET status = 'satisfied', satisfied_by = '${m.admin.uid}', satisfied_at = now(), signature_id = '${randomUUID()}' WHERE ticket_id = '${t}'`))
      .toEqual({ ok: true, rows: 1 });
  });

  it("the event log is append-only: an UPDATE is refused even for the service role, a DELETE while the ticket exists; deleting the ticket (the shed) removes them", () => {
    const t = ticket(m.requester.uid);
    const roster = randomUUID();
    expect(asCaller(db, SERVICE, event(t, roster))).toEqual({ ok: true, rows: 1 });
    const up = asCaller(db, SERVICE, `UPDATE ticket_review_slot_events SET event = 'voided' WHERE ticket_id = '${t}'`);
    expect(up.ok).toBe(false);
    if (!up.ok) expect(up.message).toMatch(/append-only/);
    const del = asCaller(db, SERVICE, `DELETE FROM ticket_review_slot_events WHERE ticket_id = '${t}'`);
    expect(del.ok).toBe(false);
    asCaller(db, SERVICE, slot(t, roster));
    expect(asCaller(db, SERVICE, `DELETE FROM tickets WHERE id = '${t}'`)).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT COUNT(*) FROM ticket_review_slot_events WHERE ticket_id = '${t}'`)).toBe("0");
    expect(admin(db, `SELECT COUNT(*) FROM ticket_review_slots WHERE ticket_id = '${t}'`)).toBe("0");
  });

  it("DF-P5 fix: deleting an org with roster events succeeds — and so does the events cascade when it fires BEFORE the tickets one (the org row already gone, the ticket still there)", () => {
    const t = ticket(m.requester.uid);
    const roster = randomUUID();
    expect(asCaller(db, SERVICE, event(t, roster))).toEqual({ ok: true, rows: 1 });
    // the order the reviewer reproduced, forced: the org row is removed with
    // the RI cascades off, then the events delete runs while the ticket exists
    const sim = admin(db, `SELECT harness.try_sql(${"$q$"}DO $do$ DECLARE e int; tk int; BEGIN
      PERFORM set_config('session_replication_role', 'replica', true);
      DELETE FROM orgs WHERE id = '${orgId}';
      PERFORM set_config('session_replication_role', 'origin', true);
      DELETE FROM ticket_review_slot_events WHERE ticket_id = '${t}';
      SELECT COUNT(*) INTO e FROM ticket_review_slot_events WHERE ticket_id = '${t}';
      SELECT COUNT(*) INTO tk FROM tickets WHERE id = '${t}';
      RAISE EXCEPTION 'simulated: events=% ticket=%', e, tk;
    END $do$${"$q$"})`);
    expect(sim).toBe("err:P0001:simulated: events=0 ticket=1");
    // and a real org deletion (a throwaway org with a ticket and its events) completes
    const s2 = seedOrg(db, { r: { role: "Requester" } });
    const t2 = randomUUID();
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id) VALUES ('${t2}', '${s2.orgId}', 'KE-P5-${t2.slice(0, 6)}', 'Tie-in', 'New Drawing', 'PENDING_REVIEW', '${s2.m.r.uid}')`);
    expect(asCaller(db, SERVICE, `INSERT INTO ticket_review_slot_events (org_id, ticket_id, roster_id, slot_kind, event) VALUES ('${s2.orgId}', '${t2}', '${randomUUID()}', 'eng', 'opened')`)).toEqual({ ok: true, rows: 1 });
    const del = admin(db, `SELECT harness.try_sql(${"$q$"}DELETE FROM orgs WHERE id = '${s2.orgId}'${"$q$"})`);
    expect(del).toBe("ok:1");
    expect(admin(db, `SELECT COUNT(*) FROM ticket_review_slot_events WHERE ticket_id = '${t2}'`)).toBe("0");
  });
});
