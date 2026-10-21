// drafting-flow Round G, DF-P8 PROJECTS — 20261256 asserted at RUNTIME on the
// replayed PostgreSQL 16 (each statement as PostgREST sends it: role
// `authenticated` with the member's claims, or `service_role` with none —
// how /api/tickets/create and /api/tickets/project-link write).
//
//   GAP-114 / DEC-40: tickets.project_id is one reference, settable only by
//   the service role (a client neither inserts nor changes it), bound to a
//   project of the ticket's OWN workspace for every caller, and cleared when
//   the project is deleted (the delete succeeds — a client's included).
//   DEC-90 ruling (2): the backfill copies metadata.intake_collision.projectId
//   only where it names a project of the same workspace and the link route
//   never recorded a choice; a re-paste writes nothing new.
//   REGRESSION: a member's own permitted writes (priority) on a linked
//   request still land.

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const F256 = "20261256_df_roundG_ticket_project.sql";

function paste(f: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
  expect(r.ok, `${f}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("DF-P8 — tickets.project_id: the reference, its rail and its backfill (runtime)", () => {
  let orgId = "";
  let otherOrg = "";
  let m: Record<string, SeededMember> = {};
  let o: Record<string, SeededMember> = {};
  const project = (org: string, owner: string, name = "Turnaround") => {
    const id = randomUUID();
    admin(db, `INSERT INTO projects (id, org_id, name, owner_user_id, created_by) VALUES ('${id}', '${org}', '${name}', '${owner}', '${owner}')`);
    return id;
  };
  const ticket = (opts: { projectId?: string | null; metadata?: Record<string, unknown> } = {}) => {
    const id = randomUUID();
    const pid = opts.projectId ? `'${opts.projectId}'` : "NULL";
    const meta = opts.metadata ? `'${JSON.stringify(opts.metadata)}'::jsonb` : "NULL";
    admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, project_id, metadata, history, last_modified)
               VALUES ('${id}', '${orgId}', 'KE-P8-${id.slice(0, 6)}', 'Isometric', 'Revision', 'DRAFTING', '${m.requester.uid}', ${pid}, ${meta}, '[]'::jsonb, '2026-10-20T10:00:00Z')`);
    return id;
  };
  const pidOf = (t: string) => admin(db, `SELECT COALESCE(project_id::text, '') FROM tickets WHERE id = '${t}'`);

  beforeAll(() => {
    const s = seedOrg(db, { requester: { role: "Viewer" }, manager: { role: "Manager" }, owner: { role: "Engineer" } });
    orgId = s.orgId;
    m = s.m;
    const s2 = seedOrg(db, { outsider: { role: "Admin" } });
    otherOrg = s2.orgId;
    o = s2.m;
  });

  it("re-pastes cleanly (DEC-30 one paste); every probe answers true (seven — fix pass 4 adds the checkout session key); six inventory rows and one after-row carry counts", () => {
    const { probes, inventory } = paste(F256);
    expect(probes.length).toBe(7);
    expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(inventory.length).toBe(7);
  });

  it("a signed-in client neither changes nor clears project_id (42501); a member's priority write on a linked request still lands (REGRESSION)", () => {
    const p = project(orgId, m.owner.uid);
    const p2 = project(orgId, m.owner.uid, "Other job");
    const t = ticket({ projectId: p });
    const set = asCaller(db, m.manager.caller, `UPDATE tickets SET project_id = '${p2}' WHERE id = '${t}'`);
    expect(set.ok).toBe(false);
    if (!set.ok) expect(set.code).toBe("42501");
    const clear = asCaller(db, m.requester.caller, `UPDATE tickets SET project_id = NULL WHERE id = '${t}'`);
    expect(clear.ok).toBe(false);
    expect(pidOf(t)).toBe(p);
    const prio = asCaller(db, m.manager.caller, `UPDATE tickets SET priority = 1, last_modified = now() WHERE id = '${t}'`);
    expect(prio).toEqual({ ok: true, rows: 1 });
  });

  it("the service role links and unlinks; another workspace's project is refused for every caller (23514), the paste owner included", () => {
    const p = project(orgId, m.owner.uid);
    const foreign = project(otherOrg, o.outsider.uid, "Their job");
    const t = ticket();
    expect(asCaller(db, SERVICE, `UPDATE tickets SET project_id = '${p}' WHERE id = '${t}'`)).toEqual({ ok: true, rows: 1 });
    expect(pidOf(t)).toBe(p);
    const cross = asCaller(db, SERVICE, `UPDATE tickets SET project_id = '${foreign}' WHERE id = '${t}'`);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.code).toBe("23514");
    expect(() => admin(db, `UPDATE tickets SET project_id = '${foreign}' WHERE id = '${t}'`)).toThrow(/own workspace/);
    expect(asCaller(db, SERVICE, `UPDATE tickets SET project_id = NULL WHERE id = '${t}'`)).toEqual({ ok: true, rows: 1 });
    // an INSERT naming another workspace's project is refused too
    const bad = asCaller(db, SERVICE, `INSERT INTO tickets (org_id, ticket_id, title, request_type, status, requester_id, project_id)
                                       VALUES ('${orgId}', 'KE-P8-X${randomUUID().slice(0, 5)}', 'x', 'Revision', 'PENDING_ASSIGNMENT', '${m.requester.uid}', '${foreign}')`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("23514");
  });

  it("deleting a project (its owner, signed in) succeeds and clears the reference — ON DELETE SET NULL passes the guard; the request is untouched otherwise", () => {
    const p = project(orgId, m.owner.uid, "Short job");
    const t = ticket({ projectId: p });
    const before = admin(db, `SELECT last_modified::text || '|' || status FROM tickets WHERE id = '${t}'`);
    const del = asCaller(db, m.owner.caller, `DELETE FROM projects WHERE id = '${p}'`);
    expect(del).toEqual({ ok: true, rows: 1 });
    expect(pidOf(t)).toBe("");
    expect(admin(db, `SELECT last_modified::text || '|' || status FROM tickets WHERE id = '${t}'`)).toBe(before);
  });

  it("fix pass 4: a request a check-in session names (linked_ticket_id, stamped by /api/tickets/create) can still be deleted — the key is ON DELETE SET NULL; the session stays with its pointer cleared", () => {
    const libId = randomUUID();
    const docId = randomUUID();
    const sessionId = randomUUID();
    admin(db, `INSERT INTO libraries (id, org_id, name, type) VALUES ('${libId}', '${orgId}', 'P8 Drawings', 'documents');
      INSERT INTO documents (id, org_id, library_id, title, status) VALUES ('${docId}', '${orgId}', '${libId}', 'P&ID P8', 'Draft');`);
    const t = ticket();
    admin(db, `INSERT INTO checkout_sessions (id, org_id, document_id, library_id, user_id, status) VALUES ('${sessionId}', '${orgId}', '${docId}', '${libId}', '${m.requester.uid}', 'released')`);
    expect(asCaller(db, SERVICE, `UPDATE checkout_sessions SET linked_ticket_id = '${t}' WHERE id = '${sessionId}' AND linked_ticket_id IS NULL`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, SERVICE, `DELETE FROM tickets WHERE id = '${t}'`)).toEqual({ ok: true, rows: 1 });
    expect(admin(db, `SELECT COUNT(*)::text || '|' || COALESCE(MAX(linked_ticket_id::text), '') FROM checkout_sessions WHERE id = '${sessionId}'`)).toBe("1|");
    // exactly one key on the column, and it is SET NULL
    expect(admin(db, `SELECT string_agg(c.confdeltype::text, ',') FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                      WHERE c.contype = 'f' AND c.conrelid = 'public.checkout_sessions'::regclass AND a.attname = 'linked_ticket_id'`)).toBe("n");
  });

  it("DEC-90 ruling (2): the backfill writes only a same-workspace project, never one somebody unlinked, never a non-UUID; last_modified never moves; a re-paste writes nothing new", () => {
    const p = project(orgId, m.owner.uid, "Collision job");
    const foreign = project(otherOrg, o.outsider.uid, "Elsewhere");
    const good = ticket({ metadata: { intake_collision: { projectId: p, intakeLinkId: null } } });
    const cross = ticket({ metadata: { intake_collision: { projectId: foreign } } });
    const unlinked = ticket({ metadata: { intake_collision: { projectId: p }, project_link: { projectId: null, at: "2026-10-21T00:00:00Z" } } });
    const junk = ticket({ metadata: { intake_collision: { projectId: "not-a-uuid" } } });
    const none = ticket();
    const lm = (t: string) => admin(db, `SELECT last_modified::text FROM tickets WHERE id = '${t}'`);
    const lmBefore = lm(good);
    const { probes } = paste(F256);
    expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(pidOf(good)).toBe(p);
    expect(pidOf(cross)).toBe("");
    expect(pidOf(unlinked)).toBe("");
    expect(pidOf(junk)).toBe("");
    expect(pidOf(none)).toBe("");
    expect(lm(good)).toBe(lmBefore);
    // re-paste: idempotent
    const again = paste(F256);
    expect(again.probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(pidOf(good)).toBe(p);
  });
});
